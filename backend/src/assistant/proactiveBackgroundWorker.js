import { createHash, randomUUID } from "node:crypto";

import { buildProactiveAssistantSnapshot } from "./proactiveAssistant.js";
import {
  PROACTIVE_SCAN_DEFAULT_BATCH_SIZE,
  PROACTIVE_SCAN_DEFAULT_INTERVAL_SECONDS,
  PROACTIVE_SCAN_DEFAULT_LEASE_MS,
  PROACTIVE_SCAN_DEFAULT_RETRY_BASE_MS,
  createProactiveScanRepository,
} from "./proactiveScanRepository.js";
import {
  createProactiveModelBudgetRepository,
  stableHash,
} from "./proactiveModelBudgetRepository.js";
import { createProactiveSuggestionRepository } from "./proactiveSuggestionRepository.js";

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const MAX_EVENT_BATCH = 20;
const MAX_ERROR_LENGTH = 500;
const RUN_TRIGGERS = new Set(["scheduled", "event", "manual", "recovery"]);
const DEFAULT_MODEL_CONCURRENCY = 2;
const DEFAULT_MODEL_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_RETRY_LIMIT = 1;
const DEFAULT_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_OWNER_DAILY_LIMIT = 100;
const DEFAULT_MODEL_GLOBAL_DAILY_LIMIT = 1_000;
const DEFAULT_MODEL_BUDGET_TIMEZONE = "Asia/Shanghai";
const MAX_MODEL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MODEL_OWNER_DAILY_LIMIT = 1_000_000;
const MAX_MODEL_GLOBAL_DAILY_LIMIT = 10_000_000;

function validDate(value, name = "date") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function clockDate(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return validDate(clock(), "clock");
}

function text(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name, max = 500) {
  const normalized = text(value, name, max);
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function safeError(error, fallback = "proactive scan failed") {
  const message = String(error?.message ?? "").trim();
  if (!message || message.length > MAX_ERROR_LENGTH || /token|secret|bearer|password|api.?key|cookie/i.test(message)) return fallback;
  return message;
}

function addSeconds(value, seconds) {
  return new Date(value.getTime() + seconds * 1000).toISOString();
}

function compareCursor(leftOwner, leftId, rightOwner, rightId) {
  if (leftOwner !== rightOwner) return leftOwner < rightOwner ? -1 : 1;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name }));
  } catch {
    return false;
  }
}

function modelFailureCode(error) {
  const code = String(error?.code ?? "").trim();
  if (code === "MODEL_DAILY_LIMIT") return "model_daily_limit";
  if (code === "MODEL_TIMEOUT" || /timeout/i.test(String(error?.message ?? ""))) return "model_timeout";
  if (code === "MODEL_SCHEMA_INVALID" || /schema|json|format/i.test(String(error?.message ?? ""))) return "model_schema_invalid";
  if (code === "MODEL_NOT_CONFIGURED" || /not_configured|not configured|api.?key/i.test(String(error?.message ?? ""))) return "model_not_configured";
  return "model_call_failed";
}

function modelSourceLooksReal(source, expectedProvider) {
  const normalized = String(source ?? "").trim().toLowerCase();
  const expected = String(expectedProvider ?? "").trim().toLowerCase();
  if (!normalized || normalized.startsWith("mock") || normalized.includes("fallback")) return false;
  return !expected || normalized === expected || normalized.includes(expected);
}

function modelText(value, max = 1_200) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : "";
}

function evidenceRefKey(type, id) {
  return `${String(type ?? "").trim()}\u0000${String(id ?? "").trim()}`;
}

const PROVENANCE_KEYS = Object.freeze([
  "version",
  "revision",
  "updatedAt",
  "occurredAt",
  "publishedAt",
  "visitDate",
  "due",
  "status",
  "confirmationStatus",
  "voidedAt",
  "identityKey",
  "sourceId",
  "noticeType",
  "contentSha256",
]);

function mergeEvidenceRef(existing, next) {
  const merged = { ...existing };
  for (const key of PROVENANCE_KEYS) {
    if (!Object.hasOwn(next ?? {}, key)) continue;
    const value = next[key];
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
    else if (!Object.hasOwn(merged, key)) merged[key] = value ?? null;
  }
  if (next?.label && !merged.label) merged.label = String(next.label).slice(0, 200);
  if (next?.detail && !merged.detail) merged.detail = String(next.detail).slice(0, 500);
  return merged;
}

/**
 * Keep model additions grounded in the exact server-owned rows sent to the
 * model.  A model may explain or re-rank the facts, but it cannot introduce a
 * new source id, contact, or free-form evidence reference.  Any malformed or
 * ungrounded response is treated as a schema failure and follows the normal
 * deterministic fallback path.
 */
function validateModelEvidence(result, allowedRefs) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    const error = new Error("model schema invalid");
    error.code = "MODEL_SCHEMA_INVALID";
    throw error;
  }
  const allowedByKey = new Map((Array.isArray(allowedRefs) ? allowedRefs : [])
    .filter((ref) => ref && typeof ref.type === "string" && typeof ref.id === "string")
    .map((ref) => [evidenceRefKey(ref.type, ref.id), ref]));
  const explicitRefs = result.sourceRefs ?? result.evidenceRefs ?? [];
  if (!Array.isArray(explicitRefs)) {
    const error = new Error("model sourceRefs must be an array");
    error.code = "MODEL_SCHEMA_INVALID";
    throw error;
  }
  const sourceRefs = [];
  for (const ref of explicitRefs.slice(0, 50)) {
    const type = modelText(ref?.type, 100);
    const id = modelText(ref?.id, 300);
    const allowedRef = type && id ? allowedByKey.get(evidenceRefKey(type, id)) : null;
    if (!allowedRef) {
      const error = new Error("model source reference is not grounded");
      error.code = "MODEL_SCHEMA_INVALID";
      throw error;
    }
    if (!sourceRefs.some((item) => evidenceRefKey(item.type, item.id) === evidenceRefKey(type, id))) {
      sourceRefs.push({ ...allowedRef, type, id });
    }
  }
  const facts = Array.isArray(result.facts) ? result.facts.slice(0, 20).map((item) => {
    const claim = modelText(item?.claim, 1_000);
    const sourceType = modelText(item?.sourceType, 100);
    const sourceId = item?.sourceId === null || item?.sourceId === undefined || item?.sourceId === ""
      ? null
      : modelText(item.sourceId, 300);
    if (!claim || !sourceType || (item?.sourceId !== null && item?.sourceId !== undefined && item?.sourceId !== "" && !sourceId)) {
      const error = new Error("model fact schema invalid");
      error.code = "MODEL_SCHEMA_INVALID";
      throw error;
    }
    if (sourceId && !allowedByKey.has(evidenceRefKey(sourceType, sourceId))) {
      const error = new Error("model fact source is not grounded");
      error.code = "MODEL_SCHEMA_INVALID";
      throw error;
    }
    if (sourceId && !sourceRefs.some((ref) => evidenceRefKey(ref.type, ref.id) === evidenceRefKey(sourceType, sourceId))) {
      sourceRefs.push({
        ...(allowedByKey.get(evidenceRefKey(sourceType, sourceId)) ?? {}),
        type: sourceType,
        id: sourceId,
      });
    }
    return {
      claim,
      sourceType,
      sourceId,
      occurredAt: item?.occurredAt == null ? null : modelText(item.occurredAt, 100) || null,
      confidence: Number.isSafeInteger(item?.confidence) ? Math.max(0, Math.min(100, item.confidence)) : 0,
    };
  }) : [];
  return { ...result, facts, sourceRefs };
}

function mergeEvidenceRefs(...lists) {
  const result = [];
  const indexes = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const ref of list) {
      if (!ref || typeof ref.type !== "string" || typeof ref.id !== "string") continue;
      const type = ref.type.trim();
      const id = ref.id.trim();
      if (!type || !id) continue;
      const key = evidenceRefKey(type, id);
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, result.length);
        result.push(mergeEvidenceRef({ type, id }, ref));
      } else {
        result[existingIndex] = mergeEvidenceRef(result[existingIndex], ref);
      }
    }
  }
  return result.slice(0, 100);
}

function sortEvidenceRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));
}

function stableSuggestionEvidence(suggestion) {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return {};
  const copy = { ...suggestion };
  // Detection/generation timestamps describe when a scan observed a signal;
  // they are not evidence changes and must not defeat the model cache.
  delete copy.generatedAt;
  if (copy.trigger && typeof copy.trigger === "object" && !Array.isArray(copy.trigger)) {
    copy.trigger = { ...copy.trigger };
    delete copy.trigger.detectedAt;
  }
  return copy;
}

function modelCacheResult(result) {
  return {
    source: result?.source ?? null,
    headline: result?.headline ?? null,
    facts: Array.isArray(result?.facts) ? result.facts : [],
    inferences: Array.isArray(result?.inferences) ? result.inferences : [],
    unknowns: Array.isArray(result?.unknowns) ? result.unknowns : [],
    risks: Array.isArray(result?.risks) ? result.risks : [],
    nextActions: Array.isArray(result?.nextActions) ? result.nextActions : [],
    decision: result?.decision && typeof result.decision === "object" && !Array.isArray(result.decision)
      ? result.decision
      : null,
    sourceRefs: Array.isArray(result?.sourceRefs) ? result.sourceRefs : [],
  };
}

function createConcurrencyLimiter(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      active += 1;
      Promise.resolve()
        .then(next.work)
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return (work) => new Promise((resolve, reject) => {
    queue.push({ work, resolve, reject });
    pump();
  });
}

function rowToOpportunity(row) {
  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    owner: row.owner,
    version: Number(row.version ?? 1),
    customerId: row.customer_id,
    customerVersion: Number(row.customer_version ?? 1),
    customerName: row.customer_name ?? row.customer,
    name: row.name,
    stage: row.stage,
    amount: row.amount,
    probability: row.probability,
    days: row.days,
    next: row.next,
    updatedAt: row.updated_at,
    customerUpdatedAt: row.customer_updated_at,
    budget: row.customer_budget ?? row.budget ?? null,
    decisionChain: parseArray(row.customer_decision_chain ?? row.decision_chain).map((item) => (
      typeof item === "string" ? item : item?.name ?? item?.title ?? item?.role ?? ""
    )).filter(Boolean),
    purchaseTime: row.purchase_time ?? row.purchase_window ?? null,
    requirements: parseArray(row.requirements),
    competitors: parseArray(row.competitors),
    solutionDirection: parseArray(row.solution_direction),
    risk: row.risk ?? null,
  };
}

function rowToAction(row) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    version: Number(row.version ?? 1),
    title: row.title,
    status: row.status,
    due: row.due,
    updatedAt: row.updated_at,
  };
}

function rowToInteraction(row) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    customerId: row.customer_id,
    version: Number(row.version ?? 1),
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
    sourceChannel: row.source_channel,
    status: row.status ?? null,
    confirmationStatus: row.status ?? null,
    voidedAt: row.voided_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToKnowledge(row) {
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    title: row.title,
    summary: row.summary,
    revision: row.revision ?? null,
    updatedAt: row.updated_at,
  };
}

function tenderRevision(item) {
  const explicit = item?.revision ?? item?.noticeVersion ?? item?.version;
  if (Number.isSafeInteger(explicit) && explicit >= 1) return explicit;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const digest = typeof item?.contentSha256 === "string" ? item.contentSha256.trim() : "";
  if (digest) return digest;
  // The tender table has no entity version. Derive a stable revision from
  // immutable notice metadata instead of last_seen_at, which changes on
  // every collector poll and would defeat cache reuse.
  return createHash("sha256")
    .update(JSON.stringify({
      identityKey: item?.identityKey ?? item?.id ?? null,
      sourceId: item?.sourceId ?? null,
      title: item?.title ?? null,
      publishedAt: item?.publishedAt ?? null,
      noticeType: item?.noticeType ?? null,
      sourceItemId: item?.sourceItemId ?? null,
    }), "utf8")
    .digest("hex");
}

function normalizedOwners(value) {
  const source = typeof value === "function" ? value() : value;
  if (!Array.isArray(source)) throw new TypeError("ownersProvider must return an array");
  return [...new Set(source.map((entry) => {
    const owner = typeof entry === "string" ? entry : entry?.owner ?? entry?.account;
    return String(owner ?? "").trim();
  }).filter(Boolean))].sort();
}

function emptyCustomerSubjectScan({ enabled = false } = {}) {
  return {
    enabled,
    status: enabled ? "idle" : "disabled",
    attemptedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    subjectCount: 0,
    suggestionCount: 0,
    insertedCount: 0,
    dedupedCount: 0,
    results: [],
    errors: [],
  };
}

function addCustomerSubjectScan(left, right) {
  const merged = {
    enabled: Boolean(left?.enabled || right?.enabled),
    status: "success",
    attemptedCount: Number(left?.attemptedCount ?? 0) + Number(right?.attemptedCount ?? 0),
    succeededCount: Number(left?.succeededCount ?? 0) + Number(right?.succeededCount ?? 0),
    failedCount: Number(left?.failedCount ?? 0) + Number(right?.failedCount ?? 0),
    subjectCount: Number(left?.subjectCount ?? 0) + Number(right?.subjectCount ?? 0),
    suggestionCount: Number(left?.suggestionCount ?? 0) + Number(right?.suggestionCount ?? 0),
    insertedCount: Number(left?.insertedCount ?? 0) + Number(right?.insertedCount ?? 0),
    dedupedCount: Number(left?.dedupedCount ?? 0) + Number(right?.dedupedCount ?? 0),
    results: [...(Array.isArray(left?.results) ? left.results : []), ...(Array.isArray(right?.results) ? right.results : [])],
    errors: [...(Array.isArray(left?.errors) ? left.errors : []), ...(Array.isArray(right?.errors) ? right.errors : [])],
  };
  merged.status = merged.failedCount > 0
    ? (merged.succeededCount > 0 ? "partial" : "failed")
    : (merged.attemptedCount > 0 ? "success" : (merged.enabled ? "idle" : "disabled"));
  return merged;
}

function customerSubjectResult({ owner, customerId, syncResult }) {
  const subject = syncResult?.subject ?? syncResult?.customerSubject ?? null;
  const suggestions = Array.isArray(syncResult?.suggestions)
    ? syncResult.suggestions
    : Array.isArray(syncResult?.items)
      ? syncResult.items
      : [];
  return {
    status: "success",
    owner,
    customerId,
    identity: subject?.identity ?? `customer:${owner}:${customerId}`,
    subjectType: subject?.subjectType ?? "customer",
    subjectId: subject?.subjectId ?? customerId,
    version: Number.isSafeInteger(subject?.version) ? subject.version : (syncResult?.revision ?? null),
    sourceDigest: subject?.sourceDigest ?? syncResult?.sourceDigest ?? null,
    suggestionCount: Number.isSafeInteger(subject?.suggestionCount)
      ? subject.suggestionCount
      : suggestions.length,
    insertedCount: Number(syncResult?.insertedCount ?? 0),
    dedupedCount: Number(syncResult?.dedupedCount ?? 0),
  };
}

/**
 * A process-owned, timer-backed proactive scanner.  It never depends on a
 * browser request: `start()` is intended to be called while the backend is
 * running, and `runOnce()` is available to a service/cron entry point or a
 * deterministic test.  SQLite state, cursor and leases make a restart safe.
 */
export function createProactiveBackgroundWorker({
  db,
  scanRepository = null,
  suggestionRepository = null,
  customerProactiveSubjectService = null,
  // Keep the shorter alias for feature owners that already use the service
  // under this name. The canonical injection point is the full option above.
  customerSubjectService = null,
  snapshotBuilder = buildProactiveAssistantSnapshot,
  clock = () => new Date(),
  idFactory = randomUUID,
  leaseTokenFactory = randomUUID,
  workerId = null,
  ownersProvider = null,
  batchSize = PROACTIVE_SCAN_DEFAULT_BATCH_SIZE,
  intervalSeconds = PROACTIVE_SCAN_DEFAULT_INTERVAL_SECONDS,
  intervalMinutes = null,
  leaseMs = PROACTIVE_SCAN_DEFAULT_LEASE_MS,
  retryBaseMs = PROACTIVE_SCAN_DEFAULT_RETRY_BASE_MS,
  staleDays = undefined,
  eventBatchSize = MAX_EVENT_BATCH,
  pollMs = 30_000,
  modelAnalyzer = null,
  modelProvider = null,
  modelName = null,
  modelConcurrency = DEFAULT_MODEL_CONCURRENCY,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  modelRetryLimit = DEFAULT_MODEL_RETRY_LIMIT,
  modelCacheTtlMs = DEFAULT_MODEL_CACHE_TTL_MS,
  modelOwnerDailyLimit = DEFAULT_MODEL_OWNER_DAILY_LIMIT,
  modelGlobalDailyLimit = DEFAULT_MODEL_GLOBAL_DAILY_LIMIT,
  modelBudgetTimezone = DEFAULT_MODEL_BUDGET_TIMEZONE,
  includeExtendedSignals = false,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof snapshotBuilder !== "function") throw new TypeError("snapshotBuilder must be a function");
  if (typeof idFactory !== "function" || typeof leaseTokenFactory !== "function") throw new TypeError("idFactory and leaseTokenFactory are required");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError("batchSize is invalid");
  const configuredIntervalSeconds = intervalMinutes === null || intervalMinutes === undefined
    ? intervalSeconds
    : intervalMinutes * 60;
  if (!Number.isSafeInteger(configuredIntervalSeconds) || configuredIntervalSeconds < 30 || configuredIntervalSeconds > 24 * 60 * 60) throw new TypeError("intervalSeconds is invalid");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1000) throw new TypeError("leaseMs is invalid");
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 24 * 60 * 60 * 1000) throw new TypeError("retryBaseMs is invalid");
  if (!Number.isSafeInteger(eventBatchSize) || eventBatchSize < 1 || eventBatchSize > MAX_EVENT_BATCH) throw new TypeError("eventBatchSize is invalid");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > MAX_TIMER_DELAY) throw new TypeError("pollMs is invalid");
  if (modelAnalyzer !== null && typeof modelAnalyzer !== "function") throw new TypeError("modelAnalyzer must be a function");
  if (!Number.isSafeInteger(modelConcurrency) || modelConcurrency < 1 || modelConcurrency > 20) throw new TypeError("modelConcurrency is invalid");
  if (!Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 100 || modelTimeoutMs > 10 * 60 * 1000) throw new TypeError("modelTimeoutMs is invalid");
  if (!Number.isSafeInteger(modelRetryLimit) || modelRetryLimit < 0 || modelRetryLimit > 3) throw new TypeError("modelRetryLimit is invalid");
  if (!Number.isSafeInteger(modelCacheTtlMs) || modelCacheTtlMs < 1_000 || modelCacheTtlMs > MAX_MODEL_CACHE_TTL_MS) throw new TypeError("modelCacheTtlMs is invalid");
  if (!Number.isSafeInteger(modelOwnerDailyLimit) || modelOwnerDailyLimit < 1 || modelOwnerDailyLimit > MAX_MODEL_OWNER_DAILY_LIMIT) throw new TypeError("modelOwnerDailyLimit is invalid");
  if (!Number.isSafeInteger(modelGlobalDailyLimit) || modelGlobalDailyLimit < 1 || modelGlobalDailyLimit > MAX_MODEL_GLOBAL_DAILY_LIMIT) throw new TypeError("modelGlobalDailyLimit is invalid");
  if (typeof modelBudgetTimezone !== "string" || !modelBudgetTimezone.trim()) throw new TypeError("modelBudgetTimezone is invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: modelBudgetTimezone }).format(new Date());
  } catch {
    throw new TypeError("modelBudgetTimezone is invalid");
  }
  if (typeof includeExtendedSignals !== "boolean") throw new TypeError("includeExtendedSignals must be boolean");
  if (ownersProvider !== null && typeof ownersProvider !== "function") throw new TypeError("ownersProvider must be a function");

  const scan = scanRepository ?? createProactiveScanRepository(db, {
    clock,
    idFactory,
    leaseTokenFactory,
  });
  const suggestions = suggestionRepository ?? createProactiveSuggestionRepository(db, { clock, idFactory });
  if (customerProactiveSubjectService && customerSubjectService
    && customerProactiveSubjectService !== customerSubjectService) {
    throw new TypeError("customer proactive subject service options must refer to the same service");
  }
  const customerSubjects = customerProactiveSubjectService ?? customerSubjectService;
  if (!scan || typeof scan.getState !== "function" || typeof scan.tryAcquireLease !== "function") {
    throw new TypeError("scanRepository is invalid");
  }
  if (!suggestions || typeof suggestions.save !== "function") throw new TypeError("suggestionRepository is invalid");
  if (customerSubjects !== null && (typeof customerSubjects !== "object" || typeof customerSubjects.syncCustomer !== "function")) {
    throw new TypeError("customerProactiveSubjectService is invalid");
  }
  if (customerSubjects?.suggestionRepository && customerSubjects.suggestionRepository !== suggestions) {
    throw new TypeError("customerProactiveSubjectService must use the shared suggestionRepository");
  }

  const configuredWorkerId = identifier(workerId ?? `proactive-worker-${idFactory()}`, "workerId");
  let timer = null;
  let started = false;
  let ticking = false;
  let lastCustomerSubjectScan = emptyCustomerSubjectScan({ enabled: Boolean(customerSubjects) });
  const modelQueue = createConcurrencyLimiter(modelConcurrency);
  const modelRuntime = modelAnalyzer && tableExists(db, "proactive_model_cache") && tableExists(db, "proactive_model_usage")
    ? createProactiveModelBudgetRepository(db, {
      clock,
      timeZone: modelBudgetTimezone,
    })
    : null;

  async function modelEnrichment({ suggestion, opportunity, actions, interactions, risks = [], itineraries = [], tenders = [], knowledge = [] }) {
    if (!modelAnalyzer) return suggestion;
    const context = {
      analysisType: "opportunity_diagnosis",
      industry: "general",
      customer: {
        id: opportunity.customerId,
        name: opportunity.customerName,
        budget: opportunity.budget,
        decisionChain: opportunity.decisionChain,
      },
      opportunity: {
        id: opportunity.id,
        customerId: opportunity.customerId,
        name: opportunity.name,
        stage: opportunity.stage,
        amount: opportunity.amount,
        next: opportunity.next,
        requirements: opportunity.requirements,
        competitors: opportunity.competitors,
        solutionDirection: opportunity.solutionDirection,
        risk: opportunity.risk,
      },
      // Interaction text is intentionally not passed to the model.  The
      // scanner only exposes bounded identifiers, timestamps and channels.
      actions: actions.slice(0, 20).map((item) => ({
        id: item.id,
        title: item.title,
        due: item.due,
        status: item.status,
      })),
      // Keep the model aware of the recency and channel evidence that drove
      // the deterministic signal, while deliberately excluding raw quick
      // record text.  Sibling-opportunity rows are filtered by processRows
      // before they reach this context.
      interactions: interactions.slice(0, 50).map((item) => ({
        id: item.id,
        opportunityId: item.opportunityId ?? null,
        customerId: item.customerId ?? null,
        occurredAt: item.occurredAt ?? null,
        sourceChannel: item.sourceChannel ?? null,
        status: item.status ?? null,
      })),
      quickRecord: null,
      risks: risks.slice(0, 20).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        severity: item.severity,
        due: item.due,
      })),
      itineraries: itineraries
        .filter((item) => (!item.opportunityId || item.opportunityId === opportunity.id)
          && (!item.customerId || item.customerId === opportunity.customerId))
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          title: item.title,
          visitDate: item.visitDate,
          status: item.status,
        })),
      tenders: tenders
        .filter((item) => !item.customerId || item.customerId === opportunity.customerId)
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          identityKey: item.identityKey ?? item.id,
          title: item.title,
          noticeType: item.noticeType,
          publishedAt: item.publishedAt,
          sourceId: item.sourceId,
        })),
      knowledge: knowledge.slice(0, 8).map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
      })),
      sourceRefs: mergeEvidenceRefs(
        suggestion.sourceRefs,
        // A custom snapshot builder may provide only the opportunity id. Add
        // the server-owned entity rows here as well so the model context and
        // its allow-list always carry the current opportunity/customer
        // version and update timestamp, not just whatever the builder kept.
        [{
          type: "opportunity",
          id: opportunity.id,
          version: opportunity.version,
          updatedAt: opportunity.updatedAt,
        }],
        [{
          type: "customer",
          id: opportunity.customerId,
          version: opportunity.customerVersion,
          updatedAt: opportunity.customerUpdatedAt,
        }],
        interactions.map((item) => ({ type: "quick_record", id: item.id, ...item })),
        actions.map((item) => ({ type: "action_item", id: item.id, ...item })),
        risks.map((item) => ({ type: "risk_item", id: item.id, ...item })),
        itineraries.map((item) => ({ type: "visit_itinerary", id: item.id, ...item })),
        tenders.map((item) => ({ type: "hospital_tender_notice", id: item.id, ...item })),
        knowledge.map((item) => ({ type: "knowledge", id: item.id, ...item })),
      ),
    };
    const allowedEvidenceRefs = context.sourceRefs;
    const ruleVersion = suggestion.modelVersion ?? suggestion.schemaVersion ?? "proactive-v1";
    // Hash all server-owned, bounded evidence rows (including version/time
    // columns when available) independently from model identity.  Sorting by
    // id makes the digest stable even when SQLite returns equal-order rows in
    // a different physical order after a restart.
    const evidenceHash = stableHash({
      owner: opportunity.owner ?? null,
      opportunity: stableSuggestionEvidence(opportunity),
      actions: sortEvidenceRows(actions).slice(0, 20),
      interactions: sortEvidenceRows(interactions).slice(0, 50),
      risks: sortEvidenceRows(risks).slice(0, 20),
      itineraries: sortEvidenceRows(itineraries
        .filter((item) => (!item.opportunityId || item.opportunityId === opportunity.id)
          && (!item.customerId || item.customerId === opportunity.customerId))).slice(0, 20),
      tenders: sortEvidenceRows(tenders
        .filter((item) => !item.customerId || item.customerId === opportunity.customerId)).slice(0, 20),
      knowledge: sortEvidenceRows(knowledge).slice(0, 8),
      suggestion: stableSuggestionEvidence(suggestion),
      sourceRefs: sortEvidenceRows(context.sourceRefs),
    });
    const payloadHash = stableHash({
      contractVersion: "proactive-model-v1",
      evidenceHash,
      modelProvider: modelProvider ?? "",
      modelName: modelName ?? "",
      ruleVersion,
    });
    const cacheKey = {
      owner: opportunity.owner,
      evidenceHash,
      payloadHash,
      modelProvider,
      modelName,
      ruleVersion,
    };
    const applyModelResult = (validatedResult, startedAt, { cacheHit = false } = {}) => {
      const modelFacts = validatedResult.facts;
      const modelInferences = Array.isArray(validatedResult.inferences) ? validatedResult.inferences.slice(0, 12) : [];
      const modelUnknowns = Array.isArray(validatedResult.unknowns) ? validatedResult.unknowns.slice(0, 12) : [];
      const modelRisks = Array.isArray(validatedResult.risks) ? validatedResult.risks.slice(0, 12) : [];
      const modelNextActions = Array.isArray(validatedResult.nextActions) ? validatedResult.nextActions.slice(0, 5) : [];
      const confidence = Number.isSafeInteger(validatedResult.decision?.confidence)
        ? validatedResult.decision.confidence
        : null;
      return {
        ...suggestion,
        conclusion: validatedResult.headline || suggestion.conclusion,
        facts: [...suggestion.facts, ...modelFacts.map((item) => ({
          key: `model.${item.sourceType ?? "fact"}`,
          label: "模型补充事实",
          value: item.claim,
          sourceRefs: item.sourceId
            ? [allowedEvidenceRefs.find((ref) => evidenceRefKey(ref.type, ref.id) === evidenceRefKey(item.sourceType, item.sourceId))
              ?? { type: item.sourceType, id: item.sourceId }]
            : suggestion.sourceRefs,
        }))].slice(0, 50),
        inferences: [...suggestion.inferences, ...modelInferences.map((item) => ({
          claim: item.claim,
          basis: item.basis,
          sourceRefs: suggestion.sourceRefs,
        }))].slice(0, 30),
        unknowns: [...suggestion.unknowns, ...modelUnknowns.map((item) => ({
          key: "model.unknown",
          question: item.question,
          reason: item.impact,
        }))].slice(0, 30),
        risks: [...suggestion.risks, ...modelRisks.map((item) => item.summary)].slice(0, 20),
        nextActions: [...suggestion.nextActions, ...modelNextActions.map((item) => ({
          type: "action_item",
          title: item.action,
          detail: item.expectedOutcome,
        }))].slice(0, 10),
        confidence,
        confidenceLevel: "model",
        confidenceCalibrated: false,
        modelVersion: `${modelProvider ?? "model"}/${modelName ?? "unknown"}`,
        modelProvider: modelProvider ?? null,
        modelName: modelName ?? null,
        modelLatencyMs: cacheHit ? 0 : Date.now() - startedAt,
        modelEvidenceHash: evidenceHash,
        modelPayloadHash: payloadHash,
        modelCacheHit: cacheHit,
        sourceRefs: mergeEvidenceRefs(suggestion.sourceRefs, validatedResult.sourceRefs),
        evidenceRefs: mergeEvidenceRefs(suggestion.evidenceRefs, validatedResult.sourceRefs),
        source: "model",
        fallbackReason: null,
        modelAttempted: !cacheHit,
      };
    };

    if (modelRuntime) {
      const cached = modelRuntime.getCache(cacheKey, { at: clockDate(clock) });
      if (cached) {
        try {
          const validatedCached = validateModelEvidence(cached.result, allowedEvidenceRefs);
          if (modelSourceLooksReal(validatedCached.source, modelProvider)) {
            return applyModelResult(validatedCached, Date.now(), { cacheHit: true });
          }
        } catch {
          // An invalid or no-longer-grounded cache row is ignored. The next
          // provider call will replace it with a result for this evidence.
        }
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt <= modelRetryLimit; attempt += 1) {
      const startedAt = Date.now();
      try {
        const result = await modelQueue(async () => {
          if (modelRuntime) {
            const budget = modelRuntime.reserve({
              owner: opportunity.owner,
              at: clockDate(clock),
              ownerDailyLimit: modelOwnerDailyLimit,
              globalDailyLimit: modelGlobalDailyLimit,
            });
            if (!budget.allowed) {
              const error = new Error("model daily limit reached");
              error.code = "MODEL_DAILY_LIMIT";
              error.budget = budget;
              throw error;
            }
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), modelTimeoutMs);
          try {
            return await modelAnalyzer(context, {
              signal: controller.signal,
              attempt: attempt + 1,
              timeoutMs: modelTimeoutMs,
              provider: modelProvider,
              model: modelName,
            });
          } catch (error) {
            if (controller.signal.aborted && !error.code) error.code = "MODEL_TIMEOUT";
            throw error;
          } finally {
            clearTimeout(timer);
          }
        });
        const validatedResult = validateModelEvidence(result, allowedEvidenceRefs);
        if (!modelSourceLooksReal(validatedResult.source, modelProvider)) {
          const error = new Error("model returned fallback result");
          error.code = "MODEL_FALLBACK";
          throw error;
        }
        if (modelRuntime) {
          const generatedAt = clockDate(clock);
          try {
            modelRuntime.saveCache(cacheKey, {
              result: modelCacheResult(validatedResult),
              generatedAt,
              expiresAt: new Date(generatedAt.getTime() + modelCacheTtlMs),
            });
          } catch {
            // A successful provider response remains usable even if a cache
            // write is unavailable; the next run will simply call the model.
          }
        }
        return applyModelResult(validatedResult, startedAt);
      } catch (error) {
        lastError = error;
        if (error?.code === "MODEL_DAILY_LIMIT" || attempt >= modelRetryLimit) break;
      }
    }
    return {
      ...suggestion,
      source: "deterministic",
      modelAttempted: true,
      modelProvider: modelProvider ?? null,
      modelName: modelName ?? null,
      modelEvidenceHash: evidenceHash,
      modelPayloadHash: payloadHash,
      modelCacheHit: false,
      fallbackReason: modelFailureCode(lastError),
      modelError: safeError(lastError, "model call failed"),
    };
  }

  function getState() {
    const state = scan.getState();
    if (!state) throw new Error("proactive scan state is not initialized");
    return state;
  }

  function ensureStateDefaults() {
    const state = getState();
    const patch = {};
    if (!Number.isSafeInteger(state.intervalSeconds) || state.intervalSeconds < 30) patch.intervalSeconds = configuredIntervalSeconds;
    if (!Number.isSafeInteger(state.batchSize) || state.batchSize < 1) patch.batchSize = batchSize;
    return Object.keys(patch).length > 0 ? scan.updateState(patch) : state;
  }

  function ownerList() {
    if (ownersProvider) return normalizedOwners(ownersProvider());
    return db.prepare(`
      SELECT DISTINCT owner
        FROM opportunities
       WHERE owner IS NOT NULL AND trim(owner) <> ''
         AND deleted_at IS NULL
       ORDER BY owner
    `).all().map((row) => row.owner).filter(Boolean);
  }

  function opportunityCount(owner = null) {
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
        FROM opportunities
       WHERE owner IS NOT NULL AND trim(owner) <> ''
         AND deleted_at IS NULL
         AND ($owner IS NULL OR owner = $owner)
    `).get({ $owner: normalizedOwner }).count);
  }

  function queryOpportunities({ cursorOwner = null, cursorOpportunityId = null, limit, owner = null } = {}) {
    const bounded = Number.isSafeInteger(limit) ? limit : getState().batchSize;
    const allowedOwners = ownersProvider ? normalizedOwners(ownersProvider()) : null;
    if (allowedOwners && allowedOwners.length === 0) return { rows: [], hasMore: false };
    const allowedOwnerPlaceholders = allowedOwners?.map((_, index) => `$allowedOwner${index}`).join(", ");
    const allowedOwnerParams = allowedOwners
      ? Object.fromEntries(allowedOwners.map((value, index) => [`$allowedOwner${index}`, value]))
      : {};
    const rows = db.prepare(`
      SELECT opportunity.id, opportunity.version, opportunity.customer_id, opportunity.name,
             opportunity.customer, opportunity.stage, opportunity.amount, opportunity.probability,
             opportunity.days, opportunity.next, opportunity.owner, opportunity.updated_at,
             opportunity.requirements, opportunity.competitors, opportunity.solution_direction, opportunity.risk,
             customer.name AS customer_name, customer.version AS customer_version,
             customer.updated_at AS customer_updated_at,
             customer.budget AS customer_budget, customer.decision_chain AS customer_decision_chain
        FROM opportunities opportunity
        INNER JOIN customers customer
          ON customer.id = opportunity.customer_id
         AND customer.deleted_at IS NULL
         AND customer.owner = opportunity.owner
       WHERE opportunity.deleted_at IS NULL
         AND opportunity.owner IS NOT NULL
         AND trim(opportunity.owner) <> ''
         AND ($owner IS NULL OR opportunity.owner = $owner)
         ${allowedOwners ? `AND opportunity.owner IN (${allowedOwnerPlaceholders})` : ""}
         AND (
           $cursorOwner IS NULL
           OR opportunity.owner > $cursorOwner
           OR (opportunity.owner = $cursorOwner AND opportunity.id > $cursorOpportunityId)
         )
       ORDER BY opportunity.owner ASC, opportunity.id ASC
       LIMIT $limit
    `).all({
      $owner: owner === null || owner === undefined ? null : identifier(owner, "owner", 200),
      $cursorOwner: cursorOwner === null || cursorOwner === undefined ? null : identifier(cursorOwner, "cursorOwner"),
      $cursorOpportunityId: cursorOpportunityId === null || cursorOpportunityId === undefined ? "" : identifier(cursorOpportunityId, "cursorOpportunityId"),
      $limit: Math.min(501, bounded + 1),
      ...allowedOwnerParams,
    });
    const hasMore = rows.length > bounded;
    return { rows: (hasMore ? rows.slice(0, bounded) : rows).map(rowToOpportunity), hasMore };
  }

  function queryOpportunityById(owner, opportunityId) {
    const normalizedOwner = identifier(owner, "owner", 200);
    if (ownersProvider && !normalizedOwners(ownersProvider()).includes(normalizedOwner)) return [];
    const rows = db.prepare(`
      SELECT opportunity.id, opportunity.version, opportunity.customer_id, opportunity.name,
             opportunity.customer, opportunity.stage, opportunity.amount, opportunity.probability,
             opportunity.days, opportunity.next, opportunity.owner, opportunity.updated_at,
             opportunity.requirements, opportunity.competitors, opportunity.solution_direction, opportunity.risk,
             customer.name AS customer_name, customer.version AS customer_version,
             customer.updated_at AS customer_updated_at,
             customer.budget AS customer_budget, customer.decision_chain AS customer_decision_chain
        FROM opportunities opportunity
        INNER JOIN customers customer
          ON customer.id = opportunity.customer_id
         AND customer.deleted_at IS NULL
         AND customer.owner = opportunity.owner
       WHERE opportunity.owner = $owner
         AND opportunity.id = $id
         AND opportunity.deleted_at IS NULL
       LIMIT 1
    `).all({ $owner: normalizedOwner, $id: identifier(opportunityId, "opportunityId") });
    return rows.map(rowToOpportunity);
  }

  function queryOpportunitiesByCustomerId(owner, customerId, limit = getState().batchSize) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const normalizedCustomerId = identifier(customerId, "customerId");
    if (ownersProvider && !normalizedOwners(ownersProvider()).includes(normalizedOwner)) return [];
    const bounded = Number.isSafeInteger(limit) ? limit : getState().batchSize;
    const rows = db.prepare(`
      SELECT opportunity.id, opportunity.version, opportunity.customer_id, opportunity.name,
             opportunity.customer, opportunity.stage, opportunity.amount, opportunity.probability,
             opportunity.days, opportunity.next, opportunity.owner, opportunity.updated_at,
             opportunity.requirements, opportunity.competitors, opportunity.solution_direction, opportunity.risk,
             customer.name AS customer_name, customer.version AS customer_version,
             customer.updated_at AS customer_updated_at,
             customer.budget AS customer_budget, customer.decision_chain AS customer_decision_chain
        FROM opportunities opportunity
        INNER JOIN customers customer
          ON customer.id = opportunity.customer_id
         AND customer.deleted_at IS NULL
         AND customer.owner = opportunity.owner
       WHERE opportunity.owner = $owner
         AND opportunity.customer_id = $customerId
         AND opportunity.deleted_at IS NULL
       ORDER BY opportunity.owner ASC, opportunity.id ASC
       LIMIT $limit
    `).all({
      $owner: normalizedOwner,
      $customerId: normalizedCustomerId,
      $limit: Math.min(500, bounded),
    });
    return rows.map(rowToOpportunity);
  }

  function queryOpportunitiesByCustomerIds(owner, customerIds, limit = 500) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const normalizedCustomerIds = [...new Set((Array.isArray(customerIds) ? customerIds : [])
      .map((value) => identifier(value, "customerId")))];
    if (normalizedCustomerIds.length === 0) return [];
    if (ownersProvider && !normalizedOwners(ownersProvider()).includes(normalizedOwner)) return [];
    const bounded = Number.isSafeInteger(limit) ? Math.min(500, limit) : 500;
    const placeholders = normalizedCustomerIds.map((_, index) => `$customerId${index}`).join(", ");
    const params = {
      $owner: normalizedOwner,
      $limit: bounded,
      ...Object.fromEntries(normalizedCustomerIds.map((value, index) => [`$customerId${index}`, value])),
    };
    const rows = db.prepare(`
      SELECT opportunity.id, opportunity.version, opportunity.customer_id, opportunity.name,
             opportunity.customer, opportunity.stage, opportunity.amount, opportunity.probability,
             opportunity.days, opportunity.next, opportunity.owner, opportunity.updated_at,
             customer.name AS customer_name, customer.version AS customer_version,
             customer.updated_at AS customer_updated_at
        FROM opportunities opportunity
        INNER JOIN customers customer
          ON customer.id = opportunity.customer_id
         AND customer.deleted_at IS NULL
         AND customer.owner = opportunity.owner
       WHERE opportunity.owner = $owner
         AND opportunity.customer_id IN (${placeholders})
         AND opportunity.deleted_at IS NULL
       ORDER BY opportunity.owner ASC, opportunity.id ASC
       LIMIT $limit
    `).all(params);
    return rows.map(rowToOpportunity);
  }

  function customerSignalRows() {
    if (!customerSubjects) return [];
    const allowedOwners = ownersProvider ? new Set(normalizedOwners(ownersProvider())) : null;
    const candidates = new Map();
    const addCandidate = (ownerValue, customerIdValue) => {
      const owner = String(ownerValue ?? "").trim();
      const customerId = String(customerIdValue ?? "").trim();
      if (!owner || !customerId || (allowedOwners && !allowedOwners.has(owner))) return;
      candidates.set(`${owner}\u0000${customerId}`, { owner, customerId });
    };
    const directRows = db.prepare(`
      SELECT customer.owner, customer.id AS customer_id
        FROM customers customer
       WHERE customer.deleted_at IS NULL
         AND customer.owner IS NOT NULL
         AND trim(customer.owner) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM opportunities opportunity
            WHERE opportunity.owner = customer.owner
              AND opportunity.customer_id = customer.id
              AND opportunity.deleted_at IS NULL
         )
         AND (
           EXISTS (
             SELECT 1 FROM action_items action
              WHERE action.owner = customer.owner
                AND action.customer_id = customer.id
                AND action.deleted_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM risk_items risk
              WHERE risk.owner = customer.owner
                AND risk.customer_id = customer.id
                AND risk.deleted_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM quick_records interaction
              WHERE interaction.owner = customer.owner
                AND interaction.customer_id = customer.id
                AND interaction.voided_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM proactive_subjects subject
              WHERE subject.owner = customer.owner
                AND subject.customer_id = customer.id
           )
         )
       ORDER BY customer.owner ASC, customer.id ASC
    `).all();
    for (const row of directRows) addCandidate(row.owner, row.customer_id);

    const selectCustomer = db.prepare(`
      SELECT customer.owner, customer.id
        FROM customers customer
       WHERE customer.id = $customerId
         AND ($owner IS NULL OR customer.owner = $owner)
         AND customer.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM opportunities opportunity
            WHERE opportunity.owner = customer.owner
              AND opportunity.customer_id = customer.id
              AND opportunity.deleted_at IS NULL
         )
       LIMIT 1
    `);
    const addOwnedCustomer = (ownerValue, customerIdValue) => {
      const owner = String(ownerValue ?? "").trim();
      const customerId = String(customerIdValue ?? "").trim();
      if (!customerId || (owner && allowedOwners && !allowedOwners.has(owner))) return;
      const row = selectCustomer.get({ $owner: owner || null, $customerId: customerId });
      if (row) addCandidate(row.owner, row.id);
    };

    if (tableExists(db, "visit_itineraries")) {
      const itineraries = db.prepare(`
        SELECT owner, request_json, plan_json
          FROM visit_itineraries
         WHERE deleted_at IS NULL AND status <> 'cancelled'
      `).all();
      for (const row of itineraries) {
        let request = {};
        let plan = {};
        try { request = JSON.parse(row.request_json ?? "{}"); } catch {}
        try { plan = JSON.parse(row.plan_json ?? "{}"); } catch {}
        addOwnedCustomer(
          row.owner,
          request.customerId ?? request.customer_id ?? plan.customerId ?? plan.customer_id ?? null,
        );
      }
    }

    if (tableExists(db, "hospital_tender_notices")) {
      const notices = db.prepare(`
        SELECT match_customer_ids_json
          FROM hospital_tender_notices
         ORDER BY published_at DESC, id DESC
         LIMIT 200
      `).all();
      for (const row of notices) {
        let customerIds = [];
        try { customerIds = JSON.parse(row.match_customer_ids_json ?? "[]"); } catch {}
        for (const customerId of Array.isArray(customerIds) ? customerIds : []) {
          addOwnedCustomer(null, customerId);
        }
      }
    }

    return [...candidates.values()].sort((left, right) => (
      left.owner.localeCompare(right.owner) || left.customerId.localeCompare(right.customerId)
    ));
  }

  function periodicCustomerSignalRows(cycleNumber, limit) {
    const rows = customerSignalRows();
    const bounded = Math.max(1, Math.min(Number(limit) || batchSize, 500));
    if (rows.length <= bounded) return rows;
    const cycle = Number.isSafeInteger(cycleNumber) && cycleNumber >= 0 ? cycleNumber : 0;
    const start = (cycle * bounded) % rows.length;
    return Array.from({ length: bounded }, (_, index) => rows[(start + index) % rows.length]);
  }

function relatedRows(owner, opportunities) {
  const rows = opportunities.filter(Boolean);
    if (rows.length === 0) return { actions: [], interactions: [], risks: [], itineraries: [], tenders: [], knowledge: [] };
    const opportunityIds = [...new Set(rows.map((row) => row.id))];
    const customerIds = [...new Set(rows.map((row) => row.customerId).filter(Boolean))];
    const opParams = Object.fromEntries(opportunityIds.map((id, index) => [`$op${index}`, id]));
    const customerParams = Object.fromEntries(customerIds.map((id, index) => [`$customer${index}`, id]));
    const opPlaceholders = opportunityIds.map((_, index) => `$op${index}`).join(", ");
    const customerPlaceholders = customerIds.map((_, index) => `$customer${index}`).join(", ");
    const ownerValue = identifier(owner, "owner", 200);
    const actionParams = { ...opParams, $owner: ownerValue };
    const interactionParams = { ...opParams, ...customerParams, $owner: ownerValue };
    const actions = db.prepare(`
      SELECT id, opportunity_id, title, status, due, version, updated_at
        FROM action_items
       WHERE owner = $owner
         AND deleted_at IS NULL
         AND opportunity_id IN (${opPlaceholders})
    `).all(actionParams).map(rowToAction);
    const interactions = db.prepare(`
      SELECT id, opportunity_id, customer_id, occurred_at, source_channel, status,
             version, updated_at, voided_at, created_at
        FROM quick_records
       WHERE owner = $owner
         AND voided_at IS NULL
         AND (opportunity_id IN (${opPlaceholders}) OR customer_id IN (${customerPlaceholders}))
    `).all(interactionParams).map(rowToInteraction);
    const riskRows = db.prepare(`
      SELECT id, opportunity_id, customer_id, title, status, severity, due, version, updated_at
        FROM risk_items
       WHERE owner = $owner
         AND deleted_at IS NULL
         AND opportunity_id IN (${opPlaceholders})
    `).all(actionParams).map((row) => ({
      id: row.id,
      opportunityId: row.opportunity_id,
      customerId: row.customer_id,
      title: row.title,
      status: row.status,
      severity: row.severity,
      due: row.due,
      version: Number(row.version ?? 1),
      updatedAt: row.updated_at,
    }));
    const itineraryRows = db.prepare(`
      SELECT id, version, title, visit_date, status, request_json, plan_json, updated_at
        FROM visit_itineraries
       WHERE owner = $owner
         AND deleted_at IS NULL
         AND status <> 'cancelled'
       ORDER BY visit_date ASC, id ASC
       LIMIT 100
    `).all({ $owner: ownerValue }).map((row) => {
      let request = {};
      let plan = {};
      try { request = JSON.parse(row.request_json ?? "{}"); } catch {}
      try { plan = JSON.parse(row.plan_json ?? "{}"); } catch {}
      return {
        id: row.id,
        version: Number(row.version ?? 1),
        title: row.title,
        visitDate: row.visit_date,
        status: row.status,
        updatedAt: row.updated_at,
        customerId: request.customerId ?? request.customer_id ?? plan.customerId ?? plan.customer_id ?? null,
        opportunityId: request.opportunityId ?? request.opportunity_id ?? plan.opportunityId ?? plan.opportunity_id ?? null,
      };
    });
    const tenderRows = [];
    if (tableExists(db, "hospital_tender_notices")) {
      const notices = db.prepare(`
        SELECT id, identity_key, title, notice_type, published_at, source_id,
               content_sha256, match_customer_ids_json
          FROM hospital_tender_notices
         ORDER BY published_at DESC, id DESC
         LIMIT 200
      `).all();
      for (const row of notices) {
        let customerIds = [];
        try { customerIds = JSON.parse(row.match_customer_ids_json ?? "[]"); } catch {}
        for (const customerId of Array.isArray(customerIds) ? customerIds : []) {
          tenderRows.push({
            id: row.id ?? row.identity_key,
            identityKey: row.identity_key,
            customerId,
            title: row.title,
            noticeType: row.notice_type,
            publishedAt: row.published_at,
            sourceId: row.source_id,
            contentSha256: row.content_sha256,
            revision: tenderRevision({
              id: row.id ?? row.identity_key,
              identityKey: row.identity_key,
              title: row.title,
              noticeType: row.notice_type,
              publishedAt: row.published_at,
              sourceId: row.source_id,
              contentSha256: row.content_sha256,
            }),
          });
        }
      }
    }
    const knowledgeRows = db.prepare(`
      SELECT id, version, title, summary, updated_at
        FROM knowledge_items
       WHERE owner = $owner
         AND deleted_at IS NULL
       ORDER BY updated_at DESC, id ASC
       LIMIT 8
    `).all({ $owner: ownerValue }).map(rowToKnowledge);
    return {
      actions,
      interactions,
      risks: riskRows,
      itineraries: itineraryRows,
      tenders: tenderRows,
      knowledge: knowledgeRows,
    };
  }

  function itemsForOpportunity(snapshot, opportunityId) {
    return Array.isArray(snapshot?.items)
      ? snapshot.items.filter((item) => item && item.opportunityId === opportunityId)
      : [];
  }

  function uniqueCustomerRows(rows) {
    const byKey = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const owner = String(row?.owner ?? "").trim();
      const customerId = String(row?.customerId ?? "").trim();
      if (!owner || !customerId) continue;
      const key = `${owner}\u0000${customerId}`;
      if (!byKey.has(key)) byKey.set(key, { owner, customerId });
    }
    return [...byKey.values()].sort((left, right) => (
      left.owner.localeCompare(right.owner) || left.customerId.localeCompare(right.customerId)
    ));
  }

  async function processCustomerSubjects(rows) {
    if (!customerSubjects) return emptyCustomerSubjectScan();
    const groups = uniqueCustomerRows(rows);
    const scanResult = emptyCustomerSubjectScan({ enabled: true });
    scanResult.attemptedCount = groups.length;
    scanResult.subjectCount = groups.length;
    for (const group of groups) {
      try {
        const synced = await customerSubjects.syncCustomer({
          owner: group.owner,
          customerId: group.customerId,
          ...(staleDays === undefined ? {} : { staleDays }),
          includeExtendedSignals,
        });
        const result = customerSubjectResult({
          owner: group.owner,
          customerId: group.customerId,
          syncResult: synced,
        });
        scanResult.succeededCount += 1;
        scanResult.suggestionCount += result.suggestionCount;
        scanResult.insertedCount += result.insertedCount;
        scanResult.dedupedCount += result.dedupedCount;
        scanResult.results.push(result);
      } catch (error) {
        const failure = {
          status: "failed",
          owner: group.owner,
          customerId: group.customerId,
          error: safeError(error, "customer proactive subject sync failed"),
          errorCode: String(error?.code ?? "PROACTIVE_CUSTOMER_SUBJECT_SYNC_FAILED").slice(0, 200),
        };
        scanResult.failedCount += 1;
        scanResult.errors.push(failure);
        scanResult.results.push(failure);
      }
    }
    scanResult.status = scanResult.failedCount > 0
      ? (scanResult.succeededCount > 0 ? "partial" : "failed")
      : (scanResult.attemptedCount > 0 ? "success" : "idle");
    return scanResult;
  }

  async function processRows(rows, { runId, eventId = null, syncCustomers = true } = {}) {
    let objectCount = 0;
    let opportunitySuggestionCount = 0;
    let opportunityInsertedCount = 0;
    let opportunityDedupedCount = 0;
    const grouped = new Map();
    for (const row of rows) {
      const list = grouped.get(row.owner) ?? [];
      list.push(row);
      grouped.set(row.owner, list);
    }
    for (const [owner, ownerRows] of grouped.entries()) {
      const related = relatedRows(owner, ownerRows);
      const actionsByOpportunity = new Map();
      const interactionsByOpportunity = new Map();
      for (const action of related.actions) {
        const list = actionsByOpportunity.get(action.opportunityId) ?? [];
        list.push(action);
        actionsByOpportunity.set(action.opportunityId, list);
      }
      for (const interaction of related.interactions) {
        // A record linked to a sibling opportunity is background context, not
        // evidence for the current opportunity.  Only an explicitly
        // opportunity-less customer record may be fanned out to every
        // opportunity for that customer.  Keeping this boundary here is
        // important because processRows passes a pre-grouped list into the
        // snapshot builder; including sibling-linked rows would make the
        // builder treat them as direct evidence again.
        for (const row of ownerRows) {
          const isDirect = interaction.opportunityId === row.id;
          const isCustomerOnly = !interaction.opportunityId
            && interaction.customerId === row.customerId;
          if (isDirect || isCustomerOnly) {
            const list = interactionsByOpportunity.get(row.id) ?? [];
            if (!list.some((item) => item.id === interaction.id)) list.push(interaction);
            interactionsByOpportunity.set(row.id, list);
          }
        }
      }
      for (const opportunity of ownerRows) {
        objectCount += 1;
        const ownerRelated = related;
        const built = await snapshotBuilder({
          opportunities: [opportunity],
          actions: actionsByOpportunity.get(opportunity.id) ?? [],
          interactions: interactionsByOpportunity.get(opportunity.id) ?? [],
          risks: ownerRelated.risks.filter((item) => item.opportunityId === opportunity.id),
          itineraries: ownerRelated.itineraries,
          tenders: ownerRelated.tenders.filter((item) => item.customerId === opportunity.customerId),
          now: clockDate(clock),
          ...(staleDays === undefined ? {} : { staleDays }),
          // Build one object at a time so the assistant's bounded result does
          // not hide the 101st suggestion in a 50-object scan batch.
          limit: 100,
          includeExtendedSignals,
        });
        const items = [];
        for (const item of itemsForOpportunity(built, opportunity.id)) {
          items.push(await modelEnrichment({
            suggestion: item,
            opportunity,
            actions: actionsByOpportunity.get(opportunity.id) ?? [],
            interactions: interactionsByOpportunity.get(opportunity.id) ?? [],
            risks: ownerRelated.risks.filter((entry) => entry.opportunityId === opportunity.id),
            itineraries: ownerRelated.itineraries,
            tenders: ownerRelated.tenders.filter((entry) => entry.customerId === opportunity.customerId),
            knowledge: ownerRelated.knowledge,
          }));
        }
        opportunitySuggestionCount += items.length;
        for (const item of items) {
          const saved = await suggestions.save({
            owner,
            suggestion: item,
            id: item.id,
            trigger: item.trigger?.type,
            subjectType: item.subjectType,
            subjectId: item.subjectId,
            customerId: item.customerId,
            opportunityId: item.opportunityId,
            // The deterministic assistant id includes the source snapshot;
            // namespacing it as the dedupe key means an unchanged source is
            // replayed while a changed source naturally receives a new row.
            dedupeKey: `proactive:v1:${item.id}`,
            priority: item.priority ?? 0,
            source: item.source,
            fallbackReason: item.fallbackReason,
            generatedAt: item.trigger?.detectedAt ?? built.generatedAt,
            ruleVersion: item.modelVersion ?? item.schemaVersion,
            runId,
            eventId,
          });
          if (saved.replayed) opportunityDedupedCount += 1;
          else opportunityInsertedCount += 1;
        }
      }
    }
    const customerScan = syncCustomers
      ? await processCustomerSubjects(rows)
      : emptyCustomerSubjectScan({ enabled: Boolean(customerSubjects) });
    return {
      objectCount,
      opportunityObjectCount: objectCount,
      opportunitySuggestionCount,
      opportunityInsertedCount,
      opportunityDedupedCount,
      customerScan,
      customerSubjectCount: customerScan.subjectCount,
      customerSuggestionCount: customerScan.suggestionCount,
      customerInsertedCount: customerScan.insertedCount,
      customerDedupedCount: customerScan.dedupedCount,
      suggestionCount: opportunitySuggestionCount + customerScan.suggestionCount,
      insertedCount: opportunityInsertedCount + customerScan.insertedCount,
      dedupedCount: opportunityDedupedCount + customerScan.dedupedCount,
    };
  }

  function emptyProcessResult() {
    const customerScan = emptyCustomerSubjectScan({ enabled: Boolean(customerSubjects) });
    return {
      objectCount: 0,
      opportunityObjectCount: 0,
      opportunitySuggestionCount: 0,
      opportunityInsertedCount: 0,
      opportunityDedupedCount: 0,
      customerScan,
      customerSubjectCount: 0,
      customerSuggestionCount: 0,
      customerInsertedCount: 0,
      customerDedupedCount: 0,
      suggestionCount: 0,
      insertedCount: 0,
      dedupedCount: 0,
    };
  }

  function customerOnlyProcessResult(customerScan) {
    return {
      ...emptyProcessResult(),
      customerScan,
      customerSubjectCount: customerScan.subjectCount,
      customerSuggestionCount: customerScan.suggestionCount,
      customerInsertedCount: customerScan.insertedCount,
      customerDedupedCount: customerScan.dedupedCount,
      suggestionCount: customerScan.suggestionCount,
      insertedCount: customerScan.insertedCount,
      dedupedCount: customerScan.dedupedCount,
    };
  }

  function mergeProcessResults(left, right) {
    const mergedCustomerScan = addCustomerSubjectScan(left?.customerScan, right?.customerScan);
    return {
      objectCount: Number(left?.objectCount ?? 0) + Number(right?.objectCount ?? 0),
      opportunityObjectCount: Number(left?.opportunityObjectCount ?? 0) + Number(right?.opportunityObjectCount ?? 0),
      opportunitySuggestionCount: Number(left?.opportunitySuggestionCount ?? 0) + Number(right?.opportunitySuggestionCount ?? 0),
      opportunityInsertedCount: Number(left?.opportunityInsertedCount ?? 0) + Number(right?.opportunityInsertedCount ?? 0),
      opportunityDedupedCount: Number(left?.opportunityDedupedCount ?? 0) + Number(right?.opportunityDedupedCount ?? 0),
      customerScan: mergedCustomerScan,
      customerSubjectCount: Number(left?.customerSubjectCount ?? 0) + Number(right?.customerSubjectCount ?? 0),
      customerSuggestionCount: Number(left?.customerSuggestionCount ?? 0) + Number(right?.customerSuggestionCount ?? 0),
      customerInsertedCount: Number(left?.customerInsertedCount ?? 0) + Number(right?.customerInsertedCount ?? 0),
      customerDedupedCount: Number(left?.customerDedupedCount ?? 0) + Number(right?.customerDedupedCount ?? 0),
      suggestionCount: Number(left?.suggestionCount ?? 0) + Number(right?.suggestionCount ?? 0),
      insertedCount: Number(left?.insertedCount ?? 0) + Number(right?.insertedCount ?? 0),
      dedupedCount: Number(left?.dedupedCount ?? 0) + Number(right?.dedupedCount ?? 0),
    };
  }

  function runView(runValue, processResult) {
    if (!runValue) return runValue;
    return {
      ...runValue,
      opportunityObjectCount: processResult?.opportunityObjectCount ?? 0,
      opportunitySuggestionCount: processResult?.opportunitySuggestionCount ?? 0,
      opportunityInsertedCount: processResult?.opportunityInsertedCount ?? 0,
      opportunityDedupedCount: processResult?.opportunityDedupedCount ?? 0,
      customerSubjectCount: processResult?.customerSubjectCount ?? 0,
      customerSuggestionCount: processResult?.customerSuggestionCount ?? 0,
      customerInsertedCount: processResult?.customerInsertedCount ?? 0,
      customerDedupedCount: processResult?.customerDedupedCount ?? 0,
      customerScan: processResult?.customerScan ?? emptyCustomerSubjectScan({ enabled: Boolean(customerSubjects) }),
    };
  }

  function eventTargetRows(event) {
    if (event.entityType === "customer") {
      const customerId = event.payload?.customerId ?? event.entityId ?? null;
      return customerId ? queryOpportunitiesByCustomerId(event.owner, customerId) : [];
    }
    const targetId = event.entityType === "opportunity"
      ? event.entityId
      : event.payload?.opportunityId ?? event.payload?.subjectId ?? null;
    const customerIds = Array.isArray(event.payload?.customerIds)
      ? event.payload.customerIds
      : event.payload?.customerId
        ? [event.payload.customerId]
        : [];
    if (!targetId && customerIds.length > 0) {
      return queryOpportunitiesByCustomerIds(event.owner, customerIds);
    }
    if (!targetId) return queryOpportunities({ owner: event.owner, limit: getState().batchSize }).rows;
    return queryOpportunityById(event.owner, targetId);
  }

  function eventCustomerRows(event, rows) {
    const customerIds = [];
    if (Array.isArray(event.payload?.customerIds)) customerIds.push(...event.payload.customerIds);
    if (event.payload?.customerId) customerIds.push(event.payload.customerId);
    if (event.entityType === "customer" && event.entityId) customerIds.push(event.entityId);
    return uniqueCustomerRows([
      ...(Array.isArray(rows) ? rows : []),
      ...customerIds.map((customerId) => ({ owner: event.owner, customerId })),
    ]);
  }

  function customerRowKey(row) {
    return `${row.owner}\u0000${row.customerId}`;
  }

  function retryAt(now, failureCount) {
    const exponent = Math.min(Math.max(failureCount - 1, 0), 10);
    return new Date(now.getTime() + retryBaseMs * (2 ** exponent)).toISOString();
  }

  async function runOnce({ force = false, trigger = "scheduled" } = {}) {
    if (!RUN_TRIGGERS.has(trigger)) throw new TypeError("trigger is invalid");
    if (ticking) return { status: "skipped", reason: "running", state: getState() };
    ticking = true;
    let lease = null;
    let run = null;
    const now = clockDate(clock);
    const nowIso = now.toISOString();
    try {
      let state = ensureStateDefaults();
      if (!force && !state.enabled) {
        state = scan.updateState({ lastStatus: "disabled", nextRunAt: null });
        return { status: "disabled", state };
      }
      if (!force && state.nextRetryAt && Date.parse(state.nextRetryAt) > now.getTime()) {
        state = scan.updateState({ lastStatus: "waiting" });
        return { status: "waiting", reason: "backoff", state };
      }
      if (!force && state.nextRunAt && Date.parse(state.nextRunAt) > now.getTime()) {
        state = scan.updateState({ lastStatus: "waiting" });
        return { status: "waiting", state };
      }

      lease = scan.tryAcquireLease({ workerId: configuredWorkerId, leaseMs });
      if (!lease) return { status: "skipped", reason: "locked", state: getState() };
      scan.recoverRunningRuns({ now, leaseMs });

      const events = [];
      for (let index = 0; index < eventBatchSize && typeof scan.claimEvent === "function"; index += 1) {
        const event = scan.claimEvent({ workerId: configuredWorkerId, leaseMs });
        if (!event) break;
        events.push(event);
      }
      const currentState = getState();
      run = scan.createRun({
        cycleNumber: currentState.cycleNumber,
        trigger: events.length > 0 ? "event" : trigger,
        workerId: configuredWorkerId,
        cursorOwner: currentState.cursorOwner,
        cursorOpportunityId: currentState.cursorOpportunityId,
        eventCount: events.length,
        startedAt: nowIso,
      });
      scan.updateState({ lastStartedAt: nowIso, lastStatus: "running", lastError: null, lastRunId: run.id });

      let aggregate = emptyProcessResult();
      let failedEvents = 0;
      if (events.length > 0) {
        const customerRows = [];
        const readyEvents = [];
        const failClaimedEvent = (claimed, errorCode, errorText) => {
          failedEvents += 1;
          try {
            scan.failEvent(claimed.item.id, {
              leaseToken: claimed.leaseToken,
              errorCode,
              errorText,
              retryBaseMs,
            });
          } catch {
            // A lost event lease remains recoverable through its durable row.
          }
        };
        for (const claimed of events) {
          try {
            const rows = eventTargetRows(claimed.item);
            const eventCustomers = eventCustomerRows(claimed.item, rows);
            customerRows.push(...eventCustomers);
            if (rows.length > 0) {
              const result = await processRows(rows, {
                runId: run.id,
                eventId: claimed.item.id,
                syncCustomers: false,
              });
              aggregate = mergeProcessResults(aggregate, result);
            }
            readyEvents.push({
              claimed,
              customerKeys: eventCustomers.map(customerRowKey),
            });
          } catch (error) {
            failClaimedEvent(
              claimed,
              "PROACTIVE_EVENT_PROCESS_FAILED",
              safeError(error, "proactive event processing failed"),
            );
          }
        }
        let customerScan = emptyCustomerSubjectScan({ enabled: Boolean(customerSubjects) });
        if (customerRows.length > 0) {
          customerScan = await processCustomerSubjects(customerRows);
          aggregate = mergeProcessResults(aggregate, customerOnlyProcessResult(customerScan));
        }
        const customerFailures = new Map(customerScan.results
          .filter((result) => result?.status === "failed")
          .map((result) => [customerRowKey(result), result]));
        for (const ready of readyEvents) {
          const failure = ready.customerKeys.map((key) => customerFailures.get(key)).find(Boolean);
          if (failure) {
            failClaimedEvent(
              ready.claimed,
              failure.errorCode ?? "PROACTIVE_CUSTOMER_SUBJECT_SYNC_FAILED",
              failure.error ?? "customer proactive subject sync failed",
            );
            continue;
          }
          scan.completeEvent(ready.claimed.item.id, {
            workerId: configuredWorkerId,
            leaseToken: ready.claimed.leaseToken,
          });
        }
        const finishedAt = clockDate(clock);
        const customerFailure = aggregate.customerScan.failedCount > 0;
        const status = failedEvents === events.length
          ? "failed"
          : (failedEvents > 0 || customerFailure ? "partial" : "success");
        const nextRetryAt = status === "success" ? null : retryAt(finishedAt, currentState.failureCount + 1);
        run = scan.updateRun(run.id, {
          status,
          objectCount: aggregate.objectCount,
          suggestionCount: aggregate.suggestionCount,
          insertedCount: aggregate.insertedCount,
          dedupedCount: aggregate.dedupedCount,
          eventCount: events.length,
          finishedAt,
          errorCode: failedEvents > 0 ? "PROACTIVE_EVENT_PROCESS_FAILED" : null,
          errorText: failedEvents > 0 ? `${failedEvents} proactive event(s) failed` : null,
          nextRetryAt,
        });
        state = scan.updateState({
          lastFinishedAt: finishedAt.toISOString(),
          lastStatus: status,
          lastError: failedEvents > 0 ? `${failedEvents} proactive event(s) failed` : null,
          lastBatchCount: 0,
          lastSuggestionCount: aggregate.suggestionCount,
          lastInsertedCount: aggregate.insertedCount,
          lastDedupedCount: aggregate.dedupedCount,
          failureCount: status === "success" ? 0 : currentState.failureCount + 1,
          nextRetryAt,
          nextRunAt: status === "success" ? addSeconds(finishedAt, currentState.intervalSeconds) : nextRetryAt,
        });
        lastCustomerSubjectScan = aggregate.customerScan;
        return {
          status,
          run: runView(run, aggregate),
          state,
          eventCount: events.length,
          ...aggregate,
        };
      }

      const cursor = currentState.cursorOwner && currentState.cursorOpportunityId
        ? { cursorOwner: currentState.cursorOwner, cursorOpportunityId: currentState.cursorOpportunityId }
        : {};
      const selected = queryOpportunities({ ...cursor, limit: currentState.batchSize });
      const rows = selected.rows.map((row) => ({ ...row, owner: row.owner ?? currentState.cursorOwner }));
      // Keep the owner from the ordered query for per-account context,
      // suggestion ownership and the composite durable cursor.
      for (let index = 0; index < rows.length; index += 1) {
        const owner = rows[index].owner;
        if (!owner) throw new Error("opportunity owner is missing");
        rows[index].owner = owner;
      }
      const last = rows.at(-1) ?? null;
      const hasMore = selected.hasMore;
      const completedCycle = !hasMore;
      let result = rows.length > 0 ? await processRows(rows, { runId: run.id }) : emptyProcessResult();
      if (completedCycle && customerSubjects) {
        const signalRows = periodicCustomerSignalRows(currentState.cycleNumber, currentState.batchSize);
        if (signalRows.length > 0) {
          const customerScan = await processCustomerSubjects(signalRows);
          result = mergeProcessResults(result, customerOnlyProcessResult(customerScan));
        }
      }
      aggregate = result;
      const nextCursorOwner = hasMore && last ? last.owner : null;
      const nextCursorOpportunityId = hasMore && last ? last.id : null;
      const cycleObjectCount = currentState.cursorOwner ? currentState.cycleObjectCount : opportunityCount();
      const cycleProcessedCount = currentState.cursorOwner
        ? currentState.cycleProcessedCount + result.objectCount
        : result.objectCount;
      const finishedAt = clockDate(clock);
      const runStatus = result.customerScan.failedCount > 0 ? "partial" : "success";
      const nextCycleNumber = completedCycle && runStatus === "success"
        ? currentState.cycleNumber + 1
        : currentState.cycleNumber;
      const nextRetryAt = runStatus === "success" ? null : retryAt(finishedAt, currentState.failureCount + 1);
      run = scan.updateRun(run.id, {
        status: runStatus,
        objectCount: result.objectCount,
        suggestionCount: result.suggestionCount,
        insertedCount: result.insertedCount,
        dedupedCount: result.dedupedCount,
        batchCount: rows.length > 0 ? 1 : 0,
        nextCursorOwner,
        nextCursorOpportunityId,
        finishedAt,
        nextRetryAt,
      });
      state = scan.updateState({
        cursorOwner: nextCursorOwner,
        cursorOpportunityId: nextCursorOpportunityId,
        cycleNumber: nextCycleNumber,
        cycleObjectCount: completedCycle ? 0 : cycleObjectCount,
        cycleProcessedCount: completedCycle ? 0 : cycleProcessedCount,
        lastFinishedAt: finishedAt.toISOString(),
        lastStatus: runStatus,
        lastError: null,
        lastBatchCount: rows.length,
        lastSuggestionCount: result.suggestionCount,
        lastInsertedCount: result.insertedCount,
        lastDedupedCount: result.dedupedCount,
        failureCount: runStatus === "success" ? 0 : currentState.failureCount + 1,
        nextRetryAt,
        nextRunAt: runStatus === "success" ? addSeconds(finishedAt, currentState.intervalSeconds) : nextRetryAt,
      });
      lastCustomerSubjectScan = result.customerScan;
      return {
        status: runStatus,
        run: runView(run, result),
        state,
        ...result,
        hasMore,
      };
    } catch (error) {
      const finishedAt = clockDate(clock);
      const message = safeError(error);
      const state = getState();
      const failureCount = state.failureCount + 1;
      const nextRetryAt = retryAt(finishedAt, failureCount);
      if (run) {
        try {
          run = scan.updateRun(run.id, {
            status: "failed",
            errorCode: "PROACTIVE_SCAN_FAILED",
            errorText: message,
            finishedAt,
            nextRetryAt,
          });
        } catch {
          // The lease owner can still recover an in-flight run on restart.
        }
      }
      let failedState = state;
      try {
        failedState = scan.updateState({
          lastFinishedAt: finishedAt.toISOString(),
          lastStatus: "failed",
          lastError: message,
          failureCount,
          nextRetryAt,
          nextRunAt: nextRetryAt,
        });
      } catch {
        // Preserve the original failure result if the state write itself is unavailable.
      }
      return { status: "failed", error: message, run, state: failedState };
    } finally {
      if (lease) {
        try { scan.releaseLease({ workerId: configuredWorkerId, leaseToken: lease.leaseToken }); } catch { /* recovery uses expiry */ }
      }
      ticking = false;
    }
  }

  function scheduleNext(minimumDelayMs = 0) {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const state = getState();
    const now = clockDate(clock);
    const dueAt = state.nextRunAt ? Date.parse(state.nextRunAt) : now.getTime();
    const delay = Math.max(
      Math.max(0, minimumDelayMs),
      Math.min(MAX_TIMER_DELAY, Math.max(0, dueAt - now.getTime())),
    );
    timer = setTimeout(async () => {
      if (!started) return;
      const result = await runOnce();
      const retryDelay = result.status === "skipped" && result.reason === "locked" ? pollMs : 0;
      scheduleNext(retryDelay);
    }, delay);
    timer.unref?.();
  }

  function start() {
    if (started) return;
    started = true;
    scheduleNext();
  }

  function stop() {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function status() {
    const customerScan = {
      ...lastCustomerSubjectScan,
      results: Array.isArray(lastCustomerSubjectScan.results)
        ? lastCustomerSubjectScan.results.slice()
        : [],
      errors: Array.isArray(lastCustomerSubjectScan.errors)
        ? lastCustomerSubjectScan.errors.slice()
        : [],
    };
    return {
      running: started,
      ticking,
      workerId: configuredWorkerId,
      state: getState(),
      lease: typeof scan.leaseState === "function" ? scan.leaseState() : null,
      pendingEventCount: typeof scan.pendingEventCount === "function" ? scan.pendingEventCount() : null,
      customerProactiveSubjects: {
        enabled: Boolean(customerSubjects),
        available: Boolean(customerSubjects),
        lastScan: customerScan,
      },
      customerSubjectScan: customerScan,
      modelBudget: modelRuntime
        ? {
          global: modelRuntime.usage({ at: clockDate(clock) }),
          ownerDailyLimit: modelOwnerDailyLimit,
          globalDailyLimit: modelGlobalDailyLimit,
          cacheTtlMs: modelCacheTtlMs,
          timeZone: modelBudgetTimezone,
        }
        : null,
    };
  }

  function enqueueEvent(input = {}) {
    if (typeof scan.enqueueEvent !== "function") throw new TypeError("scanRepository does not support events");
    return scan.enqueueEvent(input);
  }

  function assertCurrentCustomerSubjectRevision(input = {}) {
    if (!customerSubjects || typeof customerSubjects.assertCurrentRevision !== "function") {
      throw new TypeError("customerProactiveSubjectService does not support revision checks");
    }
    return customerSubjects.assertCurrentRevision(input);
  }

  function validateCustomerSubjectRevision(input = {}) {
    if (!customerSubjects || typeof customerSubjects.validateRevision !== "function") {
      throw new TypeError("customerProactiveSubjectService does not support revision checks");
    }
    return customerSubjects.validateRevision(input);
  }

  return Object.freeze({
    start,
    stop,
    runOnce,
    runNext: runOnce,
    runManual: (options = {}) => runOnce({ ...options, force: true, trigger: "manual" }),
    status,
    getState,
    enqueueEvent,
    scanRepository: scan,
    suggestionRepository: suggestions,
    customerProactiveSubjectService: customerSubjects,
    customerSubjectService: customerSubjects,
    assertCurrentCustomerSubjectRevision,
    validateCustomerSubjectRevision,
    workerId: configuredWorkerId,
  });
}

export const createProactiveAssistantWorker = createProactiveBackgroundWorker;
export { compareCursor };
