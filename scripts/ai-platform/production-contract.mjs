import { createHash } from "node:crypto";
import { posix } from "node:path";
import { sha256 as canonicalSha256 } from "../../shared/aiPlatformContract.mjs";

export const PRODUCTION_ROOT = "/opt/sentelligent-sales-workbench";
export const PLATFORM_SERVICE = "sentelligent-ai-platform.service";
export const PLATFORM_DATABASE = "/var/lib/sentelligent-ai-platform/ai-platform.sqlite";
export const PLATFORM_USER = "sentai";
// The platform never joins the business service group.  This dedicated group
// is the only shared boundary needed for Backend -> AI Platform socket access.
export const PLATFORM_SOCKET_GROUP = "sentelligent-ai";
export const PROJECT_NODE = PRODUCTION_ROOT + "/runtime/node-v24/bin/node";
export const PROTECTED_UNITS = ["sentelligent-caddy.service", "qingyang-store.service"];
export const CORE_UNITS = ["sentelligent-backend.service", "sentelligent-frontend.service", "sentelligent-weixin-agent.service"];
export const PLATFORM_ENV = PRODUCTION_ROOT + "/config/ai-platform.env";
export const BUSINESS_ENV = PRODUCTION_ROOT + "/config/backend.env";
export const BUSINESS_DATABASE = "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite";
export const WEIXIN_SESSION = PRODUCTION_ROOT + "/weixin-session";
export const ROLLOUT_PHASES = Object.freeze(["P1", "P2", "P3", "P4", "P5", "P6"]);
export const AI_PREFLIGHT_CHECKS = Object.freeze([
  "host.identity", "release.archive", "environment.binding", "supplier.acceptance",
  "resources.acceptance", "platform.service", "platform.database", "platform.runtime", "core.preflight",
]);

const ROLLOUT_PHASE_ORDER = Object.freeze(Object.fromEntries(ROLLOUT_PHASES.map((phase, index) => [phase, index + 1])));

export const P2_ACCEPTANCE_SCHEMA_VERSION = 1;
export const P2_ACCEPTANCE_MIN_SAMPLES = 10;
export const P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS = 2 * 60 * 60;
export const P2_ACCEPTANCE_MAX_AGE_MS = 24 * 60 * 60_000;
export const P2_ACCEPTANCE_PRODUCER_ID = "ai-platform-p2-acceptance";
export const P2_ACCEPTANCE_PRODUCER_VERSION = "1";

const ACCEPTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const ACCEPTANCE_COMMIT = /^[0-9a-f]{40}$/u;
const ACCEPTANCE_DIGEST = /^[0-9a-f]{64}$/u;
const ACCEPTANCE_CURRENCIES = new Set(["CNY", "USD"]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function contractError(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function requireAcceptanceId(value, name) {
  if (typeof value !== "string" || !ACCEPTANCE_ID.test(value)) contractError("P2_ACCEPTANCE_INVALID", `${name} is invalid`);
  return value;
}

function requireAcceptanceDigest(value, name, length = 64) {
  const pattern = length === 40 ? ACCEPTANCE_COMMIT : ACCEPTANCE_DIGEST;
  if (typeof value !== "string" || !pattern.test(value)) contractError("P2_ACCEPTANCE_INVALID", `${name} is invalid`);
  return value;
}

function exactIsoDate(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    contractError("P2_ACCEPTANCE_INVALID", `${name} is invalid`);
  }
  const parsed = Date.parse(value);
  if (new Date(parsed).toISOString() !== value) contractError("P2_ACCEPTANCE_INVALID", `${name} must be canonical ISO-8601`);
  return parsed;
}

export function rolloutControlsForPhase(value) {
  const phase = normalizeRolloutPhase(value);
  const platformPaused = phase === "P1";
  const singleConcurrency = phase === "P1" || phase === "P2";
  const controls = {
    rolloutPhase: phase,
    routingPhase: routingPhaseForRollout(phase),
    executionMode: phase === "P1" ? "local-simulated" : "external-provider",
    externalProvidersEnabled: phase !== "P1",
    // P2 is a platform-only live-provider acceptance window.  Its queue is
    // open for explicitly controlled samples, while Backend business routing
    // remains on the legacy path until P3.
    taskAdmissionEnabled: !platformPaused,
    queuePaused: platformPaused,
    businessAdmission: compareRolloutPhase(phase, "P3") >= 0,
    singleConcurrency,
    taskConcurrency: singleConcurrency ? 1 : null,
    taskOwnerConcurrency: singleConcurrency ? 1 : null,
  };
  return Object.freeze(controls);
}

export function validateRolloutConfiguration(value, config = {}) {
  const controls = rolloutControlsForPhase(value);
  if (!isPlainRecord(config)) contractError("ROLLOUT_CONFIGURATION_INVALID");
  if (config.executionMode !== controls.executionMode) contractError("ROLLOUT_EXECUTION_MODE_INVALID");
  if (config.externalProvidersEnabled !== controls.externalProvidersEnabled) contractError("ROLLOUT_EXTERNAL_PROVIDER_MODE_INVALID");
  if (config.taskAdmissionEnabled !== controls.taskAdmissionEnabled) contractError("ROLLOUT_TASK_ADMISSION_INVALID");
  if (controls.singleConcurrency
    && (config.taskConcurrency !== 1 || config.taskOwnerConcurrency !== 1)) {
    contractError("ROLLOUT_SINGLE_CONCURRENCY_REQUIRED");
  }
  return controls;
}

export function validateRolloutRuntime(value, { operations, backendHealth = null, requireQueueEmpty = false } = {}) {
  const controls = rolloutControlsForPhase(value);
  if (!isPlainRecord(operations)) contractError("ROLLOUT_RUNTIME_INVALID");
  const queue = operations.queue;
  const executor = operations.executor;
  if (!isPlainRecord(queue) || !isPlainRecord(executor)
    || !Number.isSafeInteger(queue.running) || queue.running < 0
    || !Number.isSafeInteger(queue.queued) || queue.queued < 0) {
    contractError("ROLLOUT_RUNTIME_INVALID");
  }
  if (controls.queuePaused) {
    if (operations.paused !== true || executor.admissionOpen !== false) contractError("ROLLOUT_QUEUE_MUST_BE_PAUSED");
  } else if (operations.paused !== false || executor.admissionOpen !== true) {
    contractError("ROLLOUT_BUSINESS_ADMISSION_REQUIRED");
  }
  if (requireQueueEmpty && (queue.running !== 0 || queue.queued !== 0)) contractError("ROLLOUT_QUEUE_NOT_EMPTY");
  const routingPhase = backendHealth?.aiPlatform?.routing?.phase;
  if (routingPhase !== undefined && routingPhase !== controls.routingPhase) contractError("ROLLOUT_BACKEND_ROUTING_INVALID");
  return controls;
}

export function providerPolicyDigest(providerPolicies) {
  if (!Array.isArray(providerPolicies)) contractError("PROVIDER_POLICY_DIGEST_INPUT_INVALID");
  return canonicalSha256(providerPolicies);
}

function probeState(probe) {
  if (!isPlainRecord(probe) || probe.status !== "passed") return "none";
  const source = probe.source ?? probe.type;
  if (!ACCEPTANCE_ID.test(String(probe.requestId ?? "")) || !Number.isFinite(Date.parse(probe.observedAt ?? ""))) return "none";
  if (source === "live" || source === "external-provider") return "live";
  if (source === "endpoint" || source === "health") return "probe";
  return "none";
}

export function providerReadiness({
  providerKind, configured = false, probe = null, capability = true,
} = {}) {
  const configuredReady = configured === true && capability !== false;
  if (providerKind === "mock") {
    return Object.freeze({ configured: configuredReady, probeReady: configuredReady, liveReady: configuredReady, ready: configuredReady });
  }
  const state = configuredReady ? probeState(probe) : "none";
  const probeReady = state === "probe" || state === "live";
  const liveReady = state === "live";
  return Object.freeze({ configured: configuredReady, probeReady, liveReady, ready: liveReady });
}

export function providerReadinessFromHealth(entry, { providerKind = entry?.providerKind ?? entry?.kind } = {}) {
  const value = isPlainRecord(entry) ? entry : {};
  const nested = isPlainRecord(value.readiness) ? value.readiness : value;
  const configured = nested.configured === true || value.configured === true || value.ready === true;
  const probe = nested.probe ?? value.probe ?? null;
  return providerReadiness({ providerKind, configured, probe });
}

function validateUsage(usage, index) {
  if (!isPlainRecord(usage)) contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].usage is invalid`);
  const usageFields = ["inputTokens", "outputTokens", "cachedInputTokens", "audioSeconds", "imagePages", "promptTokens", "completionTokens"];
  const present = usageFields.filter((field) => usage[field] !== undefined);
  if (!present.length || present.some((field) => typeof usage[field] !== "number" || !Number.isFinite(usage[field]) || usage[field] < 0)) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].usage must contain recorded non-negative metrics`);
  }
}

function validateCost(cost, index, currency) {
  if (!isPlainRecord(cost)) contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].cost is invalid`);
  const amountMicro = cost.micro ?? cost.amountMicro ?? cost.costMicro;
  if (!Number.isSafeInteger(amountMicro) || amountMicro < 0
    || typeof cost.currency !== "string" || !ACCEPTANCE_CURRENCIES.has(cost.currency)
    || (currency !== undefined && cost.currency !== currency)
    || (cost.status ?? "calculated") !== "calculated") {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].cost is invalid`);
  }
  return { amountMicro, currency: cost.currency };
}

function validateBillingReconciliation(value, index, { providerRequestId, cost } = {}) {
  if (!isPlainRecord(value) || (value.status !== "reconciled" && value.reconciled !== true)) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].billingReconciliation is not reconciled`);
  }
  for (const field of ["checkedAt", "reconciledAt"]) {
    if (value[field] !== undefined) exactIsoDate(value[field], `samples[${index}].billingReconciliation.${field}`);
  }
  if (value.reference !== undefined) requireAcceptanceId(value.reference, `samples[${index}].billingReconciliation.reference`);
  if (value.providerRequestId !== undefined && value.providerRequestId !== providerRequestId) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].billingReconciliation.providerRequestId does not match`);
  }
  const billedMicro = value.micro ?? value.amountMicro ?? value.costMicro;
  if (billedMicro !== undefined && (!Number.isSafeInteger(billedMicro) || billedMicro < 0 || billedMicro !== cost.amountMicro)) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].billingReconciliation amount does not match`);
  }
  if (value.currency !== undefined && value.currency !== cost.currency) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].billingReconciliation currency does not match`);
  }
}

function validateP2Sample(sample, index, { currency, expectedModelName = null } = {}) {
  if (!isPlainRecord(sample) || sample.approved !== true) contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}] must be approved`);
  requireAcceptanceId(sample.requestId, `samples[${index}].requestId`);
  const providerRequestId = sample.providerRequestId ?? sample.externalRequestId;
  requireAcceptanceId(providerRequestId, `samples[${index}].providerRequestId`);
  requireAcceptanceId(sample.actualModel, `samples[${index}].actualModel`);
  if (expectedModelName !== null && sample.actualModel !== expectedModelName) {
    contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].actualModel does not match runtime.modelName`);
  }
  if (sample.finishReason !== "stop") contractError("P2_ACCEPTANCE_SAMPLE_INVALID", `samples[${index}].finishReason must be stop`);
  const priceVersion = typeof sample.priceVersion === "string" ? sample.priceVersion : sample.priceVersion?.id ?? sample.priceVersionId;
  requireAcceptanceId(priceVersion, `samples[${index}].priceVersion`);
  validateUsage(sample.usage, index);
  const cost = validateCost(sample.cost, index, currency);
  validateBillingReconciliation(sample.billingReconciliation, index, { providerRequestId, cost });
  if (sample.observedAt !== undefined) exactIsoDate(sample.observedAt, `samples[${index}].observedAt`);
  return { requestId: sample.requestId, providerRequestId, priceVersion };
}

export function validateP2AcceptanceReport(input, {
  sourceCommit,
  policyDigest,
  providerPolicyDigest: expectedProviderPolicyDigest,
  currency,
  now = Date.now(),
  maxAgeMs = P2_ACCEPTANCE_MAX_AGE_MS,
} = {}) {
  if (!isPlainRecord(input)
    || input.schemaVersion !== P2_ACCEPTANCE_SCHEMA_VERSION
    || input.status !== "passed"
    || (input.phase ?? input.rolloutPhase) !== "P2"
    || !isPlainRecord(input.summary)
    || input.summary.failed !== 0
    || !Array.isArray(input.samples)
    || input.samples.length > 1_000) {
    contractError("P2_ACCEPTANCE_INVALID");
  }
  const reportCommit = input.sourceCommit ?? input.commit;
  requireAcceptanceDigest(reportCommit, "sourceCommit", 40);
  if (sourceCommit !== undefined && reportCommit !== sourceCommit) contractError("P2_ACCEPTANCE_COMMIT_MISMATCH");
  requireAcceptanceDigest(input.policyDigest, "policyDigest");
  if (policyDigest !== undefined && input.policyDigest !== policyDigest) contractError("P2_ACCEPTANCE_POLICY_DIGEST_MISMATCH");
  requireAcceptanceDigest(input.providerPolicyDigest, "providerPolicyDigest");
  if (expectedProviderPolicyDigest !== undefined && input.providerPolicyDigest !== expectedProviderPolicyDigest) contractError("P2_ACCEPTANCE_PROVIDER_POLICY_DIGEST_MISMATCH");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 7 * 24 * 60 * 60_000) contractError("P2_ACCEPTANCE_INVALID");

  const generatedAtMs = exactIsoDate(input.generatedAt, "generatedAt");
  if (!Number.isFinite(now) || now - generatedAtMs > maxAgeMs || now - generatedAtMs < -30_000) contractError("P2_ACCEPTANCE_STALE");

  const observation = input.observation;
  if (!isPlainRecord(observation)) contractError("P2_ACCEPTANCE_OBSERVATION_INVALID");
  const startedAtMs = exactIsoDate(observation.startedAt, "observation.startedAt");
  const finishedAtMs = exactIsoDate(observation.finishedAt, "observation.finishedAt");
  const durationSeconds = observation.durationSeconds;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS
    || finishedAtMs < startedAtMs || finishedAtMs - startedAtMs < P2_ACCEPTANCE_MIN_OBSERVATION_SECONDS * 1_000
    || finishedAtMs > now + 30_000) contractError("P2_ACCEPTANCE_OBSERVATION_INVALID");

  const failures = input.failures ?? [];
  if (!Array.isArray(failures) || failures.length !== 0) contractError("P2_ACCEPTANCE_FAILURES_PRESENT");
  const expectedModelName = typeof input.runtime?.modelName === "string" ? input.runtime.modelName : null;
  const samples = input.samples.map((sample, index) => validateP2Sample(sample, index, { currency, expectedModelName }));
  const requestIds = new Set(samples.map((sample) => sample.requestId));
  if (requestIds.size !== samples.length) contractError("P2_ACCEPTANCE_DUPLICATE_REQUEST_ID");
  const providerRequestIds = new Set(samples.map((sample) => sample.providerRequestId));
  if (providerRequestIds.size !== samples.length) contractError("P2_ACCEPTANCE_DUPLICATE_PROVIDER_REQUEST_ID");
  const approvedSampleCount = samples.length;
  if (approvedSampleCount < P2_ACCEPTANCE_MIN_SAMPLES
    || (input.summary.total !== undefined && input.summary.total !== samples.length)
    || (input.summary.approved !== undefined && input.summary.approved !== approvedSampleCount)) {
    contractError("P2_ACCEPTANCE_SAMPLE_COUNT_INVALID");
  }

  const producer = input.producerProvenance ?? input.provenance;
  if (!isPlainRecord(producer)
    || producer.controlled !== true
    || producer.producerId !== P2_ACCEPTANCE_PRODUCER_ID
    || producer.producerVersion !== P2_ACCEPTANCE_PRODUCER_VERSION
    || producer.sourceCommit !== reportCommit
    || producer.generatedAt !== input.generatedAt) {
    contractError("P2_ACCEPTANCE_PRODUCER_INVALID");
  }
  requireAcceptanceId(producer.runId, "producerProvenance.runId");

  return Object.freeze({
    schemaVersion: P2_ACCEPTANCE_SCHEMA_VERSION,
    status: "passed",
    phase: "P2",
    sourceCommit: reportCommit,
    policyDigest: input.policyDigest,
    providerPolicyDigest: input.providerPolicyDigest,
    generatedAt: input.generatedAt,
    observationSeconds: durationSeconds,
    sampleCount: samples.length,
    approvedSampleCount,
    failureCount: 0,
    producerId: producer.producerId,
    producerVersion: producer.producerVersion,
    producerRunId: producer.runId,
  });
}

export function normalizeRolloutPhase(value) {
  if (typeof value !== "string" || !ROLLOUT_PHASES.includes(value)) throw new Error("invalid rollout phase");
  return value;
}

export function rolloutPhaseForManifest(manifest) {
  if (manifest?.rolloutPhase) return normalizeRolloutPhase(manifest.rolloutPhase);
  if (manifest?.phase === "platform") return "P6";
  if (manifest?.phase === "canary") return "P3";
  return "P1";
}

export function routingPhaseForRollout(value) {
  const phase = normalizeRolloutPhase(value);
  return phase === "P6" ? "platform" : phase === "P1" || phase === "P2" ? "legacy" : "canary";
}

export function compareRolloutPhase(left, right) {
  const leftOrder = ROLLOUT_PHASE_ORDER[normalizeRolloutPhase(left)];
  const rightOrder = ROLLOUT_PHASE_ORDER[normalizeRolloutPhase(right)];
  return Math.sign(leftOrder - rightOrder);
}

export function p2AcceptanceRequiredForRollout(value) {
  return compareRolloutPhase(value, "P3") >= 0;
}

export function transitionIdentityDigest(manifest) {
  return hashBytes(JSON.stringify({
    schemaVersion: manifest.schemaVersion, id: manifest.id, hostname: manifest.hostname,
    machineId: manifest.machineId, oldRelease: manifest.oldRelease, oldCommit: manifest.oldCommit,
    newRelease: manifest.newRelease, newCommit: manifest.newCommit, newArchive: manifest.newArchive,
    newArchiveSha256: manifest.newArchiveSha256, evidenceDir: manifest.evidenceDir, backupDir: manifest.backupDir,
    p2AcceptanceReport: manifest.p2AcceptanceReport, p2AcceptanceReportSha256: manifest.p2AcceptanceReportSha256,
  }));
}

export function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function requireDigest(value, name, length = 64) {
  if (typeof value !== "string" || !new RegExp("^[0-9a-f]{" + length + "}$").test(value)) throw new Error(name + " must be an exact digest");
  return value;
}
export function controlledPath(value, root, name) {
  if (typeof value !== "string" || value !== posix.normalize(value) || !value.startsWith(root + "/")
    || !/^[A-Za-z0-9_./-]+$/u.test(value) || value.split("/").includes("..")) throw new Error(name + " must be a canonical controlled path");
  return value;
}
export function releasePath(value) {
  controlledPath(value, PRODUCTION_ROOT + "/releases", "release");
  if (posix.dirname(value) !== PRODUCTION_ROOT + "/releases") throw new Error("release must be immutable and directly under releases");
  return value;
}

export function platformStaticDirectoryForRelease(release) {
  releasePath(release);
  return release + "/outputs/ai-platform-admin";
}

export function validateTransitionManifest(input) {
  const allowed = ["schemaVersion", "id", "hostname", "machineId", "oldRelease", "oldCommit", "newRelease", "newCommit", "newArchive", "newArchiveSha256", "evidenceDir", "backupDir", "platformEnvCandidate", "backendEnvCandidate", "platformEnvSha256", "backendEnvSha256", "corePreflight", "corePreflightSha256", "policyFile", "policySha256", "qualityReport", "qualityReportSha256", "p2AcceptanceReport", "p2AcceptanceReportSha256", "phase", "rolloutPhase"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))
    || input.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(input.id)
    || !/^[A-Za-z0-9.-]{1,253}$/u.test(input.hostname)
    || !/^[0-9a-f]{32}$/u.test(input.machineId)
    || !["legacy", "canary", "platform"].includes(input.phase)) throw new Error("invalid transition manifest");
  if (input.rolloutPhase !== undefined) normalizeRolloutPhase(input.rolloutPhase);
  const rolloutPhase = rolloutPhaseForManifest(input);
  if (routingPhaseForRollout(rolloutPhase) !== input.phase && !(input.phase === "legacy" && ["P1", "P2"].includes(rolloutPhase))) {
    throw new Error("rollout and routing phases do not match");
  }
  const hasP2AcceptanceReport = input.p2AcceptanceReport !== undefined || input.p2AcceptanceReportSha256 !== undefined;
  if (hasP2AcceptanceReport && (input.p2AcceptanceReport === undefined || input.p2AcceptanceReportSha256 === undefined)) {
    throw new Error("p2 acceptance binding is incomplete");
  }
  if (p2AcceptanceRequiredForRollout(rolloutPhase) && !hasP2AcceptanceReport) {
    throw new Error("p2 acceptance binding is required for P3+");
  }
  releasePath(input.oldRelease); releasePath(input.newRelease);
  if (input.oldRelease === input.newRelease) throw new Error("new and old releases must differ");
  requireDigest(input.oldCommit, "oldCommit", 40); requireDigest(input.newCommit, "newCommit", 40);
  controlledPath(input.evidenceDir, PRODUCTION_ROOT + "/evidence", "evidenceDir");
  controlledPath(input.backupDir, PRODUCTION_ROOT + "/backups", "backupDir");
  for (const field of ["platformEnvCandidate", "backendEnvCandidate", "corePreflight", "policyFile", "newArchive", "qualityReport"]) {
    controlledPath(input[field], input.evidenceDir, field);
  }
  for (const field of ["platformEnvSha256", "backendEnvSha256", "corePreflightSha256", "policySha256", "newArchiveSha256", "qualityReportSha256"]) requireDigest(input[field], field);
  if (hasP2AcceptanceReport) {
    controlledPath(input.p2AcceptanceReport, input.evidenceDir, "p2AcceptanceReport");
    requireDigest(input.p2AcceptanceReportSha256, "p2AcceptanceReportSha256");
  }
  return Object.freeze({ ...input, rolloutPhase });
}

export function renderPlatformUnit(template, release, { serviceGroup = PLATFORM_SOCKET_GROUP } = {}) {
  releasePath(release);
  if (typeof serviceGroup !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(serviceGroup)) {
    throw new Error("invalid platform service group");
  }
  const substitutions = {
    PROJECT_ROOT: release, NODE_BIN: PROJECT_NODE,
    SERVICE_USER: PLATFORM_USER, SERVICE_GROUP: serviceGroup,
    RUNTIME_DIR: "/run/sentelligent-ai-platform", DATABASE_DIR: "/var/lib/sentelligent-ai-platform",
  };
  const result = template.replace(/@([A-Z_]+)@/gu, (_match, key) => {
    if (!Object.hasOwn(substitutions, key)) throw new Error("unknown systemd template placeholder");
    return substitutions[key];
  });
  if (!result.includes("Type=simple") || !result.includes("KillMode=control-group")
    || result.includes("ReadWritePaths=") || result.includes("/current/")) throw new Error("invalid platform unit");
  return result;
}
