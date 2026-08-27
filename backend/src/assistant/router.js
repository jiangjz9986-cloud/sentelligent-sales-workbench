import { validateToolInvocation } from "./contracts.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { evaluatePolicy } from "./policy.js";

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;

const HELP = "可用：战情总览、客户查询与详情、记支出/收入、发送付款凭证或发票、拜访记录、动作风险、行程摘要、差旅与报销汇总、请款结算预览、知识检索、销售周报。财务写入会先发送待确认信息；请款结算仅供核对。";

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

const CUSTOMER_FIELD_KEYS = Object.freeze({
  名称: "name",
  区域: "region",
  类型: "type",
  级别: "level",
  联系人: "contact",
  预算: "budget",
  摘要: "summary",
  备注: "summary",
  别名: "aliases",
  标签: "tags",
});
const CUSTOMER_ARRAY_FIELDS = new Set(["aliases", "tags"]);
const CUSTOMER_FIELD_HELP = "可改：名称/区域/类型/级别/联系人/预算/摘要/别名/标签";
const CUSTOMER_SEGMENT_RE = /^(名称|区域|类型|级别|联系人|预算|摘要|备注|别名|标签)\s*[:：为是]?\s*(.+)$/u;
const CUSTOMER_CLAUSE_VERB_RE = /^(?:再|又|并且?|顺便)?\s*(加|添加|新增|移除|去掉|删除)(?:一个|个)?(别名|标签)\s*[:：]?\s*(.+)$/u;
const CUSTOMER_PRONOUN_RE = /^(?:它|这个客户|该客户|当前客户)$/u;

function splitCustomerSegments(text) {
  return String(text ?? "").split(/[，,；;]/u).map((part) => part.trim()).filter(Boolean);
}

function splitCustomerListValue(value) {
  return String(value ?? "").split(/[、/]/u).map((part) => part.trim()).filter(Boolean);
}

function assignCustomerArrayChange(changes, field, patch) {
  const current = changes[field];
  if (Array.isArray(current)) return false;
  if (Array.isArray(patch)) {
    if (current !== undefined) return false;
    changes[field] = patch;
    return true;
  }
  const merged = current && typeof current === "object" ? current : { add: [], remove: [] };
  for (const item of patch.add ?? []) if (!merged.add.includes(item)) merged.add.push(item);
  for (const item of patch.remove ?? []) if (!merged.remove.includes(item)) merged.remove.push(item);
  changes[field] = merged;
  return true;
}

function applyCustomerSegment(changes, segment) {
  const keyed = segment.match(CUSTOMER_SEGMENT_RE);
  if (keyed) {
    const field = CUSTOMER_FIELD_KEYS[keyed[1]];
    const value = keyed[2].trim();
    if (!value) return { ok: false, unknown: keyed[1] };
    if (CUSTOMER_ARRAY_FIELDS.has(field)) {
      return assignCustomerArrayChange(changes, field, splitCustomerListValue(value))
        ? { ok: true }
        : { ok: false, conflict: keyed[1] };
    }
    if (changes[field] !== undefined) return { ok: false, conflict: keyed[1] };
    changes[field] = value;
    return { ok: true };
  }
  const verb = segment.match(CUSTOMER_CLAUSE_VERB_RE);
  if (verb) {
    const field = CUSTOMER_FIELD_KEYS[verb[2]];
    const items = splitCustomerListValue(verb[3]);
    if (items.length === 0) return { ok: false, unknown: verb[2] };
    const patch = ["加", "添加", "新增"].includes(verb[1]) ? { add: items } : { remove: items };
    return assignCustomerArrayChange(changes, field, patch)
      ? { ok: true }
      : { ok: false, conflict: verb[2] };
  }
  return { ok: false, unknown: segment };
}

function customerSegmentFailure(failure, confidence) {
  if (failure.conflict) {
    return clarify(`「${failure.conflict}」在同一条指令中出现了冲突的修改，请拆成两条指令。`, confidence);
  }
  return clarify(`暂不支持修改「${failure.unknown}」，${CUSTOMER_FIELD_HELP}。`, confidence);
}

function customerWriteTarget(target, context) {
  const normalized = clean(target);
  if (CUSTOMER_PRONOUN_RE.test(normalized)) {
    return context.customerId ? { customerId: context.customerId } : null;
  }
  if (!normalized || normalized.length > 200) return null;
  return { query: normalized };
}

function customerCreatePlan(payload, registry, confidence) {
  const tool = registry.getTool("customer.create");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const segments = splitCustomerSegments(payload);
  if (segments.length === 0) return clarify("请说明客户名称，例如“新建客户 莒县人民医院，区域日照”。", confidence);
  const changes = {};
  let name = null;
  for (const [index, segment] of segments.entries()) {
    const keyed = segment.match(CUSTOMER_SEGMENT_RE);
    if (!keyed && index === 0) {
      name = segment;
      continue;
    }
    const applied = applyCustomerSegment(changes, segment);
    if (!applied.ok) return customerSegmentFailure(applied, confidence);
  }
  if (changes.name) {
    if (name) return clarify("客户名称出现了两次，请只写一次。", confidence);
    name = changes.name;
    delete changes.name;
  }
  if (!name) return clarify("请说明客户名称，例如“新建客户 莒县人民医院，区域日照”。", confidence);
  const argumentsValue = { name, ...changes };
  for (const field of CUSTOMER_ARRAY_FIELDS) {
    if (argumentsValue[field] && !Array.isArray(argumentsValue[field])) {
      const merged = argumentsValue[field];
      argumentsValue[field] = merged.add ?? [];
    }
  }
  return makePlan({ tool, arguments: argumentsValue, confidence, source: "natural" });
}

function customerUpdatePlan(target, clauses, registry, confidence, context) {
  const tool = registry.getTool("customer.update");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const resolvedTarget = customerWriteTarget(target, context);
  if (!resolvedTarget) return clarify("请说明客户名称，例如“修改客户 莒县人民医院，级别A”。", confidence);
  const changes = {};
  const segments = Array.isArray(clauses) ? clauses : splitCustomerSegments(clauses);
  if (segments.length === 0) return clarify(`请说明要修改的内容，${CUSTOMER_FIELD_HELP}。`, confidence);
  for (const segment of segments) {
    const applied = applyCustomerSegment(changes, segment);
    if (!applied.ok) return customerSegmentFailure(applied, confidence);
  }
  if (Object.keys(changes).length === 0) return clarify(`请说明要修改的内容，${CUSTOMER_FIELD_HELP}。`, confidence);
  return makePlan({ tool, arguments: { ...resolvedTarget, changes }, confidence, source: "natural" });
}

function customerDeletePlan(target, registry, confidence, context) {
  const tool = registry.getTool("customer.delete");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const resolvedTarget = customerWriteTarget(target, context);
  if (!resolvedTarget) return clarify("请说明要删除的客户名称或 ID。", confidence);
  return makePlan({ tool, arguments: resolvedTarget, confidence, source: "natural" });
}

const CUSTOMER_WRITE_COMMAND_MODES = Object.freeze({
  "customer.create": "create",
  新建客户: "create",
  新增客户: "create",
  建档: "create",
  客户建档: "create",
  "customer.update": "update",
  修改客户: "update",
  更新客户: "update",
  改档: "update",
  客户改档: "update",
  "customer.delete": "delete",
  删除客户: "delete",
  删档: "delete",
  客户删档: "delete",
});

function customerWriteCommandPlan(mode, args, registry, context, confidence = 1) {
  const payload = clean(args).replace(/^[:：]\s*/u, "");
  if (mode === "create") return customerCreatePlan(payload, registry, confidence);
  if (mode === "delete") return customerDeletePlan(payload, registry, confidence, context);
  const segments = splitCustomerSegments(payload);
  const target = segments.shift() ?? "";
  return customerUpdatePlan(target, segments, registry, confidence, context);
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
  if (toolName === "bookkeeping.ingest") {
    return {
      ...(args ? { text: args } : {}),
      ...(mediaRef ? { mediaRef } : {}),
    };
  }
  return {};
}

function explicitPlan(command, args, registry, { mediaRef, context: rawContext } = {}) {
  const context = conversationContext({ context: rawContext });
  const normalized = command.replace(/^\//, "");
  if (normalized === "help" || normalized === "帮助" || normalized === "h") return { kind: "intent_plan", status: "help", toolName: null, agentId: "system-router", arguments: {}, message: HELP };
  if (normalized === "cancel" || normalized === "取消") return { kind: "intent_plan", status: "cancelled", toolName: null, agentId: "system-router", arguments: {} };
  if (Object.hasOwn(CUSTOMER_WRITE_COMMAND_MODES, normalized)) {
    return customerWriteCommandPlan(CUSTOMER_WRITE_COMMAND_MODES[normalized], args, registry, context);
  }
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
    记账: ["bookkeeping.ingest", (value) => ({ ...(value ? { text: value } : {}), ...(mediaRef ? { mediaRef } : {}) })],
    支出: ["bookkeeping.ingest", (value) => ({ text: value, ...(mediaRef ? { mediaRef } : {}) })],
    收入: ["bookkeeping.ingest", (value) => ({ text: value, ...(mediaRef ? { mediaRef } : {}) })],
    借款: ["bookkeeping.ingest", (value) => ({ text: value, ...(mediaRef ? { mediaRef } : {}) })],
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
  if (/^快捷记账(?:复核|确认)?$/u.test(value)) {
    return clarify("现在请直接把付款截图或记账文字发给小小，不再使用快捷指令；我会先发送待确认信息。", confidence);
  }
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
  if (/记账|支出|收入|借款到账/u.test(value)) {
    const tool = registry.getTool("bookkeeping.ingest");
    return tool
      ? makePlan({ tool, arguments: { text: value }, confidence, source: "natural" })
      : clarify("记账功能尚未开放，请稍后重试。", confidence);
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
  const customerCreate = value.match(/^(?:新建客户|新增客户|建档|客户建档)\s*[:：]?\s*(.+)$/u);
  if (customerCreate) {
    return customerCreatePlan(customerCreate[1], registry, confidence);
  }
  const customerUpdateExplicit = value.match(/^(?:修改客户|更新客户|改档|客户改档)\s*[:：]?\s*(.+)$/u);
  if (customerUpdateExplicit) {
    const segments = splitCustomerSegments(customerUpdateExplicit[1]);
    const target = segments.shift() ?? "";
    return customerUpdatePlan(target, segments, registry, confidence, context);
  }
  const customerDelete = value.match(/^(?:删除客户|删档|客户删档)\s*[:：]?\s*(.+)$/u);
  if (customerDelete) {
    return customerDeletePlan(customerDelete[1], registry, confidence, context);
  }
  const customerFieldChange = value.match(
    /^(?:把|将)?(.{1,60}?)的?(名称|区域|类型|级别|联系人|预算|摘要|备注|别名|标签)(?:改成|改为|设为|设置为|更新为|换成)\s*(.+)$/u,
  );
  if (customerFieldChange) {
    const [, subject, fieldLabel, remainder] = customerFieldChange;
    const clauses = splitCustomerSegments(remainder);
    const firstValue = clauses.shift() ?? "";
    return customerUpdatePlan(subject, [`${fieldLabel}：${firstValue}`, ...clauses], registry, confidence, context);
  }
  const customerArrayChange = value.match(
    /^(?:给|为)?(.{1,60}?)(加|添加|新增|移除|去掉|删除)(?:一个|个)?(别名|标签)\s*[:：]?\s*(.+)$/u,
  );
  if (customerArrayChange) {
    const [, subject, verb, kind, remainder] = customerArrayChange;
    const clauses = splitCustomerSegments(remainder);
    const firstValue = clauses.shift() ?? "";
    return customerUpdatePlan(subject, [`${verb}${kind} ${firstValue}`, ...clauses], registry, confidence, context);
  }
  const customer = value.match(/^(?:客户|查询客户)\s+(.+)$/);
  if (customer) {
    const tool = registry.getTool("customer.search");
    return makePlan({ tool, arguments: { query: customer[1] }, confidence, source: "natural" });
  }
  const bareSearch = value.match(/^查询\s*(.+)$/u);
  if (bareSearch) {
    const tool = registry.getTool("customer.search");
    return makePlan({ tool, arguments: { query: bareSearch[1] }, confidence, source: "natural" });
  }
  const customerProfile = value.match(
    /^(.{2,60}?)(?:的)?(?:什么情况|情况怎么样|情况如何|近况|画像|资料|档案)\s*[?？]?$/u,
  );
  if (customerProfile) {
    const subject = clean(customerProfile[1]);
    const excluded = /(?:项目|商机|报销|周报|记账|请款|发票|凭证|行程|差旅|风险|待办|知识)$/u.test(subject);
    if (!excluded) {
      const target = CUSTOMER_PRONOUN_RE.test(subject) ? context.customerId ?? "" : subject;
      return makePlan({
        tool: registry.getTool("customer.detail"),
        arguments: { customerId: target },
        confidence,
        source: "natural",
      });
    }
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
      if (input.mediaRef && !text) {
        const tool = registry.getTool("bookkeeping.ingest");
        if (tool) return makePlan({ tool, arguments: { mediaRef: input.mediaRef }, confidence: 1, source: "media" });
      }
      if (input.mediaRef && ["发票", "付款凭证"].includes(text)) {
        return explicitPlan(text, "", registry, input);
      }
      if (input.mediaRef && /(?:记账|支出|收入|借款|到账)/u.test(text)) {
        const tool = registry.getTool("bookkeeping.ingest");
        if (tool) return makePlan({ tool, arguments: { text, mediaRef: input.mediaRef }, confidence: 1, source: "media" });
      }
      return naturalPlan(text, confidence, registry, conversationContext(input));
    },
  });
}

export function routeAssistantMessage(input, options) {
  return createAssistantRouter(options).route(input);
}
