import { AI_TASK_TYPES, sha256 } from "../../../shared/aiPlatformContract.mjs";
import { AiPlatformError } from "../errors.js";
import { prepareMediaRequest } from "./mediaRequest.js";
import { agentPolicyText } from "./agentPolicyText.js";

const TEXT_TASKS = new Set(AI_TASK_TYPES.filter((type) => !["invoice.recognize", "payment-proof.recognize", "bookkeeping.extract", "asr.transcribe"].includes(type)));
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const ALLOWED_FIELDS = new Set(["id", "kind", "baseUrl", "credentialEnv", "models"]);
const MODEL_FIELDS = new Set(["name", "taskTypes", "reasoning", "reasoningEffort", "maxOutputTokens"]);
const PROBE_MAX_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

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

export function createOpenAiCompatibleProvider(policy, {
  env = process.env,
  fetchImpl = fetch,
  pdfOptions = {},
  credentialResolver = null,
  credentialMetadata = null,
  db = null,
  clock = () => new Date(),
  readinessTtlMs = 5 * 60_000,
  policyDigest = null,
} = {}) {
  const normalizedReadinessTtlMs = Number.isSafeInteger(readinessTtlMs) && readinessTtlMs >= 1_000
    ? readinessTtlMs
    : 5 * 60_000;
  const boundPolicyDigest = typeof policyDigest === "string" && /^[0-9a-f]{64}$/u.test(policyDigest)
    ? policyDigest
    : sha256(policy);
  let refreshPromise = null;
  let readinessState = Object.freeze({
    configured: false,
    credentialReady: false,
    probeReady: false,
    liveReady: false,
    ready: false,
    code: "not_configured",
    checkedAt: null,
    expiresAt: null,
    credentialRevision: 0,
    credentialDigest: null,
    policyDigest: boundPolicyDigest,
    models: Object.freeze([]),
    liveEvidence: null,
  });

  function nowMs() {
    const value = clock();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError("clock must return a valid date");
    return milliseconds;
  }
  function nowIso() { return new Date(nowMs()).toISOString(); }
  function credential() {
    const value = String(credentialResolver ? credentialResolver(policy.credentialEnv) : env[policy.credentialEnv] ?? "");
    if (!value || value.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      const error = invalid("registered provider credential is unavailable");
      error.providerStarted = false;
      throw error;
    }
    return value;
  }
  function credentialBinding() {
    const key = credential();
    let metadata = null;
    if (typeof credentialMetadata === "function") {
      try { metadata = credentialMetadata(policy.credentialEnv); } catch { metadata = null; }
    }
    const revision = Number.isSafeInteger(metadata?.revision) && metadata.revision >= 0 ? metadata.revision : 0;
    return { revision, digest: sha256(key) };
  }
  function configuredModelNames() {
    return policy.models.map((model) => model.name);
  }
  function bindingMatches(state, binding) {
    return Boolean(binding)
      && state.credentialRevision === binding.revision
      && state.credentialDigest === binding.digest
      && state.policyDigest === boundPolicyDigest;
  }
  function sameCredentialBinding(left, right) {
    return Boolean(left && right) && left.revision === right.revision && left.digest === right.digest;
  }
  function evidenceIsFresh(evidence, binding, atMs = nowMs()) {
    return Boolean(evidence)
      && evidence.providerId === policy.id
      && bindingMatches(evidence, binding)
      && evidence.settledStatus === "settled"
      && Number.isFinite(Date.parse(evidence.expiresAt))
      && Date.parse(evidence.expiresAt) > atMs;
  }
  function readiness(context = {}) {
    let binding = null;
    try { binding = credentialBinding(); } catch {}
    const credentialReady = Boolean(binding);
    const modelName = typeof context.modelName === "string" ? context.modelName : null;
    const taskType = typeof context.taskType === "string" ? context.taskType : null;
    const capabilityReady = modelName && taskType
      ? policy.models.some((model) => model.name === modelName && model.taskTypes.includes(taskType))
      : true;
    const stateBindingReady = bindingMatches(readinessState, binding);
    const fresh = stateBindingReady
      && Number.isFinite(Date.parse(readinessState.expiresAt ?? ""))
      && Date.parse(readinessState.expiresAt) > nowMs();
    const evidence = evidenceIsFresh(readinessState.liveEvidence, binding);
    const modelReady = modelName ? readinessState.models.includes(modelName) : readinessState.probeReady;
    const probeReady = credentialReady && fresh && readinessState.probeReady && modelReady;
    const liveReady = credentialReady && fresh && evidence && readinessState.liveReady && modelReady;
    // A catalogue probe is enough for the isolated canary admission class;
    // ordinary production tasks still require liveReady in taskService.
    const ready = credentialReady && capabilityReady && probeReady;
    const code = !credentialReady
      ? "not_configured"
      : !capabilityReady
        ? "capability_unsupported"
        : !stateBindingReady
          ? "credential_or_policy_changed"
          : !fresh && readinessState.expiresAt
            ? "readiness_expired"
            : liveReady
              ? "live_ready"
              : readinessState.code;
    return Object.freeze({
      configured: credentialReady,
      credentialReady,
      capabilityReady,
      probeReady,
      liveReady,
      ready,
      code,
      checkedAt: readinessState.checkedAt,
      expiresAt: readinessState.expiresAt,
      credentialRevision: credentialReady ? binding.revision : 0,
      policyDigest: boundPolicyDigest,
      liveEvidenceId: liveReady ? readinessState.liveEvidence.id : null,
      models: readinessState.models,
    });
  }
  function stateForBinding(binding, patch = {}) {
    return Object.freeze({
      configured: Boolean(binding),
      credentialReady: Boolean(binding),
      probeReady: false,
      liveReady: false,
      ready: false,
      code: binding ? "not_ready" : "not_configured",
      checkedAt: nowIso(),
      expiresAt: null,
      credentialRevision: binding?.revision ?? 0,
      credentialDigest: binding?.digest ?? null,
      policyDigest: boundPolicyDigest,
      models: Object.freeze([]),
      liveEvidence: null,
      ...patch,
    });
  }
  function readPersistedEvidence() {
    if (!db) return null;
    let binding;
    try { binding = credentialBinding(); } catch { return null; }
    const row = db.prepare(`
      SELECT id, provider_id, model_id, model_name, task_type, credential_revision,
             credential_digest, provider_policy_digest, run_id, sample_index, task_id,
             attempt_id, platform_request_id, provider_request_id, price_version_id,
             usage_json, cost_micro, function_fee_micro, total_micro, currency,
             result_schema_version, result_digest, settled_status, observed_at,
             expires_at, created_at
        FROM provider_readiness_evidence
       WHERE provider_id = ? AND settled_status = 'settled' AND expires_at > ?
       ORDER BY expires_at DESC, created_at DESC
       LIMIT 1
    `).get(policy.id, nowIso());
    if (!row || row.credential_revision !== binding.revision || row.credential_digest !== binding.digest
      || row.provider_policy_digest !== boundPolicyDigest) return null;
    let usage;
    try { usage = JSON.parse(row.usage_json); } catch { return null; }
    if (!plain(usage)) return null;
    return {
      id: row.id,
      providerId: row.provider_id,
      modelId: row.model_id,
      modelName: row.model_name,
      taskType: row.task_type,
      credentialRevision: row.credential_revision,
      credentialDigest: row.credential_digest,
      policyDigest: row.provider_policy_digest,
      runId: row.run_id,
      sampleIndex: row.sample_index,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      platformRequestId: row.platform_request_id,
      providerRequestId: row.provider_request_id,
      priceVersionId: row.price_version_id,
      usage,
      costMicro: row.cost_micro,
      functionFeeMicro: row.function_fee_micro,
      totalMicro: row.total_micro,
      currency: row.currency,
      resultSchemaVersion: row.result_schema_version,
      resultDigest: row.result_digest,
      settledStatus: row.settled_status,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
  function hydrateLiveEvidence() {
    const evidence = readPersistedEvidence();
    if (!evidence) return;
    let binding;
    try { binding = credentialBinding(); } catch { return; }
    readinessState = stateForBinding(binding, {
      probeReady: true,
      liveReady: true,
      ready: true,
      code: "live_ready",
      checkedAt: evidence.observedAt,
      expiresAt: evidence.expiresAt,
      models: Object.freeze([evidence.modelName]),
      liveEvidence: evidence,
    });
  }
  async function refreshReadiness({ modelName = null, taskType = null, signal } = {}) {
    if (refreshPromise) return refreshPromise.then(() => readiness({ modelName, taskType }));
    refreshPromise = (async () => {
      let key;
      let startedBinding;
      try {
        key = credential();
        startedBinding = credentialBinding();
      } catch {
        readinessState = stateForBinding(null);
        return;
      }
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const requestSignal = signal
        ? (AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal)
        : timeout;
      try {
        const response = await fetchImpl(policy.baseUrl + "/models", {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          readinessState = stateForBinding(startedBinding, {
            code: response.status === 429 ? "rate_limited" : "probe_failed",
          });
          return;
        }
        const parsed = await boundedResponse(response, PROBE_MAX_BYTES);
        const available = Array.isArray(parsed?.data)
          ? parsed.data.map((item) => item?.id)
          : Array.isArray(parsed?.models)
            ? parsed.models.map((item) => typeof item === "string" ? item : item?.id ?? item?.name)
            : [];
        const availableModels = [...new Set(available.filter((item) => typeof item === "string" && MODEL_NAME.test(item)))];
        const missing = configuredModelNames().filter((name) => !availableModels.includes(name));
        let currentBinding = null;
        try { currentBinding = credentialBinding(); } catch {}
        // A response from a probe started under an old credential/policy must
        // never restore readiness for the new binding.
        if (!sameCredentialBinding(startedBinding, currentBinding)) {
          readinessState = stateForBinding(currentBinding, { code: "credential_or_policy_changed" });
          return;
        }
        const existingEvidence = evidenceIsFresh(readinessState.liveEvidence, currentBinding)
          ? readinessState.liveEvidence
          : null;
        const expiresAt = new Date(nowMs() + normalizedReadinessTtlMs).toISOString();
        readinessState = stateForBinding(currentBinding, {
          probeReady: missing.length === 0,
          liveReady: Boolean(existingEvidence),
          ready: missing.length === 0,
          code: existingEvidence ? "live_ready" : missing.length === 0 ? "probe_ready" : "model_unavailable",
          checkedAt: nowIso(),
          expiresAt,
          models: Object.freeze(availableModels),
          liveEvidence: existingEvidence,
        });
      } catch (error) {
        let currentBinding = null;
        try { currentBinding = credentialBinding(); } catch {}
        if (!sameCredentialBinding(startedBinding, currentBinding)) {
          readinessState = stateForBinding(currentBinding, { code: "credential_or_policy_changed" });
          return;
        }
        readinessState = stateForBinding(startedBinding, {
          code: requestSignal.aborted
            ? "probe_timeout"
            : error?.code === "provider_response_too_large" ? error.code : "probe_failed",
        });
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise.then(() => readiness({ modelName, taskType }));
  }
  function validateLiveEvidence(evidence) {
    if (!plain(evidence) || evidence.providerId !== policy.id || evidence.policyDigest !== boundPolicyDigest
      || !MODEL_NAME.test(String(evidence.modelName ?? "")) || !Number.isSafeInteger(evidence.credentialRevision)
      || evidence.credentialRevision < 0 || !/^[0-9a-f]{64}$/u.test(evidence.credentialDigest ?? "")
      || evidence.settledStatus !== "settled" || !Number.isFinite(Date.parse(evidence.expiresAt ?? ""))
      || Date.parse(evidence.expiresAt) <= nowMs()) {
      throw new AiPlatformError("provider readiness evidence is invalid", { code: "provider_evidence_invalid", status: 503 });
    }
    const binding = credentialBinding();
    if (binding.revision !== evidence.credentialRevision || binding.digest !== evidence.credentialDigest) {
      throw new AiPlatformError("provider readiness evidence is stale", { code: "provider_evidence_stale", status: 409 });
    }
    return Object.freeze({ ...evidence });
  }
  function recordLiveEvidence(evidence) {
    const validated = validateLiveEvidence(evidence);
    const models = new Set(readinessState.models);
    models.add(validated.modelName);
    readinessState = Object.freeze({
      ...readinessState,
      configured: true,
      credentialReady: true,
      probeReady: true,
      liveReady: true,
      ready: true,
      code: "live_ready",
      checkedAt: validated.observedAt,
      expiresAt: validated.expiresAt,
      credentialRevision: validated.credentialRevision,
      credentialDigest: validated.credentialDigest,
      policyDigest: boundPolicyDigest,
      models: Object.freeze([...models]),
      liveEvidence: validated,
    });
    return readiness({ modelName: validated.modelName, taskType: validated.taskType });
  }
  function persistedLiveEvidence() {
    const evidence = readPersistedEvidence();
    return evidence ? Object.freeze({ ...evidence }) : null;
  }
  function readinessBinding() {
    try {
      const binding = credentialBinding();
      return Object.freeze({ credentialRevision: binding.revision, credentialDigest: binding.digest, policyDigest: boundPolicyDigest });
    } catch {
      return null;
    }
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
  hydrateLiveEvidence();
  return Object.freeze({
    id: policy.id,
    kind: policy.kind,
    readiness,
    refreshReadiness,
    validateLiveEvidence,
    recordLiveEvidence,
    persistedLiveEvidence,
    readinessBinding,
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
