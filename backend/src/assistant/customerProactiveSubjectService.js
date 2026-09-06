import { createHash, randomUUID } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import {
  buildProactiveAssistantSnapshot,
  proactivePreviewDigest,
} from "./proactiveAssistant.js";
import { createProactiveSuggestionRepository } from "./proactiveSuggestionRepository.js";

export const CUSTOMER_PROACTIVE_SUBJECT_TYPE = "customer";
export const CUSTOMER_PROACTIVE_SUBJECT_SCHEMA_VERSION = "customer-proactive-subject-v1";

const MAX_SOURCE_REFS = 100;
const MAX_CANONICAL_SOURCE_REFS = 2_000;
const MAX_CONTEXT_ITEMS = 500;
const SAFE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,500}$/u;
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
const CUSTOMER_TRIGGER_LABELS = Object.freeze({
  missing_next_step: "缺少下一步动作",
  stale_opportunity: "有商机长期没有有效互动",
  stage_evidence_mismatch: "商机阶段证据待核对",
  budget_unknown: "预算信息待补",
  decision_chain_unknown: "决策链信息待补",
  purchase_timing_unknown: "采购时间待补",
  action_due: "行动已到期或逾期",
  risk_open: "有未解决风险",
  visit_follow_up: "拜访需要准备或跟进",
  tender_change: "招标信息发生变化",
});
const CUSTOMER_TRIGGER_ORDER = Object.freeze([
  "missing_next_step",
  "stale_opportunity",
  "stage_evidence_mismatch",
  "budget_unknown",
  "decision_chain_unknown",
  "purchase_timing_unknown",
  "action_due",
  "risk_open",
  "visit_follow_up",
  "tender_change",
]);
const CUSTOMER_COUNT_KEYS = Object.freeze({
  missing_next_step: "missingNextStep",
  stale_opportunity: "staleOpportunity",
  stage_evidence_mismatch: "stageEvidenceMismatch",
  budget_unknown: "budgetUnknown",
  decision_chain_unknown: "decisionChainUnknown",
  purchase_timing_unknown: "purchaseTimingUnknown",
  action_due: "actionDue",
  risk_open: "riskOpen",
  visit_follow_up: "visitFollowUp",
  tender_change: "tenderChange",
});

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is invalid`);
  }
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function optionalText(value, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function identifier(value, name, max = 500) {
  const normalized = requiredText(value, name, max);
  if (!SAFE_IDENTIFIER.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function positiveInteger(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function validDate(value) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? null : copy;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

function clockDate(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const date = validDate(clock());
  if (!date) throw new TypeError("clock must return a valid Date");
  return date;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function arrayValue(value, max = 50) {
  const parsed = Array.isArray(value) ? value : parseJson(value, []);
  return Array.isArray(parsed) ? parsed.slice(0, max) : [];
}

function canonicalValue(value, path = "value", depth = 0) {
  if (depth > 12) throw new TypeError(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`, depth + 1));
  if (!value || typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], `${path}.${key}`, depth + 1)]));
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readValue(item, ...keys) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(item, key) && item[key] !== undefined) return item[key];
  }
  return undefined;
}

function provenanceValue(key, item) {
  const aliases = {
    version: ["version"],
    revision: ["revision", "canonicalRevision", "noticeVersion"],
    updatedAt: ["updatedAt", "updated_at"],
    occurredAt: ["occurredAt", "occurred_at", "createdAt", "created_at"],
    publishedAt: ["publishedAt", "published_at"],
    visitDate: ["visitDate", "visit_date"],
    due: ["due", "dueDate", "due_date"],
    status: ["status"],
    confirmationStatus: ["confirmationStatus", "confirmation_status"],
    voidedAt: ["voidedAt", "voided_at"],
    identityKey: ["identityKey", "identity_key", "canonicalNoticeId", "canonical_notice_id"],
    sourceId: ["sourceId", "source_id"],
    noticeType: ["noticeType", "notice_type"],
    contentSha256: ["contentSha256", "content_sha256", "canonicalDigest", "canonical_digest"],
  };
  const value = readValue(item, ...(aliases[key] ?? [key]));
  if (value === undefined || value === null || value === "") return null;
  if (key === "version") return positiveInteger(value);
  if (["updatedAt", "occurredAt", "publishedAt", "voidedAt"].includes(key)) return iso(value);
  if (key === "contentSha256") return optionalText(value, 200)?.toLowerCase() ?? null;
  if (key === "revision") return positiveInteger(value) ?? optionalText(value, 200);
  return optionalText(value, 500);
}

function sourceRef(type, item, fallbackId = null) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const resolvedType = optionalText(type, 100);
  const rawId = readValue(item, "id", "canonicalNoticeId", "canonical_notice_id", "identityKey", "identity_key") ?? fallbackId;
  const id = optionalText(rawId, 500);
  if (!resolvedType || !id || !SAFE_IDENTIFIER.test(id)) return null;
  const label = optionalText(readValue(item, "label", "name", "title", "customerName", "customer_name"), 200);
  const detail = optionalText(readValue(item, "detail", "reason"), 500);
  const result = { type: resolvedType, id };
  if (label) result.label = label;
  if (detail) result.detail = detail;
  for (const key of PROVENANCE_KEYS) {
    const value = provenanceValue(key, item);
    if (value !== null) result[key] = value;
  }
  return result;
}

function refKey(ref) {
  return `${ref.type}\u0000${ref.id}`;
}

function mergeRefs(existing, next) {
  const merged = { ...existing };
  for (const key of ["label", "detail", ...PROVENANCE_KEYS]) {
    if (!Object.hasOwn(next ?? {}, key)) continue;
    const value = next[key];
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
    else if (!Object.hasOwn(merged, key)) merged[key] = value ?? null;
  }
  return merged;
}

function normalizeSourceRefs(refs) {
  const indexes = new Map();
  const result = [];
  for (const raw of Array.isArray(refs) ? refs : []) {
    const ref = sourceRef(raw?.type, raw);
    if (!ref) continue;
    const key = refKey(ref);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, result.length);
      result.push(ref);
    } else {
      result[index] = mergeRefs(result[index], ref);
    }
    if (result.length >= MAX_CANONICAL_SOURCE_REFS) break;
  }
  return result.sort((left, right) => {
    const typeOrder = left.type.localeCompare(right.type);
    return typeOrder || left.id.localeCompare(right.id);
  });
}

function canonicalSourceRefs(refs) {
  return normalizeSourceRefs(refs).map((ref) => {
    const projected = { type: ref.type, id: ref.id };
    for (const key of PROVENANCE_KEYS) {
      if (Object.hasOwn(ref, key) && ref[key] !== null && ref[key] !== undefined && ref[key] !== "") {
        projected[key] = ref[key];
      }
    }
    return projected;
  });
}

export function customerSubjectSourceDigest(sourceRefs = []) {
  return hash(JSON.stringify(canonicalValue(canonicalSourceRefs(sourceRefs), "sourceRefs")));
}

export function customerSubjectKey(owner, customerId) {
  return `customer:${identifier(owner, "owner", 200)}:${identifier(customerId, "customerId", 200)}`;
}

function stableSuggestionId(subjectKey, trigger) {
  return `proactive-customer-${hash(`${CUSTOMER_PROACTIVE_SUBJECT_SCHEMA_VERSION}\u0000${subjectKey}\u0000${trigger}`).slice(0, 24)}`;
}

function customerSuggestionDedupeKey(subjectKey, trigger) {
  return `proactive:v1:${subjectKey}:${trigger}`;
}

function normalizeCustomer(value, fallbackId) {
  const id = identifier(readValue(value, "id") ?? fallbackId, "customerId", 200);
  return {
    id,
    owner: optionalText(readValue(value, "owner"), 200),
    name: optionalText(readValue(value, "name", "customerName", "customer_name"), 200),
    version: positiveInteger(readValue(value, "version")),
    updatedAt: iso(readValue(value, "updatedAt", "updated_at")),
    budget: optionalText(readValue(value, "budget"), 300),
    decisionChain: arrayValue(readValue(value, "decisionChain", "decision_chain"), 20),
  };
}

function normalizedRows(rows, owner, customerId, type, opportunityIds) {
  const result = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rowOwner = optionalText(readValue(item, "owner"), 200);
    if (rowOwner && rowOwner !== owner) continue;
    const rowCustomerId = optionalText(readValue(item, "customerId", "customer_id"), 200);
    const rowOpportunityId = optionalText(readValue(item, "opportunityId", "opportunity_id"), 200);
    if (type === "opportunity") {
      if (rowCustomerId !== customerId) continue;
    } else if (type === "tender") {
      if (rowCustomerId && rowCustomerId !== customerId) continue;
    } else if (type === "interaction" || type === "risk" || type === "itinerary") {
      if (rowCustomerId && rowCustomerId !== customerId && !opportunityIds.has(rowOpportunityId)) continue;
      if (!rowCustomerId && (!rowOpportunityId || !opportunityIds.has(rowOpportunityId))) continue;
    } else if (type === "action") {
      if (!opportunityIds.has(rowOpportunityId) && rowCustomerId !== customerId) continue;
    }
    result.push(item);
    if (result.length >= MAX_CONTEXT_ITEMS) break;
  }
  return result;
}

function uniqueIds(values) {
  return [...new Set(values.map((value) => optionalText(value, 200)).filter(Boolean))].sort();
}

function normalizedSourceRefsForSubject({ customer, opportunities, actions, interactions, risks, itineraries, tenders, extraRefs = [] }) {
  const refs = [sourceRef("customer", customer)];
  refs.push(...opportunities.map((item) => sourceRef("opportunity", item)));
  refs.push(...actions.map((item) => sourceRef("action_item", item)));
  refs.push(...interactions.map((item) => sourceRef("quick_record", item)));
  refs.push(...risks.map((item) => sourceRef("risk_item", item)));
  refs.push(...itineraries.map((item) => sourceRef("visit_itinerary", item)));
  refs.push(...tenders.map((item) => sourceRef("hospital_tender_notice", item)));
  refs.push(...extraRefs);
  return normalizeSourceRefs(refs);
}

function sourceRefsForValue(value) {
  return normalizeSourceRefs(Array.isArray(value) ? value : []);
}

function stableValue(value) {
  try {
    return JSON.stringify(canonicalValue(value));
  } catch {
    return String(value ?? "");
  }
}

function mergeFacts(candidates, subjectRefs, customer, opportunityIds) {
  const result = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const key = `${String(item.key ?? "fact")}\u0000${stableValue(item.value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      ...item,
      sourceRefs: sourceRefsForValue(item.sourceRefs).length > 0 ? sourceRefsForValue(item.sourceRefs) : subjectRefs,
    });
  };
  const customerRef = subjectRefs.filter((ref) => ref.type === "customer" && ref.id === customer.id);
  if (customer.name) push({ key: "customer.name", label: "客户名称", value: customer.name, sourceRefs: customerRef });
  push({
    key: "customer.opportunityCount",
    label: "客户商机数",
    value: opportunityIds.length,
    sourceRefs: subjectRefs.filter((ref) => ref.type === "opportunity"),
  });
  push({
    key: "customer.contributingOpportunityIds",
    label: "触发信号的商机",
    value: opportunityIds,
    sourceRefs: subjectRefs.filter((ref) => ref.type === "opportunity" && opportunityIds.includes(ref.id)),
  });
  for (const candidate of candidates) {
    for (const item of Array.isArray(candidate.facts) ? candidate.facts : []) push(item);
  }
  return result.slice(0, 60);
}

function mergeInferences(candidates, subjectRefs) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const item of Array.isArray(candidate.inferences) ? candidate.inferences : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const key = `${item.claim ?? ""}\u0000${stableValue(item.basis)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        ...item,
        sourceRefs: sourceRefsForValue(item.sourceRefs).length > 0 ? sourceRefsForValue(item.sourceRefs) : subjectRefs,
      });
    }
  }
  return result.slice(0, 40);
}

function mergeUnknowns(candidates) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const item of Array.isArray(candidate.unknowns) ? candidate.unknowns : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const key = `${item.key ?? ""}\u0000${item.question ?? ""}\u0000${item.reason ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...item });
    }
  }
  return result.slice(0, 40);
}

function mergeRisks(candidates) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const item of Array.isArray(candidate.risks) ? candidate.risks : []) {
      const value = typeof item === "string" ? item.trim() : item;
      if (!value || (typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))) continue;
      const key = stableValue(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
  }
  return result.slice(0, 30);
}

function mergeNextActions(candidates) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const item of Array.isArray(candidate.nextActions) ? candidate.nextActions : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const key = `${item.type ?? ""}\u0000${item.title ?? ""}\u0000${item.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...item });
    }
  }
  return result.slice(0, 20);
}

function subjectPreview(preview, { customer, subjectKey, subjectVersion, sourceDigest, primaryOpportunityId, opportunityIds }) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  return {
    ...preview,
    customerId: customer.id,
    customerName: customer.name,
    opportunityId: primaryOpportunityId,
    opportunityIds,
    contributingOpportunityIds: opportunityIds,
    subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
    subjectId: customer.id,
    subjectKey,
    subjectVersion,
    expectedSubjectVersion: subjectVersion,
    sourceDigest,
    expectedSourceDigest: sourceDigest,
    requiresHumanConfirmation: true,
  };
}

function candidateSort(left, right) {
  const leftAge = Number.isSafeInteger(left?.trigger?.ageDays) ? left.trigger.ageDays : -1;
  const rightAge = Number.isSafeInteger(right?.trigger?.ageDays) ? right.trigger.ageDays : -1;
  if (rightAge !== leftAge) return rightAge - leftAge;
  const leftOpportunity = String(left?.opportunityId ?? "");
  const rightOpportunity = String(right?.opportunityId ?? "");
  return leftOpportunity.localeCompare(rightOpportunity) || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function aggregateCandidateGroup({ trigger, candidates, customer, subjectKey, subjectVersion, sourceDigest, subjectRefs, opportunityIds }) {
  const ordered = candidates.slice().sort(candidateSort);
  const primary = ordered[0] ?? {};
  const primaryOpportunityId = optionalText(primary.opportunityId, 200) ?? opportunityIds[0] ?? null;
  const label = CUSTOMER_TRIGGER_LABELS[trigger] ?? "业务信号待核对";
  const customerName = customer.name ?? customer.id;
  const title = `${customerName}${opportunityIds.length > 1 ? `（${opportunityIds.length} 个商机）` : ""}${label}`;
  const conclusions = ordered.map((item) => optionalText(item.conclusion, 1_000)).filter(Boolean);
  const conclusion = opportunityIds.length > 1
    ? `客户“${customerName}”有 ${opportunityIds.length} 个商机触发“${label}”，需要统一核对。${conclusions[0] ?? "请查看关联证据并确认下一步。"}`
    : conclusions[0] ?? `客户“${customerName}”出现“${label}”信号，请核对关联证据。`;
  const actionPreview = ordered.find((item) => item.writebackPreview?.action)?.writebackPreview?.action ?? null;
  const riskPreview = ordered.find((item) => item.writebackPreview?.risk)?.writebackPreview?.risk ?? null;
  const suggestion = {
    id: stableSuggestionId(subjectKey, trigger),
    schemaVersion: "proactive-assistant-v1",
    subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
    subjectId: customer.id,
    subjectKey,
    subjectVersion,
    customerSubjectKey: subjectKey,
    customerId: customer.id,
    customerName: customer.name,
    opportunityId: primaryOpportunityId,
    opportunityIds,
    contributingOpportunityIds: opportunityIds,
    opportunityVersion: positiveInteger(primary.opportunityVersion, 1),
    customerVersion: positiveInteger(primary.customerVersion ?? customer.version, 1),
    title,
    conclusion,
    facts: mergeFacts(ordered, subjectRefs, customer, opportunityIds),
    inferences: mergeInferences(ordered, subjectRefs),
    unknowns: mergeUnknowns(ordered),
    risks: mergeRisks(ordered),
    nextActions: mergeNextActions(ordered),
    evidenceRefs: subjectRefs,
    sourceRefs: subjectRefs,
    sourceDigest,
    subjectSourceDigest: sourceDigest,
    subjectSourceRefs: subjectRefs,
    confidence: ordered.find((item) => Number.isFinite(item.confidence))?.confidence ?? null,
    confidenceLevel: ordered.some((item) => item.confidenceLevel === "model") ? "model" : "unverified",
    confidenceCalibrated: false,
    priority: Math.max(0, ...ordered.map((item) => Number.isSafeInteger(item.priority) ? item.priority : 0)),
    priorityCalibrated: false,
    trigger: {
      type: trigger,
      reason: conclusions[0] ?? label,
      detectedAt: ordered[0]?.trigger?.detectedAt ?? null,
      customerSubjectKey: subjectKey,
      contributingOpportunityIds: opportunityIds,
    },
    modelVersion: ordered.find((item) => item.modelVersion)?.modelVersion ?? "rules/proactive-v1",
    source: ordered.some((item) => item.source === "model") ? "model" : "deterministic",
    fallbackReason: ordered.find((item) => item.fallbackReason)?.fallbackReason ?? null,
    confirmationStatus: "not_started",
    writebackPreview: {
      requiresHumanConfirmation: true,
      automaticWriteAllowed: false,
      action: subjectPreview(actionPreview, {
        customer,
        subjectKey,
        subjectVersion,
        sourceDigest,
        primaryOpportunityId,
        opportunityIds,
      }),
      risk: subjectPreview(riskPreview, {
        customer,
        subjectKey,
        subjectVersion,
        sourceDigest,
        primaryOpportunityId,
        opportunityIds,
      }),
      note: "这是客户级写回预览，不会自动创建行动或风险；确认时必须再次校验客户主体版本。",
    },
    writebackAllowed: false,
  };
  const actionDigest = suggestion.writebackPreview.action ? proactivePreviewDigest(suggestion, "action") : null;
  const riskDigest = suggestion.writebackPreview.risk ? proactivePreviewDigest(suggestion, "risk") : null;
  suggestion.previewDigests = {
    ...(actionDigest ? { action: actionDigest } : {}),
    ...(riskDigest ? { risk: riskDigest } : {}),
  };
  suggestion.previewDigest = riskDigest ?? actionDigest ?? null;
  if (suggestion.previewDigest) suggestion.writebackPreview.previewDigest = suggestion.previewDigest;
  suggestion.customerSubject = {
    identity: subjectKey,
    owner: null,
    subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
    subjectId: customer.id,
    customerId: customer.id,
    version: subjectVersion,
    sourceDigest,
    sourceRefs: subjectRefs,
    suggestionCount: null,
    updatedAt: null,
  };
  return suggestion;
}

function suggestionCounts(suggestions) {
  const counts = {
    total: suggestions.length,
    missingNextStep: 0,
    staleOpportunity: 0,
    stageEvidenceMismatch: 0,
    budgetUnknown: 0,
    decisionChainUnknown: 0,
    purchaseTimingUnknown: 0,
    actionDue: 0,
    riskOpen: 0,
    visitFollowUp: 0,
    tenderChange: 0,
  };
  for (const suggestion of suggestions) {
    const key = CUSTOMER_COUNT_KEYS[suggestion?.trigger?.type];
    if (key) counts[key] += 1;
  }
  return counts;
}

/**
 * Build one customer subject from all of the owner's source rows.  This is a
 * pure operation: it does not write the subject ledger and can therefore be
 * used by HTTP previews, background scans, and deterministic tests alike.
 */
export function buildCustomerProactiveSubject({
  owner,
  customer,
  customerId = null,
  opportunities = [],
  actions = [],
  interactions = [],
  risks = [],
  itineraries = [],
  tenders = [],
  now = new Date(),
  staleDays = undefined,
  includeExtendedSignals = true,
  snapshotBuilder = buildProactiveAssistantSnapshot,
  extraSourceRefs = [],
  subjectVersion = 1,
} = {}) {
  const normalizedOwner = identifier(owner, "owner", 200);
  const normalizedCustomer = normalizeCustomer(customer, customerId);
  if (normalizedCustomer.owner && normalizedCustomer.owner !== normalizedOwner) {
    throw new HttpError(404, "PROACTIVE_CUSTOMER_NOT_FOUND", "The customer is not available for this owner");
  }
  if (typeof snapshotBuilder !== "function") throw new TypeError("snapshotBuilder must be a function");
  const scopedOpportunities = normalizedRows(opportunities, normalizedOwner, normalizedCustomer.id, "opportunity", new Set());
  const opportunityIds = new Set(scopedOpportunities.map((item) => optionalText(readValue(item, "id"), 200)).filter(Boolean));
  const scopedActions = normalizedRows(actions, normalizedOwner, normalizedCustomer.id, "action", opportunityIds);
  const scopedInteractions = normalizedRows(interactions, normalizedOwner, normalizedCustomer.id, "interaction", opportunityIds);
  const scopedRisks = normalizedRows(risks, normalizedOwner, normalizedCustomer.id, "risk", opportunityIds);
  const scopedItineraries = normalizedRows(itineraries, normalizedOwner, normalizedCustomer.id, "itinerary", opportunityIds);
  const scopedTenders = normalizedRows(tenders, normalizedOwner, normalizedCustomer.id, "tender", opportunityIds);
  const normalizedOpportunityIds = uniqueIds([...opportunityIds]);
  const allRefs = normalizedSourceRefsForSubject({
    customer: normalizedCustomer,
    opportunities: scopedOpportunities,
    actions: scopedActions,
    interactions: scopedInteractions,
    risks: scopedRisks,
    itineraries: scopedItineraries,
    tenders: scopedTenders,
    extraRefs: extraSourceRefs,
  });
  const subjectRefs = allRefs.slice(0, MAX_SOURCE_REFS);
  const sourceDigest = customerSubjectSourceDigest(allRefs);
  const subjectKey = customerSubjectKey(normalizedOwner, normalizedCustomer.id);
  const snapshot = snapshotBuilder({
    opportunities: scopedOpportunities,
    actions: scopedActions,
    interactions: scopedInteractions,
    risks: scopedRisks,
    itineraries: scopedItineraries,
    tenders: scopedTenders,
    now,
    ...(staleDays === undefined ? {} : { staleDays }),
    limit: 100,
    includeAll: true,
    includeExtendedSignals,
  });
  const groups = new Map();
  for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
    const trigger = optionalText(item?.trigger?.type, 100);
    if (!trigger) continue;
    const list = groups.get(trigger) ?? [];
    list.push(item);
    groups.set(trigger, list);
  }
  const suggestions = [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = CUSTOMER_TRIGGER_ORDER.indexOf(left);
      const rightIndex = CUSTOMER_TRIGGER_ORDER.indexOf(right);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
        || left.localeCompare(right);
    })
    .map(([trigger, candidates]) => aggregateCandidateGroup({
      trigger,
      candidates,
      customer: normalizedCustomer,
      subjectKey,
      subjectVersion: positiveInteger(subjectVersion, 1),
      sourceDigest,
      subjectRefs,
      opportunityIds: normalizedOpportunityIds,
    }));
  const generatedAt = iso(now) ?? new Date().toISOString();
  const subject = {
    identity: subjectKey,
    owner: normalizedOwner,
    subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
    subjectId: normalizedCustomer.id,
    customerId: normalizedCustomer.id,
    version: positiveInteger(subjectVersion, 1),
    sourceDigest,
    sourceRefs: subjectRefs,
    suggestionCount: suggestions.length,
    updatedAt: generatedAt,
  };
  for (const suggestion of suggestions) {
    suggestion.customerSubject = {
      ...suggestion.customerSubject,
      ...subject,
    };
  }
  return {
    subject,
    suggestions,
    items: suggestions,
    sourceRefs: subjectRefs,
    sourceDigest,
    snapshot: {
      ...snapshot,
      generatedAt,
      items: suggestions,
      counts: suggestionCounts(suggestions),
      subjectTypes: [CUSTOMER_PROACTIVE_SUBJECT_TYPE],
      customerSubjectCount: 1,
      customerSubjects: [subject],
    },
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: table }));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function optionalColumn(columns, name, fallback = null) {
  return columns.has(name) ? name : fallback;
}

function mapCustomerRow(row) {
  if (!row) return null;
  return normalizeCustomer({
    id: row.id,
    owner: row.owner,
    name: row.name,
    version: row.version,
    updated_at: row.updated_at,
    budget: row.budget,
    decision_chain: parseJson(row.decision_chain, []),
  }, row.id);
}

function mapOpportunityRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    customerId: row.customer_id,
    customerName: row.customer_name ?? row.customer,
    name: row.name,
    stage: row.stage,
    amount: row.amount,
    probability: row.probability,
    days: row.days,
    next: row.next,
    version: row.version,
    customerVersion: row.customer_version,
    updatedAt: row.updated_at,
    customerUpdatedAt: row.customer_updated_at,
    budget: row.customer_budget,
    decisionChain: parseJson(row.customer_decision_chain, []),
    requirements: parseJson(row.requirements, []),
    competitors: parseJson(row.competitors, []),
    solutionDirection: parseJson(row.solution_direction, []),
    risk: row.risk,
  };
}

function mapTenderRows(db, owner, customerId) {
  if (!tableExists(db, "hospital_tender_notices")) return [];
  const columns = tableColumns(db, "hospital_tender_notices");
  const canonicalId = optionalColumn(columns, "canonical_notice_id", "identity_key");
  const canonicalRevision = optionalColumn(columns, "canonical_revision");
  const canonicalDigest = optionalColumn(columns, "canonical_digest");
  const selected = [
    "id", "identity_key", "source_id", "title", "notice_type", "published_at",
    "content_sha256", "match_customer_ids_json", canonicalId, canonicalRevision, canonicalDigest,
  ].filter((value, index, values) => value && values.indexOf(value) === index && columns.has(value));
  const rows = db.prepare(`
    SELECT ${selected.join(", ")}
      FROM hospital_tender_notices
     ORDER BY published_at DESC, id DESC
     LIMIT 200
  `).all();
  const result = [];
  for (const row of rows) {
    const customerIds = arrayValue(row.match_customer_ids_json, 100).map((value) => String(value));
    if (!customerIds.includes(customerId)) continue;
    result.push({
      id: row[canonicalId] ?? row.identity_key ?? row.id,
      identityKey: row[canonicalId] ?? row.identity_key,
      canonicalNoticeId: row[canonicalId] ?? row.identity_key,
      canonicalRevision: canonicalRevision ? row[canonicalRevision] : null,
      canonicalDigest: canonicalDigest ? row[canonicalDigest] : null,
      sourceId: row.source_id,
      title: row.title,
      noticeType: row.notice_type,
      publishedAt: row.published_at,
      contentSha256: row[canonicalDigest] ?? row.content_sha256,
      owner,
      customerId,
    });
  }
  return result;
}

function loadCustomerContext(db, owner, customerId) {
  const customer = db.prepare(`
    SELECT id, owner, version, name, budget, decision_chain, updated_at
      FROM customers
     WHERE id = $customerId AND owner = $owner AND deleted_at IS NULL
  `).get({ $customerId: customerId, $owner: owner });
  if (!customer) return null;
  const opportunities = db.prepare(`
    SELECT opportunity.id, opportunity.owner, opportunity.version, opportunity.customer_id,
           opportunity.name, opportunity.customer, opportunity.stage, opportunity.amount,
           opportunity.probability, opportunity.days, opportunity.next, opportunity.requirements,
           opportunity.competitors, opportunity.solution_direction, opportunity.risk,
           opportunity.updated_at, customer.name AS customer_name,
           customer.version AS customer_version, customer.updated_at AS customer_updated_at,
           customer.budget AS customer_budget, customer.decision_chain AS customer_decision_chain
      FROM opportunities opportunity
      JOIN customers customer ON customer.id = opportunity.customer_id
                            AND customer.owner = opportunity.owner
                            AND customer.deleted_at IS NULL
     WHERE opportunity.owner = $owner
       AND opportunity.customer_id = $customerId
       AND opportunity.deleted_at IS NULL
     ORDER BY opportunity.id ASC
     LIMIT ${MAX_CONTEXT_ITEMS}
  `).all({ $owner: owner, $customerId: customerId }).map(mapOpportunityRow).filter(Boolean);
  const opportunityIds = opportunities.map((item) => item.id);
  const inParams = Object.fromEntries(opportunityIds.map((id, index) => [`$op${index}`, id]));
  const opportunityPredicate = opportunityIds.length > 0
    ? ` OR opportunity_id IN (${opportunityIds.map((_, index) => `$op${index}`).join(", ")})`
    : "";
  const actions = db.prepare(`
    SELECT id, owner, customer_id, opportunity_id, title, status, due, priority,
           assignee, version, updated_at
      FROM action_items
     WHERE owner = $owner AND deleted_at IS NULL
       AND (customer_id = $customerId${opportunityPredicate})
     ORDER BY updated_at DESC, id ASC
     LIMIT ${MAX_CONTEXT_ITEMS}
  `).all({ $owner: owner, $customerId: customerId, ...inParams }).map((row) => ({
    ...row,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    updatedAt: row.updated_at,
  }));
  const interactions = db.prepare(`
    SELECT id, owner, customer_id, opportunity_id, occurred_at, source_channel,
           status, version, updated_at, voided_at, created_at
      FROM quick_records
     WHERE owner = $owner AND voided_at IS NULL
       AND (customer_id = $customerId${opportunityPredicate})
     ORDER BY occurred_at DESC, id ASC
     LIMIT ${MAX_CONTEXT_ITEMS}
  `).all({ $owner: owner, $customerId: customerId, ...inParams }).map((row) => ({
    ...row,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    occurredAt: row.occurred_at,
    sourceChannel: row.source_channel,
    updatedAt: row.updated_at,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  }));
  const risks = db.prepare(`
    SELECT id, owner, customer_id, opportunity_id, title, status, severity, score,
           due, version, updated_at
      FROM risk_items
     WHERE owner = $owner AND deleted_at IS NULL
       AND (customer_id = $customerId${opportunityPredicate})
     ORDER BY score DESC, updated_at DESC, id ASC
     LIMIT ${MAX_CONTEXT_ITEMS}
  `).all({ $owner: owner, $customerId: customerId, ...inParams }).map((row) => ({
    ...row,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    updatedAt: row.updated_at,
  }));
  const itineraries = db.prepare(`
    SELECT id, owner, version, title, visit_date, status, request_json, plan_json, updated_at
      FROM visit_itineraries
     WHERE owner = $owner AND deleted_at IS NULL AND status <> 'cancelled'
     ORDER BY visit_date ASC, id ASC
     LIMIT ${MAX_CONTEXT_ITEMS}
  `).all({ $owner: owner }).map((row) => {
    const request = parseJson(row.request_json, {});
    const plan = parseJson(row.plan_json, {});
    return {
      id: row.id,
      owner: row.owner,
      version: row.version,
      title: row.title,
      visitDate: row.visit_date,
      status: row.status,
      updatedAt: row.updated_at,
      customerId: request.customerId ?? request.customer_id ?? plan.customerId ?? plan.customer_id ?? null,
      opportunityId: request.opportunityId ?? request.opportunity_id ?? plan.opportunityId ?? plan.opportunity_id ?? null,
    };
  });
  return {
    customer: mapCustomerRow(customer),
    opportunities,
    actions,
    interactions,
    risks,
    itineraries,
    tenders: mapTenderRows(db, owner, customerId),
  };
}

function mapSubjectRow(row, suggestionCount = 0) {
  if (!row) return null;
  return {
    identity: row.subject_key,
    owner: row.owner,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    customerId: row.customer_id,
    version: Number(row.version),
    sourceDigest: row.source_digest,
    sourceRefs: arrayValue(row.source_refs_json, MAX_SOURCE_REFS),
    suggestionCount: Number.isSafeInteger(Number(suggestionCount)) ? Number(suggestionCount) : 0,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function validateDigest(value, name = "sourceDigest") {
  const digest = requiredText(value, name, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError(`${name} is invalid`);
  return digest;
}

function validateExpectedRevision(input) {
  const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null
    ? null
    : positiveInteger(input.expectedVersion);
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && expectedVersion === null) {
    throw new TypeError("expectedVersion is invalid");
  }
  const expectedSourceDigest = input.expectedSourceDigest === undefined || input.expectedSourceDigest === null
    ? null
    : validateDigest(input.expectedSourceDigest, "expectedSourceDigest");
  return { expectedVersion, expectedSourceDigest };
}

function revisionMatches(subject, { expectedVersion = null, expectedSourceDigest = null } = {}) {
  return Boolean(subject)
    && (expectedVersion === null || subject.version === expectedVersion)
    && (expectedSourceDigest === null || subject.sourceDigest === expectedSourceDigest);
}

function decorateSuggestion(suggestion, subject) {
  // `suggestionCount` is derived from the rows being saved for this revision.
  // Persisting it inside each suggestion creates a self-referential payload:
  // the first scan stores zero, while the next unchanged scan observes the
  // completed count and incorrectly advances every suggestion revision.
  const embeddedSubject = { ...subject };
  delete embeddedSubject.suggestionCount;
  const next = {
    ...suggestion,
    subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
    subjectId: subject.subjectId,
    subjectKey: subject.identity,
    customerSubjectKey: subject.identity,
    subjectVersion: subject.version,
    customerSubjectVersion: subject.version,
    sourceDigest: subject.sourceDigest,
    subjectSourceDigest: subject.sourceDigest,
    sourceRefs: subject.sourceRefs,
    subjectSourceRefs: subject.sourceRefs,
    evidenceRefs: subject.sourceRefs,
    customerSubject: embeddedSubject,
  };
  const rewritePreview = (preview) => {
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
    return {
      ...preview,
      subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
      subjectId: subject.subjectId,
      subjectKey: subject.identity,
      subjectVersion: subject.version,
      expectedSubjectVersion: subject.version,
      sourceDigest: subject.sourceDigest,
      expectedSourceDigest: subject.sourceDigest,
      customerId: subject.customerId,
    };
  };
  const writebackPreview = next.writebackPreview && typeof next.writebackPreview === "object"
    ? {
        ...next.writebackPreview,
        action: rewritePreview(next.writebackPreview.action),
        risk: rewritePreview(next.writebackPreview.risk),
      }
    : next.writebackPreview;
  const result = { ...next, writebackPreview };
  const actionDigest = writebackPreview?.action ? proactivePreviewDigest(result, "action") : null;
  const riskDigest = writebackPreview?.risk ? proactivePreviewDigest(result, "risk") : null;
  result.previewDigests = {
    ...(actionDigest ? { action: actionDigest } : {}),
    ...(riskDigest ? { risk: riskDigest } : {}),
  };
  result.previewDigest = riskDigest ?? actionDigest ?? null;
  if (result.previewDigest && writebackPreview) result.writebackPreview = { ...writebackPreview, previewDigest: result.previewDigest };
  return result;
}

/**
 * Durable owner-scoped customer subject ledger and aggregation service.
 * `suggestionCount` is derived from the current subject revision's rows in
 * `ai_suggestions`; migration 0042 intentionally keeps the subject table
 * additive and does not add a duplicate counter column.
 */
export function createCustomerProactiveSubjectService({
  db,
  clock = () => new Date(),
  idFactory = randomUUID,
  suggestionRepository = null,
  snapshotBuilder = buildProactiveAssistantSnapshot,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!tableExists(db, "proactive_subjects")) {
    throw new TypeError("proactive_subjects table is missing; apply migration 0042 first");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory is required");
  if (typeof snapshotBuilder !== "function") throw new TypeError("snapshotBuilder must be a function");
  const suggestions = suggestionRepository ?? createProactiveSuggestionRepository(db, { clock, idFactory });
  if (!suggestions || typeof suggestions.save !== "function") throw new TypeError("suggestionRepository is invalid");
  const suggestionColumns = tableColumns(db, "ai_suggestions");
  for (const required of ["proactive_subject_key", "proactive_subject_version", "proactive_source_digest", "proactive_source_refs"]) {
    if (!suggestionColumns.has(required)) throw new TypeError(`ai_suggestions.${required} is missing; apply migration 0042 first`);
  }

  function now() {
    return clockDate(clock).toISOString();
  }

  function countSuggestions(identity, version, owner) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
        FROM ai_suggestions
       WHERE owner = $owner
         AND proactive_subject_key = $identity
         AND proactive_subject_version = $version
         AND proactive_trigger IS NOT NULL
    `).get({ $owner: owner, $identity: identity, $version: version }).count);
  }

  function selectSubject(owner, customerId) {
    return db.prepare(`
      SELECT * FROM proactive_subjects
       WHERE owner = $owner
         AND subject_type = 'customer'
         AND subject_id = $customerId
       LIMIT 1
    `).get({ $owner: owner, $customerId: customerId });
  }

  function subjectFromRow(row) {
    if (!row) return null;
    return mapSubjectRow(row, countSuggestions(row.subject_key, Number(row.version), row.owner));
  }

  function getSubject({ owner, customerId } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const normalizedCustomerId = identifier(customerId, "customerId", 200);
    return subjectFromRow(selectSubject(normalizedOwner, normalizedCustomerId));
  }

  function listSubjects({ owner, customerId = null, limit = 100, offset = 0 } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit is invalid");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new TypeError("offset is invalid");
    const normalizedCustomerId = customerId === null || customerId === undefined || customerId === ""
      ? null
      : identifier(customerId, "customerId", 200);
    const rows = db.prepare(`
      SELECT * FROM proactive_subjects
       WHERE owner = $owner
         AND subject_type = 'customer'
         AND ($customerId IS NULL OR customer_id = $customerId)
       ORDER BY updated_at DESC, subject_id ASC
       LIMIT $limit OFFSET $offset
    `).all({
      $owner: normalizedOwner,
      $customerId: normalizedCustomerId,
      $limit: limit,
      $offset: offset,
    });
    return rows.map(subjectFromRow);
  }

  function upsertSubjectRow({ owner, customer, sourceDigest, sourceRefs, at }) {
    const existing = selectSubject(owner, customer.id);
    const refsJson = JSON.stringify(sourceRefs.slice(0, MAX_SOURCE_REFS));
    if (!existing) {
      const id = identifier(idFactory(), "subject id", 500);
      db.prepare(`
        INSERT INTO proactive_subjects (
          id, owner, subject_type, subject_id, subject_key, customer_id,
          version, source_digest, source_refs_json, created_at, updated_at
        ) VALUES (
          $id, $owner, 'customer', $subjectId, $subjectKey, $customerId,
          1, $sourceDigest, $sourceRefs, $now, $now
        )
      `).run({
        $id: id,
        $owner: owner,
        $subjectId: customer.id,
        $subjectKey: customerSubjectKey(owner, customer.id),
        $customerId: customer.id,
        $sourceDigest: sourceDigest,
        $sourceRefs: refsJson,
        $now: at,
      });
      return subjectFromRow(selectSubject(owner, customer.id));
    }
    const sameDigest = existing.source_digest === sourceDigest;
    const nextVersion = Number(existing.version) + (sameDigest ? 0 : 1);
    const existingRefs = existing.source_refs_json ?? "[]";
    const refsChanged = existingRefs !== refsJson;
    db.prepare(`
      UPDATE proactive_subjects
         SET subject_key = $subjectKey,
             version = $version,
             source_digest = $sourceDigest,
             source_refs_json = $sourceRefs,
             updated_at = CASE WHEN $changed = 1 THEN $now ELSE updated_at END
       WHERE owner = $owner AND subject_type = 'customer' AND subject_id = $subjectId
    `).run({
      $subjectKey: customerSubjectKey(owner, customer.id),
      $version: nextVersion,
      $sourceDigest: sourceDigest,
      $sourceRefs: refsJson,
      $changed: sameDigest ? (refsChanged ? 1 : 0) : 1,
      $now: at,
      $owner: owner,
      $subjectId: customer.id,
    });
    return subjectFromRow(selectSubject(owner, customer.id));
  }

  function assertExpected(subject, input = {}) {
    const expected = validateExpectedRevision(input);
    if (expected.expectedVersion === null && expected.expectedSourceDigest === null) return subject;
    if (revisionMatches(subject, expected)) return subject;
    throw new HttpError(409, "PROACTIVE_SUBJECT_STALE", "The customer proactive subject has changed", {
      identity: subject?.identity ?? null,
      expectedVersion: expected.expectedVersion,
      expectedSourceDigest: expected.expectedSourceDigest,
      currentVersion: subject?.version ?? null,
      currentSourceDigest: subject?.sourceDigest ?? null,
      subject: subject ?? null,
    });
  }

  function reconcileRows({ owner, identity, version, activeTriggers, at }) {
    const triggers = [...new Set(activeTriggers)].filter((value) => /^[\u4e00-\u9fffA-Za-z0-9_.:-]{1,100}$/u.test(value));
    const triggerPredicate = triggers.length > 0
      ? `AND proactive_trigger NOT IN (${triggers.map((_, index) => `$trigger${index}`).join(", ")})`
      : "";
    const params = {
      $owner: owner,
      $identity: identity,
      $version: version,
      $now: at,
      ...Object.fromEntries(triggers.map((value, index) => [`$trigger${index}`, value])),
    };
    db.prepare(`
      UPDATE ai_suggestions
         SET proactive_status = 'expired',
             proactive_stale_at = NULL,
             version = version + 1,
             updated_at = $now
       WHERE owner = $owner
         AND proactive_subject_key = $identity
         AND proactive_trigger IS NOT NULL
         AND (proactive_subject_version IS NULL OR proactive_subject_version <> $version)
         ${triggerPredicate}
         AND proactive_status IN ('pending', 'deferred', 'snoozed')
    `).run(params);
  }

  function saveSuggestionWithinTransaction(input) {
    if (typeof suggestions.saveWithinTransaction === "function") return suggestions.saveWithinTransaction(input);
    return suggestions.save(input);
  }

  function sync(input = {}) {
    const owner = identifier(input.owner, "owner", 200);
    const customerId = identifier(input.customerId ?? input.customer?.id, "customerId", 200);
    const customer = normalizeCustomer(input.customer, customerId);
    if (customer.id !== customerId) throw new TypeError("customerId is invalid");
    if (customer.owner && customer.owner !== owner) {
      throw new HttpError(404, "PROACTIVE_CUSTOMER_NOT_FOUND", "The customer is not available for this owner");
    }
    const built = buildCustomerProactiveSubject({
      ...input,
      owner,
      customer,
      customerId,
      snapshotBuilder,
    });
    const at = now();
    return withImmediateTransaction(db, () => {
      const currentRow = selectSubject(owner, customerId);
      const current = currentRow ? subjectFromRow(currentRow) : null;
      assertExpected(current, input);
      const subject = upsertSubjectRow({
        owner,
        customer,
        sourceDigest: built.sourceDigest,
        sourceRefs: built.sourceRefs,
        at,
      });
      const savedSuggestions = [];
      let insertedCount = 0;
      let dedupedCount = 0;
      for (const item of built.suggestions) {
        const decorated = decorateSuggestion(item, subject);
        const saved = saveSuggestionWithinTransaction({
          owner,
          suggestion: decorated,
          id: decorated.id,
          trigger: decorated.trigger?.type,
          subjectType: CUSTOMER_PROACTIVE_SUBJECT_TYPE,
          subjectId: subject.subjectId,
          subjectKey: subject.identity,
          subjectVersion: subject.version,
          sourceDigest: subject.sourceDigest,
          sourceRefs: subject.sourceRefs,
          customerId: subject.customerId,
          opportunityId: decorated.opportunityId,
          dedupeKey: customerSuggestionDedupeKey(subject.identity, decorated.trigger?.type ?? "custom"),
          priority: decorated.priority ?? 0,
          source: decorated.source,
          fallbackReason: decorated.fallbackReason,
          generatedAt: decorated.trigger?.detectedAt ?? at,
          ruleVersion: decorated.modelVersion ?? decorated.schemaVersion,
        });
        if (saved?.replayed) dedupedCount += 1;
        else insertedCount += 1;
        savedSuggestions.push(saved?.item ?? saved);
      }
      reconcileRows({
        owner,
        identity: subject.identity,
        version: subject.version,
        activeTriggers: built.suggestions.map((item) => item.trigger?.type).filter(Boolean),
        at,
      });
      const finalSubject = {
        ...subject,
        suggestionCount: countSuggestions(subject.identity, subject.version, owner),
      };
      const finalSuggestions = savedSuggestions.map((item) => item && item.customerSubject
        ? { ...item, customerSubject: finalSubject }
        : item);
      return {
        subject: finalSubject,
        suggestions: finalSuggestions,
        items: finalSuggestions,
        sourceDigest: subject.sourceDigest,
        sourceRefs: subject.sourceRefs,
        revision: subject.version,
        status: "success",
        insertedCount,
        dedupedCount,
        suggestionCount: finalSubject.suggestionCount,
        snapshot: {
          ...built.snapshot,
          items: finalSuggestions,
          customerSubjects: [finalSubject],
          customerSubjectCount: 1,
          subjectTypes: [CUSTOMER_PROACTIVE_SUBJECT_TYPE],
        },
      };
    });
  }

  function syncCustomer(input = {}) {
    const owner = identifier(input.owner, "owner", 200);
    const customerId = identifier(input.customerId, "customerId", 200);
    const context = loadCustomerContext(db, owner, customerId);
    if (!context) throw new HttpError(404, "PROACTIVE_CUSTOMER_NOT_FOUND", "The customer is not available for this owner");
    return sync({
      ...input,
      owner,
      customerId,
      customer: input.customer ?? context.customer,
      opportunities: Object.hasOwn(input, "opportunities") ? input.opportunities : context.opportunities,
      actions: Object.hasOwn(input, "actions") ? input.actions : context.actions,
      interactions: Object.hasOwn(input, "interactions") ? input.interactions : context.interactions,
      risks: Object.hasOwn(input, "risks") ? input.risks : context.risks,
      itineraries: Object.hasOwn(input, "itineraries") ? input.itineraries : context.itineraries,
      tenders: Object.hasOwn(input, "tenders") ? input.tenders : context.tenders,
    });
  }

  function previewContext({ owner, customerId, suggestion = null } = {}) {
    const subject = getSubject({ owner, customerId });
    if (!subject) return null;
    return {
      identity: subject.identity,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      customerId: subject.customerId,
      subjectVersion: subject.version,
      expectedSubjectVersion: subject.version,
      sourceDigest: subject.sourceDigest,
      expectedSourceDigest: subject.sourceDigest,
      sourceRefs: subject.sourceRefs,
      customerSubject: subject,
      suggestionId: suggestion?.id ?? null,
    };
  }

  function assertCurrentRevision(input = {}) {
    const subject = getSubject({ owner: input.owner, customerId: input.customerId });
    if (!subject) throw new HttpError(404, "PROACTIVE_SUBJECT_NOT_FOUND", "The customer proactive subject was not found");
    return assertExpected(subject, input);
  }

  return Object.freeze({
    build: (input = {}) => buildCustomerProactiveSubject({ ...input, snapshotBuilder }),
    aggregate: (input = {}) => buildCustomerProactiveSubject({ ...input, snapshotBuilder }),
    buildSubject: (input = {}) => buildCustomerProactiveSubject({ ...input, snapshotBuilder }),
    sync,
    syncCustomer,
    syncCustomerSubject: syncCustomer,
    get: getSubject,
    getSubject,
    list: listSubjects,
    listSubjects,
    previewContext,
    assertCurrentRevision,
    assertFresh: assertCurrentRevision,
    validateRevision: (input = {}) => {
      const subject = getSubject({ owner: input.owner, customerId: input.customerId });
      const expected = validateExpectedRevision(input);
      return { valid: revisionMatches(subject, expected), subject };
    },
    sourceDigest: customerSubjectSourceDigest,
    subjectKey: customerSubjectKey,
    suggestionRepository: suggestions,
  });
}

export const createCustomerProactiveSubjectRepository = createCustomerProactiveSubjectService;
export const createCustomerProactiveAssistantService = createCustomerProactiveSubjectService;
export { canonicalSourceRefs };
