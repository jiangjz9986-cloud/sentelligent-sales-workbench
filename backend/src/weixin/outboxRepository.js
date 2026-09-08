import { createHash, randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { withImmediateTransaction } from "../db/transaction.js";

const MAX_PAYLOAD_BYTES = 20_000;
const SENSITIVE_KEY = /(?:^|_)(?:confirmation|code|token|secret|credential|password|authorization)(?:$|_)/iu;
const RETRYABLE_FAILURE_CODES = new Set([
  "WEIXIN_CONTEXT_NOT_READY",
  "WEIXIN_SEND_FAILED",
]);

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function inspectPayload(value, path = "payload") {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new TypeError(`${path} is too large`);
    value.forEach((item, index) => inspectPayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be JSON data`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || /(?:owner|actor|identity|account|source|idempotency)/iu.test(key)) {
      // Identity is allowed only in the surrounding envelope; it must never be
      // duplicated into the rendered payload or accidentally become a secret.
      throw new TypeError(`${path}.${key} is sensitive`);
    }
    inspectPayload(child, `${path}.${key}`);
  }
}

function payloadJson(value) {
  inspectPayload(value);
  const encoded = JSON.stringify(canonical(value));
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) throw new TypeError("payload is too large");
  return encoded;
}

function item(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    conversationId: row.conversation_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    lastErrorCode: row.last_error_code,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

export function createWeixinConfirmationOutboxRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
  leaseMs = 30_000,
  retryBaseMs = 2_000,
  maxAttempts = 8,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1000) throw new TypeError("leaseMs is invalid");
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs <= 0 || retryBaseMs > 24 * 60 * 60 * 1000) throw new TypeError("retryBaseMs is invalid");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError("maxAttempts is invalid");
  const selectById = db.prepare("SELECT * FROM weixin_confirmation_outbox WHERE id = $id");
  const selectByKey = db.prepare("SELECT * FROM weixin_confirmation_outbox WHERE owner = $owner AND idempotency_key_hash = $keyHash");

  function enqueue(input = {}) {
    const owner = text(input.owner, "owner", 200);
    const conversationId = text(input.conversationId, "conversationId", 300);
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 300);
    const encoded = payloadJson(input.payload ?? {});
    const payloadHash = hash(encoded);
    const keyHash = hash(idempotencyKey);
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const existing = selectByKey.get({ $owner: owner, $keyHash: keyHash });
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.conversation_id !== conversationId) {
          throw new HttpError(409, "WEIXIN_OUTBOX_IDEMPOTENCY_CONFLICT", "The WeChat outbox idempotency key was reused for different content");
        }
        return { ...item(existing), replayed: true };
      }
      const id = text(input.id ?? idFactory(), "outbox id", 200);
      db.prepare(`
        INSERT INTO weixin_confirmation_outbox (
          id, owner, conversation_id, idempotency_key_hash, payload_json, payload_hash,
          status, attempt_count, available_at, created_at, updated_at
        ) VALUES ($id, $owner, $conversationId, $keyHash, $payloadJson, $payloadHash,
          'queued', 0, $now, $now, $now)
      `).run({ $id: id, $owner: owner, $conversationId: conversationId, $keyHash: keyHash, $payloadJson: encoded, $payloadHash: payloadHash, $now: now });
      return { ...item(selectById.get({ $id: id })), replayed: false };
    });
  }

  // Read-only point lookup on the enqueue idempotency key. The digest
  // scheduler treats an existing row as the durable "already sent today"
  // marker, so this must never mutate state or consider delivery status.
  function hasKey({ owner, idempotencyKey } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    const keyHash = hash(text(idempotencyKey, "idempotencyKey", 300));
    return Boolean(selectByKey.get({ $owner: normalizedOwner, $keyHash: keyHash }));
  }

  function leaseNext({ workerId = "weixin-worker", renderMessage } = {}) {
    const normalizedWorker = text(workerId, "workerId", 200);
    if (typeof renderMessage !== "function") throw new TypeError("renderMessage is required");
    const now = iso(clock);
    const nowMs = Date.parse(now);
    const leaseToken = randomUUID();
    const leased = withImmediateTransaction(db, () => {
      const row = db.prepare(`
        SELECT * FROM weixin_confirmation_outbox
        WHERE (status = 'queued' AND available_at <= $now)
           OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= $now)
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get({ $now: now });
      if (!row) return null;
      const updated = db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'processing', lease_proof_hash = $leaseProofHash,
            lease_until = $leaseUntil, updated_at = $now
        WHERE id = $id AND (
          (status = 'queued' AND available_at <= $now)
          OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= $now)
        )
      `).run({ $id: row.id, $leaseProofHash: hash(leaseToken), $leaseUntil: new Date(nowMs + leaseMs).toISOString(), $now: now });
      if (updated.changes !== 1) return null;
      return { row: selectById.get({ $id: row.id }), leaseToken, workerId: normalizedWorker };
    });
    if (!leased) return null;
    const base = item(leased.row);
    let message;
    try {
      message = renderMessage(base);
      if (typeof message !== "string" || !message.trim() || message.length > 20_000) throw new TypeError("rendered message is invalid");
    } catch (error) {
      try {
        if (error?.code === "WEIXIN_OUTBOX_STALE") {
          discardLeased(base.id, { leaseToken: leased.leaseToken });
        } else {
          ackFailure(base.id, { leaseToken: leased.leaseToken, errorCode: "WEIXIN_RENDER_FAILED" });
        }
      } catch { /* best effort */ }
      if (error?.code === "WEIXIN_OUTBOX_STALE") return null;
      throw error;
    }
    return { item: { ...base, status: "processing" }, leaseToken: leased.leaseToken, workerId: leased.workerId, message };
  }

  function checkLease(idValue, leaseTokenValue) {
    const id = text(idValue, "id", 200);
    const leaseToken = text(leaseTokenValue, "leaseToken", 200);
    const now = iso(clock);
    const row = selectById.get({ $id: id });
    if (!row) throw new HttpError(404, "WEIXIN_OUTBOX_NOT_FOUND", "WeChat outbox item was not found");
    if (row.status === "sent") return { row, replayed: true };
    if (row.status !== "processing" || row.lease_proof_hash !== hash(leaseToken) || !row.lease_until || Date.parse(row.lease_until) <= Date.parse(now)) {
      throw new HttpError(409, "WEIXIN_OUTBOX_LEASE_LOST", "WeChat outbox lease is no longer current");
    }
    return { row, replayed: false };
  }

  function ackSuccess(idValue, { leaseToken, providerMessageId = null } = {}) {
    const id = text(idValue, "id", 200);
    const provider = providerMessageId === null || providerMessageId === undefined || providerMessageId === ""
      ? null
      : text(providerMessageId, "providerMessageId", 200);
    return withImmediateTransaction(db, () => {
      const state = checkLease(id, leaseToken);
      if (state.replayed) return item(state.row);
      const now = iso(clock);
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'sent', lease_proof_hash = NULL, lease_until = NULL,
            provider_message_id = $provider, sent_at = $now, updated_at = $now
        WHERE id = $id AND status = 'processing' AND lease_proof_hash = $leaseProofHash
      `).run({ $id: id, $leaseProofHash: hash(leaseToken), $provider: provider, $now: now });
      return item(selectById.get({ $id: id }));
    });
  }

  function ackFailure(idValue, { leaseToken, errorCode = "WEIXIN_SEND_FAILED" } = {}) {
    const id = text(idValue, "id", 200);
    const normalizedError = text(errorCode, "errorCode", 100).replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 100) || "WEIXIN_SEND_FAILED";
    return withImmediateTransaction(db, () => {
      const state = checkLease(id, leaseToken);
      if (state.replayed) return item(state.row);
      const now = iso(clock);
      const nextAttempt = Number(state.row.attempt_count) + 1;
      const terminal = nextAttempt >= maxAttempts;
      const delay = retryBaseMs * (2 ** Math.min(nextAttempt - 1, 10));
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = $status, attempt_count = $attemptCount,
            available_at = $availableAt, lease_proof_hash = NULL, lease_until = NULL,
            last_error_code = $errorCode, updated_at = $now
        WHERE id = $id AND status = 'processing' AND lease_proof_hash = $leaseProofHash
      `).run({ $id: id, $status: terminal ? "failed" : "queued", $attemptCount: nextAttempt, $availableAt: new Date(Date.parse(now) + delay).toISOString(), $leaseProofHash: hash(leaseToken), $errorCode: normalizedError, $now: now });
      return item(selectById.get({ $id: id }));
    });
  }

  function discardLeased(idValue, { leaseToken, errorCode = "WEIXIN_OUTBOX_STALE" } = {}) {
    const id = text(idValue, "id", 200);
    const normalizedError = text(errorCode, "errorCode", 100)
      .replace(/[^A-Za-z0-9_.-]/gu, "_")
      .slice(0, 100) || "WEIXIN_OUTBOX_STALE";
    return withImmediateTransaction(db, () => {
      const state = checkLease(id, leaseToken);
      if (state.replayed) return item(state.row);
      const now = iso(clock);
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'failed', lease_proof_hash = NULL, lease_until = NULL,
            last_error_code = $errorCode, updated_at = $now
        WHERE id = $id AND status = 'processing' AND lease_proof_hash = $leaseProofHash
      `).run({ $id: id, $leaseProofHash: hash(leaseToken), $errorCode: normalizedError, $now: now });
      return item(selectById.get({ $id: id }));
    });
  }

  // This is an explicit recovery operation, not part of normal idempotent
  // enqueue/replay. Only transient provider failures may be reopened, and the
  // cumulative attempt count is retained so replay cannot bypass the ceiling.
  function requeueFailed(idValue) {
    const id = text(idValue, "id", 200);
    return withImmediateTransaction(db, () => {
      const row = selectById.get({ $id: id });
      if (!row) throw new HttpError(404, "WEIXIN_OUTBOX_NOT_FOUND", "WeChat outbox item was not found");
      if (row.status !== "failed") return item(row);
      if (!RETRYABLE_FAILURE_CODES.has(row.last_error_code)) {
        throw new HttpError(409, "WEIXIN_OUTBOX_NOT_RETRYABLE", "WeChat outbox failure is terminal and cannot be retried");
      }
      const now = iso(clock);
      db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'queued', available_at = $now,
            lease_proof_hash = NULL, lease_until = NULL,
            provider_message_id = NULL, sent_at = NULL, updated_at = $now
        WHERE id = $id AND status = 'failed'
      `).run({ $id: id, $now: now });
      return item(selectById.get({ $id: id }));
    });
  }

  // Close queued or leased messages that refer to an older bookkeeping
  // draft. A correction/cancellation must never leave a stale confirmation
  // message waiting to be delivered after the user has already acted on it.
  // `failed` is an existing terminal outbox state, so this remains compatible
  // with databases created by migration 0019 and does not store user text.
  function closePending({ owner, conversationId, actionId, entryId, errorCode = "WEIXIN_OUTBOX_SUPERSEDED" } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    const normalizedConversationId = text(conversationId, "conversationId", 300);
    const normalizedActionId = text(actionId, "actionId", 200);
    const normalizedEntryId = text(entryId, "entryId", 200);
    const normalizedError = text(errorCode, "errorCode", 100)
      .replace(/[^A-Za-z0-9_.-]/gu, "_")
      .slice(0, 100) || "WEIXIN_OUTBOX_SUPERSEDED";
    const now = iso(clock);
    return withImmediateTransaction(db, () => {
      const result = db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'failed', lease_proof_hash = NULL, lease_until = NULL,
            last_error_code = $errorCode, updated_at = $now
        WHERE owner = $owner AND conversation_id = $conversationId
          AND status IN ('queued', 'processing')
          AND json_extract(payload_json, '$.actionId') = $actionId
          AND json_extract(payload_json, '$.entryId') = $entryId
      `).run({
        $owner: normalizedOwner,
        $conversationId: normalizedConversationId,
        $actionId: normalizedActionId,
        $entryId: normalizedEntryId,
        $errorCode: normalizedError,
        $now: now,
      });
      return { closedCount: Number(result.changes ?? 0) };
    });
  }

  function discardExpiredOpsAlerts({ maxQueueAgeMs, now = clock() } = {}) {
    if (!Number.isSafeInteger(maxQueueAgeMs) || maxQueueAgeMs <= 0) {
      throw new TypeError("maxQueueAgeMs is invalid");
    }
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowDate.getTime())) throw new TypeError("now is invalid");
    const nowIso = nowDate.toISOString();
    const cutoffAt = new Date(nowDate.getTime() - maxQueueAgeMs).toISOString();
    return withImmediateTransaction(db, () => {
      const result = db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'failed', lease_proof_hash = NULL, lease_until = NULL,
            last_error_code = 'WEIXIN_OUTBOX_STALE', updated_at = $now
        WHERE json_extract(payload_json, '$.kind') = 'ops_alert'
          AND created_at < $cutoffAt
          AND (
            status = 'queued'
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= $now)
          )
      `).run({ $cutoffAt: cutoffAt, $now: nowIso });
      return { discardedCount: Number(result.changes ?? 0), cutoffAt };
    });
  }

  function isLeaseCurrent(idValue, leaseTokenValue) {
    try {
      const state = checkLease(idValue, leaseTokenValue);
      return !state.replayed;
    } catch {
      return false;
    }
  }

  // Read-only aggregate for the ops-alerts status endpoint: per-status counts
  // plus the oldest queued availability so an inspector can spot backlog.
  function statusCounts() {
    const counts = { queued: 0, processing: 0, sent: 0, failed: 0 };
    for (const row of db.prepare(
      "SELECT status, COUNT(*) AS count FROM weixin_confirmation_outbox GROUP BY status",
    ).all()) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count);
    }
    const oldest = db.prepare(
      "SELECT MIN(available_at) AS oldest FROM weixin_confirmation_outbox WHERE status = 'queued'",
    ).get();
    return { ...counts, oldestQueuedAt: oldest?.oldest ?? null };
  }

  function latestForEntry({ owner, entryId } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    const normalizedEntryId = text(entryId, "entryId", 200);
    return item(db.prepare(`
      SELECT * FROM weixin_confirmation_outbox
      WHERE owner = $owner
        AND json_extract(payload_json, '$.entryId') = $entryId
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get({ $owner: normalizedOwner, $entryId: normalizedEntryId }));
  }

  return Object.freeze({
    enqueue,
    hasKey,
    leaseNext,
    ackSuccess,
    ackFailure,
    discardLeased,
    requeueFailed,
    closePending,
    discardExpiredOpsAlerts,
    isLeaseCurrent,
    statusCounts,
    latestForEntry,
    get: (id) => item(selectById.get({ $id: text(id, "id", 200) })),
  });
}
