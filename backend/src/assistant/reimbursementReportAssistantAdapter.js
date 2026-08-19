import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "reimbursement-report";
const CONTRACT_VERSION = "reimbursement-report-v1";
const TASK_TYPES = new Set(["weekly_summary", "invoice_coverage", "print_readiness"]);
const MAX_ITEMS = 100;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_reimbursement_report_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_reimbursement_report_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_reimbursement_report_input");
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

function invoiceCoverage(items) {
  const counts = {};
  for (const item of items) {
    const key = item.invoiceStatus ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { counts, source: "server_snapshot", conclusion: null };
}

function factsFor(items, summary) {
  return [
    ["count", "费用笔数", summary.count],
    ["actualPaidCents", "实付金额（分）", summary.actualPaidCents],
    ["reimbursementCents", "可报销金额（分）", summary.reimbursementCents],
    ["invalidAmountCount", "金额异常笔数", summary.invalidAmountCount],
  ].flatMap(([key, label, value]) => value !== null && value !== undefined
    ? [{ key: `summary.${key}`, label, value, sourceRefs: [] }]
    : []).concat(items.flatMap((item) => {
      const sourceRefs = [{ type: "travel_expense", id: item.id }];
      return [
        ["invoiceStatus", "发票状态", item.invoiceStatus],
        ["actualPaidCents", "实付金额（分）", item.actualPaidCents],
        ["reimbursementCents", "可报销金额（分）", item.reimbursementCents],
      ].flatMap(([key, label, value]) => value !== null && value !== undefined
        ? [{ key: `${item.id}.${key}`, label, value, sourceRefs }]
        : []);
    }));
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createReimbursementReportAssistantAdapter({ snapshotAdapter, runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("reimbursement-report manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.travelExpenseSummary !== "function") {
    throw new TypeError("owner-scoped expense snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "weekly_summary",
    weekStart = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for reimbursement-report", "invalid_reimbursement_report_input");
    }
    const normalizedWeekStart = optionalText(weekStart, "weekStart", 40);
    const input = { taskType, weekStart: normalizedWeekStart };
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
        invalidAmountCount: Number.isSafeInteger(snapshot?.summary?.invalidAmountCount) && snapshot.summary.invalidAmountCount >= 0 ? snapshot.summary.invalidAmountCount : 0,
      };
      const sourceRefs = uniqueRefs(items.map((item) => item.id));
      const coverage = invoiceCoverage(items);
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        taskType,
        status: "preview",
        weekStart: snapshot?.weekStart ?? normalizedWeekStart,
        summary,
        items,
        truncated: snapshot?.truncated === true,
        invoiceCoverage: coverage,
        printReadiness: {
          ready: null,
          blockers: ["当前适配器只提供费用和发票快照，打印规则与人工确认状态尚未由 Agent 代替。"],
        },
        facts: factsFor(items, summary),
        inferences: [],
        unknowns: summary.invalidAmountCount > 0
          ? [{ key: "invalid_amounts", question: "请先人工核对金额异常费用。", reason: "服务端费用摘要包含异常金额。" }]
          : [],
        sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          changedFields: [],
          note: "报销周汇总只读预览，不代表已保存、已打印或已提交。",
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "REIMBURSEMENT_REPORT_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreReimbursementReportRun };
