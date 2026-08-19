import { buildQuickRecordAnalysis } from "./quickRecordAnalysis.js";
import { analyzeSalesDecision as analyzeSalesDecisionAgent } from "./ai/agents/salesDecisionAgent.js";

function fallbackAnalysis(rawContent, source) {
  const analysis = buildQuickRecordAnalysis(rawContent);
  if (!analysis) return null;
  return { ...analysis, source };
}

function completionUrl(baseUrl) {
  return `${String(baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
}

function requireText(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Model analysis response is missing ${path}`);
  }
  return value.trim();
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function normalizeMatch(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Model analysis response is missing ${path}`);
  }
  return {
    id: nullableString(value.id),
    value: requireText(value.value, `${path}.value`),
    meta: nullableString(value.meta) ?? "模型识别",
    tone: nullableString(value.tone) ?? "blue",
  };
}

function normalizeSummaryItem(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Model analysis response is missing ${path}`);
  }
  return {
    title: requireText(value.title, `${path}.title`),
    text: requireText(value.text, `${path}.text`),
  };
}

function stripJsonFence(content) {
  const text = String(content ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

export function parseModelAnalysisContent(content, provider = "model") {
  const parsed = JSON.parse(stripJsonFence(content));
  return {
    source: provider || "model",
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 78,
    customer: normalizeMatch(parsed.customer, "customer"),
    opportunity: normalizeMatch(parsed.opportunity, "opportunity"),
    weekly: normalizeMatch(parsed.weekly, "weekly"),
    summary: {
      request: normalizeSummaryItem(parsed.summary?.request, "summary.request"),
      feedback: normalizeSummaryItem(parsed.summary?.feedback, "summary.feedback"),
      risk: normalizeSummaryItem(parsed.summary?.risk, "summary.risk"),
      action: normalizeSummaryItem(parsed.summary?.action, "summary.action"),
    },
  };
}

function buildMessages(rawContent, systemPrompt = null) {
  return [
    {
      role: "system",
      content: [
        systemPrompt || "你是森特智行 AI 销售作战台的销售记录分析器。",
        "请只输出合法 JSON，不要输出解释文字。",
        "JSON 必须包含 customer、opportunity、weekly、summary。",
        "summary 必须包含 request、feedback、risk、action，每项都有 title 和 text。",
        "示例 JSON：",
        JSON.stringify({
          customer: { id: "rizhao", value: "日照中医医院", meta: "置信度 90%", tone: "blue" },
          opportunity: { id: "op-rizhao-plan", value: "日照中医医院十五五规划", meta: "置信度 80%", tone: "green" },
          weekly: { value: "周三 / 06-03", meta: "本周记录", tone: "amber" },
          summary: {
            request: { title: "客户诉求", text: "客户希望补齐基础架构能力。" },
            feedback: { title: "客户反馈", text: "客户对现有平台可控性有顾虑。" },
            risk: { title: "风险点", text: "预算路径和决策链仍需确认。" },
            action: { title: "建议动作", text: "同步客户画像、商机和周报草稿。" },
          },
        }),
      ].join("\n"),
    },
    {
      role: "user",
      content: `请分析以下销售快速记录并输出 JSON：\n${String(rawContent ?? "").trim()}`,
    },
  ];
}

async function callChatCompletion({ messages, config, fetchImpl, maxTokens = 1200 }) {
  const response = await fetchImpl(completionUrl(config.modelBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolveModelApiKey(config)}`,
    },
    body: JSON.stringify({
      model: config.modelName ?? "deepseek-v4-flash",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(config.modelTimeoutMs ?? 30000),
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`model provider returned ${response.status}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("model provider returned empty content");
  return content;
}

async function callModel(rawContent, config, fetchImpl, systemPrompt = null) {
  const content = await callChatCompletion({
    messages: buildMessages(rawContent, systemPrompt),
    config,
    fetchImpl,
    maxTokens: 3200,
  });
  return parseModelAnalysisContent(content, config.modelProvider ?? "model");
}

export function resolveModelApiKey(config = {}) {
  if (typeof config.modelApiKeyProvider === "function") {
    return String(config.modelApiKeyProvider() ?? "");
  }
  return String(config.modelApiKey ?? "");
}

function shouldUseModel(config) {
  return config.aiAnalysisMode === "model" && Boolean(resolveModelApiKey(config));
}

function parseModelDraftContent(content) {
  const parsed = JSON.parse(stripJsonFence(content));
  return requireText(parsed.content, "content");
}

function compact(value, limit = 900) {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildWeeklyDraftMessages(context) {
  const records = (context.records ?? []).map((record) => ({
    id: record.id,
    occurredAt: record.occurredAt,
    sourceChannel: record.sourceChannel,
    rawContent: compact(record.rawContent, 500),
    analysis: record.analysis,
  }));

  return [
    {
      role: "system",
      content: [
        context.systemPrompt || "你是森特智行 AI 销售作战台的周报提炼助手。",
        "请只输出合法 JSON，不要输出解释文字。",
        "JSON 必须包含 content 字段，content 为中文 Markdown 周报正文。",
        "必须保留人工确认后的事实，不要编造客户、金额或承诺。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        owner: context.owner,
        periodStart: context.periodStart,
        periodEnd: context.periodEnd,
        records,
        knowledge: context.knowledge ?? [],
        fallbackContent: compact(context.fallbackDraft?.content, 1600),
      }),
    },
  ];
}

function buildSolutionDraftMessages(context) {
  const artifactLabels = {
    communication_outline: "沟通提纲",
    presales_questions: "售前问题清单",
    solution_framework: "方案框架",
    report_outline: "汇报材料大纲",
    competitive_talk: "竞品应对话术",
  };
  const artifactLabel = artifactLabels[context.artifactType] ?? "方案框架";
  return [
    {
      role: "system",
      content: [
        "你是森特智行 AI 销售作战台的方案辅助助手。",
        "请只输出合法 JSON，不要输出解释文字。",
        `JSON 必须包含 content 字段，content 为中文 Markdown「${artifactLabel}」正文。`,
        "必须基于客户画像、商机档案、下一步动作和知识库引用生成，不要编造未提供的信息。",
        "不要改变用户请求的交付物类型，不要输出与交付物无关的长篇方案。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        owner: context.owner,
        artifactType: context.artifactType,
        artifactLabel,
        customer: context.customer,
        opportunity: context.opportunity,
        actions: context.actions,
        knowledge: context.knowledge,
        fallbackTitle: context.fallbackDraft?.title,
        fallbackContent: compact(context.fallbackDraft?.content, 2200),
      }),
    },
  ];
}

function labelForSuggestionType(type) {
  return {
    customer_profile: "客户画像补全",
    opportunity_push: "商机推进",
    knowledge_talk: "知识话术",
  }[type] ?? "销售建议";
}

function sourceRefForSuggestion(type, context = {}) {
  return {
    type: type || "manual_suggestion",
    id: context.id ?? context.customerId ?? context.opportunityId ?? context.knowledgeId ?? "manual",
  };
}

function buildFallbackSuggestion({ type, title, context = {} }) {
  const label = labelForSuggestionType(type);
  const contextText = compact(JSON.stringify(context, null, 2), 900);
  const headline = title || `${label}建议`;
  return {
    type: type || "manual_suggestion",
    title: headline,
    status: "generated",
    content: [
      `## ${headline}`,
      "",
      `- 依据：${context.customer ?? context.opportunity ?? context.knowledge ?? context.title ?? "当前业务上下文"}。`,
      `- 建议：围绕${label}补齐关键事实、责任人、时间窗口和下一步确认动作。`,
      "- 使用方式：销售确认后再写入客户档案、商机推进、周报或方案材料。",
      "",
      "### 上下文摘要",
      contextText || "当前未提供额外上下文。",
    ].join("\n"),
    sourceRefs: [sourceRefForSuggestion(type, context)],
  };
}

function buildManualSuggestionMessages({ type, title, context, fallbackSuggestion }) {
  return [
    {
      role: "system",
      content: [
        "你是森特智行 AI 销售作战台的销售建议助手。",
        "请只输出合法 JSON，不要输出解释文字。",
        "JSON 必须包含 content 字段，content 为中文 Markdown 建议正文。",
        "必须基于用户提供的上下文生成，不要编造未提供的客户承诺、金额或时间。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        type,
        title,
        context,
        fallbackContent: compact(fallbackSuggestion?.content, 1500),
      }),
    },
  ];
}

function parseItineraryOrderContent(content, expectedStopIds) {
  const parsed = JSON.parse(stripJsonFence(content));
  const orderedStopIds = parsed?.orderedStopIds;
  const expected = new Set(expectedStopIds);
  if (
    !Array.isArray(orderedStopIds) ||
    orderedStopIds.length !== expectedStopIds.length ||
    new Set(orderedStopIds).size !== expected.size ||
    orderedStopIds.some((id) => typeof id !== "string" || !expected.has(id))
  ) {
    throw new TypeError("Model itinerary response must contain a complete stop permutation");
  }
  if (!Array.isArray(parsed.advice)) {
    throw new TypeError("Model itinerary response is missing advice");
  }
  const advice = parsed.advice.slice(0, 5).map((item, index) => requireText(item, `advice[${index}]`));
  return {
    orderedStopIds: [...orderedStopIds],
    summary: requireText(parsed.summary, "summary"),
    advice,
  };
}

function buildItineraryOrderMessages(fallback, context) {
  return [
    {
      role: "system",
      content: [
        "你是森特智行 AI 销售作战台的拜访行程助手。",
        "只输出合法 JSON，不要输出解释文字。",
        "orderedStopIds 必须包含输入中的全部停靠点 ID，每个 ID 恰好一次，不得添加或遗漏。",
        "不得虚构地址、时间、距离或客户信息；预约时间属于硬约束。",
        "JSON 必须包含 orderedStopIds、summary 和 advice，advice 为不超过 5 项的字符串数组。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        departureAt: context.departureAt,
        stops: context.stops,
        durationMatrix: context.durationMatrix,
        distanceMatrix: context.distanceMatrix,
        deterministicOrder: fallback.orderedStopIds,
        deterministicSummary: fallback.summary,
      }),
    },
  ];
}

async function enhanceDraftWithModel(fallbackDraft, messages, config, options = {}) {
  if (!shouldUseModel(config)) return fallbackDraft;

  try {
    const content = await callChatCompletion({
      messages,
      config,
      fetchImpl: options.fetchImpl ?? fetch,
      maxTokens: 2600,
    });
    return {
      ...fallbackDraft,
      content: parseModelDraftContent(content),
    };
  } catch {
    return fallbackDraft;
  }
}

export async function enhanceWeeklyDraftWithModel(fallbackDraft, context, config = {}, options = {}) {
  return enhanceDraftWithModel(
    fallbackDraft,
    buildWeeklyDraftMessages({ ...context, fallbackDraft }),
    config,
    options,
  );
}

/**
 * Compose a source-backed weekly draft while retaining whether the model was
 * actually used. The ordinary enhancer above intentionally keeps its legacy
 * return shape; the assistant adapter needs this explicit provenance to
 * persist a truthful Agent run.
 */
export async function composeWeeklyDraftWithModel(fallbackDraft, context, config = {}, options = {}) {
  if (!shouldUseModel(config)) {
    return { ...fallbackDraft, source: "deterministic", fallbackReason: null };
  }
  try {
    const content = await callChatCompletion({
      messages: buildWeeklyDraftMessages({ ...context, fallbackDraft, systemPrompt: options.systemPrompt }),
      config,
      fetchImpl: options.fetchImpl ?? fetch,
      maxTokens: 2600,
    });
    return {
      ...fallbackDraft,
      content: parseModelDraftContent(content),
      source: config.modelProvider ?? "model",
      fallbackReason: null,
    };
  } catch {
    return {
      ...fallbackDraft,
      source: "fallback",
      fallbackReason: "weekly_draft_model_failure",
    };
  }
}

export async function enhanceSolutionDraftWithModel(fallbackDraft, context, config = {}, options = {}) {
  return enhanceDraftWithModel(
    fallbackDraft,
    buildSolutionDraftMessages({ ...context, fallbackDraft }),
    config,
    options,
  );
}

export async function generateManualSuggestion(input, config = {}, options = {}) {
  const fallbackSuggestion = buildFallbackSuggestion(input ?? {});
  if (!shouldUseModel(config)) return fallbackSuggestion;

  try {
    const content = await callChatCompletion({
      messages: buildManualSuggestionMessages({ ...(input ?? {}), fallbackSuggestion }),
      config,
      fetchImpl: options.fetchImpl ?? fetch,
      maxTokens: 1800,
    });
    return {
      ...fallbackSuggestion,
      content: parseModelDraftContent(content),
    };
  } catch {
    return fallbackSuggestion;
  }
}

export async function enhanceItineraryOrderWithModel(fallback, context, config = {}, options = {}) {
  if (!shouldUseModel(config)) return fallback;
  try {
    const expectedStopIds = (context.stops ?? []).map((stop) => stop.id);
    const content = await callChatCompletion({
      messages: buildItineraryOrderMessages(fallback, context),
      config,
      fetchImpl: options.fetchImpl ?? fetch,
      maxTokens: 1000,
    });
    return {
      ...parseItineraryOrderContent(content, expectedStopIds),
      source: config.modelProvider ?? "model",
    };
  } catch {
    return fallback;
  }
}

export async function analyzeQuickRecord(rawContent, config = {}, options = {}) {
  const text = String(rawContent ?? "").trim();
  if (!text) return null;

  if (config.aiAnalysisMode !== "model") {
    return fallbackAnalysis(text, "mock");
  }

  if (!resolveModelApiKey(config)) {
    return fallbackAnalysis(text, "mock_missing_model_key");
  }

  try {
    return await callModel(text, config, options.fetchImpl ?? fetch, options.systemPrompt ?? null);
  } catch {
    return fallbackAnalysis(text, "mock_model_fallback");
  }
}

export async function analyzeSalesDecision(context, config = {}, options = {}) {
  return analyzeSalesDecisionAgent(context, config, options);
}
