import {
  AI_EXECUTION_MODE,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
  sha256,
} from "../../../shared/aiPlatformContract.mjs";
import { readBoundedResponseText } from "../http/request.js";
import { createAiPlatformClient } from "./client.js";
import { configForAiTask } from "./routingPolicy.js";
import { platformFetch } from "../../../shared/aiPlatformSocketTransport.mjs";

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_PRIORITY = "interactive";
const DEFAULT_CHANNEL = "web";
const DEFAULT_OWNER = "sentelligent-sales-workbench";
const TASK_SCHEMA_VERSION = "ai-task-v1";
const MAX_LEGACY_RESPONSE_BYTES = 512 * 1024;
const AI_PLATFORM_MODES = new Set(["disabled", "optional", "required"]);
const CHANNELS = new Set(["web", "weixin", "worker", "system"]);
const PRIORITIES = new Set(["interactive", "normal", "background"]);
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_TASK_TYPE = /^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const SAFE_OWNER = /^[^\u0000-\u001f\u007f-\u009f]{1,400}$/u;
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK",
  "UND_ERR_SOCKET",
]);

export class AiPlatformTextAdapterError extends Error {
  constructor(message, { code = "ai_platform_text_error", status = 502 } = {}) {
    super(message);
    this.name = "AiPlatformTextAdapterError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function boundedText(value, name, pattern, max) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || (pattern && !pattern.test(normalized))) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function normalizeOwner(value) {
  return boundedText(value || DEFAULT_OWNER, "owner", SAFE_OWNER, 400);
}

function normalizeActor(value, owner) {
  return boundedText(value || owner, "actor", SAFE_OWNER, 400);
}

function normalizeChannel(value) {
  const channel = boundedText(value || DEFAULT_CHANNEL, "channel", /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/u, 40);
  if (!CHANNELS.has(channel)) throw new TypeError("channel is invalid");
  return channel;
}

function normalizePriority(value) {
  const priority = boundedText(value || DEFAULT_PRIORITY, "priority", /^[A-Za-z][A-Za-z0-9_.:-]{0,19}$/u, 20);
  if (!PRIORITIES.has(priority)) throw new TypeError("priority is invalid");
  return priority;
}

function normalizeSubject(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new TypeError("subject is invalid");
  const rawId = boundedText(value.id, "subject.id", SAFE_SUBJECT_ID, 128);
  const normalizedId = /^[A-Za-z]/u.test(rawId) ? rawId : `ref-${rawId}`;
  return {
    type: boundedText(value.type, "subject.type", SAFE_ID, 128),
    id: normalizedId.slice(0, 128),
  };
}

function normalizeTaskType(value) {
  return boundedText(value, "taskType", SAFE_TASK_TYPE, 127);
}

function normalizeFeature(value) {
  return boundedText(value, "feature", SAFE_ID, 128);
}

function normalizeIdempotencyKey(value) {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, "idempotencyKey", SAFE_IDEMPOTENCY_KEY, 200);
}

function normalizeWait(value, fallback, name, max = 10 * 60_000) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return candidate;
}

function normalizeRequest(request) {
  if (!isObject(request)) throw new TypeError("completion request is invalid");
  const normalized = { ...request };
  delete normalized.signal;
  delete normalized.idempotencyKey;
  return normalized;
}

function normalizeThinking(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new TypeError("thinking is invalid");
  const type = boundedText(value.type, "thinking.type", /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/u, 40);
  return { type };
}

function defaultIdempotencyKey({ taskType, feature, owner, actor, subject, request }) {
  const digest = sha256({ taskType, feature, owner, actor, subject, request }).slice(0, 48);
  return `text:${feature}:${digest}`;
}

function resolveOwner({ config, options, owner }) {
  return normalizeOwner(
    owner
      ?? options.owner
      ?? config.aiPlatformOwner
      ?? config.owner,
  );
}

function resolveActor({ config, options, actor, owner }) {
  return normalizeActor(
    actor
      ?? options.actor
      ?? config.aiPlatformActor,
    owner,
  );
}

function resolveSubject(subject, options) {
  return normalizeSubject(subject ?? options.subject ?? null);
}

function runtimeEnabled(runtime) {
  if (!runtime) return false;
  try {
    if (typeof runtime.enabled === "function" && runtime.enabled() === false) return false;
    if (typeof runtime.configured === "function" && runtime.configured() === false) return false;
  } catch {
    return false;
  }
  return typeof runtime.createCompletionClient === "function"
    || typeof runtime.runTask === "function";
}

function completionClientEnabled(client) {
  return Boolean(client) && (
    typeof client === "function"
      || typeof client.complete === "function"
      || typeof client.createChatCompletion === "function"
      || typeof client.runTask === "function"
  );
}

function explicitRuntime(config, options) {
  return options.aiPlatformRuntime ?? config.aiPlatformRuntime ?? null;
}

function explicitClient(config, options) {
  return options.aiPlatformClient ?? config.aiPlatformClient ?? null;
}

function resolveAiPlatformMode(config, options) {
  const configured = config.aiPlatformMode;
  if (configured === undefined || configured === null || configured === "") {
    // Direct unit callers that inject a runtime/client predate the explicit
    // mode field. Treat that shape as an opt-in platform path; a normal
    // legacy-only config remains disabled and keeps the old provider path.
    return explicitRuntime(config, options) || explicitClient(config, options)
      ? "optional"
      : "disabled";
  }
  const mode = String(configured).trim().toLowerCase();
  if (!AI_PLATFORM_MODES.has(mode)) throw new TypeError("aiPlatformMode is invalid");
  return mode;
}

function canCreateConfiguredClient(config) {
  if (!String(config.aiPlatformBaseUrl ?? "").trim()) return false;
  return Boolean(
    String(config.aiPlatformAuthToken ?? "").trim()
      || typeof config.aiPlatformAuthTokenProvider === "function",
  );
}

function configuredClient(config, options) {
  if (!canCreateConfiguredClient(config)) return null;
  try {
    return createAiPlatformClient({
      baseUrl: config.aiPlatformBaseUrl,
      token: config.aiPlatformAuthToken,
      tokenProvider: config.aiPlatformAuthTokenProvider,
      fetchImpl: platformFetch(config, options.fetchImpl ?? fetch),
      timeoutMs: config.aiPlatformRequestTimeoutMs ?? config.aiPlatformTimeoutMs,
    });
  } catch {
    return null;
  }
}

export function hasAiPlatformTextRuntime(config = {}, options = {}) {
  if (resolveAiPlatformMode(config, options) === "disabled") return false;
  const runtime = explicitRuntime(config, options);
  if (runtime) return runtimeEnabled(runtime);
  const client = explicitClient(config, options) ?? configuredClient(config, options);
  return completionClientEnabled(client);
}

function legacyModelApiKey(config = {}) {
  try {
    const value = typeof config.modelApiKeyProvider === "function"
      ? config.modelApiKeyProvider()
      : config.modelApiKey;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

async function resolveLegacyModelApiKey(config = {}) {
  try {
    const value = typeof config.modelApiKeyProvider === "function"
      ? await config.modelApiKeyProvider()
      : config.modelApiKey;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function platformExecution(config, options) {
  const mode = resolveAiPlatformMode(config, options);
  if (mode === "disabled") return { mode, runtime: null, client: null };

  const runtime = explicitRuntime(config, options);
  if (runtime) {
    return {
      mode,
      runtime: runtimeEnabled(runtime) ? runtime : null,
      client: null,
    };
  }

  const client = explicitClient(config, options) ?? configuredClient(config, options);
  return {
    mode,
    runtime: null,
    client: completionClientEnabled(client) ? client : null,
  };
}

function targetModel() {
  return AI_TARGET_MODEL;
}

function targetReasoningEffort() {
  return AI_TARGET_REASONING_EFFORT;
}

function legacyCompletionUrl(baseUrl) {
  return `${String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
}

function legacyModelName(config, options) {
  return firstText(
    options.legacyModel,
    config.modelName,
    "deepseek-v4-flash",
  );
}

function taskInput(completionRequest, config, options) {
  return {
    protocol: "chat.completions.v1",
    request: {
      ...completionRequest,
      model: AI_TARGET_MODEL,
      reasoningEffort: AI_TARGET_REASONING_EFFORT,
    },
    model: AI_TARGET_MODEL,
    reasoningEffort: AI_TARGET_REASONING_EFFORT,
  };
}

function taskRequest({ taskType, feature, channel, subject, completionRequest, config, options, priority, maxWaitMs }) {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskType,
    feature,
    channel,
    subject,
    input: taskInput(completionRequest, config, options),
    priority,
    requestedWaitMs: Math.min(maxWaitMs, 30_000),
  };
}

function completionInvocationOptions({ signal, maxWaitMs, pollMs, metadata }) {
  return {
    signal,
    maxWaitMs,
    pollMs,
    metadata,
  };
}

async function invokeCompletionClient(client, completionRequest, invocationOptions) {
  if (typeof client === "function") return client(completionRequest, invocationOptions);
  if (typeof client.complete === "function") {
    return client.complete({
      ...completionRequest,
      ...(invocationOptions.signal ? { signal: invocationOptions.signal } : {}),
    });
  }
  if (typeof client.createChatCompletion === "function") {
    return client.createChatCompletion({
      ...completionRequest,
      ...(invocationOptions.signal ? { signal: invocationOptions.signal } : {}),
    });
  }
  if (typeof client.runTask === "function") {
    return client.runTask(completionRequest, invocationOptions);
  }
  throw new AiPlatformTextAdapterError("AI platform completion client is invalid", {
    code: "INVALID_CLIENT",
  });
}

async function invokeRuntime(runtime, metadata, completionRequest, config, options, maxWaitMs, pollMs, priority, signal) {
  const invocationOptions = completionInvocationOptions({
    signal,
    maxWaitMs,
    pollMs,
    metadata,
  });
  if (typeof runtime.createCompletionClient === "function") {
    const client = await runtime.createCompletionClient(metadata);
    if (!completionClientEnabled(client)) {
      throw new AiPlatformTextAdapterError("AI platform completion client is invalid", {
        code: "INVALID_CLIENT",
      });
    }
    return invokeCompletionClient(client, completionRequest, invocationOptions);
  }

  if (typeof runtime.runTask === "function") {
    const input = taskInput(completionRequest, config, options);
    // Keep both the legacy request fields and the task-shaped fields on the
    // invocation.  This supports the in-progress runtime API as well as a
    // runtime.runTask implementation that accepts the old completion body.
    return runtime.runTask({
      ...completionRequest,
      ...metadata,
      input,
      request: completionRequest,
      priority,
      maxWaitMs,
      pollMs,
      signal,
    });
  }

  throw new AiPlatformTextAdapterError("AI platform runtime is invalid", {
    code: "INVALID_RUNTIME",
  });
}

async function invokeTaskClient(client, metadata, completionRequest, config, options, maxWaitMs, pollMs, priority, signal) {
  if (!client || typeof client.runTask !== "function") {
    throw new AiPlatformTextAdapterError("AI platform task client is invalid", {
      code: "INVALID_CLIENT",
    });
  }
  return client.runTask({
    request: taskRequest({
      ...metadata,
      completionRequest,
      config,
      options,
      priority,
      maxWaitMs,
    }),
    idempotencyKey: metadata.idempotencyKey,
    maxWaitMs,
    pollMs,
    signal,
  });
}

async function invokeLegacyProvider({ config, options, completionRequest, signal, apiKey = null }) {
  const resolvedApiKey = apiKey ?? await resolveLegacyModelApiKey(config);
  if (!resolvedApiKey) {
    throw new AiPlatformTextAdapterError("Legacy model provider is not configured", {
      code: "MODEL_NOT_CONFIGURED",
      status: 503,
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(legacyCompletionUrl(config.modelBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolvedApiKey}`,
    },
    body: JSON.stringify({
      ...completionRequest,
      model: legacyModelName(config, options),
    }),
    signal: signal ?? AbortSignal.timeout(
      Number.isSafeInteger(Number(config.modelTimeoutMs)) && Number(config.modelTimeoutMs) > 0
        ? Number(config.modelTimeoutMs)
        : 30_000,
    ),
  });

  const text = await readBoundedResponseText(response, {
    maxBytes: MAX_LEGACY_RESPONSE_BYTES,
    errorMessage: "Legacy model provider response is too large",
  });
  if (!response?.ok) {
    throw new AiPlatformTextAdapterError("Legacy model provider request failed", {
      code: "MODEL_FAILURE",
      status: Number.isInteger(response?.status) ? response.status : 502,
    });
  }
  if (!text.trim()) {
    throw new AiPlatformTextAdapterError("Legacy model provider returned an empty response", {
      code: "INVALID_RESULT",
      status: 502,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiPlatformTextAdapterError("Legacy model provider returned invalid JSON", {
      code: "INVALID_JSON",
      status: 502,
    });
  }
}

function isGenericTaskResult(value) {
  return isObject(value) && value.schemaVersion === "ai-task-result-v1";
}

function findCompletionContent(value, seen = new Set()) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isObject(value) || seen.has(value)) return null;
  const genericTaskResult = isGenericTaskResult(value);
  seen.add(value);
  try {
    const direct = value.choices?.[0]?.message?.content;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const messageContent = value.message?.content;
    if (typeof messageContent === "string" && messageContent.trim()) return messageContent.trim();
    if (typeof value.content === "string" && value.content.trim()) return value.content.trim();
    for (const key of ["response", "completionResponse", "completion", "result", "output", "payload", "data", "metadata", "body"]) {
      if (Object.hasOwn(value, key)) {
        const nested = findCompletionContent(value[key], seen);
        if (nested) return nested;
      }
    }
    if (genericTaskResult) {
      if (value.metadata?.executionMode === AI_EXECUTION_MODE) {
        throw new AiPlatformTextAdapterError("AI platform local simulation does not provide business text content", {
          code: "LOCAL_SIMULATION_ONLY",
          status: 503,
        });
      }
      throw new AiPlatformTextAdapterError("AI platform returned an incompatible text result", {
        code: "INVALID_RESULT",
      });
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

async function responseValue(value) {
  if (!isObject(value)) return value;
  if (value.ok === false || (Number.isInteger(value.status) && value.status >= 400)) {
    throw new AiPlatformTextAdapterError("AI platform request was rejected", {
      code: "MODEL_FAILURE",
      status: Number.isInteger(value.status) ? value.status : 502,
    });
  }
  if (typeof value.text === "function") {
    let text;
    try {
      text = await value.text();
    } catch {
      throw new AiPlatformTextAdapterError("AI platform response could not be read", {
        code: "INVALID_RESULT",
      });
    }
    if (typeof text !== "string" || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A direct content string is accepted only for a runtime explicitly
      // returning text instead of the old JSON response envelope.
      return text;
    }
  }
  if (typeof value.json === "function") {
    try {
      return await value.json();
    } catch {
      throw new AiPlatformTextAdapterError("AI platform returned invalid JSON", {
        code: "INVALID_JSON",
      });
    }
  }
  return value;
}

function safeError(error) {
  if (error instanceof AiPlatformTextAdapterError) return error;
  const code = String(error?.code ?? "").toUpperCase();
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? "");
  if (
    name === "TimeoutError"
      || name === "AbortError"
      || code.includes("TIMEOUT")
      || /timed?\s*out|deadline\s+exceeded|request\s+aborted/i.test(message)
  ) {
    const timeout = new AiPlatformTextAdapterError("AI platform request timed out", {
      code: "TIMEOUT",
      status: 504,
    });
    timeout.name = "TimeoutError";
    return timeout;
  }
  if (
    NETWORK_ERROR_CODES.has(code)
      || name === "FetchError"
      || code.includes("NETWORK")
      || /fetch\s+failed|network\s+error|connection\s+(?:closed|refused|reset)|socket\s+(?:closed|hang\s*up)/i.test(message)
  ) {
    return new AiPlatformTextAdapterError("AI platform network error", {
      code: "NETWORK_ERROR",
      status: 502,
    });
  }
  if (
    error instanceof SyntaxError
      || code.includes("INVALID_JSON")
      || /invalid\s+json|unexpected\s+(?:end|token).*json|json\s+parse/i.test(message)
  ) {
    const invalidJson = new AiPlatformTextAdapterError("AI platform returned invalid JSON", {
      code: "INVALID_JSON",
      status: 502,
    });
    invalidJson.name = "SyntaxError";
    return invalidJson;
  }
  if (code === "LOCAL_SIMULATION_ONLY") {
    return new AiPlatformTextAdapterError("AI platform local simulation does not provide business text content", {
      code,
      status: 503,
    });
  }
  if (code.includes("INVALID_RESULT") || code === "RESULT_NOT_READY" || code === "TASK_PENDING") {
    return new AiPlatformTextAdapterError("AI platform returned an incompatible text result", {
      code: "INVALID_RESULT",
      status: 502,
    });
  }
  if (code === "AI_PLATFORM_NOT_CONFIGURED" || code === "AI_PLATFORM_DISABLED") {
    return new AiPlatformTextAdapterError("AI platform text runtime is unavailable", {
      code,
      status: 503,
    });
  }
  return new AiPlatformTextAdapterError("AI platform text request failed", {
    code: "MODEL_FAILURE",
    status: 502,
  });
}

export async function runAiPlatformTextCompletion({
  config = {},
  options = {},
  taskType,
  feature,
  channel,
  owner = null,
  actor = null,
  subject = null,
  messages,
  maxTokens = 1200,
  maxWaitMs = undefined,
  pollMs = DEFAULT_POLL_MS,
  priority = DEFAULT_PRIORITY,
  idempotencyKey = null,
  signal = null,
  thinking = null,
} = {}) {
  try {
    const normalizedTaskType = normalizeTaskType(taskType);
    const normalizedFeature = normalizeFeature(feature);
    const normalizedOwner = resolveOwner({ config, options, owner });
    const normalizedActor = resolveActor({ config, options, actor, owner: normalizedOwner });
    const normalizedChannel = normalizeChannel(channel ?? options.channel ?? config.aiPlatformChannel);
    const normalizedSubject = resolveSubject(subject, options);
    const normalizedPriority = normalizePriority(priority ?? options.priority);
    const normalizedThinking = normalizeThinking(thinking ?? options.thinking);
    const normalizedMessages = Array.isArray(messages) ? messages : [];
    const completionRequest = normalizeRequest({
      model: targetModel(config, options),
      messages: normalizedMessages,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: Number.isSafeInteger(maxTokens) ? maxTokens : 1200,
      stream: false,
      ...(normalizedThinking ? { thinking: normalizedThinking } : {}),
    });
    const normalizedMaxWaitMs = normalizeWait(
      maxWaitMs ?? options.maxWaitMs ?? config.aiPlatformMaxWaitMs,
      DEFAULT_MAX_WAIT_MS,
      "maxWaitMs",
    );
    const normalizedPollMs = normalizeWait(
      pollMs ?? options.pollMs ?? config.aiPlatformPollMs,
      DEFAULT_POLL_MS,
      "pollMs",
      30_000,
    ) || DEFAULT_POLL_MS;
    const normalizedProvidedKey = normalizeIdempotencyKey(idempotencyKey ?? options.idempotencyKey);
    const normalizedIdempotencyKey = normalizedProvidedKey ?? defaultIdempotencyKey({
      taskType: normalizedTaskType,
      feature: normalizedFeature,
      owner: normalizedOwner,
      actor: normalizedActor,
      subject: normalizedSubject,
      request: completionRequest,
    });
    const metadata = Object.freeze({
      taskType: normalizedTaskType,
      feature: normalizedFeature,
      channel: normalizedChannel,
      owner: normalizedOwner,
      actor: normalizedActor,
      subject: normalizedSubject,
      idempotencyKey: normalizedIdempotencyKey,
    });

    const execution = platformExecution(configForAiTask(config, { taskType: normalizedTaskType, owner: normalizedOwner }), options);
    let raw;
    if (execution.runtime) {
      raw = await invokeRuntime(
        execution.runtime,
        metadata,
        completionRequest,
        config,
        options,
        normalizedMaxWaitMs,
        normalizedPollMs,
        normalizedPriority,
        signal,
      );
    } else if (execution.client) {
      raw = await invokeTaskClient(
        execution.client,
        metadata,
        completionRequest,
        config,
        options,
        normalizedMaxWaitMs,
        normalizedPollMs,
        normalizedPriority,
        signal,
      );
    } else if (execution.mode !== "required") {
      raw = await invokeLegacyProvider({
        config,
        options,
        completionRequest,
        signal,
      });
    } else {
      throw new AiPlatformTextAdapterError("AI platform text runtime is required", {
        code: "AI_PLATFORM_NOT_CONFIGURED",
        status: 503,
      });
    }
    const value = await responseValue(raw);
    const content = findCompletionContent(value);
    if (!content) {
      throw new AiPlatformTextAdapterError("AI platform returned no text completion", {
        code: "INVALID_RESULT",
        status: 502,
      });
    }
    return content;
  } catch (error) {
    throw safeError(error);
  }
}

export function textModelAvailability(config = {}, options = {}) {
  if (config.aiAnalysisMode !== "model") return "disabled";
  const execution = platformExecution(config, options);
  if (execution.runtime || execution.client) return "available";
  if (execution.mode !== "required" && legacyModelApiKey(config)) return "available";
  return execution.mode === "required" ? "unavailable" : "missing";
}
