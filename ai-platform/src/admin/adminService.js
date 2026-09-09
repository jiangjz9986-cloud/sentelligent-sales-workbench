import {
  AI_TASK_STATUSES,
  AI_TASK_TYPES,
  isPlainObject,
  sha256,
  stableJson,
} from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError, asPlatformError } from "../errors.js";
import { id, iso, periodKey, withImmediateTransaction } from "../utils.js";
import {
  adminBoolean,
  adminDate,
  adminIdentifier,
  adminInteger,
  adminSlug,
  adminText,
  adminVersion,
  assertNoDuplicateVersion,
  hasConfiguredSecret,
  normalizeAgentDraft,
  normalizeBudgetPatch,
  normalizeFilter,
  normalizePage,
  normalizeSchedulePatch,
  normalizeStandardDraft,
  nextPatchVersion,
  parseArray,
  parseJson,
  parseObject,
  redactSecrets,
  safeErrorMessage,
  safeJsonView,
  safeTextView,
} from "./resourceUtils.js";

const READ_SCOPE = "ai:admin:read";
const WRITE_SCOPE = "ai:admin:write";
const PUBLISH_SCOPE = "ai:admin:publish";
const ADMIN_WILDCARD = "ai:admin:*";
const TASK_STATUS_SET = new Set(AI_TASK_STATUSES);
const LIFECYCLES = new Set(["active", "draft", "disabled"]);
const RESOURCE_TYPES = new Set([
  "agent",
  "standard",
  "budget_policy",
  "schedule",
  "model",
  "price_version",
]);
const COST_GROUPS = Object.freeze({
  owner: { expression: "u.owner", label: "owner" },
  feature: { expression: "u.feature", label: "feature" },
  taskType: { expression: "u.task_type", label: "taskType" },
  agentVersion: { expression: "u.agent_version_id", label: "agentVersionId" },
  provider: { expression: "u.provider_id", label: "providerId" },
  model: { expression: "u.model_id", label: "modelId" },
  day: { expression: "substr(u.occurred_at, 1, 10)", label: "day" },
});

function countChanges(result) {
  return Number(result?.changes ?? 0);
}

function dbId(value, name = "id") {
  return adminIdentifier(value, name);
}

function parseBooleanColumn(value) {
  return Number(value) === 1;
}

function integerOrZero(value) {
  return Number(value ?? 0);
}

function collection(items, total, { limit, offset }) {
  const normalizedTotal = Number(total ?? items.length);
  return {
    items,
    rows: items,
    total: normalizedTotal,
    pagination: {
      limit,
      offset,
      total: normalizedTotal,
      hasMore: offset + items.length < normalizedTotal,
    },
  };
}

const WRITE_META_FIELDS = new Set([
  "identity",
  "requestId",
  "body",
  "draft",
  "payload",
  "patch",
  "changes",
  "id",
  "agentId",
  "standardId",
  "policyId",
  "budgetId",
  "scheduleId",
  "expectedUpdatedAt",
  "expectedVersionId",
  "expectedVersion",
  "expectedReleaseId",
  "versionId",
  "agentVersionId",
  "draftVersionId",
  "targetVersionId",
  "testRunId",
  "offlineTestRunId",
]);

function mergeBodyArgs(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const body = args.body;
  if (body === undefined || body === null) return args;
  if (!isPlainObject(body)) {
    throw new AiPlatformError("request body must be an object", { code: "invalid_request", status: 400 });
  }
  const merged = { ...args };
  for (const [key, value] of Object.entries(body)) {
    if (["identity", "requestId", "body"].includes(key)) continue;
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function writePayload(args, ...keys) {
  const candidate = keys
    .map((key) => args?.[key])
    .find((value) => value !== undefined && value !== null) ?? {};
  if (!isPlainObject(candidate)) return candidate;
  return Object.fromEntries(Object.entries(candidate)
    .filter(([key]) => !WRITE_META_FIELDS.has(key)));
}

function withoutPageParams(params) {
  const { $limit, $offset, ...filters } = params;
  return filters;
}

function normalizedAdminIdentity(identity, { write = false, publish = false } = {}) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new AiPlatformError("authentication required", { code: "missing_auth", status: 401 });
  }
  const actor = String(identity.actor ?? identity.subject ?? "").trim();
  if (!actor || actor.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(actor)) {
    throw new AiPlatformError("authentication required", { code: "invalid_auth", status: 401 });
  }
  const scopes = Array.isArray(identity.scopes)
    ? new Set(identity.scopes.map((scope) => String(scope)))
    : null;
  const legacyAdmin = identity.isAdmin === true && (!scopes || scopes.size === 0);
  const allowed = legacyAdmin
    || scopes?.has(ADMIN_WILDCARD)
    || scopes?.has(write ? WRITE_SCOPE : READ_SCOPE)
    || (!write && scopes?.has(WRITE_SCOPE))
    || (write && publish && scopes?.has(PUBLISH_SCOPE));
  if (!allowed) throw new AiPlatformError("permission denied", { code: "forbidden", status: 403 });
  return {
    actor,
    issuer: String(identity.issuer ?? "").trim() || null,
    owner: String(identity.owner ?? "").trim() || null,
    scopes: scopes ? [...scopes].sort() : [],
  };
}

function requestId(value) {
  if (value === undefined || value === null || value === "") return id("admin-request");
  return adminText(value, "requestId", { max: 200 });
}

function expectedValue(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return adminText(value, name, { max: 200 });
}

function requireOptimisticCondition(args = {}, resourceType, resourceId) {
  const expectedUpdatedAt = expectedValue(args.expectedUpdatedAt, "expectedUpdatedAt");
  const expectedVersionId = expectedValue(args.expectedVersionId ?? args.expectedVersion, "expectedVersionId");
  const expectedReleaseId = expectedValue(args.expectedReleaseId, "expectedReleaseId");
  if (!expectedUpdatedAt && !expectedVersionId && !expectedReleaseId) {
    throw new AiPlatformError("an optimistic concurrency condition is required", {
      code: "precondition_required",
      status: 428,
      details: { resourceType, resourceId },
    });
  }
  return { expectedUpdatedAt, expectedVersionId, expectedReleaseId };
}

function assertOptimistic(row, condition, {
  resourceType,
  resourceId,
  currentVersionId = null,
  currentReleaseId = null,
} = {}) {
  if (condition.expectedUpdatedAt && row.updated_at !== condition.expectedUpdatedAt) {
    throw new AiPlatformError("resource was changed by another administrator", {
      code: "conflict",
      status: 409,
      details: {
        resourceType,
        resourceId,
        currentUpdatedAt: row.updated_at,
        currentVersionId,
        currentReleaseId,
      },
    });
  }
  if (condition.expectedVersionId && condition.expectedVersionId !== currentVersionId) {
    throw new AiPlatformError("resource version is stale", {
      code: "conflict",
      status: 409,
      details: { resourceType, resourceId, currentUpdatedAt: row.updated_at, currentVersionId },
    });
  }
  if (condition.expectedReleaseId && condition.expectedReleaseId !== currentReleaseId) {
    throw new AiPlatformError("active release is stale", {
      code: "conflict",
      status: 409,
      details: { resourceType, resourceId, currentUpdatedAt: row.updated_at, currentReleaseId },
    });
  }
}

function validateResourceType(value) {
  const resourceType = adminText(value, "resourceType", { max: 40 });
  if (!RESOURCE_TYPES.has(resourceType)) throw new AiPlatformError("resourceType is invalid", { code: "invalid_request", status: 400 });
  return resourceType;
}

function auditJson(value) {
  if (value === null || value === undefined) return null;
  const safe = redactSecrets(value);
  let encoded;
  try {
    encoded = JSON.stringify(safe);
  } catch {
    encoded = JSON.stringify({ redacted: true });
  }
  if (Buffer.byteLength(encoded, "utf8") <= 256 * 1024) return encoded;
  return JSON.stringify({
    truncated: true,
    digest: sha256(encoded),
    bytes: Buffer.byteLength(encoded, "utf8"),
  });
}

function writeFailure(error) {
  if (error instanceof AiPlatformError) return error;
  if (String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
    return new AiPlatformError("resource conflicts with an existing record", {
      code: "conflict",
      status: 409,
      cause: error,
    });
  }
  return asPlatformError(error);
}

function latestVersion(db, table, foreignColumn, resourceId) {
  if (table === "agent_versions") {
    return db.prepare(`
      SELECT * FROM agent_versions
       WHERE agent_id = $resourceId
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `).get({ $resourceId: resourceId }) ?? null;
  }
  return db.prepare(`
    SELECT * FROM standard_versions
     WHERE ${foreignColumn} = $resourceId
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get({ $resourceId: resourceId }) ?? null;
}

function encode(value) {
  return stableJson(value);
}

function safeLifecycle(value, fallback = "draft") {
  const lifecycle = value === undefined || value === null ? fallback : adminText(value, "lifecycle", { max: 20 });
  if (!LIFECYCLES.has(lifecycle)) throw new AiPlatformError("lifecycle is invalid", { code: "invalid_request", status: 400 });
  return lifecycle;
}

function standardVersionView(row) {
  if (!row) return null;
  return {
    id: row.id,
    standardId: row.standard_id,
    version: row.version,
    content: safeTextView(row.content, ""),
    rules: safeJsonView(row.rules_json, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function agentVersionView(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    version: row.version,
    taskTypes: parseArray(row.task_types_json, []),
    systemPrompt: safeTextView(row.system_prompt, ""),
    instructions: safeJsonView(row.instructions_json, {}),
    tools: redactSecrets(parseArray(row.tools_json, [])),
    modelPolicy: safeJsonView(row.model_policy_json, {}),
    inputSchema: safeJsonView(row.input_schema_json, {}),
    outputSchema: safeJsonView(row.output_schema_json, {}),
    standardIds: parseArray(row.standard_ids_json, []),
    limits: safeJsonView(row.limits_json, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function releaseView(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    status: row.status,
    testRunId: row.test_run_id || null,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

function providerView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: parseBooleanColumn(row.enabled),
    credentialConfigured: hasConfiguredSecret(row.config_json),
    updatedAt: row.updated_at,
  };
}

function modelView(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerKind: row.provider_kind,
    providerEnabled: parseBooleanColumn(row.provider_enabled),
    name: row.name,
    capabilities: safeJsonView(row.capabilities_json, {}),
    enabled: parseBooleanColumn(row.enabled),
    credentialConfigured: hasConfiguredSecret(row.provider_config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function priceView(row) {
  if (!row) return null;
  return {
    id: row.id,
    modelId: row.model_id,
    modelName: row.model_name,
    providerId: row.provider_id,
    providerName: row.provider_name,
    version: row.version,
    currency: row.currency,
    inputMicroPer1k: integerOrZero(row.input_micro_per_1k),
    outputMicroPer1k: integerOrZero(row.output_micro_per_1k),
    cachedInputMicroPer1k: integerOrZero(row.cached_input_micro_per_1k),
    audioMicroPerMinute: integerOrZero(row.audio_micro_per_minute),
    imageMicroPerPage: integerOrZero(row.image_micro_per_page),
    functionFeeMicro: integerOrZero(row.function_fee_micro),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
  };
}

function taskView(row, { includeInput = false, includeOutput = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    issuer: row.issuer,
    owner: row.owner,
    actor: row.actor,
    channel: row.channel,
    feature: row.feature,
    taskType: row.task_type,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    priority: row.priority,
    input: includeInput ? safeJsonView(row.input_json, {}) : undefined,
    evidenceDigest: row.evidence_digest,
    requestHash: row.request_hash,
    agentVersionId: row.agent_version_id,
    modelId: row.model_id,
    standardDigest: row.standard_digest,
    status: row.status,
    source: row.source,
    output: includeOutput ? safeJsonView(row.output_json, null) : undefined,
    outputDigest: row.output_digest,
    errorCode: row.error_code || null,
    errorMessage: safeErrorMessage(row.error_message),
    currentAttempt: integerOrZero(row.current_attempt),
    leaseExpiresAt: row.lease_expires_at,
    cancelRequestedAt: row.cancel_requested_at,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function attemptView(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: integerOrZero(row.attempt_no),
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    requestMeta: safeJsonView(row.request_meta_json, {}),
    responseMeta: safeJsonView(row.response_meta_json, {}),
    usage: {
      inputTokens: integerOrZero(row.input_tokens),
      outputTokens: integerOrZero(row.output_tokens),
      cachedInputTokens: integerOrZero(row.cached_input_tokens),
      audioSeconds: integerOrZero(row.audio_seconds),
      imagePages: integerOrZero(row.image_pages),
    },
    costMicro: integerOrZero(row.cost_micro),
    costStatus: row.cost_status,
    priceVersionId: row.price_version_id,
    // External provider request identifiers may be URLs carrying credentials;
    // treat the whole value as a secret-bearing metadata field.
    externalRequestId: redactSecrets(safeTextView(row.external_request_id, null, 1_000)),
    errorCode: row.error_code || null,
    errorMessage: safeErrorMessage(row.error_message),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function eventView(row) {
  return {
    id: integerOrZero(row.id),
    taskId: row.task_id,
    eventType: row.event_type,
    payload: safeJsonView(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function reservationView(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    policyId: row.policy_id,
    periodKey: row.period_key,
    reservedMicro: integerOrZero(row.reserved_micro),
    actualMicro: integerOrZero(row.actual_micro),
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function usageView(row) {
  return {
    id: integerOrZero(row.id),
    taskId: row.task_id,
    attemptId: row.attempt_id,
    owner: row.owner,
    feature: row.feature,
    taskType: row.task_type,
    agentVersionId: row.agent_version_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    priceVersionId: row.price_version_id,
    usage: safeJsonView(row.usage_json, {}),
    costMicro: integerOrZero(row.cost_micro),
    costStatus: row.cost_status,
    currency: row.currency,
    functionFeeMicro: integerOrZero(row.function_fee_micro),
    feeStatus: row.fee_status,
    occurredAt: row.occurred_at,
  };
}

function taskFilters(filters = {}) {
  const clauses = [];
  const params = {};
  const owner = normalizeFilter(filters.owner, "owner");
  const feature = normalizeFilter(filters.feature, "feature");
  const modelId = normalizeFilter(filters.modelId, "modelId");
  const agentVersionId = normalizeFilter(filters.agentVersionId, "agentVersionId");
  const taskType = normalizeFilter(filters.taskType, "taskType");
  const status = normalizeFilter(filters.status, "status");
  const from = filters.from === undefined || filters.from === null || filters.from === "" ? null : adminDate(filters.from, "from");
  const to = filters.to === undefined || filters.to === null || filters.to === "" ? null : adminDate(filters.to, "to");
  if (from && to && from >= to) throw new AiPlatformError("from must be before to", { code: "invalid_request", status: 400 });
  if (owner) { clauses.push("t.owner = $owner"); params.$owner = owner; }
  if (feature) { clauses.push("t.feature = $feature"); params.$feature = feature; }
  if (modelId) { clauses.push("t.model_id = $modelId"); params.$modelId = modelId; }
  if (agentVersionId) { clauses.push("t.agent_version_id = $agentVersionId"); params.$agentVersionId = agentVersionId; }
  if (taskType) {
    if (!AI_TASK_TYPES.includes(taskType)) throw new AiPlatformError("taskType is invalid", { code: "invalid_request", status: 400 });
    clauses.push("t.task_type = $taskType");
    params.$taskType = taskType;
  }
  if (status) {
    if (!TASK_STATUS_SET.has(status)) throw new AiPlatformError("status is invalid", { code: "invalid_request", status: 400 });
    clauses.push("t.status = $status");
    params.$status = status;
  }
  if (from) { clauses.push("t.requested_at >= $from"); params.$from = from; }
  if (to) { clauses.push("t.requested_at < $to"); params.$to = to; }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function usageFilters(filters = {}) {
  const clauses = [];
  const params = {};
  const owner = normalizeFilter(filters.owner, "owner");
  const feature = normalizeFilter(filters.feature, "feature");
  const modelId = normalizeFilter(filters.modelId, "modelId");
  const providerId = normalizeFilter(filters.providerId, "providerId");
  const agentVersionId = normalizeFilter(filters.agentVersionId, "agentVersionId");
  const taskType = normalizeFilter(filters.taskType, "taskType");
  const from = filters.from === undefined || filters.from === null || filters.from === "" ? null : adminDate(filters.from, "from");
  const to = filters.to === undefined || filters.to === null || filters.to === "" ? null : adminDate(filters.to, "to");
  if (from && to && from >= to) throw new AiPlatformError("from must be before to", { code: "invalid_request", status: 400 });
  if (owner) { clauses.push("u.owner = $owner"); params.$owner = owner; }
  if (feature) { clauses.push("u.feature = $feature"); params.$feature = feature; }
  if (modelId) { clauses.push("u.model_id = $modelId"); params.$modelId = modelId; }
  if (providerId) { clauses.push("u.provider_id = $providerId"); params.$providerId = providerId; }
  if (agentVersionId) { clauses.push("u.agent_version_id = $agentVersionId"); params.$agentVersionId = agentVersionId; }
  if (taskType) {
    if (!AI_TASK_TYPES.includes(taskType)) throw new AiPlatformError("taskType is invalid", { code: "invalid_request", status: 400 });
    clauses.push("u.task_type = $taskType");
    params.$taskType = taskType;
  }
  if (from) { clauses.push("u.occurred_at >= $from"); params.$from = from; }
  if (to) { clauses.push("u.occurred_at < $to"); params.$to = to; }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params, from, to, owner };
}

function budgetUsage(db, row, at, timeZone) {
  const key = periodKey(new Date(at), row.period, timeZone);
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro ELSE actual_micro END), 0) AS used_micro,
      COALESCE(SUM(CASE WHEN status IN ('reserved', 'settled', 'unknown') THEN 1 ELSE 0 END), 0) AS call_count,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro ELSE 0 END), 0) AS reserved_micro,
      COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count
      FROM budget_reservations
     WHERE policy_id = $policyId AND period_key = $periodKey
       AND status IN ('reserved', 'settled', 'unknown')
  `).get({ $policyId: row.id, $periodKey: key });
  const usedMicro = integerOrZero(usage?.used_micro);
  const amountMicro = integerOrZero(row.amount_micro);
  return {
    periodKey: key,
    usedMicro,
    reservedMicro: integerOrZero(usage?.reserved_micro),
    callCount: integerOrZero(usage?.call_count),
    unknownCount: integerOrZero(usage?.unknown_count),
    utilizationPercent: amountMicro > 0 ? Math.round((usedMicro / amountMicro) * 10_000) / 100 : null,
  };
}

function budgetView(db, row, at, timeZone) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    period: row.period,
    currency: row.currency,
    amountMicro: integerOrZero(row.amount_micro),
    callLimit: integerOrZero(row.call_limit),
    warningPercent: integerOrZero(row.warning_percent),
    enabled: parseBooleanColumn(row.enabled),
    usage: budgetUsage(db, row, at, timeZone),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scheduleView(db, row) {
  if (!row) return null;
  const activeRuns = db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_runs
     WHERE schedule_id = $scheduleId AND status IN ('queued', 'running')
  `).get({ $scheduleId: row.id });
  const recentRuns = db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_runs
     WHERE schedule_id = $scheduleId AND created_at >= datetime('now', '-1 day')
  `).get({ $scheduleId: row.id });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    taskType: row.task_type,
    feature: row.feature,
    intervalSeconds: integerOrZero(row.interval_seconds),
    enabled: parseBooleanColumn(row.enabled),
    priority: row.priority,
    inputTemplate: safeJsonView(row.input_template_json, {}),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: safeErrorMessage(row.last_error),
    activeRunCount: integerOrZero(activeRuns?.count),
    recentRunCount: integerOrZero(recentRuns?.count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentSummary(db, row) {
  const activeVersion = row.active_version_id
    ? db.prepare("SELECT * FROM agent_versions WHERE id = $id").get({ $id: row.active_version_id })
    : null;
  const latest = row.latest_version_id
    ? db.prepare("SELECT * FROM agent_versions WHERE id = $id").get({ $id: row.latest_version_id })
    : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    lifecycle: row.lifecycle,
    activeRelease: row.active_release_id ? {
      id: row.active_release_id,
      agentVersionId: row.active_version_id,
      publishedAt: row.active_published_at,
    } : null,
    activeVersion: activeVersion ? { id: activeVersion.id, version: activeVersion.version } : null,
    latestVersion: latest ? { id: latest.id, version: latest.version, createdAt: latest.created_at } : null,
    draftVersionId: latest && latest.id !== row.active_version_id ? latest.id : null,
    versionCount: integerOrZero(row.version_count),
    releaseCount: integerOrZero(row.release_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function standardSummary(db, row) {
  const latest = row.latest_version_id
    ? db.prepare("SELECT * FROM standard_versions WHERE id = $id").get({ $id: row.latest_version_id })
    : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    lifecycle: row.lifecycle,
    latestVersion: latest ? { id: latest.id, version: latest.version, createdAt: latest.created_at } : null,
    versionCount: integerOrZero(row.version_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectAgent(db, agentId) {
  return db.prepare("SELECT * FROM agents WHERE id = $id").get({ $id: agentId }) ?? null;
}

function selectStandard(db, standardId) {
  return db.prepare("SELECT * FROM standards WHERE id = $id").get({ $id: standardId }) ?? null;
}

function selectActiveRelease(db, agentId) {
  return db.prepare(`
    SELECT * FROM agent_releases
     WHERE agent_id = $agentId AND status = 'active'
     ORDER BY published_at DESC, id DESC
     LIMIT 1
  `).get({ $agentId: agentId }) ?? null;
}

function selectAgentSnapshot(db, agentId) {
  const agent = selectAgent(db, agentId);
  if (!agent) return null;
  const versions = db.prepare(`
    SELECT * FROM agent_versions
     WHERE agent_id = $agentId
     ORDER BY created_at DESC, id DESC
  `).all({ $agentId: agentId });
  const releases = db.prepare(`
    SELECT * FROM agent_releases
     WHERE agent_id = $agentId
     ORDER BY published_at DESC, id DESC
  `).all({ $agentId: agentId });
  const active = releases.find((release) => release.status === "active") ?? null;
  const latest = versions[0] ?? null;
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    lifecycle: agent.lifecycle,
    activeRelease: releaseView(active),
    activeVersion: agentVersionView(versions.find((version) => version.id === active?.agent_version_id) ?? null),
    latestVersion: agentVersionView(latest),
    draftVersion: latest && latest.id !== active?.agent_version_id ? agentVersionView(latest) : null,
    versions: versions.map(agentVersionView),
    releases: releases.map(releaseView),
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

function selectStandardSnapshot(db, standardId) {
  const standard = selectStandard(db, standardId);
  if (!standard) return null;
  const versions = db.prepare(`
    SELECT * FROM standard_versions
     WHERE standard_id = $standardId
     ORDER BY created_at DESC, id DESC
  `).all({ $standardId: standardId });
  return {
    id: standard.id,
    slug: standard.slug,
    name: standard.name,
    description: standard.description,
    lifecycle: standard.lifecycle,
    latestVersion: standardVersionView(versions[0] ?? null),
    versions: versions.map(standardVersionView),
    createdAt: standard.created_at,
    updatedAt: standard.updated_at,
  };
}

function validateModelReference(db, modelPolicy) {
  const modelId = modelPolicy?.modelId;
  if (!modelId) throw new AiPlatformError("modelPolicy.modelId is required", { code: "invalid_request", status: 400 });
  const model = db.prepare(`
    SELECT m.*, p.kind AS provider_kind, p.enabled AS provider_enabled
      FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE m.id = $id
  `).get({ $id: modelId });
  if (!model) throw new AiPlatformError("referenced model does not exist", { code: "invalid_reference", status: 422, details: { modelId } });
  if (modelPolicy.providerId && modelPolicy.providerId !== model.provider_id) {
    throw new AiPlatformError("modelPolicy.providerId does not match model", { code: "invalid_reference", status: 422 });
  }
  if (modelPolicy.fallbackModelId) {
    const fallback = db.prepare("SELECT id FROM models WHERE id = $id").get({ $id: modelPolicy.fallbackModelId });
    if (!fallback) throw new AiPlatformError("fallback model does not exist", { code: "invalid_reference", status: 422 });
  }
  return model;
}

function validateStandardReferences(db, standardIds) {
  for (const standardId of standardIds ?? []) {
    const row = db.prepare("SELECT id FROM standard_versions WHERE id = $id").get({ $id: standardId });
    if (!row) throw new AiPlatformError("referenced standard version does not exist", { code: "invalid_reference", status: 422, details: { standardId } });
  }
}

function validateAgentVersion(db, version) {
  validateModelReference(db, version.modelPolicy);
  validateStandardReferences(db, version.standardIds);
  if (version.instructions && version.instructions.noDirectWrite === false) {
    throw new AiPlatformError("the noDirectWrite safety baseline cannot be disabled", { code: "safety_policy_violation", status: 422 });
  }
  for (const tool of version.tools ?? []) {
    if (isPlainObject(tool) && tool.readOnly === false) {
      throw new AiPlatformError("write-capable tools require a separately reviewed integration", { code: "safety_policy_violation", status: 422 });
    }
  }
}

function ensureNoActiveTaskTypeConflict(db, agentId, taskTypes) {
  const rows = db.prepare(`
    SELECT av.agent_id, av.task_types_json
      FROM agent_releases ar
      JOIN agent_versions av ON av.id = ar.agent_version_id
      JOIN agents a ON a.id = av.agent_id
     WHERE ar.status = 'active'
       AND a.lifecycle = 'active'
       AND av.agent_id <> $agentId
  `).all({ $agentId: agentId });
  const requested = new Set(taskTypes);
  for (const row of rows) {
    const overlap = parseArray(row.task_types_json, []).filter((type) => requested.has(type));
    if (overlap.length) {
      throw new AiPlatformError("another active Agent already handles one of these task types", {
        code: "active_task_type_conflict",
        status: 409,
        details: { taskTypes: overlap },
      });
    }
  }
}

function nextTimestamp(clock, last = null) {
  const candidate = iso(clock);
  if (!last || candidate > last) return candidate;
  const next = new Date(last);
  next.setMilliseconds(next.getMilliseconds() + 1);
  return next.toISOString();
}

export function createAdminService({ db, clock = () => new Date(), timeZone = "Asia/Shanghai" } = {}) {
  if (!db) throw new TypeError("db is required");
  let lastWriteAt = null;

  function now() {
    const value = nextTimestamp(clock, lastWriteAt);
    lastWriteAt = value;
    return value;
  }

  function beginWrite(args, action, resourceType, resourceId, work) {
    const auth = normalizedAdminIdentity(args?.identity, {
      write: true,
      publish: action === "agent.publish" || action === "agent.rollback",
    });
    const rid = requestId(args?.requestId);
    try {
      return withImmediateTransaction(db, () => {
        const outcome = work({ actor: auth.actor, issuer: auth.issuer, requestId: rid });
        if (!outcome || !outcome.value) throw new AiPlatformError("admin write did not return a resource", { code: "internal_error", status: 500 });
        const auditResourceType = validateResourceType(outcome.resourceType ?? resourceType);
        const auditResourceId = dbId(outcome.resourceId ?? resourceId ?? "unknown", "resourceId");
        db.prepare(`
          INSERT INTO admin_audit (
            actor, action, resource_type, resource_id, before_json, after_json, request_id, created_at
          ) VALUES ($actor, $action, $resourceType, $resourceId, $beforeJson, $afterJson, $requestId, $createdAt)
        `).run({
          $actor: auth.actor,
          $action: adminText(outcome.action ?? action, "action", { max: 120 }),
          $resourceType: auditResourceType,
          $resourceId: auditResourceId,
          $beforeJson: auditJson(outcome.before ?? null),
          $afterJson: auditJson(outcome.after ?? outcome.value),
          $requestId: rid,
          $createdAt: now(),
        });
        return outcome.value;
      });
    } catch (error) {
      throw writeFailure(error);
    }
  }

  function requireRead(identity) {
    return normalizedAdminIdentity(identity, { write: false });
  }

  function listProviders(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const rows = db.prepare(`
      SELECT * FROM providers
       ORDER BY name ASC, id ASC
       LIMIT $limit OFFSET $offset
    `).all({ $limit: limit, $offset: offset });
    const total = db.prepare("SELECT COUNT(*) AS total FROM providers").get();
    return collection(rows.map(providerView), total?.total, { limit, offset });
  }

  function getProvider(args = {}) {
    requireRead(args.identity);
    const providerId = dbId(args.providerId ?? args.id, "providerId");
    const row = db.prepare("SELECT * FROM providers WHERE id = $id").get({ $id: providerId });
    if (!row) throw new AiPlatformError("provider not found", { code: "not_found", status: 404 });
    return providerView(row);
  }

  function listModels(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.providerId !== undefined && args.providerId !== null && args.providerId !== "") {
      const providerId = dbId(args.providerId, "providerId");
      clauses.push("m.provider_id = $providerId");
      params.$providerId = providerId;
    }
    if (args.enabled !== undefined && args.enabled !== null && args.enabled !== "") {
      const enabled = adminBoolean(args.enabled, "enabled");
      clauses.push("m.enabled = $enabled");
      params.$enabled = enabled ? 1 : 0;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT m.*, p.name AS provider_name, p.kind AS provider_kind,
             p.enabled AS provider_enabled, p.config_json AS provider_config_json
        FROM models m JOIN providers p ON p.id = m.provider_id
        ${where}
       ORDER BY p.name ASC, m.name ASC, m.id ASC
       LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM models m ${where}`).get(withoutPageParams(params));
    return collection(rows.map(modelView), total?.total, { limit, offset });
  }

  function getModel(args = {}) {
    requireRead(args.identity);
    const modelId = dbId(args.modelId ?? args.id, "modelId");
    const row = db.prepare(`
      SELECT m.*, p.name AS provider_name, p.kind AS provider_kind,
             p.enabled AS provider_enabled, p.config_json AS provider_config_json
        FROM models m
        JOIN providers p ON p.id = m.provider_id
       WHERE m.id = $id
    `).get({ $id: modelId });
    if (!row) throw new AiPlatformError("model not found", { code: "not_found", status: 404 });
    return modelView(row);
  }

  function listPrices(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.modelId !== undefined && args.modelId !== null && args.modelId !== "") {
      const modelId = dbId(args.modelId, "modelId");
      clauses.push("pv.model_id = $modelId");
      params.$modelId = modelId;
    }
    if (args.effectiveAt !== undefined && args.effectiveAt !== null && args.effectiveAt !== "") {
      const effectiveAt = adminDate(args.effectiveAt, "effectiveAt");
      clauses.push("pv.effective_from <= $effectiveAt");
      clauses.push("(pv.effective_to IS NULL OR pv.effective_to > $effectiveAt)");
      params.$effectiveAt = effectiveAt;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT pv.*, m.name AS model_name, p.id AS provider_id, p.name AS provider_name
        FROM price_versions pv
        JOIN models m ON m.id = pv.model_id
        JOIN providers p ON p.id = m.provider_id
        ${where}
       ORDER BY pv.effective_from DESC, pv.created_at DESC, pv.id DESC
       LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM price_versions pv ${where}`).get(withoutPageParams(params));
    return collection(rows.map(priceView), total?.total, { limit, offset });
  }

  function getPrice(args = {}) {
    requireRead(args.identity);
    const priceId = dbId(args.priceId ?? args.priceVersionId ?? args.id, "priceId");
    const row = db.prepare(`
      SELECT pv.*, m.name AS model_name, p.id AS provider_id, p.name AS provider_name
        FROM price_versions pv
        JOIN models m ON m.id = pv.model_id
        JOIN providers p ON p.id = m.provider_id
       WHERE pv.id = $id
    `).get({ $id: priceId });
    if (!row) throw new AiPlatformError("price version not found", { code: "not_found", status: 404 });
    return priceView(row);
  }

  function listAgents(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.lifecycle !== undefined && args.lifecycle !== null && args.lifecycle !== "") {
      const lifecycle = safeLifecycle(args.lifecycle);
      clauses.push("a.lifecycle = $lifecycle");
      params.$lifecycle = lifecycle;
    }
    if (args.slug !== undefined && args.slug !== null && args.slug !== "") {
      const slug = adminSlug(args.slug, "slug");
      clauses.push("a.slug = $slug");
      params.$slug = slug;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT a.*,
             ar.id AS active_release_id,
             ar.agent_version_id AS active_version_id,
             ar.published_at AS active_published_at,
             (SELECT av2.id FROM agent_versions av2
               WHERE av2.agent_id = a.id
               ORDER BY av2.created_at DESC, av2.id DESC LIMIT 1) AS latest_version_id,
             (SELECT COUNT(*) FROM agent_versions av3 WHERE av3.agent_id = a.id) AS version_count,
             (SELECT COUNT(*) FROM agent_releases ar3 WHERE ar3.agent_id = a.id) AS release_count
        FROM agents a
        LEFT JOIN agent_releases ar ON ar.agent_id = a.id AND ar.status = 'active'
        ${where}
       ORDER BY a.name ASC, a.id ASC
       LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM agents a ${where}`).get(withoutPageParams(params));
    return collection(rows.map((row) => agentSummary(db, row)), total?.total, { limit, offset });
  }

  function getAgent(args = {}) {
    requireRead(args.identity);
    const agentId = dbId(args.agentId ?? args.id, "agentId");
    const snapshot = selectAgentSnapshot(db, agentId);
    if (!snapshot) throw new AiPlatformError("Agent not found", { code: "not_found", status: 404 });
    return snapshot;
  }

  function listStandards(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.lifecycle !== undefined && args.lifecycle !== null && args.lifecycle !== "") {
      const lifecycle = safeLifecycle(args.lifecycle);
      clauses.push("s.lifecycle = $lifecycle");
      params.$lifecycle = lifecycle;
    }
    if (args.slug !== undefined && args.slug !== null && args.slug !== "") {
      const slug = adminSlug(args.slug, "slug");
      clauses.push("s.slug = $slug");
      params.$slug = slug;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT s.*,
             (SELECT sv2.id FROM standard_versions sv2
               WHERE sv2.standard_id = s.id
               ORDER BY sv2.created_at DESC, sv2.id DESC LIMIT 1) AS latest_version_id,
             (SELECT COUNT(*) FROM standard_versions sv3 WHERE sv3.standard_id = s.id) AS version_count
        FROM standards s
        ${where}
       ORDER BY s.name ASC, s.id ASC
       LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM standards s ${where}`).get(withoutPageParams(params));
    return collection(rows.map((row) => standardSummary(db, row)), total?.total, { limit, offset });
  }

  function getStandard(args = {}) {
    requireRead(args.identity);
    const standardId = dbId(args.standardId ?? args.id, "standardId");
    const snapshot = selectStandardSnapshot(db, standardId);
    if (!snapshot) throw new AiPlatformError("standard not found", { code: "not_found", status: 404 });
    return snapshot;
  }

  function listBudgetPolicies(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.scopeType !== undefined && args.scopeType !== null && args.scopeType !== "") {
      const scopeType = adminText(args.scopeType, "scopeType", { max: 20 });
      if (!["global", "owner", "feature", "agent"].includes(scopeType)) throw new AiPlatformError("scopeType is invalid", { code: "invalid_request", status: 400 });
      clauses.push("scope_type = $scopeType");
      params.$scopeType = scopeType;
    }
    if (args.enabled !== undefined && args.enabled !== null && args.enabled !== "") {
      const enabled = adminBoolean(args.enabled, "enabled");
      clauses.push("enabled = $enabled");
      params.$enabled = enabled ? 1 : 0;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM budget_policies
      ${where}
      ORDER BY CASE scope_type WHEN 'global' THEN 0 WHEN 'owner' THEN 1 WHEN 'feature' THEN 2 ELSE 3 END,
               scope_key ASC, period ASC
      LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM budget_policies ${where}`).get(withoutPageParams(params));
    const at = now();
    return collection(rows.map((row) => budgetView(db, row, at, timeZone)), total?.total, { limit, offset });
  }

  function getBudgetPolicy(args = {}) {
    requireRead(args.identity);
    const policyId = dbId(args.policyId ?? args.id, "policyId");
    const row = db.prepare("SELECT * FROM budget_policies WHERE id = $id").get({ $id: policyId });
    if (!row) throw new AiPlatformError("budget policy not found", { code: "not_found", status: 404 });
    return budgetView(db, row, now(), timeZone);
  }

  function listSchedules(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    if (args.enabled !== undefined && args.enabled !== null && args.enabled !== "") {
      const enabled = adminBoolean(args.enabled, "enabled");
      clauses.push("enabled = $enabled");
      params.$enabled = enabled ? 1 : 0;
    }
    if (args.taskType !== undefined && args.taskType !== null && args.taskType !== "") {
      const taskType = normalizeFilter(args.taskType, "taskType");
      if (!AI_TASK_TYPES.includes(taskType)) throw new AiPlatformError("taskType is invalid", { code: "invalid_request", status: 400 });
      clauses.push("task_type = $taskType");
      params.$taskType = taskType;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM schedules
      ${where}
      ORDER BY enabled DESC, name ASC, id ASC
      LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM schedules ${where}`).get(withoutPageParams(params));
    return collection(rows.map((row) => scheduleView(db, row)), total?.total, { limit, offset });
  }

  function getSchedule(args = {}) {
    requireRead(args.identity);
    const scheduleId = dbId(args.scheduleId ?? args.id, "scheduleId");
    const row = db.prepare("SELECT * FROM schedules WHERE id = $id").get({ $id: scheduleId });
    if (!row) throw new AiPlatformError("schedule not found", { code: "not_found", status: 404 });
    return scheduleView(db, row);
  }

  function listTasks(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const filters = taskFilters(args);
    const params = { ...filters.params, $limit: limit, $offset: offset };
    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      ${filters.where}
      ORDER BY CASE t.priority WHEN 'interactive' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               t.requested_at DESC, t.id DESC
      LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM tasks t ${filters.where}`).get(filters.params);
    const includeInput = args.includeInput === true;
    return collection(rows.map((row) => taskView(row, { includeInput, includeOutput: false })), total?.total, { limit, offset });
  }

  function getTaskDetail(args = {}) {
    requireRead(args.identity);
    const taskId = dbId(args.taskId ?? args.id, "taskId");
    const row = db.prepare("SELECT * FROM tasks WHERE id = $id").get({ $id: taskId });
    if (!row) throw new AiPlatformError("task not found", { code: "not_found", status: 404 });
    const attempts = db.prepare(`
      SELECT * FROM task_attempts WHERE task_id = $taskId ORDER BY attempt_no ASC, id ASC
    `).all({ $taskId: taskId });
    const events = db.prepare(`
      SELECT * FROM task_events WHERE task_id = $taskId ORDER BY id ASC LIMIT 500
    `).all({ $taskId: taskId });
    const reservations = db.prepare(`
      SELECT * FROM budget_reservations WHERE task_id = $taskId ORDER BY created_at ASC, id ASC
    `).all({ $taskId: taskId });
    const usage = db.prepare(`
      SELECT * FROM usage_ledger WHERE task_id = $taskId ORDER BY id ASC
    `).all({ $taskId: taskId });
    return {
      task: taskView(row, { includeInput: true, includeOutput: true }),
      attempts: attempts.map(attemptView),
      events: events.map(eventView),
      budgetReservations: reservations.map(reservationView),
      usageLedger: usage.map(usageView),
    };
  }

  function listTaskAttempts(args = {}) {
    requireRead(args.identity);
    const taskId = dbId(args.taskId, "taskId");
    const exists = db.prepare("SELECT id FROM tasks WHERE id = $id").get({ $id: taskId });
    if (!exists) throw new AiPlatformError("task not found", { code: "not_found", status: 404 });
    const { limit, offset } = normalizePage(args, { defaultLimit: 50, maxLimit: 200 });
    const rows = db.prepare(`
      SELECT * FROM task_attempts
       WHERE task_id = $taskId
       ORDER BY attempt_no ASC, id ASC
       LIMIT $limit OFFSET $offset
    `).all({ $taskId: taskId, $limit: limit, $offset: offset });
    const total = db.prepare("SELECT COUNT(*) AS total FROM task_attempts WHERE task_id = $taskId").get({ $taskId: taskId });
    return collection(rows.map(attemptView), total?.total, { limit, offset });
  }

  function listTaskEvents(args = {}) {
    requireRead(args.identity);
    const taskId = dbId(args.taskId, "taskId");
    const exists = db.prepare("SELECT id FROM tasks WHERE id = $id").get({ $id: taskId });
    if (!exists) throw new AiPlatformError("task not found", { code: "not_found", status: 404 });
    const { limit, offset } = normalizePage(args, { defaultLimit: 100, maxLimit: 200 });
    const rows = db.prepare(`
      SELECT * FROM task_events
       WHERE task_id = $taskId
       ORDER BY id ASC
       LIMIT $limit OFFSET $offset
    `).all({ $taskId: taskId, $limit: limit, $offset: offset });
    const total = db.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id = $taskId").get({ $taskId: taskId });
    return collection(rows.map(eventView), total?.total, { limit, offset });
  }

  function getTaskAttempt(args = {}) {
    requireRead(args.identity);
    const attemptId = dbId(args.attemptId ?? args.id, "attemptId");
    const row = db.prepare("SELECT * FROM task_attempts WHERE id = $id").get({ $id: attemptId });
    if (!row) throw new AiPlatformError("task attempt not found", { code: "not_found", status: 404 });
    return attemptView(row);
  }

  function summarizeCostsInternal(filters = {}, { groupBy = null } = {}) {
    const normalized = usageFilters(filters);
    const totals = db.prepare(`
      SELECT currency,
             COUNT(*) AS calls,
             COALESCE(SUM(cost_micro), 0) AS cost_micro,
             COALESCE(SUM(function_fee_micro), 0) AS function_fee_micro,
             SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_costs,
             SUM(CASE WHEN cost_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_costs,
             SUM(CASE WHEN fee_status = 'not_configured' THEN 1 ELSE 0 END) AS unconfigured_fees
        FROM usage_ledger u
        ${normalized.where}
       GROUP BY currency
       ORDER BY currency ASC
    `).all(normalized.params).map((row) => ({
      currency: row.currency,
      calls: integerOrZero(row.calls),
      costMicro: integerOrZero(row.cost_micro),
      functionFeeMicro: integerOrZero(row.function_fee_micro),
      totalMicro: integerOrZero(row.cost_micro) + integerOrZero(row.function_fee_micro),
      unknownCosts: integerOrZero(row.unknown_costs),
      estimatedCosts: integerOrZero(row.estimated_costs),
      unconfiguredFees: integerOrZero(row.unconfigured_fees),
    }));
    const selectedGroup = groupBy === undefined || groupBy === null || groupBy === "" ? null : normalizeFilter(groupBy, "groupBy", 40);
    if (selectedGroup && !COST_GROUPS[selectedGroup]) {
      throw new AiPlatformError("groupBy is invalid", { code: "invalid_request", status: 400 });
    }
    const groups = selectedGroup
      ? db.prepare(`
          SELECT ${COST_GROUPS[selectedGroup].expression} AS group_key, u.currency,
                 COUNT(*) AS calls,
                 COALESCE(SUM(u.cost_micro), 0) AS cost_micro,
                 COALESCE(SUM(u.function_fee_micro), 0) AS function_fee_micro,
                 SUM(CASE WHEN u.cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_costs,
                 SUM(CASE WHEN u.cost_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_costs
            FROM usage_ledger u
            ${normalized.where}
           GROUP BY ${COST_GROUPS[selectedGroup].expression}, u.currency
           ORDER BY cost_micro DESC, group_key ASC, u.currency ASC
        `).all(normalized.params).map((row) => ({
        [COST_GROUPS[selectedGroup].label]: row.group_key,
        currency: row.currency,
        calls: integerOrZero(row.calls),
        costMicro: integerOrZero(row.cost_micro),
        functionFeeMicro: integerOrZero(row.function_fee_micro),
        totalMicro: integerOrZero(row.cost_micro) + integerOrZero(row.function_fee_micro),
        unknownCosts: integerOrZero(row.unknown_costs),
        estimatedCosts: integerOrZero(row.estimated_costs),
      }))
      : [];
    const allSameCurrency = totals.length <= 1;
    const first = totals[0] ?? null;
    return {
      from: normalized.from,
      to: normalized.to,
      owner: normalized.owner,
      groupBy: selectedGroup,
      currency: allSameCurrency ? first?.currency ?? null : null,
      mixedCurrency: !allSameCurrency,
      calls: totals.reduce((sum, item) => sum + item.calls, 0),
      costMicro: allSameCurrency ? (first?.costMicro ?? 0) : null,
      functionFeeMicro: allSameCurrency ? (first?.functionFeeMicro ?? 0) : null,
      totalMicro: allSameCurrency ? (first?.totalMicro ?? 0) : null,
      unknownCosts: totals.reduce((sum, item) => sum + item.unknownCosts, 0),
      estimatedCosts: totals.reduce((sum, item) => sum + item.estimatedCosts, 0),
      unconfiguredFees: totals.reduce((sum, item) => sum + item.unconfiguredFees, 0),
      byCurrency: totals,
      groups,
    };
  }

  function getCostSummary(args = {}) {
    requireRead(args.identity);
    return summarizeCostsInternal(args, { groupBy: args.groupBy });
  }

  function getOverview(args = {}) {
    requireRead(args.identity);
    const at = now();
    const taskStatusRows = db.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status ASC
    `).all();
    const byStatus = Object.fromEntries(AI_TASK_STATUSES.map((status) => [status, 0]));
    for (const row of taskStatusRows) if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = integerOrZero(row.count);
    const recentTasks = db.prepare(`
      SELECT * FROM tasks ORDER BY requested_at DESC, id DESC LIMIT 10
    `).all().map((row) => taskView(row, { includeInput: false, includeOutput: false }));
    const providers = db.prepare("SELECT * FROM providers ORDER BY name ASC, id ASC").all().map(providerView);
    const budgets = db.prepare("SELECT * FROM budget_policies ORDER BY scope_type ASC, scope_key ASC, period ASC").all()
      .map((row) => budgetView(db, row, at, timeZone));
    const schedules = db.prepare("SELECT * FROM schedules ORDER BY enabled DESC, name ASC, id ASC").all()
      .map((row) => scheduleView(db, row));
    const dueSchedules = schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt && schedule.nextRunAt <= at).length;
    const unknownAttempts = db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE status = 'unknown'").get();
    const runningAttempts = db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE status = 'running'").get();
    return {
      generatedAt: at,
      tasks: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
        queueDepth: byStatus.queued,
        recent: recentTasks,
      },
      attempts: {
        running: integerOrZero(runningAttempts?.count),
        unknown: integerOrZero(unknownAttempts?.count),
      },
      providers: {
        total: providers.length,
        enabled: providers.filter((provider) => provider.enabled).length,
        items: providers,
      },
      schedules: {
        total: schedules.length,
        enabled: schedules.filter((schedule) => schedule.enabled).length,
        due: dueSchedules,
        items: schedules,
      },
      budgets: {
        total: budgets.length,
        enabled: budgets.filter((budget) => budget.enabled).length,
        items: budgets,
      },
      cost: summarizeCostsInternal({ from: args.from, to: args.to, owner: args.owner }, { groupBy: "feature" }),
    };
  }

  function listAudit(args = {}) {
    requireRead(args.identity);
    const { limit, offset } = normalizePage(args, { defaultLimit: 100, maxLimit: 200 });
    const clauses = [];
    const params = { $limit: limit, $offset: offset };
    const actor = normalizeFilter(args.actor, "actor");
    const action = normalizeFilter(args.action, "action");
    const resourceType = args.resourceType === undefined || args.resourceType === null || args.resourceType === ""
      ? null
      : validateResourceType(args.resourceType);
    const from = args.from === undefined || args.from === null || args.from === "" ? null : adminDate(args.from, "from");
    const to = args.to === undefined || args.to === null || args.to === "" ? null : adminDate(args.to, "to");
    if (from && to && from >= to) throw new AiPlatformError("from must be before to", { code: "invalid_request", status: 400 });
    if (actor) { clauses.push("actor = $actor"); params.$actor = actor; }
    if (action) { clauses.push("action = $action"); params.$action = action; }
    if (resourceType) { clauses.push("resource_type = $resourceType"); params.$resourceType = resourceType; }
    if (from) { clauses.push("created_at >= $from"); params.$from = from; }
    if (to) { clauses.push("created_at < $to"); params.$to = to; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM admin_audit ${where}
      ORDER BY id DESC LIMIT $limit OFFSET $offset
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM admin_audit ${where}`).get(withoutPageParams(params));
    return collection(rows.map((row) => ({
      id: integerOrZero(row.id),
      actor: row.actor,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      before: safeJsonView(row.before_json, null),
      after: safeJsonView(row.after_json, null),
      requestId: row.request_id,
      createdAt: row.created_at,
    })), total?.total, { limit, offset });
  }

  function createAgentDraft(args = {}) {
    args = mergeBodyArgs(args);
    const draft = normalizeAgentDraft(writePayload(args, "draft", "payload", "body"), { partial: false });
    if (draft.lifecycle !== "draft") {
      throw new AiPlatformError("createAgentDraft requires lifecycle=draft", { code: "invalid_request", status: 400 });
    }
    const agentId = dbId(args.agentId ?? id("agent"), "agentId");
    return beginWrite(args, "agent.create_draft", "agent", agentId, ({ actor, requestId: rid }) => {
      const duplicate = db.prepare("SELECT id FROM agents WHERE id = $id OR slug = $slug").get({ $id: agentId, $slug: draft.slug });
      if (duplicate) throw new AiPlatformError("Agent id or slug already exists", { code: "conflict", status: 409 });
      validateAgentVersion(db, draft);
      const createdAt = now();
      const versionId = id("agent-version");
      db.prepare(`
        INSERT INTO agents (id, slug, name, description, lifecycle, created_at, updated_at)
        VALUES ($id, $slug, $name, $description, 'draft', $createdAt, $updatedAt)
      `).run({
        $id: agentId,
        $slug: draft.slug,
        $name: draft.name,
        $description: draft.description,
        $createdAt: createdAt,
        $updatedAt: createdAt,
      });
      db.prepare(`
        INSERT INTO agent_versions (
          id, agent_id, version, task_types_json, system_prompt, instructions_json,
          tools_json, model_policy_json, input_schema_json, output_schema_json,
          standard_ids_json, limits_json, created_by, created_at
        ) VALUES (
          $id, $agentId, $version, $taskTypes, $systemPrompt, $instructions,
          $tools, $modelPolicy, $inputSchema, $outputSchema,
          $standardIds, $limits, $createdBy, $createdAt
        )
      `).run({
        $id: versionId,
        $agentId: agentId,
        $version: draft.version ?? "0.1.0",
        $taskTypes: encode(draft.taskTypes),
        $systemPrompt: draft.systemPrompt,
        $instructions: encode(draft.instructions),
        $tools: encode(draft.tools),
        $modelPolicy: encode(draft.modelPolicy),
        $inputSchema: encode(draft.inputSchema),
        $outputSchema: encode(draft.outputSchema),
        $standardIds: encode(draft.standardIds),
        $limits: encode(draft.limits),
        $createdBy: actor,
        $createdAt: createdAt,
      });
      const after = selectAgentSnapshot(db, agentId);
      return {
        value: { ...after, created: true, draftVersionId: versionId, requestId: rid },
        before: null,
        after,
        resourceId: agentId,
      };
    });
  }

  function updateAgentDraft(args = {}) {
    args = mergeBodyArgs(args);
    const agentId = dbId(args.agentId ?? args.id, "agentId");
    const patch = normalizeAgentDraft(writePayload(args, "draft", "payload", "body"), { partial: true });
    if (!Object.keys(patch).length) throw new AiPlatformError("agent draft patch is empty", { code: "invalid_request", status: 400 });
    const condition = requireOptimisticCondition(args, "agent", agentId);
    return beginWrite(args, "agent.update_draft", "agent", agentId, ({ actor, requestId: rid }) => {
      const agent = selectAgent(db, agentId);
      if (!agent) throw new AiPlatformError("Agent not found", { code: "not_found", status: 404 });
      const versions = db.prepare(`
        SELECT * FROM agent_versions WHERE agent_id = $agentId ORDER BY created_at DESC, id DESC
      `).all({ $agentId: agentId });
      const currentVersion = versions[0] ?? null;
      const active = selectActiveRelease(db, agentId);
      assertOptimistic(agent, condition, {
        resourceType: "agent",
        resourceId: agentId,
        currentVersionId: currentVersion?.id ?? null,
        currentReleaseId: active?.id ?? null,
      });
      if (!currentVersion) throw new AiPlatformError("Agent has no version", { code: "invalid_state", status: 409 });

      const versionFields = [
        "version", "taskTypes", "systemPrompt", "instructions", "tools", "modelPolicy",
        "inputSchema", "outputSchema", "standardIds", "limits",
      ];
      const hasVersionPatch = versionFields.some((field) => Object.hasOwn(patch, field));
      const nextVersion = {
        taskTypes: patch.taskTypes ?? parseArray(currentVersion.task_types_json, []),
        systemPrompt: patch.systemPrompt ?? currentVersion.system_prompt,
        instructions: patch.instructions ?? parseObject(currentVersion.instructions_json, {}),
        tools: patch.tools ?? parseArray(currentVersion.tools_json, []),
        modelPolicy: patch.modelPolicy ?? parseObject(currentVersion.model_policy_json, {}),
        inputSchema: patch.inputSchema ?? parseObject(currentVersion.input_schema_json, {}),
        outputSchema: patch.outputSchema ?? parseObject(currentVersion.output_schema_json, {}),
        standardIds: patch.standardIds ?? parseArray(currentVersion.standard_ids_json, []),
        limits: patch.limits ?? parseObject(currentVersion.limits_json, {}),
      };
      if (hasVersionPatch) validateAgentVersion(db, nextVersion);
      const slug = patch.slug ?? agent.slug;
      const name = patch.name ?? agent.name;
      const description = patch.description ?? agent.description;
      const lifecycle = patch.lifecycle ?? agent.lifecycle;
      if (slug !== agent.slug) {
        const duplicate = db.prepare("SELECT id FROM agents WHERE slug = $slug AND id <> $id").get({ $slug: slug, $id: agentId });
        if (duplicate) throw new AiPlatformError("Agent slug already exists", { code: "conflict", status: 409 });
      }
      const before = selectAgentSnapshot(db, agentId);
      const updatedAt = now();
      const updateResult = condition.expectedUpdatedAt
        ? db.prepare(`
            UPDATE agents
               SET slug = $slug, name = $name, description = $description,
                   lifecycle = $lifecycle, updated_at = $updatedAt
             WHERE id = $id AND updated_at = $expectedUpdatedAt
          `).run({
          $slug: slug,
          $name: name,
          $description: description,
          $lifecycle: lifecycle,
          $updatedAt: updatedAt,
          $id: agentId,
          $expectedUpdatedAt: condition.expectedUpdatedAt,
        })
        : db.prepare(`
            UPDATE agents
               SET slug = $slug, name = $name, description = $description,
                   lifecycle = $lifecycle, updated_at = $updatedAt
             WHERE id = $id
          `).run({
          $slug: slug,
          $name: name,
          $description: description,
          $lifecycle: lifecycle,
          $updatedAt: updatedAt,
          $id: agentId,
        });
      if (countChanges(updateResult) !== 1) throw new AiPlatformError("resource was changed by another administrator", { code: "conflict", status: 409 });

      let versionId = currentVersion.id;
      if (hasVersionPatch) {
        const version = patch.version ?? nextPatchVersion(versions);
        assertNoDuplicateVersion(versions, version);
        versionId = id("agent-version");
        db.prepare(`
          INSERT INTO agent_versions (
            id, agent_id, version, task_types_json, system_prompt, instructions_json,
            tools_json, model_policy_json, input_schema_json, output_schema_json,
            standard_ids_json, limits_json, created_by, created_at
          ) VALUES (
            $id, $agentId, $version, $taskTypes, $systemPrompt, $instructions,
            $tools, $modelPolicy, $inputSchema, $outputSchema,
            $standardIds, $limits, $createdBy, $createdAt
          )
        `).run({
          $id: versionId,
          $agentId: agentId,
          $version: version,
          $taskTypes: encode(nextVersion.taskTypes),
          $systemPrompt: nextVersion.systemPrompt,
          $instructions: encode(nextVersion.instructions),
          $tools: encode(nextVersion.tools),
          $modelPolicy: encode(nextVersion.modelPolicy),
          $inputSchema: encode(nextVersion.inputSchema),
          $outputSchema: encode(nextVersion.outputSchema),
          $standardIds: encode(nextVersion.standardIds),
          $limits: encode(nextVersion.limits),
          $createdBy: actor,
          $createdAt: updatedAt,
        });
      }
      const after = selectAgentSnapshot(db, agentId);
      return {
        value: { ...after, updated: true, draftVersionId: versionId === active?.agent_version_id ? null : versionId, requestId: rid },
        before,
        after,
        resourceId: agentId,
      };
    });
  }

  function createStandardDraft(args = {}) {
    args = mergeBodyArgs(args);
    const draft = normalizeStandardDraft(writePayload(args, "draft", "payload", "body"), { partial: false });
    if (draft.lifecycle !== "draft") {
      throw new AiPlatformError("createStandardDraft requires lifecycle=draft", { code: "invalid_request", status: 400 });
    }
    const standardId = dbId(args.standardId ?? id("standard"), "standardId");
    return beginWrite(args, "standard.create_draft", "standard", standardId, ({ actor, requestId: rid }) => {
      const duplicate = db.prepare("SELECT id FROM standards WHERE id = $id OR slug = $slug").get({ $id: standardId, $slug: draft.slug });
      if (duplicate) throw new AiPlatformError("standard id or slug already exists", { code: "conflict", status: 409 });
      const createdAt = now();
      const versionId = id("standard-version");
      db.prepare(`
        INSERT INTO standards (id, slug, name, description, lifecycle, created_at, updated_at)
        VALUES ($id, $slug, $name, $description, 'draft', $createdAt, $updatedAt)
      `).run({
        $id: standardId,
        $slug: draft.slug,
        $name: draft.name,
        $description: draft.description,
        $createdAt: createdAt,
        $updatedAt: createdAt,
      });
      db.prepare(`
        INSERT INTO standard_versions (id, standard_id, version, content, rules_json, created_by, created_at)
        VALUES ($id, $standardId, $version, $content, $rules, $createdBy, $createdAt)
      `).run({
        $id: versionId,
        $standardId: standardId,
        $version: draft.version ?? "0.1.0",
        $content: draft.content,
        $rules: encode(draft.rules),
        $createdBy: actor,
        $createdAt: createdAt,
      });
      const after = selectStandardSnapshot(db, standardId);
      return {
        value: { ...after, created: true, draftVersionId: versionId, requestId: rid },
        before: null,
        after,
        resourceId: standardId,
      };
    });
  }

  function updateStandardDraft(args = {}) {
    args = mergeBodyArgs(args);
    const standardId = dbId(args.standardId ?? args.id, "standardId");
    const patch = normalizeStandardDraft(writePayload(args, "patch", "draft", "changes", "payload", "body"), { partial: true });
    if (!Object.keys(patch).length) throw new AiPlatformError("standard draft patch is empty", { code: "invalid_request", status: 400 });
    const condition = requireOptimisticCondition(args, "standard", standardId);
    return beginWrite(args, "standard.update_draft", "standard", standardId, ({ actor, requestId: rid }) => {
      const standard = selectStandard(db, standardId);
      if (!standard) throw new AiPlatformError("standard not found", { code: "not_found", status: 404 });
      const versions = db.prepare(`
        SELECT * FROM standard_versions WHERE standard_id = $standardId ORDER BY created_at DESC, id DESC
      `).all({ $standardId: standardId });
      const currentVersion = versions[0] ?? null;
      assertOptimistic(standard, condition, {
        resourceType: "standard",
        resourceId: standardId,
        currentVersionId: currentVersion?.id ?? null,
      });
      if (!currentVersion) throw new AiPlatformError("standard has no version", { code: "invalid_state", status: 409 });
      const hasVersionPatch = ["version", "content", "rules"].some((field) => Object.hasOwn(patch, field));
      const slug = patch.slug ?? standard.slug;
      if (slug !== standard.slug) {
        const duplicate = db.prepare("SELECT id FROM standards WHERE slug = $slug AND id <> $id").get({ $slug: slug, $id: standardId });
        if (duplicate) throw new AiPlatformError("standard slug already exists", { code: "conflict", status: 409 });
      }
      const before = selectStandardSnapshot(db, standardId);
      const updatedAt = now();
      const updateResult = condition.expectedUpdatedAt
        ? db.prepare(`
            UPDATE standards
               SET slug = $slug, name = $name, description = $description,
                   lifecycle = $lifecycle, updated_at = $updatedAt
             WHERE id = $id AND updated_at = $expectedUpdatedAt
          `).run({
          $slug: slug,
          $name: patch.name ?? standard.name,
          $description: patch.description ?? standard.description,
          $lifecycle: patch.lifecycle ?? standard.lifecycle,
          $updatedAt: updatedAt,
          $id: standardId,
          $expectedUpdatedAt: condition.expectedUpdatedAt,
        })
        : db.prepare(`
            UPDATE standards
               SET slug = $slug, name = $name, description = $description,
                   lifecycle = $lifecycle, updated_at = $updatedAt
             WHERE id = $id
          `).run({
          $slug: slug,
          $name: patch.name ?? standard.name,
          $description: patch.description ?? standard.description,
          $lifecycle: patch.lifecycle ?? standard.lifecycle,
          $updatedAt: updatedAt,
          $id: standardId,
        });
      if (countChanges(updateResult) !== 1) throw new AiPlatformError("resource was changed by another administrator", { code: "conflict", status: 409 });
      let versionId = currentVersion.id;
      if (hasVersionPatch) {
        const version = patch.version ?? nextPatchVersion(versions);
        assertNoDuplicateVersion(versions, version);
        versionId = id("standard-version");
        db.prepare(`
          INSERT INTO standard_versions (id, standard_id, version, content, rules_json, created_by, created_at)
          VALUES ($id, $standardId, $version, $content, $rules, $createdBy, $createdAt)
        `).run({
          $id: versionId,
          $standardId: standardId,
          $version: version,
          $content: patch.content ?? currentVersion.content,
          $rules: encode(patch.rules ?? parseObject(currentVersion.rules_json, {})),
          $createdBy: actor,
          $createdAt: updatedAt,
        });
      }
      const after = selectStandardSnapshot(db, standardId);
      return {
        value: { ...after, updated: true, draftVersionId: versionId, requestId: rid },
        before,
        after,
        resourceId: standardId,
      };
    });
  }

  function publishAgent(args = {}) {
    args = mergeBodyArgs(args);
    const agentId = dbId(args.agentId ?? args.id, "agentId");
    const condition = requireOptimisticCondition(args, "agent", agentId);
    const testRunId = adminText(args.testRunId ?? args.offlineTestRunId, "testRunId", { max: 200 });
    return beginWrite(args, "agent.publish", "agent", agentId, ({ actor, requestId: rid }) => {
      const agent = selectAgent(db, agentId);
      if (!agent) throw new AiPlatformError("Agent not found", { code: "not_found", status: 404 });
      const versions = db.prepare(`
        SELECT * FROM agent_versions WHERE agent_id = $agentId ORDER BY created_at DESC, id DESC
      `).all({ $agentId: agentId });
      const active = selectActiveRelease(db, agentId);
      const currentVersion = versions[0] ?? null;
      assertOptimistic(agent, condition, {
        resourceType: "agent",
        resourceId: agentId,
        currentVersionId: currentVersion?.id ?? null,
        currentReleaseId: active?.id ?? null,
      });
      const versionId = dbId(args.versionId ?? args.agentVersionId ?? args.draftVersionId ?? currentVersion?.id, "versionId");
      const target = versions.find((version) => version.id === versionId);
      if (!target) throw new AiPlatformError("Agent version not found", { code: "not_found", status: 404 });
      if (active?.agent_version_id === target.id) throw new AiPlatformError("Agent version is already active", { code: "conflict", status: 409 });
      const draft = {
        taskTypes: parseArray(target.task_types_json, []),
        systemPrompt: target.system_prompt,
        instructions: parseObject(target.instructions_json, {}),
        tools: parseArray(target.tools_json, []),
        modelPolicy: parseObject(target.model_policy_json, {}),
        inputSchema: parseObject(target.input_schema_json, {}),
        outputSchema: parseObject(target.output_schema_json, {}),
        standardIds: parseArray(target.standard_ids_json, []),
        limits: parseObject(target.limits_json, {}),
      };
      validateAgentVersion(db, draft);
      ensureNoActiveTaskTypeConflict(db, agentId, draft.taskTypes);
      const before = selectAgentSnapshot(db, agentId);
      const publishedAt = now();
      if (active) {
        const retired = db.prepare(`
          UPDATE agent_releases SET status = 'retired'
           WHERE id = $id AND status = 'active'
        `).run({ $id: active.id });
        if (countChanges(retired) !== 1) throw new AiPlatformError("active release changed during publish", { code: "conflict", status: 409 });
      }
      const releaseId = id("agent-release");
      db.prepare(`
        INSERT INTO agent_releases (
          id, agent_id, agent_version_id, status, test_run_id, published_by, published_at
        ) VALUES ($id, $agentId, $versionId, 'active', $testRunId, $publishedBy, $publishedAt)
      `).run({
        $id: releaseId,
        $agentId: agentId,
        $versionId: target.id,
        $testRunId: testRunId,
        $publishedBy: actor,
        $publishedAt: publishedAt,
      });
      const updated = condition.expectedUpdatedAt
        ? db.prepare(`
            UPDATE agents SET lifecycle = 'active', updated_at = $updatedAt
             WHERE id = $id AND updated_at = $expectedUpdatedAt
          `).run({ $updatedAt: publishedAt, $id: agentId, $expectedUpdatedAt: condition.expectedUpdatedAt })
        : db.prepare(`UPDATE agents SET lifecycle = 'active', updated_at = $updatedAt WHERE id = $id`)
          .run({ $updatedAt: publishedAt, $id: agentId });
      if (countChanges(updated) !== 1) throw new AiPlatformError("Agent changed during publish", { code: "conflict", status: 409 });
      const after = selectAgentSnapshot(db, agentId);
      return {
        value: { ...after, published: true, releaseId, requestId: rid },
        before,
        after,
        resourceId: agentId,
      };
    });
  }

  function rollbackAgent(args = {}) {
    args = mergeBodyArgs(args);
    const agentId = dbId(args.agentId ?? args.id, "agentId");
    const condition = requireOptimisticCondition(args, "agent", agentId);
    const requestedVersionId = args.versionId ?? args.agentVersionId ?? args.targetVersionId ?? null;
    if (requestedVersionId !== null) dbId(requestedVersionId, "versionId");
    const requestedTestRunId = args.testRunId ?? args.offlineTestRunId;
    const testRunId = requestedTestRunId === undefined || requestedTestRunId === null || requestedTestRunId === ""
      ? null
      : adminText(requestedTestRunId, "testRunId", { max: 200 });
    return beginWrite(args, "agent.rollback", "agent", agentId, ({ actor, requestId: rid }) => {
      const agent = selectAgent(db, agentId);
      if (!agent) throw new AiPlatformError("Agent not found", { code: "not_found", status: 404 });
      const active = selectActiveRelease(db, agentId);
      if (!active) throw new AiPlatformError("Agent has no active release to roll back", { code: "invalid_state", status: 409 });
      const currentVersion = latestVersion(db, "agent_versions", "agent_id", agentId);
      assertOptimistic(agent, condition, {
        resourceType: "agent",
        resourceId: agentId,
        currentVersionId: currentVersion?.id ?? null,
        currentReleaseId: active.id,
      });
      const history = db.prepare(`
        SELECT ar.*, av.*
          FROM agent_releases ar
          JOIN agent_versions av ON av.id = ar.agent_version_id
         WHERE ar.agent_id = $agentId
           AND ar.id <> $activeReleaseId
           AND ar.status <> 'active'
         ORDER BY ar.published_at DESC, ar.id DESC
      `).all({ $agentId: agentId, $activeReleaseId: active.id });
      const target = requestedVersionId
        ? db.prepare(`
            SELECT av.*,
                   (SELECT ar.test_run_id FROM agent_releases ar
                     WHERE ar.agent_id = av.agent_id AND ar.agent_version_id = av.id
                     ORDER BY ar.published_at DESC, ar.id DESC LIMIT 1) AS target_test_run_id
              FROM agent_versions av
             WHERE av.agent_id = $agentId AND av.id = $versionId
          `).get({ $agentId: agentId, $versionId: String(requestedVersionId) })
        : (history[0] ?? db.prepare(`
            SELECT av.*,
                   (SELECT ar.test_run_id FROM agent_releases ar
                     WHERE ar.agent_id = av.agent_id AND ar.agent_version_id = av.id
                     ORDER BY ar.published_at DESC, ar.id DESC LIMIT 1) AS target_test_run_id
              FROM agent_versions av
             WHERE av.agent_id = $agentId AND av.id <> $activeVersionId
             ORDER BY av.created_at DESC, av.id DESC
             LIMIT 1
          `).get({ $agentId: agentId, $activeVersionId: active.agent_version_id }));
      if (!target) throw new AiPlatformError("rollback target version not found", { code: "not_found", status: 404 });
      const targetVersionId = target.agent_version_id ?? target.id;
      if (targetVersionId === active.agent_version_id) throw new AiPlatformError("rollback target is already active", { code: "conflict", status: 409 });
      const draft = {
        taskTypes: parseArray(target.task_types_json, []),
        systemPrompt: target.system_prompt,
        instructions: parseObject(target.instructions_json, {}),
        tools: parseArray(target.tools_json, []),
        modelPolicy: parseObject(target.model_policy_json, {}),
        inputSchema: parseObject(target.input_schema_json, {}),
        outputSchema: parseObject(target.output_schema_json, {}),
        standardIds: parseArray(target.standard_ids_json, []),
        limits: parseObject(target.limits_json, {}),
      };
      validateAgentVersion(db, draft);
      const before = selectAgentSnapshot(db, agentId);
      const publishedAt = now();
      const marked = db.prepare(`
        UPDATE agent_releases SET status = 'rolled_back'
         WHERE id = $id AND status = 'active'
      `).run({ $id: active.id });
      if (countChanges(marked) !== 1) throw new AiPlatformError("active release changed during rollback", { code: "conflict", status: 409 });
      const releaseId = id("agent-release");
      db.prepare(`
        INSERT INTO agent_releases (
          id, agent_id, agent_version_id, status, test_run_id, published_by, published_at
        ) VALUES ($id, $agentId, $versionId, 'active', $testRunId, $publishedBy, $publishedAt)
      `).run({
        $id: releaseId,
        $agentId: agentId,
        $versionId: targetVersionId,
        $testRunId: testRunId ?? target.target_test_run_id ?? target.test_run_id ?? null,
        $publishedBy: actor,
        $publishedAt: publishedAt,
      });
      const updated = condition.expectedUpdatedAt
        ? db.prepare(`
            UPDATE agents SET lifecycle = 'active', updated_at = $updatedAt
             WHERE id = $id AND updated_at = $expectedUpdatedAt
          `).run({ $updatedAt: publishedAt, $id: agentId, $expectedUpdatedAt: condition.expectedUpdatedAt })
        : db.prepare(`UPDATE agents SET lifecycle = 'active', updated_at = $updatedAt WHERE id = $id`)
          .run({ $updatedAt: publishedAt, $id: agentId });
      if (countChanges(updated) !== 1) throw new AiPlatformError("Agent changed during rollback", { code: "conflict", status: 409 });
      const after = selectAgentSnapshot(db, agentId);
      return {
        value: { ...after, rolledBack: true, releaseId, targetVersionId, requestId: rid },
        before,
        after,
        resourceId: agentId,
      };
    });
  }

  function updateBudgetPolicy(args = {}) {
    args = mergeBodyArgs(args);
    const policyId = dbId(args.policyId ?? args.budgetId ?? args.id, "policyId");
    const patch = normalizeBudgetPatch(writePayload(args, "patch", "changes", "payload", "body"));
    const condition = requireOptimisticCondition(args, "budget_policy", policyId);
    return beginWrite(args, "budget.update", "budget_policy", policyId, () => {
      const row = db.prepare("SELECT * FROM budget_policies WHERE id = $id").get({ $id: policyId });
      if (!row) throw new AiPlatformError("budget policy not found", { code: "not_found", status: 404 });
      assertOptimistic(row, condition, { resourceType: "budget_policy", resourceId: policyId });
      const before = budgetView(db, row, now(), timeZone);
      const assignments = [];
      const params = { $id: policyId, $updatedAt: now() };
      const fields = {
        amountMicro: ["amount_micro", "$amountMicro"],
        callLimit: ["call_limit", "$callLimit"],
        warningPercent: ["warning_percent", "$warningPercent"],
        enabled: ["enabled", "$enabled"],
      };
      for (const [key, [column, parameter]] of Object.entries(fields)) {
        if (!Object.hasOwn(patch, key)) continue;
        assignments.push(`${column} = ${parameter}`);
        params[parameter] = key === "enabled" ? (patch[key] ? 1 : 0) : patch[key];
      }
      assignments.push("updated_at = $updatedAt");
      const sql = condition.expectedUpdatedAt
        ? `UPDATE budget_policies SET ${assignments.join(", ")} WHERE id = $id AND updated_at = $expectedUpdatedAt`
        : `UPDATE budget_policies SET ${assignments.join(", ")} WHERE id = $id`;
      if (condition.expectedUpdatedAt) params.$expectedUpdatedAt = condition.expectedUpdatedAt;
      const updated = db.prepare(sql).run(params);
      if (countChanges(updated) !== 1) throw new AiPlatformError("budget policy changed during update", { code: "conflict", status: 409 });
      const afterRow = db.prepare("SELECT * FROM budget_policies WHERE id = $id").get({ $id: policyId });
      const after = budgetView(db, afterRow, now(), timeZone);
      return { value: after, before, after, resourceId: policyId };
    });
  }

  function setBudgetEnabled(args = {}) {
    args = mergeBodyArgs(args);
    const enabled = adminBoolean(args.enabled, "enabled");
    return updateBudgetPolicy({ ...args, patch: { enabled } });
  }

  function updateSchedule(args = {}) {
    args = mergeBodyArgs(args);
    const scheduleId = dbId(args.scheduleId ?? args.id, "scheduleId");
    const patch = normalizeSchedulePatch(writePayload(args, "patch", "changes", "payload", "body"));
    const condition = requireOptimisticCondition(args, "schedule", scheduleId);
    return beginWrite(args, "schedule.update", "schedule", scheduleId, () => {
      const row = db.prepare("SELECT * FROM schedules WHERE id = $id").get({ $id: scheduleId });
      if (!row) throw new AiPlatformError("schedule not found", { code: "not_found", status: 404 });
      assertOptimistic(row, condition, { resourceType: "schedule", resourceId: scheduleId });
      const taskType = patch.taskType ?? row.task_type;
      if (!AI_TASK_TYPES.includes(taskType)) throw new AiPlatformError("taskType is invalid", { code: "invalid_request", status: 400 });
      const feature = patch.feature ?? row.feature;
      const name = patch.name ?? row.name;
      const intervalSeconds = patch.intervalSeconds ?? integerOrZero(row.interval_seconds);
      const inputTemplate = patch.inputTemplate ?? parseObject(row.input_template_json, {});
      const enabled = patch.enabled ?? parseBooleanColumn(row.enabled);
      if (enabled && taskType === "proactive.analyze") {
        throw new AiPlatformError("proactive analysis scheduling is owned by the backend worker", {
          code: "proactive_schedule_owned_by_backend",
          status: 409,
        });
      }
      const updatedAt = now();
      let nextRunAt = row.next_run_at;
      if (Object.hasOwn(patch, "enabled")) {
        nextRunAt = enabled
          ? (row.next_run_at ?? new Date(new Date(updatedAt).getTime() + intervalSeconds * 1_000).toISOString())
          : null;
      }
      const before = scheduleView(db, row);
      const params = {
        $id: scheduleId,
        $name: name,
        $taskType: taskType,
        $feature: feature,
        $intervalSeconds: intervalSeconds,
        $enabled: enabled ? 1 : 0,
        $inputTemplate: encode(inputTemplate),
        $nextRunAt: nextRunAt,
        $updatedAt: updatedAt,
      };
      const updated = condition.expectedUpdatedAt
        ? db.prepare(`
            UPDATE schedules
               SET name = $name, task_type = $taskType, feature = $feature,
                   interval_seconds = $intervalSeconds, enabled = $enabled,
                   input_template_json = $inputTemplate, next_run_at = $nextRunAt,
                   updated_at = $updatedAt
             WHERE id = $id AND updated_at = $expectedUpdatedAt
          `).run({ ...params, $expectedUpdatedAt: condition.expectedUpdatedAt })
        : db.prepare(`
            UPDATE schedules
               SET name = $name, task_type = $taskType, feature = $feature,
                   interval_seconds = $intervalSeconds, enabled = $enabled,
                   input_template_json = $inputTemplate, next_run_at = $nextRunAt,
                   updated_at = $updatedAt
             WHERE id = $id
          `).run(params);
      if (countChanges(updated) !== 1) throw new AiPlatformError("schedule changed during update", { code: "conflict", status: 409 });
      const afterRow = db.prepare("SELECT * FROM schedules WHERE id = $id").get({ $id: scheduleId });
      const after = scheduleView(db, afterRow);
      return { value: after, before, after, resourceId: scheduleId };
    });
  }

  function setScheduleEnabled(args = {}) {
    args = mergeBodyArgs(args);
    const enabled = adminBoolean(args.enabled, "enabled");
    return updateSchedule({ ...args, patch: { enabled } });
  }

  return Object.freeze({
    getOverview,
    overview: getOverview,
    listProviders,
    getProvider,
    readProvider: getProvider,
    listModels,
    getModel,
    readModel: getModel,
    listPrices,
    getPrice,
    readPrice: getPrice,
    listAgents,
    getAgent,
    readAgent: getAgent,
    createAgentDraft,
    createAgent: createAgentDraft,
    updateAgentDraft,
    updateAgent: updateAgentDraft,
    publishAgent,
    rollbackAgent,
    listStandards,
    getStandard,
    readStandard: getStandard,
    createStandardDraft,
    createStandard: createStandardDraft,
    updateStandardDraft,
    updateStandard: updateStandardDraft,
    listBudgetPolicies,
    listBudgets: listBudgetPolicies,
    getBudgetPolicy,
    updateBudgetPolicy,
    updateBudget: updateBudgetPolicy,
    setBudgetEnabled,
    listSchedules,
    getSchedule,
    updateSchedule,
    setScheduleEnabled,
    listTasks,
    getTaskDetail,
    getTask: getTaskDetail,
    readTaskDetail: getTaskDetail,
    listTaskAttempts,
    listTaskEvents,
    getTaskAttempt,
    getCostSummary,
    getCosts: getCostSummary,
    costSummary: getCostSummary,
    summarizeCosts: getCostSummary,
    listAudit,
  });
}

export {
  agentVersionView,
  attemptView,
  modelView,
  priceView,
  redactSecrets,
  releaseView,
  scheduleView,
  standardVersionView,
  taskView,
};
