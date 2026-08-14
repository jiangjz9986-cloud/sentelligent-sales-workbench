const SCHEMA_VERSION = "project-analysis-v1";
const MAX_ITEMS_PER_SOURCE = 100;
const MAX_OUTPUT_ITEMS = 100;
const OPEN_ACTION_STATUSES = new Set(["pending", "in_progress", "deferred"]);
const CLOSED_ACTION_STATUSES = new Set(["done"]);
const ACTIVE_RISK_STATUSES = new Set(["open", "accepted", "in_progress", "deferred"]);
const CLOSED_RISK_STATUSES = new Set(["closed"]);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function boundedText(value, max = 500) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function strictText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function identifier(value) {
  const text = strictText(value, 200);
  return text && !text.startsWith("synthetic:") ? text : null;
}

function nonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function probabilityValue(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function hasValidCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return instant.getUTCFullYear() === year
    && instant.getUTCMonth() === month - 1
    && instant.getUTCDate() === day;
}

function parseEvidenceDate(value) {
  const text = boundedText(value, 100);
  if (!text) return null;
  const dateOnly = text.match(DATE_ONLY);
  if (dateOnly && hasValidCalendarDate(dateOnly[1], dateOnly[2], dateOnly[3])) {
    return { raw: text, epochMs: Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) };
  }
  const datetime = text.match(OFFSET_DATETIME);
  if (!datetime || !hasValidCalendarDate(datetime[1], datetime[2], datetime[3])) return null;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) ? { raw: text, epochMs } : null;
}

function firstEvidenceDate(...values) {
  for (const value of values) {
    const parsed = parseEvidenceDate(value);
    if (parsed) return parsed;
  }
  return null;
}

function arrayOf(value) {
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS_PER_SOURCE);
  return value && typeof value === "object" ? [value] : [];
}

function firstObject(value) {
  const item = arrayOf(value)[0];
  return item && typeof item === "object" && !Array.isArray(item) ? item : null;
}

function statusOf(item) {
  return (boundedText(item?.status, 80) ?? "").toLowerCase();
}

function sourceRef(type, item, fallbackIndex = 0) {
  const id = identifier(item?.id);
  return id
    ? { type, id }
    : { type, id: `synthetic:${type}:${fallbackIndex + 1}`, synthetic: true };
}

function addSourceRef(sourceRefs, type, item, fallbackIndex = 0) {
  const ref = sourceRef(type, item, fallbackIndex);
  const existing = sourceRefs.find((entry) => entry.type === ref.type && entry.id === ref.id);
  if (existing) return existing;
  sourceRefs.push(ref);
  return ref;
}

function pushFact(facts, sourceRefs, key, value, type, item, label, index = 0) {
  if (value === null || value === undefined || value === "") return;
  const ref = addSourceRef(sourceRefs, type, item, index);
  facts.push({ key, value, label, sourceType: ref.type, sourceId: ref.id });
}

function pushUnknown(unknowns, key, question, reason) {
  if (!unknowns.some((item) => item.key === key)) unknowns.push({ key, question, reason });
}

function latestDatedRecord(records, dateKeys) {
  let latest = null;
  for (const [index, item] of records.entries()) {
    const date = firstEvidenceDate(...dateKeys.map((key) => item?.[key]));
    if (!date || (latest && date.epochMs <= latest.date.epochMs)) continue;
    latest = { item, date, index };
  }
  return latest;
}

function normalizeAsOf(snapshot) {
  return firstEvidenceDate(snapshot?.asOf, snapshot?.referenceAt, snapshot?.analysisAt);
}

function evidenceFreshness(snapshot, datedSources) {
  const referenceAt = normalizeAsOf(snapshot);
  const allDates = datedSources.slice();
  const futureDates = referenceAt ? allDates.filter((date) => date.epochMs > referenceAt.epochMs) : [];
  const dates = (referenceAt ? allDates.filter((date) => date.epochMs <= referenceAt.epochMs) : allDates)
    .sort((left, right) => right.epochMs - left.epochMs);
  const latestAt = dates[0] ?? null;
  if (!referenceAt || !latestAt) {
    return {
      status: latestAt ? "unknown_reference" : "unknown",
      referenceAt: referenceAt?.raw ?? null,
      latestAt: latestAt?.raw ?? null,
      datedSourceCount: dates.length,
      futureSourceCount: futureDates.length,
      staleSourceCount: null,
      windowDays: null,
    };
  }
  const ageDays = Math.max(0, (referenceAt.epochMs - latestAt.epochMs) / 86_400_000);
  return {
    status: ageDays <= 7 ? "fresh" : ageDays <= 30 ? "aging" : "stale",
    referenceAt: referenceAt.raw,
    latestAt: latestAt.raw,
    datedSourceCount: dates.length,
    futureSourceCount: futureDates.length,
    staleSourceCount: dates.filter((date) => (referenceAt.epochMs - date.epochMs) / 86_400_000 > 30).length,
    windowDays: Math.round(ageDays * 100) / 100,
  };
}

function normalizeSnapshot(snapshot) {
  const input = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  return {
    customer: firstObject(input.customer),
    opportunity: firstObject(input.opportunity),
    quickRecords: arrayOf(input.quickRecord ?? input.quickRecords),
    actions: arrayOf(input.action ?? input.actions),
    risks: arrayOf(input.risk ?? input.risks),
    itineraries: arrayOf(input.itinerary ?? input.itineraries),
    expenses: arrayOf(input.expense ?? input.expenses),
    reports: arrayOf(input.report ?? input.reports),
  };
}

function safeSum(total, addend) {
  const next = total + addend;
  return Number.isSafeInteger(next) ? next : null;
}

export function analyzeProjectSnapshot(snapshot = {}) {
  const input = normalizeSnapshot(snapshot);
  const facts = [];
  const inferences = [];
  const unknowns = [];
  const risks = [];
  const nextActions = [];
  const sourceRefs = [];
  const datedSources = [];

  const customer = input.customer;
  if (customer) {
    addSourceRef(sourceRefs, "customer", customer);
    const customerId = identifier(customer.id);
    if (customerId) pushFact(facts, sourceRefs, "customer.id", customerId, "customer", customer, "客户");
    else pushUnknown(unknowns, "customer.id", "需要确认客户标识。", "客户快照缺少真实 id。");
    pushFact(facts, sourceRefs, "customer.name", strictText(customer.name, 200), "customer", customer, "客户名称");
    const date = firstEvidenceDate(customer.updatedAt, customer.createdAt);
    if (date) datedSources.push(date);
  } else {
    pushUnknown(unknowns, "customer", "需要确认关联客户。", "输入快照未提供客户证据。");
  }

  const opportunity = input.opportunity;
  let opportunityStage = null;
  let opportunityAmount = null;
  let opportunityProbability = null;
  if (opportunity) {
    const opportunityRef = addSourceRef(sourceRefs, "opportunity", opportunity);
    const opportunityId = identifier(opportunity.id);
    opportunityStage = strictText(opportunity.stage, 100);
    opportunityAmount = strictText(opportunity.amount, 100);
    opportunityProbability = probabilityValue(opportunity.probability);
    if (opportunityId) pushFact(facts, sourceRefs, "opportunity.id", opportunityId, "opportunity", opportunity, "商机");
    else pushUnknown(unknowns, "opportunity.id", "需要确认商机标识。", "商机快照缺少真实 id。");
    pushFact(facts, sourceRefs, "opportunity.name", strictText(opportunity.name, 200), "opportunity", opportunity, "商机名称");
    pushFact(facts, sourceRefs, "opportunity.stage", opportunityStage, "opportunity", opportunity, "商机阶段");
    pushFact(facts, sourceRefs, "opportunity.amount", opportunityAmount, "opportunity", opportunity, "商机金额");
    pushFact(facts, sourceRefs, "opportunity.probability", opportunityProbability, "opportunity", opportunity, "成交概率");
    if (!opportunityStage) pushUnknown(unknowns, "opportunity.stage", "需要确认当前商机阶段。", "快照没有有效阶段。");
    if (!opportunityAmount) pushUnknown(unknowns, "opportunity.amount", "需要确认商机金额。", "快照没有限界字符串金额。");
    if (opportunityProbability === null) pushUnknown(unknowns, "opportunity.probability", "需要确认成交概率。", "快照没有 0 至 100 的整数概率证据。");
    const date = firstEvidenceDate(opportunity.updatedAt, opportunity.createdAt);
    if (date) datedSources.push(date);
    if (opportunityStage && opportunityAmount && opportunityProbability !== null) {
      inferences.push({
        key: "opportunity.progress",
        statement: `商机处于“${opportunityStage}”，记录金额与概率可用于后续推进优先级判断。`,
        confidence: 68,
        basis: ["opportunity.stage", "opportunity.amount", "opportunity.probability"],
        sourceRefs: [{ type: opportunityRef.type, id: opportunityRef.id }],
      });
    }
  } else {
    pushUnknown(unknowns, "opportunity", "需要确认关联商机及其阶段、金额和概率。", "输入快照未提供商机证据。");
  }

  const latestVisit = latestDatedRecord(input.quickRecords, ["occurredAt", "occurredOn", "createdAt"]);
  if (latestVisit) {
    addSourceRef(sourceRefs, "quickRecord", latestVisit.item, latestVisit.index);
    pushFact(facts, sourceRefs, "quickRecord.latest", latestVisit.date.raw, "quickRecord", latestVisit.item, "最近拜访/记录时间", latestVisit.index);
    pushFact(facts, sourceRefs, "quickRecord.latestChannel", boundedText(latestVisit.item.sourceChannel ?? latestVisit.item.channel), "quickRecord", latestVisit.item, "最近记录渠道", latestVisit.index);
    datedSources.push(latestVisit.date);
  } else {
    pushUnknown(unknowns, "quickRecord.latest", "需要一条有时间证据的最近拜访或快速记录。", "快照没有可解析的记录时间。");
  }

  const referenceAt = normalizeAsOf(snapshot);
  let openActions = 0;
  let overdueActions = 0;
  for (const [index, item] of input.actions.entries()) {
    if (!item || typeof item !== "object") continue;
    const status = statusOf(item);
    if (CLOSED_ACTION_STATUSES.has(status)) continue;
    if (!OPEN_ACTION_STATUSES.has(status)) {
      pushUnknown(unknowns, "action.status", "需要确认行动状态。", "行动状态不是可识别的开放状态。");
      continue;
    }
    const dueProvided = item.due !== null
      && item.due !== undefined
      && (typeof item.due !== "string" || item.due.trim() !== "");
    const due = dueProvided ? firstEvidenceDate(item.due) : null;
    if (dueProvided && !due) {
      pushUnknown(unknowns, "action.due", "需要确认行动截止时间。", "行动 due 不是有效日期证据。");
    }
    const ref = addSourceRef(sourceRefs, "action", item, index);
    openActions += 1;
    nextActions.push({
      id: ref.id,
      key: "action.open",
      action: boundedText(item.title ?? item.action ?? item.name) ?? "跟进未完成行动",
      sourceType: ref.type,
      sourceId: ref.id,
      status,
      due: due?.raw ?? null,
    });
    const date = firstEvidenceDate(item.updatedAt, item.createdAt);
    if (date) datedSources.push(date);
    if (referenceAt && due && due.epochMs < referenceAt.epochMs) overdueActions += 1;
  }
  if (openActions === 0) pushUnknown(unknowns, "action.open", "需要确认是否存在未完成行动。", "快照没有开放状态的行动。");

  let activeRisks = 0;
  for (const [index, item] of input.risks.entries()) {
    if (!item || typeof item !== "object") continue;
    const status = statusOf(item);
    if (CLOSED_RISK_STATUSES.has(status)) continue;
    if (!ACTIVE_RISK_STATUSES.has(status)) {
      pushUnknown(unknowns, "risk.status", "需要确认风险状态。", "风险状态不是可识别的活跃状态。");
      continue;
    }
    const ref = addSourceRef(sourceRefs, "risk", item, index);
    activeRisks += 1;
    risks.push({
      id: ref.id,
      key: "risk.active",
      summary: boundedText(item.title ?? item.summary ?? item.description) ?? "存在待处理风险",
      severity: boundedText(item.severity ?? item.level),
      status,
      sourceType: ref.type,
      sourceId: ref.id,
    });
    const date = firstEvidenceDate(item.updatedAt, item.createdAt);
    if (date) datedSources.push(date);
  }
  if (activeRisks > 0) {
    inferences.push({
      key: "risk.exposure",
      statement: `当前有${activeRisks}项活跃风险，需要在下一步行动中明确责任人和证据。`,
      confidence: 78,
      basis: ["risk.active"],
      sourceRefs: risks.map((item) => ({ type: "risk", id: item.sourceId })),
    });
  }

  const expenseMetrics = {
    count: input.expenses.length,
    actualPaidCents: 0,
    reimbursementCents: 0,
    pendingInvoiceCount: 0,
    invalidPairCount: 0,
  };
  for (const [index, item] of input.expenses.entries()) {
    if (!item || typeof item !== "object") continue;
    const actualPaidCents = nonNegativeSafeInteger(item.actualPaidCents);
    const reimbursementCents = nonNegativeSafeInteger(item.reimbursementCents);
    const validPair = actualPaidCents !== null && reimbursementCents !== null && reimbursementCents <= actualPaidCents;
    if (!validPair) {
      expenseMetrics.invalidPairCount += 1;
      pushUnknown(unknowns, "expense.actualPaidCents", "需要确认费用实付金额。", "费用金额必须是非负安全整数且不小于可报销金额。");
      pushUnknown(unknowns, "expense.reimbursementCents", "需要确认可报销金额。", "费用金额对缺少有效的可报销金额证据。");
      continue;
    }
    const nextActualPaid = safeSum(expenseMetrics.actualPaidCents, actualPaidCents);
    const nextReimbursement = safeSum(expenseMetrics.reimbursementCents, reimbursementCents);
    if (nextActualPaid === null || nextReimbursement === null) {
      expenseMetrics.invalidPairCount += 1;
      pushUnknown(unknowns, "expense.actualPaidCents", "需要确认费用实付金额。", "费用汇总超过安全整数范围。");
      pushUnknown(unknowns, "expense.reimbursementCents", "需要确认可报销金额。", "费用汇总超过安全整数范围。");
      continue;
    }
    expenseMetrics.actualPaidCents = nextActualPaid;
    expenseMetrics.reimbursementCents = nextReimbursement;
    if (["pending", "missing", "partial"].includes(statusOf({ status: item.invoiceStatus }))) {
      expenseMetrics.pendingInvoiceCount += 1;
    }
    const ref = addSourceRef(sourceRefs, "expense", item, index);
    pushFact(facts, sourceRefs, `expense.${ref.id}.actualPaidCents`, actualPaidCents, "expense", item, "费用实付金额（分）", index);
    pushFact(facts, sourceRefs, `expense.${ref.id}.reimbursementCents`, reimbursementCents, "expense", item, "可报销金额（分）", index);
    const date = firstEvidenceDate(item.occurredOn, item.paidAt, item.createdAt);
    if (date) datedSources.push(date);
  }

  const itineraryMetrics = { count: 0, planned: 0 };
  for (const [index, item] of input.itineraries.entries()) {
    if (!item || typeof item !== "object") continue;
    const status = statusOf(item);
    if (!["planned", "completed", "cancelled"].includes(status)) {
      pushUnknown(unknowns, "itinerary.status", "需要确认行程状态。", "行程状态不是可识别的真实枚举。");
      continue;
    }
    itineraryMetrics.count += 1;
    if (status === "planned") itineraryMetrics.planned += 1;
    const date = firstEvidenceDate(item.updatedAt, item.createdAt);
    if (date) datedSources.push(date);
    addSourceRef(sourceRefs, "itinerary", item, index);
  }

  const reportMetrics = { count: 0, draft: 0, saved: 0, ready: 0 };
  for (const [index, item] of input.reports.entries()) {
    if (!item || typeof item !== "object") continue;
    const status = statusOf(item);
    if (!["draft", "saved", "ready"].includes(status)) {
      pushUnknown(unknowns, "report.status", "需要确认周报状态。", "周报状态不是可识别的真实枚举。");
      continue;
    }
    reportMetrics.count += 1;
    if (status === "draft") reportMetrics.draft += 1;
    if (status === "saved") reportMetrics.saved += 1;
    if (status === "ready") reportMetrics.ready += 1;
    const date = firstEvidenceDate(item.updatedAt, item.createdAt);
    if (date) datedSources.push(date);
    addSourceRef(sourceRefs, "report", item, index);
  }

  const freshness = evidenceFreshness(snapshot, datedSources);
  if (!referenceAt) {
    pushUnknown(unknowns, "evidenceFreshness.referenceAt", "需要提供分析基准时间，才能判断证据新鲜度。", "快照没有有效的 asOf/referenceAt。");
  }
  if (freshness.futureSourceCount > 0) {
    pushUnknown(unknowns, "evidenceFreshness.futureEvidence", "需要确认未来时间证据。", "未来发生或更新时间不能作为当前新鲜度依据。");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    facts: facts.slice(0, MAX_OUTPUT_ITEMS),
    inferences: inferences.slice(0, MAX_OUTPUT_ITEMS),
    unknowns: unknowns.slice(0, MAX_OUTPUT_ITEMS),
    risks: risks.slice(0, MAX_OUTPUT_ITEMS),
    nextActions: nextActions.slice(0, MAX_OUTPUT_ITEMS),
    metrics: {
      opportunity: { stage: opportunityStage, amount: opportunityAmount, probability: opportunityProbability },
      actions: { open: openActions, overdue: overdueActions },
      risks: { active: activeRisks },
      expense: expenseMetrics,
      expenses: expenseMetrics,
      itinerary: itineraryMetrics,
      report: reportMetrics,
      evidenceFreshness: freshness,
    },
    sourceRefs,
  };
}

export const analyzeProject = analyzeProjectSnapshot;
export const buildProjectAnalysis = analyzeProjectSnapshot;
