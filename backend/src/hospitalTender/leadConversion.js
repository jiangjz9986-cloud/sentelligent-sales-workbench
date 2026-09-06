import { createHash, timingSafeEqual } from "node:crypto";

import { createActionItemStore } from "../actionItems/actionItemStore.js";
import { insertAudit } from "../audit/auditRepository.js";
import { getActiveCustomer } from "../customers/customerStore.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { createOpportunity, getActiveOpportunity } from "../opportunities/opportunityStore.js";
import { stableDigest } from "./canonicalBridge.js";
import { matchNoticeToCustomers } from "./matching.js";
import { customerSnapshotFromRow } from "./sync.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONVERSION_IDENTITY_VERSION = 1;
const LEGACY_CONVERSION_SCHEMA_VERSION = 1;
const CONVERSION_RECEIPT_SCHEMA_VERSION = 2;
const DEFAULT_NEXT_STEP = "核验公告范围、预算、截止时间和客户采购计划";
const CONFIRM_AUDIT_ACTION = "hospital_tender.lead_conversion.confirm";
const CONFIRM_AUDIT_ENTITY_TYPE = "hospital_tender_notice";
const BRIDGE_CONFIRM_CONFLICT_CODES = new Set([
  "CONVERSION_STATE_CONFLICT",
  "BRIDGE_PREVIEW_STALE",
  "BRIDGE_STATE_CONFLICT",
  "BRIDGE_NOTICE_STALE",
]);
const MODERN_RECEIPT_KEYS = new Set([
  "canonicalNoticeId",
  "canonicalRevision",
  "canonicalDigest",
  "customerVersion",
  "customerSnapshotDigest",
  "matchSnapshotDigest",
  "opportunitySnapshotDigest",
]);

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} contains control characters`);
  }
  return normalized;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function truncate(value, max) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) continue;
    const normalized = item.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function planDigest(plan) {
  return sha256(JSON.stringify(canonicalize(plan)));
}

function noticeSnapshotDigest(notice) {
  // Bind the human preview to the complete normalized persisted notice, not
  // only to fields that happen to be projected into the opportunity/todo.
  // The upstream contentSha256 is deliberately ignored: the service hashes
  // the actual persisted contentText so a stale or forged upstream digest
  // cannot keep an old confirmation valid.
  const snapshot = {
    id: notice.id,
    identityKey: notice.identityKey,
    sourceId: notice.sourceId,
    sourceName: notice.sourceName,
    city: notice.city ?? null,
    title: notice.title,
    url: notice.url,
    publishedAt: notice.publishedAt,
    noticeType: notice.noticeType,
    purchaser: notice.purchaser ?? null,
    projectCode: notice.projectCode ?? null,
    budgetText: notice.budgetText ?? null,
    deadlineText: notice.deadlineText ?? null,
    contentSha256: sha256(notice.contentText ?? ""),
    hospitalNames: stringList(notice.hospitalNames),
    sourceItemId: notice.sourceItemId ?? null,
    relevance: notice.relevance,
  };
  return sha256(JSON.stringify(canonicalize(snapshot)));
}

function matchSnapshotDigest(customerId, match) {
  return stableDigest({
    customerId,
    score: Number(match?.score ?? 0),
    reasons: stringList(match?.reasons),
    needs: stringList(match?.needs),
  });
}

function customerSnapshotDigest(customer) {
  return stableDigest({
    id: customer.id,
    version: Number(customer.version ?? 1),
    name: customer.name ?? null,
    region: customer.region ?? null,
    type: customer.type ?? null,
    level: customer.level ?? null,
    relation: Number(customer.relation ?? 0),
    stakeholders: Array.isArray(customer.stakeholders) ? customer.stakeholders : [],
    decisionChain: Array.isArray(customer.decisionChain) ? customer.decisionChain : [],
    historyProjects: Array.isArray(customer.historyProjects) ? customer.historyProjects : [],
    infrastructure: Array.isArray(customer.infrastructure) ? customer.infrastructure : [],
    syncPreview: Array.isArray(customer.syncPreview) ? customer.syncPreview : [],
    budget: customer.budget ?? null,
    summary: customer.summary ?? null,
    needs: Array.isArray(customer.needs) ? customer.needs : [],
    risks: Array.isArray(customer.risks) ? customer.risks : [],
    opportunities: Array.isArray(customer.opportunities) ? customer.opportunities : [],
    aliases: Array.isArray(customer.aliases) ? customer.aliases : [],
    tags: Array.isArray(customer.tags) ? customer.tags : [],
  });
}

function opportunitySnapshotDigest(opportunity) {
  return stableDigest(opportunity);
}

function digestEquals(presented, expected) {
  if (typeof presented !== "string" || !DIGEST_PATTERN.test(presented)) return false;
  return timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(expected, "hex"));
}

function notFound() {
  throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
}

function stalePreview() {
  throw new HttpError(
    409,
    "PREVIEW_STALE",
    "The preview changed; review the latest proposal before confirming",
  );
}

function conversionConflict() {
  throw new HttpError(
    409,
    "CONVERSION_STATE_CONFLICT",
    "The tender notice conversion conflicts with an existing result",
  );
}

function matchEvidenceStale() {
  throw new HttpError(
    409,
    "MATCH_EVIDENCE_STALE",
    "The persisted tender match evidence no longer agrees with the current customer",
  );
}

function sameStringSet(left, right) {
  const leftValues = stringList(left);
  const rightValues = stringList(right);
  return leftValues.length === rightValues.length
    && leftValues.every((item) => rightValues.includes(item));
}

function conversionIdentity(owner, canonicalNoticeId, customerId) {
  return sha256(JSON.stringify([
    "hospital_tender_lead_conversion",
    CONVERSION_IDENTITY_VERSION,
    owner,
    canonicalNoticeId,
    customerId,
  ]));
}

function legacyConversionIdentity(owner, identityKey, customerId) {
  return sha256(JSON.stringify([
    "hospital_tender_lead_conversion",
    LEGACY_CONVERSION_SCHEMA_VERSION,
    owner,
    identityKey,
    customerId,
  ]));
}

function deterministicIds(identity) {
  return {
    opportunityId: `tender-opportunity-${sha256(`${identity}:opportunity`).slice(0, 32)}`,
    actionItemId: `tender-action-${sha256(`${identity}:action_item`).slice(0, 32)}`,
  };
}

function tenderSourceRecord(notice) {
  const direct = `hospital_tender:${notice.id}`;
  return direct.length <= 200
    ? direct
    : `hospital_tender_sha256:${sha256(notice.id)}`;
}

function draftOpportunity({ owner, notice, customer, reasons, needs, matchScore, opportunityId }) {
  const reasonEvidence = reasons.length > 0 ? reasons.join("；") : "公告与客户匹配";
  return {
    id: opportunityId,
    customerId: customer.id,
    customer: truncate(customer.name, 200),
    name: truncate(`招标线索：${notice.title}`, 200),
    stage: "线索",
    amount: truncate(notice.budgetText, 100),
    owner,
    probability: matchScore,
    days: 0,
    requirements: [
      ...needs,
      `匹配依据：${reasonEvidence}`,
      `公告编号：${notice.id}`,
      `公告原文：${notice.url}`,
    ],
    competitors: [],
    solutionDirection: [],
    sourceRecord: tenderSourceRecord(notice),
    risk: null,
    next: DEFAULT_NEXT_STEP,
    tone: notice.relevance === "high" ? "red" : "blue",
  };
}

function draftActionItem({ owner, notice, customer, reasons, matchScore, actionItemId, opportunityId }) {
  const reasonEvidence = reasons.length > 0 ? reasons.join("；") : "公告与客户匹配";
  return {
    id: actionItemId,
    owner,
    customerId: customer.id,
    opportunityId,
    customerName: truncate(customer.name, 200),
    title: truncate(`跟进招标：${notice.title}`, 80),
    reason: truncate(`来源公告 ${notice.id}；${reasonEvidence}；${notice.url}`, 500),
    due: truncate(notice.deadlineText, 50),
    priority: matchScore >= 80 ? "高" : "中",
  };
}

function publicNotice(notice) {
  return {
    id: notice.id,
    identityKey: notice.identityKey,
    sourceId: notice.sourceId,
    sourceName: notice.sourceName,
    url: notice.url,
    title: notice.title,
    publishedAt: notice.publishedAt,
    projectCode: notice.projectCode ?? null,
    canonicalNoticeId: notice.canonicalNoticeId ?? notice.identityKey,
    canonicalRevision: Number(notice.canonicalRevision ?? notice.revision ?? 1),
    canonicalDigest: notice.canonicalDigest ?? null,
  };
}

function legacyPublicNotice(notice) {
  return {
    id: notice.id,
    identityKey: notice.identityKey,
    sourceId: notice.sourceId,
    sourceName: notice.sourceName,
    url: notice.url,
    title: notice.title,
    publishedAt: notice.publishedAt,
    projectCode: notice.projectCode ?? null,
  };
}

function publicCustomer(customer) {
  return {
    id: customer.id,
    version: customer.version,
    name: customer.name,
  };
}

function resultFromPlan(plan, digest, bridge = null) {
  return {
    status: "preview",
    requiresHumanConfirmation: true,
    notice: plan.notice,
    customer: plan.customer,
    conversionIdentity: plan.conversionIdentity,
    noticeSnapshotDigest: plan.noticeSnapshotDigest,
    canonicalNoticeId: plan.canonicalNoticeId,
    canonicalRevision: plan.canonicalRevision,
    canonicalDigest: plan.canonicalDigest,
    match: plan.match,
    matchSnapshotDigest: plan.matchSnapshotDigest,
    customerSnapshotDigest: plan.customerSnapshotDigest,
    customerVersion: plan.customer.version,
    opportunitySnapshotDigest: plan.opportunitySnapshotDigest,
    drafts: plan.drafts,
    diff: {
      opportunity: { before: null, after: plan.drafts.opportunity },
      actionItem: { before: null, after: plan.drafts.actionItem },
    },
    previewDigest: digest,
    bridge: bridge ?? null,
  };
}

function currentCustomerMatch(notice, customer) {
  const persistedReasons = stringList(notice.match?.matchReasons?.[customer.id]);
  const persistedNeeds = stringList(notice.match?.matchedNeeds?.[customer.id]);
  const recomputed = matchNoticeToCustomers(notice, [customerSnapshotFromRow(customer)]);
  if (!stringList(recomputed.matchedCustomerIds).includes(customer.id)) matchEvidenceStale();

  const reasons = stringList(recomputed.matchReasons?.[customer.id]);
  const needs = stringList(recomputed.matchedNeeds?.[customer.id]);
  if (!sameStringSet(persistedReasons, reasons) || !sameStringSet(persistedNeeds, needs)) {
    matchEvidenceStale();
  }
  return {
    score: Number(recomputed.matchScore),
    reasons,
    needs,
  };
}

function parseAuditObject(value) {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function confirmationReceipt(plan, digest) {
  const common = {
    previewDigest: digest,
    conversionIdentity: plan.conversionIdentity,
    noticeSnapshotDigest: plan.noticeSnapshotDigest,
    noticeIdentityKey: plan.notice.identityKey,
    canonicalNoticeId: plan.canonicalNoticeId,
    canonicalRevision: plan.canonicalRevision,
    canonicalDigest: plan.canonicalDigest,
    owner: plan.owner,
    customerId: plan.customer.id,
    customerVersion: plan.customer.version,
    customerSnapshotDigest: plan.customerSnapshotDigest,
    matchSnapshotDigest: plan.matchSnapshotDigest,
    opportunitySnapshotDigest: plan.opportunitySnapshotDigest,
    opportunityId: plan.drafts.opportunity.id,
    actionItemId: plan.drafts.actionItem.id,
    matchScore: plan.match.score,
  };
  return {
    after: {
      schemaVersion: plan.schemaVersion,
      ...common,
      noticeId: plan.notice.id,
    },
    metadata: common,
  };
}

function receiptPayloadMatches(actual, expected) {
  if (actual === null) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

function legacyReceiptExpectation(plan) {
  const identity = legacyConversionIdentity(
    plan.owner,
    plan.notice.identityKey,
    plan.customer.id,
  );
  const ids = deterministicIds(identity);
  const opportunity = { ...plan.drafts.opportunity, id: ids.opportunityId };
  const actionItem = {
    ...plan.drafts.actionItem,
    id: ids.actionItemId,
    opportunityId: ids.opportunityId,
  };
  const legacyPlan = {
    schemaVersion: LEGACY_CONVERSION_SCHEMA_VERSION,
    conversionIdentity: identity,
    noticeSnapshotDigest: plan.noticeSnapshotDigest,
    owner: plan.owner,
    notice: legacyPublicNotice(plan.notice),
    customer: plan.customer,
    match: plan.match,
    drafts: { opportunity, actionItem },
  };
  const digest = planDigest(legacyPlan);
  const common = {
    previewDigest: digest,
    conversionIdentity: legacyPlan.conversionIdentity,
    noticeSnapshotDigest: legacyPlan.noticeSnapshotDigest,
    noticeIdentityKey: legacyPlan.notice.identityKey,
    owner: legacyPlan.owner,
    customerId: legacyPlan.customer.id,
    opportunityId: legacyPlan.drafts.opportunity.id,
    actionItemId: legacyPlan.drafts.actionItem.id,
    matchScore: legacyPlan.match.score,
  };
  return {
    after: {
      schemaVersion: LEGACY_CONVERSION_SCHEMA_VERSION,
      ...common,
      noticeId: legacyPlan.notice.id,
    },
    metadata: common,
    opportunityId: ids.opportunityId,
    actionItemId: ids.actionItemId,
  };
}

function receiptLooksModern(receipt) {
  if (receipt.after && Object.hasOwn(receipt.after, "schemaVersion")
    && receipt.after.schemaVersion !== LEGACY_CONVERSION_SCHEMA_VERSION) {
    return true;
  }
  return [receipt.after, receipt.metadata]
    .filter(Boolean)
    .some((payload) => Object.keys(payload).some((key) => MODERN_RECEIPT_KEYS.has(key)));
}

function receiptReferencesConversion(receipt, expected, legacyExpected) {
  const payloads = [receipt.after, receipt.metadata].filter(Boolean);
  const identities = new Set([
    expected.after.conversionIdentity,
    legacyExpected?.after?.conversionIdentity,
  ].filter(Boolean));
  const idPairs = [
    [expected.after.opportunityId, expected.after.actionItemId],
    [legacyExpected?.opportunityId, legacyExpected?.actionItemId],
  ].filter(([opportunityId, actionItemId]) => opportunityId && actionItemId);
  return payloads.some((payload) => identities.has(payload.conversionIdentity)
    || idPairs.some(([opportunityId, actionItemId]) => (
      payload.opportunityId === opportunityId && payload.actionItemId === actionItemId
    )));
}

function readConfirmationReceipt(db, plan, digest) {
  const expected = confirmationReceipt(plan, digest);
  const legacyExpected = legacyReceiptExpectation(plan);
  const rows = db.prepare(`
    SELECT action, entity_type, entity_id, actor, after_json, metadata_json
    FROM audit_logs
    WHERE action = $action
      AND entity_type = $entityType
      AND entity_id = $entityId
      AND actor = $actor
    ORDER BY created_at ASC, id ASC
  `).all({
    $action: CONFIRM_AUDIT_ACTION,
    $entityType: CONFIRM_AUDIT_ENTITY_TYPE,
    $entityId: plan.notice.id,
    $actor: plan.owner,
  }).map((row) => ({
    ...row,
    after: parseAuditObject(row.after_json),
    metadata: parseAuditObject(row.metadata_json),
  }));
  const candidates = rows.filter((row) => receiptReferencesConversion(row, expected, legacyExpected));
  const exactReceiptKind = candidates.length === 1
    ? (() => {
      const [row] = candidates;
      if (row.action !== CONFIRM_AUDIT_ACTION
        || row.entity_type !== CONFIRM_AUDIT_ENTITY_TYPE
        || row.entity_id !== plan.notice.id
        || row.actor !== plan.owner) return null;
      if (receiptPayloadMatches(row.after, expected.after)
        && receiptPayloadMatches(row.metadata, expected.metadata)) return "modern";
      if (!receiptLooksModern(row)
        && legacyExpected
        && receiptPayloadMatches(row.after, legacyExpected.after)
        && receiptPayloadMatches(row.metadata, legacyExpected.metadata)) return "legacy";
      return null;
    })()
    : null;
  return {
    present: candidates.length > 0,
    valid: exactReceiptKind !== null,
    kind: exactReceiptKind,
    legacyIds: exactReceiptKind === "legacy"
      ? {
        opportunityId: legacyExpected.opportunityId,
        actionItemId: legacyExpected.actionItemId,
      }
      : null,
  };
}

/**
 * Build the read/preview/confirm boundary for turning one matched tender notice
 * into one owner-scoped opportunity and one linked action item. The service is
 * deliberately not wired to HTTP here: a caller must first display preview(),
 * then send the exact digest back with confirmed=true.
 */
export function createHospitalTenderLeadConversionService({
  db,
  tenderRepository,
  clock = () => new Date(),
  failpoint = () => {},
} = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (!tenderRepository || typeof tenderRepository.getNotice !== "function") {
    throw new TypeError("A hospital tender repository is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof failpoint !== "function") throw new TypeError("failpoint must be a function");

  const actionItemStore = createActionItemStore(db, { clock });

  function bridgeInput(
    plan,
    digest,
    input = {},
    { includeResultIds = false, resultIds = null } = {},
  ) {
    const value = {
      owner: plan.owner,
      noticeId: plan.notice.id,
      customerId: plan.customer.id,
      noticeRevision: plan.canonicalRevision,
      noticeDigest: plan.canonicalDigest,
      previewDigest: digest,
      matchSnapshotDigest: plan.matchSnapshotDigest,
      customerSnapshotDigest: plan.customerSnapshotDigest,
      customerVersion: plan.customer.version,
      opportunitySnapshotDigest: plan.opportunitySnapshotDigest,
    };
    if (includeResultIds) {
      value.opportunityId = resultIds?.opportunityId ?? plan.drafts.opportunity.id;
      value.actionItemId = resultIds?.actionItemId ?? plan.drafts.actionItem.id;
    }
    if (input.requestId !== undefined) value.requestId = input.requestId;
    return value;
  }

  function markBridgeConflict(plan) {
    if (typeof tenderRepository.markBridgeConflict !== "function") return null;
    return tenderRepository.markBridgeConflict({
      owner: plan.owner,
      canonicalNoticeId: plan.canonicalNoticeId,
      customerId: plan.customer.id,
    });
  }

  function bridgePreview(plan, digest) {
    if (typeof tenderRepository.recordBridgePreview !== "function") return null;
    return withImmediateTransaction(db, () => tenderRepository.recordBridgePreview({
      ...bridgeInput(plan, digest),
      // A changed canonical revision may still be shown as a read-only
      // proposal after a prior confirmed conversion.  The immutable bridge
      // row remains conflict-marked and confirm() will reject it.
      allowConflictPreview: true,
    }));
  }

  function assertPresentedSnapshot(plan, input) {
    const presentedCanonicalId = input.canonicalNoticeId;
    if (presentedCanonicalId !== undefined
      && String(presentedCanonicalId) !== plan.canonicalNoticeId) stalePreview();

    if (input.noticeRevision !== undefined
      && Number(input.noticeRevision) !== plan.canonicalRevision) stalePreview();

    for (const [field, expected] of [
      ["noticeDigest", plan.canonicalDigest],
      ["matchSnapshotDigest", plan.matchSnapshotDigest],
      ["customerSnapshotDigest", plan.customerSnapshotDigest],
      ["opportunitySnapshotDigest", plan.opportunitySnapshotDigest],
    ]) {
      if (input[field] !== undefined && !digestEquals(input[field], expected)) stalePreview();
    }

    if (input.customerVersion !== undefined
      && Number(input.customerVersion) !== plan.customer.version) stalePreview();
  }

  function buildPlan(input = {}) {
    const owner = requiredText(input.owner, "owner", 200);
    const noticeId = requiredText(input.noticeId, "noticeId", 200);
    const customerId = requiredText(input.customerId, "customerId", 200);
    const notice = tenderRepository.getNotice(noticeId, { owner });
    if (!notice) notFound();
    const canonicalNoticeId = notice.canonicalNoticeId ?? notice.identityKey;
    const canonicalRevision = Number(notice.canonicalRevision ?? notice.revision ?? 1);
    const canonicalDigest = notice.canonicalDigest
      ?? stableDigest({
        canonicalNoticeId,
        id: notice.id,
        title: notice.title,
        contentText: notice.contentText ?? null,
      });
    if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 1 || !DIGEST_PATTERN.test(canonicalDigest)) {
      throw new HttpError(409, "BRIDGE_NOTICE_STALE", "The canonical tender notice is not repairable");
    }
    const customer = getActiveCustomer(db, customerId, { owner });
    if (!customer) notFound();

    const matchedCustomerIds = stringList(notice.match?.matchedCustomerIds);
    if (!matchedCustomerIds.includes(customer.id)) notFound();

    const match = currentCustomerMatch(notice, customer);
    const identity = conversionIdentity(owner, canonicalNoticeId, customer.id);
    const { opportunityId, actionItemId } = deterministicIds(identity);
    const opportunity = draftOpportunity({
      owner,
      notice,
      customer,
      reasons: match.reasons,
      needs: match.needs,
      matchScore: match.score,
      opportunityId,
    });
    const actionItem = draftActionItem({
      owner,
      notice,
      customer,
      reasons: match.reasons,
      matchScore: match.score,
      actionItemId,
      opportunityId,
    });

    return {
      schemaVersion: CONVERSION_RECEIPT_SCHEMA_VERSION,
      conversionIdentity: identity,
      noticeSnapshotDigest: noticeSnapshotDigest(notice),
      canonicalNoticeId,
      canonicalRevision,
      canonicalDigest,
      owner,
      notice: publicNotice({ ...notice, canonicalNoticeId, canonicalRevision, canonicalDigest }),
      customer: publicCustomer(customer),
      match,
      matchSnapshotDigest: matchSnapshotDigest(customer.id, match),
      customerSnapshotDigest: customerSnapshotDigest(customer),
      opportunitySnapshotDigest: opportunitySnapshotDigest(opportunity),
      drafts: { opportunity, actionItem },
    };
  }

  function preview(input = {}) {
    const plan = buildPlan(input);
    assertPresentedSnapshot(plan, input);
    const digest = planDigest(plan);
    const bridge = bridgePreview(plan, digest);
    return resultFromPlan(plan, digest, bridge);
  }

  function cancellationResult(plan, digest, bridge) {
    return {
      status: "cancelled",
      requiresHumanConfirmation: false,
      noticeId: plan.notice.id,
      customerId: plan.customer.id,
      conversionIdentity: plan.conversionIdentity,
      noticeSnapshotDigest: plan.noticeSnapshotDigest,
      canonicalNoticeId: plan.canonicalNoticeId,
      canonicalRevision: plan.canonicalRevision,
      canonicalDigest: plan.canonicalDigest,
      matchSnapshotDigest: plan.matchSnapshotDigest,
      customerSnapshotDigest: plan.customerSnapshotDigest,
      customerVersion: plan.customer.version,
      opportunitySnapshotDigest: plan.opportunitySnapshotDigest,
      previewDigest: digest,
      bridge: bridge ?? null,
    };
  }

  function cancel(input = {}) {
    const plan = buildPlan(input);
    assertPresentedSnapshot(plan, input);
    const digest = planDigest(plan);
    if (!digestEquals(input.previewDigest, digest)) stalePreview();
    const bridge = typeof tenderRepository.cancelBridge === "function"
      ? withImmediateTransaction(db, () => tenderRepository.cancelBridge(bridgeInput(plan, digest, input)))
      : null;
    return cancellationResult(plan, digest, bridge);
  }

  function resultFields(plan, digest) {
    return {
      noticeId: plan.notice.id,
      customerId: plan.customer.id,
      conversionIdentity: plan.conversionIdentity,
      noticeSnapshotDigest: plan.noticeSnapshotDigest,
      canonicalNoticeId: plan.canonicalNoticeId,
      canonicalRevision: plan.canonicalRevision,
      canonicalDigest: plan.canonicalDigest,
      matchSnapshotDigest: plan.matchSnapshotDigest,
      customerSnapshotDigest: plan.customerSnapshotDigest,
      customerVersion: plan.customer.version,
      opportunitySnapshotDigest: plan.opportunitySnapshotDigest,
      previewDigest: digest,
    };
  }

  function replayedResult(plan, digest, opportunity, actionItem, bridge) {
    return {
      status: "confirmed",
      requiresHumanConfirmation: false,
      replayed: true,
      ...resultFields(plan, digest),
      opportunity,
      actionItem,
      bridge: bridge ?? null,
    };
  }

  function newlyConfirmedResult(plan, digest, opportunity, actionItem, bridge) {
    return {
      status: "confirmed",
      requiresHumanConfirmation: false,
      replayed: false,
      ...resultFields(plan, digest),
      opportunity,
      actionItem,
      bridge: bridge ?? null,
    };
  }

  function confirm(input = {}) {
    if (input.confirmed !== true) {
      throw new HttpError(
        422,
        "CONFIRMATION_REQUIRED",
        "Explicit human confirmation is required before creating records",
      );
    }
    const requestId = optionalText(input.requestId, "requestId", 200);
    let transactionPlan = null;
    try {
      return withImmediateTransaction(db, () => {
        // Re-read every reviewed source under BEGIN IMMEDIATE.  The plan digest
        // includes canonical notice identity/revision/digest, match evidence,
        // the complete customer snapshot, and the exact opportunity draft.
        const plan = buildPlan(input);
        transactionPlan = plan;
        assertPresentedSnapshot(plan, input);
        const digest = planDigest(plan);
        if (!digestEquals(input.previewDigest, digest)) stalePreview();

        const currentIds = {
          opportunityId: plan.drafts.opportunity.id,
          actionItemId: plan.drafts.actionItem.id,
        };
        const legacyIds = {
          opportunityId: deterministicIds(
            legacyConversionIdentity(plan.owner, plan.notice.identityKey, plan.customer.id),
          ).opportunityId,
          actionItemId: deterministicIds(
            legacyConversionIdentity(plan.owner, plan.notice.identityKey, plan.customer.id),
          ).actionItemId,
        };
        const readResultRows = (ids) => ({
          opportunity: db.prepare(`
          SELECT id, customer_id, owner, source_record, deleted_at
          FROM opportunities WHERE id = $id
          `).get({ $id: ids.opportunityId }),
          actionItem: db.prepare(`
          SELECT id, customer_id, opportunity_id, owner, deleted_at
          FROM action_items WHERE id = $id
          `).get({ $id: ids.actionItemId }),
        });
        const currentRows = readResultRows(currentIds);
        const legacyRows = currentIds.opportunityId === legacyIds.opportunityId
          && currentIds.actionItemId === legacyIds.actionItemId
          ? currentRows
          : readResultRows(legacyIds);
        const receipt = readConfirmationReceipt(db, plan, digest);
        const hasCurrentRows = Boolean(currentRows.opportunity || currentRows.actionItem);
        const hasLegacyRows = Boolean(legacyRows.opportunity || legacyRows.actionItem);

        if (receipt.kind === "legacy" && hasCurrentRows) conversionConflict();

        const resultIds = receipt.kind === "legacy" && !hasCurrentRows
          ? legacyIds
          : currentIds;
        const resultRows = resultIds === currentIds ? currentRows : legacyRows;
        const opportunityId = resultIds.opportunityId;
        const actionItemId = resultIds.actionItemId;
        const opportunityRow = resultRows.opportunity;
        const actionItemRow = resultRows.actionItem;

        if (opportunityRow || actionItemRow || hasLegacyRows) {
          if (!opportunityRow || !actionItemRow
            || opportunityRow.deleted_at || actionItemRow.deleted_at
            || opportunityRow.owner !== plan.owner || actionItemRow.owner !== plan.owner
            || opportunityRow.customer_id !== plan.customer.id
            || actionItemRow.customer_id !== plan.customer.id
            || actionItemRow.opportunity_id !== opportunityId
            || opportunityRow.source_record !== plan.drafts.opportunity.sourceRecord) {
            conversionConflict();
          }
          if (!receipt.valid) conversionConflict();
          const bridge = typeof tenderRepository.confirmBridge === "function"
            ? tenderRepository.confirmBridge(bridgeInput(plan, digest, input, {
              includeResultIds: true,
              resultIds,
            }))
            : null;
          if (bridge && bridge.status !== "confirmed") conversionConflict();
          const opportunity = getActiveOpportunity(db, opportunityId, plan.owner);
          const actionItem = actionItemStore.getVisible({ owner: plan.owner, id: actionItemId });
          if (!opportunity || !actionItem) conversionConflict();
          return replayedResult(plan, digest, opportunity, actionItem, bridge);
        }
        if (receipt.present) conversionConflict();

        if (typeof tenderRepository.assertBridgePreview === "function") {
          tenderRepository.assertBridgePreview(bridgeInput(plan, digest, input));
        }
        const opportunity = createOpportunity(db, plan.drafts.opportunity, { id: opportunityId });
        const failpointResult = failpoint("afterOpportunity");
        if (failpointResult && typeof failpointResult.then === "function") {
          throw new TypeError("failpoint must be synchronous");
        }
        const actionItem = actionItemStore.create(plan.drafts.actionItem);
        const auditReceipt = confirmationReceipt(plan, digest);
        insertAudit(db, {
          action: CONFIRM_AUDIT_ACTION,
          entityType: CONFIRM_AUDIT_ENTITY_TYPE,
          entityId: plan.notice.id,
          actor: plan.owner,
          requestId,
          before: null,
          after: auditReceipt.after,
          metadata: auditReceipt.metadata,
        });
        const bridge = typeof tenderRepository.confirmBridge === "function"
          ? tenderRepository.confirmBridge(bridgeInput(plan, digest, input, { includeResultIds: true }))
          : null;
        if (bridge && bridge.replayed === true) conversionConflict();
        return newlyConfirmedResult(plan, digest, opportunity, actionItem, bridge);
      });
    } catch (error) {
      if (transactionPlan && BRIDGE_CONFIRM_CONFLICT_CODES.has(error?.code)) {
        try {
          withImmediateTransaction(db, () => markBridgeConflict(transactionPlan));
        } catch (persistenceError) {
          if (error instanceof Error) {
            Object.defineProperty(error, "bridgeConflictPersistenceError", {
              value: persistenceError,
              configurable: true,
            });
          }
        }
      }
      throw error;
    }
  }

  return Object.freeze({ preview, cancel, confirm });
}
