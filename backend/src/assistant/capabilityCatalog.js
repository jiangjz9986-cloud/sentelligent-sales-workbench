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
    status: "ready",
    mappings: { tools: ["dashboard.summary"], apis: ["GET /api/dashboard/summary"] },
    dependencies: ["bounded business snapshot adapter", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.dashboard", "assistant runtime handlers"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:dashboard", "toolRegistry:dashboard.summary"],
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
    description: "查看一个客户的限界基本资料。",
    status: "ready",
    mappings: { tools: ["customer.detail"], apis: ["GET /api/customers/:id"] },
    dependencies: ["owner-bounded customer snapshot", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.customer", "assistant runtime handlers"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:customer", "toolRegistry:customer.detail"],
  }),
  capability({
    id: "opportunity.detail",
    name: "商机详情",
    description: "查看商机阶段、金额、概率、下一步和关联客户。",
    status: "ready",
    mappings: { tools: ["opportunity.detail"], apis: ["GET /api/opportunities/:id"] },
    dependencies: ["owner-bounded opportunity snapshot", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.opportunity", "assistant runtime handlers"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:opportunity", "toolRegistry:opportunity.detail"],
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
    status: "ready",
    mappings: { tools: ["travel-expense.summary"], apis: ["GET /api/travel-expenses"] },
    dependencies: ["travel-expense repository", "owner-scoped expense query", "natural-week period"],
    integrationPoints: ["assistant agentRegistry.travel-expense", "travel expense API"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:travel-expense", "toolRegistry:travel-expense.summary"],
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
    description: "基于 owner-scoped 客户、商机、拜访、行动、风险和知识快照调用 sales-decision-v1，区分事实、推断、未知和需要确认的下一步。",
    status: "ready",
    mappings: { tools: ["sales-decision.preview"], apis: ["POST /api/ai/sales-decisions"] },
    dependencies: ["bounded sales loop snapshot", "versioned agent run record", "human confirmation for writeback"],
    integrationPoints: ["assistant agentRegistry.sales-decision", "sales decision API"],
    confirmationLevel: "preview",
    sourceRefs: ["agentRegistry:sales-decision", "toolRegistry:sales-decision.preview", "salesLoopPreview:sales-decision-v1", "assistant_agent_runs"],
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
    description: "汇总未完成行动和活跃风险，保留来源标识供后续处理。",
    status: "ready",
    mappings: { tools: ["action-risk.summary"], apis: ["GET /api/actions", "GET /api/risks"] },
    dependencies: ["authenticated action query", "authenticated risk query", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.action-risk", "action/risk APIs"],
    confirmationLevel: "preview",
    sourceRefs: ["agentRegistry:action-risk", "toolRegistry:action-risk.summary"],
  }),
  capability({
    id: "itinerary.summary",
    name: "行程摘要",
    description: "查询当前账号创建的拜访行程及执行状态。",
    status: "ready",
    mappings: { tools: ["itinerary.summary"], apis: ["GET /api/itineraries"] },
    dependencies: ["owner-bounded itinerary snapshot", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.itinerary", "assistant runtime handlers"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:itinerary", "toolRegistry:itinerary.summary"],
  }),
  capability({
    id: "knowledge.search",
    name: "知识检索",
    description: "只读检索知识条目并保留来源，不执行知识写入。",
    status: "ready",
    mappings: { tools: ["knowledge.search"], apis: ["POST /api/knowledge/search"] },
    dependencies: ["shared knowledge metadata query (knowledge_items has no owner field)", "source reference preservation", "read-only assistant route"],
    integrationPoints: ["assistant agentRegistry.knowledge", "knowledge API"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:knowledge", "toolRegistry:knowledge.search"],
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
