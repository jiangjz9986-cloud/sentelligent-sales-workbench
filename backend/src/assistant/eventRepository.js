import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function sha256(value, name) {
  return createHash("sha256").update(text(value, name, 200), "utf8").digest("hex");
}

function digest(value, name) {
  const normalized = text(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function json(value, name, fallback = {}) {
  const normalized = value === undefined ? fallback : value;
  try {
    const encoded = JSON.stringify(normalized);
    if (!encoded || encoded === undefined) throw new Error("not-json");
    return encoded;
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

function iso(clock) {
  const current = clock();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new TypeError("clock must return a valid Date");
  return current.toISOString();
}

function duration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60 * 1000) {
    throw new TypeError(`${name} must be a positive duration no longer than 24 hours`);
  }
  return value;
}

function item(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    status: row.status,
    version: row.version,
    payload: JSON.parse(row.payload_json),
    responseStatus: row.response_status,
    response: row.response_json ? JSON.parse(row.response_json) : null,
    errorCode: row.error_code,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toolItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    toolName: row.tool_name,
    status: row.status,
    version: row.version,
    input: JSON.parse(row.input_json),
    output: row.output_json ? JSON.parse(row.output_json) : null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAssistantEventRepository(db, { idFactory = randomUUID, clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  const selectById = db.prepare("SELECT * FROM assistant_inbound_events WHERE id = $id");
  const selectByKey = db.prepare(`
    SELECT * FROM assistant_inbound_events
    WHERE owner = $owner AND channel = $channel AND event_id_hash = $eventIdHash
  `);
  const selectToolById = db.prepare("SELECT * FROM assistant_tool_runs WHERE id = $id");
  const selectToolByKey = db.prepare(`
    SELECT * FROM assistant_tool_runs
    WHERE owner = $owner AND channel = $channel
      AND event_id_hash IS $eventIdHash AND tool_name = $toolName
  `);

  function receive(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const eventIdHash = sha256(input.eventId, "eventId");
    const requestHash = digest(input.requestHash, "requestHash");
    const payloadJson = json(input.payload, "payload");
    const auditMetadata = input.auditMetadata && typeof input.auditMetadata === "object" && !Array.isArray(input.auditMetadata)
      ? input.auditMetadata
      : {};
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const existing = selectByKey.get({ $owner: owner, $channel: channel, $eventIdHash: eventIdHash });
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(409, "ASSISTANT_EVENT_CONFLICT", "The event was already received with different request content", { existingId: existing.id });
        }
        return { item: item(existing), replayed: true };
      }
      const id = text(idFactory(), "generated event id", 200);
      db.prepare(`
        INSERT INTO assistant_inbound_events (
          id, owner, channel, event_id_hash, request_hash, payload_json,
          status, version, created_at, updated_at
        ) VALUES ($id, $owner, $channel, $eventIdHash, $requestHash, $payloadJson, 'received', 1, $now, $now)
      `).run({ $id: id, $owner: owner, $channel: channel, $eventIdHash: eventIdHash, $requestHash: requestHash, $payloadJson: payloadJson, $now: now });
      insertAudit(db, {
        action: "assistant.event.receive",
        entityType: "assistant_inbound_event",
        entityId: id,
        actor: owner,
        requestId: id,
        after: { status: "received", channel },
        metadata: { owner, channel, ...auditMetadata },
      });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
  }

  function claim(idValue, { leaseMs = 5 * 60 * 1000 } = {}) {
    const id = text(idValue, "id", 200);
    const leaseDuration = duration(leaseMs, "leaseMs");
    const now = iso(clock);
    const nowMs = Date.parse(now);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current) throw new HttpError(404, "ASSISTANT_EVENT_NOT_FOUND", "Assistant event was not found");
      if (current.status === "completed") return { item: item(current), replayed: true };
      const active = current.status === "processing" && current.lease_expires_at && Date.parse(current.lease_expires_at) > nowMs;
      if (active) throw new HttpError(409, "ASSISTANT_EVENT_IN_PROGRESS", "The same assistant event is already being processed");
      const leaseToken = randomUUID();
      const expiresAt = new Date(nowMs + leaseDuration).toISOString();
      db.prepare(`
        UPDATE assistant_inbound_events
        SET status = 'processing', version = version + 1,
            lease_token_hash = $leaseTokenHash, lease_expires_at = $leaseExpiresAt,
            updated_at = $now
        WHERE id = $id
      `).run({ $id: id, $leaseTokenHash: sha256(leaseToken, "leaseToken"), $leaseExpiresAt: expiresAt, $now: now });
      return { item: item(selectById.get({ $id: id })), replayed: false, leaseToken };
    });
  }

  function complete(idValue, { leaseToken, responseStatus = 200, response = {} } = {}) {
    const id = text(idValue, "id", 200);
    const tokenHash = sha256(leaseToken, "leaseToken");
    if (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599) throw new TypeError("responseStatus must be a valid HTTP status");
    const responseJson = json(response, "response");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectById.get({ $id: id });
      if (!current) throw new HttpError(404, "ASSISTANT_EVENT_NOT_FOUND", "Assistant event was not found");
      if (current.status === "completed") return { item: item(current), replayed: true };
      if (current.status !== "processing" || current.lease_token_hash !== tokenHash || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= Date.parse(now)) {
        throw new HttpError(409, "ASSISTANT_EVENT_LEASE_LOST", "The assistant event processing lease is no longer current");
      }
      db.prepare(`
        UPDATE assistant_inbound_events
        SET status = 'completed', version = version + 1,
            lease_token_hash = NULL, lease_expires_at = NULL,
            response_status = $responseStatus, response_json = $responseJson,
            updated_at = $now
        WHERE id = $id AND status = 'processing' AND lease_token_hash = $leaseTokenHash
      `).run({ $id: id, $leaseTokenHash: tokenHash, $responseStatus: responseStatus, $responseJson: responseJson, $now: now });
      insertAudit(db, {
        action: "assistant.event.complete",
        entityType: "assistant_inbound_event",
        entityId: id,
        actor: current.owner,
        requestId: id,
        before: { status: current.status, version: current.version },
        after: { status: "completed", version: current.version + 1, responseStatus },
        metadata: { owner: current.owner, channel: current.channel },
      });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
  }

  function createToolRun(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const eventIdHash = input.eventId === undefined || input.eventId === null ? null : sha256(input.eventId, "eventId");
    const toolName = text(input.toolName, "toolName", 200);
    const requestHash = digest(input.requestHash, "requestHash");
    const inputJson = json(input.input, "input");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const existing = selectToolByKey.get({ $owner: owner, $channel: channel, $eventIdHash: eventIdHash, $toolName: toolName });
      if (existing) {
        if (existing.request_hash !== requestHash) throw new HttpError(409, "ASSISTANT_TOOL_RUN_CONFLICT", "The tool run was already created with different request content", { existingId: existing.id });
        return { item: toolItem(existing), replayed: true };
      }
      const id = text(idFactory(), "generated tool run id", 200);
      db.prepare(`
        INSERT INTO assistant_tool_runs (
          id, owner, channel, event_id_hash, tool_name, request_hash,
          input_json, status, version, created_at, updated_at
        ) VALUES ($id, $owner, $channel, $eventIdHash, $toolName, $requestHash, $inputJson, 'queued', 1, $now, $now)
      `).run({ $id: id, $owner: owner, $channel: channel, $eventIdHash: eventIdHash, $toolName: toolName, $requestHash: requestHash, $inputJson: inputJson, $now: now });
      return { item: toolItem(selectToolById.get({ $id: id })), replayed: false };
    });
  }

  function claimToolRun(idValue, { leaseMs = 5 * 60 * 1000 } = {}) {
    const id = text(idValue, "id", 200);
    const leaseDuration = duration(leaseMs, "leaseMs");
    const now = iso(clock);
    const nowMs = Date.parse(now);
    return withImmediateTransaction(db, () => {
      const current = selectToolById.get({ $id: id });
      if (!current) throw new HttpError(404, "ASSISTANT_TOOL_RUN_NOT_FOUND", "Assistant tool run was not found");
      if (current.status === "completed") return { item: toolItem(current), replayed: true };
      if (current.status === "running" && current.lease_expires_at && Date.parse(current.lease_expires_at) > nowMs) throw new HttpError(409, "ASSISTANT_TOOL_RUN_IN_PROGRESS", "The assistant tool run is already being processed");
      const leaseToken = randomUUID();
      db.prepare(`
        UPDATE assistant_tool_runs
        SET status = 'running', version = version + 1, lease_token_hash = $leaseTokenHash,
            lease_expires_at = $leaseExpiresAt, updated_at = $now
        WHERE id = $id
      `).run({ $id: id, $leaseTokenHash: sha256(leaseToken, "leaseToken"), $leaseExpiresAt: new Date(nowMs + leaseDuration).toISOString(), $now: now });
      return { item: toolItem(selectToolById.get({ $id: id })), replayed: false, leaseToken };
    });
  }

  function completeToolRun(idValue, { leaseToken, output = {} } = {}) {
    const id = text(idValue, "id", 200);
    const leaseTokenHash = sha256(leaseToken, "leaseToken");
    const outputJson = json(output, "output");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectToolById.get({ $id: id });
      if (!current) throw new HttpError(404, "ASSISTANT_TOOL_RUN_NOT_FOUND", "Assistant tool run was not found");
      if (current.status === "completed") return { item: toolItem(current), replayed: true };
      if (current.status !== "running" || current.lease_token_hash !== leaseTokenHash || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= Date.parse(now)) throw new HttpError(409, "ASSISTANT_TOOL_RUN_LEASE_LOST", "The assistant tool run lease is no longer current");
      db.prepare(`
        UPDATE assistant_tool_runs
        SET status = 'completed', version = version + 1, lease_token_hash = NULL,
            lease_expires_at = NULL, output_json = $outputJson, updated_at = $now
        WHERE id = $id AND status = 'running' AND lease_token_hash = $leaseTokenHash
      `).run({ $id: id, $leaseTokenHash: leaseTokenHash, $outputJson: outputJson, $now: now });
      return { item: toolItem(selectToolById.get({ $id: id })), replayed: false };
    });
  }

  return {
    receive,
    claim,
    complete,
    createToolRun,
    claimToolRun,
    completeToolRun,
    get: (id) => item(selectById.get({ $id: text(id, "id", 200) })),
    getToolRun: (id) => toolItem(selectToolById.get({ $id: text(id, "id", 200) })),
  };
}
