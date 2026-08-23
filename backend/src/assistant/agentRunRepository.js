import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { AssistantContractError } from "./contracts.js";
import { createAgentManifestRegistry } from "./agentManifest.js";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_SOURCE_REFS = 100;
const MAX_LIST_LIMIT = 100;
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,200}$/u;
const SENSITIVE_KEYS = new Set([
  "apikey", "authorization", "cookie", "database", "databaseurl", "file",
  "filepath", "password", "privatekey", "secret", "shell", "sql", "token",
]);
const SOURCES = new Set(["pending", "model", "deepseek", "mock", "deterministic", "fallback"]);
const STATUSES = new Set(["running", "succeeded", "fallback", "failed"]);
const CONFIRMATION_STATUSES = new Set(["not_required", "preview", "pending", "confirmed", "rejected"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(name + " is required", "invalid_agent_run");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(name + " is too long", "invalid_agent_run");
  }
  return normalized;
}

function optionalText(value, name, max = 5000) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function hashText(value, name, max = 5000) {
  return createHash("sha256").update(text(value, name, max), "utf8").digest("hex");
}

function canonicalize(value, location = "snapshot", depth = 0, state = { count: 0 }) {
  if (depth > 12) throw new AssistantContractError(location + " is too deeply nested", "invalid_agent_run");
  state.count += 1;
  if (state.count > 5000) throw new AssistantContractError(location + " contains too many values", "invalid_agent_run");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new AssistantContractError(location + " contains a non-finite number", "invalid_agent_run");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, location + "[" + index + "]", depth + 1, state));
  if (!isPlainObject(value)) throw new AssistantContractError(location + " must be JSON data", "invalid_agent_run");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const normalizedKey = key.replace(/[\s_-]/g, "").toLowerCase();
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      throw new AssistantContractError(location + "." + key + " is sensitive and cannot be persisted", "sensitive_snapshot");
    }
    result[key] = canonicalize(value[key], location + "." + key, depth + 1, state);
  }
  return result;
}

function snapshot(value, name) {
  if (!isPlainObject(value)) {
    throw new AssistantContractError(name + " must be a plain object", "invalid_agent_run");
  }
  const normalized = canonicalize(value, name);
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new AssistantContractError(name + " exceeds the size limit", "invalid_agent_run");
  }
  return {
    value: normalized,
    json: encoded,
    hash: createHash("sha256").update(encoded, "utf8").digest("hex"),
  };
}

function sourceRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFS) {
    throw new AssistantContractError("sourceRefs must be a bounded array", "invalid_agent_run");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new AssistantContractError("sourceRefs[" + index + "] must be an object", "invalid_agent_run");
    }
    const type = text(item.type, "sourceRefs[" + index + "].type", 80);
    const id = text(item.id, "sourceRefs[" + index + "].id", 200);
    if (!SAFE_IDENTIFIER.test(type) || !SAFE_IDENTIFIER.test(id)) {
      throw new AssistantContractError("sourceRefs[" + index + "] contains an unsafe identifier", "invalid_agent_run");
    }
    return { type, id };
  });
}

function iso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value.toISOString();
}

function statusForSource(source, fallbackReason) {
  return source === "fallback" || fallbackReason ? "fallback" : "succeeded";
}

function itemFromRow(row) {
  if (!row) return null;
  const parse = (value, fallback) => {
    try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
  };
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    status: row.status,
    conversationIdHash: row.conversation_id_hash || null,
    eventIdHash: row.event_id_hash || null,
    requestHash: row.request_hash,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    taskType: row.task_type,
    contractVersion: row.contract_version,
    inputSnapshotHash: row.input_snapshot_hash,
    input: parse(row.input_json, {}),
    outputSnapshotHash: row.output_snapshot_hash,
    output: parse(row.output_json, null),
    source: row.source,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    fallbackReason: row.fallback_reason,
    sourceRefs: parse(row.source_refs_json, []),
    confirmationStatus: row.confirmation_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function limitValue(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new TypeError("limit must be between 1 and 100");
  }
  return value;
}

export function createAssistantAgentRunRepository(
  db,
  {
    idFactory = randomUUID,
    clock = () => new Date(),
    manifestRegistry = createAgentManifestRegistry(),
  } = {},
) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (!manifestRegistry || typeof manifestRegistry.get !== "function") {
    throw new TypeError("manifestRegistry is required");
  }

  function normalizeIdentity(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const conversationId = optionalText(input.conversationId, "conversationId", 500);
    const eventId = optionalText(input.eventId, "eventId", 500);
    return {
      owner,
      channel,
      conversationId,
      eventId,
      conversationIdHash: conversationId ? hashText(conversationId, "conversationId", 500) : "",
      eventIdHash: eventId ? hashText(eventId, "eventId", 500) : "",
    };
  }

  function normalizeManifest(input = {}) {
    const agentId = text(input.agentId, "agentId", 100);
    const manifest = manifestRegistry.get(agentId);
    if (!manifest) throw new AssistantContractError("agent manifest is unavailable", "invalid_agent_run");
    if (!manifest.enabled || manifest.lifecycle === "disabled") {
      throw new AssistantContractError("agent is disabled", "agent_disabled");
    }
    const agentVersion = optionalText(input.agentVersion, "agentVersion", 40) ?? manifest.version;
    const taskType = text(input.taskType, "taskType", 100);
    const contractVersion = optionalText(input.contractVersion, "contractVersion", 100) ?? manifest.contractVersion;
    if (agentVersion !== manifest.version) {
      throw new AssistantContractError("agentVersion does not match the active manifest", "invalid_agent_run");
    }
    if (contractVersion !== manifest.contractVersion) {
      throw new AssistantContractError("contractVersion does not match the active manifest", "invalid_agent_run");
    }
    if (!manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for the agent", "invalid_agent_run");
    }
    return { agentId, agentVersion, taskType, contractVersion };
  }

  function requestHash(identity, manifest, inputSnapshot) {
    const value = JSON.stringify({
      owner: identity.owner,
      channel: identity.channel,
      conversationId: identity.conversationId,
      eventId: identity.eventId,
      agentId: manifest.agentId,
      agentVersion: manifest.agentVersion,
      taskType: manifest.taskType,
      contractVersion: manifest.contractVersion,
      inputSnapshotHash: inputSnapshot.hash,
    });
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  function rowById(id, owner = null) {
    const normalizedId = text(id, "id", 200);
    const row = owner === null
      ? db.prepare("SELECT * FROM assistant_agent_runs WHERE id = $id").get({ $id: normalizedId })
      : db.prepare("SELECT * FROM assistant_agent_runs WHERE id = $id AND owner = $owner").get({
        $id: normalizedId,
        $owner: text(owner, "owner", 200),
      });
    return row;
  }

  function create(input = {}) {
    const identity = normalizeIdentity(input);
    const manifest = normalizeManifest(input);
    const inputSnapshot = snapshot(input.input, "input");
    const requestHashValue = requestHash(identity, manifest, inputSnapshot);
    const now = iso(clock);
    const id = text(idFactory(), "generated id", 200);
    const source = input.source === undefined ? "pending" : text(input.source, "source", 100);
    if (!SOURCES.has(source)) throw new AssistantContractError("source is invalid", "invalid_agent_run");
    return withImmediateTransaction(db, () => {
      const existing = db.prepare(
        "SELECT * FROM assistant_agent_runs WHERE owner = $owner AND channel = $channel AND request_hash = $requestHash",
      ).get({ $owner: identity.owner, $channel: identity.channel, $requestHash: requestHashValue });
      if (existing) return { item: itemFromRow(existing), replayed: true };
      if (identity.eventIdHash) {
        const eventExisting = db.prepare(
          "SELECT * FROM assistant_agent_runs WHERE owner = $owner AND channel = $channel AND event_id_hash = $eventIdHash",
        ).get({
          $owner: identity.owner,
          $channel: identity.channel,
          $eventIdHash: identity.eventIdHash,
        });
        if (eventExisting) {
          throw new HttpError(409, "ASSISTANT_AGENT_RUN_CONFLICT", "The event already has a different agent run");
        }
      }
      db.prepare(
        "INSERT INTO assistant_agent_runs (" +
        "id, owner, channel, conversation_id_hash, event_id_hash, request_hash, " +
        "agent_id, agent_version, task_type, contract_version, status, " +
        "input_snapshot_hash, input_json, source, source_refs_json, " +
        "confirmation_status, created_at, updated_at" +
        ") VALUES (" +
        "$id, $owner, $channel, $conversationIdHash, $eventIdHash, $requestHash, " +
        "$agentId, $agentVersion, $taskType, $contractVersion, 'running', " +
        "$inputSnapshotHash, $inputJson, $source, '[]', " +
        "'not_required', $now, $now" +
        ")",
      ).run({
        $id: id,
        $owner: identity.owner,
        $channel: identity.channel,
        $conversationIdHash: identity.conversationIdHash,
        $eventIdHash: identity.eventIdHash,
        $requestHash: requestHashValue,
        $agentId: manifest.agentId,
        $agentVersion: manifest.agentVersion,
        $taskType: manifest.taskType,
        $contractVersion: manifest.contractVersion,
        $inputSnapshotHash: inputSnapshot.hash,
        $inputJson: inputSnapshot.json,
        $source: source,
        $now: now,
      });
      insertAudit(db, {
        action: "assistant.agent_run.create",
        entityType: "assistant_agent_run",
        entityId: id,
        actor: identity.owner,
        requestId: id,
        after: {
          status: "running",
          agentId: manifest.agentId,
          agentVersion: manifest.agentVersion,
          taskType: manifest.taskType,
          inputSnapshotHash: inputSnapshot.hash,
        },
        metadata: { channel: identity.channel, source },
      });
      return { item: itemFromRow(rowById(id)), replayed: false };
    });
  }

  function complete(id, input = {}) {
    const owner = text(input.owner, "owner", 200);
    const outputSnapshot = snapshot(input.output, "output");
    const refs = sourceRefs(input.sourceRefs);
    const source = text(input.source ?? "model", "source", 100);
    if (!SOURCES.has(source) || source === "pending") {
      throw new AssistantContractError("source is invalid for completion", "invalid_agent_run");
    }
    const fallbackReason = optionalText(input.fallbackReason, "fallbackReason", 200);
    const confirmationStatus = text(input.confirmationStatus ?? "not_required", "confirmationStatus", 40);
    if (!CONFIRMATION_STATUSES.has(confirmationStatus)) {
      throw new AssistantContractError("confirmationStatus is invalid", "invalid_agent_run");
    }
    const modelProvider = optionalText(input.modelProvider, "modelProvider", 100);
    const modelName = optionalText(input.modelName, "modelName", 200);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = rowById(id, owner);
      if (!current) throw new HttpError(404, "ASSISTANT_AGENT_RUN_NOT_FOUND", "The assistant agent run was not found");
      if (!STATUSES.has(current.status)) throw new HttpError(409, "ASSISTANT_AGENT_RUN_STATE", "The assistant agent run has an invalid state");
      if (current.status !== "running") return { item: itemFromRow(current), replayed: true };
      const nextStatus = statusForSource(source, fallbackReason);
      db.prepare(
        "UPDATE assistant_agent_runs SET " +
        "status = $status, output_snapshot_hash = $outputSnapshotHash, output_json = $outputJson, " +
        "source = $source, model_provider = $modelProvider, model_name = $modelName, " +
        "fallback_reason = $fallbackReason, source_refs_json = $sourceRefsJson, " +
        "confirmation_status = $confirmationStatus, completed_at = $now, updated_at = $now " +
        "WHERE id = $id AND owner = $owner AND status = 'running'",
      ).run({
        $id: text(id, "id", 200),
        $owner: owner,
        $status: nextStatus,
        $outputSnapshotHash: outputSnapshot.hash,
        $outputJson: outputSnapshot.json,
        $source: source,
        $modelProvider: modelProvider,
        $modelName: modelName,
        $fallbackReason: fallbackReason,
        $sourceRefsJson: JSON.stringify(refs),
        $confirmationStatus: confirmationStatus,
        $now: now,
      });
      const result = itemFromRow(rowById(id, owner));
      insertAudit(db, {
        action: "assistant.agent_run.complete",
        entityType: "assistant_agent_run",
        entityId: result.id,
        actor: owner,
        requestId: result.id,
        before: { status: "running", inputSnapshotHash: result.inputSnapshotHash },
        after: {
          status: result.status,
          source: result.source,
          outputSnapshotHash: result.outputSnapshotHash,
          sourceRefCount: result.sourceRefs.length,
          confirmationStatus: result.confirmationStatus,
        },
        metadata: { fallbackReason: result.fallbackReason },
      });
      return { item: result, replayed: false };
    });
  }

  function fail(id, input = {}) {
    const owner = text(input.owner, "owner", 200);
    const errorCode = text(input.errorCode, "errorCode", 200);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = rowById(id, owner);
      if (!current) throw new HttpError(404, "ASSISTANT_AGENT_RUN_NOT_FOUND", "The assistant agent run was not found");
      if (current.status !== "running") return { item: itemFromRow(current), replayed: true };
      db.prepare(
        "UPDATE assistant_agent_runs SET status = 'failed', error_code = $errorCode, " +
        "completed_at = $now, updated_at = $now WHERE id = $id AND owner = $owner AND status = 'running'",
      ).run({ $id: text(id, "id", 200), $owner: owner, $errorCode: errorCode, $now: now });
      const result = itemFromRow(rowById(id, owner));
      insertAudit(db, {
        action: "assistant.agent_run.fail",
        entityType: "assistant_agent_run",
        entityId: result.id,
        actor: owner,
        requestId: result.id,
        after: { status: "failed", errorCode },
      });
      return { item: result, replayed: false };
    });
  }

  function get(id, { owner } = {}) {
    const row = rowById(id, owner === undefined ? null : owner);
    return row ? { item: itemFromRow(row) } : null;
  }

  function list({ owner, agentId = null, taskType = null, status = null, limit = 50 } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    const boundedLimit = limitValue(limit);
    const clauses = ["owner = $owner"];
    const params = { $owner: normalizedOwner, $limit: boundedLimit };
    if (agentId !== null && agentId !== undefined) {
      params.$agentId = text(agentId, "agentId", 100);
      clauses.push("agent_id = $agentId");
    }
    if (taskType !== null && taskType !== undefined) {
      params.$taskType = text(taskType, "taskType", 100);
      clauses.push("task_type = $taskType");
    }
    if (status !== null && status !== undefined) {
      params.$status = text(status, "status", 40);
      if (!STATUSES.has(params.$status)) throw new TypeError("status is invalid");
      clauses.push("status = $status");
    }
    return db.prepare(
      "SELECT * FROM assistant_agent_runs WHERE " + clauses.join(" AND ") +
      " ORDER BY created_at DESC, id DESC LIMIT $limit",
    ).all(params).map(itemFromRow);
  }

  function getByEvent({ owner, channel, eventId } = {}) {
    const identity = normalizeIdentity({ owner, channel, eventId });
    if (!identity.eventIdHash) return null;
    const row = db.prepare(
      "SELECT * FROM assistant_agent_runs WHERE owner = $owner AND channel = $channel AND event_id_hash = $eventIdHash",
    ).get({
      $owner: identity.owner,
      $channel: identity.channel,
      $eventIdHash: identity.eventIdHash,
    });
    return row ? { item: itemFromRow(row) } : null;
  }

  // The external conversation identifier is never stored in plaintext. This
  // lookup lets a confirmation step reuse the latest preview for the same
  // owner/channel/conversation without widening the persistence boundary.
  function getLatest({ owner, channel, conversationId, agentId = null, taskType = null } = {}) {
    const identity = normalizeIdentity({ owner, channel, conversationId });
    if (!identity.conversationIdHash) return null;
    const clauses = [
      "owner = $owner",
      "channel = $channel",
      "conversation_id_hash = $conversationIdHash",
    ];
    const params = {
      $owner: identity.owner,
      $channel: identity.channel,
      $conversationIdHash: identity.conversationIdHash,
    };
    if (agentId !== null && agentId !== undefined) {
      params.$agentId = text(agentId, "agentId", 100);
      clauses.push("agent_id = $agentId");
    }
    if (taskType !== null && taskType !== undefined) {
      params.$taskType = text(taskType, "taskType", 100);
      clauses.push("task_type = $taskType");
    }
    const row = db.prepare(
      "SELECT * FROM assistant_agent_runs WHERE " + clauses.join(" AND ") +
      " ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(params);
    return row ? { item: itemFromRow(row) } : null;
  }

  return Object.freeze({ create, complete, fail, get, list, getByEvent, getLatest });
}
