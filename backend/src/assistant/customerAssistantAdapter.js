import { AssistantContractError } from "./contracts.js";
import { weixinCard, weixinClip, weixinValue } from "./weixinCard.js";
import { getAgentManifest } from "./agentManifest.js";
import {
  countActiveOpportunities,
  findActiveCustomerByExactName,
} from "../customers/customerStore.js";

const AGENT_ID = "customer";
const CONTRACT_VERSION = "customer-v1";
const TASK_TYPES = new Set(["search", "detail", "summarize", "change_preview", "create_preview", "delete_preview"]);
const MAX_ITEMS = 100;
const MAX_TEXT = 2_000;
const SCALAR_FIELD_LIMITS = Object.freeze({
  name: 200,
  region: 100,
  type: 100,
  level: 50,
  contact: 500,
  budget: 500,
  summary: 5000,
});
const ARRAY_FIELDS = new Set(["aliases", "tags"]);
const MAX_ARRAY_ITEMS = 20;
const MAX_ARRAY_ITEM_LENGTH = 120;
const CHANGEABLE_FIELDS = new Set([...Object.keys(SCALAR_FIELD_LIMITS), ...ARRAY_FIELDS]);
const FIELD_LABELS = Object.freeze({
  name: "名称",
  region: "区域",
  type: "类型",
  level: "级别",
  contact: "联系人",
  budget: "预算",
  summary: "摘要",
  aliases: "别名",
  tags: "标签",
});

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

function boundedStringArray(value) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return null;
  const items = [];
  for (const item of value) {
    const normalized = boundedText(item, MAX_ARRAY_ITEM_LENGTH);
    if (!normalized) return null;
    if (!items.includes(normalized)) items.push(normalized);
  }
  return items;
}

function normalizeCustomer(value) {
  if (!isPlainObject(value)) return null;
  const id = identifier(value.id, "customer.id");
  if (!id) return null;
  return {
    id,
    version: Number.isSafeInteger(value.version) && value.version >= 1 ? value.version : null,
    name: boundedText(value.name, 300),
    region: boundedText(value.region, 120),
    type: boundedText(value.type, 120),
    level: boundedText(value.level, 120),
    contact: boundedText(value.contact, 500),
    budget: boundedText(value.budget, 500),
    summary: boundedText(value.summary, 5000),
    aliases: boundedStringArray(value.aliases) ?? [],
    tags: boundedStringArray(value.tags) ?? [],
    updatedAt: boundedText(value.updatedAt, 100),
  };
}

function normalizeMatches(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map(normalizeCustomer).filter(Boolean);
}

function normalizeSearchResult(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    matches: normalizeMatches(items),
    truncated: value?.truncated === true || items.length > MAX_ITEMS,
  };
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

function normalizeArrayChange(current, value) {
  if (Array.isArray(value)) return boundedStringArray(value);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.some((key) => !["add", "remove"].includes(key))) return null;
    const add = value.add === undefined ? [] : boundedStringArray(value.add);
    const remove = value.remove === undefined ? [] : boundedStringArray(value.remove);
    if (add === null || remove === null || (add.length === 0 && remove.length === 0)) return null;
    const next = (Array.isArray(current) ? current : []).filter((item) => !remove.includes(item));
    for (const item of add) {
      if (!next.includes(item)) next.push(item);
    }
    return next.length > MAX_ARRAY_ITEMS ? null : next;
  }
  return null;
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
    if (ARRAY_FIELDS.has(key)) {
      const next = normalizeArrayChange(customer[key] ?? [], value);
      if (next === null) {
        rejectedFields.push(key);
        continue;
      }
      before[key] = Array.isArray(customer[key]) ? customer[key] : [];
      after[key] = next;
      if (JSON.stringify(before[key]) !== JSON.stringify(next)) changedFields.push(key);
      continue;
    }
    const next = boundedText(value, SCALAR_FIELD_LIMITS[key]);
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
    expectedVersion: customer.version ?? null,
    before,
    after,
    changedFields,
    rejectedFields,
    requiresHumanConfirmation: true,
  };
}

function outputBase({ status, taskType, customer, matches, truncated, sourceRefs, facts, unknowns, change }) {
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
    truncated,
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
    return normalizeSearchResult(result);
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
      let truncated = false;
      if (!customer && normalizedQuery) {
        const searchResult = search(normalizedOwner, normalizedQuery);
        matches = searchResult.matches;
        truncated = searchResult.truncated;
      }
      if (!customer && matches.length === 1) customer = matches[0];
      const refs = uniqueRefs([
        customer ? sourceRef(customer.id) : null,
        ...matches.map((item) => sourceRef(item.id)),
      ]);
      let status = "ok";
      if (!customer && matches.length === 0) status = "not_found";
      if (!customer && matches.length > 1) status = "clarify";
      if ((taskType === "change_preview" || taskType === "delete_preview") && !customer) {
        status = matches.length > 1 ? "clarify" : "not_found";
      }
      const change = taskType === "change_preview" ? changePreview(customer, changes) : null;
      if (taskType === "change_preview" && customer && !change?.changedFields.length) status = "review_required";
      const output = outputBase({
        status,
        taskType,
        customer,
        matches,
        truncated,
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

const TARGET_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;
const PREVIEW_SUMMARY_MAX = 2_000;

function block(text, { bodyStatus = "clarify", status = 200 } = {}) {
  return { block: true, text, bodyStatus, status };
}

function displayValue(value, empty = "（空）") {
  if (Array.isArray(value)) return value.length > 0 ? value.join("、") : empty;
  const text = typeof value === "string" ? value.trim() : "";
  return text || empty;
}

function candidateLines(matches) {
  return matches.slice(0, 5).map((item, index) => [`${index + 1}`, `${item.name ?? "名称待确认"}  ${item.region ?? ""}`.trim()]);
}

function resolutionBlock(result, target) {
  if (result.status === "clarify") {
    return block(weixinCard("找到多个客户", candidateLines(result.matches)));
  }
  if (result.status === "not_found" || !result.customer) {
    return block(`未找到客户：${target ?? "（未提供）"}。可发送“新建客户 ${target ?? "…"}，区域…，类型…”建档。`);
  }
  return null;
}

function normalizedWriteTarget(argumentsValue) {
  const rawId = typeof argumentsValue.customerId === "string" ? argumentsValue.customerId.trim() : "";
  const rawQuery = typeof argumentsValue.query === "string" ? argumentsValue.query.trim() : "";
  const target = rawQuery || rawId;
  if (!target || target.length > 200) return null;
  const customerId = rawId && rawId.length <= 200 && TARGET_IDENTIFIER.test(rawId) && !rawId.startsWith("synthetic:")
    ? rawId
    : (TARGET_IDENTIFIER.test(target) && !target.startsWith("synthetic:") ? target : null);
  return { target, customerId };
}

function previewSummaryOf(previewText) {
  return String(previewText).slice(0, PREVIEW_SUMMARY_MAX);
}

/**
 * Pending-action preview providers for the three customer write tools. They
 * run inside the orchestrator immediately before a pending action (and its
 * six-digit confirmation code) is created: they gate direct-chat/owner scope,
 * disambiguate the target customer, pin the optimistic-lock version, and
 * render the human preview card. The returned preview text never contains a
 * confirmation code.
 */
export function createCustomerPendingPreviewProviders({
  adapter,
  db,
  resolveBusinessOwner,
} = {}) {
  if (!adapter || typeof adapter.analyze !== "function") throw new TypeError("customer adapter is required");
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");

  function writeGate({ context, serverData }) {
    if (context.channel !== "web" && serverData?.auditMetadata?.chatType !== "direct") {
      return { blocked: block("客户档案修改仅支持与小小的私聊。") };
    }
    const owner = context.channel === "web"
      ? (typeof context.owner === "string" ? context.owner.trim() : "")
      : resolveBusinessOwner(context.owner);
    if (typeof owner !== "string" || !owner.trim()) {
      return { blocked: block("当前账号未绑定业务负责人，暂不能修改客户档案。") };
    }
    return { owner: owner.trim() };
  }

  async function resolveCustomerPreview({ taskType, context, argumentsValue, changes = null }) {
    const resolved = normalizedWriteTarget(argumentsValue);
    if (!resolved) return { blocked: block("请说明客户名称或客户 ID。") };
    const result = await adapter.analyze({
      owner: context.owner,
      channel: context.channel,
      conversationId: context.conversation,
      eventId: context.event,
      taskType,
      customerId: resolved.customerId,
      query: resolved.target,
      changes,
    });
    const blocked = resolutionBlock(result, resolved.target);
    if (blocked) return { blocked };
    if (!result.customer.version) {
      return { blocked: block("客户资料版本无法确认，请稍后在系统网页中处理。") };
    }
    return { result, target: resolved.target };
  }

  return Object.freeze({
    async "customer.create"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const fields = {};
      for (const [key, limit] of Object.entries(SCALAR_FIELD_LIMITS)) {
        const value = boundedText(argumentsValue[key], limit);
        if (value) fields[key] = value;
      }
      for (const key of ARRAY_FIELDS) {
        const value = argumentsValue[key] === undefined ? null : boundedStringArray(argumentsValue[key]);
        if (value && value.length > 0) fields[key] = value;
      }
      if (!fields.name) return block("请提供客户名称，例如“新建客户 莒县人民医院，区域日照”。");
      const duplicate = findActiveCustomerByExactName(db, { owner: gate.owner, name: fields.name });
      if (duplicate) {
        return block(`已存在同名客户 [${duplicate.id}]，如确需新建请在名称中加区分（如院区），或发送“修改客户 ${duplicate.name}，…”直接更新现有档案。`);
      }
      const previewText = weixinCard("小小提醒！新建客户", [
        ["名称", fields.name],
        ["区域", fields.region || "待补充"],
        ["类型", fields.type || "待补充"],
        ["级别", fields.level || "待补充"],
        ["联系人", fields.contact || "待补充"],
        ["预算", fields.budget || "待补充"],
        ["别名", weixinValue(fields.aliases, "无")],
        ["标签", weixinValue(fields.tags, "无")],
        ...(fields.summary ? [["摘要", weixinClip(fields.summary, 80)]] : []),
      ]);
      return {
        arguments: fields,
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "customer.update"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const changes = isPlainObject(argumentsValue.changes) ? argumentsValue.changes : null;
      if (!changes || Object.keys(changes).length === 0) {
        return block("请说明要修改的字段，可改：名称/区域/类型/级别/联系人/预算/摘要/别名/标签。");
      }
      const resolution = await resolveCustomerPreview({
        taskType: "change_preview",
        context,
        argumentsValue,
        changes,
      });
      if (resolution.blocked) return resolution.blocked;
      const { result } = resolution;
      const preview = result.changePreview;
      const rejectedLabels = preview.rejectedFields.map((key) => FIELD_LABELS[key] ?? key);
      if (preview.changedFields.length === 0) {
        if (preview.rejectedFields.length > 0) {
          return block(`暂不支持修改：${rejectedLabels.join("、")}。微信端可改：名称/区域/类型/级别/联系人/预算/摘要/别名/标签，其余请在系统网页中修改。`);
        }
        return block("内容与现有档案一致，无需修改。");
      }
      const changesToApply = Object.fromEntries(preview.changedFields.map((key) => [key, preview.after[key]]));
      const previewText = weixinCard("小小提醒！修改客户", [
        ["名称", result.customer.name],
        ...preview.changedFields.map((key) => (
          [FIELD_LABELS[key] ?? key, `${displayValue(preview.before[key])} → ${displayValue(preview.after[key])}`]
        )),
        ...(rejectedLabels.length > 0 ? [["未改", `${rejectedLabels.join("、")}（请在网页改）`]] : []),
      ]);
      return {
        arguments: {
          customerId: result.customer.id,
          expectedVersion: preview.expectedVersion,
          changes: changesToApply,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },

    async "customer.delete"({ arguments: argumentsValue, context, serverData }) {
      const gate = writeGate({ context, serverData });
      if (gate.blocked) return gate.blocked;
      const resolution = await resolveCustomerPreview({
        taskType: "delete_preview",
        context,
        argumentsValue,
      });
      if (resolution.blocked) return resolution.blocked;
      const customer = resolution.result.customer;
      const opportunityCount = countActiveOpportunities(db, customer.id);
      const previewText = weixinCard("小小提醒！删除客户", [
        ["名称", customer.name],
        ["区域", customer.region || "-"],
        ["类型", customer.type || "-"],
        ["级别", customer.level || "-"],
        ["关联商机", opportunityCount],
      ]);
      return {
        arguments: {
          customerId: customer.id,
          expectedVersion: customer.version,
        },
        previewText,
        previewSummary: previewSummaryOf(previewText),
      };
    },
  });
}

export { restoreRun as restoreCustomerRun };
