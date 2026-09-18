import { createHmac, timingSafeEqual } from "node:crypto";

import { openDatabase } from "../src/db.js";
import { DATABASE_IDENTITY_PATTERN } from "../src/db/databaseIdentity.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import { readProductionDatabaseIdentity } from "./production-smoke-cleanup.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MACHINE_ACTOR = "hospital-tender-monitor";
const MANIFEST_ARRAY_KEYS = Object.freeze([
  "customerIds",
  "importBatchIds",
  "importRowIds",
  "opportunityIds",
  "quickRecordIds",
  "solutionDraftIds",
  "actionIds",
  "riskIds",
  "noticeIds",
  "canonicalNoticeIds",
  "snapshotIds",
  "bridgeIds",
  "suggestionIds",
  "subjectIds",
  "confirmationPreviewIds",
  "notificationIds",
  "outboxIds",
  "auditIds",
]);
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "runId",
  "owner",
  "databaseIdentity",
  "sessionCookie",
  ...MANIFEST_ARRAY_KEYS,
  "idempotencyKeys",
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactText(value, label, max = 500) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be an exact bounded text value`);
  }
  return value;
}

function normalizeIdArray(value, label) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new TypeError(`${label} must be an array of at most 200 ids`);
  }
  const normalized = value.map((item) => exactText(item, `${label}[]`, 500));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} contains duplicate ids`);
  }
  return normalized;
}

function normalizeIdempotencyKeys(value, { runId, owner }) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new TypeError("idempotencyKeys must be an array of at most 200 entries");
  }
  const normalized = value.map((entry) => {
    if (!isPlainObject(entry)) throw new TypeError("idempotencyKeys entries must be objects");
    const keys = Object.keys(entry).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["actor", "key", "method", "requestPath"])) {
      throw new TypeError("idempotencyKeys entries contain unsupported fields");
    }
    const actor = exactText(entry.actor, "idempotencyKeys.actor", 200);
    const method = exactText(entry.method, "idempotencyKeys.method", 16).toUpperCase();
    const requestPath = exactText(entry.requestPath, "idempotencyKeys.requestPath", 500);
    const key = exactText(entry.key, "idempotencyKeys.key", 500);
    if (actor !== owner) throw new TypeError("idempotency key actor must match the acceptance owner");
    if (!["POST", "PATCH", "DELETE"].includes(method) || entry.method !== method) {
      throw new TypeError("idempotency key method must be an uppercase write method");
    }
    if (!requestPath.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(requestPath)) {
      throw new TypeError("idempotency key requestPath must be an exact API pathname");
    }
    if (!key.includes(runId)) throw new TypeError("idempotency key is not namespaced to the acceptance run");
    return { actor, method, requestPath, key };
  });
  const fingerprints = normalized.map((entry) => JSON.stringify([
    entry.actor,
    entry.method,
    entry.requestPath,
    entry.key,
  ]));
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new TypeError("idempotencyKeys contains duplicate composite keys");
  }
  return normalized;
}

export function normalizeV0120AcceptanceManifest(value) {
  if (!isPlainObject(value)) throw new TypeError("A v0.12.0 acceptance manifest is required");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...MANIFEST_KEYS].sort())) {
    throw new TypeError("The v0.12.0 acceptance manifest must contain its exact fields");
  }
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported v0.12.0 acceptance manifest version");
  const runId = exactText(value.runId, "runId", 100);
  if (!UUID_PATTERN.test(runId)) throw new TypeError("runId must be a UUID");
  const owner = exactText(value.owner, "owner", 200);
  const databaseIdentity = exactText(value.databaseIdentity, "databaseIdentity", 100);
  if (!DATABASE_IDENTITY_PATTERN.test(databaseIdentity)) throw new TypeError("databaseIdentity is invalid");
  const sessionCookie = exactText(value.sessionCookie, "sessionCookie", 100);
  if (!SESSION_COOKIE_PATTERN.test(sessionCookie)) throw new TypeError("sessionCookie is invalid");
  const arrays = Object.fromEntries(MANIFEST_ARRAY_KEYS.map((key) => [
    key,
    normalizeIdArray(value[key], key),
  ]));
  // This runner never creates these entities. Accepting arbitrary ids here
  // would bypass the ownership/marker validation used for the supported rows.
  if (arrays.quickRecordIds.length || arrays.solutionDraftIds.length) {
    throw new TypeError("Quick records and solution drafts are outside the acceptance write set");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId,
    owner,
    databaseIdentity,
    sessionCookie,
    ...arrays,
    idempotencyKeys: normalizeIdempotencyKeys(value.idempotencyKeys, { runId, owner }),
  });
}

function assertDatabaseIdentity({ databaseUrl, authSessionSecret, expectedIdentity }) {
  const current = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret });
  const actual = Buffer.from(current.databaseIdentity, "utf8");
  const expected = Buffer.from(expectedIdentity, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("The server-local database identity does not match the v0.12.0 acceptance manifest");
  }
  return current.databasePath;
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = $name",
  ).get({ $name: table }));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function rowsByIds(db, table, ids, label) {
  if (!tableExists(db, table)) throw new Error(`Required table is missing: ${table}`);
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `$id${index}`).join(", ");
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE id IN (${placeholders})`)
    .all(Object.fromEntries(ids.map((id, index) => [`$id${index}`, id])));
  if (rows.length !== ids.length) {
    throw new Error(`${label} manifest expected ${ids.length} rows but found ${rows.length}`);
  }
  const byId = new Set(rows.map((row) => String(row.id)));
  if (ids.some((id) => !byId.has(id))) throw new Error(`${label} manifest contains a missing row`);
  return rows;
}

function assertContainsMarker(row, marker, fields, label) {
  if (!fields.some((field) => String(row[field] ?? "").includes(marker))) {
    throw new Error(`${label} does not contain the exact acceptance marker`);
  }
}

function parseJson(value, fallback = null) {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(String(value ?? ""))) throw new Error(`${label} is not a SHA-256 digest`);
}

function sessionHash(secret, cookie) {
  return createHmac("sha256", secret)
    .update(`session-store:v1:${cookie}`)
    .digest("base64url");
}

function exactCount(db, table, ids) {
  if (ids.length === 0) return 0;
  const placeholders = ids.map((_, index) => `$id${index}`).join(", ");
  return Number(db.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE id IN (${placeholders})`,
  ).get(Object.fromEntries(ids.map((id, index) => [`$id${index}`, id]))).count);
}

function deleteByIds(db, table, ids) {
  if (ids.length === 0) return 0;
  const statement = db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE id = $id`);
  return ids.reduce((total, id) => total + Number(statement.run({ $id: id }).changes), 0);
}

function exactIdempotencyCount(db, entries) {
  const statement = db.prepare(`
    SELECT COUNT(*) AS count
      FROM idempotency_keys
     WHERE actor = $actor AND method = $method AND request_path = $requestPath AND key = $key
  `);
  return entries.reduce((total, entry) => total + Number(statement.get({
    $actor: entry.actor,
    $method: entry.method,
    $requestPath: entry.requestPath,
    $key: entry.key,
  }).count), 0);
}

function deleteIdempotencyKeys(db, entries) {
  const statement = db.prepare(`
    DELETE FROM idempotency_keys
     WHERE actor = $actor AND method = $method AND request_path = $requestPath AND key = $key
  `);
  return entries.reduce((total, entry) => total + Number(statement.run({
    $actor: entry.actor,
    $method: entry.method,
    $requestPath: entry.requestPath,
    $key: entry.key,
  }).changes), 0);
}

function foreignKeyReferences(db, parentTable, parentId) {
  const references = [];
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
     WHERE type = 'table'
     ORDER BY name
  `).all().filter(({ name }) => !String(name).startsWith("sqlite_"));
  for (const { name } of tables) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all();
    const matching = foreignKeys.filter((row) => row.table === parentTable);
    const groups = new Map();
    for (const row of matching) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    for (const group of groups.values()) {
      if (group.length !== 1 || group[0].to !== "id") {
        throw new Error(`Unsupported foreign-key relationship blocks cleanup for ${parentTable}`);
      }
      const column = group[0].from;
      const rows = db.prepare(`
        SELECT rowid AS __cleanup_rowid__, *
          FROM ${quoteIdentifier(name)}
         WHERE ${quoteIdentifier(column)} = $parentId
      `).all({ $parentId: parentId });
      for (const row of rows) references.push({ table: name, column, row });
    }
  }
  return references;
}

function assertNoUnrelatedForeignKeys(db, manifest) {
  const allowed = new Map([
    ["customers", new Set(manifest.customerIds)],
    ["opportunities", new Set(manifest.opportunityIds)],
    ["quick_records", new Set(manifest.quickRecordIds)],
    ["solution_drafts", new Set(manifest.solutionDraftIds)],
    ["action_items", new Set(manifest.actionIds)],
    ["risk_items", new Set(manifest.riskIds)],
    ["customer_import_batches", new Set(manifest.importBatchIds)],
    ["customer_import_rows", new Set(manifest.importRowIds)],
    ["hospital_tender_bridges", new Set(manifest.bridgeIds)],
    ["ai_suggestions", new Set(manifest.suggestionIds)],
    ["proactive_subjects", new Set(manifest.subjectIds)],
    ["proactive_notifications", new Set(manifest.notificationIds)],
    ["weixin_confirmation_outbox", new Set(manifest.outboxIds)],
  ]);
  const parents = [
    ["customers", manifest.customerIds],
    ["opportunities", manifest.opportunityIds],
    ["quick_records", manifest.quickRecordIds],
    ["action_items", manifest.actionIds],
    ["risk_items", manifest.riskIds],
    ["customer_import_batches", manifest.importBatchIds],
    ["ai_suggestions", manifest.suggestionIds],
    ["weixin_confirmation_outbox", manifest.outboxIds],
  ];
  for (const [parentTable, parentIds] of parents) {
    for (const parentId of parentIds) {
      for (const reference of foreignKeyReferences(db, parentTable, parentId)) {
        const allowedIds = allowed.get(reference.table);
        const referencedId = String(reference.row.id ?? "");
        if (!allowedIds || !allowedIds.has(referencedId)) {
          throw new Error(
            `Unrelated ${reference.table}.${reference.column} row refers to acceptance ${parentTable}.${parentId}`,
          );
        }
      }
    }
  }
}

function auditEntityPairs(manifest) {
  return [
    ["customer", manifest.customerIds],
    ["customer_import_batch", manifest.importBatchIds],
    ["customer_import_row", manifest.importRowIds],
    ["opportunity", manifest.opportunityIds],
    ["action", manifest.actionIds],
    ["risk", manifest.riskIds],
    ["hospital_tender_notice", manifest.noticeIds],
    ["proactive_assistant_suggestion", manifest.suggestionIds],
    ["proactive_confirmation_preview", manifest.confirmationPreviewIds],
    ["proactive_assistant_writeback", manifest.suggestionIds],
    ["hospital_tender_snapshot", manifest.snapshotIds],
  ].flatMap(([entityType, ids]) => ids.map((entityId) => ({ entityType, entityId })));
}

function auditRowsForManifestEntities(db, manifest) {
  const pairs = auditEntityPairs(manifest);
  if (pairs.length === 0) return [];
  const conditions = pairs.map((_, index) => `
    (entity_type = $entityType${index} AND entity_id = $entityId${index})
  `).join(" OR ");
  const params = {};
  pairs.forEach(({ entityType, entityId }, index) => {
    params[`$entityType${index}`] = entityType;
    params[`$entityId${index}`] = entityId;
  });
  return db.prepare(`
    SELECT id, entity_type, entity_id, actor
      FROM audit_logs
     WHERE ${conditions}
  `).all(params);
}

function validateBusinessRows(db, manifest) {
  const marker = `[v0.12:${manifest.runId}]`;
  const customers = rowsByIds(db, "customers", manifest.customerIds, "customer");
  for (const row of customers) {
    if (row.owner !== manifest.owner) throw new Error("Acceptance customer owner mismatch");
    assertContainsMarker(row, marker, ["name", "summary", "contact"], "Acceptance customer");
  }

  const batches = rowsByIds(db, "customer_import_batches", manifest.importBatchIds, "customer import batch");
  for (const row of batches) {
    if (row.owner !== manifest.owner) throw new Error("Acceptance import batch owner mismatch");
    assertContainsMarker(row, marker, ["file_name"], "Acceptance import batch");
  }
  const rows = rowsByIds(db, "customer_import_rows", manifest.importRowIds, "customer import row");
  const batchIds = new Set(manifest.importBatchIds);
  for (const row of rows) {
    if (row.owner !== manifest.owner || !batchIds.has(String(row.batch_id))) {
      throw new Error("Acceptance import row ownership mismatch");
    }
    if (row.customer_id && !manifest.customerIds.includes(String(row.customer_id))) {
      throw new Error("Acceptance import row references a customer outside the manifest");
    }
  }

  const customerIds = new Set(manifest.customerIds);
  const opportunities = rowsByIds(db, "opportunities", manifest.opportunityIds, "opportunity");
  for (const row of opportunities) {
    if (row.owner !== manifest.owner || !customerIds.has(String(row.customer_id))) {
      throw new Error("Acceptance opportunity ownership or relationship mismatch");
    }
    assertContainsMarker(row, marker, ["name", "source_record", "next"], "Acceptance opportunity");
  }
  const opportunityIds = new Set(manifest.opportunityIds);
  const suggestions = rowsByIds(db, "ai_suggestions", manifest.suggestionIds, "proactive suggestion");
  for (const row of suggestions) {
    if (
      row.owner !== manifest.owner
      || !customerIds.has(String(row.proactive_customer_id ?? ""))
      || !opportunityIds.has(String(row.proactive_opportunity_id ?? ""))
      || row.proactive_subject_key !== `customer:${manifest.owner}:${row.proactive_customer_id}`
    ) {
      throw new Error("Acceptance proactive suggestion ownership or relationship mismatch");
    }
    if (!String(row.content ?? "").includes(marker)) {
      throw new Error("Acceptance proactive suggestion content lost its marker");
    }
  }
  const subjectIds = new Set(manifest.subjectIds);
  const subjects = rowsByIds(db, "proactive_subjects", manifest.subjectIds, "proactive subject");
  for (const row of subjects) {
    if (
      row.owner !== manifest.owner
      || !customerIds.has(String(row.customer_id))
      || row.subject_key !== `customer:${manifest.owner}:${row.customer_id}`
    ) {
      throw new Error("Acceptance proactive subject ownership or relationship mismatch");
    }
  }

  const actions = rowsByIds(db, "action_items", manifest.actionIds, "action");
  const risks = rowsByIds(db, "risk_items", manifest.riskIds, "risk");
  for (const row of actions) {
    if (
      row.owner !== manifest.owner
      || !customerIds.has(String(row.customer_id))
      || !opportunityIds.has(String(row.opportunity_id))
      || (row.source_proactive_id && !new Set(manifest.suggestionIds).has(String(row.source_proactive_id)))
    ) {
      throw new Error("Acceptance action ownership or relationship mismatch");
    }
    assertContainsMarker(row, marker, ["title", "reason", "expected_result"], "Acceptance action");
  }
  for (const row of risks) {
    if (
      row.owner !== manifest.owner
      || !customerIds.has(String(row.customer_id))
      || !opportunityIds.has(String(row.opportunity_id))
      || (row.source_proactive_id && !new Set(manifest.suggestionIds).has(String(row.source_proactive_id)))
    ) {
      throw new Error("Acceptance risk ownership or relationship mismatch");
    }
    assertContainsMarker(row, marker, ["title", "target", "evidence", "action", "expected_result"], "Acceptance risk");
  }

  const notices = rowsByIds(db, "hospital_tender_notices", manifest.noticeIds, "hospital tender notice");
  const canonicalIds = new Set(manifest.canonicalNoticeIds);
  for (const row of notices) {
    if (!canonicalIds.has(String(row.canonical_notice_id))) throw new Error("Acceptance notice identity mismatch");
    assertContainsMarker(row, marker, ["id", "identity_key", "title", "content_text"], "Acceptance tender notice");
    assertDigest(row.canonical_digest, "Acceptance notice canonical digest");
    const matches = parseJson(row.match_customer_ids_json, []);
    if (!Array.isArray(matches) || matches.some((id) => !customerIds.has(String(id)))) {
      throw new Error("Acceptance notice matches an unrelated customer");
    }
  }
  const bridges = rowsByIds(db, "hospital_tender_bridges", manifest.bridgeIds, "hospital tender bridge");
  for (const row of bridges) {
    if (
      row.owner !== manifest.owner
      || !customerIds.has(String(row.customer_id))
      || !canonicalIds.has(String(row.canonical_notice_id))
    ) {
      throw new Error("Acceptance bridge ownership or relationship mismatch");
    }
    assertDigest(row.notice_digest, "Acceptance bridge notice digest");
    assertDigest(row.preview_digest, "Acceptance bridge preview digest");
    for (const [field, ids] of [["opportunity_id", manifest.opportunityIds], ["action_item_id", manifest.actionIds]]) {
      if (row[field] && !ids.includes(String(row[field]))) throw new Error("Acceptance bridge writeback is outside the manifest");
    }
  }

  const previews = rowsByIds(
    db,
    "proactive_confirmation_previews",
    manifest.confirmationPreviewIds,
    "proactive confirmation preview",
  );
  const suggestionIdSet = new Set(manifest.suggestionIds);
  for (const row of previews) {
    if (
      row.owner !== manifest.owner
      || !suggestionIdSet.has(String(row.suggestion_id))
      || !customerIds.has(String(row.customer_id))
      || !opportunityIds.has(String(row.opportunity_id))
    ) {
      throw new Error("Acceptance confirmation preview ownership or relationship mismatch");
    }
    assertDigest(row.preview_digest, "Acceptance confirmation preview digest");
  }

  const notifications = rowsByIds(db, "proactive_notifications", manifest.notificationIds, "proactive notification");
  for (const row of notifications) {
    if (
      row.owner !== manifest.owner
      || !suggestionIdSet.has(String(row.suggestion_id))
      || row.channel === "pushplus"
    ) {
      throw new Error("Acceptance notification ownership or channel mismatch");
    }
  }
  const outboxes = rowsByIds(db, "weixin_confirmation_outbox", manifest.outboxIds, "WeChat outbox");
  for (const row of outboxes) {
    if (row.owner !== manifest.owner) throw new Error("Acceptance outbox owner mismatch");
    const payload = parseJson(row.payload_json, null);
    if (!payload || !suggestionIdSet.has(String(payload.suggestionId ?? ""))) {
      throw new Error("Acceptance outbox is not bound to an acceptance suggestion");
    }
    if (row.status === "processing") throw new Error("Acceptance outbox must be drained before cleanup");
  }

  const allowedEntities = new Set([
    ...manifest.customerIds.map((id) => `customer:${id}`),
    ...manifest.importBatchIds.map((id) => `customer_import_batch:${id}`),
    ...manifest.importRowIds.map((id) => `customer_import_row:${id}`),
    ...manifest.opportunityIds.map((id) => `opportunity:${id}`),
    ...manifest.actionIds.map((id) => `action:${id}`),
    ...manifest.riskIds.map((id) => `risk:${id}`),
    ...manifest.noticeIds.map((id) => `hospital_tender_notice:${id}`),
    ...manifest.suggestionIds.map((id) => `proactive_assistant_suggestion:${id}`),
    ...manifest.confirmationPreviewIds.map((id) => `proactive_confirmation_preview:${id}`),
    ...manifest.suggestionIds.map((id) => `proactive_assistant_writeback:${id}`),
    ...manifest.snapshotIds.map((id) => `hospital_tender_snapshot:${id}`),
  ]);
  const audits = rowsByIds(db, "audit_logs", manifest.auditIds, "audit log");
  for (const row of audits) {
    const entity = `${row.entity_type}:${row.entity_id}`;
    if (!allowedEntities.has(entity) || ![manifest.owner, MACHINE_ACTOR].includes(row.actor)) {
      throw new Error("Acceptance audit manifest contains an unrelated row");
    }
  }

  const listedAuditIds = new Set(manifest.auditIds);
  for (const row of auditRowsForManifestEntities(db, manifest)) {
    if (!listedAuditIds.has(String(row.id))) {
      throw new Error(
        `Acceptance audit manifest is missing audit log ${row.entity_type}:${row.entity_id}`,
      );
    }
  }

  assertNoUnrelatedForeignKeys(db, manifest);
  return {
    customers,
    batches,
    rows,
    opportunities,
    suggestions,
    subjects,
    actions,
    risks,
    notices,
    bridges,
    previews,
    notifications,
    outboxes,
    audits,
    subjectIds,
  };
}

function residualCounts(db, manifest, tokenHash) {
  return {
    customers: exactCount(db, "customers", manifest.customerIds),
    quickRecords: exactCount(db, "quick_records", manifest.quickRecordIds),
    solutionDrafts: exactCount(db, "solution_drafts", manifest.solutionDraftIds),
    importBatches: exactCount(db, "customer_import_batches", manifest.importBatchIds),
    importRows: exactCount(db, "customer_import_rows", manifest.importRowIds),
    opportunities: exactCount(db, "opportunities", manifest.opportunityIds),
    actions: exactCount(db, "action_items", manifest.actionIds),
    risks: exactCount(db, "risk_items", manifest.riskIds),
    notices: exactCount(db, "hospital_tender_notices", manifest.noticeIds),
    bridges: exactCount(db, "hospital_tender_bridges", manifest.bridgeIds),
    suggestions: exactCount(db, "ai_suggestions", manifest.suggestionIds),
    subjects: exactCount(db, "proactive_subjects", manifest.subjectIds),
    confirmationPreviews: exactCount(db, "proactive_confirmation_previews", manifest.confirmationPreviewIds),
    notifications: exactCount(db, "proactive_notifications", manifest.notificationIds),
    outboxes: exactCount(db, "weixin_confirmation_outbox", manifest.outboxIds),
    audits: exactCount(db, "audit_logs", manifest.auditIds),
    authSessions: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = $tokenHash AND account = $owner",
    ).get({ $tokenHash: tokenHash, $owner: manifest.owner }).count),
    idempotencyKeys: exactIdempotencyCount(db, manifest.idempotencyKeys),
  };
}

function acceptanceAuxiliaryRows(db, manifest) {
  const sourceId = `v0120-${manifest.runId}-source`;
  const runId = `v0120-${manifest.runId}-run`;
  const sources = db.prepare("SELECT * FROM hospital_tender_sources WHERE source_id = $id").all({ $id: sourceId });
  const runs = db.prepare("SELECT * FROM hospital_tender_runs WHERE id = $id").all({ $id: runId });
  for (const row of [...sources, ...runs]) {
    if (row.source_id !== sourceId) throw new Error("Acceptance tender source/run identity mismatch");
    const timestamp = row.started_at ?? row.last_run_at;
    if (!manifest.snapshotIds.includes(timestamp)) throw new Error("Acceptance tender source/run snapshot mismatch");
  }
  for (const snapshot of manifest.snapshotIds) {
    const audits = db.prepare("SELECT id, actor FROM audit_logs WHERE entity_type = 'hospital_tender_snapshot' AND entity_id = $id")
      .all({ $id: snapshot });
    if (audits.length !== 1 || ![MACHINE_ACTOR, manifest.owner].includes(audits[0].actor) || !manifest.auditIds.includes(String(audits[0].id))) {
      throw new Error("Acceptance snapshot audit identity is missing or ambiguous");
    }
  }
  const events = [];
  for (const [type, ids] of [
    ["customer", manifest.customerIds], ["opportunity", manifest.opportunityIds],
    ["action", manifest.actionIds], ["risk", manifest.riskIds], ["hospital_tender", manifest.snapshotIds],
  ]) {
    for (const id of ids) {
      const rows = db.prepare("SELECT * FROM proactive_scan_events WHERE entity_type = $type AND entity_id = $id")
        .all({ $type: type, $id: id });
      for (const row of rows) {
        if (row.owner !== manifest.owner || row.status === "processing") throw new Error("Acceptance event owner mismatch or worker has not drained");
        const payload = parseJson(row.payload_json, {});
        if (type === "hospital_tender" && (!Array.isArray(payload.customerIds)
          || payload.customerIds.some((customerId) => !manifest.customerIds.includes(customerId)))) {
          throw new Error("Acceptance tender event includes unrelated customers");
        }
        events.push(String(row.id));
      }
    }
  }
  return { sourceId, sources, runs, eventIds: [...new Set(events)] };
}

function auxiliaryCounts(db, auxiliary) {
  return {
    tenderSources: Number(db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_sources WHERE source_id = $id").get({ $id: auxiliary.sourceId }).count),
    tenderRuns: exactCount(db, "hospital_tender_runs", auxiliary.runs.map((row) => row.id)),
    scanEvents: exactCount(db, "proactive_scan_events", auxiliary.eventIds),
  };
}

function integrity(db) {
  const quickRows = db.prepare("PRAGMA quick_check").all();
  const quickCheck = quickRows.length === 1 ? String(quickRows[0].quick_check) : "failed";
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  if (quickCheck !== "ok" || foreignKeyViolations !== 0) {
    throw new Error(`Database integrity failed after v0.12.0 cleanup: ${quickCheck}`);
  }
  return { quickCheck, foreignKeyViolations };
}

export function cleanupV0120ProductionAcceptance({
  databaseUrl,
  authSessionSecret,
  manifest: manifestValue,
} = {}) {
  const manifest = normalizeV0120AcceptanceManifest(manifestValue);
  const databasePath = assertDatabaseIdentity({
    databaseUrl,
    authSessionSecret,
    expectedIdentity: manifest.databaseIdentity,
  });
  const db = openDatabase({ databaseUrl: databasePath });
  try {
    return withImmediateTransaction(db, () => {
      const tokenHash = sessionHash(authSessionSecret, manifest.sessionCookie);
      validateBusinessRows(db, manifest);
      const auxiliary = acceptanceAuxiliaryRows(db, manifest);
      const discovered = { ...residualCounts(db, manifest, tokenHash), ...auxiliaryCounts(db, auxiliary) };

      const deleted = {
        scanEvents: deleteByIds(db, "proactive_scan_events", auxiliary.eventIds),
        tenderRuns: deleteByIds(db, "hospital_tender_runs", auxiliary.runs.map((row) => row.id)),
        tenderSources: Number(db.prepare("DELETE FROM hospital_tender_sources WHERE source_id = $id").run({ $id: auxiliary.sourceId }).changes),
        audits: deleteByIds(db, "audit_logs", manifest.auditIds),
        notifications: deleteByIds(db, "proactive_notifications", manifest.notificationIds),
        outboxes: deleteByIds(db, "weixin_confirmation_outbox", manifest.outboxIds),
        confirmationPreviews: deleteByIds(db, "proactive_confirmation_previews", manifest.confirmationPreviewIds),
        actions: deleteByIds(db, "action_items", manifest.actionIds),
        risks: deleteByIds(db, "risk_items", manifest.riskIds),
        bridges: deleteByIds(db, "hospital_tender_bridges", manifest.bridgeIds),
        notices: deleteByIds(db, "hospital_tender_notices", manifest.noticeIds),
        suggestions: deleteByIds(db, "ai_suggestions", manifest.suggestionIds),
        subjects: deleteByIds(db, "proactive_subjects", manifest.subjectIds),
        importRows: deleteByIds(db, "customer_import_rows", manifest.importRowIds),
        importBatches: deleteByIds(db, "customer_import_batches", manifest.importBatchIds),
        opportunities: deleteByIds(db, "opportunities", manifest.opportunityIds),
        customers: deleteByIds(db, "customers", manifest.customerIds),
        quickRecords: deleteByIds(db, "quick_records", manifest.quickRecordIds),
        solutionDrafts: deleteByIds(db, "solution_drafts", manifest.solutionDraftIds),
        authSessions: Number(db.prepare(
          "DELETE FROM auth_sessions WHERE token_hash = $tokenHash AND account = $owner",
        ).run({ $tokenHash: tokenHash, $owner: manifest.owner }).changes),
        idempotencyKeys: deleteIdempotencyKeys(db, manifest.idempotencyKeys),
      };
      const residual = { ...residualCounts(db, manifest, tokenHash), ...auxiliaryCounts(db, auxiliary) };
      if (Object.values(residual).some((count) => count !== 0)) {
        throw new Error(`v0.12.0 cleanup left residual rows: ${JSON.stringify(residual)}`);
      }
      return {
        status: "clean",
        runId: manifest.runId,
        databaseIdentity: manifest.databaseIdentity,
        discovered,
        deleted,
        residual,
        integrity: integrity(db),
      };
    });
  } finally {
    db.close();
  }
}
