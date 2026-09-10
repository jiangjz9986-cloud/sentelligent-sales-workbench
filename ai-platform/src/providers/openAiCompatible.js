import { AI_TASK_TYPES } from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError } from "../errors.js";
import { prepareMediaRequest } from "./mediaRequest.js";
import { agentPolicyText } from "./agentPolicyText.js";

const TEXT_TASKS = new Set(AI_TASK_TYPES.filter((type) => !["invoice.recognize", "payment-proof.recognize", "bookkeeping.extract", "asr.transcribe"].includes(type)));
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const ALLOWED_FIELDS = new Set(["id", "kind", "baseUrl", "credentialEnv", "models"]);
const MODEL_FIELDS = new Set(["name", "taskTypes", "reasoning", "reasoningEffort", "maxOutputTokens"]);

function invalid(message = "invalid provider policy") {
  return new AiPlatformError(message, { code: "provider_configuration_invalid", status: 503 });
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProviderPolicies(value, { allowedOrigins = [], allowTestLoopback = false } = {}) {
  let policies = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 64 * 1024) throw invalid();
    try { policies = JSON.parse(value); } catch { throw invalid(); }
  }
  if (!Array.isArray(policies) || policies.length > 8) throw invalid();
  const ids = new Set();
  return policies.map((policy) => {
    if (!plain(policy) || Object.keys(policy).some((key) => !ALLOWED_FIELDS.has(key))
      || !/^provider-[a-z0-9-]{1,60}$/u.test(policy.id) || policy.id === "provider-mock"
      || ids.has(policy.id) || !/^AI_PROVIDER_[A-Z0-9_]{1,80}_KEY$/u.test(policy.credentialEnv)) throw invalid();
    ids.add(policy.id);
    const kind = policy.kind ?? "openai_compatible";
    if (!["openai_compatible", "vision", "asr"].includes(kind)) throw invalid();
    let url;
    try { url = new URL(policy.baseUrl); } catch { throw invalid(); }
    const testLoopback = allowTestLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (typeof policy.baseUrl !== "string" || policy.baseUrl.trim() !== policy.baseUrl
      || url.username || url.password || url.search || url.hash
      || !/^(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(url.pathname)
      || (!testLoopback && (url.protocol !== "https:" || !allowedOrigins.includes(url.origin)))) throw invalid("provider origin is not approved");
    if (!Array.isArray(policy.models) || !policy.models.length || policy.models.length > 16) throw invalid();
    const names = new Set();
    const models = policy.models.map((model) => {
      if (!plain(model) || Object.keys(model).some((key) => !MODEL_FIELDS.has(key))
        || !MODEL_NAME.test(model.name) || names.has(model.name)
        || !Array.isArray(model.taskTypes) || !model.taskTypes.length
        || model.taskTypes.some((type) => kind === "asr" ? type !== "asr.transcribe" : kind === "vision"
          ? !["invoice.recognize", "payment-proof.recognize"].includes(type)
          : !TEXT_TASKS.has(type) && type !== "bookkeeping.extract")
        || !["none", "deepseek-thinking", "reasoning-effort"].includes(model.reasoning ?? "none")
        || (model.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(model.reasoningEffort))
        || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 100_000) throw invalid();
      names.add(model.name);
      return Object.freeze({ ...model, taskTypes: Object.freeze([...new Set(model.taskTypes)]), reasoning: model.reasoning ?? "none" });
    });
    return Object.freeze({ ...policy, kind, baseUrl: policy.baseUrl.replace(/\/+$/u, ""), models: Object.freeze(models) });
  });
}

function usageFromResponse(value) {
  if (!plain(value) || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0
    || !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0) return null;
  const cached = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > value.prompt_tokens) return null;
  return { inputTokens: value.prompt_tokens - cached, outputTokens: value.completion_tokens, cachedInputTokens: cached, audioSeconds: 0, imagePages: 0 };
}

function safeRequestId(response, parsed) {
  const value = response.headers?.get?.("x-request-id") ?? parsed?.id;
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) ? value : null;
}

async function boundedResponse(response, maxBytes) {
  const length = response.headers?.get?.("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel?.();
    throw new AiPlatformError("provider response exceeded limit", { code: "provider_response_too_large", status: 502 });
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new AiPlatformError("provider response exceeded limit", { code: "provider_response_too_large", status: 502 });
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AiPlatformError) throw error;
    throw new AiPlatformError("invalid provider response", { code: "invalid_result", status: 502 });
  }
}

export function createOpenAiCompatibleProvider(policy, { env = process.env, fetchImpl = fetch, pdfOptions = {}, credentialResolver = null } = {}) {
  function credential() {
    const value = String(credentialResolver ? credentialResolver(policy.credentialEnv) : env[policy.credentialEnv] ?? "");
    if (!value || value.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      const error = invalid("registered provider credential is unavailable");
      error.providerStarted = false;
      throw error;
    }
    return value;
  }
  async function prepare({ task, model, agent, limits, mediaStore, signal }) {
    credential();
    const selected = policy.models.find((item) => item.name === model.name && item.taskTypes.includes(task.taskType));
    if (!selected || model.providerId !== policy.id) throw invalid("task model is not registered for this capability");
    const input = task.input;
    if (input?.protocol !== "chat.completions.v1") {
      return prepareMediaRequest({ task, model, agent, limits, mediaStore, signal }, { policy, selected, pdfOptions });
    }
    if (input?.protocol !== "chat.completions.v1" || !plain(input.request)) {
      throw new AiPlatformError("unsupported provider input protocol", { code: "invalid_request", status: 422 });
    }
    const request = input.request;
    if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 100) throw invalid("invalid completion messages");
    const messages = request.messages.map((item) => {
      if (!plain(item) || !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string") throw invalid("invalid completion message");
      return { role: item.role, content: item.content };
    });
    const policyText = agentPolicyText(agent);
    if (policyText) messages.unshift({ role: "system", content: policyText });
    const limit = Math.min(limits?.maxTokens ?? agent.limits?.maxTokens ?? 1_000, selected.maxOutputTokens);
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1 || !Number.isSafeInteger(limit) || limit < 1) throw invalid("invalid completion token limit");
    const body = {
      model: selected.name, messages,
      max_tokens: Math.min(request.max_tokens, limit),
      response_format: { type: "json_object" }, stream: false,
      temperature: 0.1,
    };
    if (selected.reasoning === "deepseek-thinking" && task.taskType === "quick-record.analyze") {
      body.thinking = { type: "disabled" };
    } else if (selected.reasoning === "reasoning-effort") {
      if (!selected.reasoningEffort) throw invalid("reasoning effort is not configured");
      body.reasoning_effort = selected.reasoningEffort;
    }
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 512 * 1024) throw invalid("completion request exceeded limit");
    return { body: encoded, selected };
  }
  return Object.freeze({
    id: policy.id,
    kind: policy.kind,
    supports({ modelName, taskType }) {
      try { credential(); } catch { return false; }
      return policy.models.some((model) => model.name === modelName && model.taskTypes.includes(taskType));
    },
    prepare,
    async execute({ task, model, agent, limits, prepared, signal, mediaStore }) {
      const input = prepared ?? await prepare({ task, model, agent, limits, mediaStore, signal });
      const key = credential();
      let response;
      try {
        response = await fetchImpl(policy.baseUrl + (input.path ?? "/chat/completions"), {
          method: "POST", redirect: "error", signal,
          headers: { ...(input.kind === "asr" ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${key}` },
          body: input.body,
        });
      } catch {
        throw new AiPlatformError("provider request failed", { code: signal?.aborted ? "cancelled" : "network_error", status: 502 });
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        throw new AiPlatformError("provider rejected request", { code: response.status === 429 ? "rate_limited" : "provider_error", status: 502 });
      }
      const parsed = await boundedResponse(response, 512 * 1024);
      const duration = typeof parsed.duration === "number" && parsed.duration > 0 && parsed.duration <= 122 ? Math.ceil(parsed.duration) : null;
      const usage = input.kind === "asr"
        ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, audioSeconds: duration ?? input.audioSeconds, imagePages: 0 }
        : usageFromResponse(parsed.usage);
      const content = parsed.choices?.[0]?.message?.content;
      const externalRequestId = safeRequestId(response, parsed);
      const reject = (code) => {
        const error = new AiPlatformError("invalid provider completion", { code, status: 502 });
        error.usage = usage;
        error.externalRequestId = externalRequestId;
        throw error;
      };
      let payload;
      if (input.kind === "asr") {
        if (typeof parsed.text !== "string" || !parsed.text.trim() || Buffer.byteLength(parsed.text) > 32 * 1024) reject("invalid_result");
        if (parsed.model && parsed.model !== model.name) reject("provider_model_mismatch");
        payload = { text: parsed.text.trim(), language: "zh-CN" };
      } else {
        if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 48 * 1024) reject("invalid_result");
        if (parsed.model !== model.name) reject("provider_model_mismatch");
        if (parsed.choices?.[0]?.finish_reason !== "stop") reject("provider_incomplete");
        if (input.kind === "structured") {
          try {
            payload = JSON.parse(content.trim().replace(/^\x60{3}(?:json)?\s*/u, "").replace(/\s*\x60{3}$/u, ""));
            if (!plain(payload)) reject("invalid_result");
          } catch { reject("invalid_result"); }
        }
      }
      return {
        externalRequestId,
        usage,
        usageStatus: input.kind === "asr" && duration === null ? "estimated" : "reported",
        result: {
          schemaVersion: "ai-task-result-v1", status: "success", source: "model",
          facts: [], inferences: [], unknowns: [], suggestions: [],
          sourceRefs: [{ type: "ai_task", id: task.id }],
          writebackPreview: { requiresHumanConfirmation: true, actions: [] },
          metadata: {
            ...(payload ? { payload, ...(input.kind === "asr" ? { transcript: payload.text } : {}) } : { completion: content }),
            provider: policy.id, actualModel: parsed.model ?? model.name, modelIdentitySource: parsed.model ? "response" : "registered-policy",
            executionMode: "external-provider", agentVersion: agent.versionId,
          },
        },
      };
    },
  });
}
