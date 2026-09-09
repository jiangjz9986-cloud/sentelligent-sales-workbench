import {
  AI_EXECUTION_MODE,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
  sha256,
} from "../../../shared/aiPlatformContract.mjs";
import { executeMediaTask, isMediaTaskType } from "./mediaAdapter.js";
import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

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

export function createProviderRegistry({ providers = null, config = {}, env = process.env, fetchImpl = fetch } = {}) {
  const configured = providers ?? [
    mockProvider,
    ...(config.externalProvidersEnabled ? (config.providerPolicies ?? []).map((policy) => createOpenAiCompatibleProvider(policy, {
      env, fetchImpl, pdfOptions: { command: config.pdfImageCommand ?? "pdftoppm", ...(config.mediaDirectory ? { tempRoot: config.mediaDirectory } : {}) },
    })) : []),
  ];
  if (new Set(configured.map((provider) => provider.id)).size !== configured.length) throw new Error("duplicate AI provider registration");
  const map = new Map(configured.map((provider) => [provider.id, provider]));
  return Object.freeze({
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
  });
}
