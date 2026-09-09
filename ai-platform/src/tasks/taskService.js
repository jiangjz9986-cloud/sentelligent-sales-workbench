import {
  AiContractError,
  AI_TASK_STATUSES,
  AI_TASK_TERMINAL_STATUSES,
  normalizeTaskCreate,
  normalizeTaskResult,
  publicTaskShape,
  sha256,
  stableJson,
} from "../../../shared/aiPlatformContract.mjs";
import { reserveBudget, releaseBudget, settleBudget, calculateCostMicro, estimateUsage } from "../budgets/ledger.js";
import { AiPlatformError } from "../errors.js";
import { readOperationalControl } from "../operations/control.js";
import { priceAtAttempt } from "../budgets/priceCalendar.js";
import { id, iso, safeLimit, safeOffset, stringify, withImmediateTransaction } from "../utils.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;
const RETRYABLE_CODES = new Set([
  "provider_unavailable",
  "rate_limited",
  "temporary_failure",
  "network_error",
]);
const TERMINAL_STATUSES = new Set(AI_TASK_TERMINAL_STATUSES);
const PRIORITY_ORDER = "CASE t.priority WHEN 'interactive' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";

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

function parseArray(value, fallback = []) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

function normalizedIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new AiPlatformError("authentication required", { code: "missing_auth", status: 401 });
  }
  const issuer = String(identity.issuer ?? "").trim();
  const owner = String(identity.owner ?? "").trim();
  const actor = String(identity.actor ?? identity.subject ?? "").trim();
  if (!issuer || !owner || !actor) {
    throw new AiPlatformError("authentication required", { code: "invalid_auth", status: 401 });
  }
  return { issuer, owner, actor, isAdmin: identity.isAdmin === true };
}

function normalizeIdempotencyKey(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate.length > 200 || !IDEMPOTENCY_KEY.test(candidate)) {
    throw new AiPlatformError("Idempotency-Key is required", { code: "missing_idempotency_key", status: 400 });
  }
  return candidate;
}

function safePositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function taskErrorCode(error, fallback = "provider_error") {
  const code = String(error?.code ?? fallback);
  return SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function taskErrorMessage(code) {
  const messages = {
    cancelled: "task cancelled",
    provider_timeout: "provider execution timed out",
    provider_unavailable: "provider unavailable",
    rate_limited: "provider rate limited",
    temporary_failure: "provider temporary failure",
    network_error: "provider network error",
    invalid_result: "provider returned an invalid result",
    lease_expired: "task lease expired before completion",
    configuration_error: "AI execution configuration unavailable",
    provider_error: "provider execution failed",
  };
  return messages[code] ?? "AI task execution failed";
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "audioSeconds", "imagePages"];
  if (!fields.some((field) => Object.hasOwn(usage, field))) return null;
  const normalized = {};
  for (const field of fields) {
    const value = Number(usage[field] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) return null;
    normalized[field] = value;
  }
  return normalized;
}

function executionLimits(agentVersion, config) {
  const limits = parseObject(agentVersion.limits_json, {});
  return {
    maxTokens: safePositiveInteger(limits.maxTokens, 1_000, 100_000),
    maxInputTokens: safePositiveInteger(limits.maxInputTokens, 0, 2_000_000),
    maxSteps: safePositiveInteger(limits.maxSteps, 8, 100),
    maxAttempts: safePositiveInteger(limits.maxAttempts, 2, 3),
    timeoutMs: Math.min(
      safePositiveInteger(limits.timeoutMs, config.taskLeaseMs, 10 * 60_000),
      config.taskTimeoutMaxMs ?? 10 * 60_000,
    ),
  };
}

function standardDigest(db, standardIds) {
  const ids = [...new Set(standardIds.map(String))].sort();
  const versions = ids.map((standardId) => {
    const row = db.prepare(`
      SELECT sv.id, sv.standard_id, sv.version, sv.content, sv.rules_json
        FROM standard_versions sv
       WHERE sv.id = $id
    `).get({ $id: standardId });
    if (!row) {
      throw new AiPlatformError("AI standard configuration unavailable", {
        code: "configuration_error",
        status: 503,
      });
    }
    return {
      id: row.id,
      standardId: row.standard_id,
      version: row.version,
      content: row.content,
      rules: parseObject(row.rules_json, {}),
    };
  });
  return sha256(versions);
}

function activeAgentForTask(db, taskType) {
  const rows = db.prepare(`
    SELECT av.*, a.slug, a.name, a.description, a.lifecycle AS agent_lifecycle,
           ar.id AS release_id, ar.published_at
      FROM agent_versions av
      JOIN agents a ON a.id = av.agent_id
      JOIN agent_releases ar ON ar.agent_version_id = av.id
                           AND ar.agent_id = av.agent_id
                           AND ar.status = 'active'
     WHERE a.lifecycle = 'active'
     ORDER BY ar.published_at DESC, av.created_at DESC, av.id ASC
  `).all();
  for (const row of rows) {
    const taskTypes = parseArray(row.task_types_json);
    if (taskTypes.includes(taskType)) return row;
  }
  throw new AiPlatformError("no active Agent is registered for this task type", {
    code: "agent_not_configured",
    status: 503,
  });
}

function agentVersionById(db, agentVersionId) {
  const row = db.prepare(`
    SELECT av.*, a.slug, a.name, a.description, a.lifecycle AS agent_lifecycle
      FROM agent_versions av
      JOIN agents a ON a.id = av.agent_id
     WHERE av.id = $id
  `).get({ $id: agentVersionId });
  if (!row) {
    throw new AiPlatformError("AI Agent version unavailable", { code: "configuration_error", status: 503 });
  }
  return row;
}

function modelAndProvider(db, modelId) {
  const row = db.prepare(`
    SELECT m.*, p.name AS provider_name, p.kind AS provider_kind,
           p.enabled AS provider_enabled, p.config_json AS provider_config_json
      FROM models m
      JOIN providers p ON p.id = m.provider_id
     WHERE m.id = $id
  `).get({ $id: modelId });
  if (!row) {
    throw new AiPlatformError("AI model unavailable", { code: "configuration_error", status: 503 });
  }
  return row;
}

function activePrice(db, modelId, at) {
  return db.prepare(`
    SELECT *
      FROM price_versions
     WHERE model_id = $modelId
       AND effective_from <= $at
       AND (effective_to IS NULL OR effective_to > $at)
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT 1
  `).get({ $modelId: modelId, $at: at }) ?? null;
}

function resolveExecutionConfiguration(db, { taskType, at, config }) {
  const agentVersion = activeAgentForTask(db, taskType);
  const modelPolicy = parseObject(agentVersion.model_policy_json, {});
  const modelId = String(modelPolicy.modelId ?? "").trim();
  if (!modelId) {
    throw new AiPlatformError("AI Agent has no model policy", { code: "configuration_error", status: 503 });
  }
  const model = modelAndProvider(db, modelId);
  if (!Number(model.enabled) || !Number(model.provider_enabled)) {
    throw new AiPlatformError("AI model or provider is disabled", { code: "provider_disabled", status: 503 });
  }
  const externalModel = model.provider_kind !== "mock";
  if (!externalModel && config.nodeEnv === "production" && config.executionMode === "external-provider") {
    throw new AiPlatformError("simulation is not permitted for production tasks", { code: "provider_policy_blocked", status: 503 });
  }
  if (externalModel && config.executionMode !== "external-provider") {
    throw new AiPlatformError("external AI execution is disabled by execution mode", {
      code: "provider_policy_blocked",
      status: 503,
    });
  }
  if (externalModel && !config.externalProvidersEnabled) {
    throw new AiPlatformError("external AI providers are disabled", {
      code: "provider_policy_blocked",
      status: 503,
    });
  }
  if (externalModel && modelPolicy.externalAllowed !== true) {
    throw new AiPlatformError("Agent policy does not allow external AI execution", {
      code: "provider_policy_blocked",
      status: 503,
    });
  }
  const price = activePrice(db, model.id, at);
  if (!price && model.provider_kind !== "mock") {
    throw new AiPlatformError("AI model price is not configured", { code: "price_not_configured", status: 503 });
  }
  const standardIds = parseArray(agentVersion.standard_ids_json);
  return {
    agentVersion,
    model,
    price,
    standardIds,
    standardDigest: standardDigest(db, standardIds),
    limits: executionLimits(agentVersion, config),
  };
}

function taskView(row) {
  return {
    id: row.id,
    owner: row.owner,
    requestId: row.request_id,
    taskType: row.task_type,
    feature: row.feature,
    channel: row.channel,
    priority: row.priority,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    input: parseObject(row.input_json, {}),
    evidenceDigest: row.evidence_digest,
  };
}

function agentView(row) {
  return {
    id: row.agent_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    versionId: row.id,
    version: row.version,
    taskTypes: parseArray(row.task_types_json),
    systemPrompt: row.system_prompt,
    instructions: parseObject(row.instructions_json, {}),
    tools: parseArray(row.tools_json),
    modelPolicy: parseObject(row.model_policy_json, {}),
    limits: parseObject(row.limits_json, {}),
  };
}

function modelView(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerKind: row.provider_kind,
    name: row.name,
    capabilities: parseObject(row.capabilities_json, {}),
    enabled: Boolean(Number(row.enabled)),
  };
}

function emitEvent(db, taskId, eventType, payload, at) {
  db.prepare(`
    INSERT INTO task_events (task_id, event_type, payload_json, created_at)
    VALUES ($taskId, $eventType, $payload, $createdAt)
  `).run({
    $taskId: taskId,
    $eventType: eventType,
    $payload: stringify(payload, "{}"),
    $createdAt: at,
  });
}

function rowById(db, taskId) {
  return db.prepare("SELECT * FROM tasks WHERE id = $id").get({ $id: taskId }) ?? null;
}

function assertTaskAccess(row, identity) {
  if (!row) throw new AiPlatformError("task not found", { code: "not_found", status: 404 });
  if (!identity.isAdmin && row.owner !== identity.owner) {
    throw new AiPlatformError("task not found", { code: "not_found", status: 404 });
  }
}

function chargeForUsage(usage, price) {
  if (!usage || !price) {
    return {
      costMicro: 0,
      functionFeeMicro: 0,
      totalMicro: 0,
      costStatus: "unknown",
      feeStatus: "not_configured",
    };
  }
  const cost = calculateCostMicro(usage, price);
  const functionFeeMicro = Math.max(0, Number(price.function_fee_micro ?? 0));
  return {
    costMicro: cost.costMicro,
    functionFeeMicro,
    totalMicro: cost.costMicro + functionFeeMicro,
    costStatus: cost.costStatus,
    feeStatus: functionFeeMicro > 0 ? "calculated" : "not_configured",
  };
}

function estimatedCharge(input, limits, price) {
  const usage = estimateUsage({ input, maxTokens: limits.maxTokens });
  const media = input?.input?.media;
  if (media && media.mediaType !== "audio/wav") {
    usage.inputTokens = Math.max(usage.inputTokens, limits.maxInputTokens);
    if (media.mediaType === "application/pdf") usage.imagePages = 4;
  } else if (media?.mediaType === "audio/wav") {
    usage.inputTokens = 0;
    usage.outputTokens = 0;
  }
  const charge = chargeForUsage(usage, price);
  return { usage, charge };
}

function terminalResult(row) {
  return {
    task: publicTaskShape(row),
    result: parseJson(row.output_json, null),
  };
}

function sumTaskCharges(db, taskId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_micro + function_fee_micro), 0) AS total_micro,
           COALESCE(SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count
      FROM usage_ledger
     WHERE task_id = $taskId
  `).get({ $taskId: taskId });
  const reservation = db.prepare(`
    SELECT COALESCE(MAX(reserved_micro), 0) AS reserved_micro
      FROM budget_reservations
     WHERE task_id = $taskId
  `).get({ $taskId: taskId });
  const totalMicro = Number(row?.total_micro ?? 0);
  const reservedMicro = Number(reservation?.reserved_micro ?? 0);
  return {
    totalMicro,
    reservedMicro,
    unknown: Number(row?.unknown_count ?? 0) > 0,
    unknownBudgetMicro: Math.max(totalMicro, reservedMicro),
  };
}

function insertUsageLedger(db, {
  task,
  attempt,
  usage,
  charge,
  costStatus = charge.costStatus,
  at,
}) {
  const providerId = attempt.provider_id ?? attempt.providerId;
  const modelId = attempt.model_id ?? attempt.modelId;
  const priceVersionId = attempt.price_version_id ?? attempt.priceVersionId ?? null;
  db.prepare(`
    INSERT INTO usage_ledger (
      task_id, attempt_id, owner, feature, task_type, agent_version_id,
      provider_id, model_id, price_version_id, usage_json, cost_micro,
      cost_status, currency, function_fee_micro, fee_status, occurred_at
    ) VALUES (
      $taskId, $attemptId, $owner, $feature, $taskType, $agentVersionId,
      $providerId, $modelId, $priceVersionId, $usageJson, $costMicro,
      $costStatus, $currency, $functionFeeMicro, $feeStatus, $occurredAt
    )
  `).run({
    $taskId: task.id,
    $attemptId: attempt.id,
    $owner: task.owner,
    $feature: task.feature,
    $taskType: task.task_type,
    $agentVersionId: task.agent_version_id,
    $providerId: providerId,
    $modelId: modelId,
    $priceVersionId: priceVersionId,
    $usageJson: stringify(usage ?? {}, "{}"),
    $costMicro: Math.max(0, Math.floor(charge.costMicro ?? 0)),
    $costStatus: costStatus,
    $currency: attempt.currency ?? "USD",
    $functionFeeMicro: Math.max(0, Math.floor(charge.functionFeeMicro ?? 0)),
    $feeStatus: charge.feeStatus ?? "not_configured",
    $occurredAt: at,
  });
}

function markAttemptUnknown(db, task, attempt, at, code = "lease_expired") {
  db.prepare(`
    UPDATE task_attempts
       SET status = 'unknown', cost_status = 'unknown',
           error_code = $errorCode, error_message = $errorMessage,
           completed_at = $completedAt
     WHERE id = $id AND status = 'running'
  `).run({
    $id: attempt.id,
    $errorCode: code,
    $errorMessage: taskErrorMessage(code),
    $completedAt: at,
  });
  insertUsageLedger(db, {
    task,
    attempt,
    usage: {},
    charge: { costMicro: 0, functionFeeMicro: 0, feeStatus: "not_configured" },
    costStatus: "unknown",
    at,
  });
}

function shouldRetry(error, attemptNo, limits, { providerStarted = true } = {}) {
  if (!providerStarted || attemptNo >= limits.maxAttempts) return false;
  const code = taskErrorCode(error);
  return error?.retryable === true || RETRYABLE_CODES.has(code);
}

export function createTaskService({
  db,
  config,
  providerRegistry,
  mediaStore = null,
  clock = () => new Date(),
  logger = console,
} = {}) {
  if (!db || !config || !providerRegistry) throw new TypeError("db, config and providerRegistry are required");
  const activeExecutions = new Map();
  let pumpTimer = null;
  let pumpPromise = null;
  let runPromise = null;
  let closed = false;
  let paused = config.taskAdmissionEnabled === false;

  function now() {
    return iso(clock);
  }

  function createTask({ identity, idempotencyKey, request = {} } = {}) {
    const auth = normalizedIdentity(identity);
    const key = normalizeIdempotencyKey(idempotencyKey);
    const normalized = normalizeTaskCreate(request);
    const mediaRef = normalized.input.mediaRef;
    const hashedInput = { ...normalized.input };
    if (mediaRef !== undefined) delete hashedInput.mediaRef;
    const requestHash = sha256({ issuer: auth.issuer, owner: auth.owner, task: { ...normalized, input: hashedInput } });
    const requestedAt = now();
    const existing = db.prepare(`
      SELECT * FROM tasks
       WHERE issuer = $issuer AND owner = $owner AND idempotency_key = $key
    `).get({ $issuer: auth.issuer, $owner: auth.owner, $key: key });
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AiPlatformError("idempotency key conflicts with a different request", {
          code: "idempotency_conflict",
          status: 409,
        });
      }
      return {
        requestId: existing.request_id,
        taskId: existing.id,
        status: existing.status,
        replayed: true,
        agentVersion: existing.agent_version_id,
        model: existing.model_id,
        standardDigest: existing.standard_digest,
      };
    }

    if (paused || closed || readOperationalControl(db).paused) {
      throw new AiPlatformError("AI platform is draining", { code: "service_draining", status: 503 });
    }
    const execution = resolveExecutionConfiguration(db, {
      taskType: normalized.taskType,
      at: requestedAt,
      config,
    });
    if (normalized.input.media && execution.model.provider_kind === "vision" && execution.limits.maxInputTokens < 1) {
      throw new AiPlatformError("vision input budget is not configured", { code: "budget_not_configured", status: 503 });
    }
    const estimate = estimatedCharge({
      input: normalized.input,
      systemPrompt: execution.agentVersion.system_prompt,
      instructions: execution.agentVersion.instructions_json,
    }, execution.limits, execution.price);
    // One task owns one budget reservation across its bounded retry window.
    // Reserve the per-attempt upper bound up front so a retry cannot bypass
    // an amount limit; each provider attempt remains separately ledgered.
    const reservedCostMicro = Math.max(0, Math.floor(
      estimate.charge.totalMicro * execution.limits.maxAttempts,
    ));
    const taskId = id("task");
    const requestId = id("request");
    const inputJson = stableJson(normalized.input);
    const subjectType = normalized.subject?.type ?? null;
    const subjectId = normalized.subject?.id ?? null;
    const result = withImmediateTransaction(db, () => {
      const race = db.prepare(`
        SELECT * FROM tasks
         WHERE issuer = $issuer AND owner = $owner AND idempotency_key = $key
      `).get({ $issuer: auth.issuer, $owner: auth.owner, $key: key });
      if (race) {
        if (race.request_hash !== requestHash) {
          throw new AiPlatformError("idempotency key conflicts with a different request", {
            code: "idempotency_conflict",
            status: 409,
          });
        }
        return {
          requestId: race.request_id,
          taskId: race.id,
          status: race.status,
          replayed: true,
          agentVersion: race.agent_version_id,
          model: race.model_id,
          standardDigest: race.standard_digest,
        };
      }
      if (readOperationalControl(db).paused) {
        throw new AiPlatformError("AI platform is draining", { code: "service_draining", status: 503 });
      }
      const queuedCount = db.prepare(`
        SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'
      `).get();
      if (Number(queuedCount?.count ?? 0) >= config.taskQueueLimit) {
        throw new AiPlatformError("AI task queue is full", { code: "queue_full", status: 429 });
      }
      db.prepare(`
        INSERT INTO tasks (
          id, request_id, issuer, owner, actor, channel, feature, task_type,
          subject_type, subject_id, priority, input_json, evidence_digest,
          request_hash, idempotency_key, agent_version_id, model_id,
          standard_digest, status, source, requested_at, updated_at
        ) VALUES (
          $id, $requestId, $issuer, $owner, $actor, $channel, $feature, $taskType,
          $subjectType, $subjectId, $priority, $inputJson, $evidenceDigest,
          $requestHash, $idempotencyKey, $agentVersionId, $modelId,
          $standardDigest, 'queued', 'model', $requestedAt, $updatedAt
        )
      `).run({
        $id: taskId,
        $requestId: requestId,
        $issuer: auth.issuer,
        $owner: auth.owner,
        $actor: auth.actor,
        $channel: normalized.channel,
        $feature: normalized.feature,
        $taskType: normalized.taskType,
        $subjectType: subjectType,
        $subjectId: subjectId,
        $priority: normalized.priority,
        $inputJson: inputJson,
        $evidenceDigest: normalized.evidenceDigest,
        $requestHash: requestHash,
        $idempotencyKey: key,
        $agentVersionId: execution.agentVersion.id,
        $modelId: execution.model.id,
        $standardDigest: execution.standardDigest,
        $requestedAt: requestedAt,
        $updatedAt: requestedAt,
      });
      if (mediaRef !== undefined) {
        if (!mediaStore) throw new AiPlatformError("media storage unavailable", { code: "media_unavailable", status: 503 });
        mediaStore.bind({ id: mediaRef, owner: auth.owner, taskId, descriptor: normalized.input.media });
      }
      reserveBudget(db, {
        taskId,
        owner: auth.owner,
        feature: normalized.feature,
        agentId: execution.agentVersion.agent_id,
        estimatedCostMicro: reservedCostMicro,
        currency: execution.price?.currency ?? null,
        requirePolicy: execution.model.provider_kind !== "mock",
        at: new Date(requestedAt),
      });
      emitEvent(db, taskId, "task.created", {
        requestId,
        taskType: normalized.taskType,
        feature: normalized.feature,
        agentVersionId: execution.agentVersion.id,
        modelId: execution.model.id,
        estimatedCostMicro: reservedCostMicro,
        estimatedAttemptCostMicro: estimate.charge.totalMicro,
        maxAttempts: execution.limits.maxAttempts,
      }, requestedAt);
      return {
        requestId,
        taskId,
        status: "queued",
        replayed: false,
        agentVersion: execution.agentVersion.id,
        model: execution.model.id,
        standardDigest: execution.standardDigest,
      };
    });
    return result;
  }

  function readTask({ identity, taskId } = {}) {
    const auth = normalizedIdentity(identity);
    const row = rowById(db, String(taskId ?? ""));
    assertTaskAccess(row, auth);
    return publicTaskShape(row);
  }

  function readTaskResult({ identity, taskId } = {}) {
    const auth = normalizedIdentity(identity);
    const row = rowById(db, String(taskId ?? ""));
    assertTaskAccess(row, auth);
    if (!TERMINAL_STATUSES.has(row.status)) {
      throw new AiPlatformError("task result is not ready", { code: "result_not_ready", status: 409 });
    }
    return terminalResult(row);
  }

  function readTaskEvents({ identity, taskId, limit = 100 } = {}) {
    const auth = normalizedIdentity(identity);
    const row = rowById(db, String(taskId ?? ""));
    assertTaskAccess(row, auth);
    let safe;
    try { safe = safeLimit(limit, 100, 200); } catch { throw new AiPlatformError("limit is invalid", { code: "invalid_request", status: 400 }); }
    return db.prepare(`
      SELECT id, task_id AS taskId, event_type AS eventType, payload_json AS payload, created_at AS createdAt
        FROM task_events
       WHERE task_id = $taskId
       ORDER BY id ASC
       LIMIT $limit
    `).all({ $taskId: row.id, $limit: safe }).map((event) => ({
      ...event,
      payload: parseObject(event.payload, {}),
    }));
  }

  function listTasks({ identity, owner = null, status = null, feature = null, limit = 50, offset = 0 } = {}) {
    const auth = normalizedIdentity(identity);
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
    if (!auth.isAdmin) {
      clauses.push("t.owner = $owner");
      params.$owner = auth.owner;
    } else if (owner) {
      clauses.push("t.owner = $owner");
      params.$owner = String(owner);
    }
    if (status) {
      if (!AI_TASK_STATUSES.includes(status)) throw new AiPlatformError("status is invalid", { code: "invalid_request", status: 400 });
      clauses.push("t.status = $status");
      params.$status = status;
    }
    if (feature) {
      clauses.push("t.feature = $feature");
      params.$feature = String(feature);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT t.*
        FROM tasks t
        ${where}
       ORDER BY ${PRIORITY_ORDER}, t.requested_at DESC
       LIMIT $limit OFFSET $offset
    `).all(params);
    return rows.map(publicTaskShape);
  }

  function claimTask({ taskId = null } = {}) {
    const claimedAt = now();
    const leaseToken = id("lease");
    const leaseExpiresAt = new Date(new Date(claimedAt).getTime() + config.taskLeaseMs).toISOString();
    return withImmediateTransaction(db, () => {
      if (readOperationalControl(db).paused) return null;
      const where = taskId ? "t.id = $taskId AND t.status = 'queued'" : "t.status = 'queued'";
      const selected = db.prepare(`
        SELECT t.*, av.limits_json, av.system_prompt, av.instructions_json,
               av.tools_json, av.task_types_json, av.model_policy_json,
               a.slug, a.name, a.description,
               m.provider_id, m.name AS model_name, m.capabilities_json,
               p.name AS provider_name,
               p.kind AS provider_kind, p.enabled AS provider_enabled,
               m.enabled AS model_enabled, pr.id AS price_version_id,
               pr.version AS price_version, pr.currency,
               pc.policy_json AS pricing_policy_json, pr.input_micro_per_1k, pr.output_micro_per_1k,
               pr.cached_input_micro_per_1k, pr.audio_micro_per_minute,
               pr.image_micro_per_page, pr.function_fee_micro,
               pr.effective_from AS price_effective_from,
               pr.effective_to AS price_effective_to
          FROM tasks t
          JOIN agent_versions av ON av.id = t.agent_version_id
          JOIN agents a ON a.id = av.agent_id
          JOIN models m ON m.id = t.model_id
          JOIN providers p ON p.id = m.provider_id
          LEFT JOIN price_versions pr
            ON pr.id = (
              SELECT pv.id FROM price_versions pv
               WHERE pv.model_id = t.model_id
                 AND pv.effective_from <= t.requested_at
                 AND (pv.effective_to IS NULL OR pv.effective_to > t.requested_at)
               ORDER BY pv.effective_from DESC, pv.created_at DESC, pv.id DESC
               LIMIT 1
            )
          LEFT JOIN price_calendars pc ON pc.price_version_id = pr.id
         WHERE ${where}
           AND (
             SELECT COUNT(*) FROM tasks running
              WHERE running.owner = t.owner AND running.status = 'running'
           ) < $ownerConcurrency
         ORDER BY ${PRIORITY_ORDER}, t.requested_at ASC
         LIMIT 1
      `).get(taskId ? { $taskId: taskId, $ownerConcurrency: config.taskOwnerConcurrency } : { $ownerConcurrency: config.taskOwnerConcurrency });
      if (!selected) return null;
      const attemptNo = Number(selected.current_attempt ?? 0) + 1;
      const attemptId = id("attempt");
      db.prepare(`
        UPDATE tasks
           SET status = 'running', current_attempt = $attemptNo,
               lease_token = $leaseToken, lease_expires_at = $leaseExpiresAt,
               started_at = COALESCE(started_at, $startedAt), updated_at = $updatedAt
         WHERE id = $taskId AND status = 'queued'
      `).run({
        $taskId: selected.id,
        $attemptNo: attemptNo,
        $leaseToken: leaseToken,
        $leaseExpiresAt: leaseExpiresAt,
        $startedAt: claimedAt,
        $updatedAt: claimedAt,
      });
      db.prepare(`
        INSERT INTO task_attempts (
          id, task_id, attempt_no, provider_id, model_id, status, lease_token,
          request_meta_json, response_meta_json, cost_micro, cost_status,
          price_version_id, started_at
        ) VALUES (
          $id, $taskId, $attemptNo, $providerId, $modelId, 'running', $leaseToken,
          $requestMeta, '{}', 0, 'not_applicable', $priceVersionId, $startedAt
        )
      `).run({
        $id: attemptId,
        $taskId: selected.id,
        $attemptNo: attemptNo,
        $providerId: selected.provider_id,
        $modelId: selected.model_id,
        $leaseToken: leaseToken,
        $requestMeta: stringify({ channel: selected.channel, feature: selected.feature }, "{}"),
        $priceVersionId: selected.price_version_id ?? null,
        $startedAt: claimedAt,
      });
      // A reservation is task-scoped. The first attempt keeps the trace link;
      // later attempts retain the same reservation so retries cannot bypass it.
      db.prepare(`
        UPDATE budget_reservations
           SET attempt_id = $attemptId
         WHERE task_id = $taskId AND attempt_id IS NULL AND status = 'reserved'
      `).run({ $taskId: selected.id, $attemptId: attemptId });
      emitEvent(db, selected.id, "task.claimed", {
        attemptId,
        attemptNo,
        leaseExpiresAt,
      }, claimedAt);
      const attemptPrice = selected.price_version_id ? priceAtAttempt({
        id: selected.price_version_id, version: selected.price_version, currency: selected.currency,
        input_micro_per_1k: selected.input_micro_per_1k, output_micro_per_1k: selected.output_micro_per_1k,
        cached_input_micro_per_1k: selected.cached_input_micro_per_1k, audio_micro_per_minute: selected.audio_micro_per_minute,
        image_micro_per_page: selected.image_micro_per_page, function_fee_micro: selected.function_fee_micro,
        pricing_policy_json: selected.pricing_policy_json,
      }, claimedAt) : null;
      if (attemptPrice?.pricingTier) {
        db.prepare("UPDATE task_attempts SET request_meta_json = ? WHERE id = ?").run(
          stringify({ channel: selected.channel, feature: selected.feature, pricingTier: attemptPrice.pricingTier, pricingAt: claimedAt }),
          attemptId,
        );
      }
      return {
        task: selected,
        attempt: {
          id: attemptId,
          attemptNo,
          leaseToken,
          priceVersionId: selected.price_version_id,
          currency: selected.currency ?? "USD",
          providerId: selected.provider_id,
          modelId: selected.model_id,
        },
        agent: agentView({ ...selected, id: selected.agent_version_id, agent_id: selected.agent_id }),
        model: {
          id: selected.model_id,
          providerId: selected.provider_id,
          providerName: selected.provider_name,
          name: selected.model_name,
          providerKind: selected.provider_kind,
          capabilities: parseObject(selected.capabilities_json, {}),
        },
        priceVersion: selected.price_version_id ? {
          id: selected.price_version_id,
          version: selected.price_version,
          currency: selected.currency,
          input_micro_per_1k: selected.input_micro_per_1k,
          output_micro_per_1k: selected.output_micro_per_1k,
          cached_input_micro_per_1k: selected.cached_input_micro_per_1k,
          audio_micro_per_minute: selected.audio_micro_per_minute,
          image_micro_per_page: selected.image_micro_per_page,
          function_fee_micro: selected.function_fee_micro,
          effective_from: selected.price_effective_from,
          effective_to: selected.price_effective_to,
          ...attemptPrice,
        } : null,
        limits: executionLimits(selected, config),
      };
    });
  }

  function renewLease(taskId, leaseToken) {
    const renewedAt = now();
    const leaseExpiresAt = new Date(new Date(renewedAt).getTime() + config.taskLeaseMs).toISOString();
    const result = db.prepare(`
      UPDATE tasks SET lease_expires_at = $leaseExpiresAt, updated_at = $updatedAt
       WHERE id = $taskId AND status = 'running' AND lease_token = $leaseToken
    `).run({ $taskId: taskId, $leaseToken: leaseToken, $leaseExpiresAt: leaseExpiresAt, $updatedAt: renewedAt });
    return Number(result.changes ?? 0) === 1;
  }

  function cancelTask({ identity, taskId } = {}) {
    const auth = normalizedIdentity(identity);
    const idValue = String(taskId ?? "");
    const requestedAt = now();
    const result = withImmediateTransaction(db, () => {
      const row = rowById(db, idValue);
      assertTaskAccess(row, auth);
      if (TERMINAL_STATUSES.has(row.status)) return publicTaskShape(row);
      if (row.status === "queued") {
        db.prepare(`
          UPDATE tasks
             SET status = 'cancelled', cancel_requested_at = $at,
                 completed_at = $at, updated_at = $at,
                 error_code = 'cancelled', error_message = 'task cancelled'
           WHERE id = $taskId AND status = 'queued'
        `).run({ $taskId: idValue, $at: requestedAt });
        releaseBudget(db, { taskId: idValue, at: new Date(requestedAt) });
        emitEvent(db, idValue, "task.cancelled", { phase: "queued" }, requestedAt);
      } else if (row.status === "running") {
        db.prepare(`
          UPDATE tasks SET cancel_requested_at = COALESCE(cancel_requested_at, $at), updated_at = $at
           WHERE id = $taskId AND status = 'running'
        `).run({ $taskId: idValue, $at: requestedAt });
        emitEvent(db, idValue, "task.cancel_requested", { phase: "running" }, requestedAt);
      }
      return publicTaskShape(rowById(db, idValue));
    });
    const execution = activeExecutions.get(idValue);
    if (execution) execution.controller.abort();
    return result;
  }

  function cancellationRequested(taskId) {
    const row = db.prepare("SELECT cancel_requested_at FROM tasks WHERE id = $id").get({ $id: taskId });
    return Boolean(row?.cancel_requested_at);
  }

  function finalizeSuccess(context, providerResponse) {
    const completedAt = now();
    const usage = normalizeUsage(providerResponse?.usage);
    const result = normalizeTaskResult(providerResponse?.result ?? providerResponse);
    const charge = chargeForUsage(usage, context.priceVersion);
    if (usage && providerResponse?.usageStatus === "estimated") charge.costStatus = "estimated";
    return withImmediateTransaction(db, () => {
      const current = rowById(db, context.task.id);
      if (!current || current.status !== "running" || current.lease_token !== context.attempt.leaseToken) {
        return { stale: true, task: current ? publicTaskShape(current) : null };
      }
      if (cancellationRequested(context.task.id)) {
        const attempt = db.prepare("SELECT * FROM task_attempts WHERE id = $id").get({ $id: context.attempt.id });
        const cancelledCharge = usage ? charge : { costMicro: 0, functionFeeMicro: 0, feeStatus: "not_configured" };
        db.prepare(`
          UPDATE task_attempts
             SET status = 'cancelled', response_meta_json = $responseMeta,
                 input_tokens = $inputTokens, output_tokens = $outputTokens,
                 cached_input_tokens = $cachedInputTokens, audio_seconds = $audioSeconds,
                 image_pages = $imagePages, cost_micro = $costMicro,
                 cost_status = $costStatus, external_request_id = $externalRequestId,
                 error_code = 'cancelled', error_message = 'task cancelled', completed_at = $completedAt
           WHERE id = $id
        `).run({
          $id: context.attempt.id,
          $responseMeta: stringify({ cancelledAfterProviderResponse: true }, "{}"),
          $inputTokens: usage?.inputTokens ?? 0,
          $outputTokens: usage?.outputTokens ?? 0,
          $cachedInputTokens: usage?.cachedInputTokens ?? 0,
          $audioSeconds: usage?.audioSeconds ?? 0,
          $imagePages: usage?.imagePages ?? 0,
          $costMicro: cancelledCharge.costMicro,
          $costStatus: usage ? cancelledCharge.costStatus : "unknown",
          $externalRequestId: providerResponse?.externalRequestId ?? null,
          $completedAt: completedAt,
        });
        insertUsageLedger(db, {
          task: current,
          attempt: { ...attempt, currency: context.attempt.currency },
          usage: usage ?? {},
          charge: cancelledCharge,
          costStatus: usage ? cancelledCharge.costStatus : "unknown",
          at: completedAt,
        });
        db.prepare(`
          UPDATE tasks
             SET status = 'cancelled', source = $source,
                 error_code = 'cancelled', error_message = 'task cancelled',
                 completed_at = $completedAt, lease_token = NULL, lease_expires_at = NULL,
                 updated_at = $updatedAt
           WHERE id = $taskId AND status = 'running' AND lease_token = $leaseToken
        `).run({
          $source: result.source,
          $completedAt: completedAt,
          $updatedAt: completedAt,
          $taskId: current.id,
          $leaseToken: context.attempt.leaseToken,
        });
        const total = sumTaskCharges(db, current.id);
        settleBudget(db, {
          taskId: current.id,
          actualCostMicro: total.unknown ? total.unknownBudgetMicro : total.totalMicro,
          unknown: true,
          at: new Date(completedAt),
        });
        emitEvent(db, current.id, "task.cancelled", { phase: "running", attemptId: context.attempt.id }, completedAt);
        return { stale: false, task: publicTaskShape(rowById(db, current.id)) };
      }
      const attempt = db.prepare("SELECT * FROM task_attempts WHERE id = $id").get({ $id: context.attempt.id });
      db.prepare(`
        UPDATE task_attempts
           SET status = 'succeeded', response_meta_json = $responseMeta,
               input_tokens = $inputTokens, output_tokens = $outputTokens,
               cached_input_tokens = $cachedInputTokens, audio_seconds = $audioSeconds,
               image_pages = $imagePages, cost_micro = $costMicro,
               cost_status = $costStatus, external_request_id = $externalRequestId,
               completed_at = $completedAt
         WHERE id = $id AND status = 'running'
      `).run({
        $id: context.attempt.id,
        $responseMeta: stringify({ source: result.source }, "{}"),
        $inputTokens: usage?.inputTokens ?? 0,
        $outputTokens: usage?.outputTokens ?? 0,
        $cachedInputTokens: usage?.cachedInputTokens ?? 0,
        $audioSeconds: usage?.audioSeconds ?? 0,
        $imagePages: usage?.imagePages ?? 0,
        $costMicro: charge.costMicro,
        $costStatus: charge.costStatus,
        $externalRequestId: providerResponse?.externalRequestId ?? null,
        $completedAt: completedAt,
      });
      insertUsageLedger(db, {
        task: current,
        attempt: { ...attempt, currency: context.attempt.currency },
        usage: usage ?? {},
        charge,
        costStatus: usage ? charge.costStatus : "unknown",
        at: completedAt,
      });
      db.prepare(`
        UPDATE tasks
           SET status = 'succeeded', source = $source, output_json = $outputJson,
               output_digest = $outputDigest, error_code = NULL, error_message = NULL,
               completed_at = $completedAt, lease_token = NULL, lease_expires_at = NULL,
               updated_at = $updatedAt
         WHERE id = $taskId AND status = 'running' AND lease_token = $leaseToken
      `).run({
        $source: result.source,
        $outputJson: stableJson(result),
        $outputDigest: sha256(result),
        $completedAt: completedAt,
        $updatedAt: completedAt,
        $taskId: current.id,
        $leaseToken: context.attempt.leaseToken,
      });
      const total = sumTaskCharges(db, current.id);
      settleBudget(db, {
        taskId: current.id,
        actualCostMicro: total.unknown ? total.unknownBudgetMicro : total.totalMicro,
        unknown: total.unknown,
        at: new Date(completedAt),
      });
      emitEvent(db, current.id, "task.succeeded", {
        attemptId: context.attempt.id,
        source: result.source,
        costMicro: charge.costMicro,
        costStatus: usage ? charge.costStatus : "unknown",
      }, completedAt);
      return { stale: false, task: publicTaskShape(rowById(db, current.id)) };
    });
  }

  function finalizeFailure(context, error, { providerStarted = true, timedOut = false } = {}) {
    const completedAt = now();
    const code = timedOut ? "provider_timeout" : taskErrorCode(error);
    const usage = normalizeUsage(error?.usage);
    const charge = usage ? chargeForUsage(usage, context.priceVersion) : {
      costMicro: 0,
      functionFeeMicro: 0,
      totalMicro: 0,
      costStatus: providerStarted ? "unknown" : "not_applicable",
      feeStatus: "not_configured",
    };
    return withImmediateTransaction(db, () => {
      const current = rowById(db, context.task.id);
      if (!current || current.status !== "running" || current.lease_token !== context.attempt.leaseToken) {
        return { stale: true, task: current ? publicTaskShape(current) : null };
      }
      const attempt = db.prepare("SELECT * FROM task_attempts WHERE id = $id").get({ $id: context.attempt.id });
      const cancelled = code === "cancelled" || Boolean(current.cancel_requested_at);
      const unknown = providerStarted && !usage;
      db.prepare(`
        UPDATE task_attempts
           SET status = $status, response_meta_json = $responseMeta,
               input_tokens = $inputTokens, output_tokens = $outputTokens,
               cached_input_tokens = $cachedInputTokens, audio_seconds = $audioSeconds,
               image_pages = $imagePages, cost_micro = $costMicro,
               cost_status = $costStatus, external_request_id = $externalRequestId, error_code = $errorCode,
               error_message = $errorMessage, completed_at = $completedAt
         WHERE id = $id AND status = 'running'
      `).run({
        $id: context.attempt.id,
        $status: cancelled ? "cancelled" : "failed",
        $responseMeta: stringify({ providerStarted, timedOut }, "{}"),
        $inputTokens: usage?.inputTokens ?? 0,
        $outputTokens: usage?.outputTokens ?? 0,
        $cachedInputTokens: usage?.cachedInputTokens ?? 0,
        $audioSeconds: usage?.audioSeconds ?? 0,
        $imagePages: usage?.imagePages ?? 0,
        $costMicro: charge.costMicro,
        $costStatus: usage ? charge.costStatus : (unknown ? "unknown" : "not_applicable"),
        $externalRequestId: typeof error?.externalRequestId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(error.externalRequestId) ? error.externalRequestId : null,
        $errorCode: cancelled ? "cancelled" : code,
        $errorMessage: taskErrorMessage(cancelled ? "cancelled" : code),
        $completedAt: completedAt,
      });
      if (providerStarted || usage) {
        insertUsageLedger(db, {
          task: current,
          attempt: { ...attempt, currency: context.attempt.currency },
          usage: usage ?? {},
          charge,
          costStatus: usage ? charge.costStatus : (unknown ? "unknown" : "not_applicable"),
          at: completedAt,
        });
      }
      const retry = !cancelled
        && (!unknown || context.model.providerKind === "mock")
        && shouldRetry(error, context.attempt.attemptNo, context.limits, { providerStarted });
      if (retry) {
        db.prepare(`
          UPDATE tasks
             SET status = 'queued', error_code = $errorCode, error_message = $errorMessage,
                 lease_token = NULL, lease_expires_at = NULL, updated_at = $updatedAt
           WHERE id = $taskId AND status = 'running' AND lease_token = $leaseToken
        `).run({
          $errorCode: code,
          $errorMessage: taskErrorMessage(code),
          $updatedAt: completedAt,
          $taskId: current.id,
          $leaseToken: context.attempt.leaseToken,
        });
        emitEvent(db, current.id, "task.retry_scheduled", {
          attemptId: context.attempt.id,
          attemptNo: context.attempt.attemptNo,
          errorCode: code,
        }, completedAt);
        return { stale: false, retry: true, task: publicTaskShape(rowById(db, current.id)) };
      }
      const finalStatus = cancelled ? "cancelled" : (timedOut ? "expired" : "failed");
      db.prepare(`
        UPDATE tasks
           SET status = $status, error_code = $errorCode, error_message = $errorMessage,
               completed_at = $completedAt, lease_token = NULL, lease_expires_at = NULL,
               updated_at = $updatedAt
         WHERE id = $taskId AND status = 'running' AND lease_token = $leaseToken
      `).run({
        $status: finalStatus,
        $errorCode: cancelled ? "cancelled" : code,
        $errorMessage: taskErrorMessage(cancelled ? "cancelled" : code),
        $completedAt: completedAt,
        $updatedAt: completedAt,
        $taskId: current.id,
        $leaseToken: context.attempt.leaseToken,
      });
      const total = sumTaskCharges(db, current.id);
      if (!providerStarted && !usage) {
        releaseBudget(db, { taskId: current.id, at: new Date(completedAt) });
      } else {
        settleBudget(db, {
          taskId: current.id,
          actualCostMicro: total.unknown || unknown ? total.unknownBudgetMicro : total.totalMicro,
          unknown: total.unknown || unknown,
          at: new Date(completedAt),
        });
      }
      emitEvent(db, current.id, cancelled ? "task.cancelled" : "task.failed", {
        attemptId: context.attempt.id,
        errorCode: cancelled ? "cancelled" : code,
        costStatus: total.unknown || unknown ? "unknown" : charge.costStatus,
      }, completedAt);
      return { stale: false, retry: false, task: publicTaskShape(rowById(db, current.id)) };
    });
  }

  async function executeClaim(context) {
    const controller = new AbortController();
    let timeoutTriggered = false;
    let providerStarted = false;
    const timeout = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, context.limits.timeoutMs);
    const leaseHeartbeat = setInterval(() => {
      try {
        if (!renewLease(context.task.id, context.attempt.leaseToken)) controller.abort();
      } catch (error) {
        logger.warn?.("AI platform lease renewal failed", { taskId: context.task.id, error: error?.message });
        controller.abort();
      }
    }, Math.max(50, Math.floor(config.taskLeaseMs / 3)));
    leaseHeartbeat.unref?.();
    activeExecutions.set(context.task.id, { controller, leaseToken: context.attempt.leaseToken });
    try {
      const provider = providerRegistry.get(context.model.providerId);
      if (!provider) {
        const error = new Error("provider unavailable");
        error.code = "provider_unavailable";
        throw error;
      }
      const externalModel = context.model.providerKind !== "mock";
      if (
        externalModel
        && (
          config.executionMode !== "external-provider"
          || !config.externalProvidersEnabled
          || context.agent.modelPolicy?.externalAllowed !== true
        )
      ) {
        const error = new Error("external AI execution is blocked by policy");
        error.code = "provider_policy_blocked";
        throw error;
      }
      const providerInput = {
        task: taskView(context.task),
        agent: context.agent,
        limits: context.limits,
        mediaStore,
        model: modelView({
          id: context.model.id,
          provider_id: context.model.providerId,
          provider_name: context.model.providerName,
          provider_kind: context.model.providerKind,
          name: context.model.name,
          capabilities_json: JSON.stringify(context.model.capabilities),
          enabled: 1,
        }),
        signal: controller.signal,
      };
      const prepared = provider.prepare ? await provider.prepare(providerInput) : undefined;
      providerStarted = true;
      const response = await provider.execute({ ...providerInput, prepared });
      if (timeoutTriggered) {
        const error = new Error("provider execution timed out");
        error.code = "provider_timeout";
        error.usage = response?.usage;
        throw error;
      }
      if (controller.signal.aborted || cancellationRequested(context.task.id)) {
        const error = new Error("task cancelled");
        error.code = "cancelled";
        error.usage = response?.usage;
        throw error;
      }
      try {
        return finalizeSuccess(context, response);
      } catch (finalizeError) {
        if (!finalizeError.usage) finalizeError.usage = response?.usage;
        throw finalizeError;
      }
    } catch (error) {
      return finalizeFailure(context, error, { providerStarted, timedOut: timeoutTriggered });
    } finally {
      clearTimeout(timeout);
      clearInterval(leaseHeartbeat);
      activeExecutions.delete(context.task.id);
      try { mediaStore?.sweep(); } catch (error) {
        pause();
        throw error;
      }
    }
  }

  function recoverExpiredLeases({ limit = 100 } = {}) {
    let safe;
    try { safe = safeLimit(limit, 100, 500); } catch { throw new AiPlatformError("limit is invalid", { code: "invalid_request", status: 400 }); }
    const at = now();
    const stale = db.prepare(`
      SELECT t.*, ta.id AS attempt_id, ta.attempt_no, ta.provider_id, ta.model_id,
             ta.price_version_id, av.limits_json, p.kind AS provider_kind, pr.currency
        FROM tasks t
        JOIN task_attempts ta ON ta.task_id = t.id AND ta.attempt_no = t.current_attempt
        JOIN agent_versions av ON av.id = t.agent_version_id
        JOIN providers p ON p.id = ta.provider_id
        LEFT JOIN price_versions pr ON pr.id = ta.price_version_id
       WHERE t.status = 'running'
         AND t.lease_expires_at IS NOT NULL
         AND t.lease_expires_at < $at
       ORDER BY t.lease_expires_at ASC
       LIMIT $limit
    `).all({ $at: at, $limit: safe });
    const recovered = [];
    for (const staleTask of stale) {
      const outcome = withImmediateTransaction(db, () => {
        const current = rowById(db, staleTask.id);
        if (!current || current.status !== "running" || current.lease_expires_at >= at) return null;
        const attempt = {
          id: staleTask.attempt_id,
          attemptNo: Number(staleTask.attempt_no),
          providerId: staleTask.provider_id,
          modelId: staleTask.model_id,
          priceVersionId: staleTask.price_version_id,
          currency: staleTask.currency ?? "USD",
        };
        markAttemptUnknown(db, current, attempt, at);
        const limits = executionLimits(staleTask, config);
        const canRetry = staleTask.provider_kind === "mock"
          && !current.cancel_requested_at && attempt.attemptNo < limits.maxAttempts;
        if (canRetry) {
          db.prepare(`
            UPDATE tasks
               SET status = 'queued', error_code = NULL, error_message = NULL,
                   lease_token = NULL, lease_expires_at = NULL, updated_at = $at
             WHERE id = $taskId AND status = 'running'
          `).run({ $taskId: current.id, $at: at });
          emitEvent(db, current.id, "task.recovered", { attemptId: attempt.id, requeued: true }, at);
        } else {
          db.prepare(`
            UPDATE tasks
               SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
                   error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'lease_expired' END,
                   error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN 'task cancelled' ELSE 'task lease expired before completion' END,
                   completed_at = $at, lease_token = NULL, lease_expires_at = NULL, updated_at = $at
             WHERE id = $taskId AND status = 'running'
          `).run({ $taskId: current.id, $at: at });
          const total = sumTaskCharges(db, current.id);
          settleBudget(db, {
            taskId: current.id,
            actualCostMicro: total.unknownBudgetMicro,
            unknown: true,
            at: new Date(at),
          });
          emitEvent(db, current.id, current.cancel_requested_at ? "task.cancelled" : "task.expired", {
            attemptId: attempt.id,
            reason: "lease_expired",
          }, at);
        }
        return publicTaskShape(rowById(db, current.id));
      });
      activeExecutions.get(staleTask.id)?.controller.abort();
      if (outcome) recovered.push(outcome);
    }
    return recovered;
  }

  async function runPending({ limit = config.taskConcurrency } = {}) {
    if (runPromise) return runPromise;
    runPromise = (async () => {
      if (closed || paused) return { claimed: 0, completed: 0, results: [] };
      let safe;
      try { safe = safeLimit(limit, config.taskConcurrency, config.taskConcurrency); } catch { safe = config.taskConcurrency; }
      recoverExpiredLeases({ limit: safe });
      const contexts = [];
      for (let index = 0; index < safe; index += 1) {
        const context = claimTask();
        if (!context) break;
        contexts.push(context);
      }
      const results = await Promise.all(contexts.map((context) => executeClaim(context)));
      return { claimed: contexts.length, completed: results.length, results };
    })().finally(() => { runPromise = null; });
    return runPromise;
  }

  function start() {
    if (closed || pumpTimer) return;
    pumpTimer = setInterval(() => {
      if (pumpPromise) return;
      pumpPromise = runPending().catch((error) => {
        logger.error?.("AI platform task pump failed", error);
        return null;
      }).finally(() => { pumpPromise = null; });
    }, config.taskPollMs);
    pumpTimer.unref?.();
    void runPending();
  }

  async function waitForTask({ identity, taskId, waitMs = 0 } = {}) {
    const maxWait = Math.max(0, Math.min(Number(waitMs) || 0, 30_000));
    const started = Date.now();
    while (true) {
      const current = readTask({ identity, taskId });
      const remaining = maxWait - (Date.now() - started);
      if (TERMINAL_STATUSES.has(current.status) || remaining <= 0) return current;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }

  function pause() {
    paused = true;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
  }

  async function drain({ timeoutMs = config.drainTimeoutMs ?? 180_000, abort = false } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) {
      throw new TypeError("drain timeout is invalid");
    }
    pause();
    if (abort) {
      for (const execution of activeExecutions.values()) execution.controller.abort();
    }
    const pending = runPromise;
    if (!pending) return status();
    let timeout;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new AiPlatformError("AI platform drain timed out", {
            code: "drain_timeout",
            status: 503,
          })), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    return status();
  }

  function status() {
    const control = readOperationalControl(db);
    return {
      admissionOpen: !paused && !closed && !control.paused,
      paused: paused || control.paused,
      closed,
      activeExecutions: activeExecutions.size,
      generation: control.generation,
    };
  }

  function resume() {
    if (closed || readOperationalControl(db).paused) {
      throw new AiPlatformError("AI platform is not resumable", { code: "service_draining", status: 503 });
    }
    paused = false;
    start();
    return status();
  }

  async function close() {
    closed = true;
    return drain({ abort: true });
  }

  return Object.freeze({
    createTask,
    readTask,
    readTaskResult,
    readTaskEvents,
    listTasks,
    cancelTask,
    recoverExpiredLeases,
    runPending,
    waitForTask,
    start,
    pause,
    drain,
    status,
    resume,
    close,
  });
}
