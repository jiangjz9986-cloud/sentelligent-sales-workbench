import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function confirmationKey(value) {
  const key = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("confirmationSecret must contain at least 32 bytes");
  }
  return Buffer.from(key);
}

function confirmationHash(key, value) {
  return createHmac("sha256", key).update(text(value, "confirmationCode", 100), "utf8").digest("hex");
}

function sameDigest(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "hex");
  const rightBuffer = Buffer.from(String(right ?? ""), "hex");
  return leftBuffer.length === 32 && rightBuffer.length === 32 && timingSafeEqual(leftBuffer, rightBuffer);
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

function item(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel,
    conversationId: row.conversation_id,
    actionType: row.action_type,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    version: row.version,
    expiresAt: row.expires_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAssistantPendingActionRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
  confirmationSecret,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  const codeKey = confirmationKey(confirmationSecret);
  const selectById = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id");
  const selectByScope = db.prepare(`
    SELECT * FROM assistant_pending_actions
    WHERE id = $id AND owner = $owner AND channel = $channel
  `);
  const selectConversation = db.prepare(`
    SELECT id FROM assistant_conversations
    WHERE id = $id AND owner = $owner AND channel = $channel
  `);
  const selectActiveByConversation = db.prepare(`
    SELECT id FROM assistant_pending_actions
    WHERE owner = $owner AND channel = $channel AND conversation_id = $conversationId
      AND status IN ('pending', 'processing', 'confirmed')
    LIMIT 1
  `);

  function create(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const actionType = text(input.actionType, "actionType", 200);
    const confirmationCodeHash = confirmationHash(codeKey, input.confirmationCode);
    const expiresAt = text(input.expiresAt, "expiresAt", 100);
    if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError("expiresAt must be an ISO date-time");
    const payloadJson = json(input.payload, "payload");
    const now = iso(clock);
    const conversationId = input.conversationId === undefined || input.conversationId === null
      ? null
      : text(input.conversationId, "conversationId", 200);
    return withImmediateTransaction(db, () => {
      if (conversationId && !selectConversation.get({ $id: conversationId, $owner: owner, $channel: channel })) {
        throw new HttpError(404, "ASSISTANT_CONVERSATION_NOT_FOUND", "Assistant conversation was not found");
      }
      if (conversationId && selectActiveByConversation.get({
        $owner: owner,
        $channel: channel,
        $conversationId: conversationId,
      })) {
        throw new HttpError(409, "ASSISTANT_ACTION_PENDING", "The conversation already has a pending assistant action");
      }
      const id = text(input.id ?? idFactory(), "generated action id", 200);
      db.prepare(`
        INSERT INTO assistant_pending_actions (
          id, owner, channel, conversation_id, action_type, payload_json,
          status, version, confirmation_code_hash, expires_at, created_at, updated_at
        ) VALUES ($id, $owner, $channel, $conversationId, $actionType, $payloadJson, 'pending', 1, $confirmationCodeHash, $expiresAt, $now, $now)
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $actionType: actionType, $payloadJson: payloadJson, $confirmationCodeHash: confirmationCodeHash, $expiresAt: expiresAt, $now: now });
      insertAudit(db, {
        action: "assistant.action.create",
        entityType: "assistant_pending_action",
        entityId: id,
        actor: owner,
        requestId: id,
        after: { status: "pending", actionType },
        metadata: { owner, channel },
      });
      return item(selectById.get({ $id: id }));
    });
  }

  function confirm(idValue, { owner: ownerValue, channel: channelValue, confirmationCode } = {}) {
    const id = text(idValue, "id", 200);
    const owner = text(ownerValue, "owner", 200);
    const channel = text(channelValue, "channel", 100);
    const codeHash = confirmationHash(codeKey, confirmationCode);
    const now = iso(clock);
    const result = withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel });
      if (!current) throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      if (!sameDigest(current.confirmation_code_hash, codeHash)) {
        throw new HttpError(409, "ASSISTANT_CONFIRMATION_INVALID", "The confirmation code is invalid");
      }
      if (["confirmed", "executed"].includes(current.status)) return { item: item(current), replayed: true };
      if (current.status === "expired" || Date.parse(current.expires_at) <= Date.parse(now)) {
        db.prepare("UPDATE assistant_pending_actions SET status = 'expired', version = version + 1, updated_at = $now WHERE id = $id AND status NOT IN ('executed', 'expired')").run({ $id: id, $now: now });
        return { expired: true };
      }
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'confirmed', version = version + 1, updated_at = $now
        WHERE id = $id AND status = 'pending' AND confirmation_code_hash = $confirmationCodeHash
      `).run({ $id: id, $confirmationCodeHash: codeHash, $now: now });
      insertAudit(db, {
        action: "assistant.action.confirm",
        entityType: "assistant_pending_action",
        entityId: id,
        actor: current.owner,
        requestId: id,
        before: { status: current.status, version: current.version },
        after: { status: "confirmed", version: current.version + 1 },
        metadata: { owner: current.owner, channel: current.channel },
      });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
    if (result.expired) {
      throw new HttpError(410, "ASSISTANT_ACTION_EXPIRED", "The assistant action confirmation window has expired");
    }
    return result;
  }

  function expire(nowValue = iso(clock)) {
    const now = text(nowValue, "now", 100);
    return db.prepare(`
      UPDATE assistant_pending_actions
      SET status = 'expired', version = version + 1, updated_at = $now
      WHERE status = 'pending' AND expires_at <= $now
    `).run({ $now: now }).changes;
  }

  function markExecuted(idValue, { owner: ownerValue, channel: channelValue, result = {} } = {}) {
    const id = text(idValue, "id", 200);
    const owner = text(ownerValue, "owner", 200);
    const channel = text(channelValue, "channel", 100);
    const resultJson = json(result, "result");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel });
      if (!current) throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      if (current.status === "executed") return { item: item(current), replayed: true };
      if (current.status !== "confirmed") {
        throw new HttpError(409, "ASSISTANT_ACTION_NOT_CONFIRMED", "The assistant action has not been confirmed");
      }
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'executed', version = version + 1, result_json = $resultJson, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel AND status = 'confirmed'
      `).run({ $id: id, $owner: owner, $channel: channel, $resultJson: resultJson, $now: now });
      insertAudit(db, {
        action: "assistant.action.execute",
        entityType: "assistant_pending_action",
        entityId: id,
        actor: owner,
        requestId: id,
        before: { status: current.status, version: current.version },
        after: { status: "executed", version: current.version + 1 },
        metadata: { owner, channel },
      });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
  }

  function get(idValue, { owner: ownerValue, channel: channelValue } = {}) {
    const id = text(idValue, "id", 200);
    const owner = text(ownerValue, "owner", 200);
    const channel = text(channelValue, "channel", 100);
    return item(selectByScope.get({ $id: id, $owner: owner, $channel: channel }));
  }

  return { create, confirm, expire, markExecuted, get };
}
