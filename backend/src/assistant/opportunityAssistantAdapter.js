import { AssistantContractError } from "./contracts.js";
import { getAgentManifest } from "./agentManifest.js";

const AGENT_ID = "opportunity";
const CONTRACT_VERSION = "opportunity-v1";
const TASK_TYPES = new Set(["search", "detail", "stage_review", "change_preview"]);
const MAX_ITEMS = 100;
const MAX_TEXT = 2_000;
const CHANGEABLE_FIELDS = new Set(["name", "risk", "next"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssistantContractError(`${name} is required`, "invalid_opportunity_input");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new AssistantContractError(`${name} is too long`, "invalid_opportunity_input");
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
    throw new AssistantContractError(`${name} is invalid`, "invalid_opportunity_input");
  }
  return normalized;
}

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function boundedProbability(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 100
    ? value
    : null;
}

function boundedDays(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sourceRef(type, id) {
  const normalized = identifier(id, "sourceRef.id");
  return normalized ? { type, id: normalized } : null;
}

function uniqueRefs(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (!item) continue;
    const key = `${item.type}\u0000${item.id}`;
    if (seen.has(key) || result.length >= MAX_ITEMS) continue;
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
  };
}

function normalizeOpportunity(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "opportunity.id");
  if (!id) return null;
  return {
    id,
    customerId: identifier(value.customerId, "opportunity.customerId"),
    name: boundedText(value.name, 300),
    customer: boundedText(value.customer, 300),
    stage: boundedText(value.stage, 120),
    amount: boundedText(value.amount, 120),
    probability: boundedProbability(value.probability),
    days: boundedDays(value.days),
    risk: boundedText(value.risk, 500),
    next: boundedText(value.next, 500),
    updatedAt: boundedText(value.updatedAt, 100),
  };
}

function refsFor(opportunity) {
  if (!opportunity) return [];
  return uniqueRefs([
    opportunity.customerId ? sourceRef("customer", opportunity.customerId) : null,
    sourceRef("opportunity", opportunity.id),
  ]);
}

function factsFor(opportunity, customer) {
  if (!opportunity || !customer) return [];
  const opportunityRef = sourceRef("opportunity", opportunity.id);
  const customerRef = sourceRef("customer", customer.id);
  const opportunityRefs = opportunityRef ? [opportunityRef] : [];
  const relationshipRefs = uniqueRefs([customerRef, opportunityRef]);
  return [
    ["name", "商机名称", opportunity.name, opportunityRefs],
    ["customer", "关联客户", customer.name, relationshipRefs],
    ["stage", "当前阶段", opportunity.stage, opportunityRefs],
    ["amount", "当前金额", opportunity.amount, opportunityRefs],
    ["probability", "当前成交概率", opportunity.probability, opportunityRefs],
    ["days", "当前阶段天数", opportunity.days, opportunityRefs],
    ["risk", "已记录风险", opportunity.risk, opportunityRefs],
    ["next", "已记录下一步", opportunity.next, opportunityRefs],
    ["updatedAt", "更新时间", opportunity.updatedAt, opportunityRefs],
  ].flatMap(([key, label, value, sourceRefs]) => value !== null && value !== undefined
    ? [{ key, label, value, sourceRefs }]
    : []);
}

function unknownsFor(opportunity) {
  if (!opportunity) {
    return [{ key: "opportunity", question: "请先确认要查看的商机。", reason: "没有唯一且关系有效的服务端商机快照。" }];
  }
  return [
    ["stage", opportunity.stage, "请在业务系统中确认当前阶段。"],
    ["amount", opportunity.amount, "请在业务系统中确认当前金额。"],
    ["probability", opportunity.probability, "请在业务系统中确认当前成交概率。"],
  ].flatMap(([key, value, question]) => value === null
    ? [{ key, question, reason: "当前 owner-scoped 商机快照没有可信值，Opportunity Agent 不会猜测。" }]
    : []);
}

function changePreview(opportunity, changes) {
  if (!opportunity || !isPlainObject(changes)) return null;
  const changedFields = [];
  const before = {};
  const after = {};
  const rejectedFields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!CHANGEABLE_FIELDS.has(key)) {
      rejectedFields.push(key);
      continue;
    }
    const nextValue = boundedText(value, key === "name" ? 300 : 500);
    if (!nextValue) {
      rejectedFields.push(key);
      continue;
    }
    before[key] = opportunity[key] ?? null;
    after[key] = nextValue;
    if (before[key] !== nextValue) changedFields.push(key);
  }
  return {
    entity: "opportunity",
    opportunityId: opportunity.id,
    expectedVersion: null,
    before,
    after,
    changedFields,
    rejectedFields,
    protectedFields: ["customerId", "stage", "amount", "probability", "version"],
    requiresHumanConfirmation: true,
  };
}

function stageReview(opportunity) {
  if (!opportunity) return null;
  return {
    currentStage: opportunity.stage,
    nextStage: null,
    recommendation: null,
    requiresSalesDecisionAgent: true,
    note: "Opportunity Agent 只陈述当前阶段，不生成推进策略或阶段变更建议。",
  };
}

function outputBase({
  status,
  taskType,
  opportunity,
  customer,
  matches,
  truncated,
  relationshipIssueCount,
  sourceRefs,
  facts,
  unknowns,
  change,
}) {
  return {
    schemaVersion: CONTRACT_VERSION,
    agentId: AGENT_ID,
    taskType,
    status,
    opportunity,
    customer,
    matches,
    truncated,
    relationship: opportunity && customer
      ? { valid: true, customerId: customer.id, reason: null }
      : { valid: relationshipIssueCount > 0 ? false : null, customerId: null, reason: relationshipIssueCount > 0 ? "商机与当前账号可见客户的关系无法验证。" : null },
    headline: opportunity
      ? `${opportunity.name ?? "商机"}（${opportunity.stage ?? "阶段待确认"}）`
      : "当前没有唯一且关系有效的商机结果。",
    facts,
    inferences: [],
    unknowns,
    sourceRefs,
    stageReview: taskType === "stage_review" ? stageReview(opportunity) : null,
    salesDecisionAdvice: null,
    changePreview: change,
    writebackPreview: {
      requiresHumanConfirmation: true,
      allowed: false,
      changedFields: change?.changedFields ?? [],
      note: "商机写入工具尚未开放；阶段、金额、概率和版本保持只读，当前不会执行任何写入。",
    },
    writebackAllowed: false,
  };
}

function restoreRun(run) {
  const item = run?.item ?? run;
  if (!item || !isPlainObject(item) || item.agentId !== AGENT_ID || !isPlainObject(item.output)) return null;
  return { ...item.output, runId: item.id, inputSnapshotHash: item.inputSnapshotHash, replayed: true };
}

export function createOpportunityAssistantAdapter({
  snapshotAdapter,
  runRepository = null,
  clock = () => new Date(),
} = {}) {
  const manifest = getAgentManifest(AGENT_ID);
  if (!manifest) throw new TypeError("opportunity manifest is unavailable");
  if (
    !snapshotAdapter
    || typeof snapshotAdapter.opportunitySearch !== "function"
    || typeof snapshotAdapter.opportunityDetail !== "function"
    || typeof snapshotAdapter.customerDetail !== "function"
  ) {
    throw new TypeError("owner-scoped opportunity and customer snapshot adapter is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function validateRelationship(owner, value) {
    const opportunity = normalizeOpportunity(value);
    if (!opportunity) return { opportunity: null, customer: null, issue: null };
    if (!opportunity.customerId) return { opportunity: null, customer: null, issue: "missing_customer" };
    const customer = normalizeCustomer(snapshotAdapter.customerDetail({
      owner,
      customerId: opportunity.customerId,
    }));
    if (!customer || customer.id !== opportunity.customerId) {
      return { opportunity: null, customer: null, issue: "customer_not_visible" };
    }
    return {
      opportunity: { ...opportunity, customer: customer.name ?? opportunity.customer },
      customer,
      issue: null,
    };
  }

  function searchValidated(owner, query) {
    const result = snapshotAdapter.opportunitySearch({ owner, query: text(query, "query", 200) });
    const items = Array.isArray(result?.items) ? result.items : [];
    const entries = [];
    let relationshipIssueCount = 0;
    for (const item of items.slice(0, MAX_ITEMS)) {
      const validated = validateRelationship(owner, item);
      if (validated.opportunity && validated.customer) entries.push(validated);
      else if (validated.issue) relationshipIssueCount += 1;
    }
    return {
      entries,
      matches: entries.map((entry) => entry.opportunity),
      truncated: result?.truncated === true || items.length > MAX_ITEMS,
      relationshipIssueCount,
    };
  }

  async function analyze({
    owner,
    channel = "assistant",
    conversationId = null,
    eventId = null,
    taskType = "detail",
    query = null,
    opportunityId = null,
    changes = null,
  } = {}) {
    const normalizedOwner = text(owner, "owner", 200);
    if (!TASK_TYPES.has(taskType) || !manifest.taskTypes.includes(taskType)) {
      throw new AssistantContractError("taskType is not registered for opportunity", "invalid_opportunity_input");
    }
    const normalizedId = identifier(opportunityId, "opportunityId");
    const normalizedQuery = optionalText(query, "query", 200);
    const input = {
      taskType,
      opportunityId: normalizedId,
      query: normalizedQuery,
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
      const direct = normalizedId
        ? validateRelationship(normalizedOwner, snapshotAdapter.opportunityDetail({
          owner: normalizedOwner,
          opportunityId: normalizedId,
        }))
        : { opportunity: null, customer: null, issue: null };
      let opportunity = direct.opportunity;
      let customer = direct.customer;
      let matches = [];
      let truncated = false;
      let relationshipIssueCount = direct.issue ? 1 : 0;
      if (!opportunity && normalizedQuery) {
        const searchResult = searchValidated(normalizedOwner, normalizedQuery);
        matches = searchResult.matches;
        truncated = searchResult.truncated;
        relationshipIssueCount += searchResult.relationshipIssueCount;
        if (searchResult.entries.length === 1) {
          opportunity = searchResult.entries[0].opportunity;
          customer = searchResult.entries[0].customer;
        }
      }
      let status = "ok";
      if (!opportunity && matches.length > 1) status = "clarify";
      else if (!opportunity && relationshipIssueCount > 0) status = "review_required";
      else if (!opportunity) status = "not_found";
      const change = taskType === "change_preview" ? changePreview(opportunity, changes) : null;
      if (taskType === "change_preview" && opportunity && !change?.changedFields.length) status = "review_required";
      const refs = uniqueRefs([
        ...refsFor(opportunity),
        ...matches.flatMap(refsFor),
      ]);
      const output = outputBase({
        status,
        taskType,
        opportunity,
        customer,
        matches,
        truncated,
        relationshipIssueCount,
        sourceRefs: refs,
        facts: factsFor(opportunity, customer),
        unknowns: status === "clarify"
          ? [{ key: "ambiguity", question: "请从候选列表中确认唯一商机。", reason: "服务端返回多个关系有效的匹配项。" }]
          : status === "review_required" && !opportunity
            ? [{ key: "relationship", question: "请先在业务系统中核对商机与客户的关联。", reason: "当前账号下无法验证商机与客户关系。" }]
            : unknownsFor(opportunity),
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
        try {
          runRepository.fail(run.item.id, { owner: normalizedOwner, errorCode: "OPPORTUNITY_ADAPTER_FAILED" });
        } catch {
          // Preserve the original adapter error.
        }
      }
      throw error;
    }
  }

  function search(owner, query) {
    const result = searchValidated(text(owner, "owner", 200), query);
    return {
      matches: result.matches,
      truncated: result.truncated,
      relationshipIssueCount: result.relationshipIssueCount,
    };
  }

  return Object.freeze({ analyze, search, detail: analyze, restore: restoreRun });
}

export { restoreRun as restoreOpportunityRun };
