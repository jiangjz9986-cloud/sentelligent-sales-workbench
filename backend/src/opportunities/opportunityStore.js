import { randomUUID } from "node:crypto";

import { all, get, run } from "../db.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { insertAudit } from "../audit/auditRepository.js";
import { HttpError } from "../http/errors.js";

/**
 * Shared opportunity write path (moved out of server.js in v0.7.6, mirroring
 * customers/customerStore.js). The web HTTP routes and the WeChat assistant
 * runtime both use this module so row projection, create/update SQL,
 * optimistic locking, and audit snapshots cannot drift between channels.
 */

const OPPORTUNITY_SOFT_DELETE_AUDIT_FIELDS = [
  "id", "version", "customerId", "name", "stage", "owner", "createdAt", "updatedAt",
];
const ID_SUFFIX = /^[A-Za-z0-9-]{6,64}$/u;

function parseJson(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function patchValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? body[field] : currentValue;
}

function patchJsonValue(body, field, currentValue) {
  return Object.hasOwn(body, field) ? json(body[field]) : json(currentValue);
}

function notFound() {
  throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
}

function throwVersionFailure(db, id) {
  const current = get(db, "SELECT version, deleted_at FROM opportunities WHERE id = $id", { $id: id });
  if (!current || current.deleted_at) notFound();
  throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
    currentVersion: Number(current.version),
  });
}

export function opportunityFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    customerId: row.customer_id,
    name: row.name,
    customer: row.customer,
    stage: row.stage,
    amount: row.amount,
    owner: row.owner,
    probability: row.probability,
    days: row.days,
    requirements: parseJson(row.requirements),
    competitors: parseJson(row.competitors),
    solutionDirection: parseJson(row.solution_direction),
    sourceRecord: row.source_record,
    risk: row.risk,
    next: row.next,
    tone: row.tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function activeOpportunityEntityRow(db, id, owner) {
  if (!id) return null;
  const ownerClause = owner === undefined || owner === null
    ? ""
    : " AND opportunities.owner = $owner AND customers.owner = $owner";
  return get(
    db,
    `SELECT opportunities.*
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id
     WHERE opportunities.id = $id
       AND opportunities.deleted_at IS NULL
       AND customers.deleted_at IS NULL${ownerClause}`,
    owner === undefined || owner === null ? { $id: id } : { $id: id, $owner: owner },
  );
}

export function getActiveOpportunity(db, id) {
  return opportunityFromRow(activeOpportunityEntityRow(db, id));
}

export function createOpportunity(db, body, { id = randomUUID() } = {}) {
  run(
    db,
    `INSERT INTO opportunities (
      id, customer_id, name, customer, stage, amount, owner, probability,
      days, requirements, competitors, solution_direction, source_record,
      risk, next, tone
    ) VALUES (
      $id, $customerId, $name, $customer, $stage, $amount, $owner, $probability,
      $days, $requirements, $competitors, $solutionDirection, $sourceRecord,
      $risk, $next, $tone
    )`,
    {
      $id: id,
      $customerId: body.customerId,
      $name: body.name,
      $customer: body.customer ?? null,
      $stage: body.stage ?? null,
      $amount: body.amount ?? null,
      $owner: body.owner ?? null,
      $probability: body.probability ?? 0,
      $days: body.days ?? 0,
      $requirements: json(body.requirements),
      $competitors: json(body.competitors),
      $solutionDirection: json(body.solutionDirection),
      $sourceRecord: body.sourceRecord ?? null,
      $risk: body.risk ?? null,
      $next: body.next ?? null,
      $tone: body.tone ?? null,
    },
  );
  return opportunityFromRow(get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id }));
}

export function updateOpportunity(db, id, body, expectedVersion) {
  const current = getActiveOpportunity(db, id);
  if (!current) return null;

  const result = run(
    db,
    `UPDATE opportunities
     SET customer_id = $customerId,
         name = $name,
         customer = $customer,
         stage = $stage,
         amount = $amount,
         owner = $owner,
         probability = $probability,
         days = $days,
         requirements = $requirements,
         competitors = $competitors,
         solution_direction = $solutionDirection,
         source_record = $sourceRecord,
         risk = $risk,
         next = $next,
         tone = $tone,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $id
       AND version = $expectedVersion
       AND deleted_at IS NULL`,
    {
      $id: id,
      $expectedVersion: expectedVersion,
      $customerId: patchValue(body, "customerId", current.customerId),
      $name: patchValue(body, "name", current.name),
      $customer: patchValue(body, "customer", current.customer),
      $stage: patchValue(body, "stage", current.stage),
      $amount: patchValue(body, "amount", current.amount),
      $owner: patchValue(body, "owner", current.owner),
      $probability: patchValue(body, "probability", current.probability),
      $days: patchValue(body, "days", current.days),
      $requirements: patchJsonValue(body, "requirements", current.requirements),
      $competitors: patchJsonValue(body, "competitors", current.competitors),
      $solutionDirection: patchJsonValue(body, "solutionDirection", current.solutionDirection),
      $sourceRecord: patchValue(body, "sourceRecord", current.sourceRecord),
      $risk: patchValue(body, "risk", current.risk),
      $next: patchValue(body, "next", current.next),
      $tone: patchValue(body, "tone", current.tone),
    },
  );
  if (result.changes !== 1) {
    throwVersionFailure(db, id);
  }

  return getActiveOpportunity(db, id);
}

function opportunitySoftDeleteAuditSnapshot(entity, lifecycle = {}) {
  return {
    ...Object.fromEntries(
      OPPORTUNITY_SOFT_DELETE_AUDIT_FIELDS
        .filter((field) => entity[field] !== undefined)
        .map((field) => [field, entity[field]]),
    ),
    ...lifecycle,
  };
}

export function softDeleteOpportunity(db, { id, expectedVersion, deletedBy, requestId, metadata = {} }) {
  return withImmediateTransaction(db, () => {
    const beforeRow = get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id });
    if (!beforeRow || beforeRow.deleted_at) notFound();

    const result = run(
      db,
      `UPDATE opportunities
       SET deleted_at = CURRENT_TIMESTAMP,
           deleted_by = $deletedBy,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $id
         AND version = $expectedVersion
         AND deleted_at IS NULL`,
      {
        $id: id,
        $expectedVersion: expectedVersion,
        $deletedBy: deletedBy,
      },
    );
    if (result.changes !== 1) {
      throwVersionFailure(db, id);
    }

    const afterRow = get(db, "SELECT * FROM opportunities WHERE id = $id", { $id: id });
    const beforeEntity = opportunityFromRow(beforeRow);
    const afterEntity = opportunityFromRow(afterRow);
    insertAudit(db, {
      action: "opportunity.delete",
      entityType: "opportunity",
      entityId: id,
      actor: deletedBy,
      metadata: {
        name: beforeEntity.name,
        customerId: beforeEntity.customerId,
        stage: beforeEntity.stage,
        ...metadata,
      },
      requestId,
      before: opportunitySoftDeleteAuditSnapshot(beforeEntity),
      after: opportunitySoftDeleteAuditSnapshot(afterEntity, {
        deletedAt: afterRow.deleted_at,
        deletedBy: afterRow.deleted_by,
      }),
      entityVersion: afterEntity.version,
    });
    return {
      ...afterEntity,
      deletedAt: afterRow.deleted_at,
      deletedBy: afterRow.deleted_by,
    };
  });
}

const OWNER_VISIBILITY_CLAUSE = `
  (opportunities.owner = $owner OR (opportunities.owner IS NULL AND customers.owner = $owner))
`;

/**
 * Owner-visible opportunities whose id ends with the given suffix (candidate
 * cards show the last six characters). Same OR-visibility scope as the
 * assistant business snapshot; LIKE metacharacters in the suffix are escaped.
 */
export function findOpportunityByIdSuffix(db, { owner, suffix }) {
  const normalizedSuffix = String(suffix ?? "").trim();
  if (typeof owner !== "string" || !owner.trim() || !ID_SUFFIX.test(normalizedSuffix)) {
    return { matches: [] };
  }
  const pattern = `%${normalizedSuffix.replace(/[\\%_]/gu, "\\$&")}`;
  const rows = all(
    db,
    `SELECT opportunities.*, customers.name AS customer_name
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id AND customers.deleted_at IS NULL
     WHERE opportunities.deleted_at IS NULL
       AND ${OWNER_VISIBILITY_CLAUSE}
       AND opportunities.id LIKE $pattern ESCAPE '\\'
     ORDER BY opportunities.updated_at DESC, opportunities.id
     LIMIT 6`,
    { $owner: owner.trim(), $pattern: pattern },
  );
  return { matches: rows.map((row) => opportunityFromRow({ ...row, customer: row.customer_name })) };
}

/** All owner-visible opportunities, most recently updated first. */
export function listOwnerOpportunities(db, { owner, limit = 9 }) {
  if (typeof owner !== "string" || !owner.trim()) return { items: [], truncated: false };
  const bounded = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 9;
  const rows = all(
    db,
    `SELECT opportunities.*, customers.name AS customer_name
     FROM opportunities
     INNER JOIN customers ON customers.id = opportunities.customer_id AND customers.deleted_at IS NULL
     WHERE opportunities.deleted_at IS NULL
       AND ${OWNER_VISIBILITY_CLAUSE}
     ORDER BY opportunities.updated_at DESC, opportunities.id
     LIMIT ${bounded + 1}`,
    { $owner: owner.trim() },
  );
  return {
    items: rows.slice(0, bounded).map((row) => opportunityFromRow({ ...row, customer: row.customer_name })),
    truncated: rows.length > bounded,
  };
}

/** Duplicate-name guard used before creating an opportunity under a customer. */
export function findActiveOpportunityByExactName(db, { customerId, name }) {
  if (typeof name !== "string" || !name.trim() || !customerId) return null;
  const row = get(
    db,
    `SELECT * FROM opportunities
     WHERE customer_id = $customerId AND name = $name AND deleted_at IS NULL
     LIMIT 1`,
    { $customerId: customerId, $name: name.trim() },
  );
  return opportunityFromRow(row);
}

/**
 * Reference counts shown on the delete preview card. Rows keep their
 * opportunity_id after a soft delete (FK SET NULL fires only on hard delete);
 * the joins in read paths hide the linkage, which is exactly what the card
 * warns about.
 */
export function countOpportunityReferences(db, opportunityId) {
  const row = get(
    db,
    `SELECT
      (SELECT COUNT(*) FROM action_items WHERE opportunity_id = $id AND deleted_at IS NULL) AS actions,
      (SELECT COUNT(*) FROM risk_items WHERE opportunity_id = $id AND deleted_at IS NULL) AS risks,
      (SELECT COUNT(*) FROM quick_records WHERE opportunity_id = $id AND voided_at IS NULL) AS quick_records,
      (SELECT COUNT(*) FROM solution_drafts WHERE opportunity_id = $id) AS solution_drafts`,
    { $id: opportunityId },
  );
  return {
    actions: Number(row?.actions ?? 0),
    risks: Number(row?.risks ?? 0),
    quickRecords: Number(row?.quick_records ?? 0),
    solutionDrafts: Number(row?.solution_drafts ?? 0),
  };
}
