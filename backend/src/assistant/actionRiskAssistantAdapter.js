import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "action-risk";
const CONTRACT_VERSION = "action-risk-v1";
const TASK_TYPES = new Set(["summary", "prioritize", "follow_up_preview", "status_change_preview"]);
const MAX_ITEMS = 100;
const MAX_TEXT = 2_000;
const PREVIEW_FIELDS = new Set(["status", "due", "priority"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_action_risk_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new AssistantContractError(`${name} is too long`, "invalid_action_risk_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_action_risk_input");
  }
  return normalized;
}

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function boundedScore(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function normalizeItem(value, kind) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, `${kind}.id`);
  if (!id) return null;
  return {
    id,
    kind,
    customerId: identifier(value.customerId, `${kind}.customerId`),
    opportunityId: identifier(value.opportunityId, `${kind}.opportunityId`),
    title: boundedText(value.title, 500),
    status: boundedText(value.status, 60),
    due: boundedText(value.due, 40),
    priority: boundedText(value.priority, 60),
    severity: boundedText(value.severity, 60),
    score: boundedScore(value.score),
    updatedAt: boundedText(value.updatedAt, 100),
  };
}

function normalizeItems(value, kind) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map((item) => normalizeItem(item, kind)).filter(Boolean);
}

function refsFor(item) {
  if (!item) return [];
  const refs = [
    item.customerId ? { type: "customer", id: item.customerId } : null,
    item.opportunityId ? { type: "opportunity", id: item.opportunityId } : null,
    { type: item.kind, id: item.id },
  ];
  const result = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key) || result.length >= MAX_ITEMS) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function uniqueRefs(items) {
  const result = [];
  const seen = new Set();
  for (const ref of items) {
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key) || result.length >= MAX_ITEMS) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function factsFor(actions, risks) {
  return [...actions, ...risks].flatMap((item) => {
    const sourceRefs = refsFor(item);
    return [
      [`${item.kind}.${item.id}.title`, `${item.kind}.${item.id}.title`, item.title],
      [`${item.kind}.${item.id}.status`, `${item.kind}.${item.id}.status`, item.status],
      [`${item.kind}.${item.id}.due`, `${item.kind}.${item.id}.due`, item.due],
      [`${item.kind}.${item.id}.priority`, `${item.kind}.${item.id}.priority`, item.priority],
      [`${item.kind}.${item.id}.severity`, `${item.kind}.${item.id}.severity`, item.severity],
      [`${item.kind}.${item.id}.score`, `${item.kind}.${item.id}.score`, item.score],
    ].flatMap(([key, label, value]) => value !== null && value !== undefined
      ? [{ key, label, value, sourceRefs }]
      : []);
  });
}

function changePreview(target, changes) {
  if (!target || !isPlainObject(changes)) return null;
  const changedFields = [];
  const before = {};
  const after = {};
  const rejectedFields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!PREVIEW_FIELDS.has(key)) {
      rejectedFields.push(key);
      continue;
    }
    const next = boundedText(value, 100);
    if (!next) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = target[key] ?? null;
    after[key] = next;
    if (before[key] !== next) changedFields.push(key);
  }
  return {
    entity: target.kind,
    targetId: target.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    requiresHumanConfirmation: true,
  };
}

function outputBase({
  status,
  taskType,
  customerId,
  opportunityId,
  actions,
  risks,
  truncated,
  sourceRefs,
  change,
}) {
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    filters: { customerId, opportunityId },
    actions,
    risks,
    truncated,
    facts: factsFor(actions, risks),
    inferences: [],
    unknowns: actions.length || risks.length
      ? []
      : [{ key: "actions_risks", question: "当前筛选范围没有未完成行动或活跃风险。", reason: "服务端摘要返回空集合，Agent 不会推断不存在的事项。" }],
    sourceRefs,
    prioritization: {
      mode: "server_order",
      recommendations: [],
      note: "当前结果沿用服务端行动/风险排序，不把排序伪装成销售决策建议。",
    },
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "行动和风险写入工具尚未开放；当前只生成预览，不执行状态、截止日或优先级修改。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createActionRiskAssistantAdapter({
  snapshotAdapter,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("action-risk manifest is unavailable");
  if (!snapshotAdapter || typeof snapshotAdapter.actionRiskSummary !== "function") {
    throw new TypeError("owner-scoped action-risk snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "summary",
    customerId = null,
    opportunityId = null,
    actionId = null,
    riskId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for action-risk", "invalid_action_risk_input");
    }
    const normalizedCustomerId = identifier(customerId, "customerId");
    const normalizedOpportunityId = identifier(opportunityId, "opportunityId");
    const normalizedActionId = identifier(actionId, "actionId");
    const normalizedRiskId = identifier(riskId, "riskId");
    const input = {
      taskType,
      customerId: normalizedCustomerId,
      opportunityId: normalizedOpportunityId,
      actionId: normalizedActionId,
      riskId: normalizedRiskId,
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
      const snapshot = snapshotAdapter.actionRiskSummary({
        owner: normalizedOwner,
        customerId: normalizedCustomerId,
        opportunityId: normalizedOpportunityId,
      });
      const actions = normalizeItems(snapshot?.actions, "action");
      const risks = normalizeItems(snapshot?.risks, "risk");
      const target = normalizedActionId
        ? actions.find((item) => item.id === normalizedActionId) ?? null
        : normalizedRiskId
          ? risks.find((item) => item.id === normalizedRiskId) ?? null
          : null;
      const previewTask = ["follow_up_preview", "status_change_preview"].includes(taskType);
      const change = previewTask
        ? changePreview(target, changes)
        : null;
      const status = previewTask && (!target || !change || !change.changedFields.length)
        ? "review_required"
        : "ok";
      const sourceRefs = uniqueRefs([...actions, ...risks].flatMap(refsFor));
      const output = outputBase({
        status,
        taskType,
        customerId: normalizedCustomerId,
        opportunityId: normalizedOpportunityId,
        actions,
        risks,
        truncated: {
          actions: snapshot?.truncated?.actions === true,
          risks: snapshot?.truncated?.risks === true,
        },
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
        try { runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "ACTION_RISK_ADAPTER_FAILED" }); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  return Object.freeze({ analyze, summary: analyze, restore: restoreRun });
}

export { restoreRun as restoreActionRiskRun };
