import { createHash, randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";

export const PROACTIVE_SCAN_DEFAULT_INTERVAL_SECONDS = 5 * 60;
export const PROACTIVE_SCAN_DEFAULT_BATCH_SIZE = 50;
export const PROACTIVE_SCAN_DEFAULT_LEASE_MS = 2 * 60 * 1000;
export const PROACTIVE_SCAN_DEFAULT_RETRY_BASE_MS = 30 * 1000;
export const PROACTIVE_SCAN_MAX_INTERVAL_SECONDS = 24 * 60 * 60;
export const PROACTIVE_SCAN_MAX_BATCH_SIZE = 500;
export const PROACTIVE_SCAN_MAX_RETRY_BASE_MS = 24 * 60 * 60 * 1000;

const STATE_STATUSES = new Set(["idle", "running", "success", "partial", "failed", "disabled", "waiting"]);
const RUN_STATUSES = new Set(["running", "success", "partial", "failed", "skipped"]);
const RUN_TRIGGERS = new Set(["scheduled", "event", "manual", "recovery"]);
const EVENT_STATUSES = new Set(["queued", "processing", "completed", "failed", "cancelled"]);
const PROACTIVE_STATUSES = new Set(["pending", "snoozed", "dismissed", "resolved", "expired", "failed"]);
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,500}$/u;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,200}$/u;
const SENSITIVE_KEY = /(?:password|secret|token|authorization|cookie|credential|private.?key|raw.?content|body|contact|phone|mobile|email)/iu;

function text(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name, max = 500) {
  const normalized = text(value, name, max);
  if (!SAFE_IDENTIFIER.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function errorCode(value, name = "errorCode") {
  const normalized = text(value, name, 200).replace(/[^A-Za-z0-9_.:-]/gu, "_");
  if (!ERROR_CODE.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function date(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid date`);
  return parsed;
}

function iso(value, name, options = {}) {
  const parsed = date(value, name, options);
  return parsed ? parsed.toISOString() : null;
}

function clockDate(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return date(clock(), "clock");
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const normalized = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function comparablePayloadHash(eventType, payloadJson) {
  if (eventType !== "hospital_tender_changed") return hash(payloadJson);
  const payload = parseJson(payloadJson, null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return hash(payloadJson);
  // Older tender events persisted the scheduler attempt id in the payload
  // while the event key intentionally excluded it. Ignore that one legacy
  // field during replay comparison; all business identities remain strict.
  if (!Object.hasOwn(payload, "runId")) return hash(payloadJson);
  const { runId: _legacyRunId, ...stablePayload } = payload;
  return hash(json(stablePayload, "payload"));
}

function canonical(value, path = "value", depth = 0, seen = new Set()) {
  if (depth > 10) throw new TypeError(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 500) throw new TypeError(`${path} contains too many items`);
      return value.map((item, index) => canonical(item, `${path}[${index}]`, depth + 1, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (SENSITIVE_KEY.test(key)) throw new TypeError(`${path}.${key} is sensitive`);
      result[key] = canonical(value[key], `${path}.${key}`, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function json(value, name, { maxBytes = 128 * 1024 } = {}) {
  const encoded = JSON.stringify(canonical(value, name));
  if (!encoded || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new TypeError(`${name} is too large`);
  return encoded;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed;
  } catch {
    return fallback;
  }
}

function mapState(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    intervalSeconds: Number(row.interval_seconds),
    batchSize: Number(row.batch_size),
    cursorOwner: row.cursor_owner ?? null,
    cursorOpportunityId: row.cursor_opportunity_id ?? null,
    cycleNumber: Number(row.cycle_number),
    cycleObjectCount: Number(row.cycle_object_count),
    cycleProcessedCount: Number(row.cycle_processed_count),
    lastStartedAt: row.last_started_at ?? null,
    lastFinishedAt: row.last_finished_at ?? null,
    lastStatus: row.last_status,
    lastError: row.last_error ?? null,
    lastRunId: row.last_run_id ?? null,
    lastBatchCount: Number(row.last_batch_count),
    lastSuggestionCount: Number(row.last_suggestion_count),
    lastInsertedCount: Number(row.last_inserted_count),
    lastDedupedCount: Number(row.last_deduped_count),
    failureCount: Number(row.failure_count),
    nextRetryAt: row.next_retry_at ?? null,
    nextRunAt: row.next_run_at ?? null,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    trigger: row.trigger,
    workerId: row.worker_id,
    cursorOwner: row.cursor_owner ?? null,
    cursorOpportunityId: row.cursor_opportunity_id ?? null,
    nextCursorOwner: row.next_cursor_owner ?? null,
    nextCursorOpportunityId: row.next_cursor_opportunity_id ?? null,
    batchCount: Number(row.batch_count),
    objectCount: Number(row.object_count),
    suggestionCount: Number(row.suggestion_count),
    insertedCount: Number(row.inserted_count),
    dedupedCount: Number(row.deduped_count),
    eventCount: Number(row.event_count),
    status: row.status,
    errorCode: row.error_code ?? null,
    errorText: row.error_text ?? null,
    attemptCount: Number(row.attempt_count),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    nextRetryAt: row.next_retry_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLease(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workerId: row.worker_id ?? null,
    lockedUntil: row.locked_until ?? null,
    updatedAt: row.updated_at,
    active: Boolean(row.locked_until && Date.parse(row.locked_until) > Date.now()),
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    eventKey: row.event_key,
    eventType: row.event_type,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorText: row.last_error_text ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activeLeaseAt(row, nowMs) {
  return row?.locked_until && Date.parse(row.locked_until) > nowMs;
}

function leaseLost() {
  return new HttpError(409, "PROACTIVE_SCAN_LEASE_LOST", "The proactive scan lease is no longer current");
}

function eventLeaseLost() {
  return new HttpError(409, "PROACTIVE_EVENT_LEASE_LOST", "The proactive event lease is no longer current");
}

/**
 * Durable SQLite repository for the proactive scan state machine.
 *
 * `ai_suggestions` remains the shared suggestion ledger.  This repository owns
 * only the scanner's state/run/lease/event tables; lifecycle and dedupe for
 * suggestions live in proactiveSuggestionRepository.js.
 */
export function createProactiveScanRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
  leaseTokenFactory = randomUUID,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof idFactory !== "function" || typeof leaseTokenFactory !== "function") {
    throw new TypeError("idFactory and leaseTokenFactory are required");
  }

  const now = () => clockDate(clock).toISOString();
  const selectState = () => db.prepare("SELECT * FROM proactive_scan_state WHERE id = 1").get();
  const selectRun = (id) => db.prepare("SELECT * FROM proactive_scan_runs WHERE id = $id").get({ $id: id });
  const selectLease = () => db.prepare("SELECT * FROM proactive_scan_lease WHERE id = 1").get();
  const selectEvent = (id) => db.prepare("SELECT * FROM proactive_scan_events WHERE id = $id").get({ $id: id });

  function getState() {
    return mapState(selectState());
  }

  function updateState(patch = {}) {
    const current = getState();
    if (!current) throw new Error("proactive scan state is not initialized");
    const allowed = new Set([
      "enabled", "intervalSeconds", "batchSize", "cursorOwner", "cursorOpportunityId", "cycleNumber",
      "cycleObjectCount", "cycleProcessedCount", "lastStartedAt", "lastFinishedAt", "lastStatus", "lastError",
      "lastRunId", "lastBatchCount", "lastSuggestionCount", "lastInsertedCount", "lastDedupedCount",
      "failureCount", "nextRetryAt", "nextRunAt",
    ]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`unknown proactive scan state field: ${key}`);
    const next = { ...current, ...patch };
    const intervalSeconds = integer(next.intervalSeconds, "intervalSeconds", { min: 30, max: PROACTIVE_SCAN_MAX_INTERVAL_SECONDS });
    const batchSize = integer(next.batchSize, "batchSize", { min: 1, max: PROACTIVE_SCAN_MAX_BATCH_SIZE });
    const values = {
      $enabled: next.enabled ? 1 : 0,
      $intervalSeconds: intervalSeconds,
      $batchSize: batchSize,
      $cursorOwner: optionalText(next.cursorOwner, "cursorOwner", 500),
      $cursorOpportunityId: optionalText(next.cursorOpportunityId, "cursorOpportunityId", 500),
      $cycleNumber: integer(next.cycleNumber, "cycleNumber"),
      $cycleObjectCount: integer(next.cycleObjectCount, "cycleObjectCount"),
      $cycleProcessedCount: integer(next.cycleProcessedCount, "cycleProcessedCount"),
      $lastStartedAt: iso(next.lastStartedAt, "lastStartedAt", { nullable: true }),
      $lastFinishedAt: iso(next.lastFinishedAt, "lastFinishedAt", { nullable: true }),
      $lastStatus: text(next.lastStatus, "lastStatus", 40),
      $lastError: optionalText(next.lastError, "lastError", 500),
      $lastRunId: optionalText(next.lastRunId, "lastRunId", 500),
      $lastBatchCount: integer(next.lastBatchCount, "lastBatchCount"),
      $lastSuggestionCount: integer(next.lastSuggestionCount, "lastSuggestionCount"),
      $lastInsertedCount: integer(next.lastInsertedCount, "lastInsertedCount"),
      $lastDedupedCount: integer(next.lastDedupedCount, "lastDedupedCount"),
      $failureCount: integer(next.failureCount, "failureCount"),
      $nextRetryAt: iso(next.nextRetryAt, "nextRetryAt", { nullable: true }),
      $nextRunAt: iso(next.nextRunAt, "nextRunAt", { nullable: true }),
      $updatedAt: now(),
    };
    if (!STATE_STATUSES.has(values.$lastStatus)) throw new TypeError("lastStatus is invalid");
    db.prepare(`
      UPDATE proactive_scan_state SET
        enabled = $enabled,
        interval_seconds = $intervalSeconds,
        batch_size = $batchSize,
        cursor_owner = $cursorOwner,
        cursor_opportunity_id = $cursorOpportunityId,
        cycle_number = $cycleNumber,
        cycle_object_count = $cycleObjectCount,
        cycle_processed_count = $cycleProcessedCount,
        last_started_at = $lastStartedAt,
        last_finished_at = $lastFinishedAt,
        last_status = $lastStatus,
        last_error = $lastError,
        last_run_id = $lastRunId,
        last_batch_count = $lastBatchCount,
        last_suggestion_count = $lastSuggestionCount,
        last_inserted_count = $lastInsertedCount,
        last_deduped_count = $lastDedupedCount,
        failure_count = $failureCount,
        next_retry_at = $nextRetryAt,
        next_run_at = $nextRunAt,
        updated_at = $updatedAt
      WHERE id = 1
    `).run(values);
    return getState();
  }

  function createRun(input = {}) {
    const current = getState();
    const id = optionalText(input.id, "run id", 500) ?? text(idFactory(), "generated run id", 500);
    const startedAt = iso(input.startedAt ?? clockDate(clock), "startedAt");
    const values = {
      $id: id,
      $cycleNumber: integer(input.cycleNumber ?? current?.cycleNumber ?? 0, "cycleNumber"),
      $trigger: text(input.trigger ?? "scheduled", "trigger", 40),
      $workerId: identifier(input.workerId ?? "proactive-worker", "workerId", 500),
      $cursorOwner: optionalText(input.cursorOwner, "cursorOwner", 500),
      $cursorOpportunityId: optionalText(input.cursorOpportunityId, "cursorOpportunityId", 500),
      $nextCursorOwner: optionalText(input.nextCursorOwner, "nextCursorOwner", 500),
      $nextCursorOpportunityId: optionalText(input.nextCursorOpportunityId, "nextCursorOpportunityId", 500),
      $batchCount: integer(input.batchCount ?? 0, "batchCount"),
      $objectCount: integer(input.objectCount ?? 0, "objectCount"),
      $suggestionCount: integer(input.suggestionCount ?? 0, "suggestionCount"),
      $insertedCount: integer(input.insertedCount ?? 0, "insertedCount"),
      $dedupedCount: integer(input.dedupedCount ?? 0, "dedupedCount"),
      $eventCount: integer(input.eventCount ?? 0, "eventCount"),
      $status: text(input.status ?? "running", "status", 20),
      $errorCode: optionalText(input.errorCode, "errorCode", 200),
      $errorText: optionalText(input.errorText, "errorText", 500),
      $attemptCount: integer(input.attemptCount ?? 1, "attemptCount", { min: 1 }),
      $startedAt: startedAt,
      $finishedAt: iso(input.finishedAt, "finishedAt", { nullable: true }),
      $nextRetryAt: iso(input.nextRetryAt, "nextRetryAt", { nullable: true }),
      $createdAt: now(),
      $updatedAt: now(),
    };
    if (!RUN_TRIGGERS.has(values.$trigger)) throw new TypeError("trigger is invalid");
    if (!RUN_STATUSES.has(values.$status)) throw new TypeError("status is invalid");
    db.prepare(`
      INSERT INTO proactive_scan_runs (
        id, cycle_number, trigger, worker_id, cursor_owner, cursor_opportunity_id,
        next_cursor_owner, next_cursor_opportunity_id, batch_count, object_count,
        suggestion_count, inserted_count, deduped_count, event_count, status,
        error_code, error_text, attempt_count, started_at, finished_at, next_retry_at,
        created_at, updated_at
      ) VALUES (
        $id, $cycleNumber, $trigger, $workerId, $cursorOwner, $cursorOpportunityId,
        $nextCursorOwner, $nextCursorOpportunityId, $batchCount, $objectCount,
        $suggestionCount, $insertedCount, $dedupedCount, $eventCount, $status,
        $errorCode, $errorText, $attemptCount, $startedAt, $finishedAt, $nextRetryAt,
        $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        cycle_number = excluded.cycle_number,
        trigger = excluded.trigger,
        worker_id = excluded.worker_id,
        cursor_owner = excluded.cursor_owner,
        cursor_opportunity_id = excluded.cursor_opportunity_id,
        next_cursor_owner = excluded.next_cursor_owner,
        next_cursor_opportunity_id = excluded.next_cursor_opportunity_id,
        batch_count = excluded.batch_count,
        object_count = excluded.object_count,
        suggestion_count = excluded.suggestion_count,
        inserted_count = excluded.inserted_count,
        deduped_count = excluded.deduped_count,
        event_count = excluded.event_count,
        status = excluded.status,
        error_code = excluded.error_code,
        error_text = excluded.error_text,
        attempt_count = excluded.attempt_count,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        next_retry_at = excluded.next_retry_at,
        updated_at = excluded.updated_at
    `).run(values);
    return mapRun(selectRun(id));
  }

  function updateRun(idValue, patch = {}) {
    const id = identifier(idValue, "run id");
    const current = getRun(id);
    if (!current) throw new HttpError(404, "PROACTIVE_SCAN_RUN_NOT_FOUND", "The proactive scan run was not found");
    const allowed = new Set([
      "cycleNumber", "trigger", "workerId", "cursorOwner", "cursorOpportunityId", "nextCursorOwner",
      "nextCursorOpportunityId", "batchCount", "objectCount", "suggestionCount", "insertedCount",
      "dedupedCount", "eventCount", "status", "errorCode", "errorText", "attemptCount", "startedAt",
      "finishedAt", "nextRetryAt",
    ]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`unknown proactive scan run field: ${key}`);
    const next = { ...current, ...patch };
    const values = {
      $id: id,
      $cycleNumber: integer(next.cycleNumber, "cycleNumber"),
      $trigger: text(next.trigger, "trigger", 40),
      $workerId: identifier(next.workerId, "workerId", 500),
      $cursorOwner: optionalText(next.cursorOwner, "cursorOwner", 500),
      $cursorOpportunityId: optionalText(next.cursorOpportunityId, "cursorOpportunityId", 500),
      $nextCursorOwner: optionalText(next.nextCursorOwner, "nextCursorOwner", 500),
      $nextCursorOpportunityId: optionalText(next.nextCursorOpportunityId, "nextCursorOpportunityId", 500),
      $batchCount: integer(next.batchCount, "batchCount"),
      $objectCount: integer(next.objectCount, "objectCount"),
      $suggestionCount: integer(next.suggestionCount, "suggestionCount"),
      $insertedCount: integer(next.insertedCount, "insertedCount"),
      $dedupedCount: integer(next.dedupedCount, "dedupedCount"),
      $eventCount: integer(next.eventCount, "eventCount"),
      $status: text(next.status, "status", 20),
      $errorCode: optionalText(next.errorCode, "errorCode", 200),
      $errorText: optionalText(next.errorText, "errorText", 500),
      $attemptCount: integer(next.attemptCount, "attemptCount", { min: 1 }),
      $startedAt: iso(next.startedAt, "startedAt"),
      $finishedAt: iso(next.finishedAt, "finishedAt", { nullable: true }),
      $nextRetryAt: iso(next.nextRetryAt, "nextRetryAt", { nullable: true }),
      $updatedAt: now(),
    };
    if (!RUN_TRIGGERS.has(values.$trigger)) throw new TypeError("trigger is invalid");
    if (!RUN_STATUSES.has(values.$status)) throw new TypeError("status is invalid");
    db.prepare(`
      UPDATE proactive_scan_runs SET
        cycle_number = $cycleNumber, trigger = $trigger, worker_id = $workerId,
        cursor_owner = $cursorOwner, cursor_opportunity_id = $cursorOpportunityId,
        next_cursor_owner = $nextCursorOwner, next_cursor_opportunity_id = $nextCursorOpportunityId,
        batch_count = $batchCount, object_count = $objectCount,
        suggestion_count = $suggestionCount, inserted_count = $insertedCount,
        deduped_count = $dedupedCount, event_count = $eventCount, status = $status,
        error_code = $errorCode, error_text = $errorText, attempt_count = $attemptCount,
        started_at = $startedAt, finished_at = $finishedAt, next_retry_at = $nextRetryAt,
        updated_at = $updatedAt
      WHERE id = $id
    `).run(values);
    return getRun(id);
  }

  function getRun(idValue) {
    return mapRun(selectRun(identifier(idValue, "run id")));
  }

  function listRuns({ limit = 50, status = null } = {}) {
    const bounded = integer(limit, "limit", { min: 1, max: 100, fallback: 50 });
    const normalizedStatus = status === null || status === undefined ? null : text(status, "status", 20);
    if (normalizedStatus !== null && !RUN_STATUSES.has(normalizedStatus)) throw new TypeError("status is invalid");
    return db.prepare(`
      SELECT * FROM proactive_scan_runs
       WHERE ($status IS NULL OR status = $status)
       ORDER BY started_at DESC, id DESC
       LIMIT $limit
    `).all({ $status: normalizedStatus, $limit: bounded }).map(mapRun);
  }

  // Any run left running beyond the lease window belongs to a worker that was
  // interrupted.  The row is retained as failed evidence; the cursor remains
  // in proactive_scan_state and can safely be retried by the next worker.
  function recoverRunningRuns({ now = clockDate(clock), leaseMs = PROACTIVE_SCAN_DEFAULT_LEASE_MS } = {}) {
    const current = date(now, "now");
    const leaseDuration = integer(leaseMs, "leaseMs", { min: 1, max: 24 * 60 * 60 * 1000 });
    const nowIso = current.toISOString();
    const cutoff = new Date(current.getTime() - leaseDuration).toISOString();
    const result = db.prepare(`
      UPDATE proactive_scan_runs
         SET status = 'failed', error_code = 'PROACTIVE_SCAN_RESTARTED',
             error_text = 'worker restarted before the run completed',
             finished_at = $now, next_retry_at = $now, updated_at = $now
       WHERE status = 'running' AND started_at <= $cutoff
    `).run({ $now: nowIso, $cutoff: cutoff });
    return { recoveredCount: Number(result.changes) };
  }

  function tryAcquireLease(input = {}, legacyLockedUntil = null) {
    let workerId;
    let leaseMs;
    if (typeof input === "string") {
      workerId = input;
      leaseMs = legacyLockedUntil
        ? Math.max(1, Date.parse(legacyLockedUntil) - clockDate(clock).getTime())
        : PROACTIVE_SCAN_DEFAULT_LEASE_MS;
    } else {
      workerId = input.workerId ?? input.owner ?? "proactive-worker";
      leaseMs = input.leaseMs ?? PROACTIVE_SCAN_DEFAULT_LEASE_MS;
    }
    const normalizedWorker = identifier(workerId, "workerId");
    const duration = integer(leaseMs, "leaseMs", { min: 1, max: 24 * 60 * 60 * 1000 });
    const current = clockDate(clock);
    const nowIso = current.toISOString();
    const token = text(leaseTokenFactory(), "leaseToken", 500);
    const lockedUntil = new Date(current.getTime() + duration).toISOString();
    const acquired = withImmediateTransaction(db, () => {
      const result = db.prepare(`
        UPDATE proactive_scan_lease
           SET worker_id = $workerId,
               lease_token_hash = $leaseTokenHash,
               locked_until = $lockedUntil,
               updated_at = $now
         WHERE id = 1
           AND (locked_until IS NULL OR locked_until <= $now)
      `).run({
        $workerId: normalizedWorker,
        $leaseTokenHash: hash(token),
        $lockedUntil: lockedUntil,
        $now: nowIso,
      });
      return Number(result.changes) === 1;
    });
    return acquired ? { acquired: true, workerId: normalizedWorker, leaseToken: token, lockedUntil } : null;
  }

  function acquireLease(input = {}) {
    return tryAcquireLease(input);
  }

  function isLeaseCurrent(input = {}) {
    const workerId = identifier(input.workerId ?? input.owner, "workerId");
    const token = text(input.leaseToken, "leaseToken", 500);
    const current = clockDate(clock);
    const row = selectLease();
    return Boolean(row
      && row.worker_id === workerId
      && row.lease_token_hash === hash(token)
      && row.locked_until
      && Date.parse(row.locked_until) > current.getTime());
  }

  function assertLease(input = {}) {
    if (!isLeaseCurrent(input)) throw leaseLost();
    return true;
  }

  function releaseLease(input = {}, legacyToken = null) {
    const workerId = typeof input === "string" ? input : (input.workerId ?? input.owner);
    const leaseToken = typeof input === "string" ? legacyToken : input.leaseToken;
    const normalizedWorker = identifier(workerId, "workerId");
    const normalizedToken = text(leaseToken, "leaseToken", 500);
    const result = db.prepare(`
      UPDATE proactive_scan_lease
         SET worker_id = NULL, lease_token_hash = NULL, locked_until = NULL, updated_at = $now
       WHERE id = 1 AND worker_id = $workerId AND lease_token_hash = $leaseTokenHash
    `).run({ $workerId: normalizedWorker, $leaseTokenHash: hash(normalizedToken), $now: now() });
    return Number(result.changes) === 1;
  }

  function leaseState() {
    const row = selectLease();
    if (!row) return null;
    const current = clockDate(clock);
    return {
      id: Number(row.id),
      workerId: row.worker_id ?? null,
      lockedUntil: row.locked_until ?? null,
      updatedAt: row.updated_at,
      active: Boolean(row.locked_until && Date.parse(row.locked_until) > current.getTime()),
    };
  }

  function enqueueEvent(input = {}) {
    const owner = identifier(input.owner, "owner", 200);
    const eventKey = text(input.eventKey ?? input.idempotencyKey, "eventKey", 500);
    const eventType = text(input.eventType ?? "business_change", "eventType", 100);
    const entityType = optionalText(input.entityType, "entityType", 100);
    const entityId = input.entityId === undefined || input.entityId === null ? null : identifier(input.entityId, "entityId");
    const payloadJson = json(input.payload ?? {}, "payload");
    const payloadHash = comparablePayloadHash(eventType, payloadJson);
    const current = clockDate(clock);
    const nowIso = current.toISOString();
    const availableAt = iso(input.availableAt ?? current, "availableAt");
    return withImmediateTransaction(db, () => {
      const existing = db.prepare(`
        SELECT * FROM proactive_scan_events WHERE owner = $owner AND event_key = $eventKey
      `).get({ $owner: owner, $eventKey: eventKey });
      if (existing) {
        if (comparablePayloadHash(existing.event_type, existing.payload_json) !== payloadHash
          || existing.event_type !== eventType
          || (existing.entity_id ?? null) !== entityId) {
          throw new HttpError(409, "PROACTIVE_EVENT_CONFLICT", "The proactive event key was reused for different content");
        }
        return { item: mapEvent(existing), replayed: true };
      }
      const id = identifier(input.id ?? idFactory(), "event id");
      db.prepare(`
        INSERT INTO proactive_scan_events (
          id, owner, event_key, event_type, entity_type, entity_id, payload_json,
          status, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          $id, $owner, $eventKey, $eventType, $entityType, $entityId, $payloadJson,
          'queued', 0, $availableAt, $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $eventKey: eventKey,
        $eventType: eventType,
        $entityType: entityType,
        $entityId: entityId,
        $payloadJson: payloadJson,
        $availableAt: availableAt,
        $now: nowIso,
      });
      return { item: mapEvent(selectEvent(id)), replayed: false };
    });
  }

  function getEvent(idValue, { owner = null } = {}) {
    const id = identifier(idValue, "event id");
    const row = owner === null
      ? selectEvent(id)
      : db.prepare("SELECT * FROM proactive_scan_events WHERE id = $id AND owner = $owner").get({ $id: id, $owner: identifier(owner, "owner", 200) });
    return mapEvent(row);
  }

  function listEvents({ owner = null, status = null, limit = 50 } = {}) {
    const bounded = integer(limit, "limit", { min: 1, max: 100, fallback: 50 });
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    const normalizedStatus = status === null || status === undefined ? null : text(status, "status", 20);
    if (normalizedStatus !== null && !EVENT_STATUSES.has(normalizedStatus)) throw new TypeError("status is invalid");
    return db.prepare(`
      SELECT * FROM proactive_scan_events
       WHERE ($owner IS NULL OR owner = $owner)
         AND ($status IS NULL OR status = $status)
       ORDER BY created_at ASC, id ASC
       LIMIT $limit
    `).all({ $owner: normalizedOwner, $status: normalizedStatus, $limit: bounded }).map(mapEvent);
  }

  function claimEvent(input = {}) {
    const workerId = identifier(input.workerId ?? input.owner ?? "proactive-worker", "workerId");
    const duration = integer(input.leaseMs ?? PROACTIVE_SCAN_DEFAULT_LEASE_MS, "leaseMs", { min: 1, max: 24 * 60 * 60 * 1000 });
    const eventId = input.eventId === undefined || input.eventId === null ? null : identifier(input.eventId, "event id");
    const current = clockDate(clock);
    const nowIso = current.toISOString();
    const leaseToken = text(leaseTokenFactory(), "event leaseToken", 500);
    const leaseExpiresAt = new Date(current.getTime() + duration).toISOString();
    return withImmediateTransaction(db, () => {
      const row = db.prepare(`
        SELECT * FROM proactive_scan_events
         WHERE ($eventId IS NULL OR id = $eventId)
           AND (
             (status IN ('queued', 'failed') AND available_at <= $now)
             OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now)
           )
         ORDER BY available_at ASC, created_at ASC, id ASC
         LIMIT 1
      `).get({ $eventId: eventId, $now: nowIso });
      if (!row) return null;
      const updated = db.prepare(`
        UPDATE proactive_scan_events
           SET status = 'processing', attempt_count = attempt_count + 1,
               lease_token_hash = $leaseTokenHash, lease_expires_at = $leaseExpiresAt,
               updated_at = $now
         WHERE id = $id AND (
           (status IN ('queued', 'failed') AND available_at <= $now)
           OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now)
         )
      `).run({ $id: row.id, $leaseTokenHash: hash(leaseToken), $leaseExpiresAt: leaseExpiresAt, $now: nowIso });
      if (Number(updated.changes) !== 1) return null;
      return {
        item: mapEvent(selectEvent(row.id)),
        workerId,
        leaseToken,
        leaseExpiresAt,
      };
    });
  }

  function completeEvent(idValue, input = {}) {
    const id = identifier(idValue, "event id");
    const leaseToken = text(input.leaseToken, "leaseToken", 500);
    const skippedSubjects = integer(input.skippedSubjects ?? 0, "skippedSubjects", { min: 0, max: 10_000 });
    const current = clockDate(clock);
    const nowIso = current.toISOString();
    return withImmediateTransaction(db, () => {
      const row = selectEvent(id);
      if (!row) throw new HttpError(404, "PROACTIVE_EVENT_NOT_FOUND", "The proactive event was not found");
      if (row.status === "completed") return { item: mapEvent(row), replayed: true };
      if (row.status !== "processing" || row.lease_token_hash !== hash(leaseToken)
        || row.lease_expires_at === null || Date.parse(row.lease_expires_at) <= current.getTime()) {
        throw eventLeaseLost();
      }
      const result = db.prepare(`
        UPDATE proactive_scan_events
           SET status = 'completed', lease_token_hash = NULL, lease_expires_at = NULL,
               completed_at = $now, last_error_code = $completionCode, last_error_text = $completionText, updated_at = $now
         WHERE id = $id AND status = 'processing' AND lease_token_hash = $leaseTokenHash
      `).run({
        $id: id, $leaseTokenHash: hash(leaseToken), $now: nowIso,
        $completionCode: skippedSubjects > 0 ? "PROACTIVE_SUBJECT_UNAVAILABLE" : null,
        $completionText: skippedSubjects > 0 ? `Skipped ${skippedSubjects} unavailable customer subject(s)` : null,
      });
      if (Number(result.changes) !== 1) throw eventLeaseLost();
      return { item: mapEvent(selectEvent(id)), replayed: false };
    });
  }

  function failEvent(idValue, input = {}) {
    const id = identifier(idValue, "event id");
    const leaseToken = text(input.leaseToken, "leaseToken", 500);
    const current = clockDate(clock);
    const nowIso = current.toISOString();
    const retryBaseMs = integer(input.retryBaseMs ?? PROACTIVE_SCAN_DEFAULT_RETRY_BASE_MS, "retryBaseMs", { min: 1, max: PROACTIVE_SCAN_MAX_RETRY_BASE_MS });
    const normalizedCode = errorCode(input.errorCode ?? "PROACTIVE_EVENT_FAILED");
    const normalizedText = optionalText(input.errorText, "errorText", 500);
    return withImmediateTransaction(db, () => {
      const row = selectEvent(id);
      if (!row) throw new HttpError(404, "PROACTIVE_EVENT_NOT_FOUND", "The proactive event was not found");
      if (row.status === "completed" || row.status === "cancelled") return { item: mapEvent(row), replayed: true };
      if (row.status !== "processing" || row.lease_token_hash !== hash(leaseToken)
        || !row.lease_expires_at || Date.parse(row.lease_expires_at) <= current.getTime()) throw eventLeaseLost();
      const attempt = Number(row.attempt_count);
      const delay = retryBaseMs * (2 ** Math.min(Math.max(attempt - 1, 0), 10));
      const availableAt = new Date(current.getTime() + delay).toISOString();
      const result = db.prepare(`
        UPDATE proactive_scan_events
           SET status = 'failed', available_at = $availableAt,
               lease_token_hash = NULL, lease_expires_at = NULL,
               last_error_code = $errorCode, last_error_text = $errorText,
               updated_at = $now
         WHERE id = $id AND status = 'processing' AND lease_token_hash = $leaseTokenHash
      `).run({ $id: id, $availableAt: availableAt, $leaseTokenHash: hash(leaseToken), $errorCode: normalizedCode, $errorText: normalizedText, $now: nowIso });
      if (Number(result.changes) !== 1) throw eventLeaseLost();
      return { item: mapEvent(selectEvent(id)), replayed: false };
    });
  }

  function cancelEvent(idValue, { owner, now: at = clockDate(clock) } = {}) {
    const id = identifier(idValue, "event id");
    const normalizedOwner = identifier(owner, "owner", 200);
    const nowIso = iso(at, "now");
    const result = db.prepare(`
      UPDATE proactive_scan_events
         SET status = 'cancelled', lease_token_hash = NULL, lease_expires_at = NULL, updated_at = $now
       WHERE id = $id AND owner = $owner AND status IN ('queued', 'failed')
    `).run({ $id: id, $owner: normalizedOwner, $now: nowIso });
    return { item: mapEvent(selectEvent(id)), changed: Number(result.changes) === 1 };
  }

  function pendingEventCount({ owner = null } = {}) {
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    return Number(db.prepare(`
      SELECT COUNT(*) AS count FROM proactive_scan_events
       WHERE status IN ('queued', 'failed') AND available_at <= $now
         AND ($owner IS NULL OR owner = $owner)
    `).get({ $now: now(), $owner: normalizedOwner }).count);
  }

  return Object.freeze({
    getState,
    updateState,
    createRun,
    recordRun: createRun,
    updateRun,
    getRun,
    listRuns,
    recoverRunningRuns,
    tryAcquireLease,
    acquireLease,
    tryAcquireLock: tryAcquireLease,
    isLeaseCurrent,
    assertLease,
    releaseLease,
    releaseLock: releaseLease,
    leaseState,
    enqueueEvent,
    getEvent,
    listEvents,
    claimEvent,
    completeEvent,
    failEvent,
    cancelEvent,
    pendingEventCount,
  });
}

export { mapEvent, mapLease, mapRun, mapState };
