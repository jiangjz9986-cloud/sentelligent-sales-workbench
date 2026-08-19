import { validateToolInvocation } from "./contracts.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { evaluatePolicy } from "./policy.js";

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;

const HELP = "可用：战情总览、客户查询与详情、商机详情与项目分析、拜访记录、动作风险、行程摘要、差旅与报销汇总、请款结算预览、知识检索、销售周报。涉及写入或财务操作需要明确确认。";

function clean(value) { return String(value ?? "").trim(); }

function contextIdentifier(value) {
  const normalized = clean(value);
  return normalized && normalized.length <= 200 && !normalized.startsWith("synthetic:")
    && /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function conversationContext(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const context = value.context && typeof value.context === "object" && !Array.isArray(value.context)
    ? value.context
    : {};
  return {
    customerId: contextIdentifier(context.customerId),
    opportunityId: contextIdentifier(context.opportunityId),
  };
}

function parseExplicit(text) {
  const match = clean(text).match(/^\/([^\s]+)\s*(.*)$/s);
  return match ? { command: match[1].toLowerCase(), args: match[2].trim() } : null;
}

function makePlan({ tool, arguments: args, confidence = 1, confirmed = false, source = "explicit" }) {
  const missing = Object.entries(tool.arguments ?? {})
    .filter(([name, schema]) => schema?.required && (args?.[name] === undefined || args?.[name] === null || String(args[name]).trim() === ""))
    .map(([name]) => name);
  if (missing.length > 0) return clarify(`请补充必要参数：${missing.join("、")}。`, confidence);
  const invocation = validateToolInvocation({ agentId: tool.agentId, toolName: tool.name, arguments: args });
  const policy = evaluatePolicy({ toolName: tool.name, confirmed });
  if (!policy.allowed) return { kind: "intent_plan", status: "denied", toolName: tool.name, agentId: tool.agentId, risk: policy.risk, confirmation: policy.confirmation, reason: policy.reason, arguments: invocation.arguments, confidence, source };
  return {
    kind: "intent_plan",
    status: policy.requiresConfirmation ? "confirmation_required" : "planned",
    agentId: tool.agentId,
    toolName: tool.name,
    arguments: invocation.arguments,
    risk: policy.risk,
    confirmation: policy.confirmation,
    requiresConfirmation: policy.requiresConfirmation,
    confirmed: Boolean(confirmed),
    confidence,
    source,
  };
}

function unknown(confidence, reason = "no_registered_intent") {
  return { kind: "intent_plan", status: "unknown", toolName: null, agentId: null, arguments: {}, confidence, reason };
}

function clarify(question, confidence = 0) {
  return { kind: "intent_plan", status: "clarify", toolName: null, agentId: "system-router", arguments: {}, confidence, question };
}

function dateRange(args) {
  const [periodStart, periodEnd] = args.split(/\s+|至|到/).filter(Boolean);
  if (!periodStart || !periodEnd) return null;
  return { periodStart, periodEnd };
}

function reportArguments(args) {
  if (!clean(args)) return { week: "current" };
  return dateRange(args);
}

function directArguments(toolName, args, mediaRef, context = {}) {
  if (toolName === "dashboard.summary" || toolName === "itinerary.summary") return {};
  if (toolName === "customer.search" || toolName === "knowledge.search") return { query: args };
  if (toolName === "customer.detail") return { customerId: clean(args) || context.customerId || "" };
  if (toolName === "opportunity.detail" || toolName === "sales-decision.preview") {
    return { opportunityId: clean(args) || context.opportunityId || "" };
  }
  if (toolName === "action-risk.summary") return {
    ...(clean(args) ? { customerId: clean(args) } : {}),
    ...(!clean(args) && context.opportunityId ? { opportunityId: context.opportunityId } : {}),
    ...(!clean(args) && !context.opportunityId && context.customerId ? { customerId: context.customerId } : {}),
  };
  if (toolName === "travel-expense.summary") return { week: clean(args) || "current" };
  if (toolName === "advance-settlement.preview") return { week: clean(args) || "current" };
  if (toolName.includes("report.preview")) return reportArguments(args) ?? {};
  if (toolName === "visit-capture.collect") return { text: args };
  if (toolName === "visit-capture.preview" || toolName === "visit-capture.confirm") return { draftId: args };
  if (toolName === "invoice.ingest" || toolName === "payment-proof.ingest") return { mediaRef: args || mediaRef };
  return {};
}

function explicitPlan(command, args, registry, { mediaRef, context: rawContext } = {}) {
  const context = conversationContext({ context: rawContext });
  const normalized = command.replace(/^\//, "");
  if (normalized === "help" || normalized === "帮助" || normalized === "h") return { kind: "intent_plan", status: "help", toolName: null, agentId: "system-router", arguments: {}, message: HELP };
  if (normalized === "cancel" || normalized === "取消") return { kind: "intent_plan", status: "cancelled", toolName: null, agentId: "system-router", arguments: {} };
  const direct = registry.getTool(normalized);
  if (direct) {
    const input = directArguments(normalized, args, mediaRef, context);
    return makePlan({ tool: direct, arguments: input, source: "explicit" });
  }
  const aliases = {
    战情: ["dashboard.summary", () => ({})],
    战情总览: ["dashboard.summary", () => ({})],
    客户: ["customer.search", (value) => ({ query: value })],
    "客户查询": ["customer.search", (value) => ({ query: value })],
    "客户详情": ["customer.detail", (value) => ({ customerId: value })],
    "商机详情": ["opportunity.detail", (value) => ({ opportunityId: value })],
    "项目分析": ["sales-decision.preview", (value) => ({ opportunityId: value })],
    "动作风险": ["action-risk.summary", () => ({})],
    "行程摘要": ["itinerary.summary", () => ({})],
    "差旅汇总": ["travel-expense.summary", (value) => ({ week: clean(value) || "current" })],
    "知识检索": ["knowledge.search", (value) => ({ query: value })],
    拜访: ["visit-capture.collect", (value) => ({ text: value })],
    "拜访预览": ["visit-capture.preview", (value) => ({ draftId: value })],
    "拜访确认": ["visit-capture.confirm", (value) => ({ draftId: value })],
    付款凭证: ["payment-proof.ingest", (value) => ({ mediaRef: value || mediaRef })],
    发票: ["invoice.ingest", (value) => ({ mediaRef: value || mediaRef })],
    报销周报: ["reimbursement-report.preview", reportArguments],
    报销周汇总: ["reimbursement-report.preview", reportArguments],
    请款结算: ["advance-settlement.preview", (value) => ({ week: clean(value) || "current" })],
    请款汇总: ["advance-settlement.preview", (value) => ({ week: clean(value) || "current" })],
    多退少补: ["advance-settlement.preview", (value) => ({ week: clean(value) || "current" })],
    销售周报: ["sales-report.preview", reportArguments],
  };
  const alias = aliases[normalized];
  if (!alias) return null;
  const tool = registry.getTool(alias[0]);
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", 1);
  const parsed = alias[1](args);
  if (!parsed) return clarify("请提供完整的开始日期和结束日期。", 1);
  if (alias[0] === "customer.detail" && !clean(parsed.customerId)) parsed.customerId = context.customerId ?? "";
  if ((alias[0] === "opportunity.detail" || alias[0] === "sales-decision.preview") && !clean(parsed.opportunityId)) {
    parsed.opportunityId = context.opportunityId ?? "";
  }
  if (alias[0] === "action-risk.summary" && Object.keys(parsed).length === 0) {
    if (context.opportunityId) parsed.opportunityId = context.opportunityId;
    else if (context.customerId) parsed.customerId = context.customerId;
  }
  return makePlan({ tool, arguments: parsed, source: "explicit" });
}

function naturalPlan(text, confidence, registry, rawContext = {}) {
  const value = clean(text);
  const context = conversationContext({ context: rawContext });
  if (/销售周报/.test(value)) {
    return makePlan({ tool: registry.getTool("sales-report.preview"), arguments: { week: "current" }, confidence, source: "natural" });
  }
  if (/报销(?:周报|周汇总)/.test(value)) {
    return makePlan({ tool: registry.getTool("reimbursement-report.preview"), arguments: { week: "current" }, confidence, source: "natural" });
  }
  const settlementPreview = value.match(/^(?:请款(?:结算|汇总)?|多退少补)(?:\s+(.+))?$/u);
  if (settlementPreview) {
    return makePlan({
      tool: registry.getTool("advance-settlement.preview"),
      arguments: { week: settlementPreview[1] ?? "current" },
      confidence,
      source: "natural",
    });
  }
  if (/周报|周汇总/.test(value)) return clarify("你要生成销售周报，还是报销周汇总？", confidence);
  if (/^(?:战情(?:总览)?|工作台总览)$/u.test(value)) {
    return makePlan({ tool: registry.getTool("dashboard.summary"), arguments: {}, confidence, source: "natural" });
  }
  const customerDetail = value.match(/^客户详情(?:\s+(.+))?$/u);
  if (customerDetail) {
    return makePlan({
      tool: registry.getTool("customer.detail"),
      arguments: { customerId: customerDetail[1] ?? context.customerId ?? "" },
      confidence,
      source: "natural",
    });
  }
  const opportunityDetail = value.match(/^商机详情(?:\s+(.+))?$/u);
  if (opportunityDetail) {
    return makePlan({
      tool: registry.getTool("opportunity.detail"),
      arguments: { opportunityId: opportunityDetail[1] ?? context.opportunityId ?? "" },
      confidence,
      source: "natural",
    });
  }
  const projectAnalysis = value.match(/^项目分析(?:\s+(.+))?$/u);
  if (projectAnalysis) {
    if (!projectAnalysis[1] && !context.opportunityId && context.customerId) {
      return clarify("当前客户未指定商机，请补充商机名称或标识。", confidence);
    }
    return makePlan({
      tool: registry.getTool("sales-decision.preview"),
      arguments: { opportunityId: projectAnalysis[1] ?? context.opportunityId ?? "" },
      confidence,
      source: "natural",
    });
  }
  if (/^(?:动作风险|行动风险|风险动作)(?:摘要)?$/u.test(value)) {
    return makePlan({
      tool: registry.getTool("action-risk.summary"),
      arguments: context.opportunityId ? { opportunityId: context.opportunityId } : (context.customerId ? { customerId: context.customerId } : {}),
      confidence,
      source: "natural",
    });
  }
  const followUpText = value.replace(/[？?。.!！]+$/u, "");
  if (/^(?:(?:这个|当前|该)?(?:项目|商机|客户)?(?:还有哪些|还有|有哪些|有什么|当前有哪些)?(?:跟进动作|待办|行动|风险|下一步))$/u.test(followUpText)) {
    return makePlan({
      tool: registry.getTool("action-risk.summary"),
      arguments: context.opportunityId ? { opportunityId: context.opportunityId } : (context.customerId ? { customerId: context.customerId } : {}),
      confidence,
      source: "natural",
    });
  }
  if (/^(?:行程|行程摘要|拜访行程)$/u.test(value)) {
    return makePlan({ tool: registry.getTool("itinerary.summary"), arguments: {}, confidence, source: "natural" });
  }
  if (/^(?:差旅汇总|差旅费用(?:摘要|汇总)?)$/u.test(value)) {
    return makePlan({
      tool: registry.getTool("travel-expense.summary"),
      arguments: { week: "current" },
      confidence,
      source: "natural",
    });
  }
  const knowledgeSearch = value.match(/^知识(?:检索|查询)(?:\s+(.+))?$/u);
  if (knowledgeSearch) {
    return makePlan({
      tool: registry.getTool("knowledge.search"),
      arguments: { query: knowledgeSearch[1] ?? "" },
      confidence,
      source: "natural",
    });
  }
  if (value === "记录") {
    return makePlan({
      tool: registry.getTool("visit-capture.preview"),
      arguments: { draftId: "current" },
      confidence,
      source: "explicit",
    });
  }
  if (value === "录入") {
    return makePlan({
      tool: registry.getTool("visit-capture.confirm"),
      arguments: { draftId: "current" },
      confidence,
      source: "explicit",
    });
  }
  const customer = value.match(/^(?:客户|查询客户)\s+(.+)$/);
  if (customer) {
    const tool = registry.getTool("customer.search");
    return makePlan({ tool, arguments: { query: customer[1] }, confidence, source: "natural" });
  }
  if (/(拜访|拜会|电话|会议|沟通|走访|客户现场)/u.test(value)) {
    return makePlan({
      tool: registry.getTool("visit-capture.collect"),
      arguments: { text: value },
      confidence,
      source: "natural",
    });
  }
  return unknown(confidence);
}

export function createAssistantRouter({ registry = createAgentRegistry(), confidenceThreshold = ROUTER_CONFIDENCE_THRESHOLD } = {}) {
  return Object.freeze({
    route(input = {}) {
      const text = clean(input.text);
      const explicit = parseExplicit(text);
      const plainCommand = text.toLowerCase();
      if (["帮助", "help"].includes(plainCommand)) {
        return explicitPlan("帮助", "", registry, input);
      }
      if (["取消", "cancel"].includes(plainCommand)) {
        return explicitPlan("取消", "", registry, input);
      }
      if (["确认", "confirm"].includes(plainCommand)) {
        const pending = input.pendingPlan;
        if (!pending || pending.status !== "confirmation_required" || !pending.toolName) return clarify("当前没有待确认的操作。", 1);
        const tool = registry.getTool(pending.toolName);
        if (!tool) return unknown(1, "tool_not_registered");
        return makePlan({ tool, arguments: pending.arguments ?? {}, confidence: pending.confidence ?? 1, confirmed: true, source: "confirmation" });
      }
      if (explicit) {
        if (explicit.command === "confirm" || explicit.command === "确认") {
          const pending = input.pendingPlan;
          if (!pending || pending.status !== "confirmation_required" || !pending.toolName) return clarify("当前没有待确认的操作。", 1);
          const tool = registry.getTool(pending.toolName);
          if (!tool) return unknown(1, "tool_not_registered");
          return makePlan({ tool, arguments: pending.arguments ?? {}, confidence: pending.confidence ?? 1, confirmed: true, source: "confirmation" });
        }
        return explicitPlan(explicit.command, explicit.args, registry, input) ?? unknown(1, "unknown_explicit_command");
      }
      const confidence = input.confidence === undefined ? 1 : Number(input.confidence);
      if (confidence < confidenceThreshold) return clarify("我不确定你的意图，请使用明确命令或补充说明。", confidence);
      if (input.mediaRef && ["发票", "付款凭证"].includes(text)) {
        return explicitPlan(text, "", registry, input);
      }
      return naturalPlan(text, confidence, registry, conversationContext(input));
    },
  });
}

export function routeAssistantMessage(input, options) {
  return createAssistantRouter(options).route(input);
}
