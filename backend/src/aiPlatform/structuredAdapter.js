import { taskEvidenceInput } from "../../../shared/aiPlatformContract.mjs";
import {
  AI_TASK_RESULT_SCHEMA_VERSION,
  AI_TASK_TYPES,
  isPlainObject,
  sha256,
  stableJson,
} from "../../../shared/aiPlatformContract.mjs";

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_PRIORITY = "interactive";
const DEFAULT_CHANNEL = "web";
const DEFAULT_OWNER = "sentelligent-sales-workbench";
const MODES = new Set(["disabled", "optional", "required"]);
const CHANNELS = new Set(["web", "weixin", "worker", "system"]);
const PRIORITIES = new Set(["interactive", "normal", "background"]);
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const OWNER_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]{1,400}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const MEDIA_TASK_TYPES = new Set([
  "asr.transcribe",
  "invoice.recognize",
  "payment-proof.recognize",
  "bookkeeping.extract",
]);
const MEDIA_TYPES = new Set([
  "audio/wav",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const AUDIO_PURPOSES = new Set(["quick_record", "assistant_chat"]);
const AUDIO_MAX_DURATION_MS = Object.freeze({
  quick_record: 120_000,
  assistant_chat: 60_000,
});
const RAW_MEDIA_KEYS = new Set([
  "audioPath",
  "base64",
  "buffer",
  "bytes",
  "content",
  "data",
  "file",
  "filePath",
  "path",
  "raw",
  "uri",
  "url",
]);

export class AiPlatformStructuredTaskError extends Error {
  constructor(message, {
    code = "AI_PLATFORM_STRUCTURED_ERROR",
    status = 502,
    retryable = false,
    requestId = null,
    taskId = null,
    details = null,
    cause = undefined,
  } = {}) {
    super(message, { cause });
    this.name = "AiPlatformStructuredTaskError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.taskId = taskId;
    this.details = details;
  }
}

function fail(message, options = {}) {
  throw new AiPlatformStructuredTaskError(message, options);
}

function modeOf(config = {}) {
  const mode = String(config.aiPlatformMode ?? "disabled").trim().toLowerCase();
  if (!MODES.has(mode)) throw new TypeError("aiPlatformMode is invalid");
  return mode;
}

function boundedText(value, name, pattern, max) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || (pattern && !pattern.test(normalized))) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function ownerOf(value) {
  return boundedText(value || DEFAULT_OWNER, "owner", OWNER_PATTERN, 400);
}

function actorOf(value, owner) {
  return boundedText(value || owner, "actor", OWNER_PATTERN, 400);
}

function subjectOf(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new TypeError("subject is invalid");
  const rawId = boundedText(value.id, "subject.id", SUBJECT_ID_PATTERN, 128);
  const normalizedId = /^[A-Za-z]/u.test(rawId) ? rawId : `ref-${rawId}`;
  return Object.freeze({
    type: boundedText(value.type, "subject.type", IDENTIFIER_PATTERN, 128),
    id: normalizedId.slice(0, 128),
  });
}

function taskTypeOf(value) {
  const taskType = boundedText(value, "taskType", TASK_TYPE_PATTERN, 127);
  if (!AI_TASK_TYPES.includes(taskType)) throw new TypeError("taskType is not registered");
  return taskType;
}

function featureOf(value) {
  return boundedText(value, "feature", IDENTIFIER_PATTERN, 128);
}

function channelOf(value) {
  const channel = boundedText(value || DEFAULT_CHANNEL, "channel", IDENTIFIER_PATTERN, 128);
  if (!CHANNELS.has(channel)) throw new TypeError("channel is invalid");
  return channel;
}

function priorityOf(value) {
  const priority = boundedText(value || DEFAULT_PRIORITY, "priority", IDENTIFIER_PATTERN, 128);
  if (!PRIORITIES.has(priority)) throw new TypeError("priority is invalid");
  return priority;
}

function waitOf(value, fallback, name, max) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return candidate;
}

function digestOf(value, input) {
  if (value === null || value === undefined || value === "") return sha256(input);
  const digest = String(value).trim();
  if (!DIGEST_PATTERN.test(digest)) throw new TypeError("evidenceDigest is invalid");
  return digest;
}

function idempotencyOf(value, parts) {
  if (value !== null && value !== undefined && value !== "") {
    return boundedText(value, "idempotencyKey", IDEMPOTENCY_PATTERN, 200);
  }
  return `${parts.feature}:${parts.taskType}:${sha256({
    owner: parts.owner,
    actor: parts.actor,
    subject: parts.subject,
    evidenceDigest: parts.evidenceDigest,
    input: parts.input,
  }).slice(0, 48)}`.slice(0, 200);
}

function assertJsonInput(input, name = "input") {
  if (!isPlainObject(input)) throw new TypeError(`${name} must be an object`);
  let encoded;
  try {
    encoded = stableJson(input);
  } catch (error) {
    throw new TypeError(`${name} must be JSON data: ${error.message}`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) {
    throw new TypeError(`${name} is too large`);
  }
  return JSON.parse(encoded);
}

function assertNoRawMedia(value, path = "input", seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    fail("raw media payloads are not accepted by the AI platform", {
      code: "AI_PLATFORM_RAW_MEDIA_FORBIDDEN",
      status: 422,
    });
  }
  if (seen.has(value)) {
    fail(`${path} contains a cycle`, { code: "AI_PLATFORM_INPUT_INVALID", status: 422 });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoRawMedia(item, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (RAW_MEDIA_KEYS.has(key)) {
        fail(`${path}.${key} is not accepted`, {
          code: "AI_PLATFORM_RAW_MEDIA_FORBIDDEN",
          status: 422,
        });
      }
      assertNoRawMedia(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function configuredRuntime(runtime) {
  if (!runtime) return null;
  if (typeof runtime.enabled === "function" && runtime.enabled() === false) return null;
  if (typeof runtime.configured === "function" && runtime.configured() === false) return null;
  if (typeof runtime.runStructuredTask === "function" || typeof runtime.runTask === "function") return runtime;
  return null;
}

function configuredClient(client) {
  return client && typeof client.runTask === "function" ? client : null;
}

function executionFor(config = {}, options = {}) {
  const mode = modeOf(config);
  if (mode === "disabled") return { mode, runtime: null, client: null };
  const runtimeCandidate = options.aiPlatformRuntime ?? config.aiPlatformRuntime ?? null;
  const runtime = configuredRuntime(runtimeCandidate);
  if (runtime) return { mode, runtime, client: null };
  const client = configuredClient(options.aiPlatformClient ?? config.aiPlatformClient ?? null);
  return { mode, runtime: null, client };
}

export function aiPlatformStructuredTaskAvailability(config = {}, options = {}) {
  const execution = executionFor(config, options);
  if (execution.mode === "disabled") return "disabled";
  if (execution.runtime || execution.client) return "available";
  return execution.mode === "required" ? "unavailable" : "missing";
}

function standardTaskResult(value) {
  return isPlainObject(value) && value.schemaVersion === AI_TASK_RESULT_SCHEMA_VERSION;
}

function payloadFromValue(value, seen = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (standardTaskResult(value)) {
      const metadata = isPlainObject(value.metadata) ? value.metadata : {};
      for (const candidate of [
        metadata.payload,
        metadata.compatibility,
        metadata.result,
        value.payload,
      ]) {
        const payload = payloadFromValue(candidate, seen);
        if (payload !== null) return payload;
      }
      return null;
    }
    for (const key of ["payload", "result", "task", "item", "data"]) {
      if (!Object.hasOwn(value, key)) continue;
      const nested = payloadFromValue(value[key], seen);
      if (nested !== null) return nested;
    }
    if (isPlainObject(value)) return value;
    return null;
  } finally {
    seen.delete(value);
  }
}

function normalizeTaskPayload(raw) {
  const payload = payloadFromValue(raw);
  if (!isPlainObject(payload)) {
    fail("AI platform returned an invalid structured result", {
      code: "AI_PLATFORM_INVALID_RESULT",
      status: 502,
    });
  }
  return Object.freeze(payload);
}

function requestShape({
  taskType,
  feature,
  channel,
  subject,
  input,
  evidenceDigest,
  priority,
  requestedWaitMs,
}) {
  return {
    schemaVersion: "ai-task-v1",
    taskType,
    feature,
    channel,
    subject,
    input,
    evidenceDigest,
    priority,
    requestedWaitMs,
  };
}

async function executePlatformTask({
  config = {},
  options = {},
  taskType,
  feature,
  channel,
  owner,
  actor,
  subject,
  input,
  evidenceDigest,
  priority,
  idempotencyKey,
  maxWaitMs,
  pollMs,
  signal,
}) {
  const normalizedTaskType = taskTypeOf(taskType);
  const normalizedFeature = featureOf(feature);
  const normalizedOwner = ownerOf(owner);
  const normalizedActor = actorOf(actor, normalizedOwner);
  const normalizedSubject = subjectOf(subject);
  const normalizedInput = assertJsonInput(input);
  assertNoRawMedia(normalizedInput);
  const evidenceInput = taskEvidenceInput(normalizedInput);
  const normalizedEvidenceDigest = digestOf(evidenceDigest, evidenceInput);
  const normalizedMaxWaitMs = waitOf(
    maxWaitMs ?? options.maxWaitMs ?? config.aiPlatformMaxWaitMs,
    DEFAULT_MAX_WAIT_MS,
    "maxWaitMs",
    10 * 60_000,
  );
  const normalizedPollMs = waitOf(
    pollMs ?? options.pollMs ?? config.aiPlatformPollMs,
    DEFAULT_POLL_MS,
    "pollMs",
    30_000,
  ) || DEFAULT_POLL_MS;
  const normalizedPriority = priorityOf(priority ?? options.priority);
  const key = idempotencyOf(idempotencyKey ?? options.idempotencyKey, {
    taskType: normalizedTaskType,
    feature: normalizedFeature,
    owner: normalizedOwner,
    actor: normalizedActor,
    subject: normalizedSubject,
    evidenceDigest: normalizedEvidenceDigest,
    input: evidenceInput,
  });
  const request = requestShape({
    taskType: normalizedTaskType,
    feature: normalizedFeature,
    channel: channelOf(channel ?? options.channel),
    subject: normalizedSubject,
    input: normalizedInput,
    evidenceDigest: normalizedEvidenceDigest,
    priority: normalizedPriority,
    requestedWaitMs: normalizedMaxWaitMs,
  });
  const execution = executionFor(config, options);
  if (execution.mode === "disabled") {
    fail("AI platform integration is disabled", {
      code: "AI_PLATFORM_DISABLED",
      status: 503,
    });
  }
  if (!execution.runtime && !execution.client) {
    fail("AI platform integration is not configured", {
      code: "AI_PLATFORM_NOT_CONFIGURED",
      status: 503,
    });
  }

  try {
    if (execution.runtime) {
      const identity = { owner: normalizedOwner, actor: normalizedActor };
      const raw = typeof execution.runtime.runStructuredTask === "function"
        ? await execution.runtime.runStructuredTask({
            taskType: normalizedTaskType,
            feature: normalizedFeature,
            channel: request.channel,
            owner: normalizedOwner,
            actor: normalizedActor,
            subject: normalizedSubject,
            input: normalizedInput,
            evidenceDigest: normalizedEvidenceDigest,
            priority: normalizedPriority,
            idempotencyKey: key,
            maxWaitMs: normalizedMaxWaitMs,
            pollMs: normalizedPollMs,
            signal,
            identity,
          })
        : await execution.runtime.runTask({
            ...request,
            idempotencyKey: key,
            maxWaitMs: normalizedMaxWaitMs,
            pollMs: normalizedPollMs,
            signal,
            identity,
          });
      return {
        payload: normalizeTaskPayload(raw),
        request,
        idempotencyKey: key,
        raw,
      };
    }
    const raw = await execution.client.runTask({
      request,
      idempotencyKey: key,
      maxWaitMs: normalizedMaxWaitMs,
      pollMs: normalizedPollMs,
      signal,
    });
    return {
      payload: normalizeTaskPayload(raw),
      request,
      idempotencyKey: key,
      raw,
    };
  } catch (error) {
    if (error instanceof AiPlatformStructuredTaskError) throw error;
    throw new AiPlatformStructuredTaskError("AI platform structured task failed", {
      code: String(error?.code ?? "AI_PLATFORM_REQUEST_FAILED"),
      status: Number.isInteger(error?.status) ? error.status : 502,
      retryable: error?.retryable === true,
      requestId: error?.requestId ?? null,
      taskId: error?.taskId ?? null,
      details: error?.details ?? null,
      cause: error,
    });
  }
}

export async function runAiPlatformStructuredTask(options = {}) {
  return (await executePlatformTask(options)).payload;
}

function normalizeMediaDescriptor(taskType, media) {
  if (!isPlainObject(media)) throw new TypeError("media descriptor is required");
  const allowed = taskType === "asr.transcribe"
    ? new Set(["mediaType", "byteLength", "durationMs", "purpose", "language", "sha256"])
    : new Set(["mediaType", "byteLength", "pageCount", "sha256"]);
  for (const key of Object.keys(media)) {
    if (!allowed.has(key)) throw new TypeError(`media.${key} is not supported`);
  }
  const mediaType = boundedText(media.mediaType, "media.mediaType", /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u, 100).toLowerCase();
  if (!MEDIA_TYPES.has(mediaType)) throw new TypeError("media.mediaType is unsupported");
  const byteLength = Number(media.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 12 * 1024 * 1024) {
    throw new TypeError("media.byteLength is invalid");
  }
  const sha = String(media.sha256 ?? "").trim();
  if (!DIGEST_PATTERN.test(sha)) throw new TypeError("media.sha256 is invalid");
  if (taskType === "asr.transcribe") {
    if (mediaType !== "audio/wav") throw new TypeError("ASR requires audio/wav");
    const durationMs = Number(media.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs < 300 || durationMs > 120_000) {
      throw new TypeError("media.durationMs is invalid");
    }
    const purpose = boundedText(media.purpose, "media.purpose", IDENTIFIER_PATTERN, 40);
    if (!AUDIO_PURPOSES.has(purpose) || durationMs > AUDIO_MAX_DURATION_MS[purpose]) {
      throw new TypeError("media.purpose or duration is invalid");
    }
    const language = boundedText(media.language, "media.language", /^[A-Za-z][A-Za-z0-9-]{0,19}$/u, 20);
    if (language !== "zh-CN") throw new TypeError("media.language is invalid");
    return Object.freeze({ mediaType, byteLength, durationMs, purpose, language, sha256: sha });
  }
  if (mediaType === "audio/wav") throw new TypeError("document media type is unsupported");
  const pageCount = media.pageCount === undefined ? 1 : Number(media.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 4) {
    throw new TypeError("media.pageCount is invalid");
  }
  return Object.freeze({ mediaType, byteLength, pageCount, sha256: sha });
}

function normalizedReferenceDate(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError("referenceDate is invalid");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("referenceDate is invalid");
  }
  return value;
}

export function normalizeAiPlatformMediaInput(taskType, {
  media,
  referenceDate = undefined,
} = {}) {
  const normalizedTaskType = taskTypeOf(taskType);
  if (!MEDIA_TASK_TYPES.has(normalizedTaskType)) throw new TypeError("taskType is not a media task");
  const normalizedMedia = normalizeMediaDescriptor(normalizedTaskType, media);
  const input = {
    media: normalizedMedia,
    ...(normalizedTaskType === "payment-proof.recognize" || normalizedTaskType === "bookkeeping.extract"
      ? { referenceDate: normalizedReferenceDate(referenceDate) ?? null }
      : {}),
  };
  assertNoRawMedia(input);
  return Object.freeze(input);
}

export async function runAiPlatformMediaTask({
  taskType,
  media,
  referenceDate,
  bytes = null,
  ...options
} = {}) {
  const input = normalizeAiPlatformMediaInput(taskType, { media, referenceDate });
  const runtime = options.config?.aiPlatformRuntime ?? options.options?.aiPlatformRuntime;
  let uploaded = null;
  try {
    if (options.config?.aiPlatformExecutionMode === "external-provider") {
      if (!bytes || typeof runtime?.uploadMedia !== "function") throw new AiPlatformStructuredTaskError("media upload is unavailable", { code: "media_unavailable", status: 503 });
      uploaded = await runtime.uploadMedia({ bytes, media: input.media, owner: options.owner, actor: options.actor ?? options.owner, signal: options.signal });
    }
    return await runAiPlatformStructuredTask({
      ...options, taskType, input: { ...input, ...(uploaded ? { mediaRef: uploaded.id } : {}) },
    });
  } finally {
    if (uploaded) await runtime.discardMedia({ id: uploaded.id, owner: options.owner, actor: options.actor ?? options.owner });
  }
}

export function isAiPlatformMediaTaskType(taskType) {
  return MEDIA_TASK_TYPES.has(taskType);
}

export function mediaDescriptorFromFile({ taskType = "invoice.recognize", mediaType, byteLength, sha256: digest, durationMs, purpose, language, pageCount } = {}) {
  return normalizeMediaDescriptor(
    taskType,
    durationMs === undefined
      ? { mediaType, byteLength, sha256: digest, pageCount }
      : { mediaType, byteLength, sha256: digest, durationMs, purpose, language },
  );
}
