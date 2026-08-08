import { validateToolInvocation } from "./contracts.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { evaluatePolicy } from "./policy.js";

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;

const HELP = "可用：客户查询、拜访记录、实付凭证、发票、报销周汇总、销售周报。涉及写入或财务操作需要明确确认。";

function clean(value) { return String(value ?? "").trim(); }

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

function explicitPlan(command, args, registry, { mediaRef } = {}) {
  const normalized = command.replace(/^\//, "");
  if (normalized === "help" || normalized === "帮助" || normalized === "h") return { kind: "intent_plan", status: "help", toolName: null, agentId: "system-router", arguments: {}, message: HELP };
  if (normalized === "cancel" || normalized === "取消") return { kind: "intent_plan", status: "cancelled", toolName: null, agentId: "system-router", arguments: {} };
  const direct = registry.getTool(normalized);
  if (direct) {
    const input = normalized === "customer.search"
      ? { query: args }
      : normalized.includes("report.preview")
        ? (reportArguments(args) ?? {})
        : normalized === "visit-capture.collect"
          ? { text: args }
          : normalized === "visit-capture.preview" || normalized === "visit-capture.confirm"
            ? { draftId: args }
        : normalized === "invoice.ingest"
          ? { mediaRef: args || mediaRef }
          : normalized === "payment-proof.ingest"
            ? { mediaRef: args || mediaRef }
            : { text: args, draftId: args };
    return makePlan({ tool: direct, arguments: input, source: "explicit" });
  }
  const aliases = {
    客户: ["customer.search", (value) => ({ query: value })],
    "客户查询": ["customer.search", (value) => ({ query: value })],
    拜访: ["visit-capture.collect", (value) => ({ text: value })],
    "拜访预览": ["visit-capture.preview", (value) => ({ draftId: value })],
    "拜访确认": ["visit-capture.confirm", (value) => ({ draftId: value })],
    付款凭证: ["payment-proof.ingest", (value) => ({ mediaRef: value || mediaRef })],
    发票: ["invoice.ingest", (value) => ({ mediaRef: value || mediaRef })],
    报销周报: ["reimbursement-report.preview", reportArguments],
    报销周汇总: ["reimbursement-report.preview", reportArguments],
    销售周报: ["sales-report.preview", reportArguments],
  };
  const alias = aliases[normalized];
  if (!alias) return null;
  const tool = registry.getTool(alias[0]);
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", 1);
  const parsed = alias[1](args);
  if (!parsed) return clarify("请提供完整的开始日期和结束日期。", 1);
  return makePlan({ tool, arguments: parsed, source: "explicit" });
}

function naturalPlan(text, confidence, registry) {
  const value = clean(text);
  if (/销售周报/.test(value)) {
    return makePlan({ tool: registry.getTool("sales-report.preview"), arguments: { week: "current" }, confidence, source: "natural" });
  }
  if (/报销(?:周报|周汇总)/.test(value)) {
    return makePlan({ tool: registry.getTool("reimbursement-report.preview"), arguments: { week: "current" }, confidence, source: "natural" });
  }
  if (/周报|周汇总/.test(value)) return clarify("你要生成销售周报，还是报销周汇总？", confidence);
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
      return naturalPlan(text, confidence, registry);
    },
  });
}

export function routeAssistantMessage(input, options) {
  return createAssistantRouter(options).route(input);
}
