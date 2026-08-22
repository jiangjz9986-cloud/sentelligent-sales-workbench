import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";

function text(value, name, max = 20000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function hash(value, name) {
  return createHash("sha256").update(text(value, name, 5000), "utf8").digest("hex");
}

function iso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return value.toISOString();
}

function json(value, name, fallback = {}) {
  try {
    const encoded = JSON.stringify(value === undefined ? fallback : value);
    if (!encoded) throw new Error("not-json");
    return encoded;
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

function conversationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    state: row.state,
    version: row.version,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function partFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    metadata: JSON.parse(row.metadata_json),
    version: row.version,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assistantContextFromPart(part) {
  const value = part?.metadata?.assistantContext;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contextIdentifier = (candidate) => {
    if (typeof candidate !== "string") return null;
    const normalized = candidate.trim();
    if (
      !normalized
      || normalized.length > 200
      || normalized.startsWith("synthetic:")
      || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    ) return null;
    return normalized;
  };
  const customerId = contextIdentifier(value.customerId);
  const opportunityId = contextIdentifier(value.opportunityId);
  if (!customerId && !opportunityId) return null;
  return { customerId, opportunityId };
}

export function createAssistantSessionRepository(db, { idFactory = randomUUID, clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  const selectConversation = db.prepare("SELECT * FROM assistant_conversations WHERE id = $id");
  const selectByExternalId = db.prepare(`
    SELECT * FROM assistant_conversations
    WHERE owner = $owner AND channel = $channel AND conversation_id_hash = $conversationIdHash
  `);

  function getOrCreate(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const conversationIdHash = hash(input.conversationId, "conversationId");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const existing = selectByExternalId.get({ $owner: owner, $channel: channel, $conversationIdHash: conversationIdHash });
      if (existing) return conversationFromRow(existing);
      const id = text(idFactory(), "generated conversation id", 200);
      db.prepare(`
        INSERT INTO assistant_conversations (id, owner, channel, conversation_id_hash, state, version, created_at, updated_at)
        VALUES ($id, $owner, $channel, $conversationIdHash, 'active', 1, $now, $now)
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationIdHash: conversationIdHash, $now: now });
      insertAudit(db, {
        action: "assistant.conversation.create",
        entityType: "assistant_conversation",
        entityId: id,
        actor: owner,
        requestId: id,
        after: { state: "active" },
        metadata: { owner, channel },
      });
      return conversationFromRow(selectConversation.get({ $id: id }));
    });
  }

  function getByExternalId(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const conversationIdHash = hash(input.conversationId, "conversationId");
    return conversationFromRow(selectByExternalId.get({ $owner: owner, $channel: channel, $conversationIdHash: conversationIdHash }));
  }

  function appendDraftPart(conversationIdValue, input = {}) {
    const conversationId = text(conversationIdValue, "conversationId", 200);
    const role = text(input.role, "role", 20);
    if (!["system", "user", "assistant", "tool"].includes(role)) throw new TypeError("role is invalid");
    const partText = text(input.text, "text");
    const metadataJson = json(input.metadata, "metadata");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const conversation = selectConversation.get({ $id: conversationId });
      if (!conversation) throw new Error("Assistant conversation was not found");
      const next = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM assistant_draft_parts WHERE conversation_id = $conversationId").get({ $conversationId: conversationId }).sequence;
      const id = text(input.id ?? idFactory(), "generated draft part id", 200);
      db.prepare(`
        INSERT INTO assistant_draft_parts (id, conversation_id, sequence, role, text, metadata_json, version, created_at, updated_at)
        VALUES ($id, $conversationId, $sequence, $role, $text, $metadataJson, 1, $now, $now)
      `).run({ $id: id, $conversationId: conversationId, $sequence: next, $role: role, $text: partText, $metadataJson: metadataJson, $now: now });
      db.prepare("UPDATE assistant_conversations SET version = version + 1, updated_at = $now WHERE id = $id").run({ $id: conversationId, $now: now });
      return partFromRow(db.prepare("SELECT * FROM assistant_draft_parts WHERE id = $id").get({ $id: id }));
    });
  }

  function listDraftParts(conversationIdValue) {
    const conversationId = text(conversationIdValue, "conversationId", 200);
    return db.prepare("SELECT * FROM assistant_draft_parts WHERE conversation_id = $conversationId ORDER BY sequence").all({ $conversationId: conversationId }).map(partFromRow);
  }

  function clearDraftParts(conversationIdValue) {
    const conversationId = text(conversationIdValue, "conversationId", 200);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const conversation = selectConversation.get({ $id: conversationId });
      if (!conversation) throw new Error("Assistant conversation was not found");
      const deleted = db.prepare("DELETE FROM assistant_draft_parts WHERE conversation_id = $conversationId")
        .run({ $conversationId: conversationId }).changes;
      if (deleted > 0) {
        db.prepare("UPDATE assistant_conversations SET version = version + 1, updated_at = $now WHERE id = $id")
          .run({ $id: conversationId, $now: now });
        insertAudit(db, {
          action: "assistant.draft.clear",
          entityType: "assistant_conversation",
          entityId: conversationId,
          actor: conversation.owner,
          requestId: conversationId,
          before: { partCount: deleted },
          after: { partCount: 0 },
          entityVersion: Number(conversation.version) + 1,
          metadata: { owner: conversation.owner, channel: conversation.channel },
        });
      }
      return deleted;
    });
  }

  function getContext(conversationIdValue) {
    const conversationId = text(conversationIdValue, "conversationId", 200);
    const parts = listDraftParts(conversationId);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const context = assistantContextFromPart(parts[index]);
      if (context) return context;
    }
    return {};
  }

  return {
    getOrCreate,
    getByExternalId,
    appendDraftPart,
    listDraftParts,
    clearDraftParts,
    getContext,
    getConversationContext: getContext,
    get: (id) => conversationFromRow(selectConversation.get({ $id: text(id, "id", 200) })),
  };
}
