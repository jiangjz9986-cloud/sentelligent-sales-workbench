import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "travel-expense";
const CONTRACT_VERSION = "travel-expense-v1";
const TASK_TYPES = new Set(["weekly_summary", "expense_review", "entry_preview"]);
const MAX_ITEMS = 100;
const PREVIEW_FIELDS = new Set(["purpose", "category"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_travel_expense_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_travel_expense_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_travel_expense_input");
  }
  return normalized;
}

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function money(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeItem(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "expense.id");
  if (!id) return null;
  return {
    id,
    occurredOn: boundedText(value.occurredOn, 40),
    category: boundedText(value.category, 100),
    purpose: boundedText(value.purpose, 500),
    invoiceStatus: boundedText(value.invoiceStatus, 60),
    actualPaidCents: money(value.actualPaidCents),
    reimbursementCents: money(value.reimbursementCents),
  };
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map(normalizeItem).filter(Boolean);
}

function uniqueRefs(items) {
  const result = [];
  const seen = new Set();
  for (const id of items) {
    if (seen.has(id) || result.length >= MAX_ITEMS) continue;
    seen.add(id);
    result.push({ type: "travel_expense", id });
  }
  return result;
}

function factsFor(items, summary) {
  const facts = [
    ["count", "费用笔数", summary.count],
    ["actualPaidCents", "实付金额（分）", summary.actualPaidCents],
    ["reimbursementCents", "可报销金额（分）", summary.reimbursementCents],
    ["invalidAmountCount", "金额异常笔数", summary.invalidAmountCount],
  ].flatMap(([key, label, value]) => value !== null && value !== undefined
    ? [{ key: `summary.${key}`, label, value, sourceRefs: [] }]
    : []);
  return facts.concat(items.flatMap((item) => {
    const sourceRefs = [{ type: "travel_expense", id: item.id }];
    return [
      ["occurredOn", "发生日期", item.occurredOn],
      ["category", "费用类别", item.category],
      ["purpose", "费用事由", item.purpose],
      ["invoiceStatus", "发票状态", item.invoiceStatus],
      ["actualPaidCents", "实付金额（分）", item.actualPaidCents],
      ["reimbursementCents", "可报销金额（分）", item.reimbursementCents],
    ].flatMap(([key, label, value]) => value !== null && value !== undefined
      ? [{ key: `${item.id}.${key}`, label, value, sourceRefs }]
      : []);
  }));
}

function changePreview(item, changes) {
  if (!item || !isPlainObject(changes)) return null;
  const changedFields = [];
  const before = {};
  const after = {};
  const rejectedFields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!PREVIEW_FIELDS.has(key)) {
      rejectedFields.push(key);
      continue;
    }
    const next = boundedText(value, key === "purpose" ? 500 : 100);
    if (!next) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = item[key] ?? null;
    after[key] = next;
    if (before[key] !== next) changedFields.push(key);
  }
  return {
    entity: "travel_expense",
    expenseId: item.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    protectedFields: ["actualPaidCents", "reimbursementCents", "invoiceStatus", "version", "owner"],
    requiresHumanConfirmation: true,
  };
}

function outputBase({ status, taskType, weekStart, summary, items, truncated, sourceRefs, change }) {
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    weekStart,
    summary,
    items,
    truncated,
    facts: factsFor(items, summary),
    inferences: [],
    unknowns: summary.invalidAmountCount > 0
      ? [{ key: "invalid_amounts", question: "请在费用系统中人工核对金额和可报销金额。", reason: "服务端检测到金额不满足实付/可报销约束，Agent 不会修正或猜测。" }]
      : items.length ? [] : [{ key: "expenses", question: "当前自然周没有可见费用。", reason: "服务端费用快照为空。" }],
    sourceRefs,
    entryPreview: taskType === "expense_review" ? { recommendations: [], note: "当前只展示服务端费用事实，不生成财务处理结论。" } : null,
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "差旅费用写入工具尚未开放；金额、可报销额、发票状态和版本保持只读。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createTravelExpenseAssistantAdapter({ snapshotAdapter, runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("travel-expense manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.travelExpenseSummary !== "function") {
    throw new TypeError("owner-scoped travel-expense snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "weekly_summary",
    weekStart = null,
    expenseId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for travel-expense", "invalid_travel_expense_input");
    }
    const normalizedWeekStart = optionalText(weekStart, "weekStart", 40);
    const normalizedExpenseId = identifier(expenseId, "expenseId");
    const input = {
      taskType,
      weekStart: normalizedWeekStart,
      expenseId: normalizedExpenseId,
      changes: isPlainObject(changes) ? changes : null,
    };
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
      const snapshot = snapshotAdapter.travelExpenseSummary({ owner: normalizedOwner, weekStart: normalizedWeekStart });
      const items = normalizeItems(snapshot?.items);
      const summary = {
        count: Number.isSafeInteger(snapshot?.summary?.count) && snapshot.summary.count >= 0 ? snapshot.summary.count : items.length,
        actualPaidCents: money(snapshot?.summary?.actualPaidCents),
        reimbursementCents: money(snapshot?.summary?.reimbursementCents),
        invalidAmountCount: Number.isSafeInteger(snapshot?.summary?.invalidAmountCount) && snapshot.summary.invalidAmountCount >= 0
          ? snapshot.summary.invalidAmountCount
          : 0,
      };
      const filteredItems = normalizedExpenseId ? items.filter((item) => item.id === normalizedExpenseId) : items;
      const target = normalizedExpenseId ? filteredItems.find((item) => item.id === normalizedExpenseId) ?? null : null;
      const change = taskType === "entry_preview" ? changePreview(target, changes) : null;
      const status = taskType === "entry_preview" && (!target || !change || !change.changedFields.length)
        ? "review_required"
        : filteredItems.length || summary.count > 0 ? "ok" : "not_found";
      const sourceRefs = uniqueRefs(filteredItems.map((item) => item.id));
      const output = outputBase({
        status,
        taskType,
        weekStart: snapshot?.weekStart ?? normalizedWeekStart,
        summary,
        items: filteredItems,
        truncated: snapshot?.truncated === true,
        sourceRefs,
        change,
      });
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "TRAVEL_EXPENSE_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreTravelExpenseRun };
