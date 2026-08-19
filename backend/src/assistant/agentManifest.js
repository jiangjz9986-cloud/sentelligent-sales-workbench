import {
  AGENT_DEFINITIONS,
  createAgentRegistry,
} from "./agentRegistry.js";
import {
  AssistantContractError,
  validateAgentId,
  validateToolName,
} from "./contracts.js";

export const AGENT_MANIFEST_SCHEMA_VERSION = "assistant-agent-manifest-v1";
export const AGENT_CONTRACT_VERSION = "assistant-agent-contract-v1";

const LIFECYCLE_STATUSES = new Set(["active", "draft", "disabled"]);
const MODEL_POLICIES = new Set([
  "none",
  "optional",
  "required",
  "required_with_deterministic_fallback",
  "disabled_until_approved",
  "disabled_until_data_boundary_approved",
]);
const CONFIRMATION_LEVELS = new Set(["none", "preview", "explicit"]);
const SOURCE_POLICIES = new Set(["none", "optional", "required"]);
const TASK_TYPE = /^[a-z][a-z0-9_]{1,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const UNSAFE_PROMPT = /(?:execute|run|send|reveal|accept)\s+(?:arbitrary\s+)?(?:sql|shell|http|url|token|owner)|ignore\s+(?:all\s+)?safety/i;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requiredText(value, name, max = 4000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(name + " is required", "invalid_manifest");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(name + " is too long", "invalid_manifest");
  }
  return normalized;
}

function stringArray(value, name, { maxItems = 100, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AssistantContractError(name + " must be a bounded array", "invalid_manifest");
  }
  const result = value.map((item, index) => {
    const label = name + "[" + index + "]";
    const normalized = requiredText(item, label, 500);
    if (pattern && !pattern.test(normalized)) {
      throw new AssistantContractError(label + " is invalid", "invalid_manifest");
    }
    return normalized;
  });
  if (new Set(result).size !== result.length) {
    throw new AssistantContractError(name + " contains duplicates", "invalid_manifest");
  }
  return result;
}

function schema(value, name) {
  if (!isPlainObject(value) || value.type !== "object") {
    throw new AssistantContractError(name + " must be an object schema", "invalid_manifest");
  }
  const required = stringArray(value.required ?? [], name + ".required", { maxItems: 100 });
  const properties = isPlainObject(value.properties ?? {}) ? clone(value.properties) : null;
  if (!properties) {
    throw new AssistantContractError(name + ".properties must be an object", "invalid_manifest");
  }
  return { type: "object", required, properties };
}

function promptFor(description) {
  return [
    "你是小小助手的", description, "Agent。",
    "只使用服务端提供的 owner-scoped 业务快照和已注册工具。",
    "必须区分事实、推断、未知和建议，并保留来源引用。",
    "不得猜测身份、权限、金额、日期或实体关系，不得执行任意 SQL、Shell、网络请求或文件操作。",
    "任何写回只能生成预览，必须由本人明确确认后执行。",
  ].join("");
}

function manifestDefinition(id, options = {}) {
  const agent = AGENT_DEFINITIONS.find((item) => item.id === id);
  if (!agent) throw new Error("missing registered agent: " + id);
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    contractVersion: AGENT_CONTRACT_VERSION,
    id,
    version: "1.0.0",
    description: agent.description,
    instructions: agent.instructions,
    enabled: agent.enabled,
    lifecycle: agent.enabled ? "active" : "disabled",
    modelPolicy: "optional",
    taskTypes: ["default"],
    tools: [],
    confirmation: { preview: "none", write: "explicit" },
    sourcePolicy: { mode: "optional", requiredFields: ["sourceRefs"] },
    inputSchema: { type: "object", required: [], properties: {} },
    outputSchema: {
      type: "object",
      required: ["status", "facts", "inferences", "unknowns", "sourceRefs"],
      properties: {},
    },
    systemPrompt: promptFor(agent.description),
    fallback: { strategy: "return a bounded deterministic result", status: "fallback" },
    ...options,
  };
}

export const AGENT_MANIFESTS = deepFreeze([
  manifestDefinition("system-router", {
    modelPolicy: "none",
    taskTypes: ["route_intent", "clarify", "help", "cancel", "confirm"],
    confirmation: { preview: "none", write: "none" },
    sourcePolicy: { mode: "none", requiredFields: [] },
    outputSchema: { type: "object", required: ["status", "agentId", "taskType"], properties: {} },
    fallback: { strategy: "return unknown or clarify without executing a tool", status: "clarify" },
  }),
  manifestDefinition("dashboard", {
    taskTypes: ["daily_overview", "weekly_overview", "focus_summary"],
    tools: ["dashboard.summary"],
  }),
  manifestDefinition("visit-capture", {
    modelPolicy: "required_with_deterministic_fallback",
    taskTypes: ["capture", "normalize", "preview", "link_candidates"],
    tools: ["visit-capture.collect", "visit-capture.preview", "visit-capture.confirm"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs", "rawContent"] },
  }),
  manifestDefinition("customer", {
    contractVersion: "customer-v1",
    taskTypes: ["search", "detail", "summarize", "change_preview"],
    tools: ["customer.search", "customer.detail"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType"],
      properties: { taskType: "enum", query: "string", customerId: "string", changes: "object" },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: {
        schemaVersion: "customer-v1",
        customer: "object|null",
        matches: "array",
        changePreview: "object|null",
      },
    },
    systemPrompt: [
      "你是森特智行客户 Agent。",
      "只使用服务端提供的 owner-scoped 客户快照；查询结果以服务端字段为准。",
      "匹配不唯一时必须澄清，不得根据名称相似度擅自选择。",
      "严格区分事实、推断和未知；变更只生成逐字段 before/after 预览，不能执行写入。",
      "不得猜测联系人、级别、行业、客户关系、权限或来源。",
    ].join(""),
    fallback: { strategy: "return deterministic owner-scoped customer fields and clarify ambiguity", status: "fallback" },
  }),
  manifestDefinition("opportunity", {
    contractVersion: "opportunity-v1",
    modelPolicy: "none",
    taskTypes: ["search", "detail", "stage_review", "change_preview"],
    tools: ["opportunity.detail"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType"],
      properties: { taskType: "enum", query: "string", opportunityId: "string", changes: "object" },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "relationship", "writebackPreview"],
      properties: {
        schemaVersion: "opportunity-v1",
        opportunity: "object|null",
        matches: "array",
        relationship: "object",
        stageReview: "object|null",
        changePreview: "object|null",
      },
    },
    systemPrompt: [
      "你是森特智行商机 Agent。",
      "只使用服务端提供的 owner-scoped 商机和客户快照，并先校验商机与客户关系。",
      "阶段、金额和概率只能作为服务端事实陈述，不得猜测或修改；金额和版本不得由模型生成。",
      "不得混入 sales-decision 的推进策略；阶段评审只报告当前值和未知项。",
      "变更仅生成逐字段预览，不能执行写入，且必须拒绝客户关系、阶段、金额、概率和版本字段。",
    ].join(""),
    fallback: { strategy: "return deterministic owner-scoped opportunity facts and clarify ambiguity", status: "fallback" },
  }),
  manifestDefinition("sales-decision", {
    contractVersion: "sales-decision-v1",
    modelPolicy: "required_with_deterministic_fallback",
    taskTypes: ["opportunity_diagnosis", "customer_analysis", "meeting_preparation", "next_step_decision"],
    tools: ["sales-decision.preview"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["customer", "opportunity", "sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["analysisType", "analysisAt"],
      properties: {
        analysisType: "enum",
        analysisAt: "iso_datetime",
        customer: "object",
        opportunity: "object",
        quickRecord: "object|null",
        actions: "array",
        risks: "array",
        knowledge: "array",
      },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "inferences", "unknowns", "sourceRefs", "writebackPreview"],
      properties: {
        schemaVersion: "sales-decision-v1",
        decision: "object",
        stage: "object",
        score: "object",
        compliance: "object",
      },
    },
    systemPrompt: [
      "你是森特智行 sales-decision-v1 Agent。",
      "只基于服务端提供的不可变业务快照分析，不得编造预算、决策人、承诺、竞争信息、金额、阶段或客户意图。",
      "严格区分事实、推断、未知、风险和建议；每个关键结论保留来源引用。",
      "证据不足时保守评分并列出验证问题；发现合规红线时停止推进建议并要求人工审查。",
      "只输出严格合同；writebackPreview 永远只是待确认草案，不能执行任何业务写回。",
    ].join(""),
    fallback: { strategy: "run deterministic sales-decision guardrails on the same snapshot", status: "fallback" },
  }),
  manifestDefinition("action-risk", {
    contractVersion: "action-risk-v1",
    modelPolicy: "none",
    taskTypes: ["summary", "prioritize", "follow_up_preview", "status_change_preview"],
    tools: ["action-risk.summary"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType"],
      properties: {
        taskType: "enum",
        customerId: "string",
        opportunityId: "string",
        actionId: "string",
        riskId: "string",
        changes: "object",
      },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: {
        schemaVersion: "action-risk-v1",
        actions: "array",
        risks: "array",
        prioritization: "object",
        changePreview: "object|null",
      },
    },
    systemPrompt: [
      "你是森特智行行动与风险 Agent。",
      "只使用 owner-scoped 服务端行动和风险摘要，保留服务端排序及来源引用。",
      "可以区分事实和未知，但不得把排序伪装成销售推进建议，也不得猜测责任人、截止日或风险处置结果。",
      "状态、截止日和优先级变更只能生成预览，不能执行写回，且必须经过本人确认。",
    ].join(""),
    fallback: { strategy: "return deterministic owner-scoped action and risk summary", status: "fallback" },
  }),
  manifestDefinition("itinerary", {
    contractVersion: "itinerary-v1",
    modelPolicy: "none",
    taskTypes: ["summary", "plan_preview", "optimize_order", "change_preview"],
    tools: ["itinerary.summary"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType"],
      properties: { taskType: "enum", itineraryId: "string", changes: "object" },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: { schemaVersion: "itinerary-v1", items: "array", planPreview: "object|null", changePreview: "object|null" },
    },
    systemPrompt: [
      "你是森特智行行程 Agent。",
      "只使用 owner-scoped 行程快照，日期和状态以服务端记录为准。",
      "没有路线输入时不得猜地址、顺序、里程或到达时间；规划和排序只能返回待确认预览。",
      "保存、修改、删除和路线变更都不能直接执行，必须由本人确认。",
    ].join(""),
    fallback: { strategy: "return deterministic owner-scoped itinerary facts and an empty plan preview", status: "fallback" },
  }),
  manifestDefinition("travel-expense", {
    contractVersion: "travel-expense-v1",
    modelPolicy: "none",
    taskTypes: ["weekly_summary", "expense_review", "entry_preview"],
    tools: ["travel-expense.summary"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType"],
      properties: { taskType: "enum", weekStart: "date", expenseId: "string", changes: "object" },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: { schemaVersion: "travel-expense-v1", weekStart: "date", summary: "object", items: "array", changePreview: "object|null" },
    },
    systemPrompt: [
      "你是森特智行差旅费用 Agent。",
      "只使用 owner-scoped 自然周费用快照；金额、实付、可报销额和发票状态必须原样保留并带来源。",
      "金额异常时只提示人工核对，不得修正、四舍五入、补票或猜测缺失金额。",
      "费用维护只生成预览，金额、发票状态、版本和 owner 永远不可由模型修改。",
    ].join(""),
    fallback: { strategy: "return deterministic owner-scoped expense facts and review blockers", status: "fallback" },
  }),
  manifestDefinition("payment-proof", {
    taskTypes: ["ingest", "recognize", "candidate_match", "review"],
    tools: ["payment-proof.ingest"],
    confirmation: { preview: "preview", write: "explicit" },
  }),
  manifestDefinition("invoice", {
    taskTypes: ["ingest", "recognize", "match_preview", "no_invoice_review"],
    tools: ["invoice.ingest"],
    confirmation: { preview: "preview", write: "explicit" },
  }),
  manifestDefinition("advance-settlement", {
    taskTypes: ["advance_summary", "settlement_preview", "direction_explanation"],
    confirmation: { preview: "preview", write: "explicit" },
  }),
  manifestDefinition("reimbursement-report", {
    taskTypes: ["weekly_summary", "invoice_coverage", "print_readiness"],
    tools: ["reimbursement-report.preview"],
    confirmation: { preview: "preview", write: "none" },
  }),
  manifestDefinition("sales-report", {
    contractVersion: "sales-report-v1",
    modelPolicy: "required_with_deterministic_fallback",
    taskTypes: ["weekly_preview", "meeting_digest", "source_review", "save_preview"],
    tools: ["sales-report.preview"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs", "period"] },
    inputSchema: {
      type: "object",
      required: ["period", "sourceRecords"],
      properties: {
        period: "object",
        sourceRecords: "array",
        knowledge: "array",
        taskType: "enum",
      },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "period", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: {
        schemaVersion: "sales-report-v1",
        executiveSummary: "string",
        customerUpdates: "array",
        opportunityUpdates: "array",
        actions: "array",
        risks: "array",
        preparation: "object",
      },
    },
    systemPrompt: [
      "你是森特智行销售周报 Agent。",
      "只使用服务端提供的已确认拜访记录、客户、商机、行动、风险和知识引用组织周报。",
      "不得编造客户进展、金额、承诺、完成状态或来源；没有证据的内容必须标记为未知或省略。",
      "严格区分事实、推断、未知和建议；输出只是预览，不代表周报已保存、发布或写回任何业务数据。",
    ].join(""),
    fallback: { strategy: "use the deterministic source-backed weekly draft and mark composition as fallback", status: "fallback" },
  }),
  manifestDefinition("knowledge", {
    contractVersion: "knowledge-v1",
    modelPolicy: "none",
    taskTypes: ["search", "answer_with_sources", "compare", "maintenance_preview"],
    tools: ["knowledge.search"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    inputSchema: {
      type: "object",
      required: ["taskType", "query"],
      properties: { taskType: "enum", query: "string", knowledgeId: "string", changes: "object" },
    },
    outputSchema: {
      type: "object",
      required: ["schemaVersion", "status", "facts", "unknowns", "sourceRefs", "writebackPreview"],
      properties: {
        schemaVersion: "knowledge-v1",
        items: "array",
        answer: "object|null",
        comparison: "object|null",
        changePreview: "object|null",
      },
    },
    systemPrompt: [
      "你是森特智行知识 Agent。",
      "只读检索有界知识元数据和摘要，所有结论必须保留来源引用。",
      "没有来源时必须返回未知，不得把完整正文、外部链接或猜测当作事实。",
      "回答、比较和维护都只能基于当前返回条目；知识写入仅生成预览并等待本人确认。",
    ].join(""),
    fallback: { strategy: "return bounded source-backed knowledge metadata and unknowns", status: "fallback" },
  }),
  manifestDefinition("solution", {
    lifecycle: "disabled",
    modelPolicy: "disabled_until_approved",
    taskTypes: ["solution_outline", "meeting_agenda", "proposal_draft"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    fallback: { strategy: "explain that the feature is disabled", status: "disabled" },
  }),
  manifestDefinition("personal-finance", {
    lifecycle: "disabled",
    modelPolicy: "disabled_until_data_boundary_approved",
    taskTypes: ["ledger_summary", "cashflow_review", "personal_budget"],
    confirmation: { preview: "preview", write: "explicit" },
    sourcePolicy: { mode: "required", requiredFields: ["sourceRefs"] },
    fallback: { strategy: "explain that the feature is disabled", status: "disabled" },
  }),
]);

export function validateAgentManifest(value, { registry = createAgentRegistry() } = {}) {
  if (!isPlainObject(value)) {
    throw new AssistantContractError("agent manifest must be an object", "invalid_manifest");
  }
  const id = validateAgentId(value.id);
  const registered = registry.getAgent(id);
  if (!registered) throw new AssistantContractError("agent is not registered: " + id, "invalid_manifest");
  const version = requiredText(value.version, "version", 40);
  if (!VERSION.test(version)) throw new AssistantContractError("version is invalid", "invalid_manifest");
  const lifecycle = requiredText(value.lifecycle, "lifecycle", 40);
  if (!LIFECYCLE_STATUSES.has(lifecycle)) throw new AssistantContractError("lifecycle is invalid", "invalid_manifest");
  const modelPolicy = requiredText(value.modelPolicy, "modelPolicy", 100);
  if (!MODEL_POLICIES.has(modelPolicy)) throw new AssistantContractError("modelPolicy is invalid", "invalid_manifest");
  if (Boolean(value.enabled) !== Boolean(registered.enabled)) {
    throw new AssistantContractError("manifest enabled state does not match registry", "invalid_manifest");
  }
  const taskTypes = stringArray(value.taskTypes, "taskTypes", { pattern: TASK_TYPE });
  const tools = stringArray(value.tools ?? [], "tools", { pattern: TOOL_NAME });
  for (const toolName of tools) {
    validateToolName(toolName);
    const tool = registry.getTool(toolName);
    if (!tool) throw new AssistantContractError("tool is not registered: " + toolName, "invalid_manifest");
    if (tool.agentId !== id) {
      throw new AssistantContractError("tool belongs to another agent: " + toolName, "invalid_manifest");
    }
  }
  if (!isPlainObject(value.confirmation)) {
    throw new AssistantContractError("confirmation is invalid", "invalid_manifest");
  }
  const confirmation = {
    preview: requiredText(value.confirmation.preview, "confirmation.preview", 40),
    write: requiredText(value.confirmation.write, "confirmation.write", 40),
  };
  if (!CONFIRMATION_LEVELS.has(confirmation.preview) || !CONFIRMATION_LEVELS.has(confirmation.write)) {
    throw new AssistantContractError("confirmation level is invalid", "invalid_manifest");
  }
  if (!isPlainObject(value.sourcePolicy)) {
    throw new AssistantContractError("sourcePolicy is invalid", "invalid_manifest");
  }
  const sourcePolicy = {
    mode: requiredText(value.sourcePolicy.mode, "sourcePolicy.mode", 40),
    requiredFields: stringArray(value.sourcePolicy.requiredFields ?? [], "sourcePolicy.requiredFields"),
  };
  if (!SOURCE_POLICIES.has(sourcePolicy.mode)) {
    throw new AssistantContractError("sourcePolicy.mode is invalid", "invalid_manifest");
  }
  const systemPrompt = requiredText(value.systemPrompt, "systemPrompt", 20_000);
  if (UNSAFE_PROMPT.test(systemPrompt)) {
    throw new AssistantContractError("systemPrompt contains unsafe execution instructions", "unsafe_prompt");
  }
  if (!isPlainObject(value.fallback)) {
    throw new AssistantContractError("fallback is invalid", "invalid_manifest");
  }
  const fallback = {
    strategy: requiredText(value.fallback.strategy, "fallback.strategy", 2000),
    status: requiredText(value.fallback.status, "fallback.status", 100),
  };
  const inputSchema = schema(value.inputSchema, "inputSchema");
  const outputSchema = schema(value.outputSchema, "outputSchema");
  return deepFreeze({
    schemaVersion: requiredText(value.schemaVersion, "schemaVersion", 100),
    contractVersion: requiredText(value.contractVersion, "contractVersion", 100),
    id,
    version,
    description: requiredText(value.description, "description", 1000),
    instructions: requiredText(value.instructions, "instructions", 4000),
    enabled: Boolean(value.enabled),
    lifecycle,
    modelPolicy,
    taskTypes,
    tools,
    confirmation,
    sourcePolicy,
    inputSchema,
    outputSchema,
    systemPrompt,
    fallback,
  });
}

export function createAgentManifestRegistry({
  manifests = AGENT_MANIFESTS,
  registry = createAgentRegistry(),
} = {}) {
  if (!Array.isArray(manifests)) {
    throw new AssistantContractError("manifests must be an array", "invalid_manifest");
  }
  const map = new Map();
  for (const candidate of manifests) {
    const normalized = validateAgentManifest(candidate, { registry });
    if (map.has(normalized.id)) {
      throw new AssistantContractError("duplicate agent manifest: " + normalized.id, "invalid_manifest");
    }
    map.set(normalized.id, normalized);
  }
  for (const agent of registry.listAgents()) {
    if (!map.has(agent.id)) {
      throw new AssistantContractError("missing agent manifest: " + agent.id, "invalid_manifest");
    }
  }
  return Object.freeze({
    list: () => [...map.values()].map(clone),
    get: (id) => {
      if (typeof id !== "string") return null;
      const item = map.get(id.trim());
      return item ? clone(item) : null;
    },
    has: (id) => typeof id === "string" && map.has(id.trim()),
  });
}

const DEFAULT_REGISTRY = createAgentManifestRegistry();

export function listAgentManifests() {
  return DEFAULT_REGISTRY.list();
}

export function getAgentManifest(id) {
  return DEFAULT_REGISTRY.get(id);
}
