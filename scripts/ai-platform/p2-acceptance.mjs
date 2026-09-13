import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceToken } from "../../ai-platform/src/auth/internalAuth.js";
import { normalizeDeploymentPolicy as normalizeRuntimeDeploymentPolicy } from "../../ai-platform/src/operations/deploymentPolicy.js";
import { normalizeProviderPolicies } from "../../ai-platform/src/providers/openAiCompatible.js";
import { AI_TASK_TERMINAL_STATUSES, AI_TARGET_MODEL, AI_TARGET_REASONING_EFFORT, sha256 } from "../../shared/aiPlatformContract.mjs";
import { providerCanaryIdempotencyKey } from "../../shared/aiPlatformCanaryContract.mjs";
import { createRequestBinding } from "../../shared/aiPlatformRequestAuth.mjs";
import { socketFetch, PRODUCTION_AI_SOCKET } from "../../shared/aiPlatformSocketTransport.mjs";
import { readBoundedResponseText } from "../../backend/src/http/request.js";
import {
  P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS,
  P2_ACCEPTANCE_MIN_SAMPLES,
  P2_ACCEPTANCE_PRODUCER_ID,
  P2_ACCEPTANCE_PRODUCER_VERSION,
  hashBytes,
  providerPolicyDigest,
  validateP2AcceptanceReport,
} from "./production-contract.mjs";
import { atomicReplace, privateFile, writeExclusive, writeOnceOrVerify } from "./production-io.mjs";
import { createDeepSeekAggregateReconciliation, readAggregateBillingInput } from "./p2-billing-aggregate.mjs";

export const P2_ACCEPTANCE_LIVE_CONFIRMATION = "I_UNDERSTAND_P2_LIVE_PROVIDER_CALLS";
export const P2_ACCEPTANCE_TASK_TYPE = "quick-record.analyze";
export const P2_ACCEPTANCE_FEATURE = "p2-acceptance";
export const P2_ACCEPTANCE_DEFAULT_OWNER = "p2-acceptance";
export const P2_ACCEPTANCE_DEFAULT_SAMPLE_COUNT = P2_ACCEPTANCE_MIN_SAMPLES;
export const P2_ACCEPTANCE_DEFAULT_TASK_TIMEOUT_SECONDS = 600;
export const P2_ACCEPTANCE_DEFAULT_POLL_INTERVAL_SECONDS = 2;
export const P2_ACCEPTANCE_DEFAULT_OBSERVATION_INTERVAL_SECONDS = 60;
export const P2_ACCEPTANCE_MAX_SAMPLES = 100;
export const P2_ACCEPTANCE_MAX_TIMEOUT_SECONDS = 600;
export const P2_ACCEPTANCE_MAX_OBSERVATION_SECONDS = 7 * 24 * 60 * 60;
export const P2_ACCEPTANCE_SAMPLE_MAX_OUTPUT_TOKENS = 256;
export const P2_ACCEPTANCE_DEFAULT_BASE_URL = "http://127.0.0.1:18997";
export const P2_ACCEPTANCE_CHECKPOINT_SCHEMA_VERSION = 1;
export const P2_ACCEPTANCE_CHECKPOINT_PHASES = Object.freeze([
  "collecting", "observing", "reconciling", "finalizing", "completed", "failed",
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SENSITIVE_ARGUMENT = /(?:password|secret|token|cookie|api[-_]?key|credential)/iu;
const TERMINAL = AI_TASK_TERMINAL_STATUSES ?? new Set(["succeeded", "failed", "cancelled", "expired"]);

function failure(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) failure("P2_ACCEPTANCE_INPUT_INVALID", `${name} is invalid`);
  return value;
}

function safeCommit(value, name = "sourceCommit") {
  if (typeof value !== "string" || !COMMIT.test(value)) failure("P2_ACCEPTANCE_INPUT_INVALID", `${name} is invalid`);
  return value;
}

function safeInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) failure("P2_ACCEPTANCE_INPUT_INVALID", `${name} is invalid`);
  return value;
}

function canonicalIso(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    failure("P2_ACCEPTANCE_INPUT_INVALID", `${name} is invalid`);
  }
  return value;
}

function nowMs(clock) {
  const value = clock();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) failure("P2_ACCEPTANCE_CLOCK_INVALID");
  return parsed;
}

function nowIso(clock) {
  return new Date(nowMs(clock)).toISOString();
}

function parseJsonFile(path, label) {
  const absolute = resolve(path);
  let text;
  try { text = readFileSync(absolute, "utf8"); } catch { failure("P2_ACCEPTANCE_INPUT_INVALID", `${label} is unavailable`); }
  try { return JSON.parse(text); } catch { failure("P2_ACCEPTANCE_INPUT_INVALID", `${label} is not valid JSON`); }
}

function parseProviderPolicies(value) {
  const policies = Array.isArray(value) ? value : value?.providerPolicies;
  if (!Array.isArray(policies) || !policies.length || policies.length > 8) failure("P2_ACCEPTANCE_PROVIDER_POLICY_INVALID");
  const allowedOrigins = [];
  for (const policy of policies) {
    try {
      const origin = new URL(policy?.baseUrl).origin;
      if (origin !== "null") allowedOrigins.push(origin);
    } catch {
      failure("P2_ACCEPTANCE_PROVIDER_POLICY_INVALID");
    }
  }
  try {
    // The acceptance input is normalized by the same runtime contract used by
    // loadAiPlatformConfig.  The derived origins only make this offline
    // parser perform the runtime shape checks; production still binds the
    // resulting digest to its explicitly configured allowlist and policy.
    return normalizeProviderPolicies(policies, {
      allowedOrigins: [...new Set(allowedOrigins)],
      allowTestLoopback: false,
    });
  } catch {
    failure("P2_ACCEPTANCE_PROVIDER_POLICY_INVALID");
  }
}

function normalizeDeploymentPolicy(value, sourceCommit, providers) {
  let policy;
  try {
    policy = normalizeRuntimeDeploymentPolicy(value, { providerPolicies: providers });
  } catch {
    failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID");
  }
  if (policy.sourceCommit !== sourceCommit) failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID");
  if (policy.models.some((model) => model.providerId === "provider-mock")) {
    failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID");
  }
  const binding = policy.agents.find((item) => item?.slug === "quick-record");
  if (!binding || !safeId(binding.modelId, "policy.quick-record.modelId")) {
    failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID", "quick-record policy binding is required");
  }
  const selectedModel = policy.models.find((item) => item.id === binding.modelId);
  if (!selectedModel) failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID", "quick-record model is not registered");
  const provider = providers.find((item) => item.id === selectedModel.providerId);
  if ((provider?.kind ?? "openai_compatible") !== "openai_compatible") {
    failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID", "quick-record must use a text provider");
  }
  const registeredModel = provider?.models.find((item) => item.name === selectedModel.name);
  if (!registeredModel || !registeredModel.taskTypes.includes(P2_ACCEPTANCE_TASK_TYPE)) {
    failure("P2_ACCEPTANCE_DEPLOYMENT_POLICY_INVALID", "quick-record provider capability is not registered");
  }
  return Object.freeze({
    policy,
    digest: sha256(policy),
    currency: policy.currency,
    modelId: selectedModel.id,
    modelName: selectedModel.name,
    providerId: selectedModel.providerId,
    priceVersionId: selectedModel.price?.id,
  });
}

function normalizeBillingEntries(value) {
  const entries = Array.isArray(value) ? value : value?.entries;
  if (!Array.isArray(entries) || entries.length > P2_ACCEPTANCE_MAX_SAMPLES) failure("P2_ACCEPTANCE_BILLING_INVALID");
  const result = new Map();
  for (const entry of entries) {
    if (!isPlainRecord(entry)) failure("P2_ACCEPTANCE_BILLING_INVALID");
    const providerRequestId = entry.providerRequestId ?? entry.externalRequestId;
    const reference = entry.reference ?? entry.billingReference;
    const amountMicro = entry.amountMicro ?? entry.micro ?? entry.costMicro;
    if (typeof providerRequestId !== "string" || !SAFE_ID.test(providerRequestId)
      || typeof reference !== "string" || !SAFE_ID.test(reference)
      || !Number.isSafeInteger(amountMicro) || amountMicro < 0
      || !["CNY", "USD"].includes(entry.currency)
      || (entry.status ?? (entry.reconciled === true ? "reconciled" : "")) !== "reconciled"
      || result.has(providerRequestId)) {
      failure("P2_ACCEPTANCE_BILLING_INVALID");
    }
    result.set(providerRequestId, Object.freeze({
      status: "reconciled", reference, providerRequestId, amountMicro, currency: entry.currency,
      ...(entry.checkedAt !== undefined ? { checkedAt: canonicalIso(entry.checkedAt, "billing.checkedAt") } : {}),
      ...(entry.reconciledAt !== undefined ? { reconciledAt: canonicalIso(entry.reconciledAt, "billing.reconciledAt") } : {}),
    }));
  }
  return result;
}

function validateLoopbackBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { failure("P2_ACCEPTANCE_BASE_URL_INVALID"); }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") failure("P2_ACCEPTANCE_BASE_URL_INVALID");
  return url.origin;
}

function responseError(response, payload) {
  const code = payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`;
  return Object.assign(new Error("AI platform request failed"), { code });
}

function checkpointFailure(code, message = code) {
  failure(code, message);
}

function checkpointContent(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function checkpointDigest(value) {
  return hashBytes(Buffer.from(checkpointContent(value), "utf8"));
}

function readCheckpoint(path) {
  if (!path || !existsSync(resolve(path))) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint is unavailable or invalid");
  }
  if (!isPlainRecord(parsed)
    || parsed.schemaVersion !== P2_ACCEPTANCE_CHECKPOINT_SCHEMA_VERSION
    || !SAFE_ID.test(parsed.runId ?? "")
    || !COMMIT.test(parsed.sourceCommit ?? "")
    || !/^[0-9a-f]{64}$/u.test(parsed.policyDigest ?? "")
    || !/^[0-9a-f]{64}$/u.test(parsed.providerPolicyDigest ?? "")
    || !P2_ACCEPTANCE_CHECKPOINT_PHASES.includes(parsed.phase)
    || !Array.isArray(parsed.samples)) {
    checkpointFailure("P2_CHECKPOINT_INVALID");
  }
  return parsed;
}

function writeCheckpoint(path, value) {
  if (!path) return null;
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const ownerUid = process.getuid?.() ?? 0;
  const expectedSha = existsSync(absolute)
    ? privateFile(absolute, null, { ownerUid }).sha256
    : null;
  atomicReplace(absolute, checkpointContent(value), expectedSha, { ownerUid });
  return checkpointDigest(value);
}

function initialCheckpoint({ runId, sourceCommit, policyDigest, providerPolicyDigest: providerDigest, owner, sampleCount, startedAt }) {
  return {
    schemaVersion: P2_ACCEPTANCE_CHECKPOINT_SCHEMA_VERSION,
    phase: "collecting",
    runId,
    sourceCommit,
    policyDigest,
    providerPolicyDigest: providerDigest,
    owner,
    sampleCount,
    startedAt,
    updatedAt: startedAt,
    samples: Array.from({ length: sampleCount }, (_item, index) => ({
      sampleIndex: index + 1,
      sampleId: `sample-${String(index + 1).padStart(3, "0")}`,
      status: "pending",
    })),
    observation: null,
    billing: null,
    report: null,
    failure: null,
  };
}

function checkpointSample(state, sampleIndex) {
  const item = state.samples.find((sample) => sample.sampleIndex === sampleIndex);
  if (!item) checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint sample is missing");
  return item;
}

function updateCheckpoint(state, patch, clock) {
  return {
    ...state,
    ...patch,
    updatedAt: nowIso(clock),
  };
}

function validateCheckpointMatches(state, { runId, sourceCommit, policyDigest, providerPolicyDigest: providerDigest, owner, sampleCount }) {
  if (state.runId !== runId || state.sourceCommit !== sourceCommit
    || state.policyDigest !== policyDigest || state.providerPolicyDigest !== providerDigest
    || state.owner !== owner || state.sampleCount !== sampleCount
    || state.samples.length !== sampleCount
    || new Set(state.samples.map((sample) => sample.sampleIndex)).size !== sampleCount) {
    checkpointFailure("P2_CHECKPOINT_MISMATCH", "checkpoint does not match the requested run");
  }
  for (const sample of state.samples) {
    if (!Number.isSafeInteger(sample.sampleIndex) || sample.sampleIndex < 1 || sample.sampleIndex > sampleCount
      || !SAFE_ID.test(sample.sampleId ?? "")
      || !["pending", "requested", "succeeded", "settled"].includes(sample.status)) {
      checkpointFailure("P2_CHECKPOINT_INVALID");
    }
    if (["requested", "succeeded", "settled"].includes(sample.status)
      && (typeof sample.taskId !== "string" || !SAFE_ID.test(sample.taskId))) {
      checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint sample task is missing");
    }
    if (sample.status === "settled" && !isPlainRecord(sample.evidence)) {
      checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint sample evidence is missing");
    }
  }
  if (state.observation !== null) {
    if (!isPlainRecord(state.observation) || !Array.isArray(state.observation.checks)
      || !Object.hasOwn(state.observation, "startedAt") || !Object.hasOwn(state.observation, "finishedAt")) {
      checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint observation is invalid");
    }
    canonicalIso(state.observation.startedAt, "checkpoint.observation.startedAt");
    if (state.observation.finishedAt !== null) canonicalIso(state.observation.finishedAt, "checkpoint.observation.finishedAt");
    for (const check of state.observation.checks) {
      if (!isPlainRecord(check) || check.status !== "passed") checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint observation check is invalid");
      canonicalIso(check.at, "checkpoint.observation.check.at");
    }
  }
  if (state.failure !== null && (!isPlainRecord(state.failure)
    || !SAFE_ID.test(state.failure.code ?? "")
    || !["collecting", "observing", "reconciling", "finalizing"].includes(state.failure.resumePhase))) {
    checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint failure is invalid");
  }
  return state;
}

function checkpointStateDigest(state) {
  const { report: _report, ...withoutReport } = state;
  return checkpointDigest({ ...withoutReport, report: null });
}

function billingEntriesDigest(entries) {
  return hashBytes(JSON.stringify([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function normalizeStoredEvidence(value) {
  if (!isPlainRecord(value)
    || typeof value.requestId !== "string" || !SAFE_ID.test(value.requestId)
    || typeof value.providerRequestId !== "string" || !SAFE_ID.test(value.providerRequestId)
    || typeof value.actualModel !== "string" || !SAFE_ID.test(value.actualModel)
    || value.finishReason !== "stop"
    || typeof value.priceVersion !== "string" || !SAFE_ID.test(value.priceVersion)
    || !isPlainRecord(value.usage)
    || !isPlainRecord(value.cost)
    || !Number.isSafeInteger(value.cost.micro) || value.cost.micro < 0
    || !["CNY", "USD"].includes(value.cost.currency)
    || value.cost.status !== "calculated") {
    checkpointFailure("P2_CHECKPOINT_INVALID", "checkpoint evidence is invalid");
  }
  return value;
}

function validateCompletedCheckpoint(state, { sourceCommit, policyDigest, providerPolicyDigest: providerDigest, currency, now }) {
  if (state.phase !== "completed" || !isPlainRecord(state.report)) {
    checkpointFailure("P2_CHECKPOINT_INVALID", "completed checkpoint report is missing");
  }
  const report = state.report;
  validateP2AcceptanceReport(report, {
    sourceCommit, policyDigest, providerPolicyDigest: providerDigest, currency, now,
  });
  if (report.checkpointDigest !== checkpointStateDigest(state)) {
    checkpointFailure("P2_CHECKPOINT_INVALID", "completed checkpoint digest does not match report");
  }
  return report;
}

async function responseJson(response) {
  const text = await readBoundedResponseText(response, { maxBytes: 1_048_576, errorMessage: "AI platform response exceeded limit" });
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { failure("P2_ACCEPTANCE_RESPONSE_INVALID"); }
}

export function createP2AcceptanceClient({
  secret,
  issuer,
  owner = P2_ACCEPTANCE_DEFAULT_OWNER,
  baseUrl = P2_ACCEPTANCE_DEFAULT_BASE_URL,
  socketPath = PRODUCTION_AI_SOCKET,
  fetchImpl = null,
  now = () => Date.now(),
} = {}) {
  if (typeof secret !== "string" || secret.length < 32) failure("P2_ACCEPTANCE_AUTH_NOT_CONFIGURED");
  if (typeof issuer !== "string" || !issuer || /[\u0000-\u001f\u007f]/u.test(issuer)) failure("P2_ACCEPTANCE_ISSUER_INVALID");
  const normalizedOwner = safeId(owner, "owner");
  const origin = validateLoopbackBaseUrl(baseUrl);
  const transport = fetchImpl ?? socketFetch(socketPath);

  async function request({ method = "GET", path, body, idempotencyKey = null, scopes = [] } = {}) {
    if (typeof path !== "string" || !path.startsWith("/internal/ai/v1/")) failure("P2_ACCEPTANCE_PATH_INVALID");
    const payload = body === undefined ? "" : JSON.stringify(body);
    const binding = createRequestBinding({ method, path, body: payload, idempotencyKey });
    const token = createServiceToken({
      secret, issuer, subject: "p2-acceptance", owner: normalizedOwner, actor: "p2-acceptance",
      scopes, ttlSeconds: 300, now, jti: randomUUID(), requestBinding: binding,
    });
    const response = await transport(origin + path, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: payload }),
    });
    const payloadJson = await responseJson(response);
    if (!response.ok) throw responseError(response, payloadJson);
    return payloadJson?.item ?? payloadJson;
  }

  async function publicRequest(path) {
    const response = await transport(origin + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000) });
    const payload = await responseJson(response);
    if (!response.ok) throw responseError(response, payload);
    return payload?.item ?? payload;
  }

  return Object.freeze({
    async health() { return publicRequest("/healthz"); },
    async operations() { return request({ path: "/internal/ai/v1/operations", scopes: ["ai:ops:read"] }); },
    async proactiveSchedules() {
      return request({ path: "/internal/ai/v1/admin/schedules?taskType=proactive.analyze&enabled=true&limit=200", scopes: ["ai:admin:read"] });
    },
    async proactiveTasks() {
      return request({ path: "/internal/ai/v1/admin/tasks?taskType=proactive.analyze&limit=200", scopes: ["ai:admin:read"] });
    },
    async providerCanary(runId, sampleIndex) {
      return request({
        method: "POST",
        path: "/internal/ai/v1/provider-canaries",
        body: { runId, sampleIndex },
        idempotencyKey: providerCanaryIdempotencyKey(runId, sampleIndex),
        scopes: ["ai:provider:canary"],
      });
    },
    async readTask(taskId) {
      return request({ path: `/internal/ai/v1/tasks/${encodeURIComponent(taskId)}`, scopes: ["ai:task:read"] });
    },
    async taskDetail(taskId) {
      return request({ path: `/internal/ai/v1/admin/tasks/${encodeURIComponent(taskId)}`, scopes: ["ai:admin:read"] });
    },
  });
}

export function parseP2AcceptanceArguments(argv) {
  if (!Array.isArray(argv)) failure("P2_ACCEPTANCE_ARGUMENTS_INVALID");
  const values = {};
  for (const raw of argv) {
    const argument = String(raw);
    const match = argument.match(/^--([a-z0-9-]+)=(.*)$/u);
    if (!match || Object.hasOwn(values, match[1])) failure("P2_ACCEPTANCE_ARGUMENTS_INVALID");
    if (SENSITIVE_ARGUMENT.test(match[1])) failure("P2_ACCEPTANCE_SECRET_ARGUMENT_FORBIDDEN");
    values[match[1]] = match[2];
  }
  const required = ["source-commit", "policy", "provider-policies", "billing", "report", "confirm"];
  if (required.some((key) => !values[key])) failure("P2_ACCEPTANCE_ARGUMENTS_INVALID");
  if (values.confirm !== P2_ACCEPTANCE_LIVE_CONFIRMATION) failure("P2_LIVE_CONFIRMATION_REQUIRED");
  safeCommit(values["source-commit"]);
  const integerOption = (key, fallback, min, max) => values[key] === undefined
    ? fallback
    : safeInteger(Number(values[key]), `--${key}`, { min, max });
  const sampleCount = integerOption("sample-count", P2_ACCEPTANCE_DEFAULT_SAMPLE_COUNT, P2_ACCEPTANCE_MIN_SAMPLES, P2_ACCEPTANCE_MAX_SAMPLES);
  const taskTimeoutSeconds = integerOption("task-timeout-seconds", P2_ACCEPTANCE_DEFAULT_TASK_TIMEOUT_SECONDS, 1, P2_ACCEPTANCE_MAX_TIMEOUT_SECONDS);
  const pollIntervalSeconds = integerOption("poll-interval-seconds", P2_ACCEPTANCE_DEFAULT_POLL_INTERVAL_SECONDS, 1, 300);
  const observationSeconds = integerOption("observation-seconds", P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS, P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS, P2_ACCEPTANCE_MAX_OBSERVATION_SECONDS);
  const observationIntervalSeconds = integerOption("observation-interval-seconds", P2_ACCEPTANCE_DEFAULT_OBSERVATION_INTERVAL_SECONDS, 1, 3_600);
  if (values["resume-only"] !== undefined && !["true", "false"].includes(values["resume-only"])) failure("P2_ACCEPTANCE_ARGUMENTS_INVALID");
  return Object.freeze({
    sourceCommit: values["source-commit"], policyPath: resolve(values.policy), providerPoliciesPath: resolve(values["provider-policies"]),
    billingPath: resolve(values.billing), reportPath: resolve(values.report),
    checkpointPath: resolve(values.checkpoint ?? `${values.report}.checkpoint.json`), confirmation: values.confirm,
    baseUrl: values["base-url"] ?? P2_ACCEPTANCE_DEFAULT_BASE_URL, socketPath: values.socket ?? PRODUCTION_AI_SOCKET,
    owner: values.owner ?? P2_ACCEPTANCE_DEFAULT_OWNER, runId: values["run-id"] ?? randomUUID(), sampleCount,
    resumeOnly: values["resume-only"] === "true",
    taskTimeoutSeconds, pollIntervalSeconds, observationSeconds, observationIntervalSeconds,
  });
}

export function createP2AcceptanceSamples(runId, count = P2_ACCEPTANCE_DEFAULT_SAMPLE_COUNT) {
  safeId(runId, "runId");
  safeInteger(count, "sampleCount", { min: P2_ACCEPTANCE_MIN_SAMPLES, max: P2_ACCEPTANCE_MAX_SAMPLES });
  return Array.from({ length: count }, (_item, index) => {
    const id = `sample-${String(index + 1).padStart(3, "0")}`;
    const message = JSON.stringify({
      sampleId: id,
      runId,
      text: `Synthetic P2 acceptance sample ${index + 1}.`,
      output: "json-only",
    });
    return {
      id,
      input: {
        protocol: "chat.completions.v1",
        model: AI_TARGET_MODEL,
        reasoningEffort: AI_TARGET_REASONING_EFFORT,
        request: {
          model: AI_TARGET_MODEL,
          messages: [{ role: "user", content: message }],
          max_tokens: P2_ACCEPTANCE_SAMPLE_MAX_OUTPUT_TOKENS,
        },
      },
    };
  });
}

function assertHealth(health, policy, { allowCanaryProbe = false } = {}) {
  if (!isPlainRecord(health) || health.executionMode !== "external-provider" || health.externalProvidersEnabled !== true
    || health.proactiveScheduleOwner !== "backend" || health.targetModel !== AI_TARGET_MODEL
    || health.targetReasoningEffort !== AI_TARGET_REASONING_EFFORT
    || health.executor?.paused !== false || health.executor?.admissionOpen !== true
    || !Array.isArray(health.providers) || !health.providers.some((item) => item?.id === policy.providerId && item.kind !== "mock")) {
    failure("P2_RUNTIME_NOT_READY");
  }
  const readiness = health.tasks?.[P2_ACCEPTANCE_TASK_TYPE];
  const providerReady = readiness?.provider === policy.providerId
    && readiness?.probeReady === true
    && (allowCanaryProbe || (readiness.ready === true && readiness.liveReady === true));
  if (!providerReady) {
    failure("P2_PROVIDER_NOT_READY");
  }
}

function assertOperations(operations) {
  if (!isPlainRecord(operations) || operations.paused !== false || operations.executor?.admissionOpen !== true
    || !Number.isSafeInteger(operations.queue?.running) || operations.queue.running !== 0
    || !Number.isSafeInteger(operations.queue?.queued) || operations.queue.queued !== 0) {
    failure("P2_PLATFORM_NOT_OPEN");
  }
}

function assertProactiveClosed(value) {
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items) || items.some((item) => item?.enabled === true)) failure("P2_PROACTIVE_SCHEDULE_ENABLED");
}

function assertProactiveTasksClosed(value) {
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items) || items.some((item) => ["queued", "running"].includes(item?.status))) {
    failure("P2_PROACTIVE_TASK_ACTIVE");
  }
}

function normalizeUsage(value) {
  if (!isPlainRecord(value)) failure("P2_USAGE_INVALID");
  const usage = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["inputTokens", "outputTokens", "cachedInputTokens", "audioSeconds", "imagePages"].includes(key)) continue;
    usage[key] = safeInteger(Number(item), `usage.${key}`);
  }
  if (!Object.keys(usage).length || !Object.values(usage).some((item) => item > 0)) failure("P2_USAGE_INVALID");
  return usage;
}

function normalizeTaskEvidence(detail, policy, owner, runId) {
  const task = detail?.task;
  const attempts = detail?.attempts;
  const usageLedger = detail?.usageLedger;
  if (!isPlainRecord(task) || task.owner !== owner || task.feature !== P2_ACCEPTANCE_FEATURE
    || task.taskType !== P2_ACCEPTANCE_TASK_TYPE || task.channel !== "system"
    || task.subject?.type !== "p2_acceptance" || task.subject?.id !== runId || task.status !== "succeeded"
    || !Array.isArray(attempts) || attempts.length !== 1 || !Array.isArray(usageLedger) || usageLedger.length !== 1) {
    failure("P2_SAMPLE_TASK_INVALID");
  }
  const [attempt] = attempts;
  const [ledger] = usageLedger;
  const providerRequestId = attempt?.externalRequestId;
  if (!isPlainRecord(attempt) || attempt.status !== "succeeded" || attempt.providerId !== policy.providerId
    || attempt.modelId !== policy.modelId || typeof providerRequestId !== "string" || !SAFE_ID.test(providerRequestId)
    || typeof attempt.priceVersionId !== "string" || !SAFE_ID.test(attempt.priceVersionId)
    || attempt.priceVersionId !== policy.priceVersionId
    || attempt.costStatus !== "calculated" || !Number.isSafeInteger(attempt.costMicro) || attempt.costMicro < 0) {
    failure("P2_SAMPLE_ATTEMPT_INVALID");
  }
  const usage = normalizeUsage(attempt.usage);
  // The authenticated admin task contract exposes the persisted model result
  // as `output`; older test harnesses used the terminal task shape's `result`.
  // Accept both shapes so live acceptance validates the same evidence that
  // the production admin endpoint actually returns.
  const result = task?.output ?? task?.result;
  const actualModel = result?.metadata?.actualModel;
  if (typeof actualModel !== "string" || !SAFE_ID.test(actualModel)) failure("P2_MODEL_IDENTITY_INVALID");
  if (actualModel !== policy.modelName) failure("P2_MODEL_IDENTITY_MISMATCH");
  const finishReason = result?.metadata?.finishReason;
  if (finishReason !== "stop") failure("P2_FINISH_REASON_INVALID");
  if (!isPlainRecord(ledger) || ledger.providerId !== policy.providerId || ledger.modelId !== policy.modelId
    || ledger.priceVersionId !== attempt.priceVersionId || ledger.costStatus !== "calculated"
    || ledger.currency === undefined || ledger.costMicro !== attempt.costMicro) {
    failure("P2_USAGE_LEDGER_INVALID");
  }
  return {
    requestId: safeId(task.requestId, "task.requestId"), providerRequestId, actualModel, finishReason, priceVersion: attempt.priceVersionId,
    usage, cost: { micro: attempt.costMicro, currency: ledger.currency, status: "calculated" },
  };
}

async function waitForTerminal(client, taskId, { timeoutMs, pollIntervalMs, clock, sleep }) {
  const startedAt = nowMs(clock);
  while (true) {
    const task = await client.readTask(taskId);
    if (TERMINAL.has(task?.status)) return task;
    if (nowMs(clock) - startedAt >= timeoutMs) failure("P2_SAMPLE_TIMEOUT");
    await sleep(pollIntervalMs);
  }
}

async function observeWindow(client, {
  durationSeconds, intervalSeconds, clock, sleep, policy, checks = [], onCheck = null,
}) {
  const observedChecks = [...checks];
  let firstCheckAt = observedChecks[0]?.at ?? null;
  while (true) {
    const health = await client.health();
    assertHealth(health, policy);
    const operations = await client.operations();
    assertOperations(operations);
    assertProactiveClosed(await client.proactiveSchedules());
    assertProactiveTasksClosed(await client.proactiveTasks());
    observedChecks.push({ at: nowIso(clock), status: "passed" });
    firstCheckAt ??= observedChecks[0].at;
    const previousAt = observedChecks.at(-2)?.at;
    if (previousAt && (Date.parse(observedChecks.at(-1).at) - Date.parse(previousAt) > (intervalSeconds + 30) * 1_000
      || Date.parse(observedChecks.at(-1).at) < Date.parse(previousAt))) {
      failure("P2_OBSERVATION_GAP");
    }
    if (typeof onCheck === "function") await onCheck(observedChecks);
    const elapsed = nowMs(clock) - Date.parse(firstCheckAt);
    if (elapsed >= durationSeconds * 1_000) {
      return { startedAt: firstCheckAt, checks: observedChecks, finishedAt: nowIso(clock), durationSeconds: Math.floor(elapsed / 1_000) };
    }
    await sleep(Math.min(intervalSeconds * 1_000, durationSeconds * 1_000 - elapsed));
  }
}

export async function runP2Acceptance({
  sourceCommit,
  deploymentPolicy,
  providerPolicies,
  billing = null,
  billingLoader = null,
  client,
  runId = randomUUID(),
  owner = P2_ACCEPTANCE_DEFAULT_OWNER,
  sampleCount = P2_ACCEPTANCE_DEFAULT_SAMPLE_COUNT,
  taskTimeoutSeconds = P2_ACCEPTANCE_DEFAULT_TASK_TIMEOUT_SECONDS,
  pollIntervalSeconds = P2_ACCEPTANCE_DEFAULT_POLL_INTERVAL_SECONDS,
  observationSeconds = P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS,
  observationIntervalSeconds = P2_ACCEPTANCE_DEFAULT_OBSERVATION_INTERVAL_SECONDS,
  checkpointPath = null,
  resumeOnly = false,
  liveConfirmation,
  clock = () => new Date(),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  safeCommit(sourceCommit);
  if (liveConfirmation !== P2_ACCEPTANCE_LIVE_CONFIRMATION) failure("P2_LIVE_CONFIRMATION_REQUIRED");
  safeId(runId, "runId");
  safeId(owner, "owner");
  safeInteger(sampleCount, "sampleCount", { min: P2_ACCEPTANCE_MIN_SAMPLES, max: P2_ACCEPTANCE_MAX_SAMPLES });
  safeInteger(taskTimeoutSeconds, "taskTimeoutSeconds", { min: 1, max: P2_ACCEPTANCE_MAX_TIMEOUT_SECONDS });
  safeInteger(pollIntervalSeconds, "pollIntervalSeconds", { min: 1, max: 300 });
  safeInteger(observationSeconds, "observationSeconds", { min: P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS, max: P2_ACCEPTANCE_MAX_OBSERVATION_SECONDS });
  safeInteger(observationIntervalSeconds, "observationIntervalSeconds", { min: 1, max: 3_600 });
  if (!client) failure("P2_ACCEPTANCE_CLIENT_REQUIRED");

  const providers = parseProviderPolicies(providerPolicies);
  const policy = normalizeDeploymentPolicy(deploymentPolicy, sourceCommit, providers);
  const expectedProviderPolicyDigest = providerPolicyDigest(providers);
  const generatedRunId = runId;
  let checkpointState = null;
  let currentPhase = "collecting";

  const persist = (nextState) => {
    checkpointState = nextState;
    writeCheckpoint(checkpointPath, nextState);
    return nextState;
  };

  const recordFailure = (error) => {
    if (checkpointPath && checkpointState) {
      try {
        const code = /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "P2_ACCEPTANCE_FAILED";
        checkpointState = {
          ...checkpointState,
          phase: "failed",
          updatedAt: nowIso(clock),
          failure: { code, at: nowIso(clock), resumePhase: currentPhase },
        };
        writeCheckpoint(checkpointPath, checkpointState);
      } catch {
        // The original acceptance error is more useful than masking it with a
        // filesystem error while attempting to preserve the checkpoint.
      }
    }
    throw error;
  };

  const readBilling = async () => (
    typeof billingLoader === "function"
      ? await billingLoader()
      : billing === null
        ? { entries: [] }
        : billing
  );

  const replaceSample = (state, sampleIndex, patch) => ({
    ...state,
    samples: state.samples.map((sample) => sample.sampleIndex === sampleIndex
      ? { ...sample, ...patch }
      : sample),
  });

  const assertSettledResponse = (settled, sampleIndex) => {
    if (!isPlainRecord(settled) || settled.ready !== true
      || !isPlainRecord(settled.evidence) || settled.evidence.runId !== generatedRunId
      || settled.evidence.sampleIndex !== sampleIndex || settled.evidence.settledStatus !== "settled") {
      failure("P2_SAMPLE_SETTLEMENT_INVALID");
    }
    return settled;
  };

  const reconcileEvidence = (evidence, entries, { observedAt = null } = {}) => evidence.map((sample) => {
    const reconciliation = entries.get(sample.providerRequestId);
    if (!reconciliation || reconciliation.currency !== sample.cost.currency
      || reconciliation.amountMicro !== sample.cost.micro) {
      failure("P2_BILLING_RECONCILIATION_MISSING");
    }
    return {
      ...sample,
      approved: true,
      billingReconciliation: reconciliation,
      observedAt: observedAt ?? sample.observedAt ?? nowIso(clock),
    };
  });

  try {
    const existing = readCheckpoint(checkpointPath);
    if (existing) {
      validateCheckpointMatches(existing, {
        runId: generatedRunId, sourceCommit, policyDigest: policy.digest,
        providerPolicyDigest: expectedProviderPolicyDigest, owner, sampleCount,
      });
      if (existing.phase === "completed") {
        return Object.freeze(validateCompletedCheckpoint(existing, {
          sourceCommit, policyDigest: policy.digest,
          providerPolicyDigest: expectedProviderPolicyDigest, currency: policy.currency, now: nowMs(clock),
        }));
      }
      checkpointState = existing;
      if (existing.phase === "failed") {
        currentPhase = existing.failure.resumePhase;
        persist({ ...existing, phase: currentPhase, failure: null, updatedAt: nowIso(clock) });
      }
    } else {
      if (resumeOnly) failure("P2_RESUME_CHECKPOINT_REQUIRED");
      checkpointState = initialCheckpoint({
        runId: generatedRunId, sourceCommit, policyDigest: policy.digest,
        providerPolicyDigest: expectedProviderPolicyDigest, owner, sampleCount, startedAt: nowIso(clock),
      });
      persist(checkpointState);
    }

    if (resumeOnly && checkpointState.samples.some((sample) => sample.status !== "settled")) {
      failure("P2_RESUME_REQUIRES_SETTLED_SAMPLES");
    }
    const healthBefore = await client.health();
    // The first controlled canary is the operation that creates live evidence.
    // Before it settles, probeReady is the only valid admission state; every
    // later health check must require the resulting liveReady evidence.
    assertHealth(healthBefore, policy, {
      allowCanaryProbe: !checkpointState.samples.some((sample) => sample.status === "settled"),
    });
    const operationsBefore = await client.operations();
    assertOperations(operationsBefore);
    assertProactiveClosed(await client.proactiveSchedules());
    assertProactiveTasksClosed(await client.proactiveTasks());

    const evidence = [];
    for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
      currentPhase = "collecting";
      let sample = checkpointSample(checkpointState, sampleIndex);
      if (sample.status === "pending") {
        const created = await client.providerCanary(generatedRunId, sampleIndex);
        const taskId = created?.taskId;
        if (typeof taskId !== "string" || !SAFE_ID.test(taskId)) failure("P2_SAMPLE_CREATE_INVALID");
        checkpointState = persist(replaceSample(checkpointState, sampleIndex, {
          status: "requested", taskId, requestedAt: nowIso(clock),
        }));
        sample = checkpointSample(checkpointState, sampleIndex);
      }
      if (sample.status === "requested") {
        const terminal = await waitForTerminal(client, sample.taskId, {
          timeoutMs: taskTimeoutSeconds * 1_000, pollIntervalMs: pollIntervalSeconds * 1_000, clock, sleep,
        });
        if (terminal.status !== "succeeded") failure("P2_SAMPLE_FAILED");
        checkpointState = persist(replaceSample(checkpointState, sampleIndex, {
          status: "succeeded", succeededAt: nowIso(clock), terminalStatus: terminal.status,
        }));
        sample = checkpointSample(checkpointState, sampleIndex);
      }
      if (sample.status === "succeeded") {
        const settled = assertSettledResponse(await client.providerCanary(generatedRunId, sampleIndex), sampleIndex);
        const detail = await client.taskDetail(sample.taskId);
        const normalized = normalizeTaskEvidence(detail, policy, owner, generatedRunId);
        checkpointState = persist(replaceSample(checkpointState, sampleIndex, {
          status: "settled", settledAt: nowIso(clock),
          settlement: settled.evidence, evidence: normalized,
        }));
        sample = checkpointSample(checkpointState, sampleIndex);
      }
      if (sample.status !== "settled") failure("P2_CHECKPOINT_INVALID", "sample did not reach settled state");
      // Older checkpoints predate persisted actualModel. Re-read the completed
      // task detail to upgrade them without creating another provider task or
      // replaying a paid completion.
      if (!sample.evidence?.actualModel) {
        const detail = await client.taskDetail(sample.taskId);
        const normalized = normalizeTaskEvidence(detail, policy, owner, generatedRunId);
        checkpointState = persist(replaceSample(checkpointState, sampleIndex, { evidence: normalized }));
        sample = checkpointSample(checkpointState, sampleIndex);
      }
      evidence.push({ ...normalizeStoredEvidence(sample.evidence), requestedAt: sample.requestedAt, settledAt: sample.settledAt });
      if (sampleIndex === 1) assertHealth(await client.health(), policy);
    }

    // Provider exports can arrive hours after settlement. Observe immediately;
    // the final reconciliation remains mandatory before producing a pass.
    currentPhase = "observing";
    let observation = checkpointState.observation;
    if (observation && observation.finishedAt === null) {
      const lastCheckAt = Date.parse(observation.checks.at(-1)?.at ?? observation.startedAt);
      const elapsed = nowMs(clock) - lastCheckAt;
      if (elapsed < 0 || elapsed > (observationIntervalSeconds + 30) * 1_000) {
        checkpointState = persist({
          ...checkpointState,
          observationHistory: [...(checkpointState.observationHistory ?? []), {
            ...observation, invalidatedAt: nowIso(clock), reason: "P2_OBSERVATION_GAP",
          }],
          observation: null,
        });
        observation = null;
      }
    }
    if (!observation) {
      observation = { startedAt: nowIso(clock), finishedAt: null, checks: [], intervalSeconds: observationIntervalSeconds };
      checkpointState = persist({ ...checkpointState, phase: "observing", observation });
    }
    canonicalIso(observation.startedAt, "checkpoint.observation.startedAt");
    if (observation.finishedAt !== null) {
      canonicalIso(observation.finishedAt, "checkpoint.observation.finishedAt");
    } else {
      const observed = await observeWindow(client, {
        durationSeconds: observationSeconds,
        intervalSeconds: observationIntervalSeconds,
        clock, sleep, policy,
        checks: observation.checks,
        onCheck: async (checks) => {
          checkpointState = persist({
            ...checkpointState,
            phase: "observing",
            observation: { ...checkpointState.observation, startedAt: checks[0].at, checks, finishedAt: null },
            failure: null,
          });
        },
      });
      observation = { ...observation, ...observed };
      checkpointState = persist({ ...checkpointState, phase: "reconciling", observation, failure: null });
    }

    currentPhase = "reconciling";
    const finalBillingInput = await readBilling();
    let aggregateBilling = null;
    let finalBillingEntries = null;
    let samplesWithBilling;
    if (finalBillingInput?.scope === "aggregate") {
      aggregateBilling = createDeepSeekAggregateReconciliation({
        ...readAggregateBillingInput(finalBillingInput), samples: evidence, runId: generatedRunId, sourceCommit,
      });
      samplesWithBilling = evidence.map((sample) => ({
        ...sample, approved: true, observedAt: nowIso(clock),
        billingReconciliation: { scope: "aggregate", status: "covered", aggregateDigest: aggregateBilling.digest },
      }));
    } else {
      finalBillingEntries = normalizeBillingEntries(finalBillingInput);
      if (finalBillingEntries.size !== evidence.length) failure("P2_BILLING_RECONCILIATION_MISSING");
      samplesWithBilling = reconcileEvidence(evidence, finalBillingEntries, {
        observedAt: checkpointState.samples[0]?.observedAt ?? nowIso(clock),
      });
    }
    checkpointState = persist({
      ...checkpointState,
      phase: "finalizing",
      samples: checkpointState.samples.map((sample, index) => ({
        ...sample,
        ...(samplesWithBilling[index] ? { billingReconciliation: samplesWithBilling[index].billingReconciliation, observedAt: samplesWithBilling[index].observedAt } : {}),
      })),
      billing: {
        ...(checkpointState.billing ?? {}),
        final: {
          status: "reconciled", checkedAt: nowIso(clock),
          scope: aggregateBilling ? "aggregate" : "request",
          entryCount: evidence.length,
          entriesDigest: aggregateBilling?.digest ?? billingEntriesDigest(finalBillingEntries),
          ...(aggregateBilling ? { aggregate: aggregateBilling } : {}),
        },
      },
      failure: null,
    });

    currentPhase = "finalizing";
    const generatedAt = nowIso(clock);
    const completedBase = {
      ...checkpointState,
      phase: "completed",
      updatedAt: generatedAt,
      report: null,
      failure: null,
    };
    const reportCheckpointDigest = checkpointStateDigest(completedBase);
    const report = {
      schemaVersion: 1,
      status: "passed",
      phase: "P2",
      sourceCommit,
      policyDigest: policy.digest,
      providerPolicyDigest: expectedProviderPolicyDigest,
      generatedAt,
      checkpointDigest: reportCheckpointDigest,
      observation: {
        startedAt: observation.startedAt, finishedAt: observation.finishedAt,
        durationSeconds: observation.durationSeconds ?? Math.floor((Date.parse(observation.finishedAt) - Date.parse(observation.startedAt)) / 1_000),
        checks: observation.checks, intervalSeconds: observation.intervalSeconds ?? observationIntervalSeconds,
      },
      summary: { total: samplesWithBilling.length, approved: samplesWithBilling.length, failed: 0 },
      failures: [],
      samples: samplesWithBilling,
      ...(aggregateBilling ? { billingReconciliation: aggregateBilling } : {}),
      producerProvenance: {
        controlled: true, producerId: P2_ACCEPTANCE_PRODUCER_ID, producerVersion: P2_ACCEPTANCE_PRODUCER_VERSION,
        sourceCommit, generatedAt, runId: generatedRunId,
        sourceIdentity: "runtime-under-test",
        processorFiles: ["p2-acceptance.mjs", "p2-billing-aggregate.mjs", "production-contract.mjs"].map((name) => ({
          path: `scripts/ai-platform/${name}`, sha256: hashBytes(readFileSync(new URL(name, import.meta.url))),
        })),
      },
      runtime: {
        executionMode: "external-provider", externalProvidersEnabled: true, providerId: policy.providerId,
        modelId: policy.modelId, modelName: policy.modelName, singleConcurrency: true,
        observationChecks: observation.checks.length,
      },
      sideEffects: { businessDatabaseAccessed: false, notificationsInvoked: false, proactiveSchedulesChanged: false },
    };
    validateP2AcceptanceReport(report, {
      sourceCommit, policyDigest: policy.digest, providerPolicyDigest: expectedProviderPolicyDigest,
      currency: policy.currency, now: nowMs(clock),
    });
    persist({ ...completedBase, report });
    return Object.freeze(report);
  } catch (error) {
    return recordFailure(error);
  }
}

export function writeP2AcceptanceReport(path, report) {
  const absolute = resolve(path);
  const content = checkpointContent(report);
  const fileOptions = { ownerUid: process.getuid?.() ?? 0 };
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  if (!existsSync(absolute)) return writeOnceOrVerify(absolute, content, fileOptions);
  const existing = privateFile(absolute, null, fileOptions);
  if (existing.sha256 === hashBytes(content)) return existing.sha256;
  let previous;
  try { previous = JSON.parse(existing.content.toString("utf8")); } catch { failure("P2_REPORT_REPLACE_FORBIDDEN"); }
  if (previous.status !== "failed" || previous.sourceCommit !== report.sourceCommit
    || previous.producerProvenance?.runId !== report.producerProvenance?.runId) failure("P2_REPORT_REPLACE_FORBIDDEN");
  writeOnceOrVerify(`${absolute}.failed-${existing.sha256}.json`, existing.content, fileOptions);
  atomicReplace(absolute, content, existing.sha256, fileOptions);
  return hashBytes(content);
}

function writeFailureReport(path, { sourceCommit, runId, error, clock }) {
  const report = {
    schemaVersion: 1, status: "failed", phase: "P2", sourceCommit: COMMIT.test(sourceCommit ?? "") ? sourceCommit : null,
    generatedAt: nowIso(clock), summary: { total: 0, approved: 0, failed: 1 },
    failures: [{ code: /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "P2_ACCEPTANCE_FAILED" }],
    producerProvenance: { controlled: true, producerId: P2_ACCEPTANCE_PRODUCER_ID, producerVersion: P2_ACCEPTANCE_PRODUCER_VERSION, runId },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeExclusive(path, JSON.stringify(report, null, 2) + "\n");
  return report;
}

async function main() {
  const options = parseP2AcceptanceArguments(process.argv.slice(2));
  const env = process.env;
  const runId = options.runId;
  try {
    const result = await runP2Acceptance({
      sourceCommit: options.sourceCommit,
      deploymentPolicy: parseJsonFile(options.policyPath, "deployment policy"),
      providerPolicies: parseProviderPolicies(parseJsonFile(options.providerPoliciesPath, "provider policies")),
      billingLoader: () => existsSync(options.billingPath)
        ? parseJsonFile(options.billingPath, "billing reconciliation")
        : { entries: [] },
      client: createP2AcceptanceClient({
        secret: env.AI_PLATFORM_AUTH_SECRET, issuer: env.AI_PLATFORM_TRUSTED_ISSUER,
        owner: options.owner, baseUrl: options.baseUrl, socketPath: options.socketPath,
      }),
      runId, owner: options.owner, sampleCount: options.sampleCount,
      taskTimeoutSeconds: options.taskTimeoutSeconds, pollIntervalSeconds: options.pollIntervalSeconds,
      observationSeconds: options.observationSeconds, observationIntervalSeconds: options.observationIntervalSeconds,
      checkpointPath: options.checkpointPath,
      resumeOnly: options.resumeOnly,
      liveConfirmation: options.confirmation,
    });
    mkdirSync(dirname(options.reportPath), { recursive: true, mode: 0o700 });
    writeP2AcceptanceReport(options.reportPath, result);
    process.stdout.write(JSON.stringify({ status: result.status, report: options.reportPath, checkpoint: options.checkpointPath, runId, sampleCount: result.samples.length }) + "\n");
  } catch (error) {
    try { writeFailureReport(options.reportPath, { sourceCommit: options.sourceCommit, runId, error, clock: () => new Date() }); } catch {}
    process.stderr.write(JSON.stringify({ status: "failed", code: /^[A-Za-z0-9_.:-]{1,100}$/u.test(error?.code ?? "") ? error.code : "P2_ACCEPTANCE_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
