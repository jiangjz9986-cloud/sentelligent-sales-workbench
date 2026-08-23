import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "knowledge";
const CONTRACT_VERSION = "knowledge-v1";
const TASK_TYPES = new Set(["search", "answer_with_sources", "compare", "maintenance_preview"]);
const MAX_ITEMS = 10;
const CHANGEABLE_FIELDS = new Set(["title", "category", "summary", "source"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_knowledge_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_knowledge_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_knowledge_input");
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
  const id = identifier(value.id, "knowledge.id");
  if (!id) return null;
  return {
    id,
    title: boundedText(value.title, 300),
    category: boundedText(value.category, 120),
    summary: boundedText(value.summary, 1_000),
    source: boundedText(value.source, 300),
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
    const key = `knowledge\u0000${id}`;
    if (seen.has(key) || result.length >= MAX_ITEMS) continue;
    seen.add(key);
    result.push({ type: "knowledge", id });
  }
  return result;
}

function factsFor(items) {
  return items.flatMap((item) => {
    const sourceRefs = [{ type: "knowledge", id: item.id }];
    return [
      ["title", "知识标题", item.title],
      ["category", "知识分类", item.category],
      ["summary", "知识摘要", item.summary],
      ["source", "知识来源", item.source],
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
    const next = boundedText(value, key === "summary" ? 1_000 : 300);
    if (!next) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = item[key] ?? null;
    after[key] = next;
    if (before[key] !== next) changedFields.push(key);
  }
  return {
    entity: "knowledge",
    knowledgeId: item.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    requiresHumanConfirmation: true,
  };
}

function outputBase({ status, taskType, query, items, sourceRefs, change }) {
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    query,
    items,
    truncated: false,
    facts: factsFor(items),
    inferences: [],
    unknowns: items.length
      ? []
      : [{ key: "knowledge", question: "请补充更具体的检索词或确认知识库范围。", reason: "服务端没有返回匹配条目，Agent 不会编造答案。" }],
    sourceRefs,
    answer: taskType === "answer_with_sources"
      ? { text: null, requiresHumanReview: true, note: "当前适配器只返回带来源的摘要，不生成无证据答案。" }
      : null,
    comparison: taskType === "compare"
      ? { items: items.map((item) => item.id), conclusion: null, note: "比较结论需由后续明确的分析 Agent 生成。" }
      : null,
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "知识写入工具尚未开放；当前只生成维护预览，不执行新增、修改或删除。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createKnowledgeAssistantAdapter({
  snapshotAdapter,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("knowledge manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.knowledgeSearch !== "function") {
    throw new TypeError("bounded knowledge snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "search",
    query,
    knowledgeId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for knowledge", "invalid_knowledge_input");
    }
    const normalizedQuery = text(query, "query", 200);
    const normalizedKnowledgeId = identifier(knowledgeId, "knowledgeId");
    const input = {
      taskType,
      query: normalizedQuery,
      knowledgeId: normalizedKnowledgeId,
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
      // Knowledge is currently a bounded shared catalog. The authenticated
      // owner is retained in the run/audit scope, but is never sent as a
      // caller-controlled filter to the shared read-only query.
      const result = snapshotAdapter.knowledgeSearch({ query: normalizedQuery });
      let items = normalizeItems(result?.items);
      if (normalizedKnowledgeId) items = items.filter((item) => item.id === normalizedKnowledgeId);
      const target = normalizedKnowledgeId ? items.find((item) => item.id === normalizedKnowledgeId) ?? null : null;
      const change = taskType === "maintenance_preview" ? changePreview(target, changes) : null;
      const status = taskType === "maintenance_preview" && (!target || !change || !change.changedFields.length)
        ? "review_required"
        : items.length ? "ok" : "not_found";
      const sourceRefs = uniqueRefs(items.map((item) => item.id));
      const output = outputBase({
        status,
        taskType,
        query: normalizedQuery,
        items,
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "KNOWLEDGE_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, search: analyze, restore: restoreRun });
}

export { restoreRun as restoreKnowledgeRun };
