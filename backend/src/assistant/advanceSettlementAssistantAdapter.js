import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "advance-settlement";
const CONTRACT_VERSION = "advance-settlement-v1";
const TASK_TYPES = new Set(["advance_summary", "settlement_preview", "direction_explanation"]);
const ADVANCE_STATUSES = new Set(["draft", "requested", "received", "closed"]);
const DIRECTIONS = new Set(["company_reimburses", "individual_returns", "balanced"]);
const MAX_ITEMS = 100;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_advance_settlement_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(`${name} is too long`, "invalid_advance_settlement_input");
  }
  return normalized;
}

function optionalText(value, name, max = 5000) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, max);
}

function identifier(value, name = "id") {
  const normalized = optionalText(value, name, 200);
  if (!normalized) return null;
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized) || normalized.startsWith("synthetic:")) {
    throw new AssistantContractError(`${name} is invalid`, "invalid_advance_settlement_input");
  }
  return normalized;
}

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized) && !normalized.startsWith("synthetic:")
    ? normalized
    : null;
}

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function nonNegativeMoney(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function signedMoney(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function currentWeekStart(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function normalizeWeekStart(value, clock) {
  if (value === null || value === undefined || value === "" || value === "current") return currentWeekStart(clock);
  const normalized = text(value, "weekStart", 40);
  const date = dateOnly(normalized);
  if (!date || new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new AssistantContractError("weekStart must be a Monday", "invalid_advance_settlement_input");
  }
  return date;
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

function refsFor(expenses, advances) {
  const refs = [];
  const seen = new Set();
  for (const item of expenses) {
    if (!item.id || seen.has(`travel_expense:${item.id}`) || refs.length >= MAX_ITEMS) continue;
    seen.add(`travel_expense:${item.id}`);
    refs.push({ type: "travel_expense", id: item.id });
  }
  for (const item of advances) {
    if (!item.id || seen.has(`travel_expense_advance:${item.id}`) || refs.length >= MAX_ITEMS) continue;
    seen.add(`travel_expense_advance:${item.id}`);
    refs.push({ type: "travel_expense_advance", id: item.id });
  }
  return refs;
}

function normalizeAdvance(value) {
  if (!isPlainObject(value)) return null;
  const id = safeIdentifier(value.id);
  if (!id) return null;
  return {
    id,
    version: Number.isSafeInteger(value.version) && value.version >= 1 ? value.version : null,
    weekStart: dateOnly(value.weekStart),
    status: ADVANCE_STATUSES.has(value.status) ? value.status : null,
    requestedCents: nonNegativeMoney(value.requestedCents),
    receivedCents: nonNegativeMoney(value.receivedCents),
    requestedOn: dateOnly(value.requestedOn),
    receivedOn: dateOnly(value.receivedOn),
    purpose: boundedText(value.purpose, 1000),
  };
}

function normalizePayment(value) {
  if (!isPlainObject(value)) return null;
  const id = safeIdentifier(value.id);
  if (!id) return null;
  return {
    id,
    amountCents: nonNegativeMoney(value.amountCents),
    reimbursementCents: nonNegativeMoney(value.reimbursementCents),
    fundingSource: boundedText(value.fundingSource, 40),
    paidAt: boundedText(value.paidAt, 100),
  };
}

function normalizeExpense(value) {
  if (!isPlainObject(value)) return null;
  const id = safeIdentifier(value.id);
  if (!id) return null;
  return {
    id,
    referenceCode: boundedText(value.referenceCode, 100),
    version: Number.isSafeInteger(value.version) && value.version >= 1 ? value.version : null,
    occurredOn: dateOnly(value.occurredOn),
    category: boundedText(value.category, 80),
    purpose: boundedText(value.purpose, 500),
    invoiceStatus: boundedText(value.invoiceStatus, 40),
    payments: Array.isArray(value.payments) ? value.payments.slice(0, 25).map(normalizePayment).filter(Boolean) : [],
    actualPaidCents: nonNegativeMoney(value.actualPaidCents),
    reimbursementCents: nonNegativeMoney(value.reimbursementCents),
    settlementEligibleCents: nonNegativeMoney(value.settlementEligibleCents),
    personalPaidCents: nonNegativeMoney(value.personalPaidCents),
    companyDirectPaidCents: nonNegativeMoney(value.companyDirectPaidCents),
    companyDirectReimbursementCents: nonNegativeMoney(value.companyDirectReimbursementCents),
    advanceFundedCents: nonNegativeMoney(value.advanceFundedCents),
    invoiceCoverage: {
      confirmedCents: nonNegativeMoney(value.invoiceCoverage?.confirmedCents),
      missingCents: nonNegativeMoney(value.invoiceCoverage?.missingCents),
      noInvoiceConfirmedCents: nonNegativeMoney(value.invoiceCoverage?.noInvoiceConfirmedCents),
      unacknowledgedMissingCents: nonNegativeMoney(value.invoiceCoverage?.unacknowledgedMissingCents),
    },
  };
}

function normalizeSummary(value) {
  return {
    expenseCount: count(value?.expenseCount),
    paymentCount: count(value?.paymentCount),
    actualPaidCents: nonNegativeMoney(value?.actualPaidCents),
    reimbursementCents: nonNegativeMoney(value?.reimbursementCents),
    personalPaidCents: nonNegativeMoney(value?.personalPaidCents),
    companyDirectPaidCents: nonNegativeMoney(value?.companyDirectPaidCents),
    companyDirectReimbursementCents: nonNegativeMoney(value?.companyDirectReimbursementCents),
    advanceFundedCents: nonNegativeMoney(value?.advanceFundedCents),
    settlementEligibleCents: nonNegativeMoney(value?.settlementEligibleCents),
    advanceReceivedCents: nonNegativeMoney(value?.advanceReceivedCents),
    personalSettlementCents: signedMoney(value?.personalSettlementCents),
    settlementDirection: DIRECTIONS.has(value?.settlementDirection) ? value.settlementDirection : null,
  };
}

function normalizeEvidence(value) {
  const item = isPlainObject(value) ? value : {};
  const group = (entry) => ({ count: count(entry?.count), complete: entry?.complete === true });
  return {
    advances: group(item.advances),
    expenses: group(item.expenses),
    fundingSources: {
      complete: item.fundingSources?.complete === true,
      unknownCount: count(item.fundingSources?.unknownCount),
    },
    invoiceCoverage: {
      complete: item.invoiceCoverage?.complete === true,
      unacknowledgedMissingCents: nonNegativeMoney(item.invoiceCoverage?.unacknowledgedMissingCents),
    },
    settlement: {
      arithmeticComplete: item.settlement?.arithmeticComplete === true,
      transactionRecorded: item.settlement?.transactionRecorded === true,
    },
  };
}

function normalizeSnapshot(snapshot, requestedWeekStart) {
  const value = isPlainObject(snapshot) ? snapshot : {};
  const expenses = Array.isArray(value.expenses) ? value.expenses.slice(0, MAX_ITEMS).map(normalizeExpense).filter(Boolean) : [];
  const advances = Array.isArray(value.advances) ? value.advances.slice(0, MAX_ITEMS).map(normalizeAdvance).filter(Boolean) : [];
  return {
    asOf: boundedText(value.asOf, 100),
    weekStart: dateOnly(value.weekStart) ?? requestedWeekStart,
    expenses,
    advances,
    summary: normalizeSummary(value.summary),
    invoiceCoverage: {
      reimbursementCents: nonNegativeMoney(value.invoiceCoverage?.reimbursementCents),
      confirmedCents: nonNegativeMoney(value.invoiceCoverage?.confirmedCents),
      missingCents: nonNegativeMoney(value.invoiceCoverage?.missingCents),
      noInvoiceConfirmedCents: nonNegativeMoney(value.invoiceCoverage?.noInvoiceConfirmedCents),
      unacknowledgedMissingCents: nonNegativeMoney(value.invoiceCoverage?.unacknowledgedMissingCents),
      complete: value.invoiceCoverage?.complete === true,
    },
    evidence: normalizeEvidence(value.evidence),
    issues: Array.isArray(value.issues)
      ? [...new Set(value.issues
        .filter((item) => typeof item === "string")
        .map((item) => item.trim().replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase())
        .filter((item) => /^[A-Z0-9_]+$/u.test(item))
        .slice(0, 50))]
      : [],
    truncated: {
      expenses: value.truncated?.expenses === true,
      advances: value.truncated?.advances === true,
    },
    sourceRefs: refsFor(expenses, advances),
  };
}

function sourceReader({ settlementSnapshotAdapter, snapshotAdapter, advanceSnapshotAdapter, advanceRepository }) {
  const source = settlementSnapshotAdapter ?? snapshotAdapter ?? advanceSnapshotAdapter ?? advanceRepository;
  if (!source) throw new TypeError("owner-scoped settlement snapshot adapter is required");
  if (typeof source.advanceSettlementSummary === "function") {
    return ({ owner, weekStart }) => source.advanceSettlementSummary({ owner, weekStart });
  }
  if (typeof source.settlementSummary === "function") {
    return ({ owner, weekStart }) => source.settlementSummary({ owner, weekStart });
  }
  if (typeof source.advanceSummary === "function") {
    return ({ owner, weekStart }) => {
      const advances = source.advanceSummary({ owner, weekStart });
      return {
        weekStart,
        advances,
        truncated: { expenses: false, advances: Array.isArray(advances) && advances.length > MAX_ITEMS },
        issues: ["SETTLEMENT_EVIDENCE_UNAVAILABLE"],
      };
    };
  }
  if (typeof source.listAdvances === "function") {
    return ({ owner, weekStart }) => {
      const advances = source.listAdvances({ owner, weekStart });
      return {
        weekStart,
        advances,
        truncated: { expenses: false, advances: Array.isArray(advances) && advances.length > MAX_ITEMS },
        issues: ["SETTLEMENT_EVIDENCE_UNAVAILABLE"],
      };
    };
  }
  throw new TypeError("settlement snapshot adapter must expose advanceSettlementSummary");
}

function blocker(key, question, reason) {
  return { key, question, reason };
}

function blockersFor(snapshot) {
  const blockers = [];
  const add = (key, question, reason) => {
    if (!blockers.some((item) => item.key === key)) blockers.push(blocker(key, question, reason));
  };
  if (snapshot.issues.includes("OWNER_SCOPE_EMPTY")) {
    add("owner_scope", "当前账号没有可读取的业务 owner 映射。", "服务端 owner resolver 返回空范围。");
  }
  if (snapshot.issues.includes("SETTLEMENT_EVIDENCE_UNAVAILABLE")) {
    add("settlement_evidence", "请先读取完整的费用和票据结算快照。", "当前数据源只提供请款记录，不能安全推导结算方向。");
  }
  if (snapshot.truncated.expenses || snapshot.truncated.advances) {
    add("truncated", "请在费用系统中分批查看全部记录。", "结算快照达到单次返回上限，Agent 不会静默截断。");
  }
  if (!snapshot.expenses.length && !snapshot.advances.length) {
    add("no_evidence", "当前自然周没有可见请款或费用记录。", "owner-scoped 结算快照为空。");
  }
  if (!snapshot.evidence.expenses.complete || !snapshot.evidence.advances.complete) {
    add("invalid_evidence", "请先人工核对费用或请款记录中的异常字段。", "服务端快照存在日期、金额、状态、版本或关联字段异常。");
  }
  if (!snapshot.evidence.fundingSources.complete) {
    add("funding_source", "请先确认每笔付款的资金来源。", "存在无法识别为个人垫付、公司直付或请款资金的付款。");
  }
  if (snapshot.summary.personalSettlementCents === null || !snapshot.evidence.settlement.arithmeticComplete) {
    add("arithmetic", "暂不生成结算金额方向。", "请款或费用金额不完整，无法重建安全公式。");
  }
  if (!snapshot.advances.length) {
    add("advance_record", "请确认本周是否没有请款，或补录请款事实。", "没有请款记录与“到账 0 元”不是同一事实。");
  }
  if ((snapshot.invoiceCoverage.unacknowledgedMissingCents ?? 0) > 0 || !snapshot.evidence.invoiceCoverage.complete) {
    add("invoice_coverage", "请补齐发票覆盖或完成无票人工确认。", "仍有可报销金额没有已确认发票或有效无票确认。");
  }
  if (!snapshot.evidence.settlement.transactionRecorded) {
    add("settlement_transaction", "方向仅为待人工确认预览，尚未记录退款或补款交易。", "系统当前没有由 Agent 写入的退款/补款流水。");
  }
  return blockers;
}

function factsFor(snapshot) {
  const expenseRefs = snapshot.expenses.map((item) => ({ type: "travel_expense", id: item.id }));
  const advanceRefs = snapshot.advances.map((item) => ({ type: "travel_expense_advance", id: item.id }));
  const summaryRefs = [...expenseRefs, ...advanceRefs].slice(0, MAX_ITEMS);
  const summary = snapshot.summary;
  const facts = [
    ["summary.expenseCount", "费用笔数", summary.expenseCount],
    ["summary.paymentCount", "付款笔数", summary.paymentCount],
    ["summary.settlementEligibleCents", "计入个人结算的可报销金额（分）", summary.settlementEligibleCents],
    ["summary.advanceReceivedCents", "已收到请款金额（分）", summary.advanceReceivedCents],
    ["summary.personalSettlementCents", "个人结算差额（分）", summary.personalSettlementCents],
    ["invoiceCoverage.unacknowledgedMissingCents", "未被票据或无票确认覆盖的金额（分）", snapshot.invoiceCoverage.unacknowledgedMissingCents],
  ].flatMap(([key, label, value]) => value === null || value === undefined
    ? []
    : [{ key, label, value, sourceRefs: summaryRefs }]);
  for (const item of snapshot.advances) {
    const refs = [{ type: "travel_expense_advance", id: item.id }];
    for (const [key, label, value] of [
      ["status", "请款状态", item.status],
      ["requestedCents", "申请金额（分）", item.requestedCents],
      ["receivedCents", "到账金额（分）", item.receivedCents],
      ["requestedOn", "申请日期", item.requestedOn],
      ["receivedOn", "到账日期", item.receivedOn],
      ["purpose", "请款事由", item.purpose],
    ]) {
      if (value !== null && value !== undefined) facts.push({ key: `${item.id}.${key}`, label, value, sourceRefs: refs });
    }
  }
  for (const item of snapshot.expenses) {
    const refs = [{ type: "travel_expense", id: item.id }];
    for (const [key, label, value] of [
      ["occurredOn", "发生日期", item.occurredOn],
      ["category", "费用类别", item.category],
      ["purpose", "费用事由", item.purpose],
      ["invoiceStatus", "发票状态", item.invoiceStatus],
      ["reimbursementCents", "可报销金额（分）", item.reimbursementCents],
      ["settlementEligibleCents", "计入个人结算金额（分）", item.settlementEligibleCents],
    ]) {
      if (value !== null && value !== undefined) facts.push({ key: `${item.id}.${key}`, label, value, sourceRefs: refs });
    }
  }
  return facts.slice(0, 500);
}

function makeSettlementPreview(snapshot, blockers) {
  const summary = snapshot.summary;
  const direction = summary.personalSettlementCents === null ? null : summary.settlementDirection;
  const amountCents = summary.personalSettlementCents === null ? null : Math.abs(summary.personalSettlementCents);
  return {
    status: direction && blockers.length === 1 && blockers[0].key === "settlement_transaction"
      ? "ready_for_manual_confirmation"
      : "review_required",
    direction,
    amountCents,
    signedAmountCents: summary.personalSettlementCents,
    formula: {
      settlementEligibleCents: summary.settlementEligibleCents,
      advanceReceivedCents: summary.advanceReceivedCents,
      personalSettlementCents: summary.personalSettlementCents,
      expression: "非公司直付的可报销金额 - 已收到请款金额",
    },
    blockers,
    transaction: {
      recorded: false,
      type: null,
      note: "系统当前只生成方向预览，不记录退款或补款流水。",
    },
    requiresHumanConfirmation: true,
    writebackAllowed: false,
  };
}

export function createAdvanceSettlementAssistantAdapter({
  settlementSnapshotAdapter = null,
  snapshotAdapter = null,
  advanceSnapshotAdapter = null,
  advanceRepository = null,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("advance-settlement manifest is unavailable");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readSnapshot = sourceReader({ settlementSnapshotAdapter, snapshotAdapter, advanceSnapshotAdapter, advanceRepository });

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "advance_summary",
    weekStart = null,
    advanceId = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for advance-settlement", "invalid_advance_settlement_input");
    }
    const normalizedWeekStart = normalizeWeekStart(weekStart, clock);
    const normalizedAdvanceId = identifier(advanceId, "advanceId");
    const input = { taskType, weekStart: normalizedWeekStart, advanceId: normalizedAdvanceId };
    let run = null;
    if (runRepository) {
      run = runRepository.create({
        owner: normalizedOwner,
        channel,
        conversationId,
        eventId,
        agentId: AGENT_ID,
        agentVersion: manifest.version,
        taskType,
        contractVersion: manifest.contractVersion,
        input,
      });
      const replay = run.replayed ? restoreRun(run.item) : null;
      if (replay) return replay;
    }
    try {
      const snapshot = normalizeSnapshot(await readSnapshot({ owner: normalizedOwner, weekStart: normalizedWeekStart }), normalizedWeekStart);
      const filteredAdvances = normalizedAdvanceId
        ? snapshot.advances.filter((item) => item.id === normalizedAdvanceId)
        : snapshot.advances;
      const filteredSnapshot = normalizedAdvanceId
        ? { ...snapshot, advances: filteredAdvances, sourceRefs: refsFor(snapshot.expenses, filteredAdvances) }
        : snapshot;
      const blockers = blockersFor(filteredSnapshot);
      if (normalizedAdvanceId && !filteredAdvances.length) {
        blockers.push(blocker("advance_not_found", "请确认请款编号和自然周。", "owner-scoped 请款快照中没有匹配记录。"));
      }
      const status = filteredSnapshot.expenses.length || filteredSnapshot.advances.length
        ? (blockers.length ? "review_required" : "preview")
        : "not_found";
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        lifecycle: manifest.lifecycle,
        taskType,
        status,
        asOf: filteredSnapshot.asOf,
        weekStart: filteredSnapshot.weekStart,
        advances: filteredSnapshot.advances,
        expenses: filteredSnapshot.expenses,
        summary: filteredSnapshot.summary,
        settlementEvidence: {
          advances: filteredSnapshot.evidence.advances,
          expenses: filteredSnapshot.evidence.expenses,
          fundingSources: filteredSnapshot.evidence.fundingSources,
          invoiceCoverage: filteredSnapshot.invoiceCoverage,
          settlement: filteredSnapshot.evidence.settlement,
        },
        settlementPreview: makeSettlementPreview(filteredSnapshot, blockers),
        truncated: filteredSnapshot.truncated,
        facts: factsFor(filteredSnapshot),
        inferences: [],
        unknowns: blockers,
        sourceRefs: filteredSnapshot.sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          changedFields: [],
          note: "请款结算 Agent 只生成来源可追溯的预览；不创建、修改、删除或记录退款/补款流水。",
        },
        writebackAllowed: false,
      };
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: "deterministic",
          sourceRefs: filteredSnapshot.sourceRefs,
          confirmationStatus: "preview",
        });
      }
      return { ...output, runId: run?.item?.id ?? null, inputSnapshotHash: run?.item?.inputSnapshotHash ?? null };
    } catch (error) {
      if (runRepository && run?.item) {
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "ADVANCE_SETTLEMENT_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, preview: analyze, restore: restoreRun });
}

export { restoreRun as restoreAdvanceSettlementRun };
