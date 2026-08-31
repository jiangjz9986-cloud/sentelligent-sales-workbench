import { createHash, timingSafeEqual } from "node:crypto";

import { createActionItemStore } from "../actionItems/actionItemStore.js";
import { insertAudit } from "../audit/auditRepository.js";
import { getActiveCustomer } from "../customers/customerStore.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { createOpportunity, getActiveOpportunity } from "../opportunities/opportunityStore.js";
import { matchNoticeToCustomers } from "./matching.js";
import { customerSnapshotFromRow } from "./sync.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONVERSION_SCHEMA_VERSION = 1;
const DEFAULT_NEXT_STEP = "核验公告范围、预算、截止时间和客户采购计划";
const CONFIRM_AUDIT_ACTION = "hospital_tender.lead_conversion.confirm";
const CONFIRM_AUDIT_ENTITY_TYPE = "hospital_tender_notice";

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

function conversionIdentity(owner, identityKey, customerId) {
  return sha256(JSON.stringify([
    "hospital_tender_lead_conversion",
    CONVERSION_SCHEMA_VERSION,
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
  };
}

function publicCustomer(customer) {
  return {
    id: customer.id,
    version: customer.version,
    name: customer.name,
  };
}

function resultFromPlan(plan, digest) {
  return {
    status: "preview",
    requiresHumanConfirmation: true,
    notice: plan.notice,
    customer: plan.customer,
    conversionIdentity: plan.conversionIdentity,
    noticeSnapshotDigest: plan.noticeSnapshotDigest,
    match: plan.match,
    drafts: plan.drafts,
    diff: {
      opportunity: { before: null, after: plan.drafts.opportunity },
      actionItem: { before: null, after: plan.drafts.actionItem },
    },
    previewDigest: digest,
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
    owner: plan.owner,
    customerId: plan.customer.id,
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
  return actual !== null
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function receiptReferencesConversion(receipt, expected) {
  const payloads = [receipt.after, receipt.metadata].filter(Boolean);
  return payloads.some((payload) => payload.conversionIdentity === expected.after.conversionIdentity
    || (payload.opportunityId === expected.after.opportunityId
      && payload.actionItemId === expected.after.actionItemId));
}

function readConfirmationReceipt(db, plan, digest) {
  const expected = confirmationReceipt(plan, digest);
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
  const candidates = rows.filter((row) => receiptReferencesConversion(row, expected));
  const valid = candidates.filter((row) => row.action === CONFIRM_AUDIT_ACTION
    && row.entity_type === CONFIRM_AUDIT_ENTITY_TYPE
    && row.entity_id === plan.notice.id
    && row.actor === plan.owner
    && receiptPayloadMatches(row.after, expected.after)
    && receiptPayloadMatches(row.metadata, expected.metadata));
  return {
    present: candidates.length > 0,
    valid: candidates.length === 1 && valid.length === 1,
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

  function buildPlan(input = {}) {
    const owner = requiredText(input.owner, "owner", 200);
    const noticeId = requiredText(input.noticeId, "noticeId", 200);
    const customerId = requiredText(input.customerId, "customerId", 200);
    const notice = tenderRepository.getNotice(noticeId);
    if (!notice) notFound();
    const customer = getActiveCustomer(db, customerId, { owner });
    if (!customer) notFound();

    const matchedCustomerIds = stringList(notice.match?.matchedCustomerIds);
    if (!matchedCustomerIds.includes(customer.id)) notFound();

    const match = currentCustomerMatch(notice, customer);
    const identity = conversionIdentity(owner, notice.identityKey, customer.id);
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
      schemaVersion: CONVERSION_SCHEMA_VERSION,
      conversionIdentity: identity,
      noticeSnapshotDigest: noticeSnapshotDigest(notice),
      owner,
      notice: publicNotice(notice),
      customer: publicCustomer(customer),
      match,
      drafts: { opportunity, actionItem },
    };
  }

  function preview(input = {}) {
    const plan = buildPlan(input);
    return resultFromPlan(plan, planDigest(plan));
  }

  function cancel(input = {}) {
    const current = preview(input);
    if (!digestEquals(input.previewDigest, current.previewDigest)) stalePreview();
    return {
      status: "cancelled",
      requiresHumanConfirmation: false,
      noticeId: current.notice.id,
      customerId: current.customer.id,
      conversionIdentity: current.conversionIdentity,
      noticeSnapshotDigest: current.noticeSnapshotDigest,
      previewDigest: current.previewDigest,
    };
  }

  function replayedResult(plan, digest, opportunity, actionItem) {
    return {
      status: "confirmed",
      requiresHumanConfirmation: false,
      replayed: true,
      noticeId: plan.notice.id,
      customerId: plan.customer.id,
      conversionIdentity: plan.conversionIdentity,
      noticeSnapshotDigest: plan.noticeSnapshotDigest,
      previewDigest: digest,
      opportunity,
      actionItem,
    };
  }

  function newlyConfirmedResult(plan, digest, opportunity, actionItem) {
    return {
      status: "confirmed",
      requiresHumanConfirmation: false,
      replayed: false,
      noticeId: plan.notice.id,
      customerId: plan.customer.id,
      conversionIdentity: plan.conversionIdentity,
      noticeSnapshotDigest: plan.noticeSnapshotDigest,
      previewDigest: digest,
      opportunity,
      actionItem,
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

    return withImmediateTransaction(db, () => {
      // Re-read both records under BEGIN IMMEDIATE, then recompute the exact
      // plan so a changed notice, match, or customer version invalidates the
      // digest that the human previously saw.
      const plan = buildPlan(input);
      const digest = planDigest(plan);
      if (!digestEquals(input.previewDigest, digest)) stalePreview();

      const opportunityId = plan.drafts.opportunity.id;
      const actionItemId = plan.drafts.actionItem.id;
      const opportunityRow = db.prepare(`
        SELECT id, customer_id, owner, source_record, deleted_at
        FROM opportunities WHERE id = $id
      `).get({ $id: opportunityId });
      const actionItemRow = db.prepare(`
        SELECT id, customer_id, opportunity_id, owner, deleted_at
        FROM action_items WHERE id = $id
      `).get({ $id: actionItemId });
      const receipt = readConfirmationReceipt(db, plan, digest);

      if (opportunityRow || actionItemRow) {
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
        const opportunity = getActiveOpportunity(db, opportunityId, plan.owner);
        const actionItem = actionItemStore.getVisible({ owner: plan.owner, id: actionItemId });
        if (!opportunity || !actionItem) conversionConflict();
        return replayedResult(plan, digest, opportunity, actionItem);
      }
      if (receipt.present) conversionConflict();

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
      return newlyConfirmedResult(plan, digest, opportunity, actionItem);
    });
  }

  return Object.freeze({ preview, cancel, confirm });
}
