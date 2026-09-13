import { randomUUID } from "node:crypto";
import {
  AI_EXECUTION_MODE,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
  sha256,
} from "../../../shared/aiPlatformContract.mjs";
import { AI_PROVIDER_CANARY_MAX_SAMPLES } from "../../../shared/aiPlatformCanaryContract.mjs";
import { AiPlatformError } from "../errors.js";
import { executeMediaTask, isMediaTaskType } from "./mediaAdapter.js";
import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";
import { withImmediateTransaction } from "../utils.js";

function boundedText(value, max = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, max);
}

export const mockProvider = Object.freeze({
  id: "provider-mock",
  kind: "mock",
  async execute({ task, agent, model, signal }) {
    if (signal?.aborted) {
      const error = new Error("task cancelled");
      error.code = "cancelled";
      throw error;
    }
    if (isMediaTaskType(task.taskType)) {
      return executeMediaTask({ task, agent, model, signal });
    }
    const inputSummary = boundedText(JSON.stringify(task.input));
    return {
      externalRequestId: `mock-${task.id}`,
      result: {
        schemaVersion: "ai-task-result-v1",
        status: "success",
        source: "mock",
        facts: [
          { key: "task_type", value: task.taskType, confidence: 100 },
          { key: "feature", value: task.feature, confidence: 100 },
          ...(inputSummary ? [{ key: "input_summary", value: inputSummary, confidence: 100 }] : []),
        ],
        inferences: [],
        unknowns: ["当前任务使用本地模拟供应商，未代表真实模型质量或真实供应商费用。"],
        suggestions: [{ title: "下一步", text: "接入真实供应商前先完成配置、成本和结果合同验收。" }],
        sourceRefs: [{ type: "ai_task", id: task.id }],
        writebackPreview: { requiresHumanConfirmation: true, actions: [] },
        metadata: {
          provider: model.providerId ?? "provider-mock",
          model: model.name ?? "mock-standard-v1",
          actualModel: model.name ?? "mock-standard-v1",
          logicalTargetModel: AI_TARGET_MODEL,
          targetReasoningEffort: AI_TARGET_REASONING_EFFORT,
          executionMode: AI_EXECUTION_MODE,
          agentVersion: agent.versionId,
          inputDigest: sha256(task.input),
        },
      },
      usage: {
        inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(inputSummary, "utf8") / 4)),
        outputTokens: 120,
        cachedInputTokens: 0,
        audioSeconds: 0,
        imagePages: 0,
      },
    };
  },
});

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);
}

function safeDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeEvidence(value, provider) {
  if (!provider || provider.kind === "mock" || provider.id === "provider-mock") {
    throw new AiPlatformError("mock provider evidence is not eligible", { code: "provider_evidence_invalid", status: 422 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.providerId !== provider.id
    || !safeId(value.modelId) || !safeId(value.modelName) || !safeId(value.taskType)
    || !safeInteger(value.credentialRevision) || !safeDigest(value.credentialDigest)
    || !safeDigest(value.policyDigest) || !safeId(value.runId)
    || !Number.isSafeInteger(value.sampleIndex) || value.sampleIndex < 1 || value.sampleIndex > AI_PROVIDER_CANARY_MAX_SAMPLES
    || !safeId(value.taskId) || !safeId(value.attemptId) || !safeId(value.platformRequestId)
    || !safeId(value.providerRequestId) || !safeId(value.priceVersionId)
    || !value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)
    || !safeInteger(value.costMicro) || !safeInteger(value.functionFeeMicro) || !safeInteger(value.totalMicro)
    || value.totalMicro !== value.costMicro + value.functionFeeMicro
    || !["CNY", "USD"].includes(value.currency)
    || value.resultSchemaVersion !== "ai-task-result-v1" || !safeDigest(value.resultDigest)
    || value.settledStatus !== "settled"
    || !Number.isFinite(Date.parse(value.observedAt ?? ""))
    || !Number.isFinite(Date.parse(value.expiresAt ?? ""))
    || !Number.isFinite(Date.parse(value.createdAt ?? ""))) {
    throw new AiPlatformError("provider readiness evidence is invalid", { code: "provider_evidence_invalid", status: 422 });
  }
  return Object.freeze({
    ...value,
    usage: Object.freeze({ ...value.usage }),
  });
}

export function createProviderRegistry({
  providers = null,
  config = {},
  env = process.env,
  fetchImpl = fetch,
  credentialResolver = null,
  credentialMetadata = null,
  db = null,
  clock = () => new Date(),
  readinessTtlMs = 5 * 60_000,
} = {}) {
  const policyDigest = sha256(config.providerPolicies ?? []);
  const configured = providers ?? [
    mockProvider,
    ...(config.externalProvidersEnabled ? (config.providerPolicies ?? []).map((policy) => createOpenAiCompatibleProvider(policy, {
      env, fetchImpl, credentialResolver,
      credentialMetadata,
      db,
      clock,
      readinessTtlMs,
      policyDigest,
      pdfOptions: { command: config.pdfImageCommand ?? "pdftoppm", ...(config.mediaDirectory ? { tempRoot: config.mediaDirectory } : {}) },
    })) : []),
  ];
  if (new Set(configured.map((provider) => provider.id)).size !== configured.length) throw new Error("duplicate AI provider registration");
  const map = new Map(configured.map((provider) => [provider.id, provider]));
  function evidenceRow(row) {
    if (!row) return null;
    let usage;
    try { usage = JSON.parse(row.usage_json); } catch { usage = {}; }
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
  function recordLiveEvidence(value) {
    const provider = map.get(value?.providerId);
    const evidence = normalizeEvidence(value, provider);
    if (typeof provider.validateLiveEvidence !== "function" || typeof provider.recordLiveEvidence !== "function") {
      throw new AiPlatformError("provider cannot promote live evidence", { code: "provider_evidence_invalid", status: 503 });
    }
    provider.validateLiveEvidence(evidence);
    let stored;
    if (db) {
      stored = withImmediateTransaction(db, () => {
        const existing = db.prepare(`
          SELECT * FROM provider_readiness_evidence
           WHERE provider_id = ? AND run_id = ? AND sample_index = ?
        `).get(evidence.providerId, evidence.runId, evidence.sampleIndex);
        if (existing) {
          const replay = evidenceRow(existing);
          const same = replay.taskId === evidence.taskId
            && replay.attemptId === evidence.attemptId
            && replay.providerRequestId === evidence.providerRequestId
            && replay.resultDigest === evidence.resultDigest
            && replay.credentialRevision === evidence.credentialRevision
            && replay.credentialDigest === evidence.credentialDigest
            && replay.policyDigest === evidence.policyDigest;
          if (!same) throw new AiPlatformError("provider readiness evidence conflicts with an existing sample", { code: "provider_evidence_conflict", status: 409 });
          return { ...replay, replayed: true };
        }
        const task = db.prepare(`
          SELECT t.request_id, t.status, t.admission_mode, m.provider_id, t.model_id,
                 t.task_type, t.owner, t.feature, t.channel, t.subject_type, t.subject_id
            FROM tasks t
            JOIN models m ON m.id = t.model_id
           WHERE t.id = ?
        `).get(evidence.taskId);
        const attempt = db.prepare(`
          SELECT id, task_id, provider_id, model_id, status, external_request_id,
                 price_version_id, cost_micro, cost_status
            FROM task_attempts WHERE id = ?
        `).get(evidence.attemptId);
        if (!task || task.status !== "succeeded" || task.admission_mode !== "provider-canary"
          || task.provider_id === "provider-mock" || task.provider_id !== evidence.providerId
          || task.model_id !== evidence.modelId || task.task_type !== evidence.taskType
          || task.owner !== "p2-acceptance" || task.feature !== "p2-acceptance" || task.channel !== "system"
          || task.subject_type !== "p2_acceptance" || task.subject_id !== evidence.runId
          || task.request_id !== evidence.platformRequestId
          || !attempt || attempt.task_id !== evidence.taskId || attempt.status !== "succeeded"
          || attempt.provider_id !== evidence.providerId || attempt.model_id !== evidence.modelId
          || attempt.external_request_id !== evidence.providerRequestId
          || attempt.price_version_id !== evidence.priceVersionId
          || attempt.cost_micro !== evidence.costMicro || attempt.cost_status !== "calculated") {
          throw new AiPlatformError("provider readiness evidence does not match settled task state", { code: "provider_evidence_invalid", status: 422 });
        }
        const id = `provider-readiness-${randomUUID()}`;
        db.prepare(`
          INSERT INTO provider_readiness_evidence (
            id, provider_id, model_id, model_name, task_type, credential_revision,
            credential_digest, provider_policy_digest, run_id, sample_index, task_id,
            attempt_id, platform_request_id, provider_request_id, price_version_id,
            usage_json, cost_micro, function_fee_micro, total_micro, currency,
            result_schema_version, result_digest, settled_status, observed_at,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?)
        `).run(
          id, evidence.providerId, evidence.modelId, evidence.modelName, evidence.taskType,
          evidence.credentialRevision, evidence.credentialDigest, evidence.policyDigest,
          evidence.runId, evidence.sampleIndex, evidence.taskId, evidence.attemptId,
          evidence.platformRequestId, evidence.providerRequestId, evidence.priceVersionId,
          JSON.stringify(evidence.usage), evidence.costMicro, evidence.functionFeeMicro,
          evidence.totalMicro, evidence.currency, evidence.resultSchemaVersion,
          evidence.resultDigest, evidence.observedAt, evidence.expiresAt, evidence.createdAt,
        );
        return { ...evidence, id, replayed: false };
      });
    } else {
      stored = { ...evidence, id: `provider-readiness-memory-${randomUUID()}`, replayed: false };
    }
    provider.recordLiveEvidence(stored);
    return Object.freeze({ ...stored, usage: Object.freeze({ ...stored.usage }) });
  }
  function readinessEvidence({ providerId = null, limit = 25 } = {}) {
    if (!db) return [];
    const safeLimitValue = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 25;
    const rows = providerId
      ? db.prepare("SELECT * FROM provider_readiness_evidence WHERE provider_id = ? ORDER BY created_at DESC LIMIT ?").all(providerId, safeLimitValue)
      : db.prepare("SELECT * FROM provider_readiness_evidence ORDER BY created_at DESC LIMIT ?").all(safeLimitValue);
    return rows.map(evidenceRow);
  }
  return Object.freeze({
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
    readiness: (context = {}) => map.get(context.providerId)?.readiness?.(context) ?? null,
    async refreshReadiness(context = {}) {
      const selected = context.providerId ? [map.get(context.providerId)].filter(Boolean) : [...map.values()];
      return Promise.all(selected.map((provider) => provider.refreshReadiness?.(context) ?? provider.readiness?.(context) ?? null));
    },
    recordLiveEvidence,
    readinessEvidence,
  });
}
