import { randomUUID } from "node:crypto";

const STATUS_VALUES = new Set(["idle", "running", "success", "partial", "failed", "disabled", "waiting"]);
const RUN_STATUS_VALUES = new Set(["running", "success", "partial", "failed", "skipped"]);

function iso(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO date`);
  return value;
}

function positiveInteger(value, name, fallback) {
  const normalized = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${name} must be a positive integer`);
  return normalized;
}

function nonNegativeInteger(value, name, fallback = 0) {
  const normalized = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return normalized;
}

function nullableText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${name} is invalid`);
  return value;
}

function mapState(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    intervalMinutes: Number(row.interval_minutes),
    batchSize: Number(row.batch_size),
    cursorCustomerId: row.cursor_customer_id ?? null,
    cycleNumber: Number(row.cycle_number),
    snapshotId: row.snapshot_id ?? null,
    cycleCustomerCount: Number(row.cycle_customer_count),
    cycleProcessedCount: Number(row.cycle_processed_count),
    lastStartedAt: row.last_started_at ?? null,
    lastFinishedAt: row.last_finished_at ?? null,
    lastStatus: row.last_status,
    lastError: row.last_error ?? null,
    lastBatchStartCustomerId: row.last_batch_start_customer_id ?? null,
    lastBatchEndCustomerId: row.last_batch_end_customer_id ?? null,
    lastBatchCount: Number(row.last_batch_count),
    lastAcceptedCount: Number(row.last_accepted_count),
    lastRejectedCount: Number(row.last_rejected_count),
    lastHighRelevanceCount: Number(row.last_high_relevance_count),
    notificationCount: Number(row.notification_count),
    nextRunAt: row.next_run_at ?? null,
    updatedAt: row.updated_at,
  };
}

function mapSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    generatedAt: row.generated_at,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    errorText: row.error_text ?? null,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    snapshotId: row.snapshot_id ?? null,
    batchStartCustomerId: row.batch_start_customer_id ?? null,
    batchEndCustomerId: row.batch_end_customer_id ?? null,
    batchCount: Number(row.batch_count),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    status: row.status,
    acceptedCount: Number(row.accepted_count),
    rejectedCount: Number(row.rejected_count),
    highRelevanceCount: Number(row.high_relevance_count),
    notificationCount: Number(row.notification_count),
    errorText: row.error_text ?? null,
    createdAt: row.created_at,
  };
}

export function createHospitalTenderSchedulerRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite connection is required");
  if (typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("clock and idFactory are required");

  const now = () => {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
    return value.toISOString();
  };

  function getState() {
    return mapState(db.prepare("SELECT * FROM hospital_tender_scheduler_state WHERE id = 1").get());
  }

  function updateState(patch = {}) {
    const current = getState();
    if (!current) throw new Error("hospital tender scheduler state is not initialized");
    const allowed = new Set([
      "enabled", "intervalMinutes", "batchSize", "cursorCustomerId", "cycleNumber", "snapshotId",
      "cycleCustomerCount", "cycleProcessedCount", "lastStartedAt", "lastFinishedAt", "lastStatus", "lastError",
      "lastBatchStartCustomerId", "lastBatchEndCustomerId", "lastBatchCount", "lastAcceptedCount",
      "lastRejectedCount", "lastHighRelevanceCount", "notificationCount", "nextRunAt",
    ]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`unknown scheduler state field: ${key}`);
    const next = { ...current, ...patch };
    const status = String(next.lastStatus);
    if (!STATUS_VALUES.has(status)) throw new TypeError("lastStatus is invalid");
    const intervalMinutes = positiveInteger(next.intervalMinutes, "intervalMinutes");
    const batchSize = positiveInteger(next.batchSize, "batchSize");
    if (intervalMinutes > 1440 || batchSize > 200) throw new TypeError("scheduler bounds exceeded");
    const fields = {
      enabled: next.enabled ? 1 : 0,
      interval_minutes: intervalMinutes,
      batch_size: batchSize,
      cursor_customer_id: nullableText(next.cursorCustomerId, "cursorCustomerId", 200),
      cycle_number: nonNegativeInteger(next.cycleNumber, "cycleNumber"),
      snapshot_id: nullableText(next.snapshotId, "snapshotId", 200),
      cycle_customer_count: nonNegativeInteger(next.cycleCustomerCount, "cycleCustomerCount"),
      cycle_processed_count: nonNegativeInteger(next.cycleProcessedCount, "cycleProcessedCount"),
      last_started_at: iso(next.lastStartedAt, "lastStartedAt", { nullable: true }),
      last_finished_at: iso(next.lastFinishedAt, "lastFinishedAt", { nullable: true }),
      last_status: status,
      last_error: nullableText(next.lastError, "lastError", 500),
      last_batch_start_customer_id: nullableText(next.lastBatchStartCustomerId, "lastBatchStartCustomerId", 200),
      last_batch_end_customer_id: nullableText(next.lastBatchEndCustomerId, "lastBatchEndCustomerId", 200),
      last_batch_count: nonNegativeInteger(next.lastBatchCount, "lastBatchCount"),
      last_accepted_count: nonNegativeInteger(next.lastAcceptedCount, "lastAcceptedCount"),
      last_rejected_count: nonNegativeInteger(next.lastRejectedCount, "lastRejectedCount"),
      last_high_relevance_count: nonNegativeInteger(next.lastHighRelevanceCount, "lastHighRelevanceCount"),
      notification_count: nonNegativeInteger(next.notificationCount, "notificationCount"),
      next_run_at: iso(next.nextRunAt, "nextRunAt", { nullable: true }),
      updated_at: now(),
    };
    db.prepare(`
      UPDATE hospital_tender_scheduler_state SET
        enabled = $enabled, interval_minutes = $interval_minutes, batch_size = $batch_size,
        cursor_customer_id = $cursor_customer_id, cycle_number = $cycle_number, snapshot_id = $snapshot_id,
        cycle_customer_count = $cycle_customer_count, cycle_processed_count = $cycle_processed_count,
        last_started_at = $last_started_at,
        last_finished_at = $last_finished_at, last_status = $last_status, last_error = $last_error,
        last_batch_start_customer_id = $last_batch_start_customer_id,
        last_batch_end_customer_id = $last_batch_end_customer_id, last_batch_count = $last_batch_count,
        last_accepted_count = $last_accepted_count, last_rejected_count = $last_rejected_count,
        last_high_relevance_count = $last_high_relevance_count,
        notification_count = $notification_count, next_run_at = $next_run_at, updated_at = $updated_at
      WHERE id = 1
    `).run(fields);
    return getState();
  }

  function saveSnapshot({ id = idFactory(), cycleNumber, generatedAt, payload, status = "pending" } = {}) {
    const snapshotId = nullableText(id, "snapshotId", 200);
    const cycle = nonNegativeInteger(cycleNumber, "cycleNumber");
    const generated = iso(generatedAt, "generatedAt");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("payload is required");
    if (!["pending", "completed", "failed"].includes(status)) throw new TypeError("snapshot status is invalid");
    const createdAt = now();
    db.prepare(`
      INSERT INTO hospital_tender_scheduler_snapshots
        (id, cycle_number, generated_at, payload_json, status, created_at)
      VALUES ($id, $cycleNumber, $generatedAt, $payload, $status, $createdAt)
    `).run({
      $id: snapshotId,
      $cycleNumber: cycle,
      $generatedAt: generated,
      $payload: JSON.stringify(payload),
      $status: status,
      $createdAt: createdAt,
    });
    return getSnapshot(snapshotId);
  }

  function getSnapshot(id) {
    if (!id) return null;
    return mapSnapshot(db.prepare("SELECT * FROM hospital_tender_scheduler_snapshots WHERE id = $id").get({ $id: id }));
  }

  function updateSnapshot(id, { status, completedAt = null, errorText = null } = {}) {
    if (!["pending", "completed", "failed"].includes(status)) throw new TypeError("snapshot status is invalid");
    const finished = completedAt === null ? null : iso(completedAt, "completedAt", { nullable: true });
    const error = nullableText(errorText, "errorText", 500);
    db.prepare(`
      UPDATE hospital_tender_scheduler_snapshots
      SET status = $status, completed_at = $completedAt, error_text = $errorText
      WHERE id = $id
    `).run({ $id: id, $status: status, $completedAt: finished, $errorText: error });
    return getSnapshot(id);
  }

  function recordRun(input = {}) {
    const status = String(input.status ?? "running");
    if (!RUN_STATUS_VALUES.has(status)) throw new TypeError("run status is invalid");
    const startedAt = iso(input.startedAt ?? now(), "startedAt");
    const finishedAt = iso(input.finishedAt, "finishedAt", { nullable: true });
    const row = {
      id: nullableText(input.id, "id", 200) ?? idFactory(),
      cycleNumber: nonNegativeInteger(input.cycleNumber, "cycleNumber"),
      snapshotId: nullableText(input.snapshotId, "snapshotId", 200),
      batchStartCustomerId: nullableText(input.batchStartCustomerId, "batchStartCustomerId", 200),
      batchEndCustomerId: nullableText(input.batchEndCustomerId, "batchEndCustomerId", 200),
      batchCount: nonNegativeInteger(input.batchCount, "batchCount"),
      startedAt,
      finishedAt,
      status,
      acceptedCount: nonNegativeInteger(input.acceptedCount, "acceptedCount"),
      rejectedCount: nonNegativeInteger(input.rejectedCount, "rejectedCount"),
      highRelevanceCount: nonNegativeInteger(input.highRelevanceCount, "highRelevanceCount"),
      notificationCount: nonNegativeInteger(input.notificationCount, "notificationCount"),
      errorText: nullableText(input.errorText, "errorText", 500),
      createdAt: now(),
    };
    db.prepare(`
      INSERT INTO hospital_tender_scheduler_runs (
        id, cycle_number, snapshot_id, batch_start_customer_id, batch_end_customer_id,
        batch_count, started_at, finished_at, status, accepted_count, rejected_count,
        high_relevance_count, notification_count, error_text, created_at
      ) VALUES (
        $id, $cycleNumber, $snapshotId, $batchStartCustomerId, $batchEndCustomerId,
        $batchCount, $startedAt, $finishedAt, $status, $acceptedCount, $rejectedCount,
        $highRelevanceCount, $notificationCount, $errorText, $createdAt
      )
      ON CONFLICT(id) DO UPDATE SET
        cycle_number = excluded.cycle_number,
        snapshot_id = excluded.snapshot_id,
        batch_start_customer_id = excluded.batch_start_customer_id,
        batch_end_customer_id = excluded.batch_end_customer_id,
        batch_count = excluded.batch_count,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        status = excluded.status,
        accepted_count = excluded.accepted_count,
        rejected_count = excluded.rejected_count,
        high_relevance_count = excluded.high_relevance_count,
        notification_count = excluded.notification_count,
        error_text = excluded.error_text
    `).run({
      $id: row.id,
      $cycleNumber: row.cycleNumber,
      $snapshotId: row.snapshotId,
      $batchStartCustomerId: row.batchStartCustomerId,
      $batchEndCustomerId: row.batchEndCustomerId,
      $batchCount: row.batchCount,
      $startedAt: row.startedAt,
      $finishedAt: row.finishedAt,
      $status: row.status,
      $acceptedCount: row.acceptedCount,
      $rejectedCount: row.rejectedCount,
      $highRelevanceCount: row.highRelevanceCount,
      $notificationCount: row.notificationCount,
      $errorText: row.errorText,
      $createdAt: row.createdAt,
    });
    return getRun(row.id);
  }

  function updateRun(id, patch = {}) {
    if (!id || typeof id !== "string") throw new TypeError("run id is required");
    const current = getRun(id);
    if (!current) throw new Error(`scheduler run not found: ${id}`);
    const allowed = new Set([
      "cycleNumber", "snapshotId", "batchStartCustomerId", "batchEndCustomerId", "batchCount",
      "startedAt", "finishedAt", "status", "acceptedCount", "rejectedCount", "highRelevanceCount", "notificationCount", "errorText",
    ]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`unknown scheduler run field: ${key}`);
    const next = { ...current, ...patch };
    if (!RUN_STATUS_VALUES.has(String(next.status))) throw new TypeError("run status is invalid");
    const values = {
      $id: id,
      $cycleNumber: nonNegativeInteger(next.cycleNumber, "cycleNumber"),
      $snapshotId: nullableText(next.snapshotId, "snapshotId", 200),
      $batchStartCustomerId: nullableText(next.batchStartCustomerId, "batchStartCustomerId", 200),
      $batchEndCustomerId: nullableText(next.batchEndCustomerId, "batchEndCustomerId", 200),
      $batchCount: nonNegativeInteger(next.batchCount, "batchCount"),
      $startedAt: iso(next.startedAt, "startedAt"),
      $finishedAt: iso(next.finishedAt, "finishedAt", { nullable: true }),
      $status: String(next.status),
      $acceptedCount: nonNegativeInteger(next.acceptedCount, "acceptedCount"),
      $rejectedCount: nonNegativeInteger(next.rejectedCount, "rejectedCount"),
      $highRelevanceCount: nonNegativeInteger(next.highRelevanceCount, "highRelevanceCount"),
      $notificationCount: nonNegativeInteger(next.notificationCount, "notificationCount"),
      $errorText: nullableText(next.errorText, "errorText", 500),
    };
    db.prepare(`
      UPDATE hospital_tender_scheduler_runs SET
        cycle_number = $cycleNumber, snapshot_id = $snapshotId,
        batch_start_customer_id = $batchStartCustomerId, batch_end_customer_id = $batchEndCustomerId,
        batch_count = $batchCount, started_at = $startedAt, finished_at = $finishedAt,
        status = $status, accepted_count = $acceptedCount, rejected_count = $rejectedCount,
        high_relevance_count = $highRelevanceCount,
        notification_count = $notificationCount, error_text = $errorText
      WHERE id = $id
    `).run(values);
    return getRun(id);
  }

  function getRun(id) {
    return mapRun(db.prepare("SELECT * FROM hospital_tender_scheduler_runs WHERE id = $id").get({ $id: id }));
  }

  function listRuns(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.prepare("SELECT * FROM hospital_tender_scheduler_runs ORDER BY started_at DESC, id DESC LIMIT $limit")
      .all({ $limit: bounded }).map(mapRun);
  }

  function tryAcquireLock(owner, lockedUntil) {
    const normalizedOwner = nullableText(owner, "owner", 200);
    const until = iso(lockedUntil, "lockedUntil");
    const nowValue = now();
    const result = db.prepare(`
      UPDATE hospital_tender_scheduler_lock
      SET owner = $owner, locked_until = $lockedUntil, updated_at = $updatedAt
      WHERE id = 1 AND (locked_until IS NULL OR locked_until <= $now)
    `).run({ $owner: normalizedOwner, $lockedUntil: until, $updatedAt: nowValue, $now: nowValue });
    return result.changes === 1;
  }

  function releaseLock(owner) {
    db.prepare(`
      UPDATE hospital_tender_scheduler_lock
      SET owner = NULL, locked_until = NULL, updated_at = $updatedAt
      WHERE id = 1 AND owner = $owner
    `).run({ $owner: nullableText(owner, "owner", 200), $updatedAt: now() });
  }

  function lockState() {
    const row = db.prepare("SELECT * FROM hospital_tender_scheduler_lock WHERE id = 1").get();
    return row ? { owner: row.owner ?? null, lockedUntil: row.locked_until ?? null, updatedAt: row.updated_at } : null;
  }

  return {
    getState,
    updateState,
    saveSnapshot,
    getSnapshot,
    updateSnapshot,
    recordRun,
    updateRun,
    getRun,
    listRuns,
    tryAcquireLock,
    releaseLock,
    lockState,
  };
}

export { mapRun, mapSnapshot, mapState };
