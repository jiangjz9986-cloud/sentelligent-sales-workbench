import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { AssistantContractError } from "./contracts.js";

const MAX_OWNER = 200;
const MAX_CHANNEL = 100;
const MAX_CONVERSATION = 500;
const MAX_ID = 200;
const MAX_SOURCE_REFS = 50;
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,200}$/u;
const SOURCES = new Set(["user_selection", "verified_entity", "analysis", "system"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AssistantContractError(`${name} is required`, "invalid_business_context");
  }
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new AssistantContractError(`${name} contains control characters`, "invalid_business_context");
  }
  return normalized;
}

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredText(value, name, MAX_ID);
  if (!SAFE_IDENTIFIER.test(normalized) || normalized.startsWith("synthetic:")) {
    throw new AssistantContractError(`${name} is not a safe identifier`, "invalid_business_context");
  }
  return normalized;
}

function normalizeSource(value) {
  const source = value === undefined || value === null ? "user_selection" : requiredText(value, "source", 40);
  if (!SOURCES.has(source)) {
    throw new AssistantContractError("source is invalid", "invalid_business_context");
  }
  return source;
}

function normalizeSourceRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFS) {
    throw new AssistantContractError("sourceRefs must be a bounded array", "invalid_business_context");
  }
  const refs = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      throw new AssistantContractError(`sourceRefs[${index}] must be an object`, "invalid_business_context");
    }
    const type = requiredText(item.type, `sourceRefs[${index}].type`, 80);
    const id = optionalIdentifier(item.id, `sourceRefs[${index}].id`);
    if (!id) {
      throw new AssistantContractError(`sourceRefs[${index}].id is required`, "invalid_business_context");
    }
    if (refs.some((ref) => ref.type === type && ref.id === id)) continue;
    refs.push({ type, id });
  }
  return refs;
}

function stableJson(value) {
  return JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]));
  });
}

function hash(value, name, max) {
  return createHash("sha256")
    .update(requiredText(value, name, max), "utf8")
    .digest("hex");
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return value.toISOString();
}

function rowToItem(row) {
  if (!row) return null;
  let sourceRefs = [];
  try {
    const parsed = JSON.parse(row.source_refs_json);
    sourceRefs = Array.isArray(parsed) ? parsed : [];
  } catch {
    sourceRefs = [];
  }
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    conversationIdHash: row.conversation_id_hash,
    customerId: row.customer_id ?? null,
    opportunityId: row.opportunity_id ?? null,
    source: row.source,
    sourceRefs,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeIdentity(input = {}) {
  return {
    owner: requiredText(input.owner, "owner", MAX_OWNER),
    channel: requiredText(input.channel, "channel", MAX_CHANNEL),
    conversationId: requiredText(input.conversationId, "conversationId", MAX_CONVERSATION),
  };
}

function assertAllowedKeys(input, allowed) {
  if (!isPlainObject(input)) throw new AssistantContractError("business context must be an object", "invalid_business_context");
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AssistantContractError(`unsupported business context field: ${unknown[0]}`, "forbidden_field");
  }
}

export function createSalesLoopContextRepository(
  db,
  {
    idFactory = randomUUID,
    clock = () => new Date(),
    resolveEntities = null,
  } = {},
) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (resolveEntities !== null && typeof resolveEntities !== "function") throw new TypeError("resolveEntities must be a function");

  function identity(input) {
    const normalized = normalizeIdentity(input);
    return {
      ...normalized,
      conversationIdHash: hash(normalized.conversationId, "conversationId", MAX_CONVERSATION),
    };
  }

  function validateEntityRelation({ owner, customerId, opportunityId }) {
    if (!resolveEntities || (!customerId && !opportunityId)) return;
    const resolved = resolveEntities({ owner, customerId, opportunityId });
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw new AssistantContractError("business entity evidence is unavailable", "context_not_found");
    }
    if (customerId && !resolved.customer) {
      throw new AssistantContractError("customer is not visible to this owner", "context_not_found");
    }
    if (opportunityId && !resolved.opportunity) {
      throw new AssistantContractError("opportunity is not visible to this owner", "context_not_found");
    }
    if (
      customerId && opportunityId
      && resolved.opportunity.customerId
      && resolved.opportunity.customerId !== customerId
    ) {
      throw new AssistantContractError("customer and opportunity relationship is inconsistent", "relationship_conflict");
    }
  }

  function normalizePayload(input, identityValue) {
    assertAllowedKeys(input, new Set([
      "owner", "channel", "conversationId", "customerId", "opportunityId", "source", "sourceRefs",
      "expectedVersion", "requestId",
    ]));
    const customerId = optionalIdentifier(input.customerId, "customerId");
    const opportunityId = optionalIdentifier(input.opportunityId, "opportunityId");
    validateEntityRelation({ owner: identityValue.owner, customerId, opportunityId });
    return {
      customerId,
      opportunityId,
      source: normalizeSource(input.source),
      sourceRefs: normalizeSourceRefs(input.sourceRefs),
    };
  }

  function find(identityValue) {
    return db.prepare(`
      SELECT * FROM assistant_business_contexts
      WHERE owner = $owner AND channel = $channel AND conversation_id_hash = $conversationIdHash
    `).get({
      $owner: identityValue.owner,
      $channel: identityValue.channel,
      $conversationIdHash: identityValue.conversationIdHash,
    });
  }

  function get(input = {}) {
    return rowToItem(find(identity(input)));
  }

  function set(input = {}) {
    assertAllowedKeys(input, new Set([
      "owner", "channel", "conversationId", "customerId", "opportunityId", "source", "sourceRefs", "expectedVersion", "requestId",
    ]));
    const identityValue = identity(input);
    const payload = normalizePayload(input, identityValue);
    const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null
      ? null
      : input.expectedVersion;
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new AssistantContractError("expectedVersion is invalid", "invalid_business_context");
    }
    const requestId = input.requestId === undefined || input.requestId === null
      ? null
      : requiredText(input.requestId, "requestId", 500);
    const timestamp = nowIso(clock);
    return withImmediateTransaction(db, () => {
      const existingRow = find(identityValue);
      const existing = rowToItem(existingRow);
      if (expectedVersion !== null && existing?.version !== expectedVersion) {
        throw new HttpError(409, "ASSISTANT_CONTEXT_VERSION_CONFLICT", "The business context has changed");
      }
      const same = existing
        && existing.customerId === payload.customerId
        && existing.opportunityId === payload.opportunityId
        && existing.source === payload.source
        && stableJson(existing.sourceRefs) === stableJson(payload.sourceRefs);
      if (same) return { item: existing, changed: false };

      const nextVersion = existing ? existing.version + 1 : 1;
      const id = existing?.id ?? requiredText(idFactory(), "generated id", MAX_ID);
      if (!existing) {
        db.prepare(`
          INSERT INTO assistant_business_contexts (
            id, owner, channel, conversation_id_hash, customer_id, opportunity_id,
            source, source_refs_json, version, created_at, updated_at
          ) VALUES (
            $id, $owner, $channel, $conversationIdHash, $customerId, $opportunityId,
            $source, $sourceRefsJson, $version, $createdAt, $updatedAt
          )
        `).run({
          $id: id,
          $owner: identityValue.owner,
          $channel: identityValue.channel,
          $conversationIdHash: identityValue.conversationIdHash,
          $customerId: payload.customerId,
          $opportunityId: payload.opportunityId,
          $source: payload.source,
          $sourceRefsJson: JSON.stringify(payload.sourceRefs),
          $version: nextVersion,
          $createdAt: timestamp,
          $updatedAt: timestamp,
        });
      } else {
        db.prepare(`
          UPDATE assistant_business_contexts
          SET customer_id = $customerId,
              opportunity_id = $opportunityId,
              source = $source,
              source_refs_json = $sourceRefsJson,
              version = $version,
              updated_at = $updatedAt
          WHERE id = $id AND version = $previousVersion
        `).run({
          $id: existing.id,
          $customerId: payload.customerId,
          $opportunityId: payload.opportunityId,
          $source: payload.source,
          $sourceRefsJson: JSON.stringify(payload.sourceRefs),
          $version: nextVersion,
          $updatedAt: timestamp,
          $previousVersion: existing.version,
        });
      }
      const item = rowToItem(db.prepare("SELECT * FROM assistant_business_contexts WHERE id = $id").get({ $id: id }));
      insertAudit(db, {
        action: existing ? "assistant_business_context.update" : "assistant_business_context.create",
        entityType: "assistant_business_context",
        entityId: item.id,
        actor: identityValue.owner,
        requestId,
        before: existing,
        after: item,
        entityVersion: item.version,
        metadata: {
          channel: identityValue.channel,
          source: item.source,
          sourceRefCount: item.sourceRefs.length,
        },
      });
      return { item, changed: true };
    });
  }

  function clear(input = {}) {
    return set({
      owner: input.owner,
      channel: input.channel,
      conversationId: input.conversationId,
      source: input.source ?? "system",
      sourceRefs: input.sourceRefs ?? [],
      expectedVersion: input.expectedVersion,
      requestId: input.requestId,
      customerId: null,
      opportunityId: null,
    });
  }

  return Object.freeze({ get, set, clear });
}

export const normalizeSalesLoopContextIdentifier = optionalIdentifier;
