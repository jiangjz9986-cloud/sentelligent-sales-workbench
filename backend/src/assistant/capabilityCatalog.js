const CAPABILITY_STATUSES = new Set(["ready", "partial", "planned", "disabled"]);
const CONFIRMATION_LEVELS = new Set(["none", "preview", "explicit"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function capability({
  id,
  name,
  description,
  status,
  mappings,
  dependencies,
  integrationPoints,
  confirmationLevel,
  unavailableReason = null,
  sourceRefs = [],
}) {
  if (!CAPABILITY_STATUSES.has(status)) throw new TypeError(`invalid capability status: ${status}`);
  if (!CONFIRMATION_LEVELS.has(confirmationLevel)) {
    throw new TypeError(`invalid confirmation level: ${confirmationLevel}`);
  }
  return {
    id,
    name,
    capability: description,
    description,
    status,
    readiness: status,
    readinessReason: unavailableReason,
    mappings: {
      tools: [...(mappings?.tools ?? [])],
      apis: [...(mappings?.apis ?? [])],
    },
    wiring: {
      dependencies: [...dependencies],
      integrationPoints: [...integrationPoints],
    },
    confirmationLevel,
    confirmation: {
      level: confirmationLevel,
      required: confirmationLevel === "explicit",
    },
    unavailableReason,
    sourceRefs: [...sourceRefs],
  };
}

// This is descriptive product metadata only. Executable agent/tool definitions
// remain owned by agentRegistry, toolRegistry, policy, and router.
export const CAPABILITY_CATALOG = deepFreeze([
  capability({
    id: "dashboard",
    name: "工作台总览",
    description: "汇总经认证保护的客户、商机、待办和风险摘要。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/dashboard/summary"] },
    dependencies: ["dashboard summary API", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.dashboard", "server dashboard summary"],
    confirmationLevel: "none",
    unavailableReason: "当前助手目录尚未注册独立 dashboard 查询工具。",
    sourceRefs: ["agentRegistry:dashboard", "server:/api/dashboard/summary"],
  }),
  capability({
    id: "customer.search",
    name: "客户搜索",
    description: "按关键词查询受认证保护的客户资料。",
    status: "ready",
    mappings: { tools: ["customer.search"], apis: ["GET /api/customers"] },
    dependencies: ["customer assistant agent", "customer.search tool", "authenticated customer query"],
    integrationPoints: ["assistant router", "assistant runtime handlers"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:customer", "toolRegistry:customer.search"],
  }),
  capability({
    id: "customer.detail",
    name: "客户详情",
    description: "查看一个客户的基本资料、关联商机和可见业务证据。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/customers/:id"] },
    dependencies: ["authenticated customer detail API", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.customer", "server customer API"],
    confirmationLevel: "none",
    unavailableReason: "客户详情 API 存在，但尚未接入独立微信助手工具。",
    sourceRefs: ["agentRegistry:customer"],
  }),
  capability({
    id: "opportunity.detail",
    name: "商机详情",
    description: "查看商机阶段、金额、概率、下一步和关联客户。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/opportunities/:id"] },
    dependencies: ["authenticated opportunity query", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.opportunity", "server opportunity API"],
    confirmationLevel: "none",
    unavailableReason: "商机详情尚未注册为微信助手可调用工具。",
    sourceRefs: ["agentRegistry:opportunity"],
  }),
  capability({
    id: "visit-capture",
    name: "拜访记录采集",
    description: "把拜访、电话或会议内容整理为草稿，预览后由本人确认写入。",
    status: "ready",
    mappings: {
      tools: ["visit-capture.collect", "visit-capture.preview", "visit-capture.confirm"],
      apis: ["POST /api/quick-records/preview"],
    },
    dependencies: ["visit-capture agent", "quick-record persistence", "human confirmation gate"],
    integrationPoints: ["assistant router", "assistant orchestrator", "quick-record API"],
    confirmationLevel: "explicit",
    sourceRefs: ["agentRegistry:visit-capture", "toolRegistry:visit-capture.confirm"],
  }),
  capability({
    id: "travel-expense.summary",
    name: "差旅费用摘要",
    description: "按自然周汇总已记录的差旅费用、实付和可报销金额。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/travel-expenses"] },
    dependencies: ["travel-expense repository", "owner-scoped expense query", "natural-week period"],
    integrationPoints: ["assistant agentRegistry.travel-expense", "travel expense API"],
    confirmationLevel: "none",
    unavailableReason: "费用账本 API 已存在，但助手尚未接入独立摘要工具。",
    sourceRefs: ["agentRegistry:travel-expense"],
  }),
  capability({
    id: "reimbursement-report",
    name: "报销周汇总",
    description: "预览自然周实付、缺票和报销准备信息，不修改费用或公司规则。",
    status: "ready",
    mappings: {
      tools: ["reimbursement-report.preview"],
      apis: ["GET /api/travel-expenses"],
    },
    dependencies: ["reimbursement-report agent", "natural-week aggregation", "read-only report handler"],
    integrationPoints: ["assistant router", "assistant runtime handlers"],
    confirmationLevel: "preview",
    sourceRefs: ["agentRegistry:reimbursement-report", "toolRegistry:reimbursement-report.preview"],
  }),
  capability({
    id: "sales-decision.preview",
    name: "销售决策预览",
    description: "基于限界证据生成销售诊断，区分事实、推断、未知和需要确认的下一步。",
    status: "partial",
    mappings: { tools: [], apis: ["POST /api/ai/sales-decisions"] },
    dependencies: ["sales-decision agent", "bounded project snapshot", "human confirmation for writeback"],
    integrationPoints: ["assistant agentRegistry.sales-decision", "sales decision API"],
    confirmationLevel: "preview",
    unavailableReason: "销售决策分析 API 已存在，但尚未接入微信助手独立预览工具。",
    sourceRefs: ["agentRegistry:sales-decision"],
  }),
  capability({
    id: "sales-report",
    name: "销售周报",
    description: "按自然周生成带证据引用的销售业务周报预览。",
    status: "ready",
    mappings: {
      tools: ["sales-report.preview"],
      apis: [],
    },
    dependencies: ["sales-report agent", "weekly report draft", "source reference preservation"],
    integrationPoints: ["assistant router", "assistant runtime handlers"],
    confirmationLevel: "preview",
    sourceRefs: ["agentRegistry:sales-report", "toolRegistry:sales-report.preview"],
  }),
  capability({
    id: "action-risk",
    name: "行动与风险",
    description: "汇总未完成行动和活跃风险，并提供可追溯的处理建议。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/actions", "GET /api/risks"] },
    dependencies: ["authenticated action query", "authenticated risk query", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.action-risk", "action/risk APIs"],
    confirmationLevel: "preview",
    unavailableReason: "行动和风险查询尚未接入独立微信助手工具。",
    sourceRefs: ["agentRegistry:action-risk"],
  }),
  capability({
    id: "knowledge.search",
    name: "知识检索",
    description: "只读检索知识条目并保留来源，不执行知识写入。",
    status: "partial",
    mappings: { tools: [], apis: ["POST /api/knowledge/search"] },
    dependencies: ["authenticated knowledge query", "source reference preservation", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.knowledge", "knowledge API"],
    confirmationLevel: "none",
    unavailableReason: "知识查询 API 已存在，但助手尚未注册独立检索工具。",
    sourceRefs: ["agentRegistry:knowledge"],
  }),
]);

const CAPABILITY_BY_ID = new Map(CAPABILITY_CATALOG.map((item) => [item.id, item]));

export function listCapabilities(options = {}) {
  const filter = options && typeof options === "object" ? options : {};
  const status = typeof filter.status === "string" ? filter.status : null;
  const readiness = typeof filter.readiness === "string" ? filter.readiness : null;
  return CAPABILITY_CATALOG
    .filter((item) => (!status || item.status === status) && (!readiness || item.readiness === readiness))
    .map(clone);
}

export function getCapability(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  const item = CAPABILITY_BY_ID.get(id.trim());
  return item ? clone(item) : null;
}

export function hasCapability(id) {
  return typeof id === "string" && CAPABILITY_BY_ID.has(id.trim());
}

export function getCapabilityCatalog() {
  return listCapabilities();
}
