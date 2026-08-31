import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";

const MAX_OWNER = 200;
const MAX_ID = 200;
const MAX_HISTORY = 50;
const MAX_JSON_ITEMS = 50;
const VISIT_EVIDENCE_KEYS = ["request", "feedback", "risk", "action"];

function requiredText(value, name, max = MAX_ID) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function owner(value) {
  return requiredText(value, "owner", MAX_OWNER);
}

function positiveVersion(value, name = "version") {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function relation(value, name = "relation") {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 100) {
    throw new TypeError(`${name} must be an integer from 0 to 100`);
  }
  return normalized;
}

function timestamp(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value.toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boundedArray(value, name) {
  if (!Array.isArray(value) || value.length > MAX_JSON_ITEMS) {
    throw new Error(`${name} must contain a bounded JSON array`);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sourceRef(value, fallbackType = null, fallbackId = null) {
  const type = value?.type ?? fallbackType;
  const id = value?.id ?? fallbackId;
  if (typeof type !== "string" || !type.trim() || typeof id !== "string" || !id.trim()) return null;
  if (type.length > MAX_ID || id.length > MAX_ID || !/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(type) || !/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(id)) return null;
  return { type: type.trim(), id: id.trim() };
}

function boundedEvidenceValue(value) {
  if (typeof value === "string" && value.trim() && value.length <= 2_000) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function normalizeEvidenceItem(raw, index, fallbackSource) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const key = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : `evidence_${index + 1}`;
  const value = boundedEvidenceValue(raw.value ?? raw.text);
  const ref = sourceRef(raw.sourceRef, raw.sourceType, raw.sourceId) ?? fallbackSource;
  if (!ref || value === null || key.length > 200 || !/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(key)) return null;
  const confidenceValue = Number(raw.confidence ?? 100);
  return {
    key,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 200) : key,
    value,
    confidence: Number.isSafeInteger(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 100
      ? confidenceValue
      : 100,
    sourceRef: ref,
  };
}

function evidenceFromInsight(row, analysis) {
  const insightRef = sourceRef(null, "quick_record_insight", row.id);
  const result = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || seen.has(item.key) || result.length >= MAX_JSON_ITEMS) return;
    seen.add(item.key);
    result.push(item);
  };

  if (Array.isArray(analysis?.evidence)) {
    analysis.evidence.forEach((item, index) => add(normalizeEvidenceItem(item, index, insightRef)));
  }
  if (Array.isArray(analysis?.facts)) {
    analysis.facts.forEach((item, index) => add(normalizeEvidenceItem(item, index, insightRef)));
  }
  for (const key of VISIT_EVIDENCE_KEYS) {
    const summary = analysis?.summary?.[key];
    if (!summary || typeof summary !== "object") continue;
    add(normalizeEvidenceItem({
      key: `summary_${key}`,
      label: summary.title ?? key,
      value: summary.text,
      confidence: analysis.confidence ?? 100,
      sourceRef: insightRef,
    }, result.length, insightRef));
  }
  if (result.length === 0) {
    const quickRecordRef = sourceRef(null, "quick_record", row.id);
    add(normalizeEvidenceItem({
      key: "quick_record",
      label: "快速记录",
      value: row.raw_content,
      sourceRef: quickRecordRef,
    }, 0, quickRecordRef));
  }
  return result;
}

function latestInsight(db, quickRecordId) {
  return db.prepare(`
    SELECT * FROM ai_insights
    WHERE quick_record_id = $quickRecordId
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get({ $quickRecordId: quickRecordId }) ?? null;
}

function confirmedVisitFromRows(row, insightRow, confirmationRow) {
  if (!row) return null;
  const analysis = insightRow ? parseJson(insightRow.analysis_json, {}) : {};
  return {
    id: row.id,
    owner: row.owner,
    status: row.status,
    version: Number(row.version ?? 1),
    customerId: row.customer_id,
    occurredAt: row.occurred_at,
    confirmedAt: confirmationRow?.confirmed_at ?? row.updated_at ?? row.created_at,
    evidence: evidenceFromInsight({
      ...(insightRow ?? { id: row.id }),
      raw_content: row.raw_content,
    }, analysis),
  };
}

function customerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    version: Number(row.version ?? 1),
    relation: Number(row.relation),
    name: row.name ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function suggestionFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    identity: row.identity,
    owner: row.owner,
    status: row.status,
    visitId: row.visit_id,
    visitVersion: Number(row.visit_version),
    visitEvidenceHash: row.visit_evidence_hash,
    customerId: row.customer_id,
    customerVersion: Number(row.customer_version),
    previousValue: Number(row.previous_value),
    suggestedValue: Number(row.suggested_value),
    delta: Number(row.delta),
    confidence: Number(row.confidence),
    facts: parseJson(row.facts_json, []),
    inferences: parseJson(row.inferences_json, []),
    sourceRefs: parseJson(row.source_refs_json, []),
    requiresHumanConfirmation: Number(row.requires_human_confirmation) === 1,
    writebackAllowed: Number(row.writeback_allowed) === 1,
    inputSnapshotHash: row.input_snapshot_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    confirmedCustomerVersion: row.confirmed_customer_version === null
      ? null
      : Number(row.confirmed_customer_version),
    confirmedRelation: row.confirmed_relation === null ? null : Number(row.confirmed_relation),
  };
}

function assertDb(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
}

function assertIdFactory(idFactory) {
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
}

export function createVisitTemperatureSuggestionRepositories(
  db,
  { idFactory = randomUUID, clock = () => new Date() } = {},
) {
  assertDb(db);
  assertIdFactory(idFactory);
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const visitRepository = Object.freeze({
    getConfirmed({ owner: ownerValue, visitId } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(visitId, "visitId");
      const row = db.prepare(`
        SELECT * FROM quick_records
        WHERE id = $id AND owner = $owner AND status = 'confirmed' AND voided_at IS NULL
      `).get({ $id: id, $owner: normalizedOwner });
      if (!row) return null;
      const insight = latestInsight(db, id);
      const confirmation = db.prepare(`
        SELECT MAX(created_at) AS confirmed_at
        FROM manual_confirmations
        WHERE quick_record_id = $quickRecordId
      `).get({ $quickRecordId: id });
      return confirmedVisitFromRows(row, insight, confirmation);
    },
  });

  const customerRepository = Object.freeze({
    getActive({ owner: ownerValue, customerId } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(customerId, "customerId");
      return customerFromRow(db.prepare(`
        SELECT * FROM customers
        WHERE id = $id AND owner = $owner AND deleted_at IS NULL
      `).get({ $id: id, $owner: normalizedOwner }));
    },

    updateRelation({
      owner: ownerValue,
      customerId,
      expectedVersion,
      expectedRelation,
      relation: nextRelation,
      suggestionId = null,
      actor = null,
      requestId = null,
    } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(customerId, "customerId");
      const version = positiveVersion(expectedVersion, "expectedVersion");
      const previousRelation = relation(expectedRelation, "expectedRelation");
      const updatedRelation = relation(nextRelation, "relation");
      const before = customerRepository.getActive({ owner: normalizedOwner, customerId: id });
      if (!before) return { notFound: true };
      const now = timestamp(clock);
      const result = db.prepare(`
        UPDATE customers
        SET relation = $relation,
            version = version + 1,
            updated_at = $updatedAt
        WHERE id = $id
          AND owner = $owner
          AND version = $expectedVersion
          AND relation = $expectedRelation
          AND deleted_at IS NULL
      `).run({
        $relation: updatedRelation,
        $updatedAt: now,
        $id: id,
        $owner: normalizedOwner,
        $expectedVersion: version,
        $expectedRelation: previousRelation,
      });
      if (Number(result.changes) !== 1) {
        const current = customerRepository.getActive({ owner: normalizedOwner, customerId: id });
        return current ? { conflict: true, current: clone(current) } : { notFound: true };
      }
      const after = customerRepository.getActive({ owner: normalizedOwner, customerId: id });
      insertAudit(db, {
        action: "customer.relation.update",
        entityType: "customer",
        entityId: id,
        actor: actor ? requiredText(actor, "actor", MAX_OWNER) : normalizedOwner,
        requestId,
        before: { id, owner: normalizedOwner, version: before.version, relation: before.relation },
        after: { id, owner: normalizedOwner, version: after.version, relation: after.relation },
        entityVersion: after.version,
        metadata: {
          source: "visit_temperature_suggestion",
          suggestionId: suggestionId ?? null,
        },
      });
      return { item: clone(after) };
    },
  });

  const suggestionRepository = Object.freeze({
    findByVisit({ owner: ownerValue, visitId } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(visitId, "visitId");
      return suggestionFromRow(db.prepare(`
        SELECT * FROM visit_temperature_suggestions
        WHERE owner = $owner AND visit_id = $visitId
      `).get({ $owner: normalizedOwner, $visitId: id }));
    },

    create(item) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("suggestion item is required");
      const normalizedOwner = owner(item.owner);
      const values = {
        $id: requiredText(item.id, "suggestion.id"),
        $schemaVersion: requiredText(item.schemaVersion, "suggestion.schemaVersion"),
        $owner: normalizedOwner,
        $visitId: requiredText(item.visitId, "suggestion.visitId"),
        $visitVersion: positiveVersion(item.visitVersion, "suggestion.visitVersion"),
        $customerId: requiredText(item.customerId, "suggestion.customerId"),
        $customerVersion: positiveVersion(item.customerVersion, "suggestion.customerVersion"),
        $previousValue: relation(item.previousValue, "suggestion.previousValue"),
        $suggestedValue: relation(item.suggestedValue, "suggestion.suggestedValue"),
        $delta: Number(item.delta),
        $confidence: relation(item.confidence, "suggestion.confidence"),
        $status: requiredText(item.status, "suggestion.status"),
        $identity: requiredText(item.identity, "suggestion.identity"),
        $visitEvidenceHash: requiredText(item.visitEvidenceHash, "suggestion.visitEvidenceHash"),
        $inputSnapshotHash: requiredText(item.inputSnapshotHash, "suggestion.inputSnapshotHash"),
        $factsJson: JSON.stringify(boundedArray(item.facts, "suggestion.facts")),
        $inferencesJson: JSON.stringify(boundedArray(item.inferences, "suggestion.inferences")),
        $sourceRefsJson: JSON.stringify(boundedArray(item.sourceRefs, "suggestion.sourceRefs")),
        $requiresHumanConfirmation: item.requiresHumanConfirmation === true ? 1 : 0,
        $writebackAllowed: item.writebackAllowed === true ? 1 : 0,
        $createdAt: requiredText(item.createdAt, "suggestion.createdAt"),
        $expiresAt: requiredText(item.expiresAt, "suggestion.expiresAt"),
      };
      try {
        db.prepare(`
          INSERT INTO visit_temperature_suggestions (
            id, schema_version, owner, visit_id, visit_version, customer_id, customer_version,
            previous_value, suggested_value, delta, confidence, status, identity,
            visit_evidence_hash, input_snapshot_hash, facts_json, inferences_json, source_refs_json,
            requires_human_confirmation, writeback_allowed, created_at, expires_at
          ) VALUES (
            $id, $schemaVersion, $owner, $visitId, $visitVersion, $customerId, $customerVersion,
            $previousValue, $suggestedValue, $delta, $confidence, $status, $identity,
            $visitEvidenceHash, $inputSnapshotHash, $factsJson, $inferencesJson, $sourceRefsJson,
            $requiresHumanConfirmation, $writebackAllowed, $createdAt, $expiresAt
          )
        `).run(values);
      } catch (error) {
        // A second request can win the owner/visit unique key between the
        // caller's find and insert. Return the durable winner as a replay.
        if (!String(error?.code ?? "").includes("SQLITE_CONSTRAINT")) throw error;
        const existing = suggestionRepository.findByVisit({ owner: normalizedOwner, visitId: values.$visitId });
        if (!existing) throw error;
        return { item: existing, replayed: true };
      }
      return {
        item: suggestionRepository.get({ owner: normalizedOwner, suggestionId: values.$id }),
        replayed: false,
      };
    },

    get({ owner: ownerValue, suggestionId } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(suggestionId, "suggestionId");
      return suggestionFromRow(db.prepare(`
        SELECT * FROM visit_temperature_suggestions
        WHERE owner = $owner AND id = $id
      `).get({ $owner: normalizedOwner, $id: id }));
    },

    list({ owner: ownerValue, customerId = null, limit = 20 } = {}) {
      const normalizedOwner = owner(ownerValue);
      const normalizedLimit = Number(limit);
      if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > MAX_HISTORY) {
        throw new TypeError(`limit must be an integer from 1 to ${MAX_HISTORY}`);
      }
      const normalizedCustomerId = customerId === null || customerId === undefined
        ? null
        : requiredText(customerId, "customerId");
      const rows = db.prepare(`
        SELECT * FROM visit_temperature_suggestions
        WHERE owner = $owner AND ($customerId IS NULL OR customer_id = $customerId)
        ORDER BY created_at DESC, id DESC
        LIMIT ${normalizedLimit + 1}
      `).all({ $owner: normalizedOwner, $customerId: normalizedCustomerId });
      return {
        items: rows.slice(0, normalizedLimit).map(suggestionFromRow),
        truncated: rows.length > normalizedLimit,
      };
    },

    markConfirmed({ owner: ownerValue, suggestionId, identity, confirmedAt, customerVersion, relation: confirmedRelation } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(suggestionId, "suggestionId");
      const normalizedIdentity = requiredText(identity, "identity");
      const version = positiveVersion(customerVersion, "customerVersion");
      const value = relation(confirmedRelation, "relation");
      const result = db.prepare(`
        UPDATE visit_temperature_suggestions
        SET status = 'confirmed',
            confirmed_at = $confirmedAt,
            confirmed_customer_version = $customerVersion,
            confirmed_relation = $relation
        WHERE owner = $owner AND id = $id AND identity = $identity AND status = 'pending'
      `).run({
        $confirmedAt: requiredText(confirmedAt, "confirmedAt"),
        $customerVersion: version,
        $relation: value,
        $owner: normalizedOwner,
        $id: id,
        $identity: normalizedIdentity,
      });
      if (Number(result.changes) !== 1) return null;
      return suggestionRepository.get({ owner: normalizedOwner, suggestionId: id });
    },

    markCancelled({ owner: ownerValue, suggestionId, identity, cancelledAt } = {}) {
      const normalizedOwner = owner(ownerValue);
      const id = requiredText(suggestionId, "suggestionId");
      const normalizedIdentity = requiredText(identity, "identity");
      const result = db.prepare(`
        UPDATE visit_temperature_suggestions
        SET status = 'cancelled', cancelled_at = $cancelledAt
        WHERE owner = $owner AND id = $id AND identity = $identity AND status = 'pending'
      `).run({
        $cancelledAt: requiredText(cancelledAt, "cancelledAt"),
        $owner: normalizedOwner,
        $id: id,
        $identity: normalizedIdentity,
      });
      if (Number(result.changes) !== 1) return null;
      return suggestionRepository.get({ owner: normalizedOwner, suggestionId: id });
    },
  });

  return Object.freeze({ visitRepository, customerRepository, suggestionRepository });
}

// Narrow aliases keep the persistence boundary convenient for callers that
// construct one repository at a time while the aggregate factory remains the
// preferred wiring API.
export function createVisitTemperatureSuggestionRepository(db, options) {
  return createVisitTemperatureSuggestionRepositories(db, options).suggestionRepository;
}

export function createConfirmedVisitRepository(db, options) {
  return createVisitTemperatureSuggestionRepositories(db, options).visitRepository;
}

export function createCustomerRelationRepository(db, options) {
  return createVisitTemperatureSuggestionRepositories(db, options).customerRepository;
}

export const createVisitTemperatureRepositories = createVisitTemperatureSuggestionRepositories;
