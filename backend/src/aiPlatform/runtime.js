import { createHmac, randomUUID } from "node:crypto";

import {
  AI_EXECUTION_MODE,
  AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
  AI_TASK_RESULT_SCHEMA_VERSION,
  sha256,
  stableJson,
  taskEvidenceInput,
} from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformClientError, createAiPlatformClient } from "./client.js";
import { normalizeRequestBinding } from "../../../shared/aiPlatformRequestAuth.mjs";

const DEFAULT_MODE = "disabled";
const DEFAULT_ISSUER = "sentelligent-sales-backend";
const DEFAULT_SUBJECT = "sentelligent-backend";
const DEFAULT_SCOPES = Object.freeze([
  "ai:task:create",
  "ai:task:read",
  "ai:task:cancel",
  "ai:media:write",
  "ai:media:delete",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const MAX_TOKEN_TTL_SECONDS = 15 * 60;
const MODE_VALUES = new Set(["disabled", "optional", "required"]);
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_FEATURE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_OWNER = /^[^\u0000-\u001f\u007f-\u009f]{1,400}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/u;

export class AiPlatformRuntimeError extends Error {
  constructor(message, {
    code = "ai_platform_error",
    status = 502,
    retryable = false,
    requestId = null,
    taskId = null,
    details = null,
    cause = undefined,
  } = {}) {
    super(message, { cause });
    this.name = "AiPlatformRuntimeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.taskId = taskId;
    this.details = details;
  }
}

function bounded(value, name, pattern, max = 400) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || !pattern.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function modeValue(value) {
  const normalized = String(value ?? DEFAULT_MODE).trim().toLowerCase();
  if (!MODE_VALUES.has(normalized)) throw new TypeError("aiPlatformMode is invalid");
  return normalized;
}

function safeScopes(value) {
  const scopes = value === undefined || value === null ? DEFAULT_SCOPES : value;
  if (!Array.isArray(scopes) || scopes.length === 0) throw new TypeError("AI platform scopes are invalid");
  return Object.freeze([...new Set(scopes.map((item) => bounded(item, "scope", SAFE_ID, 128)))].sort());
}

function positiveInteger(value, name, fallback, max) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return candidate;
}

function tokenSignature(secret, unsigned) {
  return createHmac("sha256", String(secret)).update(unsigned, "utf8").digest("hex");
}

function encodeTokenPayload(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Mint the short-lived service token expected by ai-platform.  The backend
 * signs one token per business owner so the platform can enforce owner
 * isolation without trusting owner values in the task body.
 */
export function createAiPlatformServiceToken({
  secret,
  issuer = DEFAULT_ISSUER,
  subject = DEFAULT_SUBJECT,
  owner,
  actor = owner,
  scopes = DEFAULT_SCOPES,
  ttlSeconds = 300,
  now = () => Date.now(),
  jti = randomUUID(),
  requestBinding = null,
} = {}) {
  if (typeof secret !== "string" || !secret) throw new TypeError("AI platform auth secret is required");
  const normalizedIssuer = bounded(issuer, "issuer", SAFE_OWNER);
  const normalizedSubject = bounded(subject, "subject", SAFE_OWNER);
  const normalizedOwner = bounded(owner, "owner", SAFE_OWNER);
  const normalizedActor = bounded(actor, "actor", SAFE_OWNER);
  const normalizedScopes = safeScopes(scopes);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
    throw new TypeError("ttlSeconds is invalid");
  }
  const issuedAt = Math.floor(Number(now()) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError("now is invalid");
  const payload = {
    ver: 1,
    iss: normalizedIssuer,
    sub: normalizedSubject,
    owner: normalizedOwner,
    actor: normalizedActor,
    scopes: [...normalizedScopes],
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: bounded(jti, "jti", SAFE_OWNER, 400),
    ...(requestBinding ? { request: normalizeRequestBinding(requestBinding) } : {}),
  };
  const unsigned = `aip1.${encodeTokenPayload(payload)}`;
  return `${unsigned}.${tokenSignature(secret, unsigned)}`;
}

function normalizeIdentity(identity = {}, fallbackOwner = null) {
  const owner = identity.owner ?? fallbackOwner;
  if (owner === null || owner === undefined || owner === "") {
    throw new TypeError("AI platform owner is required");
  }
  return Object.freeze({
    issuer: String(identity.issuer ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER,
    subject: String(identity.subject ?? identity.actor ?? DEFAULT_SUBJECT).trim() || DEFAULT_SUBJECT,
    owner: bounded(owner, "owner", SAFE_OWNER),
    actor: bounded(identity.actor ?? owner, "actor", SAFE_OWNER),
    scopes: safeScopes(identity.scopes),
  });
}

function normalizeSubject(subject) {
  if (subject === null || subject === undefined) return null;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    throw new TypeError("subject is invalid");
  }
  return Object.freeze({
    type: bounded(subject.type, "subject.type", SAFE_ID, 128),
    id: bounded(subject.id, "subject.id", SAFE_ID, 128),
  });
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI platform input must be an object");
  }
  // stableJson also rejects cycles, non-JSON values and excessively deep
  // structures through the shared task contract before the request leaves
  // the business process.
  const normalized = JSON.parse(stableJson(input));
  if (normalized.protocol !== "chat.completions.v1") return normalized;

  // The logical target is a deployment contract, not a caller-controlled
  // request option.  Keep the completion envelope explicit so a forged model
  // or reasoning value cannot change the platform routing decision.
  const request = normalized.request && typeof normalized.request === "object"
    && !Array.isArray(normalized.request)
    ? {
        ...normalized.request,
        model: AI_TARGET_MODEL,
        reasoningEffort: AI_TARGET_REASONING_EFFORT,
      }
    : normalized.request;
  return {
    ...normalized,
    request,
    model: AI_TARGET_MODEL,
    reasoningEffort: AI_TARGET_REASONING_EFFORT,
  };
}

function normalizeEvidenceDigest(value, input) {
  if (value === null || value === undefined || value === "") return sha256(taskEvidenceInput(input));
  const normalized = String(value).trim();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new TypeError("evidenceDigest is invalid");
  return normalized;
}

function defaultIdempotencyKey({ taskType, feature, identity, input, idempotencyKey }) {
  if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== "") {
    return bounded(idempotencyKey, "idempotencyKey", SAFE_ID, 200);
  }
  const digest = sha256({ taskType, feature, owner: identity.owner, input: taskEvidenceInput(input) }).slice(0, 48);
  return `${feature}:${taskType.replace(/[^A-Za-z0-9_.:-]/gu, "-")}:${digest}`.slice(0, 200);
}

function taskResultFromOutcome(outcome) {
  const nested = outcome?.result;
  if (nested && typeof nested === "object" && !Array.isArray(nested) && Object.hasOwn(nested, "result")) {
    return nested.result;
  }
  if (nested && typeof nested === "object" && !Array.isArray(nested) && nested.schemaVersion === AI_TASK_RESULT_SCHEMA_VERSION) {
    return nested;
  }
  const direct = outcome?.task?.result;
  return direct && typeof direct === "object" ? direct : null;
}

function taskFromOutcome(outcome) {
  if (outcome?.task && typeof outcome.task === "object") return outcome.task;
  if (outcome && typeof outcome === "object") return outcome;
  return null;
}

function resultMetadata(result) {
  return result?.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
    ? result.metadata
    : {};
}

function completionContentFromResult(result) {
  const metadata = resultMetadata(result);
  const response = metadata.completionResponse ?? metadata.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content;
  }
  for (const candidate of [
    metadata.completion,
    metadata.content,
    result?.completion,
    result?.content,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const fact = (result?.facts ?? []).find((item) => ["completion", "content", "model_content"].includes(item?.key));
  if (typeof fact?.value === "string" && fact.value.trim()) return fact.value;
  return null;
}

function structuredPayloadFromResult(result) {
  const metadata = resultMetadata(result);
  for (const candidate of [metadata.payload, metadata.result, result?.payload]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function transcriptFromResult(result) {
  const metadata = resultMetadata(result);
  for (const candidate of [metadata.transcript, result?.transcript]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const fact = (result?.facts ?? []).find((item) => ["transcript", "text"].includes(item?.key));
  return typeof fact?.value === "string" && fact.value.trim() ? fact.value.trim() : null;
}

function runtimeFailure(error, fallbackCode = "ai_platform_error") {
  if (error instanceof AiPlatformRuntimeError) return error;
  if (error instanceof AiPlatformClientError) {
    return new AiPlatformRuntimeError(error.message, {
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      requestId: error.requestId,
      details: error.details,
      cause: error,
    });
  }
  return new AiPlatformRuntimeError("AI platform request failed", {
    code: fallbackCode,
    status: 502,
    retryable: true,
    cause: error,
  });
}

function taskFailure(task, outcome) {
  const status = String(task?.status ?? "");
  const code = String(task?.errorCode ?? (status === "cancelled" ? "cancelled" : "task_failed"));
  const error = new AiPlatformRuntimeError(
    status === "expired" ? "AI platform task expired" : "AI platform task failed",
    {
      code,
      status: status === "cancelled" ? 499 : status === "expired" ? 504 : 502,
      retryable: status === "expired" || code === "provider_unavailable" || code === "rate_limited",
      requestId: task?.requestId ?? outcome?.requestId ?? null,
      taskId: task?.taskId ?? null,
      details: { taskStatus: status, errorMessage: task?.errorMessage ?? null },
    },
  );
  return error;
}

function responseForCompletion(content, result) {
  if (typeof content !== "string" || !content.trim()) {
    throw new AiPlatformRuntimeError("AI platform returned no completion content", {
      code: "invalid_result",
      status: 502,
      retryable: false,
    });
  }
  const metadata = resultMetadata(result);
  const usage = metadata.usage && typeof metadata.usage === "object" ? metadata.usage : undefined;
  return Object.freeze({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
      ...(usage ? { usage } : {}),
    }),
  });
}

function makeClient({ config, identity, fetchImpl, tokenProvider, now }) {
  if (typeof config.aiPlatformClientFactory === "function") {
    const client = config.aiPlatformClientFactory({ identity, fetchImpl });
    if (!client || typeof client.runTask !== "function") throw new TypeError("aiPlatformClientFactory returned an invalid client");
    return client;
  }
  const staticToken = String(config.aiPlatformAuthToken ?? "").trim() || null;
  const dynamicProvider = typeof tokenProvider === "function"
    ? ({ signal, ...meta }) => tokenProvider({ signal, ...meta, identity })
    : typeof config.aiPlatformAuthTokenProvider === "function"
      ? ({ signal, ...meta }) => config.aiPlatformAuthTokenProvider({ signal, ...meta, identity })
      : typeof config.aiPlatformAuthSecret === "string" && config.aiPlatformAuthSecret.trim()
        ? ({ requestBinding }) => createAiPlatformServiceToken({
            secret: config.aiPlatformAuthSecret,
            issuer: config.aiPlatformIssuer ?? DEFAULT_ISSUER,
            subject: config.aiPlatformSubject ?? DEFAULT_SUBJECT,
            owner: identity.owner,
            actor: identity.actor,
            scopes: identity.scopes,
            ttlSeconds: 300,
            now,
            requestBinding,
          })
        : null;
  return createAiPlatformClient({
    baseUrl: config.aiPlatformBaseUrl,
    token: staticToken,
    tokenProvider: dynamicProvider,
    fetchImpl,
    timeoutMs: config.aiPlatformRequestTimeoutMs ?? config.aiPlatformTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

export function createAiPlatformRuntime({
  config = {},
  fetchImpl = fetch,
  client = null,
  tokenProvider = null,
  now = () => Date.now(),
} = {}) {
  const mode = modeValue(config.aiPlatformMode);
  const maxWaitMs = positiveInteger(
    config.aiPlatformMaxWaitMs,
    "aiPlatformMaxWaitMs",
    DEFAULT_MAX_WAIT_MS,
    10 * 60_000,
  );
  const pollMs = positiveInteger(
    config.aiPlatformPollMs,
    "aiPlatformPollMs",
    250,
    30_000,
  ) || 250;
  const cache = new Map();

  function enabled() {
    return mode !== "disabled";
  }

  function configured() {
    return Boolean(client)
      || Boolean(String(config.aiPlatformBaseUrl ?? "").trim())
      && Boolean(String(config.aiPlatformAuthToken ?? "").trim() || String(config.aiPlatformAuthSecret ?? "").trim() || tokenProvider || typeof config.aiPlatformAuthTokenProvider === "function");
  }

  function assertEnabled() {
    if (!enabled()) {
      throw new AiPlatformRuntimeError("AI platform integration is disabled", {
        code: "ai_platform_disabled",
        status: 503,
        retryable: false,
      });
    }
    if (!configured()) {
      throw new AiPlatformRuntimeError("AI platform integration is not configured", {
        code: "ai_platform_not_configured",
        status: 503,
        retryable: false,
      });
    }
  }

  function clientFor(identityInput) {
    const identity = normalizeIdentity(identityInput);
    if (client) return { client, identity };
    const cacheKey = `${identity.owner}\u0000${identity.actor}\u0000${identity.scopes.join(",")}`;
    let scoped = cache.get(cacheKey);
    if (!scoped) {
      scoped = makeClient({ config, identity, fetchImpl, tokenProvider, now });
      cache.set(cacheKey, scoped);
    }
    return { client: scoped, identity };
  }

  async function runTask({
    taskType,
    feature,
    channel = "web",
    owner,
    actor = owner,
    subject = null,
    input = {},
    evidenceDigest = null,
    priority = "interactive",
    idempotencyKey = null,
    maxWaitMs: requestedMaxWaitMs = maxWaitMs,
    pollMs: requestedPollMs = pollMs,
    signal = null,
    identity = null,
  } = {}) {
    assertEnabled();
    const normalizedTaskType = bounded(taskType, "taskType", /^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/u, 127);
    const normalizedFeature = bounded(feature, "feature", SAFE_FEATURE, 128);
    const normalizedIdentity = normalizeIdentity(identity ?? { owner, actor });
    const normalizedInput = normalizeInput(input);
    const normalizedSubject = normalizeSubject(subject);
    const normalizedMaxWaitMs = positiveInteger(requestedMaxWaitMs, "maxWaitMs", maxWaitMs, 10 * 60_000);
    const normalizedPollMs = Math.max(1, positiveInteger(requestedPollMs, "pollMs", pollMs, 30_000));
    const key = defaultIdempotencyKey({
      taskType: normalizedTaskType,
      feature: normalizedFeature,
      identity: normalizedIdentity,
      input: normalizedInput,
      idempotencyKey,
    });
    const request = {
      schemaVersion: "ai-task-v1",
      taskType: normalizedTaskType,
      feature: normalizedFeature,
      channel,
      subject: normalizedSubject,
      input: normalizedInput,
      evidenceDigest: normalizeEvidenceDigest(evidenceDigest, normalizedInput),
      priority,
      requestedWaitMs: Math.min(normalizedMaxWaitMs, 30_000),
    };
    const scoped = clientFor(normalizedIdentity);
    let outcome;
    try {
      outcome = await scoped.client.runTask({
        request,
        idempotencyKey: key,
        maxWaitMs: normalizedMaxWaitMs,
        pollMs: normalizedPollMs,
        signal,
      });
    } catch (error) {
      throw runtimeFailure(error);
    }
    const task = taskFromOutcome(outcome);
    if (!task || typeof task.status !== "string") {
      throw new AiPlatformRuntimeError("AI platform returned an invalid task", {
        code: "invalid_result",
        status: 502,
        requestId: outcome?.requestId ?? null,
      });
    }
    if (task.status !== "succeeded") {
      if (["queued", "running"].includes(task.status)) {
        throw new AiPlatformRuntimeError("AI platform task did not finish within the bounded wait", {
          code: "task_pending",
          status: 504,
          retryable: true,
          requestId: task.requestId ?? outcome?.requestId ?? null,
          taskId: task.taskId ?? null,
          details: { taskStatus: task.status },
        });
      }
      throw taskFailure(task, outcome);
    }
    const result = taskResultFromOutcome(outcome);
    if (!result || result.schemaVersion !== AI_TASK_RESULT_SCHEMA_VERSION) {
      throw new AiPlatformRuntimeError("AI platform returned an invalid task result", {
        code: "invalid_result",
        status: 502,
        requestId: task.requestId ?? outcome?.requestId ?? null,
        taskId: task.taskId ?? null,
      });
    }
    return Object.freeze({
      task,
      result,
      requestId: task.requestId ?? outcome?.requestId ?? null,
      taskId: task.taskId ?? null,
      idempotencyKey: key,
    });
  }

  function createCompletionClient({
    taskType,
    feature,
    channel = "web",
    owner,
    actor = owner,
    subject = null,
    priority = "interactive",
    idempotencyKey = null,
    identity = null,
    maxWaitMs: completionMaxWaitMs = maxWaitMs,
  } = {}) {
    return Object.freeze({
      async complete(request = {}) {
        const { signal: requestSignal = null, ...serializableRequest } = request ?? {};
        const result = await runTask({
          taskType,
          feature,
          channel,
          owner,
          actor,
          subject,
          input: {
            protocol: "chat.completions.v1",
            request: normalizeInput({
              ...serializableRequest,
              model: AI_TARGET_MODEL,
              reasoningEffort: AI_TARGET_REASONING_EFFORT,
            }),
            model: AI_TARGET_MODEL,
            reasoningEffort: AI_TARGET_REASONING_EFFORT,
          },
          priority,
          idempotencyKey,
          identity,
          maxWaitMs: completionMaxWaitMs,
          signal: requestSignal,
        });
        return responseForCompletion(completionContentFromResult(result.result), result.result);
      },
      async createChatCompletion(request = {}) {
        return this.complete(request);
      },
    });
  }

  async function runStructuredTask(options = {}) {
    const response = await runTask(options);
    return structuredPayloadFromResult(response.result) ?? response.result;
  }

  async function transcribe(options = {}) {
    const response = await runTask(options);
    const transcript = transcriptFromResult(response.result);
    if (!transcript) {
      throw new AiPlatformRuntimeError("AI platform returned no transcript", {
        code: "invalid_result",
        status: 502,
        requestId: response.requestId,
        taskId: response.taskId,
      });
    }
    return { ...response, transcript };
  }

  async function uploadMedia({ bytes, media, owner, actor = owner, signal }) {
    assertEnabled();
    if (!Buffer.isBuffer(bytes) || !media || sha256(bytes) !== media.sha256 || bytes.length !== media.byteLength) {
      throw new AiPlatformRuntimeError("media does not match descriptor", { code: "media_descriptor_mismatch", status: 422 });
    }
    const scoped = clientFor({ owner, actor });
    if (typeof scoped.client.uploadMedia !== "function") throw new AiPlatformRuntimeError("media upload is unavailable", { code: "media_unavailable", status: 503 });
    return scoped.client.uploadMedia({ bytes, mediaType: media.mediaType, sha256: media.sha256, signal });
  }

  async function discardMedia({ id, owner, actor = owner }) {
    const scoped = clientFor({ owner, actor });
    return scoped.client.discardMedia(id);
  }

  function health() {
    return {
      mode,
      configured: configured(),
      enabled: enabled(),
      baseUrl: config.aiPlatformBaseUrl ?? null,
      targetModel: AI_TARGET_MODEL,
      targetReasoningEffort: AI_TARGET_REASONING_EFFORT,
      executionMode: config.aiPlatformExecutionMode ?? AI_EXECUTION_MODE,
      proactiveScheduleOwner: config.aiPlatformProactiveScheduleOwner
        ?? AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER,
    };
  }

  return Object.freeze({
    mode,
    enabled,
    configured,
    health,
    runTask,
    runStructuredTask,
    transcribe,
    uploadMedia,
    discardMedia,
    createCompletionClient,
    clearCache() { cache.clear(); },
  });
}
