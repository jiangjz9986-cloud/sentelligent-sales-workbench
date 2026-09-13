import { randomUUID } from "node:crypto";

import { insertAudit } from "../src/audit/auditRepository.js";
import { createActionRiskWritebackService } from "../src/actionRisk/writeback.js";
import { createCustomerProactiveSubjectService } from "../src/assistant/customerProactiveSubjectService.js";
import { openDatabase } from "../src/db.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import { readProductionDatabaseIdentity } from "./production-smoke-cleanup.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredText(value, label, max = 200) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertRunId(value) {
  const runId = requiredText(value, "runId", 100);
  if (!UUID_PATTERN.test(runId)) throw new TypeError("runId must be a UUID");
  return runId;
}

function assertOwner(value) {
  return requiredText(value, "owner", 200);
}

function assertDatabaseInput({ databaseUrl, authSessionSecret } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new TypeError("databaseUrl is required");
  }
  if (typeof authSessionSecret !== "string" || authSessionSecret.length < 32) {
    throw new TypeError("authSessionSecret must contain at least 32 characters");
  }
}

function markerFor(runId) {
  return `[v0.12:${runId}]`;
}

function ownedOpportunity(db, { owner, customerId, opportunityId }) {
  const row = db.prepare(`
    SELECT
      customer.id AS customer_id,
      customer.owner AS customer_owner,
      customer.deleted_at AS customer_deleted_at,
      opportunity.id AS opportunity_id,
      opportunity.owner AS opportunity_owner,
      opportunity.customer_id AS opportunity_customer_id,
      opportunity.deleted_at AS opportunity_deleted_at
      FROM opportunities opportunity
      JOIN customers customer ON customer.id = opportunity.customer_id
     WHERE opportunity.id = $opportunityId
       AND opportunity.customer_id = $customerId
       AND opportunity.owner = $owner
       AND customer.owner = $owner
       AND opportunity.deleted_at IS NULL
       AND customer.deleted_at IS NULL
  `).get({
    $owner: owner,
    $customerId: customerId,
    $opportunityId: opportunityId,
  });
  if (!row) throw new Error("The acceptance customer and opportunity must belong to the acceptance owner");
  return row;
}

function findSuggestion(result, trigger) {
  const item = result.suggestions.find((candidate) => (
    (typeof candidate?.trigger === "string" ? candidate.trigger : candidate?.trigger?.type) === trigger
  ));
  if (!item) throw new Error(`The customer proactive fixture did not produce ${trigger}`);
  return item;
}

function subjectRow(db, { owner, customerId }) {
  const row = db.prepare(`
    SELECT id, subject_key, version, source_digest
      FROM proactive_subjects
     WHERE owner = $owner AND subject_type = 'customer' AND customer_id = $customerId
  `).get({ $owner: owner, $customerId: customerId });
  if (!row) throw new Error("The customer proactive subject was not persisted");
  return row;
}

/**
 * Create only the server-local synthetic risk needed to exercise the real
 * proactive subject and writeback path. The caller must provide an existing
 * owner/customer/opportunity tuple; this helper never creates or mutates that
 * business identity and never reads credential material other than the DB
 * identity secret supplied by the server-local runner.
 */
export function createV0120ProductionAcceptanceFixture({
  databaseUrl,
  authSessionSecret,
  runId,
  owner,
  customerId,
  opportunityId,
  clock = () => new Date(),
} = {}) {
  assertDatabaseInput({ databaseUrl, authSessionSecret });
  const exactRunId = assertRunId(runId);
  const exactOwner = assertOwner(owner);
  const exactCustomerId = requiredText(customerId, "customerId");
  const exactOpportunityId = requiredText(opportunityId, "opportunityId");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const identity = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret });
  const db = openDatabase({ databaseUrl: identity.databasePath });
  const marker = markerFor(exactRunId);
  const seedRiskId = `v0120-risk-${exactRunId}`;
  try {
    const relationship = ownedOpportunity(db, {
      owner: exactOwner,
      customerId: exactCustomerId,
      opportunityId: exactOpportunityId,
    });
    const writeback = createActionRiskWritebackService({
      db,
      idFactory: () => seedRiskId,
    });
    const seeded = withImmediateTransaction(db, () => {
      const risk = writeback.writeRisk({
        mode: "create",
        id: seedRiskId,
        owner: exactOwner,
        customerId: exactCustomerId,
        opportunityId: exactOpportunityId,
        title: `${marker} 主动助手验收风险`,
        target: `${marker} 客户商机`,
        score: 88,
        severity: "高",
        status: "open",
        evidence: `${marker} 仅用于主动助手生产验收，清理时按精确 id 删除。`,
        action: `${marker} 验收后由清理器删除，不产生真实业务后续动作。`,
        expectedResult: `${marker} 风险写回链路可验证`,
        assignee: exactOwner,
        due: new Date(clock()).toISOString().slice(0, 10),
      }, { withinTransaction: true });
      const audit = insertAudit(db, {
        action: "v0120.production_acceptance.seed",
        entityType: "risk",
        entityId: risk.id,
        actor: exactOwner,
        requestId: exactRunId,
        before: null,
        after: {
          id: risk.id,
          customerId: exactCustomerId,
          opportunityId: exactOpportunityId,
          writebackDigest: risk.writebackDigest,
        },
        entityVersion: risk.version,
        metadata: {
          marker,
          purpose: "v0120-production-acceptance",
        },
      });
      return { risk, audit };
    });

    const subjectService = createCustomerProactiveSubjectService({ db, clock });
    const synced = subjectService.syncCustomer({
      owner: exactOwner,
      customerId: exactCustomerId,
      includeExtendedSignals: true,
    });
    const subject = subjectRow(db, { owner: exactOwner, customerId: exactCustomerId });
    const actionSuggestion = findSuggestion(synced, "missing_next_step");
    const riskSuggestion = findSuggestion(synced, "risk_open");
    const suggestionIds = db.prepare(`
      SELECT id
        FROM ai_suggestions
       WHERE owner = $owner AND proactive_subject_key = $subjectKey
       ORDER BY created_at ASC, id ASC
    `).all({ $owner: exactOwner, $subjectKey: subject.subject_key }).map((row) => String(row.id));
    if (suggestionIds.length === 0) throw new Error("The customer proactive suggestion ledger is empty");

    for (const suggestion of [actionSuggestion, riskSuggestion]) {
      if (!JSON.stringify(suggestion).includes(marker)) {
        throw new Error(`The ${suggestion.trigger.type} suggestion lost the acceptance marker`);
      }
    }

    return Object.freeze({
      runId: exactRunId,
      owner: exactOwner,
      customerId: exactCustomerId,
      opportunityId: exactOpportunityId,
      marker,
      databaseIdentity: identity.databaseIdentity,
      seedRiskId: seeded.risk.id,
      seedRiskVersion: seeded.risk.version,
      seedRiskWritebackDigest: seeded.risk.writebackDigest,
      seedAuditId: seeded.audit.id,
      subjectId: subject.id,
      subjectKey: subject.subject_key,
      subjectVersion: Number(subject.version),
      sourceDigest: subject.source_digest,
      suggestionIds,
      actionSuggestionId: actionSuggestion.id,
      actionSuggestionVersion: actionSuggestion.version,
      actionSuggestionDigest: actionSuggestion.previewDigests?.action ?? actionSuggestion.previewDigest ?? null,
      riskSuggestionId: riskSuggestion.id,
      riskSuggestionVersion: riskSuggestion.version,
      riskSuggestionDigest: riskSuggestion.previewDigests?.risk ?? riskSuggestion.previewDigest ?? null,
    });
  } finally {
    db.close();
  }
}
