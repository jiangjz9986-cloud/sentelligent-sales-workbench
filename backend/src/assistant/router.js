import { validateToolInvocation } from "./contracts.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { evaluatePolicy } from "./policy.js";
import { extractSpokenOccurredAt, resolveSpokenRange } from "./spokenDate.js";
import { extractSpokenInstant, resolveFutureRange } from "./spokenTime.js";
import { KNOWN_STAGES, normalizeStageText } from "../opportunities/stageVocabulary.js";

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;

const HELP = "可用：战情总览、客户查询与详情、商机查询与维护（列表/详情/推进阶段/改金额/新建/删除）、记支出/收入、发送付款凭证或发票、拜访记录、动作风险、行程摘要、招标摘要、差旅与报销汇总、请款结算预览、知识检索、销售周报。财务写入会先发送待确认信息；请款结算仅供核对。";

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

// --- v0.7.3 quick-record intents (deterministic, no model) ---

const QUICK_CAPTURE_PREFIX_RE = /^(记一下|记录一下|帮我记(?:一下|录)?(?!待办)|快速记录|记拜访)\s*[:：]?\s*([\s\S]*)$/u;
const QUICK_CAPTURE_ESCAPE_PREFIX = "记拜访";
const QUICK_CAPTURE_EMPTY_QUESTION = "请把拜访、电话或会议内容跟在“记一下：”后面一起发我。";
const QUICK_CAPTURE_BOOKKEEPING_HINT = /记账|支出|收入|借款|报销|发票|付款/u;
const QUICK_CAPTURE_AMOUNT_HINT = /\d+(?:\.\d+)?\s*(?:元|块钱?)/u;
const QUICK_CAPTURE_VISIT_HINT = /(?:拜访|拜会|电话|会议|沟通|走访|客户|医院|项目)/u;
const QUICK_SEARCH_RE = /^(?:查一下|查查|查询|查)?\s*(上上周|上周|本周|这周|上个月|上月|本月|今天|昨天|前天|最近)?\s*(?:去|拜访)?(.{0,60}?)的?(?:拜访记录|快速记录|记录)\s*[?？]?$/u;
const QUICK_SEARCH_EXCLUDED_SUBJECT = /^(?:会议|电话|沟通|拜访|快速|历史)$/u;
const QUICK_UPDATE_RE = /^(?:把|将)?(?:那条|这条|上一条|最近(?:一条|的)?)?记录\s*([A-Za-z0-9-]{6,64})?\s*的?(发生时间|时间|日期|客户|商机|诉求|反馈|风险|建议|下一步|待办)\s*(?:改成|改为|设为|设置为|更新为|换成)\s*([\s\S]+)$/u;
const QUICK_UPDATE_FIELD_KEYS = Object.freeze({
  发生时间: "occurredAt",
  时间: "occurredAt",
  日期: "occurredAt",
  客户: "customerQuery",
  商机: "opportunityQuery",
  诉求: "summary.request",
  反馈: "summary.feedback",
  风险: "summary.risk",
  建议: "summary.action",
  下一步: "summary.action",
  待办: "summary.action",
});
const QUICK_VOID_RE = /^(?:作废|删除|撤销)(?:那条|这条|最近的?)?记录\s*([A-Za-z0-9-]{6,64})?\s*$/u;
const QUICK_CAPTURE_COMMANDS = new Set(["记一下", "记录一下", "快速记录", "记拜访"]);

function quickRecordCapturePlan(prefix, body, registry, confidence, now) {
  const tool = registry.getTool("visit-capture.capture");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const content = clean(body);
  if (!content) return clarify(QUICK_CAPTURE_EMPTY_QUESTION, confidence);
  // Ambiguity gate: bodies that read like bookkeeping (amount words or
  // financial keywords without any visit vocabulary) are clarified instead of
  // being captured; the 记拜访 prefix is the unconditional escape hatch.
  if (prefix !== QUICK_CAPTURE_ESCAPE_PREFIX
    && (QUICK_CAPTURE_BOOKKEEPING_HINT.test(content) || QUICK_CAPTURE_AMOUNT_HINT.test(content))
    && !QUICK_CAPTURE_VISIT_HINT.test(content)) {
    return clarify("这段更像记账内容：直接发送「支出 …」即可记账；如果是拜访记录请以「记拜访：…」开头重发。", confidence);
  }
  const occurredAt = extractSpokenOccurredAt(content, now);
  return makePlan({
    tool,
    arguments: { rawContent: content, ...(occurredAt ? { occurredAt } : {}) },
    confidence,
    source: "natural",
  });
}

function quickRecordSearchPlan(match, registry, confidence, now) {
  const tool = registry.getTool("visit-capture.search");
  if (!tool) return null;
  const periodWord = match[1] ?? null;
  const subject = clean(match[2]);
  const usableSubject = subject && !QUICK_SEARCH_EXCLUDED_SUBJECT.test(subject) ? subject : null;
  // Generic phrases like 会议记录 (no period word, excluded subject) keep the
  // existing visit-capture collect fallback instead of becoming a search.
  if (!periodWord && !usableSubject) return null;
  const range = resolveSpokenRange(periodWord ?? "最近", now) ?? resolveSpokenRange("最近", now);
  return makePlan({
    tool,
    arguments: {
      ...(usableSubject ? { query: usableSubject } : {}),
      dateStart: range.start,
      dateEnd: range.end,
    },
    confidence,
    source: "natural",
  });
}

function quickRecordUpdatePlan(match, registry, confidence) {
  const tool = registry.getTool("visit-capture.update");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const value = clean(match[3]);
  if (!value) return clarify("请说明要修改成的内容。", confidence);
  return makePlan({
    tool,
    arguments: {
      ...(match[1] ? { quickRecordId: match[1] } : {}),
      field: QUICK_UPDATE_FIELD_KEYS[match[2]],
      value,
    },
    confidence,
    source: "natural",
  });
}

function quickRecordVoidPlan(match, registry, confidence) {
  const tool = registry.getTool("visit-capture.void");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  return makePlan({
    tool,
    arguments: { ...(match[1] ? { quickRecordId: match[1] } : {}) },
    confidence,
    source: "natural",
  });
}

// --- v0.7.5 todo intents (deterministic, no model) ---

const TODO_CREATE_PREFIX_RE = /^(?:提醒我|记待办|新建待办)\s*[:：]?\s*([\s\S]+)$/u;
const TODO_CREATE_COLON_RE = /^待办\s*[:：]\s*([\s\S]+)$/u;
const TODO_DEFER_RE = /^(?:把)?待办\s*(.+?)\s*(?:推迟|延期|顺延|改)(?:到|至|成)\s*(.+)$/u;
const TODO_DEFER_PREFIX_RE = /^(?:推迟|延期|顺延)待办\s*(.+?)\s*(?:到|至)\s*(.+)$/u;
const TODO_COMPLETE_RE = /^(?:完成|办完|做完)(?:了)?待办\s*(.+)$/u;
const TODO_COMPLETE_SUFFIX_RE = /^待办\s*(.+?)\s*(?:完成|办完|做完)(?:了)?$/u;
const TODO_DELETE_RE = /^(?:删除|取消|删掉)待办\s*(.+)$/u;
const TODO_LIST_RE = /^(?:查?(?:一下)?)?\s*(今天|今日|明天|本周|这周|下周|最近)?\s*(?:的)?\s*(我的)?\s*(?:有什么|有哪些|还有什么|还有哪些)?\s*待办(?:清单|列表|事项)?\s*[?？]?$/u;
const TODO_PRIORITY_RE = /(紧急|重要|优先|高优)/u;
const TODO_BOOKKEEPING_LEAD_RE = /^(?:记账|记支出|记收入)/u;
const TODO_CONTACT_RE = /(?:给|帮|约|拜访|联系|回复)([\u4e00-\u9fffA-Za-z0-9]{2,20})/u;
const TODO_EMPTY_QUESTION = "请补充待办内容，例如「提醒我周五前给王工送方案」。";

function todoCreatePlan(body, registry, confidence, now) {
  const tool = registry.getTool("action-risk.create");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const content = clean(body);
  if (!content) return clarify(TODO_EMPTY_QUESTION, confidence);
  // A body that opens with a bookkeeping verb is genuinely ambiguous between
  // “remind me to book it later” and “book it now”; everything else stays a
  // todo (提醒我… means a reminder even when money words appear).
  if (TODO_BOOKKEEPING_LEAD_RE.test(content)) {
    return clarify("你是要现在记账（直接发送「支出 …」），还是建一条待办提醒（以「待办：…」重发）？", confidence);
  }
  const { instant, remainder } = extractSpokenInstant(content, now);
  let title = remainder;
  const priorityMatch = title.match(TODO_PRIORITY_RE);
  if (priorityMatch) title = title.replace(priorityMatch[1], "").trim();
  title = clean(title).replace(/^[，,。:：\s]+|[，,。:：\s]+$/gu, "").slice(0, 80);
  if (!title) return clarify(TODO_EMPTY_QUESTION, confidence);
  const contact = title.match(TODO_CONTACT_RE);
  return makePlan({
    tool,
    arguments: {
      title,
      ...(instant ? { remindAt: instant.iso, due: clean(instant.token).slice(0, 50) } : {}),
      priority: priorityMatch ? "高" : "中",
      ...(contact ? { customerQuery: contact[1] } : {}),
    },
    confidence,
    source: "natural",
  });
}

function todoTargetPlan(toolName, target, registry, confidence, extra = {}) {
  const tool = registry.getTool(toolName);
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const query = clean(target);
  if (!query) return clarify("请带上待办编号或标题，例如「完成待办 a1b2c3」。", confidence);
  return makePlan({ tool, arguments: { query, ...extra }, confidence, source: "natural" });
}

function todoListPlan(match, registry, confidence, now) {
  const tool = registry.getTool("action-risk.list");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const rangeWord = match[1] ?? null;
  const range = rangeWord ? resolveFutureRange(rangeWord, now) : null;
  return makePlan({
    tool,
    arguments: {
      ...(range ? { dateStart: range.start, dateEnd: range.end } : {}),
      rangeLabel: rangeWord ?? "全部",
    },
    confidence,
    source: "natural",
  });
}

// --- v0.7.6 opportunity intents (deterministic, no model) ---

// Write group (design §3.2 G-W). 推进/推到 counts as an opportunity-domain
// strong verb, so the 商机 stem may be omitted (covers subject-less
// 推进到方案交流 and suffix references like 把 f3a9c1 推进到预算确认).
const OPPORTUNITY_STAGE_ADVANCE_RE = /^(?:把|将)?(.{0,60}?)(?:的)?(?:商机)?(?:的)?(?:阶段)?(?:推进|推)(?:到|至)\s*(.+)$/u;
const OPPORTUNITY_STAGE_SET_RE = /^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?阶段(?:改成|改为|设为|设置为|更新为|换成|调整?到)\s*(.+)$/u;
const OPPORTUNITY_STAGE_BACK_RE = /^(?:把|将)?(.{0,60}?)(?:的)?商机(?:回退|退回)(?:到|至)\s*(.+)$/u;
const OPPORTUNITY_NEXT_SET_RE = /^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?下一步(?:动作)?(?:改成|改为|设为|更新为|换成)\s*(.+)$/u;
const OPPORTUNITY_NEXT_COLON_RE = /^(.{0,60}?)(?:的)?商机(?:的)?下一步\s*[:：]\s*(.+)$/u;
const OPPORTUNITY_FIELD_SET_RE = /^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?(金额|名称|风险)(?:改成|改为|设为|更新为|换成)\s*(.+)$/u;
const OPPORTUNITY_CREATE_RE = /^(?:新建|新增|创建)商机\s*[:：]?\s*(.+)$/u;
const OPPORTUNITY_DELETE_RE = /^(?:删除|删掉)商机\s*[:：]?\s*(.+)$/u;
// Query group (design §3.2 G-Q, detail before list — the detail suffix is
// more specific). A leading query verb keeps 查询日照的商机 away from the
// bare customer search downstream.
const OPPORTUNITY_DETAIL_QUERY_RE = /^(?:查一下|查查|查询|查)?\s*(.{2,60}?)(?:的)?商机(?:的)?(?:进展|什么进展|情况|什么情况|状态|怎么样)(?:如何|怎么样)?\s*[?？]?$/u;
const OPPORTUNITY_LIST_RE = /^(?:查一下|查查|查询|查)?\s*(.{0,60}?)(?:的)?(有哪些|有什么)?商机(列表|们)?\s*[?？]?$/u;
const OPPORTUNITY_PRONOUN_RE = /^(?:它|这个商机|该商机|当前商机|这个项目|该项目|当前项目)$/u;
// Narrative visit phrasings that happen to end in 商机 stay with the
// visit-capture fallback instead of becoming opportunity lookups.
const OPPORTUNITY_SUBJECT_VISIT_HINT = /(?:拜访|拜会|电话|会议|沟通|走访)/u;
const OPPORTUNITY_FIELD_KEYS = Object.freeze({ 金额: "amount", 名称: "name", 风险: "risk" });
const OPPORTUNITY_CREATE_SEGMENT_RE = /^(名称|客户|阶段|金额|下一步)\s*[:：]?\s*(.+)$/u;
const OPPORTUNITY_CREATE_SEGMENT_KEYS = Object.freeze({
  名称: "name",
  客户: "customerQuery",
  阶段: "stage",
  金额: "amount",
  下一步: "next",
});
const OPPORTUNITY_TARGET_QUESTION = "请说明商机名称或编号，例如「把日照的商机推进到方案交流」。";

// v0.9.0 hospital-tender summary intent (audit C B12). Anchored full-match on
// purpose: a loose 查.*招标 would swallow record searches like
// 查上周招标办的拜访记录, which must stay with QUICK_SEARCH downstream.
const HOSPITAL_TENDER_SUMMARY_RE = /^(?:查一下|查查|查询|查)?\s*(?:最近|今天|本周)?\s*(?:有什么|有哪些)?\s*(?:医院)?招标(?:公告|信息|动态|情况|摘要|监测)?\s*(?:有什么|有哪些|怎么样)?\s*[?？]?$/u;

function opportunityWriteTarget(subject, context) {
  const normalized = clean(subject);
  if (!normalized || OPPORTUNITY_PRONOUN_RE.test(normalized)) {
    return context.opportunityId ? { opportunityId: context.opportunityId } : null;
  }
  if (normalized.length > 200) return null;
  return { query: normalized };
}

function opportunityToolPlan(toolName, subject, extra, registry, confidence, context) {
  const tool = registry.getTool(toolName);
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const target = opportunityWriteTarget(subject, context);
  if (!target) return clarify(OPPORTUNITY_TARGET_QUESTION, confidence);
  return makePlan({ tool, arguments: { ...target, ...extra }, confidence, source: "natural" });
}

function opportunityStagePlan(subject, stageRaw, registry, confidence, context) {
  const stage = normalizeStageText(stageRaw);
  if (!stage) {
    return clarify(`请说明目标阶段，例如「把日照的商机推进到方案交流」。已知阶段：${KNOWN_STAGES.join("、")}。`, confidence);
  }
  // Relative phrasing is not auto-resolved in this version (design §7.2):
  // the user states the explicit target after seeing the known sequence.
  if (/^(?:下一?个?|上一?个?)(?:阶段|环节|步)$/u.test(stage)) {
    return clarify(`请直接说明目标阶段。已知阶段顺序：${KNOWN_STAGES.join(" → ")}。`, confidence);
  }
  return opportunityToolPlan("opportunity.update-stage", subject, { stage }, registry, confidence, context);
}

function opportunityNextPlan(subject, nextRaw, registry, confidence, context) {
  const next = clean(nextRaw);
  if (!next) return clarify("请说明新的下一步动作，例如「把日照商机的下一步改成 下周带售前调研」。", confidence);
  if (next.length > 500) return clarify("下一步动作太长了，请精简到 500 字以内。", confidence);
  return opportunityToolPlan("opportunity.update-next", subject, { next }, registry, confidence, context);
}

function opportunityFieldPlan(subject, fieldLabel, valueRaw, registry, confidence, context) {
  const value = clean(valueRaw);
  if (!value) return clarify(`请说明新的${fieldLabel}。`, confidence);
  return opportunityToolPlan(
    "opportunity.update",
    subject,
    { changes: { [OPPORTUNITY_FIELD_KEYS[fieldLabel]]: value } },
    registry,
    confidence,
    context,
  );
}

function opportunityCreatePlan(payload, registry, confidence) {
  const tool = registry.getTool("opportunity.create");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const segments = String(payload ?? "").split(/[，,；;]/u).map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) {
    return clarify("请说明商机名称，例如「新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院」。", confidence);
  }
  const fields = {};
  let name = null;
  for (const [index, segment] of segments.entries()) {
    const keyed = segment.match(OPPORTUNITY_CREATE_SEGMENT_RE);
    if (!keyed) {
      if (index === 0) {
        name = segment;
        continue;
      }
      return clarify(`没听懂「${segment}」。可用段：客户（必填）、阶段、金额、下一步。`, confidence);
    }
    const key = OPPORTUNITY_CREATE_SEGMENT_KEYS[keyed[1]];
    const value = keyed[2].trim();
    if (key === "name") {
      if (name) return clarify("商机名称出现了两次，请只写一次。", confidence);
      name = value;
      continue;
    }
    if (fields[key] !== undefined) return clarify(`「${keyed[1]}」出现了两次，请只写一次。`, confidence);
    fields[key] = key === "stage" ? normalizeStageText(value) || value : value;
  }
  if (!name) return clarify("请说明商机名称，例如「新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院」。", confidence);
  if (!fields.customerQuery) {
    return clarify("请注明客户，例如「新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院」。", confidence);
  }
  return makePlan({ tool, arguments: { name, ...fields }, confidence, source: "natural" });
}

function opportunityWritePlan(value, registry, confidence, context) {
  const create = value.match(OPPORTUNITY_CREATE_RE);
  if (create) return opportunityCreatePlan(create[1], registry, confidence);
  const remove = value.match(OPPORTUNITY_DELETE_RE);
  if (remove) return opportunityToolPlan("opportunity.delete", remove[1], {}, registry, confidence, context);
  const stageSet = value.match(OPPORTUNITY_STAGE_SET_RE) ?? value.match(OPPORTUNITY_STAGE_BACK_RE);
  if (stageSet) return opportunityStagePlan(stageSet[1], stageSet[2], registry, confidence, context);
  const fieldSet = value.match(OPPORTUNITY_FIELD_SET_RE);
  if (fieldSet) return opportunityFieldPlan(fieldSet[1], fieldSet[2], fieldSet[3], registry, confidence, context);
  const nextSet = value.match(OPPORTUNITY_NEXT_SET_RE) ?? value.match(OPPORTUNITY_NEXT_COLON_RE);
  if (nextSet) return opportunityNextPlan(nextSet[1], nextSet[2], registry, confidence, context);
  const advance = value.match(OPPORTUNITY_STAGE_ADVANCE_RE);
  if (advance) return opportunityStagePlan(advance[1], advance[2], registry, confidence, context);
  return null;
}

function opportunityDetailPlan(subject, registry, confidence, context) {
  const tool = registry.getTool("opportunity.detail");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const normalized = clean(subject);
  const target = !normalized || OPPORTUNITY_PRONOUN_RE.test(normalized)
    ? context.opportunityId ?? ""
    : normalized;
  if (!target) return clarify(OPPORTUNITY_TARGET_QUESTION, confidence);
  return makePlan({ tool, arguments: { opportunityId: target }, confidence, source: "natural" });
}

function opportunityListPlan(match, registry, confidence) {
  const tool = registry.getTool("opportunity.list");
  if (!tool) return clarify("该功能尚未开放，请联系管理员。", confidence);
  const subject = clean(match[1]);
  const hasMarker = Boolean(match[2] || match[3]);
  // Narrative sentences that merely end in 商机 (…拜访了X聊了聊商机) keep the
  // visit-capture fallback instead of becoming a lookup.
  if (subject && OPPORTUNITY_SUBJECT_VISIT_HINT.test(subject)) return null;
  if (!subject && !hasMarker) {
    return clarify("请带上客户或商机名称，如「日照医院有哪些商机」；发送「商机列表」可查看全部。", confidence);
  }
  if (!subject || OPPORTUNITY_PRONOUN_RE.test(subject)) {
    return makePlan({ tool, arguments: {}, confidence, source: "natural" });
  }
  return makePlan({ tool, arguments: { query: subject }, confidence, source: "natural" });
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

function explicitPlan(command, args, registry, { mediaRef, context: rawContext } = {}, now = new Date()) {
  const context = conversationContext({ context: rawContext });
  const normalized = command.replace(/^\//, "");
  if (normalized === "help" || normalized === "帮助" || normalized === "h") return { kind: "intent_plan", status: "help", toolName: null, agentId: "system-router", arguments: {}, message: HELP };
  if (normalized === "cancel" || normalized === "取消") return { kind: "intent_plan", status: "cancelled", toolName: null, agentId: "system-router", arguments: {} };
  if (Object.hasOwn(CUSTOMER_WRITE_COMMAND_MODES, normalized)) {
    return customerWriteCommandPlan(CUSTOMER_WRITE_COMMAND_MODES[normalized], args, registry, context);
  }
  if (QUICK_CAPTURE_COMMANDS.has(normalized)) {
    return quickRecordCapturePlan(normalized, args, registry, 1, now);
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
    "招标摘要": ["hospital-tender.summary", () => ({})],
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

function naturalPlan(text, confidence, registry, rawContext = {}, now = new Date()) {
  const value = clean(text);
  const context = conversationContext({ context: rawContext });
  // The capture prefix is the strongest user-intent signal and therefore sits
  // in front of every other natural phrasing; its internal bookkeeping
  // ambiguity gate keeps finance-looking bodies out (see quickRecordCapturePlan).
  const quickCapture = value.match(QUICK_CAPTURE_PREFIX_RE);
  if (quickCapture) {
    return quickRecordCapturePlan(quickCapture[1], quickCapture[2], registry, confidence, now);
  }
  // Todo prefixes are the second-strongest intent signals; the strong 待办
  // stem keeps them disjoint from the capture prefixes above and every
  // phrasing below (design v0.7.5 §1.3).
  const todoCreate = value.match(TODO_CREATE_PREFIX_RE) ?? value.match(TODO_CREATE_COLON_RE);
  if (todoCreate) return todoCreatePlan(todoCreate[1], registry, confidence, now);
  const todoDefer = value.match(TODO_DEFER_RE) ?? value.match(TODO_DEFER_PREFIX_RE);
  if (todoDefer) return todoTargetPlan("action-risk.defer", todoDefer[1], registry, confidence, { newTime: clean(todoDefer[2]) });
  const todoComplete = value.match(TODO_COMPLETE_RE) ?? value.match(TODO_COMPLETE_SUFFIX_RE);
  if (todoComplete) return todoTargetPlan("action-risk.complete", todoComplete[1], registry, confidence);
  const todoDelete = value.match(TODO_DELETE_RE);
  if (todoDelete) return todoTargetPlan("action-risk.delete", todoDelete[1], registry, confidence);
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
  // v0.7.6 opportunity write group. Anchored after the 商机详情 alias and
  // before 项目分析; it must stay ahead of the customer field-change regex
  // below so 把X商机的名称改成Y is not swallowed by the customer tools.
  const opportunityWrite = opportunityWritePlan(value, registry, confidence, context);
  if (opportunityWrite) return opportunityWrite;
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
  // Time-scoped or 我的-scoped todo queries route to the owner-bounded list;
  // bare 待办/有什么待办 keeps the existing action-risk summary above.
  const todoList = followUpText.match(TODO_LIST_RE);
  if (todoList && (todoList[1] || todoList[2])) {
    return todoListPlan(todoList, registry, confidence, now);
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
  // R0 tender summary sits with the query group: after the travel-expense
  // summary phrasing, before the bookkeeping capture so 记一下/提醒我 prefixes
  // upstream and the bookkeeping keywords below never see these queries.
  if (HOSPITAL_TENDER_SUMMARY_RE.test(value)) {
    return makePlan({
      tool: registry.getTool("hospital-tender.summary"),
      arguments: {},
      confidence,
      source: "natural",
    });
  }
  const naturalBookkeeping = value.match(/^记一笔[：:\s]*(.+)$/u);
  if (naturalBookkeeping || /记账|支出|收入|借款到账/u.test(value)) {
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
  // Quick-record history intents carry the explicit 记录 stem and sit before
  // the v0.7.2 customer-write phrasings (longer stems match first; the two
  // regex families are disjoint by field vocabulary).
  const quickUpdate = value.match(QUICK_UPDATE_RE);
  if (quickUpdate) {
    return quickRecordUpdatePlan(quickUpdate, registry, confidence);
  }
  const quickVoid = value.match(QUICK_VOID_RE);
  if (quickVoid) {
    return quickRecordVoidPlan(quickVoid, registry, confidence);
  }
  const quickSearch = value.match(QUICK_SEARCH_RE);
  if (quickSearch) {
    const plan = quickRecordSearchPlan(quickSearch, registry, confidence, now);
    if (plan) return plan;
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
  // v0.7.6 opportunity query group. Anchored before the customer search and
  // bare 查询 fallbacks so 查询日照的商机 stays an opportunity list instead of
  // becoming a customer search. Detail runs before list (more specific suffix).
  const opportunityProgress = value.match(OPPORTUNITY_DETAIL_QUERY_RE);
  if (opportunityProgress) {
    return opportunityDetailPlan(opportunityProgress[1], registry, confidence, context);
  }
  const opportunityList = value.match(OPPORTUNITY_LIST_RE);
  if (opportunityList) {
    const plan = opportunityListPlan(opportunityList, registry, confidence);
    if (plan) return plan;
  }
  const customer = value.match(/^(?:查客户|查询客户|客户)\s+(.+)$/u);
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
    // v0.7.6 tech-debt repayment (v0.7.2 design risk 3): 商机/项目 subjects
    // forward to the opportunity detail tool instead of being excluded to
    // unknown. Normal traffic is captured upstream by the opportunity query
    // group; this branch is the safety net for variants like X商机资料.
    const opportunitySubject = subject.match(/^(.{0,58}?)(?:的)?(?:商机|项目)$/u);
    if (opportunitySubject) {
      const inner = clean(opportunitySubject[1]);
      const target = !inner || /^(?:它|这个|该|当前)$/u.test(inner) ? context.opportunityId ?? "" : inner;
      if (!target) return clarify(OPPORTUNITY_TARGET_QUESTION, confidence);
      return makePlan({
        tool: registry.getTool("opportunity.detail"),
        arguments: { opportunityId: target },
        confidence,
        source: "natural",
      });
    }
    const excluded = /(?:报销|周报|记账|请款|发票|凭证|行程|差旅|风险|待办|知识)$/u.test(subject);
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

export function createAssistantRouter({
  registry = createAgentRegistry(),
  confidenceThreshold = ROUTER_CONFIDENCE_THRESHOLD,
  clock = () => new Date(),
} = {}) {
  return Object.freeze({
    route(input = {}) {
      const text = clean(input.text);
      const now = clock();
      const explicit = parseExplicit(text);
      const plainCommand = text.toLowerCase();
      if (["帮助", "help"].includes(plainCommand)) {
        return explicitPlan("帮助", "", registry, input, now);
      }
      if (["取消", "cancel"].includes(plainCommand)) {
        return explicitPlan("取消", "", registry, input, now);
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
        return explicitPlan(explicit.command, explicit.args, registry, input, now) ?? unknown(1, "unknown_explicit_command");
      }
      const confidence = input.confidence === undefined ? 1 : Number(input.confidence);
      if (confidence < confidenceThreshold) return clarify("我不确定你的意图，请使用明确命令或补充说明。", confidence);
      if (input.mediaRef && !text) {
        const tool = registry.getTool("bookkeeping.ingest");
        if (tool) return makePlan({ tool, arguments: { mediaRef: input.mediaRef }, confidence: 1, source: "media" });
      }
      if (input.mediaRef && ["发票", "付款凭证"].includes(text)) {
        return explicitPlan(text, "", registry, input, now);
      }
      if (input.mediaRef && /(?:记账|支出|收入|借款|到账)/u.test(text)) {
        const tool = registry.getTool("bookkeeping.ingest");
        if (tool) return makePlan({ tool, arguments: { text, mediaRef: input.mediaRef }, confidence: 1, source: "media" });
      }
      return naturalPlan(text, confidence, registry, conversationContext(input), now);
    },
  });
}

export function routeAssistantMessage(input, options) {
  return createAssistantRouter(options).route(input);
}
