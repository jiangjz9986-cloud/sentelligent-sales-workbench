import { HttpError } from "../http/errors.js";

// Shared owner-scoped quick-record read/write module (v0.7.3). The WeChat
// assistant handlers and the web PATCH /api/quick-records/:id/analysis route
// consume the same SQL so the two write paths cannot drift. Auditing stays
// with the callers (same decision as customers/customerStore.js).

const ID_SUFFIX = /^[A-Za-z0-9-]{6,64}$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const SUMMARY_KEYS = new Set(["request", "feedback", "risk", "action"]);

/**
 * A durable confirmation preview is a snapshot. Once it is completed or
 * cancelled, every edit/analyse path must stop rather than silently creating
 * a new revision behind the user's confirmed (or explicitly declined) view.
 * Keep this guard exported so HTTP and assistant callers share one rule.
 */
export function assertQuickRecordConfirmationEditable(record) {
  const status = record?.confirmationPreviewStatus;
  if (!["completed", "cancelled"].includes(status)) return;
  throw new HttpError(
    409,
    "QUICK_RECORD_CONFIRMATION_TERMINAL",
    "The quick-record confirmation preview is terminal and cannot be edited",
    {
      currentStatus: status,
      previewId: record.confirmationPreviewId ?? null,
    },
  );
}

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function optionalOwner(value) {
  if (value === undefined || value === null) return null;
  return requiredText(value, "owner", 200);
}

function requiredVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
  return version;
}

function normalizedDate(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const text = requiredText(value, name, 10);
  if (!DATE_ONLY.test(text)) throw new TypeError(`${name} must be YYYY-MM-DD`);
  return text;
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

function quickRecordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    owner: row.owner ?? null,
    rawContent: row.raw_content,
    occurredAt: row.occurred_at,
    sourceChannel: row.source_channel,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    customerName: row.customer_name ?? null,
    status: row.status,
    confirmationPreviewId: row.confirmation_preview_id ?? null,
    confirmationPreviewStatus: row.confirmation_preview_status ?? null,
    voidedAt: row.voided_at ?? null,
    voidedBy: row.voided_by ?? null,
    voidReason: row.void_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insightFromRow(row) {
  if (!row) return null;
  let analysis = {};
  try { analysis = JSON.parse(row.analysis_json); } catch { analysis = {}; }
  return {
    id: row.id,
    quickRecordId: row.quick_record_id,
    source: row.source,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...analysis,
  };
}

function ownerClause(owner, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return owner === null ? "" : ` AND ${prefix}owner = $owner`;
}

function ownerParams(owner) {
  return owner === null ? {} : { $owner: owner };
}

function throwMutationFailure(db, { owner, id }) {
  const current = db.prepare(
    `SELECT version, voided_at FROM quick_records WHERE id = $id${ownerClause(owner)}`,
  ).get({ $id: id, ...ownerParams(owner) });
  if (!current || current.voided_at) {
    throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
  }
  throw new HttpError(409, "VERSION_CONFLICT", "The record was updated by another request", {
    currentVersion: Number(current.version),
  });
}

export function createQuickRecordStore(db, { clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  function search({ owner, query = null, dateStart = null, dateEnd = null, limit = 6 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : 6;
    const normalizedQuery = typeof query === "string" && query.trim() ? query.trim().slice(0, 200) : null;
    const start = normalizedDate(dateStart, "dateStart");
    const end = normalizedDate(dateEnd, "dateEnd");
    const rows = db.prepare(`
      SELECT qr.*, c.name AS customer_name
      FROM quick_records qr
      LEFT JOIN customers c ON c.id = qr.customer_id AND c.deleted_at IS NULL
      WHERE qr.owner = $owner AND qr.voided_at IS NULL
        AND ($start IS NULL OR date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10)) >= date($start))
        AND ($end IS NULL OR date(substr(COALESCE(qr.occurred_at, qr.created_at), 1, 10)) <= date($end))
        AND ($pattern IS NULL OR qr.raw_content LIKE $pattern ESCAPE '\\' OR c.name LIKE $pattern ESCAPE '\\')
      ORDER BY COALESCE(qr.occurred_at, qr.created_at) DESC, qr.id
      LIMIT ${normalizedLimit + 1}
    `).all({
      $owner: normalizedOwner,
      $start: start,
      $end: end,
      $pattern: normalizedQuery ? likePattern(normalizedQuery) : null,
    });
    return {
      items: rows.slice(0, normalizedLimit).map(quickRecordFromRow),
      truncated: rows.length > normalizedLimit,
    };
  }

  function findByIdSuffix({ owner, suffix } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedSuffix = requiredText(suffix, "suffix", 64);
    if (!ID_SUFFIX.test(normalizedSuffix)) return { items: [] };
    const rows = db.prepare(`
      SELECT qr.*, c.name AS customer_name
      FROM quick_records qr
      LEFT JOIN customers c ON c.id = qr.customer_id AND c.deleted_at IS NULL
      WHERE qr.owner = $owner AND qr.voided_at IS NULL
        AND qr.id LIKE $pattern ESCAPE '\\'
      ORDER BY COALESCE(qr.occurred_at, qr.created_at) DESC, qr.id
      LIMIT 6
    `).all({
      $owner: normalizedOwner,
      $pattern: `%${normalizedSuffix.replace(/[\\%_]/gu, "\\$&")}`,
    });
    return { items: rows.map(quickRecordFromRow) };
  }

  function latestEditable({ owner, withinDays = 3 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const days = Number.isSafeInteger(withinDays) && withinDays >= 1 && withinDays <= 30 ? withinDays : 3;
    const nowIso = clock().toISOString();
    const row = db.prepare(`
      SELECT qr.*, c.name AS customer_name
      FROM quick_records qr
      LEFT JOIN customers c ON c.id = qr.customer_id AND c.deleted_at IS NULL
      WHERE qr.owner = $owner AND qr.voided_at IS NULL
        AND datetime(COALESCE(qr.occurred_at, qr.created_at)) >= datetime($now, '-' || $days || ' days')
      ORDER BY COALESCE(qr.occurred_at, qr.created_at) DESC, qr.id
      LIMIT 1
    `).get({ $owner: normalizedOwner, $now: nowIso, $days: days });
    return quickRecordFromRow(row);
  }

  function getWithLatestInsight({ owner, id } = {}) {
    const normalizedOwner = optionalOwner(owner);
    const normalizedId = requiredText(id, "id", 200);
    const row = db.prepare(`
      SELECT qr.*, c.name AS customer_name
      FROM quick_records qr
      LEFT JOIN customers c ON c.id = qr.customer_id AND c.deleted_at IS NULL
      WHERE qr.id = $id AND qr.voided_at IS NULL${ownerClause(normalizedOwner, "qr")}
    `).get({ $id: normalizedId, ...ownerParams(normalizedOwner) });
    const record = quickRecordFromRow(row);
    if (!record) return null;
    const insightRow = db.prepare(`
      SELECT * FROM ai_insights
      WHERE quick_record_id = $quickRecordId
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get({ $quickRecordId: record.id });
    return { record, insight: insightFromRow(insightRow) };
  }

  function assertLinkRelationship({ customerId, opportunityId }) {
    if (customerId) {
      const customer = db.prepare(
        "SELECT id FROM customers WHERE id = $id AND deleted_at IS NULL",
      ).get({ $id: customerId });
      if (!customer) {
        throw new HttpError(400, "QUICK_RECORD_RELATIONSHIP_INVALID", "The customer does not exist or is deleted");
      }
    }
    if (opportunityId) {
      const opportunity = db.prepare(
        "SELECT customer_id FROM opportunities WHERE id = $id AND deleted_at IS NULL",
      ).get({ $id: opportunityId });
      if (!opportunity) {
        throw new HttpError(400, "QUICK_RECORD_RELATIONSHIP_INVALID", "The opportunity does not exist or is deleted");
      }
      if (customerId && opportunity.customer_id !== customerId) {
        throw new HttpError(400, "QUICK_RECORD_RELATIONSHIP_INVALID", "The opportunity does not belong to the customer");
      }
    }
  }

  function updateFields({ owner, id, expectedVersion, occurredAt, customerId, opportunityId } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedId = requiredText(id, "id", 200);
    const version = requiredVersion(expectedVersion);
    const before = getWithLatestInsight({ owner: normalizedOwner, id: normalizedId });
    if (!before) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    assertQuickRecordConfirmationEditable(before.record);
    const sets = [];
    const params = {};
    if (occurredAt !== undefined) {
      if (occurredAt !== null) {
        const normalized = requiredText(occurredAt, "occurredAt", 100);
        if (!Number.isFinite(Date.parse(normalized))) throw new TypeError("occurredAt must be an ISO date-time");
        params.$occurredAt = new Date(normalized).toISOString();
      } else {
        params.$occurredAt = null;
      }
      sets.push("occurred_at = $occurredAt");
    }
    const nextCustomerId = customerId === undefined ? before.record.customerId : customerId;
    const nextOpportunityId = opportunityId === undefined ? before.record.opportunityId : opportunityId;
    if (customerId !== undefined || opportunityId !== undefined) {
      assertLinkRelationship({ customerId: nextCustomerId, opportunityId: nextOpportunityId });
    }
    if (customerId !== undefined) {
      sets.push("customer_id = $customerId");
      params.$customerId = customerId;
    }
    if (opportunityId !== undefined) {
      sets.push("opportunity_id = $opportunityId");
      params.$opportunityId = opportunityId;
    }
    if (sets.length === 0) throw new TypeError("updateFields requires at least one field");
    const result = db.prepare(`
      UPDATE quick_records
      SET ${sets.join(", ")},
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND voided_at IS NULL
    `).run({ ...params, $id: normalizedId, $owner: normalizedOwner, $expectedVersion: version });
    if (result.changes !== 1) throwMutationFailure(db, { owner: normalizedOwner, id: normalizedId });
    return {
      before: before.record,
      after: getWithLatestInsight({ owner: normalizedOwner, id: normalizedId }).record,
    };
  }

  function updateInsightSummary({ owner, id, expectedVersion, summaryPatch } = {}) {
    const normalizedOwner = optionalOwner(owner);
    const normalizedId = requiredText(id, "id", 200);
    const version = requiredVersion(expectedVersion);
    if (!summaryPatch || typeof summaryPatch !== "object" || Array.isArray(summaryPatch)) {
      throw new TypeError("summaryPatch must be an object");
    }
    const entries = Object.entries(summaryPatch);
    if (entries.length === 0) throw new TypeError("summaryPatch must contain at least one field");
    for (const [key, value] of entries) {
      if (!SUMMARY_KEYS.has(key)) throw new TypeError(`summaryPatch.${key} is not editable`);
      requiredText(value, `summaryPatch.${key}`, 2000);
    }
    const beforeRow = db.prepare(
      `SELECT * FROM quick_records WHERE id = $id AND voided_at IS NULL${ownerClause(normalizedOwner)}`,
    ).get({ $id: normalizedId, ...ownerParams(normalizedOwner) });
    const beforeRecord = quickRecordFromRow(beforeRow);
    if (!beforeRecord) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    assertQuickRecordConfirmationEditable(beforeRecord);
    const insightRow = db.prepare(`
      SELECT * FROM ai_insights
      WHERE quick_record_id = $quickRecordId
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get({ $quickRecordId: beforeRecord.id });
    if (!insightRow) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");

    let persistedAnalysis = null;
    try { persistedAnalysis = JSON.parse(insightRow.analysis_json); } catch { persistedAnalysis = null; }
    if (!persistedAnalysis?.summary || typeof persistedAnalysis.summary !== "object") {
      throw new HttpError(500, "DATA_INTEGRITY_ERROR", "Saved quick-record analysis is invalid");
    }
    const nextSummary = { ...persistedAnalysis.summary };
    for (const [key, text] of entries) {
      const current = nextSummary[key];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new HttpError(500, "DATA_INTEGRITY_ERROR", "Saved quick-record analysis summary is invalid");
      }
      nextSummary[key] = { ...current, text: text.trim() };
    }
    const result = db.prepare(`
      UPDATE quick_records
      SET status = $status,
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND version = $expectedVersion AND voided_at IS NULL${ownerClause(normalizedOwner)}
    `).run({
      $id: beforeRecord.id,
      $status: beforeRecord.status,
      $expectedVersion: version,
      ...ownerParams(normalizedOwner),
    });
    if (result.changes !== 1) throwMutationFailure(db, { owner: normalizedOwner, id: beforeRecord.id });
    db.prepare("UPDATE ai_insights SET analysis_json = $analysisJson WHERE id = $id").run({
      $id: insightRow.id,
      $analysisJson: JSON.stringify({ ...persistedAnalysis, summary: nextSummary }),
    });
    const after = getWithLatestInsight({ owner: normalizedOwner, id: beforeRecord.id });
    return {
      beforeRecord,
      beforeAnalysis: insightFromRow(insightRow),
      record: after.record,
      analysis: after.insight,
    };
  }

  function voidRecord({ owner, id, expectedVersion, voidedBy, reason = null } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedId = requiredText(id, "id", 200);
    const version = requiredVersion(expectedVersion);
    const normalizedVoidedBy = requiredText(voidedBy, "voidedBy", 200);
    const normalizedReason = reason === null || reason === undefined
      ? null
      : requiredText(reason, "reason", 500);
    const before = getWithLatestInsight({ owner: normalizedOwner, id: normalizedId });
    if (!before) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    const result = db.prepare(`
      UPDATE quick_records
      SET voided_at = $voidedAt,
          voided_by = $voidedBy,
          void_reason = $voidReason,
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND owner = $owner AND version = $expectedVersion AND voided_at IS NULL
    `).run({
      $id: normalizedId,
      $owner: normalizedOwner,
      $voidedAt: clock().toISOString(),
      $voidedBy: normalizedVoidedBy,
      $voidReason: normalizedReason,
      $expectedVersion: version,
    });
    if (result.changes !== 1) throwMutationFailure(db, { owner: normalizedOwner, id: normalizedId });
    const afterRow = db.prepare(
      "SELECT qr.*, NULL AS customer_name FROM quick_records qr WHERE qr.id = $id",
    ).get({ $id: normalizedId });
    return { before: before.record, after: quickRecordFromRow(afterRow) };
  }

  return Object.freeze({
    search,
    findByIdSuffix,
    latestEditable,
    getWithLatestInsight,
    updateFields,
    updateInsightSummary,
    void: voidRecord,
  });
}
