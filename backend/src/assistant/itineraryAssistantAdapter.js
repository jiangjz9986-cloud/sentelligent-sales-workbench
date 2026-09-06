import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "itinerary";
const CONTRACT_VERSION = "itinerary-v1";
const TASK_TYPES = new Set(["summary", "plan_preview", "optimize_order", "change_preview"]);
const MAX_ITEMS = 100;
const CHANGEABLE_FIELDS = new Set(["title", "visitDate"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new AssistantContractError(`${name} is required`, "invalid_itinerary_input");
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_itinerary_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_itinerary_input");
  }
  return normalized;
}

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function normalizeItem(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "itinerary.id");
  if (!id) return null;
  return {
    id,
    title: boundedText(value.title, 500),
    visitDate: boundedText(value.visitDate, 40),
    status: boundedText(value.status, 60),
    createdAt: boundedText(value.createdAt, 100),
    updatedAt: boundedText(value.updatedAt, 100),
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
    result.push({ type: "itinerary", id });
  }
  return result;
}

function factsFor(items) {
  return items.flatMap((item) => {
    const sourceRefs = [{ type: "itinerary", id: item.id }];
    return [
      ["title", "行程标题", item.title],
      ["visitDate", "拜访日期", item.visitDate],
      ["status", "行程状态", item.status],
      ["createdAt", "创建时间", item.createdAt],
      ["updatedAt", "更新时间", item.updatedAt],
    ].flatMap(([key, label, value]) => value !== null
      ? [{ key: `${item.id}.${key}`, label, value, sourceRefs }]
      : []);
  });
}

function changePreview(item, changes) {
  if (!item || !isPlainObject(changes)) return null;
  const changedFields = [];
  const before = {};
  const after = {};
  const rejectedFields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!CHANGEABLE_FIELDS.has(key)) {
      rejectedFields.push(key);
      continue;
    }
    const next = boundedText(value, key === "title" ? 500 : 40);
    if (!next) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = item[key] ?? null;
    after[key] = next;
    if (before[key] !== next) changedFields.push(key);
  }
  return {
    entity: "itinerary",
    itineraryId: item.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    requiresHumanConfirmation: true,
  };
}

function outputBase({ status, taskType, items, truncated, sourceRefs, change }) {
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    items,
    truncated,
    facts: factsFor(items),
    inferences: [],
    unknowns: items.length
      ? []
      : [{ key: "itinerary", question: "当前没有可见行程。", reason: "服务端行程快照为空，Agent 不会生成不存在的拜访安排。" }],
    sourceRefs,
    planPreview: ["plan_preview", "optimize_order"].includes(taskType)
      ? { items: [], route: null, recommendation: null, note: "当前适配器没有路线规划输入，不生成地址或顺序建议。" }
      : null,
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "行程写入工具尚未开放；当前只生成标题/日期预览，不执行保存、删除或路线变更。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createItineraryAssistantAdapter({ snapshotAdapter, runRepository = null, clock = () => new Date() } = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("itinerary manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.itinerarySummary !== "function") {
    throw new TypeError("owner-scoped itinerary snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "summary",
    itineraryId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for itinerary", "invalid_itinerary_input");
    }
    const normalizedId = identifier(itineraryId, "itineraryId");
    const input = { taskType, itineraryId: normalizedId, changes: isPlainObject(changes) ? changes : null };
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
      const snapshot = snapshotAdapter.itinerarySummary({ owner: normalizedOwner });
      let items = normalizeItems(snapshot?.items);
      if (normalizedId) items = items.filter((item) => item.id === normalizedId);
      const target = normalizedId ? items.find((item) => item.id === normalizedId) ?? null : null;
      const change = taskType === "change_preview" ? changePreview(target, changes) : null;
      const status = taskType === "change_preview" && (!target || !change || !change.changedFields.length)
        ? "review_required"
        : items.length ? "ok" : "not_found";
      const sourceRefs = uniqueRefs(items.map((item) => item.id));
      const output = outputBase({
        status,
        taskType,
        items,
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "ITINERARY_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreItineraryRun };
