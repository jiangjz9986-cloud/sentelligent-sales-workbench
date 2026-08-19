import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "customer";
const CONTRACT_VERSION = "customer-v1";
const TASK_TYPES = new Set(["search", "detail", "summarize", "change_preview"]);
const MAX_ITEMS = 100;
const MAX_TEXT = 2_000;
const CHANGEABLE_FIELDS = new Set(["name", "region", "type", "level"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_customer_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_customer_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_customer_input");
  }
  return normalized;
}

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function sourceRef(id) {
  const normalized = identifier(id, "sourceRef.id");
  return normalized ? { type: "customer", id: normalized } : null;
}

function uniqueRefs(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const key = `${item.type}\u0000${item.id}`;
    if (seen.has(key) || result.length >= 100) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeCustomer(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "customer.id");
  if (!id) return null;
  return {
    id,
    name: boundedText(value.name, 300),
    region: boundedText(value.region, 120),
    type: boundedText(value.type, 120),
    level: boundedText(value.level, 120),
    updatedAt: boundedText(value.updatedAt, 100),
  };
}

function normalizeMatches(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map(normalizeCustomer).filter(Boolean);
}

function factsFor(customer) {
  if (!customer) return [];
  const ref = sourceRef(customer.id);
  return [
    ["name", "客户名称", customer.name],
    ["region", "区域", customer.region],
    ["type", "类型", customer.type],
    ["level", "级别", customer.level],
    ["updatedAt", "更新时间", customer.updatedAt],
  ].flatMap(([key, label, value]) => value
    ? [{ key, label, value, sourceRefs: ref ? [ref] : [] }]
    : []);
}

function unknownsFor(customer) {
  if (!customer) return [{ key: "customer", question: "请先确认要查看的客户。", reason: "没有唯一的服务端客户快照。" }];
  return [
    ["contact", "请补充客户联系人和角色。"],
    ["decision_chain", "请补充客户决策链和预算路径。"],
  ].map(([key, question]) => ({ key, question, reason: "当前客户详情工具未提供该字段，不能由 Agent 猜测。" }));
}

function changePreview(customer, changes) {
  if (!customer || !isPlainObject(changes)) return null;
  const changedFields = [];
  const before = {};
  const after = {};
  const rejectedFields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!CHANGEABLE_FIELDS.has(key)) {
      rejectedFields.push(key);
      continue;
    }
    const next = boundedText(value, 300);
    if (!next) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = customer[key] ?? null;
    after[key] = next;
    if (before[key] !== next) changedFields.push(key);
  }
  return {
    entity: "customer",
    customerId: customer.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    requiresHumanConfirmation: true,
  };
}

function outputBase({ status, taskType, customer, matches, sourceRefs, facts, unknowns, change }) {
  const textSummary = customer
    ? `${customer.name ?? "客户"}（${customer.region ?? "区域待确认"}，${customer.type ?? "类型待确认"}，${customer.level ?? "级别待确认"}）`
    : "当前没有唯一客户结果。";
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    customer,
    matches,
    headline: textSummary,
    facts,
    inferences: customer ? [{ claim: "当前仅能确认服务端返回的客户基础字段，不能据此推断关系或决策权。", sourceRefs }] : [],
    unknowns,
    sourceRefs,
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "客户写入工具尚未开放；当前只生成预览，不执行新增、修改或删除。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createCustomerAssistantAdapter({
  snapshotAdapter,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("customer manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.customerSearch !== "function" || typeof snapshotAdapter.customerDetail !== "function") {
    throw new TypeError("owner-scoped customer snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function search(owner, query) {
    const result = snapshotAdapter.customerSearch({ owner, query: text(query, "query", 200) });
    return normalizeMatches(result?.items);
  }

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "detail",
    query = null,
    customerId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for customer", "invalid_customer_input");
    }
    const normalizedId = identifier(customerId, "customerId");
    const normalizedQuery = optionalText(query, "query", 200);
    const input = { taskType, customerId: normalizedId, query: normalizedQuery, changes: isPlainObject(changes) ? changes : null };
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
      let customer = normalizedId
        ? normalizeCustomer(snapshotAdapter.customerDetail({ owner: normalizedOwner, customerId: normalizedId }))
        : null;
      let matches = [];
      if (!customer && normalizedQuery) matches = search(normalizedOwner, normalizedQuery);
      if (!customer && matches.length === 1) customer = matches[0];
      const refs = uniqueRefs([
        customer ? sourceRef(customer.id) : null,
        ...matches.map((item) => sourceRef(item.id)),
      ]);
      let status = "ok";
      if (!customer && matches.length === 0) status = "not_found";
      if (!customer && matches.length > 1) status = "clarify";
      if (taskType === "change_preview" && !customer) status = matches.length > 1 ? "clarify" : "not_found";
      const change = taskType === "change_preview" ? changePreview(customer, changes) : null;
      if (taskType === "change_preview" && customer && !change?.changedFields.length) status = "review_required";
      const output = outputBase({
        status,
        taskType,
        customer,
        matches,
        sourceRefs: refs,
        facts: factsFor(customer),
        unknowns: status === "clarify"
          ? [{ key: "ambiguity", question: "请从候选列表中确认唯一客户。", reason: "服务端返回多个匹配项。" }]
          : unknownsFor(customer),
        change,
      });
      if (runRepository && run?.item) {
        run = runRepository.complete(run.item.id, {
          owner: normalizedOwner,
          output,
          source: "deterministic",
          sourceRefs: refs,
          confirmationStatus: "preview",
        });
      }
      return { ...output, runId: run?.item?.id ?? null, inputSnapshotHash: run?.item?.inputSnapshotHash ?? null };
    } catch (error) {
      if (runRepository && run?.item) {
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "CUSTOMER_ADAPTER_FAILED" }); } catch { /* preserve error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, search, detail: analyze, restore: restoreRun });
}

export { restoreRun as restoreCustomerRun };
