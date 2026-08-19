import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "advance-settlement";
const CONTRACT_VERSION = "advance-settlement-v1";
const TASK_TYPES = new Set(["advance_summary", "settlement_preview", "direction_explanation"]);
const ADVANCE_STATUSES = new Set(["draft", "requested", "received", "closed"]);
const MAX_ITEMS = 100;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";

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

function money(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function version(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function currentWeekStart(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const businessDate = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = (businessDate.getUTCDay() + 6) % 7;
  businessDate.setUTCDate(businessDate.getUTCDate() - day);
  return [
    businessDate.getUTCFullYear(),
    String(businessDate.getUTCMonth() + 1).padStart(2, "0"),
    String(businessDate.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function explicitWeekStart(value) {
  const normalized = text(value, "weekStart", 40);
  const date = dateOnly(normalized);
  if (!date || new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new AssistantContractError("weekStart must be a Monday", "invalid_advance_settlement_input");
  }
  return date;
}

function normalizeWeekStart(value, clock) {
  if (value === undefined || value === null || value === "" || value === "current") return currentWeekStart(clock);
  return explicitWeekStart(value);
}

function normalizeAdvance(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "advance.id");
  if (!id) return null;
  const status = ADVANCE_STATUSES.has(value.status) ? value.status : null;
  return {
    id,
    version: version(value.version),
    weekStart: dateOnly(value.weekStart),
    status,
    requestedCents: money(value.requestedCents),
    receivedCents: money(value.receivedCents),
    requestedOn: dateOnly(value.requestedOn),
    receivedOn: dateOnly(value.receivedOn),
    purpose: boundedText(value.purpose, 1000),
    notes: boundedText(value.notes, 2000),
  };
}

function normalizeSnapshot(snapshot, normalizedWeekStart) {
  const rawItems = Array.isArray(snapshot)
    ? snapshot
    : (Array.isArray(snapshot?.items) ? snapshot.items : []);
  const boundedRawItems = rawItems.slice(0, MAX_ITEMS + 1);
  const items = boundedRawItems.map(normalizeAdvance).filter(Boolean);
  const sourceWeekStart = dateOnly(snapshot?.weekStart);
  return {
    weekStart: normalizedWeekStart,
    sourceWeekStart,
    items: items.slice(0, MAX_ITEMS),
    truncated: snapshot?.truncated === true || items.length > MAX_ITEMS || rawItems.length > MAX_ITEMS,
  };
}

function uniqueRefs(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id) || result.length >= MAX_ITEMS) continue;
    seen.add(item.id);
    result.push({ type: "travel_expense_advance", id: item.id });
  }
  return result;
}

function factsFor(items, sourceRefs) {
  const summaryRef = sourceRefs.length ? sourceRefs : [];
  const facts = [{
    key: "summary.advanceCount",
    label: "请款笔数",
    value: items.length,
    sourceRefs: summaryRef,
  }];
  return facts.concat(items.flatMap((item) => {
    const refs = [{ type: "travel_expense_advance", id: item.id }];
    return [
      ["weekStart", "自然周", item.weekStart],
      ["status", "请款状态", item.status],
      ["requestedCents", "申请金额（分）", item.requestedCents],
      ["receivedCents", "到账金额（分）", item.receivedCents],
      ["requestedOn", "申请日期", item.requestedOn],
      ["receivedOn", "到账日期", item.receivedOn],
      ["purpose", "请款事由", item.purpose],
      ["notes", "备注", item.notes],
      ["version", "记录版本", item.version],
    ].flatMap(([key, label, value]) => value === null || value === undefined
      ? []
      : [{ key: `${item.id}.${key}`, label, value, sourceRefs: refs }]);
  }));
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

function sourceReader({ advanceSnapshotAdapter, snapshotAdapter, advanceRepository }) {
  const source = advanceSnapshotAdapter ?? snapshotAdapter ?? advanceRepository;
  if (!source) throw new TypeError("owner-scoped advance snapshot adapter is required");
  if (typeof source.advanceSummary === "function") {
    return ({ owner, weekStart }) => source.advanceSummary({ owner, weekStart });
  }
  if (typeof source.listAdvances === "function") {
    return ({ owner, weekStart }) => ({
      weekStart,
      items: source.listAdvances({ owner, weekStart }),
      truncated: false,
    });
  }
  throw new TypeError("owner-scoped advance snapshot adapter must expose advanceSummary or listAdvances");
}

export function createAdvanceSettlementAssistantAdapter({
  advanceSnapshotAdapter = null,
  snapshotAdapter = null,
  advanceRepository = null,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("advance-settlement manifest is unavailable");
  if (manifest.lifecycle !== "draft") throw new TypeError("advance-settlement manifest must remain draft");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readAdvances = sourceReader({ advanceSnapshotAdapter, snapshotAdapter, advanceRepository });

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
    const requestedWeekStart = weekStart === undefined || weekStart === null || weekStart === ""
      ? null
      : text(weekStart, "weekStart", 40);
    if (requestedWeekStart !== null && requestedWeekStart !== "current") explicitWeekStart(requestedWeekStart);
    const normalizedAdvanceId = identifier(advanceId, "advanceId");
    const input = { taskType, weekStart: requestedWeekStart, advanceId: normalizedAdvanceId };
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
      const normalizedWeekStart = normalizeWeekStart(requestedWeekStart, clock);
      const snapshot = normalizeSnapshot(await readAdvances({ owner: normalizedOwner, weekStart: normalizedWeekStart }), normalizedWeekStart);
      const items = normalizedAdvanceId
        ? snapshot.items.filter((item) => item.id === normalizedAdvanceId)
        : snapshot.items;
      const sourceRefs = uniqueRefs(items);
      const blockers = [
        {
          key: "settlement_evidence",
          question: "请先人工核对费用、资金来源和退款/补款依据。",
          reason: "当前草稿 Agent 只读取请款记录，尚未接入完整结算证据合同。",
        },
        {
          key: "settlement_direction",
          question: "暂不生成应退、应补或结算金额方向。",
          reason: "请款事实不足以单独得出结算方向，且该 Agent 仍处于 draft 状态。",
        },
      ];
      if (snapshot.truncated) {
        blockers.push({
          key: "truncated",
          question: "请在费用系统中继续分批查看全部请款记录。",
          reason: "服务端请款快照达到单次返回上限，Agent 不会静默丢弃记录。",
        });
      }
      if (snapshot.sourceWeekStart && snapshot.sourceWeekStart !== normalizedWeekStart) {
        blockers.push({
          key: "week_mismatch",
          question: "请重新加载指定自然周的请款记录。",
          reason: "数据适配器返回的自然周与请求不一致，Agent 不会把跨周记录当作当前事实。",
        });
      }
      if (!items.length) {
        blockers.push({
          key: normalizedAdvanceId ? "advance_not_found" : "advances",
          question: normalizedAdvanceId ? "请确认请款编号和自然周。" : "当前自然周没有可见请款记录。",
          reason: normalizedAdvanceId ? "owner-scoped 请款快照中没有匹配记录。" : "owner-scoped 请款快照为空。",
        });
      }
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        lifecycle: manifest.lifecycle,
        taskType,
        status: "review_required",
        weekStart: snapshot.weekStart,
        advances: items,
        truncated: snapshot.truncated,
        settlementPreview: null,
        facts: factsFor(items, sourceRefs),
        inferences: [],
        unknowns: blockers,
        sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          changedFields: [],
          note: "请款结算 Agent 当前只读且未注册工具；不执行创建、修改、删除或金额/状态写入。",
        },
        writebackAllowed: false,
      };
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: "deterministic",
          sourceRefs,
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

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreAdvanceSettlementRun };
