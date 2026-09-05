import { createHash } from "node:crypto";

import { KNOWN_STAGES, normalizeStageText } from "../opportunities/stageVocabulary.js";

export const PROACTIVE_ASSISTANT_SCHEMA_VERSION = "proactive-assistant-v1";
export const PROACTIVE_ASSISTANT_MODEL_VERSION = "rules/proactive-v1";
export const DEFAULT_PROACTIVE_STALE_DAYS = 21;
export const DEFAULT_PROACTIVE_LIMIT = 50;
export const MAX_PROACTIVE_LIMIT = 100;

// Keep rule decisions on the same vocabulary as the opportunity tools and
// board.  The board vocabulary intentionally contains only active columns;
// terminal labels are explicit aliases here so a historical/legacy terminal
// value cannot fall through to an active-stage reminder.
const ADVANCED_STAGES = new Set(["方案输出", "方案交流", "预算确认"]);
const TERMINAL_STAGES = new Set([
  "赢单",
  "成交",
  "已成交",
  "已签约",
  "交付完成",
  "丢单",
  "输单",
  "失败",
  "关闭",
  "已关闭",
  "流失",
]);
const PAUSED_STAGE = "暂停观察";
const CONFIRMED_INTERACTION_STATUSES = new Set(["analyzed", "confirmed"]);
const OPEN_ACTION_STATUSES = new Set(["pending", "in_progress", "deferred"]);
const TRIGGER_ORDER = Object.freeze({
  missing_next_step: 0,
  stale_opportunity: 1,
  stage_evidence_mismatch: 2,
  budget_unknown: 3,
  decision_chain_unknown: 4,
  purchase_timing_unknown: 5,
  action_due: 6,
  risk_open: 7,
  visit_follow_up: 8,
  tender_change: 9,
});
const DAY_MS = 24 * 60 * 60 * 1000;

function text(value, max = 500) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : "";
}

function optionalText(value, max = 500) {
  const normalized = text(value, max);
  return normalized || null;
}

function normalizeStage(value) {
  const normalized = normalizeStageText(value);
  return normalized || null;
}

function stageState(value) {
  const stage = normalizeStage(value);
  return {
    value: stage,
    known: Boolean(stage && KNOWN_STAGES.includes(stage)),
    advanced: Boolean(stage && ADVANCED_STAGES.has(stage)),
    terminal: Boolean(stage && TERMINAL_STAGES.has(stage)),
    paused: stage === PAUSED_STAGE,
  };
}

function identifier(value) {
  const normalized = text(value, 200);
  return normalized && /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized) ? normalized : null;
}

function validDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function revisionValue(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  const normalized = text(value, 200);
  return normalized || null;
}

// Provenance is deliberately flat and additive.  Existing callers only know
// about type/id/label/detail, while proactive consumers need enough of the
// source snapshot to tell an unchanged row from a changed row.  Keep the
// allow-list here so arbitrary source payload (and especially raw record
// content) can never leak into the assistant response or model context.
const PROVENANCE_KEYS = Object.freeze([
  "version",
  "revision",
  "updatedAt",
  "occurredAt",
  "publishedAt",
  "visitDate",
  "due",
  "status",
  "confirmationStatus",
  "voidedAt",
  "identityKey",
  "sourceId",
  "noticeType",
  "contentSha256",
]);

function normalizedProvenanceValue(key, value) {
  if (key === "version") return positiveVersion(value);
  if (key === "revision") return revisionValue(value);
  if (["updatedAt", "occurredAt", "publishedAt", "voidedAt"].includes(key)) {
    return value === null || value === undefined || value === "" ? null : iso(value);
  }
  if (value === null || value === undefined || value === "") return null;
  return text(value, key === "contentSha256" ? 200 : 500) || null;
}

function provenanceFrom(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  const result = {};
  for (const key of PROVENANCE_KEYS) {
    if (!Object.hasOwn(item, key)) continue;
    result[key] = normalizedProvenanceValue(key, item[key]);
  }
  return result;
}

function provenanceKey(refs) {
  return JSON.stringify(canonicalValue((Array.isArray(refs) ? refs : []).map((ref) => {
    const normalized = { type: ref?.type ?? null, id: ref?.id ?? null };
    for (const key of PROVENANCE_KEYS) {
      if (Object.hasOwn(ref ?? {}, key)) normalized[key] = ref[key];
    }
    return normalized;
  })));
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function boundedLimit(value) {
  if (!Number.isSafeInteger(value)) return DEFAULT_PROACTIVE_LIMIT;
  return Math.min(MAX_PROACTIVE_LIMIT, Math.max(1, value));
}

function boundedStaleDays(value) {
  if (!Number.isSafeInteger(value)) return DEFAULT_PROACTIVE_STALE_DAYS;
  return Math.min(365, Math.max(1, value));
}

function stableId(trigger, opportunityId, snapshotKey) {
  const digest = createHash("sha256")
    .update(`${PROACTIVE_ASSISTANT_SCHEMA_VERSION}\u0000${trigger}\u0000${opportunityId}\u0000${snapshotKey}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `proactive-${trigger}-${digest}`;
}

// The browser sends this digest back when a person confirms a writeback.  It
// binds the confirmation to the exact server-generated preview rather than to
// mutable client text.  Keep the representation canonical so key ordering in
// a JSON request cannot change the digest.
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function proactivePreviewDigest(suggestion, type = "action") {
  const preview = suggestion?.writebackPreview?.[type] ?? null;
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue({ suggestionId: suggestion?.id ?? null, type, preview })), "utf8")
    .digest("hex");
}

/**
 * Return the bounded, server-owned snapshot that is persisted when a person
 * opens a proactive confirmation preview.  It intentionally excludes raw
 * quick-record content and keeps only the facts, evidence references, source
 * versions and selected writeback draft needed to reproduce the decision.
 */
export function proactiveConfirmationSnapshot(suggestion, target = "action") {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return null;
  if (target !== "action" && target !== "risk") return null;
  const preview = suggestion.writebackPreview?.[target];
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const previewDigest = suggestion.previewDigests?.[target] ?? proactivePreviewDigest(suggestion, target);
  return {
    schemaVersion: suggestion.schemaVersion,
    suggestionId: suggestion.id,
    target,
    subjectType: suggestion.subjectType,
    subjectId: suggestion.subjectId,
    customerId: suggestion.customerId,
    opportunityId: suggestion.opportunityId,
    opportunityVersion: suggestion.opportunityVersion,
    customerVersion: suggestion.customerVersion,
    title: suggestion.title,
    conclusion: suggestion.conclusion,
    facts: Array.isArray(suggestion.facts) ? suggestion.facts : [],
    inferences: Array.isArray(suggestion.inferences) ? suggestion.inferences : [],
    unknowns: Array.isArray(suggestion.unknowns) ? suggestion.unknowns : [],
    risks: Array.isArray(suggestion.risks) ? suggestion.risks : [],
    nextActions: Array.isArray(suggestion.nextActions) ? suggestion.nextActions : [],
    evidenceRefs: Array.isArray(suggestion.evidenceRefs) ? suggestion.evidenceRefs : [],
    sourceRefs: Array.isArray(suggestion.sourceRefs) ? suggestion.sourceRefs : [],
    trigger: suggestion.trigger ?? null,
    modelVersion: suggestion.modelVersion,
    source: suggestion.source,
    fallbackReason: suggestion.fallbackReason ?? null,
    previewDigest,
    preview: { ...preview },
  };
}

function sourceRef(type, id, label = null, detail = null, provenance = {}) {
  const normalizedId = identifier(id);
  if (!normalizedId) return null;
  return {
    type,
    id: normalizedId,
    ...(label ? { label: text(label, 200) } : {}),
    ...(detail ? { detail: text(detail, 500) } : {}),
    ...provenanceFrom(provenance),
  };
}

function uniqueRefs(refs) {
  const result = [];
  const indexes = new Map();
  for (const ref of refs) {
    if (!ref) continue;
    const key = `${ref.type}\u0000${ref.id}`;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(ref);
      continue;
    }
    // The same source is often used by more than one fact.  Merge the
    // richest representation instead of letting a later sparse reference
    // erase version/timestamp metadata from the first one.
    const existing = result[existingIndex];
    const merged = { ...existing };
    for (const [field, value] of Object.entries(ref)) {
      if (value === undefined) continue;
      if (value !== null || merged[field] === undefined || merged[field] === null) merged[field] = value;
    }
    result[existingIndex] = merged;
  }
  return result;
}

function fact(key, label, value, sourceRefs) {
  if (value === null || value === undefined || value === "") return null;
  return {
    key,
    label,
    value,
    sourceRefs: sourceRefs.map((ref) => ({
      type: ref.type,
      id: ref.id,
      ...(ref.label ? { label: ref.label } : {}),
      ...(ref.detail ? { detail: ref.detail } : {}),
      ...provenanceFrom(ref),
    })),
  };
}

function normalizeOpportunity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  const customerId = identifier(value.customerId);
  if (!id || !customerId) return null;
  return {
    id,
    customerId,
    customerName: optionalText(value.customerName ?? value.customer, 200),
    name: optionalText(value.name, 300),
    stage: normalizeStage(value.stage),
    amount: optionalText(value.amount, 120),
    probability: Number.isSafeInteger(value.probability) ? value.probability : null,
    days: Number.isSafeInteger(value.days) && value.days >= 0 ? value.days : null,
    next: optionalText(value.next, 500),
    createdAt: iso(value.createdAt ?? value.created_at),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
    version: Number.isSafeInteger(value.version) && value.version >= 1 ? value.version : null,
    customerVersion: Number.isSafeInteger(value.customerVersion) && value.customerVersion >= 1
      ? value.customerVersion
      : null,
    customerUpdatedAt: iso(value.customerUpdatedAt ?? value.customer_updated_at),
    budget: optionalText(value.budget, 300),
    decisionChain: Array.isArray(value.decisionChain)
      ? value.decisionChain.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 20)
      : [],
    purchaseTime: optionalText(value.purchaseTime ?? value.purchaseWindow ?? value.procurementTime, 300),
  };
}

function normalizeAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  const opportunityId = identifier(value.opportunityId);
  if (!id || !opportunityId) return null;
  const actionStatus = optionalText(value.status, 60);
  return {
    id,
    opportunityId,
    version: positiveVersion(value.version),
    title: optionalText(value.title, 500),
    status: actionStatus ? actionStatus.toLowerCase() : null,
    due: optionalText(value.due, 100),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
  };
}

function normalizeInteraction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  if (!id) return null;
  const interactionStatus = optionalText(value.status, 60);
  return {
    id,
    opportunityId: identifier(value.opportunityId),
    customerId: identifier(value.customerId),
    version: positiveVersion(value.version),
    occurredAt: iso(value.occurredAt ?? value.createdAt ?? value.created_at),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
    sourceChannel: optionalText(value.sourceChannel, 100),
    status: interactionStatus ? interactionStatus.toLowerCase() : null,
    confirmationStatus: interactionStatus ? interactionStatus.toLowerCase() : null,
    voidedAt: iso(value.voidedAt ?? value.voided_at),
  };
}

function normalizeRisk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  if (!id) return null;
  return {
    id,
    opportunityId: identifier(value.opportunityId),
    customerId: identifier(value.customerId),
    version: positiveVersion(value.version),
    title: optionalText(value.title, 500),
    status: optionalText(value.status, 60)?.toLowerCase() ?? null,
    severity: optionalText(value.severity, 60),
    due: optionalText(value.due, 100),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
  };
}

function normalizeItinerary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  if (!id) return null;
  return {
    id,
    version: positiveVersion(value.version),
    customerId: identifier(value.customerId),
    opportunityId: identifier(value.opportunityId),
    visitDate: optionalText(value.visitDate, 40),
    status: optionalText(value.status, 40)?.toLowerCase() ?? null,
    title: optionalText(value.title, 500),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
  };
}

function normalizeTender(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identityKey = identifier(value.identityKey ?? value.id);
  const id = identifier(value.id ?? identityKey);
  if (!id) return null;
  const title = optionalText(value.title, 500);
  const publishedAt = iso(value.publishedAt);
  const noticeType = optionalText(value.noticeType, 80);
  const sourceId = identifier(value.sourceId);
  const contentSha256 = optionalText(value.contentSha256, 200);
  const explicitRevision = revisionValue(value.revision ?? value.noticeVersion ?? value.version);
  // The tender table predates entity versions.  Prefer its content digest as
  // the immutable revision; when an older row has no digest, derive a stable
  // revision from the visible notice identity/metadata instead of using
  // lastSeenAt (which changes on every collector poll).
  const revision = explicitRevision ?? contentSha256 ?? createHash("sha256")
    .update(JSON.stringify({
      identityKey: identityKey ?? id,
      sourceId,
      title,
      publishedAt,
      noticeType,
      sourceItemId: optionalText(value.sourceItemId, 300),
      contentText: optionalText(value.contentText, 2_000),
    }), "utf8")
    .digest("hex");
  return {
    id,
    identityKey: identityKey ?? id,
    customerId: identifier(value.customerId),
    title,
    noticeType,
    publishedAt,
    sourceId,
    revision,
    version: positiveVersion(value.version),
    updatedAt: iso(value.updatedAt ?? value.updated_at),
    contentSha256,
  };
}

function stageEvidenceMismatch(opportunity, interactionCount) {
  const state = stageState(opportunity.stage);
  if (state.terminal || state.paused) return false;
  // A missing or out-of-vocabulary value is surfaced as an explicit unknown
  // below.  It must not be guessed into an "advanced" stage merely because
  // an unrelated word happens to match a regex.
  if (!state.value || !state.known) return "unknown";
  if (!state.advanced) return false;
  // A newly-created advanced-stage record with no linked evidence is the
  // strongest mismatch.  A long-running stage with only one evidence row is
  // also surfaced, but only after 30 recorded stage days.
  return interactionCount === 0
    || (opportunity.days !== null && opportunity.days >= 30 && interactionCount < 2);
}

function ageInDays(lastInteractionAt, now) {
  if (!lastInteractionAt) return null;
  const elapsed = now.getTime() - lastInteractionAt.getTime();
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / DAY_MS);
}

function usableInteraction(item) {
  return item && (!item.status || CONFIRMED_INTERACTION_STATUSES.has(item.status));
}

function unknownStageEntry(stage) {
  return {
    key: "opportunity.stage",
    question: "当前商机阶段是否属于统一阶段词表？",
    reason: stage
      ? `阶段“${stage}”不在统一词表（${KNOWN_STAGES.join("、")}）中。`
      : "当前商机没有有效阶段字段。",
  };
}

function missingInteractionEntry() {
  return {
    key: "interaction.lastAt",
    question: "当前商机最近一次有效互动是什么时候？",
    reason: "没有找到直接关联且已确认的有效互动记录，停滞天数待补。",
  };
}

function actionContributesToNextStep(action, now) {
  if (!action || !OPEN_ACTION_STATUSES.has(action.status)) return false;
  // A deferred action with an elapsed, parseable due date no longer proves
  // that the opportunity has a current next step.  Unknown due dates remain
  // visible as open work rather than being silently reclassified.
  if (action.status === "deferred") {
    const due = validDate(action.due);
    if (due && due.getTime() < now.getTime()) return false;
  }
  return true;
}

function suggestionFor({
  trigger,
  opportunity,
  interactions,
  backgroundInteractions = [],
  openActions,
  now,
  staleDays,
}) {
  const currentStage = stageState(opportunity.stage);
  const customerRef = sourceRef(
    "customer",
    opportunity.customerId,
    opportunity.customerName ?? "关联客户",
    null,
    { version: opportunity.customerVersion, updatedAt: opportunity.customerUpdatedAt },
  );
  const opportunityRef = sourceRef(
    "opportunity",
    opportunity.id,
    opportunity.name ?? "商机",
    null,
    { version: opportunity.version, updatedAt: opportunity.updatedAt },
  );
  const opportunityRefs = uniqueRefs([customerRef, opportunityRef]);
  const sortedInteractions = interactions
    .filter((item) => usableInteraction(item) && item.occurredAt)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id));
  const lastInteraction = sortedInteractions[0] ?? null;
  const lastInteractionDate = validDate(lastInteraction?.occurredAt);
  const interactionRefs = sortedInteractions.slice(0, 5).map((item) => sourceRef(
    "quick_record",
    item.id,
    item.sourceChannel ?? "互动记录",
    item.occurredAt ?? null,
    item,
  ));
  const actionRefs = openActions.slice(0, 5).map((item) => sourceRef(
    "action_item",
    item.id,
    item.title ?? "未完成行动",
    item.due ?? null,
    item,
  ));
  const evidenceRefs = uniqueRefs([...opportunityRefs, ...interactionRefs, ...actionRefs]);
  const sourceRefs = uniqueRefs([...opportunityRefs, ...interactionRefs, ...actionRefs]);
  const interactionCount = interactions.filter(usableInteraction).length;
  const customerBackgroundCount = backgroundInteractions.filter(usableInteraction).length;
  const openActionCount = openActions.length;
  const lastInteractionIso = lastInteractionDate ? lastInteractionDate.toISOString() : null;
  const ageDays = ageInDays(lastInteractionDate, now);
  const lastInteractionRef = lastInteraction
    ? interactionRefs.find((ref) => ref.id === lastInteraction.id) ?? sourceRef("quick_record", lastInteraction.id, null, null, lastInteraction)
    : null;
  const sourceIdentityRefs = trigger === "missing_next_step"
    ? evidenceRefs
    : uniqueRefs([...opportunityRefs, ...interactionRefs]);
  const snapshotKey = [
    opportunity.version ?? "",
    opportunity.updatedAt ?? "",
    lastInteractionIso ?? "none",
    interactionCount,
    // Only missing-next-step depends on the open-action count.  Keeping that
    // value out of the other trigger IDs lets a person confirm two sibling
    // cards from the same refresh without creating a false stale conflict.
    trigger === "missing_next_step" ? openActionCount : "",
    provenanceKey(sourceIdentityRefs),
  ].join("|");

  const commonFacts = [
    fact("opportunity.name", "商机名称", opportunity.name, [opportunityRef]),
    fact("customer.name", "关联客户", opportunity.customerName, [customerRef, opportunityRef]),
    fact("opportunity.stage", "当前阶段", opportunity.stage, [opportunityRef]),
    fact("opportunity.amount", "当前金额", opportunity.amount, [opportunityRef]),
    fact("opportunity.days", "当前阶段天数", opportunity.days, [opportunityRef]),
    fact("opportunity.createdAt", "商机创建时间", opportunity.createdAt, [opportunityRef]),
    fact("opportunity.next", "已记录下一步", opportunity.next, [opportunityRef]),
    fact("opportunity.updatedAt", "商机更新时间", opportunity.updatedAt, [opportunityRef]),
    fact("interaction.count", "有效互动记录数", interactionCount, evidenceRefs),
    fact("interaction.lastAt", "最近有效互动", lastInteractionIso, lastInteractionRef ? [lastInteractionRef] : opportunityRefs),
    fact("customer.backgroundInteractionCount", "客户背景互动数（不计入本商机）", customerBackgroundCount, customerBackgroundCount > 0 ? [customerRef] : opportunityRefs),
    fact("action.openCount", "未完成行动数", openActionCount, openActionCount > 0 ? actionRefs : opportunityRefs),
  ].filter(Boolean);

  let title;
  let conclusion;
  let inferences;
  let unknowns;
  let risks;
  let nextActions;
  let confidence;
  let previewAction;
  let previewRisk = null;
  let reason;

  if (trigger === "missing_next_step") {
    title = `${opportunity.name ?? "商机"}缺少下一步动作`;
    conclusion = "当前商机没有记录下一步，也没有未完成行动，建议先补一条可执行的跟进动作。";
    inferences = [{
      claim: "商机推进可能缺少明确的责任人或时间点。",
      basis: "服务端同时未发现 next 字段和未完成 action_item。",
      sourceRefs: opportunityRefs,
    }];
    unknowns = [
      { key: "next.owner", question: "谁负责下一次跟进？", reason: "当前商机快照没有责任人信息。" },
      { key: "next.due", question: "下一次跟进的时间点是什么？", reason: "当前商机快照没有下一步截止时间。" },
      ...(currentStage.known ? [] : [unknownStageEntry(opportunity.stage)]),
      ...(interactionCount === 0 ? [missingInteractionEntry()] : []),
    ];
    risks = ["推进节奏不可见，可能错过客户预算或决策窗口。"];
    nextActions = [{
      type: "action_item",
      title: "补充一次明确的客户跟进动作",
      detail: "写清动作、负责人和时间点后再提交人工确认。",
    }];
    confidence = null;
    previewAction = {
      title: `跟进${opportunity.customerName ?? "客户"}：补充下一步动作`,
      reason: "商机没有下一步记录，也没有未完成行动。",
      customerId: opportunity.customerId,
      opportunityId: opportunity.id,
      requiresHumanConfirmation: true,
    };
    reason = "next 为空且未找到 pending/in_progress/deferred 行动。";
  } else if (trigger === "stale_opportunity") {
    title = `${opportunity.name ?? "商机"}长期没有有效互动`;
    conclusion = lastInteractionIso
      ? `最近一次有效互动距今约 ${ageDays} 天，已经超过 ${staleDays} 天阈值。`
      : `当前没有可验证的有效互动记录，已按超过 ${staleDays} 天处理。`;
    inferences = [{
      claim: "客户推进状态可能已经停滞，需要先确认客户侧是否发生变化。",
      basis: lastInteractionIso ? `最近互动距今 ${ageDays} 天。` : "没有找到有效互动记录。",
      // Keep the same complete server-owned reference used by the facts and
      // top-level evidence list.  Rebuilding this ref from only the id would
      // silently drop the interaction version/timestamps from nested model
      // context and confirmation snapshots.
      sourceRefs: lastInteraction ? [lastInteractionRef] : opportunityRefs,
    }];
    unknowns = [
      { key: "interaction.offSystem", question: "是否存在未录入系统的电话、微信或线下沟通？", reason: "系统只统计已保存且未作废的快速记录。" },
      ...(currentStage.known ? [] : [unknownStageEntry(opportunity.stage)]),
    ];
    risks = ["长时间没有新证据，阶段、预算和决策链可能已经变化。"];
    nextActions = [{
      type: "action_item",
      title: "联系客户确认当前项目状态",
      detail: "优先确认预算窗口、决策人和下一次沟通时间。",
    }];
    confidence = null;
    previewAction = {
      title: `重新联系${opportunity.customerName ?? "客户"}确认商机状态`,
      reason: lastInteractionIso ? `最近有效互动距今 ${ageDays} 天。` : "没有可验证的有效互动记录。",
      customerId: opportunity.customerId,
      opportunityId: opportunity.id,
      requiresHumanConfirmation: true,
    };
    reason = lastInteractionIso
      ? `最近有效互动距今 ${ageDays} 天，达到 ${staleDays} 天阈值。`
      : "没有可验证的有效互动记录。";
  } else {
    title = `${opportunity.name ?? "商机"}的阶段缺少对应证据`;
    const stageUnknown = !currentStage.known;
    conclusion = stageUnknown
      ? `当前阶段为“${opportunity.stage ?? "未填写"}”，不在统一阶段词表（${KNOWN_STAGES.join("、")}）中，需要人工核对。`
      : `当前阶段为“${opportunity.stage ?? "未填写"}”，但系统没有足够的互动证据支撑该阶段。`;
    inferences = stageUnknown
      ? [{
        claim: "当前阶段需要先与统一阶段词表核对。",
        basis: "阶段字段不是统一词表中的已知阶段。",
        sourceRefs: opportunityRefs,
      }]
      : [{
        claim: "当前阶段可能需要重新核对，或需要补录对应的客户证据。",
        basis: interactionCount === 0 ? "没有找到关联有效互动记录。" : `仅找到 ${interactionCount} 条关联互动记录。`,
        sourceRefs: opportunityRefs,
      }];
    unknowns = [
      ...(stageUnknown ? [unknownStageEntry(opportunity.stage)] : []),
      { key: "stage.evidence", question: "客户是否已经完成当前阶段所需的关键确认？", reason: "系统没有足够的客户互动证据。" },
      { key: "stage.source", question: "当前阶段由哪一次客户沟通或正式材料确认？", reason: "阶段字段没有绑定独立的阶段证据。" },
    ];
    risks = stageUnknown
      ? ["未知阶段可能导致漏斗统计和推进判断不一致。"]
      : ["阶段判断可能偏乐观，导致预测和资源安排失真。"];
    nextActions = [{
      type: "action_item",
      title: "补录阶段证据并复核商机阶段",
      detail: "先确认客户事实，再决定是否保留当前阶段。",
    }];
    confidence = null;
    previewAction = {
      title: `核对${opportunity.customerName ?? "客户"}的阶段证据`,
      reason: stageUnknown ? "当前阶段不在统一阶段词表中。" : "当前阶段与已保存的互动证据不匹配。",
      customerId: opportunity.customerId,
      opportunityId: opportunity.id,
      requiresHumanConfirmation: true,
    };
    previewRisk = {
      title: "商机阶段缺少可验证证据",
      target: `${opportunity.customerName ?? "客户"} / ${opportunity.name ?? "商机"}`,
      evidence: stageUnknown
        ? "阶段字段不在统一阶段词表中。"
        : "阶段字段已填写，但关联有效互动证据不足。",
      action: "补录客户沟通证据并由销售人员复核阶段。",
      customerId: opportunity.customerId,
      opportunityId: opportunity.id,
      requiresHumanConfirmation: true,
    };
    reason = stageUnknown
      ? `阶段“${opportunity.stage ?? "未填写"}”不在统一阶段词表中，需要人工核对。`
      : `阶段“${opportunity.stage ?? "未填写"}”属于推进阶段，但关联有效互动证据不足。`;
  }

  const suggestion = {
    id: stableId(trigger, opportunity.id, snapshotKey),
    schemaVersion: PROACTIVE_ASSISTANT_SCHEMA_VERSION,
    subjectType: "opportunity",
    subjectId: opportunity.id,
    customerId: opportunity.customerId,
    opportunityId: opportunity.id,
    opportunityVersion: opportunity.version,
    customerVersion: opportunity.customerVersion,
    customerName: opportunity.customerName,
    title,
    conclusion,
    facts: commonFacts,
    inferences,
    unknowns,
    risks,
    nextActions,
    evidenceRefs,
    sourceRefs,
    confidence,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
    priority: null,
    priorityCalibrated: false,
    trigger: {
      type: trigger,
      reason,
      detectedAt: now.toISOString(),
      ...(trigger === "stale_opportunity"
        ? { staleDays, ...(ageDays !== null ? { ageDays } : {}) }
        : {}),
    },
    modelVersion: PROACTIVE_ASSISTANT_MODEL_VERSION,
    source: "deterministic",
    fallbackReason: null,
    confirmationStatus: "not_started",
    writebackPreview: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
      action: previewAction,
      risk: previewRisk,
      note: "这是写回预览，不会自动创建行动或风险；确认后仍需经过现有人工确认链路。",
    },
    writebackAllowed: false,
  };
  // Keep a digest for every available writeback target.  Stage-evidence
  // suggestions expose both an action and a risk preview; a single digest
  // would make the less prominent action button unverifiable.  The digest
  // only covers the selected preview and suggestion identity, so these
  // additive fields do not change the canonical input used to calculate it.
  const actionDigest = previewAction ? proactivePreviewDigest(suggestion, "action") : null;
  const riskDigest = previewRisk ? proactivePreviewDigest(suggestion, "risk") : null;
  suggestion.previewDigests = {
    ...(actionDigest ? { action: actionDigest } : {}),
    ...(riskDigest ? { risk: riskDigest } : {}),
  };
  const digest = riskDigest ?? actionDigest;
  suggestion.previewDigest = digest;
  suggestion.writebackPreview.previewDigest = digest;
  return suggestion;
}

function extendedSuggestionFor({ trigger, opportunity, now, details = [], action = null, risk = null }) {
  const customerRef = sourceRef(
    "customer",
    opportunity.customerId,
    opportunity.customerName ?? "关联客户",
    null,
    { version: opportunity.customerVersion, updatedAt: opportunity.customerUpdatedAt },
  );
  const opportunityRef = sourceRef(
    "opportunity",
    opportunity.id,
    opportunity.name ?? "商机",
    null,
    { version: opportunity.version, updatedAt: opportunity.updatedAt },
  );
  const extraRefs = details.map((item) => sourceRef(
    item.type,
    item.id,
    item.label ?? null,
    item.detail ?? null,
    item,
  ));
  const sourceRefs = uniqueRefs([customerRef, opportunityRef, ...extraRefs]);
  const labels = {
    budget_unknown: ["预算信息待补", "当前记录没有项目预算或正式预算依据，商机金额不能直接当作客户预算。", "请确认预算归口、立项状态和可验证的预算材料。"],
    decision_chain_unknown: ["决策链信息待补", "当前记录没有足够证据确认经济决策者、业务决策者或采购角色。", "请确认谁能批准预算、谁会否决项目，以及下一次由谁参加。"],
    purchase_timing_unknown: ["采购时间待补", "当前记录没有可验证的采购窗口、招标节点或客户承诺日期。", "请确认立项、采购、招标和合同节点，不要把估计日期当成客户承诺。"],
    action_due: ["行动已到期或逾期", "已有行动的截止时间已经到达，但系统还没有记录完成结果。", "请更新行动结果或重新约定明确的下一步。"],
    risk_open: ["已有风险尚未解决", "关联商机仍有未关闭风险，推进前需要补充处置结果。", "请先更新风险状态、负责人和截止日期，再决定是否继续投入。"],
    visit_follow_up: ["拜访需要准备或跟进", "关联拜访计划临近、已过期但未标记完成，或缺少已确认的拜访记录。", "请先核对实际拜访状态，再补充会前准备或会后行动。"],
    tender_change: ["招标信息发生变化", "客户匹配的招标公告出现新版本或状态变化，需要重新核对项目和商机关系。", "打开公告原文，确认是否需要创建行动或更新风险。"],
  };
  const [titleSuffix, conclusion, actionDetail] = labels[trigger] ?? ["业务信号待核对", "当前业务记录出现需要人工核对的变化。", "请核对来源并补充下一步。"];
  const title = `${opportunity.name ?? "商机"}${titleSuffix}`;
  const previewAction = action
    ? {
        title: action.title ?? `${opportunity.customerName ?? "客户"}：${titleSuffix}`,
        reason: action.reason ?? conclusion,
        customerId: opportunity.customerId,
        opportunityId: opportunity.id,
        requiresHumanConfirmation: true,
      }
    : null;
  const previewRisk = risk
    ? {
        title: risk.title ?? titleSuffix,
        target: `${opportunity.customerName ?? "客户"} / ${opportunity.name ?? "商机"}`,
        evidence: risk.evidence ?? conclusion,
        action: risk.action ?? actionDetail,
        customerId: opportunity.customerId,
        opportunityId: opportunity.id,
        requiresHumanConfirmation: true,
      }
    : null;
  const snapshotKey = [
    opportunity.version ?? "",
    opportunity.updatedAt ?? "",
    trigger,
    provenanceKey(sourceRefs),
  ].join("|");
  const suggestion = {
    id: stableId(trigger, opportunity.id, snapshotKey),
    schemaVersion: PROACTIVE_ASSISTANT_SCHEMA_VERSION,
    subjectType: "opportunity",
    subjectId: opportunity.id,
    customerId: opportunity.customerId,
    opportunityId: opportunity.id,
    opportunityVersion: opportunity.version,
    customerVersion: opportunity.customerVersion,
    customerName: opportunity.customerName,
    title,
    conclusion,
    facts: [
      fact("opportunity.name", "商机名称", opportunity.name, [opportunityRef]),
      fact("opportunity.stage", "当前阶段", opportunity.stage, [opportunityRef]),
      fact("opportunity.amount", "商机金额（不等于客户预算）", opportunity.amount, [opportunityRef]),
      fact(`signal.${trigger}`, "触发信号", conclusion, sourceRefs),
    ].filter(Boolean),
    inferences: [{ claim: actionDetail, basis: [conclusion], sourceRefs }],
    unknowns: [{ key: `signal.${trigger}`, question: actionDetail, reason: "现有记录没有足够的已确认证据。" }],
    risks: [conclusion],
    nextActions: [{ type: "action_item", title: titleSuffix, detail: actionDetail }],
    evidenceRefs: sourceRefs,
    sourceRefs,
    confidence: null,
    confidenceLevel: "unverified",
    confidenceCalibrated: false,
    priority: null,
    priorityCalibrated: false,
    trigger: { type: trigger, reason: conclusion, detectedAt: now.toISOString() },
    modelVersion: PROACTIVE_ASSISTANT_MODEL_VERSION,
    source: "deterministic",
    fallbackReason: null,
    confirmationStatus: "not_started",
    writebackPreview: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
      action: previewAction,
      risk: previewRisk,
      note: "这是写回预览，不会自动创建行动或风险；确认后仍需经过现有人工确认链路。",
    },
    writebackAllowed: false,
  };
  const actionDigest = previewAction ? proactivePreviewDigest(suggestion, "action") : null;
  const riskDigest = previewRisk ? proactivePreviewDigest(suggestion, "risk") : null;
  suggestion.previewDigests = {
    ...(actionDigest ? { action: actionDigest } : {}),
    ...(riskDigest ? { risk: riskDigest } : {}),
  };
  suggestion.previewDigest = riskDigest ?? actionDigest;
  if (suggestion.previewDigest) suggestion.writebackPreview.previewDigest = suggestion.previewDigest;
  return suggestion;
}

function emptySnapshot({ now, staleDays, limit }) {
  return {
    schemaVersion: PROACTIVE_ASSISTANT_SCHEMA_VERSION,
    modelVersion: PROACTIVE_ASSISTANT_MODEL_VERSION,
    source: "deterministic",
    generatedAt: now.toISOString(),
    staleDays,
    limit,
    items: [],
    counts: {
      total: 0,
      missingNextStep: 0,
      staleOpportunity: 0,
      stageEvidenceMismatch: 0,
    },
    truncated: false,
    writebackPolicy: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
    },
  };
}

/**
 * Build a repeatable, owner-scoped proactive snapshot from server-owned facts.
 * This function deliberately performs no writes and does not call a model.
 */
export function buildProactiveAssistantSnapshot({
  opportunities = [],
  actions = [],
  interactions = [],
  risks = [],
  itineraries = [],
  tenders = [],
  now = new Date(),
  staleDays = DEFAULT_PROACTIVE_STALE_DAYS,
  limit = DEFAULT_PROACTIVE_LIMIT,
  includeAll = false,
  includeExtendedSignals = false,
} = {}) {
  const current = validDate(now);
  if (!current) throw new TypeError("now must be a valid Date");
  const normalizedStaleDays = boundedStaleDays(staleDays);
  const normalizedLimit = boundedLimit(limit);
  const opportunityItems = opportunities.map(normalizeOpportunity).filter(Boolean);
  const actionItems = actions.map(normalizeAction).filter(Boolean);
  const interactionItems = interactions.map(normalizeInteraction).filter(Boolean);
  const riskItems = risks.map(normalizeRisk).filter(Boolean);
  const itineraryItems = itineraries.map(normalizeItinerary).filter(Boolean);
  const tenderItems = tenders.map(normalizeTender).filter(Boolean);
  if (opportunityItems.length === 0) return emptySnapshot({ now: current, staleDays: normalizedStaleDays, limit: normalizedLimit });

  const actionsByOpportunity = new Map();
  for (const action of actionItems) {
    const list = actionsByOpportunity.get(action.opportunityId) ?? [];
    list.push(action);
    actionsByOpportunity.set(action.opportunityId, list);
  }
  const interactionsByOpportunity = new Map();
  const interactionsByCustomer = new Map();
  for (const interaction of interactionItems) {
    if (!usableInteraction(interaction)) continue;
    if (interaction.opportunityId) {
      const list = interactionsByOpportunity.get(interaction.opportunityId) ?? [];
      list.push(interaction);
      interactionsByOpportunity.set(interaction.opportunityId, list);
    }
    if (interaction.customerId) {
      const list = interactionsByCustomer.get(interaction.customerId) ?? [];
      list.push(interaction);
      interactionsByCustomer.set(interaction.customerId, list);
    }
  }

  const risksByOpportunity = new Map();
  for (const risk of riskItems) {
    if (!risk.opportunityId) continue;
    const list = risksByOpportunity.get(risk.opportunityId) ?? [];
    list.push(risk);
    risksByOpportunity.set(risk.opportunityId, list);
  }

  const suggestions = [];
  for (const opportunity of opportunityItems) {
    const currentStage = stageState(opportunity.stage);
    const openActions = (actionsByOpportunity.get(opportunity.id) ?? [])
      .filter((action) => actionContributesToNextStep(action, current));
    const directInteractions = interactionsByOpportunity.get(opportunity.id) ?? [];
    // Customer-level records and records linked to a sibling opportunity are
    // retained only as background context.  They must never satisfy this
    // opportunity's own stale/evidence rule.
    const backgroundInteractions = (interactionsByCustomer.get(opportunity.customerId) ?? [])
      .filter((item) => item.opportunityId !== opportunity.id);
    const relevantInteractions = directInteractions.filter((item) => (
      !item.customerId || item.customerId === opportunity.customerId
    ));
    const lastInteraction = relevantInteractions
      .map((item) => validDate(item.occurredAt))
      .filter(Boolean)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    const stale = !currentStage.terminal
      && !currentStage.paused
      && Boolean(lastInteraction)
      && ageInDays(lastInteraction, current) >= normalizedStaleDays;
    const missingNextStep = !currentStage.terminal
      && !opportunity.next
      && openActions.length === 0;
    const mismatch = stageEvidenceMismatch(opportunity, relevantInteractions.length);

    if (missingNextStep) suggestions.push(suggestionFor({
      trigger: "missing_next_step",
      opportunity,
      interactions: relevantInteractions,
      backgroundInteractions,
      openActions,
      now: current,
      staleDays: normalizedStaleDays,
    }));
    if (stale) suggestions.push(suggestionFor({
      trigger: "stale_opportunity",
      opportunity,
      interactions: relevantInteractions,
      backgroundInteractions,
      openActions,
      now: current,
      staleDays: normalizedStaleDays,
    }));
    if (mismatch) suggestions.push(suggestionFor({
      trigger: "stage_evidence_mismatch",
      opportunity,
      interactions: relevantInteractions,
      backgroundInteractions,
      openActions,
      now: current,
      staleDays: normalizedStaleDays,
    }));

    if (includeExtendedSignals) {
      const sourceOpportunity = { ...opportunity };
      if (!sourceOpportunity.budget) suggestions.push(extendedSuggestionFor({
        trigger: "budget_unknown",
        opportunity: sourceOpportunity,
        now: current,
        details: [{
          type: "opportunity",
          id: opportunity.id,
          label: "商机预算字段",
          version: opportunity.version,
          updatedAt: opportunity.updatedAt,
        }],
        action: { title: `确认${opportunity.customerName ?? "客户"}项目预算`, reason: "商机金额不能替代客户预算依据。" },
      }));
      if (sourceOpportunity.decisionChain.length === 0) suggestions.push(extendedSuggestionFor({
        trigger: "decision_chain_unknown",
        opportunity: sourceOpportunity,
        now: current,
        details: [{
          type: "customer",
          id: opportunity.customerId,
          label: "客户决策链",
          version: opportunity.customerVersion,
          updatedAt: opportunity.customerUpdatedAt,
        }],
        action: { title: `确认${opportunity.customerName ?? "客户"}决策链`, reason: "当前没有已确认的决策角色。" },
      }));
      if (!sourceOpportunity.purchaseTime) suggestions.push(extendedSuggestionFor({
        trigger: "purchase_timing_unknown",
        opportunity: sourceOpportunity,
        now: current,
        details: [{
          type: "opportunity",
          id: opportunity.id,
          label: "采购时间",
          version: opportunity.version,
          updatedAt: opportunity.updatedAt,
        }],
        action: { title: `确认${opportunity.customerName ?? "客户"}采购时间`, reason: "当前没有客户确认的采购窗口。" },
      }));
      const overdueActions = openActions.filter((item) => {
        const due = validDate(item.due);
        return due && due.getTime() <= current.getTime();
      });
      if (overdueActions.length > 0) suggestions.push(extendedSuggestionFor({
        trigger: "action_due",
        opportunity: sourceOpportunity,
        now: current,
        details: overdueActions.slice(0, 5).map((item) => ({
          type: "action_item",
          id: item.id,
          label: item.title,
          detail: item.due,
          version: item.version,
          updatedAt: item.updatedAt,
          due: item.due,
          status: item.status,
        })),
        action: null,
      }));
      const openRisks = (risksByOpportunity.get(opportunity.id) ?? []).filter((item) => item.status !== "closed");
      if (openRisks.length > 0) suggestions.push(extendedSuggestionFor({
        trigger: "risk_open",
        opportunity: sourceOpportunity,
        now: current,
        details: openRisks.slice(0, 5).map((item) => ({
          type: "risk_item",
          id: item.id,
          label: item.title,
          detail: item.status,
          version: item.version,
          updatedAt: item.updatedAt,
          due: item.due,
          status: item.status,
        })),
        risk: { title: "先处理关联未解决风险", evidence: `${openRisks.length} 条关联风险仍未关闭。`, action: "更新风险处置结果并由负责人确认。" },
      }));
      const visits = itineraryItems.filter((item) => (
        item.status !== "cancelled"
        && ((!item.opportunityId || item.opportunityId === opportunity.id)
          && (!item.customerId || item.customerId === opportunity.customerId))
      ));
      const needsVisitFollowUp = visits.some((item) => {
        if (item.status === "completed") return false;
        const visitDate = validDate(item.visitDate);
        return !visitDate || visitDate.getTime() <= current.getTime() + 3 * DAY_MS;
      });
      if (needsVisitFollowUp) suggestions.push(extendedSuggestionFor({
        trigger: "visit_follow_up",
        opportunity: sourceOpportunity,
        now: current,
        details: visits.slice(0, 5).map((item) => ({
          type: "visit_itinerary",
          id: item.id,
          label: item.title,
          detail: item.visitDate,
          version: item.version,
          updatedAt: item.updatedAt,
          visitDate: item.visitDate,
          status: item.status,
        })),
        action: { title: "核对拜访状态并补充会前或会后动作", reason: "拜访计划临近或已过，但还没有已确认的完成记录。" },
      }));
      const matchedTenders = tenderItems.filter((item) => !item.customerId || item.customerId === opportunity.customerId);
      if (matchedTenders.length > 0) suggestions.push(extendedSuggestionFor({
        trigger: "tender_change",
        opportunity: sourceOpportunity,
        now: current,
        details: matchedTenders.slice(0, 5).map((item) => ({
          type: "hospital_tender_notice",
          id: item.id,
          label: item.title,
          detail: item.noticeType,
          identityKey: item.identityKey,
          version: item.version,
          revision: item.revision,
          updatedAt: item.updatedAt,
          publishedAt: item.publishedAt,
          noticeType: item.noticeType,
          sourceId: item.sourceId,
          contentSha256: item.contentSha256,
        })),
        action: { title: "查看招标公告变化并确认下一步", reason: "客户匹配的招标公告有新版本或状态变化。" },
      }));
    }
  }

  suggestions.sort((left, right) => {
    const leftAge = Number.isSafeInteger(left.trigger.ageDays) ? left.trigger.ageDays : -1;
    const rightAge = Number.isSafeInteger(right.trigger.ageDays) ? right.trigger.ageDays : -1;
    if (rightAge !== leftAge) return rightAge - leftAge;
    const leftEvidence = Number.isSafeInteger(left.facts.find((item) => item.key === "interaction.count")?.value)
      ? left.facts.find((item) => item.key === "interaction.count").value
      : 0;
    const rightEvidence = Number.isSafeInteger(right.facts.find((item) => item.key === "interaction.count")?.value)
      ? right.facts.find((item) => item.key === "interaction.count").value
      : 0;
    if (leftEvidence !== rightEvidence) return leftEvidence - rightEvidence;
    const leftOpportunityId = left.opportunityId ?? left.subjectId ?? "";
    const rightOpportunityId = right.opportunityId ?? right.subjectId ?? "";
    if (leftOpportunityId !== rightOpportunityId) return leftOpportunityId.localeCompare(rightOpportunityId);
    const leftTriggerOrder = TRIGGER_ORDER[left.trigger?.type] ?? Number.MAX_SAFE_INTEGER;
    const rightTriggerOrder = TRIGGER_ORDER[right.trigger?.type] ?? Number.MAX_SAFE_INTEGER;
    if (leftTriggerOrder !== rightTriggerOrder) return leftTriggerOrder - rightTriggerOrder;
    return left.id.localeCompare(right.id);
  });
  const items = includeAll ? suggestions : suggestions.slice(0, normalizedLimit);
  const counts = {
    total: suggestions.length,
    missingNextStep: suggestions.filter((item) => item.trigger.type === "missing_next_step").length,
    staleOpportunity: suggestions.filter((item) => item.trigger.type === "stale_opportunity").length,
    stageEvidenceMismatch: suggestions.filter((item) => item.trigger.type === "stage_evidence_mismatch").length,
    budgetUnknown: suggestions.filter((item) => item.trigger.type === "budget_unknown").length,
    decisionChainUnknown: suggestions.filter((item) => item.trigger.type === "decision_chain_unknown").length,
    purchaseTimingUnknown: suggestions.filter((item) => item.trigger.type === "purchase_timing_unknown").length,
    actionDue: suggestions.filter((item) => item.trigger.type === "action_due").length,
    riskOpen: suggestions.filter((item) => item.trigger.type === "risk_open").length,
    visitFollowUp: suggestions.filter((item) => item.trigger.type === "visit_follow_up").length,
    tenderChange: suggestions.filter((item) => item.trigger.type === "tender_change").length,
  };
  return {
    schemaVersion: PROACTIVE_ASSISTANT_SCHEMA_VERSION,
    modelVersion: PROACTIVE_ASSISTANT_MODEL_VERSION,
    source: "deterministic",
    generatedAt: current.toISOString(),
    staleDays: normalizedStaleDays,
    limit: normalizedLimit,
    items,
    counts,
    truncated: suggestions.length > items.length,
    writebackPolicy: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
    },
  };
}

/**
 * Read the minimal server-owned rows needed by the proactive rules.  Raw
 * quick-record text is intentionally not selected or returned.
 */
export function createProactiveAssistantSnapshotFromDb({
  db,
  owner,
  now = new Date(),
  staleDays = DEFAULT_PROACTIVE_STALE_DAYS,
  limit = DEFAULT_PROACTIVE_LIMIT,
  includeAll = false,
  includeExtendedSignals = true,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  const normalizedOwner = identifier(owner);
  const current = validDate(now);
  if (!current) throw new TypeError("now must be a valid Date");
  const normalizedStaleDays = boundedStaleDays(staleDays);
  const normalizedLimit = boundedLimit(limit);
  if (!normalizedOwner) return emptySnapshot({ now: current, staleDays: normalizedStaleDays, limit: normalizedLimit });

  const opportunities = db.prepare(`
    SELECT opportunity.id, opportunity.version, opportunity.customer_id, opportunity.name,
           opportunity.customer, opportunity.stage, opportunity.amount, opportunity.probability,
           opportunity.days, opportunity.next, opportunity.created_at, opportunity.updated_at,
           customer.name AS customer_name,
           customer.version AS customer_version,
           customer.updated_at AS customer_updated_at,
           customer.budget AS customer_budget,
           customer.decision_chain AS customer_decision_chain
    FROM opportunities opportunity
    INNER JOIN customers customer
      ON customer.id = opportunity.customer_id
     AND customer.deleted_at IS NULL
     AND customer.owner = $owner
    WHERE opportunity.deleted_at IS NULL
      AND opportunity.owner = $owner
    ORDER BY opportunity.updated_at DESC, opportunity.id
  `).all({ $owner: normalizedOwner }).map((row) => ({
    id: row.id,
    version: row.version,
    customerId: row.customer_id,
    customerName: row.customer_name ?? row.customer,
    customerVersion: row.customer_version,
    name: row.name,
    stage: row.stage,
    amount: row.amount,
    probability: row.probability,
    days: row.days,
    next: row.next,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    budget: row.customer_budget,
    decisionChain: parseJsonArray(row.customer_decision_chain),
    customerUpdatedAt: row.customer_updated_at,
    // The current opportunity schema has no dedicated purchase-window
    // column. Keep this explicitly unknown instead of reading an invented
    // field; the extended rule will ask for a verified procurement window.
    purchaseTime: null,
  }));
  if (opportunities.length === 0) return emptySnapshot({ now: current, staleDays: normalizedStaleDays, limit: normalizedLimit });

  const actions = db.prepare(`
    SELECT id, opportunity_id, title, status, due, version, updated_at
    FROM action_items
    WHERE owner = $owner
      AND deleted_at IS NULL
      AND opportunity_id IS NOT NULL
  `).all({ $owner: normalizedOwner }).map((row) => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    title: row.title,
    status: row.status,
    due: row.due,
    version: row.version,
    updatedAt: row.updated_at,
  }));
  const interactions = db.prepare(`
    SELECT id, opportunity_id, customer_id, occurred_at, source_channel, status,
           version, updated_at, voided_at, created_at
    FROM quick_records
    WHERE owner = $owner
      AND voided_at IS NULL
  `).all({ $owner: normalizedOwner }).map((row) => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    customerId: row.customer_id,
    occurredAt: row.occurred_at,
    sourceChannel: row.source_channel,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  }));

  const risks = db.prepare(`
    SELECT id, opportunity_id, customer_id, title, status, severity, due, version, updated_at
      FROM risk_items
     WHERE owner = $owner
       AND deleted_at IS NULL
       AND opportunity_id IS NOT NULL
  `).all({ $owner: normalizedOwner }).map((row) => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    customerId: row.customer_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    due: row.due,
    version: row.version,
    updatedAt: row.updated_at,
  }));

  const itineraries = db.prepare(`
    SELECT id, version, title, visit_date, status, request_json, plan_json, updated_at
      FROM visit_itineraries
     WHERE owner = $owner
       AND deleted_at IS NULL
       AND status <> 'cancelled'
     ORDER BY visit_date ASC, id ASC
     LIMIT 100
  `).all({ $owner: normalizedOwner }).map((row) => {
    let request = {};
    let plan = {};
    try { request = JSON.parse(row.request_json ?? "{}"); } catch {}
    try { plan = JSON.parse(row.plan_json ?? "{}"); } catch {}
    return {
      id: row.id,
      version: row.version,
      title: row.title,
      visitDate: row.visit_date,
      status: row.status,
      updatedAt: row.updated_at,
      customerId: request.customerId ?? request.customer_id ?? plan.customerId ?? plan.customer_id ?? null,
      opportunityId: request.opportunityId ?? request.opportunity_id ?? plan.opportunityId ?? plan.opportunity_id ?? null,
    };
  });

  const tenders = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hospital_tender_notices'").get()) {
    const notices = db.prepare(`
      SELECT id, identity_key, title, notice_type, published_at, source_id,
             content_sha256, match_customer_ids_json
        FROM hospital_tender_notices
       ORDER BY published_at DESC, id DESC
       LIMIT 200
    `).all();
    for (const row of notices) {
      let customerIds = [];
      try { customerIds = JSON.parse(row.match_customer_ids_json ?? "[]"); } catch {}
      for (const customerId of Array.isArray(customerIds) ? customerIds : []) {
        tenders.push({
          id: row.id ?? row.identity_key,
          identityKey: row.identity_key,
          customerId,
          title: row.title,
          noticeType: row.notice_type,
          publishedAt: row.published_at,
          sourceId: row.source_id,
          contentSha256: row.content_sha256,
        });
      }
    }
  }

  return buildProactiveAssistantSnapshot({
    opportunities,
    actions,
    interactions,
    risks,
    itineraries,
    tenders,
    now: current,
    staleDays: normalizedStaleDays,
    limit: normalizedLimit,
    includeAll,
    includeExtendedSignals,
  });
}

/**
 * Resolve a suggestion by its stable ID from the complete owner-scoped
 * snapshot.  Confirmation callers must use this path instead of searching
 * the bounded first page, otherwise a valid card after the page boundary
 * would look missing while its preview is still open.
 */
export function findProactiveAssistantSuggestionFromDb({
  db,
  owner,
  suggestionId,
  now = new Date(),
  staleDays = DEFAULT_PROACTIVE_STALE_DAYS,
} = {}) {
  const normalizedId = identifier(suggestionId);
  if (!normalizedId) return null;
  const snapshot = createProactiveAssistantSnapshotFromDb({
    db,
    owner,
    now,
    staleDays,
    includeAll: true,
  });
  return snapshot.items.find((item) => item.id === normalizedId) ?? null;
}
