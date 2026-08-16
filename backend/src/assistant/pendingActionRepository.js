import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function exactText(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  if (value.length > max) throw new TypeError(`${name} is too long`);
  return value;
}

function confirmationKey(value) {
  const key = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("confirmationSecret must contain at least 32 bytes");
  }
  return Buffer.from(key);
}

function confirmationHash(key, value) {
  const code = exactText(value, "confirmationCode", 100);
  if (!/^\d{6}$/u.test(code)) throw new TypeError("confirmationCode must contain exactly six digits");
  return createHmac("sha256", key).update(code, "utf8").digest("hex");
}

function encodeLengthPrefixed(parts) {
  return Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    return Buffer.concat([length, value]);
  }));
}

function confirmationAttemptHash(key, { owner, channel, conversationId, eventId }) {
  return createHmac("sha256", key).update(encodeLengthPrefixed([
    "sentelligent/assistant-confirmation-attempt/v1",
    owner,
    channel,
    conversationId ?? "",
    eventId,
  ])).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function planDigest(value) {
  const encoded = JSON.stringify(canonicalValue(value));
  if (!encoded) throw new TypeError("plan must be JSON serializable");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function leaseHash(value) {
  return createHash("sha256").update(text(value, "leaseToken", 200), "utf8").digest("hex");
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
    planDigest: row.plan_digest ?? null,
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
      AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
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
  const selectActiveRowsByConversation = db.prepare(`
    SELECT * FROM assistant_pending_actions
    WHERE owner = $owner AND channel = $channel AND conversation_id = $conversationId
      AND status IN ('pending', 'processing', 'confirmed')
    ORDER BY created_at, id
    LIMIT 2
  `);

  function scope(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const conversationProvided = Object.hasOwn(input, "conversationId");
    if (!conversationProvided) throw new TypeError("conversationId is required");
    const conversationId = input.conversationId === null
      ? null
      : text(input.conversationId, "conversationId", 200);
    return { owner, channel, conversationProvided, conversationId };
  }

  function scopedRow(id, input = {}) {
    const values = scope(input);
    const row = selectByScope.get({
      $id: id,
      $owner: values.owner,
      $channel: values.channel,
      $conversationId: values.conversationId,
    });
    if (!row) return { values, row: null };
    if (values.conversationProvided && row.conversation_id !== values.conversationId) {
      return { values, row: null };
    }
    return { values, row };
  }

  function create(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    const actionType = text(input.actionType, "actionType", 200);
    const confirmationCodeHash = confirmationHash(codeKey, input.confirmationCode);
    const expiresAtInput = text(input.expiresAt, "expiresAt", 100);
    const expiresAtMs = Date.parse(expiresAtInput);
    if (!Number.isFinite(expiresAtMs)) throw new TypeError("expiresAt must be an ISO date-time");
    const expiresAt = new Date(expiresAtMs).toISOString();
    const payloadJson = json(input.payload, "payload");
    const payloadValue = input.payload === undefined ? {} : input.payload;
    const storedPlanDigest = input.planDigest === undefined || input.planDigest === null
      ? planDigest(payloadValue?.plan ?? payloadValue)
      : text(input.planDigest, "planDigest", 64);
    if (!/^[0-9a-f]{64}$/u.test(storedPlanDigest)) throw new TypeError("planDigest must be a lowercase SHA-256 digest");
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
      const updated = db.prepare(`
        INSERT INTO assistant_pending_actions (
          id, owner, channel, conversation_id, action_type, payload_json, plan_digest,
          status, version, confirmation_code_hash, expires_at, created_at, updated_at
        ) VALUES ($id, $owner, $channel, $conversationId, $actionType, $payloadJson, $planDigest, 'pending', 1, $confirmationCodeHash, $expiresAt, $now, $now)
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $actionType: actionType, $payloadJson: payloadJson, $planDigest: storedPlanDigest, $confirmationCodeHash: confirmationCodeHash, $expiresAt: expiresAt, $now: now });
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

  function exactScope(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const channel = text(input.channel, "channel", 100);
    if (!Object.hasOwn(input, "conversationId")) throw new TypeError("conversationId is required");
    const conversationId = input.conversationId === null
      ? null
      : text(input.conversationId, "conversationId", 200);
    return { owner, channel, conversationId };
  }

  function findActiveByConversation(input = {}) {
    const { owner, channel, conversationId } = exactScope(input);
    if (!conversationId) throw new TypeError("conversationId is required");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'expired', version = version + 1, updated_at = $now
        WHERE owner = $owner AND channel = $channel AND conversation_id = $conversationId
          AND status IN ('pending', 'confirmed') AND datetime(expires_at) <= datetime($now)
      `).run({ $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
      const rows = selectActiveRowsByConversation.all({
        $owner: owner,
        $channel: channel,
        $conversationId: conversationId,
      });
      if (rows.length > 1) {
        throw new HttpError(500, "ASSISTANT_ACTION_INVARIANT", "Assistant action state is invalid");
      }
      return item(rows[0]);
    });
  }

  function recordConfirmationFailure(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationId } = exactScope(input);
    const eventId = exactText(input.eventId, "eventId", 500);
    const eventIdHash = confirmationAttemptHash(codeKey, { owner, channel, conversationId, eventId });
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM assistant_pending_actions
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
      `).get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "failed" && current.error_code === "ASSISTANT_CONFIRMATION_LOCKED") {
        return { item: item(current), counted: false, locked: true };
      }
      if (current.status === "expired" || Date.parse(current.expires_at) <= Date.parse(now)) {
        db.prepare(`
          UPDATE assistant_pending_actions
          SET status = 'expired', version = version + 1, updated_at = $now
          WHERE id = $id AND owner = $owner AND channel = $channel
            AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
            AND status IN ('pending', 'confirmed')
        `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
        throw new HttpError(410, "ASSISTANT_ACTION_EXPIRED", "The assistant action confirmation window has expired");
      }
      if (!["pending", "confirmed"].includes(current.status)) {
        throw new HttpError(409, "ASSISTANT_ACTION_STATE_CONFLICT", "The assistant action cannot accept confirmation attempts");
      }
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO assistant_confirmation_attempts (action_id, event_id_hash, created_at)
        VALUES ($actionId, $eventIdHash, $now)
      `).run({ $actionId: id, $eventIdHash: eventIdHash, $now: now });
      if (inserted.changes !== 1) {
        return { item: item(current), counted: false, locked: current.confirmation_attempts >= 5 };
      }
      const updated = db.prepare(`
        UPDATE assistant_pending_actions
        SET confirmation_attempts = confirmation_attempts + 1,
            status = CASE WHEN confirmation_attempts + 1 = 5 THEN 'failed' ELSE status END,
            error_code = CASE WHEN confirmation_attempts + 1 = 5 THEN 'ASSISTANT_CONFIRMATION_LOCKED' ELSE error_code END,
            confirmation_locked_at = CASE WHEN confirmation_attempts + 1 = 5 THEN $now ELSE confirmation_locked_at END,
            lease_token_hash = CASE WHEN confirmation_attempts + 1 = 5 THEN NULL ELSE lease_token_hash END,
            lease_expires_at = CASE WHEN confirmation_attempts + 1 = 5 THEN NULL ELSE lease_expires_at END,
            version = version + 1, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status IN ('pending', 'confirmed') AND confirmation_attempts < 5
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
      if (updated.changes !== 1) {
        throw new HttpError(500, "ASSISTANT_ACTION_INVARIANT", "Assistant action state is invalid");
      }
      const next = selectById.get({ $id: id });
      return { item: item(next), counted: true, locked: next.confirmation_attempts === 5 };
    });
  }

  function cancel(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationId } = exactScope(input);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM assistant_pending_actions
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
      `).get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "cancelled") return { item: item(current), replayed: true };
      const activeLease = current.status === "processing"
        && current.lease_expires_at
        && Date.parse(current.lease_expires_at) > Date.parse(now);
      if (activeLease) {
        throw new HttpError(409, "ASSISTANT_ACTION_IN_PROGRESS", "The assistant action is already being executed");
      }
      if (!["pending", "confirmed", "processing"].includes(current.status)) {
        throw new HttpError(409, "ASSISTANT_ACTION_STATE_CONFLICT", "The assistant action cannot be cancelled");
      }
      const updated = db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'cancelled', version = version + 1,
            lease_token_hash = NULL, lease_expires_at = NULL, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND (
            status IN ('pending', 'confirmed')
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= $now))
          )
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
      if (updated.changes !== 1) {
        throw new HttpError(409, "ASSISTANT_ACTION_IN_PROGRESS", "The assistant action is already being executed");
      }
      insertAudit(db, {
        action: "assistant.action.cancel",
        entityType: "assistant_pending_action",
        entityId: id,
        actor: owner,
        requestId: id,
        before: { status: current.status, version: current.version },
        after: { status: "cancelled", version: current.version + 1 },
        metadata: { owner, channel },
      });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
  }

  function confirm(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationProvided, conversationId } = scope(input);
    const confirmationCode = input.confirmationCode;
    const codeHash = confirmationHash(codeKey, confirmationCode);
    const now = iso(clock);
    const result = withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current) throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      if (conversationProvided && current.conversation_id !== conversationId) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "failed" && current.error_code === "ASSISTANT_CONFIRMATION_LOCKED") {
        throw new HttpError(409, "ASSISTANT_CONFIRMATION_LOCKED", "The assistant action confirmation is locked");
      }
      if (!sameDigest(current.confirmation_code_hash, codeHash)) {
        throw new HttpError(409, "ASSISTANT_CONFIRMATION_INVALID", "The confirmation code is invalid");
      }
      if (current.status === "confirmed" || current.status === "executed") {
        return { item: item(current), replayed: true };
      }
      if (current.status === "processing") {
        const leaseActive = current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.parse(now);
        return { item: item(current), replayed: true, inProgress: Boolean(leaseActive) };
      }
      if (current.status === "expired" || Date.parse(current.expires_at) <= Date.parse(now)) {
        db.prepare(`
          UPDATE assistant_pending_actions
          SET status = 'expired', version = version + 1, updated_at = $now
          WHERE id = $id AND owner = $owner AND channel = $channel
            AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
            AND status NOT IN ('executed', 'expired')
        `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
        return { expired: true };
      }
      const updated = db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'confirmed', version = version + 1, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status = 'pending' AND confirmation_code_hash = $confirmationCodeHash
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $confirmationCodeHash: codeHash, $now: now });
      if (updated.changes !== 1) {
        throw new HttpError(409, "ASSISTANT_CONFIRMATION_INVALID", "The confirmation code is invalid");
      }
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

  function renewConfirmation(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationId } = exactScope(input);
    const confirmationCode = exactText(input.confirmationCode, "confirmationCode", 100);
    const confirmationCodeHash = confirmationHash(codeKey, confirmationCode);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM assistant_pending_actions
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
      `).get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "executed") {
        throw new HttpError(409, "ASSISTANT_ACTION_ALREADY_EXECUTED", "The assistant action has already been executed");
      }
      if (current.status === "processing") {
        const leaseActive = current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.parse(now);
        if (leaseActive) {
          throw new HttpError(409, "ASSISTANT_ACTION_IN_PROGRESS", "The assistant action is already being executed");
        }
      }
      if (current.status === "expired" || Date.parse(current.expires_at) <= Date.parse(now)) {
        throw new HttpError(410, "ASSISTANT_ACTION_EXPIRED", "The assistant action confirmation window has expired");
      }
      const updated = db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'pending', version = version + 1,
            confirmation_code_hash = $confirmationCodeHash,
            lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND (
            status IN ('pending', 'confirmed')
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= $now))
          )
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $confirmationCodeHash: confirmationCodeHash, $now: now });
      if (updated.changes !== 1) {
        throw new HttpError(409, "ASSISTANT_ACTION_IN_PROGRESS", "The assistant action is already being executed");
      }
      insertAudit(db, {
        action: "assistant.action.renew",
        entityType: "assistant_pending_action",
        entityId: id,
        actor: owner,
        requestId: id,
        before: { status: current.status, version: current.version },
        after: { status: "pending", version: current.version + 1 },
        metadata: { owner, channel },
      });
      return { item: item(selectById.get({ $id: id })), confirmationCode };
    });
  }

  function expire(nowValue = iso(clock)) {
    const now = text(nowValue, "now", 100);
    return withImmediateTransaction(db, () => db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'expired', version = version + 1, updated_at = $now
        WHERE status = 'pending' AND expires_at <= $now
      `).run({ $now: now }).changes);
  }

  function markExecuted(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationProvided, conversationId } = scope(input);
    const result = input.result ?? {};
    const resultJson = json(result, "result");
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current) throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      if (conversationProvided && current.conversation_id !== conversationId) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "executed") return { item: item(current), replayed: true };
      if (current.status !== "confirmed") {
        throw new HttpError(409, "ASSISTANT_ACTION_NOT_CONFIRMED", "The assistant action has not been confirmed");
      }
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'executed', version = version + 1, result_json = $resultJson, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status = 'confirmed'
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $resultJson: resultJson, $now: now });
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

  function claimExecution(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationProvided, conversationId } = scope(input);
    const leaseMs = input.leaseMs ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1000) {
      throw new TypeError("leaseMs must be a positive duration no longer than 24 hours");
    }
    const now = iso(clock);
    const nowMs = Date.parse(now);
    return withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current || (conversationProvided && current.conversation_id !== conversationId)) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      try {
        const payload = JSON.parse(current.payload_json);
        const expectedDigest = planDigest(payload?.plan ?? payload);
        if (current.plan_digest && current.plan_digest !== expectedDigest) {
          throw new HttpError(409, "ASSISTANT_ACTION_INVALID", "The stored assistant action is invalid");
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, "ASSISTANT_ACTION_INVALID", "The stored assistant action is invalid");
      }
      if (current.status === "executed") return { item: item(current), replayed: true };
      if (current.status === "expired" || Date.parse(current.expires_at) <= nowMs) {
        db.prepare(`
          UPDATE assistant_pending_actions
          SET status = 'expired', version = version + 1, updated_at = $now
          WHERE id = $id AND owner = $owner AND channel = $channel
            AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
            AND status NOT IN ('executed', 'expired')
        `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $now: now });
        throw new HttpError(410, "ASSISTANT_ACTION_EXPIRED", "The assistant action confirmation window has expired");
      }
      if (!["confirmed", "processing"].includes(current.status)) {
        throw new HttpError(409, "ASSISTANT_ACTION_NOT_CONFIRMED", "The assistant action has not been confirmed");
      }
      const activeLease = current.status === "processing"
        && current.lease_expires_at
        && Date.parse(current.lease_expires_at) > nowMs;
      if (activeLease) return { item: item(current), inProgress: true, replayed: false };
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'processing', version = version + 1,
            lease_token_hash = $leaseTokenHash, lease_expires_at = $leaseExpiresAt,
            updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status IN ('confirmed', 'processing')
      `).run({
        $id: id,
        $owner: owner,
        $channel: channel,
        $conversationId: conversationId,
        $leaseTokenHash: leaseHash(leaseToken),
        $leaseExpiresAt: leaseExpiresAt,
        $now: now,
      });
      return { item: item(selectById.get({ $id: id })), replayed: false, leaseToken };
    });
  }

  function completeExecution(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationProvided, conversationId } = scope(input);
    const leaseToken = text(input.leaseToken, "leaseToken", 200);
    const resultJson = json(input.result, "result");
    const tokenHash = leaseHash(leaseToken);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current || (conversationProvided && current.conversation_id !== conversationId)) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status === "executed") return { item: item(current), replayed: true };
      if (current.status !== "processing" || current.lease_token_hash !== tokenHash || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= Date.parse(now)) {
        throw new HttpError(409, "ASSISTANT_ACTION_LEASE_LOST", "The assistant action execution lease is no longer current");
      }
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'executed', version = version + 1,
            lease_token_hash = NULL, lease_expires_at = NULL,
            result_json = $resultJson, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status = 'processing' AND lease_token_hash = $leaseTokenHash
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $leaseTokenHash: tokenHash, $resultJson: resultJson, $now: now });
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

  function releaseExecution(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { owner, channel, conversationProvided, conversationId } = scope(input);
    const leaseToken = text(input.leaseToken, "leaseToken", 200);
    const tokenHash = leaseHash(leaseToken);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const current = selectByScope.get({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId });
      if (!current || (conversationProvided && current.conversation_id !== conversationId)) {
        throw new HttpError(404, "ASSISTANT_ACTION_NOT_FOUND", "Assistant pending action was not found");
      }
      if (current.status !== "processing" || current.lease_token_hash !== tokenHash) {
        return { item: item(current), replayed: true };
      }
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'confirmed', version = version + 1,
            lease_token_hash = NULL, lease_expires_at = NULL,
            error_code = $errorCode, updated_at = $now
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND (conversation_id = $conversationId OR (conversation_id IS NULL AND $conversationId IS NULL))
          AND status = 'processing' AND lease_token_hash = $leaseTokenHash
      `).run({ $id: id, $owner: owner, $channel: channel, $conversationId: conversationId, $leaseTokenHash: tokenHash, $errorCode: input.errorCode ?? null, $now: now });
      return { item: item(selectById.get({ $id: id })), replayed: false };
    });
  }

  function get(idValue, input = {}) {
    const id = text(idValue, "id", 200);
    const { row } = scopedRow(id, input);
    return item(row);
  }

  return {
    create,
    findActiveByConversation,
    confirm,
    recordConfirmationFailure,
    cancel,
    renewConfirmation,
    expire,
    markExecuted,
    claimExecution,
    completeExecution,
    releaseExecution,
    get,
  };
}
