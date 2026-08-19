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
  capability({
    id: "system-router",
    name: "助手路由与安全门禁",
    description: "识别固定 Agent 意图、处理帮助/取消/确认并在歧义时澄清；不直接执行业务写入。",
    status: "ready",
    mappings: { tools: [], apis: [] },
    dependencies: ["versioned agent manifest registry", "deterministic assistant router", "tool policy"],
    integrationPoints: ["assistant router", "assistant orchestrator"],
    confirmationLevel: "none",
    sourceRefs: ["agentRegistry:system-router", "assistant/router.js", "assistant/policy.js"],
  }),
  capability({
    id: "payment-proof",
    name: "实付凭证识别",
    description: "接收原始图片或 PDF 并生成脱敏识别复核预览；正式关联、拒绝或删除仍需本人确认。",
    status: "ready",
    mappings: {
      tools: ["payment-proof.ingest"],
      apis: ["POST /api/travel-expense-document-inbox", "GET /api/travel-expense-document-inbox"],
    },
    dependencies: ["lossless document inbox", "redacted payment-proof-v1 adapter", "owner-scoped review"],
    integrationPoints: ["assistant runtime handlers", "travel-expense document inbox API"],
    confirmationLevel: "explicit",
    sourceRefs: ["agentRegistry:payment-proof", "toolRegistry:payment-proof.ingest", "paymentProofAssistantAdapter.js"],
  }),
  capability({
    id: "invoice",
    name: "发票识别与复核",
    description: "接收原始发票并生成脱敏识别预览；匹配、无票确认和删除必须由本人确认。",
    status: "ready",
    mappings: {
      tools: ["invoice.ingest"],
      apis: ["POST /api/invoices", "GET /api/invoices"],
    },
    dependencies: ["lossless invoice repository", "redacted invoice-v1 adapter", "owner-scoped review"],
    integrationPoints: ["assistant runtime handlers", "invoice API"],
    confirmationLevel: "explicit",
    sourceRefs: ["agentRegistry:invoice", "toolRegistry:invoice.ingest", "invoiceAssistantAdapter.js"],
  }),
  capability({
    id: "advance-settlement",
    name: "请款事实与结算准备",
    description: "只读预览 owner-scoped 请款申请、到账、状态和来源；完整费用结算证据与应退/应补方向尚未开放。",
    status: "partial",
    mappings: { tools: [], apis: ["GET /api/travel-expense-advances"] },
    dependencies: ["advance-settlement-v1 draft adapter", "travel expense advance repository", "settlement evidence contract"],
    integrationPoints: ["assistant agent manifest", "advanceSettlementAssistantAdapter.js"],
    confirmationLevel: "preview",
    unavailableReason: "当前仍为 draft：不计算差额，不生成应退/应补方向，不注册工具，也不执行写入。",
    sourceRefs: ["agentRegistry:advance-settlement", "advanceSettlementAssistantAdapter.js", "GET /api/travel-expense-advances"],
  }),
  capability({
    id: "solution",
    name: "方案草稿",
    description: "预留基于客户、商机、知识和会议证据的方案与会前大纲能力。",
    status: "disabled",
    mappings: { tools: [], apis: [] },
    dependencies: ["approved solution data boundary", "solution-v1 manifest", "explicit writeback policy"],
    integrationPoints: ["assistant agent manifest"],
    confirmationLevel: "preview",
    unavailableReason: "功能开关关闭；当前不会调用 Agent 工具、读取未授权材料或生成正式方案。",
    sourceRefs: ["agentRegistry:solution", "agentManifest:solution-v1"],
  }),
  capability({
    id: "personal-finance",
    name: "个人财务助手",
    description: "预留个人总账、现金流和预算分析能力。",
    status: "disabled",
    mappings: { tools: [], apis: [] },
    dependencies: ["approved personal ledger boundary", "personal-finance-v1 manifest", "explicit writeback policy"],
    integrationPoints: ["assistant agent manifest"],
    confirmationLevel: "preview",
    unavailableReason: "个人财务数据边界和权限尚未批准；当前不会读取或创建个人财务记录。",
    sourceRefs: ["agentRegistry:personal-finance", "agentManifest:personal-finance-v1"],
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
