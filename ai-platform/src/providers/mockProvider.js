import { sha256 } from "../../../shared/aiPlatformContract.mjs";

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
          provider: model.providerId,
          model: model.name,
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

export function createProviderRegistry({ providers = [mockProvider] } = {}) {
  const map = new Map(providers.map((provider) => [provider.id, provider]));
  return Object.freeze({
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
  });
}
