import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "dashboard";
const CONTRACT_VERSION = "dashboard-v1";
const TASK_TYPES = new Set(["daily_overview", "weekly_overview", "focus_summary"]);
const COUNT_KEYS = ["customers", "opportunities", "openActions", "activeRisks", "upcomingItineraries", "currentWeekExpenses"];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_dashboard_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_dashboard_input");
  return normalized;
}

function boundedDateTime(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value.trim();
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeSummary(value) {
  const counts = {};
  for (const key of COUNT_KEYS) counts[key] = count(value?.counts?.[key]);
  return {
    asOf: boundedDateTime(value?.asOf),
    weekStart: typeof value?.weekStart === "string" ? value.weekStart.trim() : null,
    counts,
  };
}

function factsFor(summary) {
  const sourceRefs = summary.weekStart ? [{ type: "dashboard", id: summary.weekStart }] : [];
  return COUNT_KEYS.flatMap((key) => summary.counts[key] === null
    ? []
    : [{ key: `counts.${key}`, label: key, value: summary.counts[key], sourceRefs }]);
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createDashboardAssistantAdapter({ snapshotAdapter, runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("dashboard manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.dashboardSummary !== "function") {
    throw new TypeError("owner-scoped dashboard snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({ owner, channel = "assistant", conversationId = null, eventId = null, taskType = "daily_overview" } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for dashboard", "invalid_dashboard_input");
    }
    const input = { taskType };
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
      const summary = normalizeSummary(snapshotAdapter.dashboardSummary({ owner: normalizedOwner }));
      const sourceRefs = summary.weekStart ? [{ type: "dashboard", id: summary.weekStart }] : [];
      const output = {
        schemaVersion: CONTRACT_VERSION,
        agentId: AGENT_ID,
        taskType,
        status: "ok",
        asOf: summary.asOf,
        weekStart: summary.weekStart,
        counts: summary.counts,
        facts: factsFor(summary),
        inferences: [],
        unknowns: summary.asOf ? [] : [{ key: "asOf", question: "请确认总览快照时间。", reason: "服务端没有提供可信的截至时间。" }],
        sourceRefs,
        writebackPreview: {
          requiresHumanConfirmation: true,
          allowed: false,
          changedFields: [],
          note: "总览 Agent 只读，不执行任何业务写入。",
        },
        writebackAllowed: false,
      };
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: "deterministic",
          sourceRefs,
          confirmationStatus: "not_required",
        });
      }
      return { ...output, runId: run?.item?.id ?? null, inputSnapshotHash: run?.item?.inputSnapshotHash ?? null };
    } catch (error) {
      if (runRepository && run?.item) {
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "DASHBOARD_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreDashboardRun };
