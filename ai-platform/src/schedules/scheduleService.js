import {
  AI_TASK_SCHEMA_VERSION,
  boundedObject,
  identifier,
  isPlainObject,
  sha256,
  stableJson,
  taskType,
} from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError } from "../errors.js";
import { id, iso, safeLimit, safeOffset, stringify, withImmediateTransaction } from "../utils.js";

const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 2_592_000;
const MAX_SCHEDULE_NAME_LENGTH = 200;
const MAX_ERROR_LENGTH = 500;
const MAX_ACTOR_LENGTH = 200;
const MAX_REQUEST_ID_LENGTH = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SCAN_LIMIT = 100;
const DEFAULT_CATCH_UP = 1;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_DISPATCH_CONCURRENCY = 4;
const RUN_STATUSES = new Set(["queued", "running", "succeeded", "failed", "skipped"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "skipped"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/gu;
const SAFE_ERROR_MESSAGES = Object.freeze({
  invalid_schedule_time: "schedule time is invalid",
  schedule_paused: "schedule is paused",
  task_service_unavailable: "task service is unavailable",
  task_service_invalid_response: "task service returned an invalid response",
  task_failed: "scheduled task failed",
  task_cancelled: "scheduled task was cancelled",
  task_expired: "scheduled task expired",
  budget_exceeded: "scheduled task was rejected by budget policy",
  configuration_error: "scheduled task configuration is unavailable",
  provider_disabled: "scheduled task provider is disabled",
  provider_policy_blocked: "scheduled task provider is blocked by policy",
  schedule_dispatch_failed: "scheduled task dispatch failed",
});

const DEFAULT_SCHEDULER_IDENTITY = Object.freeze({
  issuer: "ai-platform-scheduler",
  owner: "__system__",
  actor: "scheduler",
});

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

function cleanText(value, name, { required = true, max = 500 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw new AiPlatformError(`${name} is required`, { code: "invalid_request", status: 400 });
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > max || CONTROL_CHARS.test(normalized)) {
    throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
  }
  return normalized;
}

function cleanIdentifier(value, name) {
  const normalized = cleanText(value, name, { max: 128 });
  if (!SAFE_ID.test(normalized)) {
    throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
  }
  try {
    return identifier(normalized, name);
  } catch (error) {
    throw normalizeThrown(error);
  }
}

function cleanBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
}

function cleanInteger(value, name, { min, max, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new AiPlatformError(`${name} is required`, { code: "invalid_request", status: 400 });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
  }
  return parsed;
}

function cleanDate(value, name, { allowNull = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (allowNull) return null;
    throw new AiPlatformError(`${name} is required`, { code: "invalid_request", status: 400 });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
  }
  return date.toISOString();
}

function cleanInputTemplate(value, name = "inputTemplate") {
  let candidate = value;
  if (typeof candidate === "string") {
    candidate = parseJson(candidate, null);
    if (!candidate) {
      throw new AiPlatformError(`${name} is invalid`, { code: "invalid_request", status: 400 });
    }
  }
  try {
    return boundedObject(candidate ?? {}, name, { maxBytes: 512 * 1024 });
  } catch (error) {
    throw normalizeThrown(error);
  }
}

function normalizeThrown(error) {
  if (error instanceof AiPlatformError) return error;
  if (error?.name === "AiContractError") {
    return new AiPlatformError(error.message, {
      code: error.code ?? "invalid_request",
      status: error.code === "payload_too_large" ? 413 : 400,
      details: error.details ?? null,
      cause: error,
    });
  }
  if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || String(error?.code ?? "").includes("SQLITE_CONSTRAINT_UNIQUE")) {
    return new AiPlatformError("schedule conflicts with an existing resource", {
      code: "conflict",
      status: 409,
      cause: error,
    });
  }
  return error;
}

function schedulePayload(value) {
  if (isPlainObject(value?.schedule)) return value.schedule;
  if (isPlainObject(value?.patch)) return value.patch;
  if (isPlainObject(value?.changes)) return value.changes;
  return value ?? {};
}

function normalizeTaskType(value) {
  try {
    return taskType(value, "taskType");
  } catch (error) {
    throw normalizeThrown(error);
  }
}

function normalizeScheduleCreate(value, at) {
  const payload = schedulePayload(value);
  if (!isPlainObject(payload)) {
    throw new AiPlatformError("schedule must be an object", { code: "invalid_request", status: 400 });
  }
  const enabled = cleanBoolean(payload.enabled, "enabled", false);
  const intervalSeconds = cleanInteger(payload.intervalSeconds ?? payload.interval_seconds, "intervalSeconds", {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
  });
  const explicitNext = Object.prototype.hasOwnProperty.call(payload, "nextRunAt")
    ? payload.nextRunAt
    : payload.next_run_at;
  const nextRunAt = enabled
    ? (explicitNext === undefined
      ? addSeconds(at, intervalSeconds)
      : cleanDate(explicitNext, "nextRunAt", { allowNull: true }) ?? addSeconds(at, intervalSeconds))
    : null;
  const priority = payload.priority === undefined ? "background" : cleanText(payload.priority, "priority", { max: 20 });
  if (priority !== "background") {
    throw new AiPlatformError("schedule priority must be background", { code: "invalid_request", status: 400 });
  }
  return {
    id: payload.id === undefined ? id("schedule") : cleanIdentifier(payload.id, "id"),
    slug: cleanIdentifier(payload.slug, "slug"),
    name: cleanText(payload.name, "name", { max: MAX_SCHEDULE_NAME_LENGTH }),
    taskType: normalizeTaskType(payload.taskType ?? payload.task_type),
    feature: cleanIdentifier(payload.feature, "feature"),
    intervalSeconds,
    enabled,
    inputTemplate: cleanInputTemplate(
      payload.inputTemplate ?? payload.input_template ?? payload.input_template_json ?? {},
    ),
    nextRunAt,
  };
}

function normalizeScheduleUpdate(value, current, at) {
  const payload = schedulePayload(value);
  if (!isPlainObject(payload)) {
    throw new AiPlatformError("schedule must be an object", { code: "invalid_request", status: 400 });
  }
  const has = (camel, snake = null) => Object.prototype.hasOwnProperty.call(payload, camel)
    || (snake && Object.prototype.hasOwnProperty.call(payload, snake));
  const enabled = has("enabled")
    ? cleanBoolean(payload.enabled, "enabled", Boolean(Number(current.enabled)))
    : Boolean(Number(current.enabled));
  const taskTypeValue = has("taskType", "task_type")
    ? normalizeTaskType(payload.taskType ?? payload.task_type)
    : current.task_type;
  const featureValue = has("feature") ? cleanIdentifier(payload.feature, "feature") : current.feature;
  const intervalValue = has("intervalSeconds", "interval_seconds")
    ? cleanInteger(payload.intervalSeconds ?? payload.interval_seconds, "intervalSeconds", {
      min: MIN_INTERVAL_SECONDS,
      max: MAX_INTERVAL_SECONDS,
    })
    : Number(current.interval_seconds);
  const inputValue = has("inputTemplate", "input_template") || has("input_template_json")
    ? cleanInputTemplate(payload.inputTemplate ?? payload.input_template ?? payload.input_template_json)
    : parseObject(current.input_template_json, {});
  const explicitNext = has("nextRunAt", "next_run_at")
    ? cleanDate(payload.nextRunAt ?? payload.next_run_at, "nextRunAt", { allowNull: true })
    : current.next_run_at;
  const wasEnabled = Boolean(Number(current.enabled));
  const nextRunAt = enabled
    ? ((!wasEnabled && !has("nextRunAt", "next_run_at")) || explicitNext === null
      ? addSeconds(at, intervalValue)
      : explicitNext)
    : null;
  const hasAnyMutableField = [
    "slug",
    "name",
    "taskType",
    "task_type",
    "feature",
    "intervalSeconds",
    "interval_seconds",
    "inputTemplate",
    "input_template",
    "input_template_json",
    "nextRunAt",
    "next_run_at",
    "enabled",
  ].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (!hasAnyMutableField) {
    throw new AiPlatformError("schedule has no mutable fields", { code: "invalid_request", status: 400 });
  }
  return {
    slug: has("slug") ? cleanIdentifier(payload.slug, "slug") : current.slug,
    name: has("name") ? cleanText(payload.name, "name", { max: MAX_SCHEDULE_NAME_LENGTH }) : current.name,
    taskType: taskTypeValue,
    feature: featureValue,
    intervalSeconds: intervalValue,
    enabled,
    inputTemplate: inputValue,
    nextRunAt,
  };
}

function scheduleView(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    taskType: row.task_type,
    feature: row.feature,
    intervalSeconds: Number(row.interval_seconds),
    enabled: Boolean(Number(row.enabled)),
    priority: row.priority,
    inputTemplate: parseObject(row.input_template_json, {}),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scheduleAuditView(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    taskType: row.task_type,
    feature: row.feature,
    intervalSeconds: Number(row.interval_seconds),
    enabled: Boolean(Number(row.enabled)),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    inputTemplateDigest: sha256(parseObject(row.input_template_json, {})),
  };
}

function scheduleRunView(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    dedupeKey: row.dedupe_key,
    taskId: row.task_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    // The core schema stores the searchable code on schedule_runs. The
    // detailed, redacted message is kept in schedules.last_error and the
    // corresponding admin_audit record; tolerate a future error_message
    // column without making it a v1 dependency.
    errorMessage: row.error_message ?? row.errorMessage ?? null,
    createdAt: row.created_at,
  };
}

function runErrorMessage(row) {
  return row?.error_message ?? row?.errorMessage ?? null;
}

function normalizeActor(value, fallback) {
  const candidate = typeof value === "object" && value !== null
    ? value.actor ?? value.subject ?? value.id
    : value;
  return cleanText(candidate ?? fallback, "actor", { max: MAX_ACTOR_LENGTH });
}

function normalizeRequestId(value, fallbackFactory = () => id("schedule-request")) {
  if (value === undefined || value === null || value === "") return fallbackFactory();
  return cleanText(value, "requestId", { max: MAX_REQUEST_ID_LENGTH });
}

function normalizeError(error, fallbackCode = "schedule_dispatch_failed") {
  const rawCode = String(error?.code ?? fallbackCode).trim();
  const code = SAFE_CODE.test(rawCode) ? rawCode : fallbackCode;
  const rawMessage = String(error?.message ?? "").replace(CONTROL_CHARS_GLOBAL, " ").trim();
  const message = (SAFE_ERROR_MESSAGES[code]
    ?? (error instanceof AiPlatformError && Number(error.status) < 500 ? rawMessage : null)
    ?? "schedule operation failed").slice(0, MAX_ERROR_LENGTH);
  return { code, message };
}

function addSeconds(value, seconds) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("invalid schedule time");
  return new Date(date.getTime() + Number(seconds) * 1_000).toISOString();
}

function addMilliseconds(value, milliseconds) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("invalid schedule time");
  return new Date(date.getTime() + Number(milliseconds)).toISOString();
}

function runDedupeKey(dueAt) {
  return `interval:${dueAt}`;
}

function dedupeDueAt(dedupeKey, fallback) {
  const candidate = String(dedupeKey ?? "");
  const value = candidate.startsWith("interval:") ? candidate.slice("interval:".length) : candidate;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function scheduledTaskIdempotencyKey(scheduleId, dedupeKey) {
  const raw = `schedule:${scheduleId}:${dedupeKey}`;
  return raw.length <= 200 ? raw : `schedule:${sha256(raw).slice(0, 64)}`;
}

function isAllowedRunTransition(current, next) {
  if (!RUN_STATUSES.has(next)) return false;
  if (current.status === next) return true;
  if (!ACTIVE_RUN_STATUSES.has(current.status)) return false;
  if (TERMINAL_RUN_STATUSES.has(next)) return true;
  if (current.status === "queued" && next === "running") return true;
  // A freshly claimed run starts as the scheduler's running lease. It may
  // become queued only before a task id has been attached. Once a task is
  // attached and observed running, an older queued read cannot regress it.
  return current.status === "running" && next === "queued" && !current.task_id;
}

/**
 * Stable task adapter seam.
 *
 * The canonical taskService shape is:
 *   taskService.createTask({ identity, idempotencyKey, request })
 *
 * A future task implementation can be wired without changing scheduler logic
 * by injecting `createTask({ identity, idempotencyKey, request, schedule, run })`.
 * The adapter must persist the task before returning its local taskId; the
 * schedule_runs.task_id foreign key intentionally rejects an unknown id.
 */
export function buildScheduledTaskRequest(claim) {
  const schedule = claim?.schedule ?? claim;
  const scheduleId = String(claim?.scheduleId ?? schedule?.id ?? "").trim();
  const taskTypeValue = String(claim?.taskType ?? schedule?.taskType ?? schedule?.task_type ?? "").trim();
  const featureValue = String(claim?.feature ?? schedule?.feature ?? "").trim();
  const input = claim?.inputTemplate ?? schedule?.inputTemplate ?? parseObject(schedule?.input_template_json, {});
  return {
    schemaVersion: AI_TASK_SCHEMA_VERSION,
    taskType: taskTypeValue,
    feature: featureValue,
    channel: "worker",
    subject: { type: "schedule", id: scheduleId },
    input: JSON.parse(stableJson(input)),
    priority: "background",
  };
}

export function buildScheduleIdempotencyKey(claim) {
  return scheduledTaskIdempotencyKey(
    String(claim?.scheduleId ?? claim?.schedule?.id ?? "").trim(),
    String(claim?.dedupeKey ?? "").trim(),
  );
}

function defaultIdentityFactory() {
  return { ...DEFAULT_SCHEDULER_IDENTITY };
}

function taskStatusFromResponse(response) {
  const status = String(response?.status ?? response?.task?.status ?? "queued").trim().toLowerCase();
  if (status === "succeeded") return "succeeded";
  if (status === "running") return "running";
  if (TERMINAL_TASK_STATUSES.has(status)) return "failed";
  return "queued";
}

function taskIdFromResponse(response) {
  const value = response?.taskId
    ?? response?.task?.taskId
    ?? response?.task?.id
    ?? response?.id;
  const taskId = String(value ?? "").trim();
  return taskId || null;
}

function taskErrorForStatus(response) {
  const status = String(response?.status ?? response?.task?.status ?? "").trim().toLowerCase();
  if (status === "cancelled") return { code: "task_cancelled", message: "scheduled task was cancelled" };
  if (status === "expired") return { code: "task_expired", message: "scheduled task expired" };
  const responseCode = response?.errorCode ?? response?.task?.errorCode;
  const responseMessage = response?.errorMessage ?? response?.task?.errorMessage;
  if (responseCode || responseMessage) {
    return normalizeError({
      code: responseCode ?? "task_failed",
      message: responseMessage,
    }, "task_failed");
  }
  return { code: "task_failed", message: "scheduled task failed" };
}

function taskRunState(response) {
  const rawStatus = String(response?.status ?? response?.task?.status ?? "queued").trim().toLowerCase();
  if (rawStatus === "succeeded") return { status: "succeeded", errorCode: null, errorMessage: null };
  if (rawStatus === "running") return { status: "running", errorCode: null, errorMessage: null };
  if (TERMINAL_TASK_STATUSES.has(rawStatus)) {
    const fallback = taskErrorForStatus(response);
    const info = normalizeError({
      code: response?.errorCode ?? response?.task?.errorCode ?? fallback.code,
      message: response?.errorMessage ?? response?.task?.errorMessage ?? fallback.message,
    }, fallback.code);
    return { status: "failed", errorCode: info.code, errorMessage: info.message };
  }
  return { status: "queued", errorCode: null, errorMessage: null };
}

export function createScheduleService({
  db,
  taskService = null,
  createTask = null,
  readTask = null,
  clock = () => new Date(),
  logger = console,
  config = {},
  schedulerId = "scheduler",
  schedulerIdentity = null,
  identityFactory = null,
  leaseMs = config.scheduleLeaseMs ?? config.taskLeaseMs ?? DEFAULT_LEASE_MS,
  pollMs = config.schedulePollMs ?? DEFAULT_POLL_MS,
  dispatchConcurrency = config.scheduleDispatchConcurrency ?? DEFAULT_DISPATCH_CONCURRENCY,
} = {}) {
  if (!db) throw new TypeError("db is required");
  const safeSchedulerId = normalizeActor(schedulerId, "scheduler");
  const safeLeaseMs = cleanInteger(leaseMs, "leaseMs", { min: 1, max: 10 * 60_000 });
  const safePollMs = cleanInteger(pollMs, "pollMs", { min: 10, max: 60_000 });
  const safeDispatchConcurrency = cleanInteger(dispatchConcurrency, "dispatchConcurrency", { min: 1, max: 20 });
  const taskCreator = typeof createTask === "function"
    ? createTask
    : (typeof taskService?.createTask === "function" ? taskService.createTask.bind(taskService) : null);
  const taskReader = typeof readTask === "function"
    ? readTask
    : (typeof taskService?.readTask === "function" ? taskService.readTask.bind(taskService) : null);
  const makeIdentity = identityFactory
    ?? (typeof schedulerIdentity === "function" ? schedulerIdentity : () => schedulerIdentity ?? defaultIdentityFactory());

  let timer = null;
  let inFlight = null;
  let closed = false;

  function now() {
    return iso(clock);
  }

  function rowById(scheduleId) {
    return db.prepare("SELECT * FROM schedules WHERE id = $id").get({ $id: scheduleId }) ?? null;
  }

  function runRowById(runId) {
    return db.prepare("SELECT * FROM schedule_runs WHERE id = $id").get({ $id: runId }) ?? null;
  }

  function requireSchedule(scheduleId) {
    const row = rowById(scheduleId);
    if (!row) throw new AiPlatformError("schedule not found", { code: "not_found", status: 404 });
    return row;
  }

  function writeAudit({ actor, action, resourceType, resourceId, before = null, after = null, requestId, at }) {
    try {
      db.prepare(`
        INSERT INTO admin_audit (
          actor, action, resource_type, resource_id, before_json, after_json, request_id, created_at
        ) VALUES (
          $actor, $action, $resourceType, $resourceId, $beforeJson, $afterJson, $requestId, $createdAt
        )
      `).run({
        $actor: normalizeActor(actor, safeSchedulerId),
        $action: cleanText(action, "action", { max: 120 }),
        $resourceType: cleanText(resourceType, "resourceType", { max: 120 }),
        $resourceId: cleanText(resourceId, "resourceId", { max: 200 }),
        $beforeJson: before === null ? null : stringify(before, "{}"),
        $afterJson: after === null ? null : stringify(after, "{}"),
        $requestId: normalizeRequestId(requestId),
        $createdAt: at,
      });
    } catch (error) {
      // The core migration owns admin_audit. Keep scheduling usable in a
      // reduced test schema, but surface an operational warning loudly.
      logger.warn?.("AI schedule audit write failed", {
        action,
        resourceId,
        error: error?.message,
      });
    }
  }

  function updateSchedulePointer(row, { dueAt, status, error = null, at }) {
    const nextRunAt = addSeconds(dueAt, Number(row.interval_seconds));
    db.prepare(`
      UPDATE schedules
         SET next_run_at = $nextRunAt,
             last_run_at = $lastRunAt,
             last_status = $lastStatus,
             last_error = $lastError,
             updated_at = $updatedAt
       WHERE id = $id
    `).run({
      $nextRunAt: nextRunAt,
      $lastRunAt: dueAt,
      $lastStatus: status,
      $lastError: error,
      $updatedAt: at,
      $id: row.id,
    });
    return nextRunAt;
  }

  function claimView(row, run, { leaseStartedAt, dueAt, reclaimed = false, existingTaskId = null } = {}) {
    return {
      runId: run.id,
      scheduleId: row.id,
      schedule: scheduleView(row),
      taskType: row.task_type,
      feature: row.feature,
      inputTemplate: parseObject(row.input_template_json, {}),
      dueAt,
      dedupeKey: run.dedupe_key,
      leaseStartedAt,
      leaseExpiresAt: addMilliseconds(leaseStartedAt, safeLeaseMs),
      reclaimed,
      existingTaskId: existingTaskId ?? run.task_id ?? null,
    };
  }

  function detailedRunView(row) {
    const view = scheduleRunView(row);
    if (!view || view.errorMessage || !view.errorCode) return view;
    try {
      const audit = db.prepare(`
        SELECT after_json
          FROM admin_audit
         WHERE resource_type = 'schedule_run'
           AND resource_id = $resourceId
           AND action IN ('schedule.run_failed', 'schedule.run_skipped')
         ORDER BY id DESC
         LIMIT 1
      `).get({ $resourceId: view.id });
      const after = parseObject(audit?.after_json, {});
      if (typeof after.errorMessage === "string" && after.errorMessage) view.errorMessage = after.errorMessage;
    } catch {
      // Error detail remains available through schedules.last_error even if
      // an older/reduced schema does not provide the audit table.
    }
    return view;
  }

  function markInvalidScheduleTime(row, at, error) {
    const info = normalizeError(error, "invalid_schedule_time");
    db.prepare(`
      UPDATE schedules
         SET enabled = 0, next_run_at = NULL, last_status = 'failed',
             last_error = $lastError, updated_at = $updatedAt
       WHERE id = $id AND enabled = 1
    `).run({ $lastError: info.message, $updatedAt: at, $id: row.id });
    writeAudit({
      actor: safeSchedulerId,
      action: "schedule.invalid",
      resourceType: "schedule",
      resourceId: row.id,
      before: scheduleAuditView(row),
      after: { ...scheduleAuditView(row), enabled: false, nextRunAt: null, lastStatus: "failed", lastError: info.message },
      requestId: `schedule:${row.id}:invalid`,
      at,
    });
  }

  function claimDueOccurrences({ limit = DEFAULT_SCAN_LIMIT, maxOccurrencesPerSchedule = DEFAULT_CATCH_UP, at = null } = {}) {
    let safeLimit;
    let safeCatchUp;
    try {
      safeLimit = safeLimitValue(limit, DEFAULT_SCAN_LIMIT, 500);
      safeCatchUp = safeLimitValue(maxOccurrencesPerSchedule, DEFAULT_CATCH_UP, 100);
    } catch {
      throw new AiPlatformError("scan limit is invalid", { code: "invalid_request", status: 400 });
    }
    const atIso = at === null || at === undefined ? now() : cleanDate(at, "at");
    return withImmediateTransaction(db, () => {
      const candidates = db.prepare(`
        SELECT *
          FROM schedules
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= $at
         ORDER BY next_run_at ASC, id ASC
         LIMIT $limit
      `).all({ $at: atIso, $limit: safeLimit });
      const claims = [];
      const skipped = [];
      let considered = 0;

      for (const candidate of candidates) {
        let perSchedule = 0;
        while (perSchedule < safeCatchUp && considered < safeLimit) {
          const row = rowById(candidate.id);
          if (!row || !Number(row.enabled) || !row.next_run_at || row.next_run_at > atIso) break;
          let dueAt;
          try {
            dueAt = cleanDate(row.next_run_at, "nextRunAt");
          } catch (error) {
            markInvalidScheduleTime(row, atIso, error);
            skipped.push({ scheduleId: row.id, reason: "invalid_schedule_time" });
            considered += 1;
            break;
          }
          const dedupeKey = runDedupeKey(dueAt);
          const existing = db.prepare(`
            SELECT * FROM schedule_runs
             WHERE schedule_id = $scheduleId AND dedupe_key = $dedupeKey
          `).get({ $scheduleId: row.id, $dedupeKey: dedupeKey }) ?? null;

          if (existing) {
            const stale = existing.status === "running"
              && cleanDate(existing.started_at, "startedAt") < new Date(new Date(atIso).getTime() - safeLeaseMs).toISOString();
            if (stale && !existing.task_id) {
              const changed = db.prepare(`
                UPDATE schedule_runs
                   SET started_at = $startedAt, error_code = NULL, completed_at = NULL
                 WHERE id = $id AND status = 'running' AND started_at = $previousStartedAt
              `).run({
                $startedAt: atIso,
                $previousStartedAt: existing.started_at,
                $id: existing.id,
              });
              if (Number(changed.changes ?? 0) === 1) {
                db.prepare(`
                  UPDATE schedules
                     SET last_status = 'running', last_error = NULL, updated_at = $updatedAt
                   WHERE id = $id
                `).run({ $updatedAt: atIso, $id: row.id });
                claims.push(claimView(row, { ...existing, started_at: atIso }, {
                  leaseStartedAt: atIso,
                  dueAt,
                  reclaimed: true,
                }));
              }
            } else if (stale && existing.task_id) {
              const changed = db.prepare(`
                UPDATE schedule_runs
                   SET started_at = $startedAt, error_code = NULL, completed_at = NULL
                 WHERE id = $id AND status = 'running' AND started_at = $previousStartedAt
              `).run({
                $startedAt: atIso,
                $previousStartedAt: existing.started_at,
                $id: existing.id,
              });
              if (Number(changed.changes ?? 0) === 1) {
                db.prepare(`
                  UPDATE schedules
                     SET last_status = 'running', last_error = NULL, updated_at = $updatedAt
                   WHERE id = $id
                `).run({ $updatedAt: atIso, $id: row.id });
                claims.push(claimView(row, { ...existing, started_at: atIso }, {
                  leaseStartedAt: atIso,
                  dueAt,
                  reclaimed: true,
                  existingTaskId: existing.task_id,
                }));
              }
            } else {
              updateSchedulePointer(row, {
                dueAt,
                status: existing.status,
                error: runErrorMessage(existing),
                at: atIso,
              });
              skipped.push({
                scheduleId: row.id,
                runId: existing.id,
                dedupeKey,
                reason: "duplicate",
                status: existing.status,
              });
              writeAudit({
                actor: safeSchedulerId,
                action: "schedule.run_deduplicated",
                resourceType: "schedule_run",
                resourceId: existing.id,
                before: scheduleRunView(existing),
                after: scheduleRunView({ ...existing, status: existing.status }),
                requestId: `schedule:${row.id}:${dedupeKey}`,
                at: atIso,
              });
            }
            perSchedule += 1;
            considered += 1;
            continue;
          }

          const runId = id("schedule-run");
          const inserted = db.prepare(`
            INSERT INTO schedule_runs (
              id, schedule_id, dedupe_key, task_id, status, started_at,
              completed_at, error_code, created_at
            ) VALUES (
              $id, $scheduleId, $dedupeKey, NULL, 'running', $startedAt,
              NULL, NULL, $createdAt
            )
          `).run({
            $id: runId,
            $scheduleId: row.id,
            $dedupeKey: dedupeKey,
            $startedAt: atIso,
            $createdAt: atIso,
          });
          if (Number(inserted.changes ?? 0) !== 1) {
            throw new AiPlatformError("schedule run could not be claimed", {
              code: "schedule_claim_failed",
              status: 503,
            });
          }
          updateSchedulePointer(row, { dueAt, status: "running", error: null, at: atIso });
          const run = {
            id: runId,
            schedule_id: row.id,
            dedupe_key: dedupeKey,
            task_id: null,
            status: "running",
            started_at: atIso,
            created_at: atIso,
          };
          const claim = claimView(row, run, { leaseStartedAt: atIso, dueAt });
          claims.push(claim);
          writeAudit({
            actor: safeSchedulerId,
            action: "schedule.run_claimed",
            resourceType: "schedule_run",
            resourceId: runId,
            before: null,
            after: {
              scheduleId: row.id,
              dedupeKey,
              dueAt,
              leaseStartedAt: atIso,
            },
            requestId: `schedule:${row.id}:${dedupeKey}`,
            at: atIso,
          });
          perSchedule += 1;
          considered += 1;
        }
      }
      return {
        scanned: candidates.length,
        considered,
        claims,
        skipped,
      };
    });
  }

  function recoverStaleRuns({ limit = DEFAULT_SCAN_LIMIT, at = null } = {}) {
    let safeLimit;
    try {
      safeLimit = safeLimitValue(limit, DEFAULT_SCAN_LIMIT, 500);
    } catch {
      throw new AiPlatformError("recovery limit is invalid", { code: "invalid_request", status: 400 });
    }
    const atIso = at === null || at === undefined ? now() : cleanDate(at, "at");
    const cutoff = new Date(new Date(atIso).getTime() - safeLeaseMs).toISOString();
    return withImmediateTransaction(db, () => {
      const candidates = db.prepare(`
        SELECT id
          FROM schedule_runs
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at < $cutoff
         ORDER BY started_at ASC, id ASC
         LIMIT $limit
      `).all({ $cutoff: cutoff, $limit: safeLimit });
      const claims = [];
      const skipped = [];
      for (const candidate of candidates) {
        const run = runRowById(candidate.id);
        if (!run || run.status !== "running" || !run.started_at || run.started_at >= cutoff) continue;
        const row = rowById(run.schedule_id);
        if (!row) continue;
        if (!Number(row.enabled)) {
          const info = { code: "schedule_paused", message: "schedule is paused" };
          db.prepare(`
            UPDATE schedule_runs
               SET status = 'skipped', error_code = $errorCode, completed_at = $completedAt
             WHERE id = $id AND status = 'running' AND started_at = $startedAt
          `).run({
            $errorCode: info.code,
            $completedAt: atIso,
            $id: run.id,
            $startedAt: run.started_at,
          });
          db.prepare(`
            UPDATE schedules
               SET last_status = 'skipped', last_error = $lastError, updated_at = $updatedAt
             WHERE id = $id
          `).run({ $lastError: info.message, $updatedAt: atIso, $id: row.id });
          skipped.push({ scheduleId: row.id, runId: run.id, reason: info.code });
          writeAudit({
            actor: safeSchedulerId,
            action: "schedule.run_skipped",
            resourceType: "schedule_run",
            resourceId: run.id,
            before: scheduleRunView(run),
            after: { ...scheduleRunView(run), status: "skipped", errorCode: info.code, errorMessage: info.message },
            requestId: `schedule:${row.id}:${run.dedupe_key}`,
            at: atIso,
          });
          continue;
        }
          const changed = db.prepare(`
            UPDATE schedule_runs
             SET started_at = $startedAt, completed_at = NULL,
                 error_code = NULL
           WHERE id = $id AND status = 'running' AND started_at = $previousStartedAt
        `).run({
          $startedAt: atIso,
          $previousStartedAt: run.started_at,
          $id: run.id,
        });
        if (Number(changed.changes ?? 0) !== 1) continue;
        const dueAt = dedupeDueAt(run.dedupe_key, row.last_run_at ?? run.created_at ?? atIso);
        db.prepare(`
          UPDATE schedules
             SET last_status = 'running', last_error = NULL, updated_at = $updatedAt
           WHERE id = $id
        `).run({ $updatedAt: atIso, $id: row.id });
        claims.push(claimView(row, { ...run, started_at: atIso }, {
          leaseStartedAt: atIso,
          dueAt,
          reclaimed: true,
          existingTaskId: run.task_id,
        }));
        writeAudit({
          actor: safeSchedulerId,
          action: "schedule.run_reclaimed",
          resourceType: "schedule_run",
          resourceId: run.id,
          before: scheduleRunView(run),
          after: { ...scheduleRunView(run), status: "running", startedAt: atIso },
          requestId: `schedule:${row.id}:${run.dedupe_key}`,
          at: atIso,
        });
      }
      return { scanned: candidates.length, claims, skipped };
    });
  }

  function currentScheduleEnabled(scheduleId) {
    const row = db.prepare("SELECT enabled FROM schedules WHERE id = $id").get({ $id: scheduleId });
    return Boolean(Number(row?.enabled ?? 0));
  }

  function transitionRunInTransaction(claim, {
    status,
    taskId = undefined,
    expectedTaskId = null,
    errorCode = null,
    errorMessage = null,
    at = null,
  } = {}) {
    const current = runRowById(claim?.runId);
    const leaseStartedAt = String(claim?.leaseStartedAt ?? "");
    const expectedTaskIdValue = expectedTaskId === null || expectedTaskId === undefined
      ? null
      : String(expectedTaskId).trim() || null;
    if (!current || !ACTIVE_RUN_STATUSES.has(current.status) || current.started_at !== leaseStartedAt) {
      return { stale: true, run: detailedRunView(current) };
    }
    if (expectedTaskIdValue !== null && String(current.task_id ?? "") !== expectedTaskIdValue) {
      return { stale: true, run: detailedRunView(current) };
    }

    const transitionAt = at === null || at === undefined ? now() : cleanDate(at, "at");
    const nextTaskId = taskId === null || taskId === undefined
      ? (current.task_id ?? null)
      : (String(taskId).trim() || null);
    if (status === "queued" && !nextTaskId) {
      throw new AiPlatformError("queued schedule run must reference a task", {
        code: "task_service_invalid_response",
        status: 503,
      });
    }

    let nextErrorCode = null;
    let nextErrorMessage = null;
    if (status === "failed" || status === "skipped") {
      const fallbackCode = status === "skipped" ? "schedule_paused" : "schedule_dispatch_failed";
      const info = normalizeError({
        code: errorCode ?? fallbackCode,
        message: errorMessage,
      }, fallbackCode);
      nextErrorCode = info.code;
      nextErrorMessage = info.message;
    }
    const terminal = TERMINAL_RUN_STATUSES.has(status);
    const completedAt = terminal ? transitionAt : null;
    if (!isAllowedRunTransition(current, status)) {
      return { stale: true, run: detailedRunView(current) };
    }

    const unchanged = current.status === status
      && (current.task_id ?? null) === nextTaskId
      && (current.completed_at ?? null) === completedAt
      && (current.error_code ?? null) === nextErrorCode;
    if (unchanged) return { stale: false, changed: false, run: detailedRunView(current) };

    const taskFence = expectedTaskIdValue === null ? "" : " AND task_id = $expectedTaskId";
    const changed = db.prepare(`
      UPDATE schedule_runs
         SET task_id = $taskId, status = $status, completed_at = $completedAt,
             error_code = $errorCode
       WHERE id = $id
         AND status = $currentStatus
         AND started_at = $startedAt
         ${taskFence}
    `).run({
      $taskId: nextTaskId,
      $status: status,
      $completedAt: completedAt,
      $errorCode: nextErrorCode,
      $id: current.id,
      $currentStatus: current.status,
      $startedAt: leaseStartedAt,
      ...(expectedTaskIdValue === null ? {} : { $expectedTaskId: expectedTaskIdValue }),
    });
    if (Number(changed.changes ?? 0) !== 1) {
      return { stale: true, run: detailedRunView(runRowById(claim.runId)) };
    }

    const schedule = rowById(current.schedule_id);
    if (schedule) {
      const dueAt = claim?.dueAt === null || claim?.dueAt === undefined
        ? null
        : cleanDate(claim.dueAt, "dueAt");
      const scheduleDueFence = dueAt === null
        ? ""
        : " AND (last_run_at IS NULL OR last_run_at <= $dueAt)";
      db.prepare(`
        UPDATE schedules
           SET last_status = $lastStatus, last_error = $lastError, updated_at = $updatedAt
         WHERE id = $id${scheduleDueFence}
      `).run({
        $lastStatus: status,
        $lastError: nextErrorMessage,
        $updatedAt: transitionAt,
        $id: schedule.id,
        ...(dueAt === null ? {} : { $dueAt: dueAt }),
      });
    }

    const after = detailedRunView(runRowById(current.id));
    const auditedAfter = { ...after, errorMessage: nextErrorMessage };
    writeAudit({
      actor: safeSchedulerId,
      action: status === "failed" ? "schedule.run_failed" : `schedule.run_${status}`,
      resourceType: "schedule_run",
      resourceId: current.id,
      before: scheduleRunView(current),
      after: auditedAfter,
      requestId: `schedule:${current.schedule_id}:${current.dedupe_key}`,
      at: transitionAt,
    });
    return { stale: false, changed: true, run: auditedAfter };
  }

  function finishRun(claim, {
    status,
    taskId = null,
    errorCode = null,
    errorMessage = null,
    at = null,
  } = {}) {
    if (!RUN_STATUSES.has(status)) {
      throw new AiPlatformError("schedule run status is invalid", { code: "internal_error", status: 500 });
    }
    return withImmediateTransaction(db, () => transitionRunInTransaction(claim, {
      status,
      taskId,
      errorCode,
      errorMessage,
      at,
    }));
  }

  function reconcileRun(claim, taskResponse) {
    const state = taskRunState(taskResponse);
    const claimTaskId = String(claim?.existingTaskId ?? "").trim() || null;
    const responseTaskId = taskIdFromResponse(taskResponse);
    if (claimTaskId && responseTaskId && claimTaskId !== responseTaskId) {
      return { stale: true, run: detailedRunView(runRowById(claim.runId)) };
    }
    const expectedTaskId = claimTaskId ?? responseTaskId;
    return withImmediateTransaction(db, () => {
      return transitionRunInTransaction(claim, {
        status: state.status,
        taskId: expectedTaskId,
        expectedTaskId,
        errorCode: state.errorCode,
        errorMessage: state.errorMessage,
        at: now(),
      });
    });
  }

  async function identityFor(claim) {
    const identity = await makeIdentity(claim);
    if (!identity || typeof identity !== "object") {
      throw new AiPlatformError("scheduler identity is unavailable", { code: "task_service_unavailable", status: 503 });
    }
    return identity;
  }

  async function dispatchClaim(claim) {
    if (!currentScheduleEnabled(claim.scheduleId)) {
      return {
        claim,
        outcome: finishRun(claim, {
          status: "skipped",
          errorCode: "schedule_paused",
          errorMessage: "schedule is paused before task creation",
        }),
      };
    }

    let taskId = claim.existingTaskId ?? null;
    try {
      const identity = await identityFor(claim);
      let response;
      if (taskId && taskReader) {
        response = await taskReader({ identity, taskId });
      } else if (taskId) {
        response = { taskId, status: "queued", replayed: true };
      } else {
        if (!currentScheduleEnabled(claim.scheduleId)) {
          return {
            claim,
            outcome: finishRun(claim, {
              status: "skipped",
              errorCode: "schedule_paused",
              errorMessage: "schedule is paused before task creation",
            }),
          };
        }
        if (!taskCreator) {
          throw new AiPlatformError("taskService.createTask adapter is required", {
            code: "task_service_unavailable",
            status: 503,
          });
        }
        const request = buildScheduledTaskRequest(claim);
        response = await taskCreator({
          identity,
          idempotencyKey: buildScheduleIdempotencyKey(claim),
          request,
          schedule: claim.schedule,
          run: { id: claim.runId, dedupeKey: claim.dedupeKey, dueAt: claim.dueAt },
        });
        taskId = taskIdFromResponse(response);
        if (!taskId) {
          throw new AiPlatformError("taskService.createTask returned no taskId", {
            code: "task_service_invalid_response",
            status: 503,
          });
        }
      }

      const status = taskStatusFromResponse(response);
      const taskError = status === "failed" ? taskErrorForStatus(response) : { code: null, message: null };
      const outcome = finishRun(claim, {
        status,
        taskId,
        errorCode: taskError.code,
        errorMessage: taskError.message,
      });
      return { claim, outcome, taskId, taskResponse: response };
    } catch (error) {
      const info = normalizeError(error);
      const outcome = finishRun(claim, {
        status: "failed",
        taskId,
        errorCode: info.code,
        errorMessage: info.message,
      });
      logger.error?.("AI schedule dispatch failed", {
        scheduleId: claim.scheduleId,
        runId: claim.runId,
        code: info.code,
        error: info.message,
      });
      return { claim, outcome, error: info };
    }
  }

  async function dispatchClaims(claims) {
    const results = new Array(claims.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= claims.length) return;
        results[index] = await dispatchClaim(claims[index]);
      }
    }
    const workers = Array.from({ length: Math.min(safeDispatchConcurrency, claims.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function reconcileRuns({ limit = DEFAULT_SCAN_LIMIT } = {}) {
    if (!taskReader) return { scanned: 0, reconciled: 0, failed: 0, runs: [] };
    let safeLimit;
    try {
      safeLimit = safeLimitValue(limit, DEFAULT_SCAN_LIMIT, 500);
    } catch {
      throw new AiPlatformError("reconciliation limit is invalid", { code: "invalid_request", status: 400 });
    }
    const rows = db.prepare(`
      SELECT *
        FROM schedule_runs
       WHERE status IN ('queued', 'running') AND task_id IS NOT NULL
       ORDER BY created_at ASC, id ASC
       LIMIT $limit
    `).all({ $limit: safeLimit });
    const results = [];
    for (const run of rows) {
      const schedule = rowById(run.schedule_id);
      if (!schedule) continue;
      const claim = claimView(schedule, run, {
        leaseStartedAt: run.started_at ?? run.created_at ?? now(),
        dueAt: dedupeDueAt(run.dedupe_key, run.created_at ?? now()),
        existingTaskId: run.task_id,
      });
      try {
        const identity = await identityFor(claim);
        const response = await taskReader({ identity, taskId: run.task_id });
        results.push(reconcileRun(claim, response));
      } catch (error) {
        const info = normalizeError(error, "task_read_failed");
        logger.warn?.("AI schedule task reconciliation failed", {
          scheduleId: run.schedule_id,
          runId: run.id,
          code: info.code,
        });
        results.push({ stale: false, changed: false, error: info, run: scheduleRunView(run) });
      }
    }
    return {
      scanned: rows.length,
      reconciled: results.filter((item) => item.changed).length,
      failed: results.filter((item) => item.error).length,
      runs: results.filter((item) => item.changed).map((item) => item.run).filter(Boolean),
    };
  }

  async function scanDue({ limit = DEFAULT_SCAN_LIMIT, maxOccurrencesPerSchedule = DEFAULT_CATCH_UP } = {}) {
    if (closed) {
      return {
        scanned: 0,
        recovered: 0,
        reconciled: 0,
        claimed: 0,
        dispatched: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        runs: [],
      };
    }
    const reconciled = await reconcileRuns({ limit });
    const recovered = recoverStaleRuns({ limit });
    const due = claimDueOccurrences({ limit, maxOccurrencesPerSchedule });
    const claims = [...recovered.claims, ...due.claims];
    const dispatched = await dispatchClaims(claims);
    const reconciledRuns = reconciled.runs ?? [];
    const dispatchedRuns = dispatched.map((item) => item.outcome?.run ?? null).filter(Boolean);
    const runStatuses = [...reconciledRuns, ...dispatchedRuns].map((run) => run.status ?? null);
    return {
      scanned: due.scanned + recovered.scanned,
      recovered: recovered.claims.length + recovered.skipped.length,
      reconciled: reconciled.reconciled,
      claimed: claims.length,
      dispatched: dispatched.length,
      succeeded: runStatuses.filter((status) => status === "succeeded").length,
      failed: runStatuses.filter((status) => status === "failed").length,
      skipped: due.skipped.length + recovered.skipped.length
        + runStatuses.filter((status) => status === "skipped").length,
      runs: [...reconciledRuns, ...dispatchedRuns],
      claims,
      skippedRuns: [...recovered.skipped, ...due.skipped],
    };
  }

  function listSchedules({ enabled = null, taskType: taskTypeFilter = null, limit = 50, offset = 0 } = {}) {
    let safeLimitValue;
    let safeOffsetValue;
    try {
      safeLimitValue = safeLimit(limit, 50, 200);
      safeOffsetValue = safeOffset(offset, 0, 100_000);
    } catch {
      throw new AiPlatformError("pagination is invalid", { code: "invalid_request", status: 400 });
    }
    const clauses = [];
    const params = { $limit: safeLimitValue, $offset: safeOffsetValue };
    if (enabled !== null && enabled !== undefined) {
      clauses.push("enabled = $enabled");
      params.$enabled = cleanBoolean(enabled, "enabled") ? 1 : 0;
    }
    if (taskTypeFilter !== null && taskTypeFilter !== undefined && taskTypeFilter !== "") {
      params.$taskType = normalizeTaskType(taskTypeFilter);
      clauses.push("task_type = $taskType");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT * FROM schedules
      ${where}
      ORDER BY enabled DESC, next_run_at ASC, id ASC
      LIMIT $limit OFFSET $offset
    `).all(params).map(scheduleView);
  }

  function listScheduleRuns({ scheduleId = null, status = null, limit = 50, offset = 0 } = {}) {
    let safeLimitValue;
    let safeOffsetValue;
    try {
      safeLimitValue = safeLimit(limit, 50, 200);
      safeOffsetValue = safeOffset(offset, 0, 100_000);
    } catch {
      throw new AiPlatformError("pagination is invalid", { code: "invalid_request", status: 400 });
    }
    const clauses = [];
    const params = { $limit: safeLimitValue, $offset: safeOffsetValue };
    if (scheduleId !== null && scheduleId !== undefined && scheduleId !== "") {
      params.$scheduleId = cleanIdentifier(scheduleId, "scheduleId");
      clauses.push("sr.schedule_id = $scheduleId");
    }
    if (status !== null && status !== undefined && status !== "") {
      const normalizedStatus = cleanText(status, "status", { max: 20 });
      if (!RUN_STATUSES.has(normalizedStatus)) {
        throw new AiPlatformError("status is invalid", { code: "invalid_request", status: 400 });
      }
      params.$status = normalizedStatus;
      clauses.push("sr.status = $status");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT sr.*
        FROM schedule_runs sr
        ${where}
       ORDER BY sr.created_at DESC, sr.id DESC
       LIMIT $limit OFFSET $offset
    `).all(params).map(detailedRunView);
  }

  function listScheduleErrors(options = {}) {
    return listScheduleRuns({ ...options, status: "failed" });
  }

  function readSchedule(scheduleId) {
    const normalizedId = cleanIdentifier(scheduleId, "scheduleId");
    return scheduleView(requireSchedule(normalizedId));
  }

  function readScheduleRun(runId) {
    const normalizedId = cleanIdentifier(runId, "runId");
    const row = runRowById(normalizedId);
    if (!row) throw new AiPlatformError("schedule run not found", { code: "not_found", status: 404 });
    return detailedRunView(row);
  }

  function createSchedule(options = {}) {
    const at = now();
    const actor = normalizeActor(options.actor, safeSchedulerId);
    const requestId = normalizeRequestId(options.requestId);
    const normalized = normalizeScheduleCreate(options, at);
    try {
      return withImmediateTransaction(db, () => {
        const createdAt = at;
        db.prepare(`
          INSERT INTO schedules (
            id, slug, name, task_type, feature, interval_seconds, enabled, priority,
            input_template_json, next_run_at, last_run_at, last_status, last_error,
            created_at, updated_at
          ) VALUES (
            $id, $slug, $name, $taskType, $feature, $intervalSeconds, $enabled, 'background',
            $inputTemplateJson, $nextRunAt, NULL, NULL, NULL, $createdAt, $updatedAt
          )
        `).run({
          $id: normalized.id,
          $slug: normalized.slug,
          $name: normalized.name,
          $taskType: normalized.taskType,
          $feature: normalized.feature,
          $intervalSeconds: normalized.intervalSeconds,
          $enabled: normalized.enabled ? 1 : 0,
          $inputTemplateJson: stableJson(normalized.inputTemplate),
          $nextRunAt: normalized.nextRunAt,
          $createdAt: createdAt,
          $updatedAt: createdAt,
        });
        const row = rowById(normalized.id);
        writeAudit({
          actor,
          action: "schedule.created",
          resourceType: "schedule",
          resourceId: normalized.id,
          before: null,
          after: scheduleAuditView(row),
          requestId,
          at,
        });
        return scheduleView(row);
      });
    } catch (error) {
      throw normalizeThrown(error);
    }
  }

  function updateSchedule(options = {}) {
    const scheduleId = cleanIdentifier(options.scheduleId ?? options.id, "scheduleId");
    const at = now();
    const actor = normalizeActor(options.actor, safeSchedulerId);
    const requestId = normalizeRequestId(options.requestId);
    try {
      return withImmediateTransaction(db, () => {
        const current = requireSchedule(scheduleId);
        const expected = options.expectedUpdatedAt ?? options.ifUnmodifiedSince ?? null;
        if (expected !== null && cleanDate(expected, "expectedUpdatedAt") !== current.updated_at) {
          throw new AiPlatformError("schedule was modified by another request", { code: "conflict", status: 409 });
        }
        const normalized = normalizeScheduleUpdate(options, current, at);
        db.prepare(`
          UPDATE schedules
             SET slug = $slug, name = $name, task_type = $taskType, feature = $feature,
                 interval_seconds = $intervalSeconds, enabled = $enabled, priority = 'background',
                 input_template_json = $inputTemplateJson, next_run_at = $nextRunAt,
                 updated_at = $updatedAt,
                 last_status = CASE WHEN $enabled = 0 THEN 'paused' ELSE last_status END
           WHERE id = $id
        `).run({
          $slug: normalized.slug,
          $name: normalized.name,
          $taskType: normalized.taskType,
          $feature: normalized.feature,
          $intervalSeconds: normalized.intervalSeconds,
          $enabled: normalized.enabled ? 1 : 0,
          $inputTemplateJson: stableJson(normalized.inputTemplate),
          $nextRunAt: normalized.nextRunAt,
          $updatedAt: at,
          $id: scheduleId,
        });
        const row = rowById(scheduleId);
        writeAudit({
          actor,
          action: "schedule.updated",
          resourceType: "schedule",
          resourceId: scheduleId,
          before: scheduleAuditView(current),
          after: scheduleAuditView(row),
          requestId,
          at,
        });
        return scheduleView(row);
      });
    } catch (error) {
      throw normalizeThrown(error);
    }
  }

  function setEnabled(options = {}, enabled) {
    const scheduleId = cleanIdentifier(options.scheduleId ?? options.id, "scheduleId");
    const at = now();
    const actor = normalizeActor(options.actor, safeSchedulerId);
    const requestId = normalizeRequestId(options.requestId);
    try {
      return withImmediateTransaction(db, () => {
        const current = requireSchedule(scheduleId);
        const before = scheduleAuditView(current);
        const nextRunAt = enabled
          ? (current.next_run_at && new Date(current.next_run_at).getTime() > new Date(at).getTime()
            ? current.next_run_at
            : addSeconds(at, Number(current.interval_seconds)))
          : null;
        db.prepare(`
          UPDATE schedules
             SET enabled = $enabled, next_run_at = $nextRunAt,
                 last_status = CASE WHEN $enabled = 0 THEN 'paused' ELSE last_status END,
                 updated_at = $updatedAt
           WHERE id = $id
        `).run({
          $enabled: enabled ? 1 : 0,
          $nextRunAt: nextRunAt,
          $updatedAt: at,
          $id: scheduleId,
        });
        const row = rowById(scheduleId);
        writeAudit({
          actor,
          action: enabled ? "schedule.enabled" : "schedule.disabled",
          resourceType: "schedule",
          resourceId: scheduleId,
          before,
          after: scheduleAuditView(row),
          requestId,
          at,
        });
        return scheduleView(row);
      });
    } catch (error) {
      throw normalizeThrown(error);
    }
  }

  function enableSchedule(options = {}) {
    return setEnabled(options, true);
  }

  function disableSchedule(options = {}) {
    return setEnabled(options, false);
  }

  function getSchedule(options = {}) {
    return readSchedule(options.scheduleId ?? options.id ?? options);
  }

  function setScheduleEnabled(options = {}) {
    const enabled = cleanBoolean(options.enabled, "enabled");
    return setEnabled(options, enabled);
  }

  function start(options = {}) {
    if (closed) throw new AiPlatformError("schedule service is closed", { code: "service_closed", status: 503 });
    if (timer) return false;
    const interval = options.pollMs === undefined ? safePollMs : cleanInteger(options.pollMs, "pollMs", { min: 10, max: 60_000 });
    timer = setInterval(() => {
      if (inFlight || closed) return;
      inFlight = scanDue(options).catch((error) => {
        logger.error?.("AI schedule scan failed", { error: error?.message, code: error?.code });
        return null;
      }).finally(() => {
        inFlight = null;
      });
    }, interval);
    timer.unref?.();
    if (!inFlight) {
      inFlight = scanDue(options).catch((error) => {
        logger.error?.("AI schedule initial scan failed", { error: error?.message, code: error?.code });
        return null;
      }).finally(() => {
        inFlight = null;
      });
    }
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return true;
  }

  async function drain() {
    if (inFlight) await inFlight;
  }

  function close() {
    closed = true;
    stop();
  }

  return Object.freeze({
    listSchedules,
    readSchedule,
    getSchedule,
    createSchedule,
    updateSchedule,
    enableSchedule,
    disableSchedule,
    setScheduleEnabled,
    listScheduleRuns,
    listRuns: listScheduleRuns,
    listScheduleErrors,
    listErrors: listScheduleErrors,
    readScheduleRun,
    claimDueOccurrences,
    recoverStaleRuns,
    scanDue,
    scan: scanDue,
    runDue: scanDue,
    reconcileRuns,
    start,
    stop,
    drain,
    close,
  });
}

function safeLimitValue(value, fallback, max) {
  try {
    return safeLimit(value, fallback, max);
  } catch {
    throw new TypeError("limit is invalid");
  }
}
