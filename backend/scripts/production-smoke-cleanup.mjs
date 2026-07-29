import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";

import { openDatabase, resolveDatabasePath } from "../src/db.js";
import {
  DATABASE_IDENTITY_PATTERN,
  createDatabaseIdentity,
} from "../src/db/databaseIdentity.js";
import { withImmediateTransaction } from "../src/db/transaction.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREATED_ID_KEYS = Object.freeze([
  "customers",
  "opportunities",
  "quickRecords",
  "aiInsights",
  "salesDecisions",
  "itineraries",
  "weeklyReports",
  "auditLogs",
]);

function assertInputs({
  databaseUrl,
  runId,
  account,
  sessionCookie,
  authSessionSecret,
  expectedDatabaseIdentity,
}) {
  if (!UUID_PATTERN.test(String(runId ?? ""))) {
    throw new TypeError("A valid smoke runId UUID is required");
  }
  if (typeof account !== "string" || !account.trim()) {
    throw new TypeError("A smoke account is required");
  }
  if (!SESSION_COOKIE_PATTERN.test(String(sessionCookie ?? ""))) {
    throw new TypeError("A valid smoke session cookie is required");
  }
  if (!DATABASE_IDENTITY_PATTERN.test(String(expectedDatabaseIdentity ?? ""))) {
    throw new TypeError("A valid production database identity is required");
  }
  const { databasePath, databaseIdentity } = readProductionDatabaseIdentity({
    databaseUrl,
    authSessionSecret,
  });
  if (!timingSafeEqual(
    Buffer.from(databaseIdentity, "utf8"),
    Buffer.from(expectedDatabaseIdentity, "utf8"),
  )) {
    throw new Error("The server-local database identity does not match the public backend");
  }
  return { databasePath, databaseIdentity };
}

export function readProductionDatabaseIdentity({ databaseUrl, authSessionSecret } = {}) {
  if (typeof authSessionSecret !== "string" || authSessionSecret.length < 32) {
    throw new TypeError("The authentication session secret must contain at least 32 characters");
  }
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    throw new Error("The existing file-backed production database is required");
  }
  return {
    databasePath,
    databaseIdentity: createDatabaseIdentity({
      databaseUrl: databasePath,
      secret: authSessionSecret,
    }),
  };
}

function sessionHash(secret, cookie) {
  return createHmac("sha256", secret)
    .update(`session-store:v1:${cookie}`)
    .digest("base64url");
}

function normalizeCreatedIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("An exact created id manifest is required");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...CREATED_ID_KEYS].sort())) {
    throw new TypeError("The created id manifest must contain exactly the supported resource keys");
  }

  return Object.fromEntries(CREATED_ID_KEYS.map((key) => {
    const values = value[key];
    if (!Array.isArray(values) || values.length > 20) {
      throw new TypeError(`The created id manifest ${key} entry must be an array of at most 20 ids`);
    }
    const normalized = values.map((id) => {
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > 200 ||
        id.trim() !== id ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(id)
      ) {
        throw new TypeError(`The created id manifest ${key} entry contains an invalid id`);
      }
      return id;
    });
    if (new Set(normalized).size !== normalized.length) {
      throw new TypeError(`The created id manifest ${key} entry contains duplicate ids`);
    }
    return [key, normalized];
  }));
}

function normalizeIdempotencyKeys(value, { runId, account }) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError("The exact idempotency key manifest must be an array of at most 50 entries");
  }
  const expectedKeys = ["actor", "key", "method", "requestPath"];
  const normalized = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)
    ) {
      throw new TypeError("Each idempotency key manifest entry must contain its exact composite key");
    }
    const method = String(entry.method ?? "").toUpperCase();
    if (entry.actor !== account.trim()) {
      throw new TypeError("The idempotency key actor must match the smoke account");
    }
    if (!["POST", "PATCH", "DELETE"].includes(method) || entry.method !== method) {
      throw new TypeError("The idempotency key method must be an uppercase write method");
    }
    if (
      typeof entry.requestPath !== "string" ||
      !entry.requestPath.startsWith("/api/") ||
      entry.requestPath.length > 500 ||
      /[?#\u0000-\u001f\u007f-\u009f]/u.test(entry.requestPath)
    ) {
      throw new TypeError("The idempotency request path must be an exact API pathname");
    }
    const keyPrefix = `smoke:${runId}:`;
    if (
      typeof entry.key !== "string" ||
      !entry.key.startsWith(keyPrefix) ||
      entry.key.length <= keyPrefix.length ||
      entry.key.length > 200 ||
      /[\u0000-\u001f\u007f-\u009f,]/u.test(entry.key)
    ) {
      throw new TypeError("The idempotency key must be namespaced to the exact smoke runId");
    }
    return { actor: entry.actor, method, requestPath: entry.requestPath, key: entry.key };
  });
  const fingerprints = normalized.map((entry) =>
    JSON.stringify([entry.actor, entry.method, entry.requestPath, entry.key])
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new TypeError("The idempotency key manifest contains duplicate composite keys");
  }
  return normalized;
}

function ids(db, sql, params) {
  return db.prepare(sql).all(params).map((row) => String(row.id));
}

function inClause(values, prefix) {
  const params = {};
  const placeholders = values.map((value, index) => {
    const name = `$${prefix}${index}`;
    params[name] = value;
    return name;
  });
  return { sql: placeholders.join(", "), params };
}

function countByIds(db, table, column, values) {
  if (values.length === 0) return 0;
  const clause = inClause(values, "countId");
  return Number(db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${clause.sql})`,
  ).get(clause.params).count);
}

function deleteByIds(db, table, column, values) {
  if (values.length === 0) return 0;
  const clause = inClause(values, "deleteId");
  return Number(db.prepare(
    `DELETE FROM ${table} WHERE ${column} IN (${clause.sql})`,
  ).run(clause.params).changes);
}

function rowsByIds(db, table, values, prefix) {
  if (values.length === 0) return [];
  const clause = inClause(values, prefix);
  return db.prepare(`SELECT * FROM ${table} WHERE id IN (${clause.sql})`).all(clause.params);
}

function containsMarker(row, fields, marker) {
  return fields.some((field) => String(row[field] ?? "").includes(marker));
}

function discoverSmokeOwnedIds(db, owned, { marker, runLabel, account }) {
  const discovered = Object.fromEntries(
    CREATED_ID_KEYS.map((key) => [key, new Set(owned[key])]),
  );
  const addMatching = (key, rows, predicate) => {
    for (const row of rows) {
      if (predicate(row)) discovered[key].add(String(row.id));
    }
  };

  addMatching(
    "customers",
    db.prepare("SELECT id, name, owner, contact, summary FROM customers").all(),
    (row) => row.owner === account && containsMarker(row, ["name", "contact", "summary"], marker),
  );
  addMatching(
    "opportunities",
    db.prepare(`
      SELECT id, customer_id, name, owner, risk, next, source_record
      FROM opportunities
    `).all(),
    (row) =>
      row.owner === account
      && discovered.customers.has(String(row.customer_id ?? ""))
      && containsMarker(row, ["name", "risk", "next", "source_record"], marker),
  );
  addMatching(
    "quickRecords",
    db.prepare(`
      SELECT id, customer_id, opportunity_id, raw_content, source_channel
      FROM quick_records
    `).all(),
    (row) =>
      containsMarker(row, ["raw_content", "source_channel"], marker)
      && (!row.customer_id || discovered.customers.has(String(row.customer_id)))
      && (!row.opportunity_id || discovered.opportunities.has(String(row.opportunity_id))),
  );
  addMatching(
    "aiInsights",
    db.prepare("SELECT id, quick_record_id, analysis_json FROM ai_insights").all(),
    (row) =>
      discovered.quickRecords.has(String(row.quick_record_id ?? ""))
      || containsMarker(row, ["analysis_json"], marker),
  );
  addMatching(
    "salesDecisions",
    db.prepare(`
      SELECT id, customer_id, opportunity_id, quick_record_id, input_json, analysis_json, created_by
      FROM sales_decision_analyses
    `).all(),
    (row) =>
      row.created_by === account
      && (
        discovered.customers.has(String(row.customer_id ?? ""))
        || discovered.opportunities.has(String(row.opportunity_id ?? ""))
        || discovered.quickRecords.has(String(row.quick_record_id ?? ""))
        || containsMarker(row, ["input_json", "analysis_json"], marker)
      ),
  );
  addMatching(
    "itineraries",
    db.prepare(`
      SELECT id, title, request_json, plan_json, created_by
      FROM visit_itineraries
    `).all(),
    (row) =>
      row.created_by === account
      && containsMarker(row, ["title", "request_json", "plan_json"], marker),
  );
  addMatching(
    "weeklyReports",
    db.prepare("SELECT id, owner, content, source_refs FROM weekly_reports").all(),
    (row) => row.owner === runLabel || containsMarker(row, ["content", "source_refs"], marker),
  );

  const auditTargets = new Set([
    ...[...discovered.customers].map((id) => JSON.stringify(["customer", id])),
    ...[...discovered.opportunities].map((id) => JSON.stringify(["opportunity", id])),
    ...[...discovered.quickRecords].map((id) => JSON.stringify(["quick_record", id])),
    ...[...discovered.salesDecisions].map((id) => JSON.stringify(["sales_decision_analysis", id])),
    ...[...discovered.itineraries].map((id) => JSON.stringify(["visit_itinerary", id])),
    ...[...discovered.weeklyReports].map((id) => JSON.stringify(["weekly_report", id])),
  ]);
  addMatching(
    "auditLogs",
    db.prepare("SELECT id, entity_type, entity_id, actor FROM audit_logs").all(),
    (row) =>
      row.actor === account
      && auditTargets.has(JSON.stringify([row.entity_type, String(row.entity_id ?? "")])),
  );

  return Object.fromEntries(
    CREATED_ID_KEYS.map((key) => [key, [...discovered[key]]]),
  );
}

function assertRowsOwned(rows, predicate, label, expectedCount) {
  if (rows.length !== expectedCount) {
    throw new Error(`${label} manifest expected ${expectedCount} rows but discovered ${rows.length}`);
  }
  if (rows.some((row) => !predicate(row))) {
    throw new Error(`${label} ownership does not match the exact smoke run marker`);
  }
}

function assertManifestOwnership(db, owned, { marker, runLabel, account }) {
  const customerIds = new Set(owned.customers);
  const opportunityIds = new Set(owned.opportunities);
  const quickRecordIds = new Set(owned.quickRecords);
  const auditTargets = new Set([
    ...owned.customers.map((id) => JSON.stringify(["customer", id])),
    ...owned.opportunities.map((id) => JSON.stringify(["opportunity", id])),
    ...owned.quickRecords.map((id) => JSON.stringify(["quick_record", id])),
    ...owned.salesDecisions.map((id) => JSON.stringify(["sales_decision_analysis", id])),
    ...owned.itineraries.map((id) => JSON.stringify(["visit_itinerary", id])),
    ...owned.weeklyReports.map((id) => JSON.stringify(["weekly_report", id])),
  ]);

  assertRowsOwned(
    rowsByIds(db, "customers", owned.customers, "ownedCustomer"),
    (row) => containsMarker(row, ["name", "contact", "summary"], marker),
    "Customer",
    owned.customers.length,
  );
  assertRowsOwned(
    rowsByIds(db, "opportunities", owned.opportunities, "ownedOpportunity"),
    (row) =>
      customerIds.has(String(row.customer_id ?? "")) &&
      containsMarker(row, ["name", "risk", "next", "source_record"], marker),
    "Opportunity",
    owned.opportunities.length,
  );
  assertRowsOwned(
    rowsByIds(db, "quick_records", owned.quickRecords, "ownedQuickRecord"),
    (row) =>
      (!row.customer_id || customerIds.has(String(row.customer_id))) &&
      (!row.opportunity_id || opportunityIds.has(String(row.opportunity_id))) &&
      containsMarker(row, ["raw_content", "source_channel"], marker),
    "Quick record",
    owned.quickRecords.length,
  );
  assertRowsOwned(
    rowsByIds(db, "ai_insights", owned.aiInsights, "ownedInsight"),
    (row) =>
      quickRecordIds.has(String(row.quick_record_id ?? "")) ||
      containsMarker(row, ["analysis_json"], marker),
    "AI insight",
    owned.aiInsights.length,
  );
  assertRowsOwned(
    rowsByIds(db, "sales_decision_analyses", owned.salesDecisions, "ownedDecision"),
    (row) =>
      customerIds.has(String(row.customer_id ?? "")) ||
      opportunityIds.has(String(row.opportunity_id ?? "")) ||
      quickRecordIds.has(String(row.quick_record_id ?? "")) ||
      containsMarker(row, ["input_json", "analysis_json"], marker),
    "Sales decision",
    owned.salesDecisions.length,
  );
  assertRowsOwned(
    rowsByIds(db, "visit_itineraries", owned.itineraries, "ownedItinerary"),
    (row) => containsMarker(row, ["title", "request_json", "plan_json"], marker),
    "Itinerary",
    owned.itineraries.length,
  );
  assertRowsOwned(
    rowsByIds(db, "weekly_reports", owned.weeklyReports, "ownedWeekly"),
    (row) =>
      row.owner === runLabel ||
      containsMarker(row, ["content", "source_refs"], marker),
    "Weekly report",
    owned.weeklyReports.length,
  );
  assertRowsOwned(
    rowsByIds(db, "audit_logs", owned.auditLogs, "ownedAudit"),
    (row) =>
      row.actor === account &&
      auditTargets.has(JSON.stringify([row.entity_type, String(row.entity_id ?? "")])),
    "Audit log",
    owned.auditLogs.length,
  );
}

function exactIdempotencyParams(entry) {
  return {
    $actor: entry.actor,
    $method: entry.method,
    $requestPath: entry.requestPath,
    $key: entry.key,
  };
}

function deleteIdempotencyKeys(db, entries) {
  const statement = db.prepare(`
    DELETE FROM idempotency_keys
    WHERE actor = $actor
      AND method = $method
      AND request_path = $requestPath
      AND key = $key
  `);
  return entries.reduce(
    (total, entry) => total + Number(statement.run(exactIdempotencyParams(entry)).changes),
    0,
  );
}

function countIdempotencyKeys(db, entries) {
  const statement = db.prepare(`
    SELECT COUNT(*) AS count FROM idempotency_keys
    WHERE actor = $actor
      AND method = $method
      AND request_path = $requestPath
      AND key = $key
  `);
  return entries.reduce(
    (total, entry) => total + Number(statement.get(exactIdempotencyParams(entry)).count),
    0,
  );
}

function assertNoUnrelatedDependents(db, owned) {
  const customerClause = inClause(owned.customers, "customer");
  const opportunityClause = inClause(owned.opportunities, "opportunity");
  const quickRecordClause = inClause(owned.quickRecords, "quick");

  if (owned.customers.length > 0) {
    const opportunityIds = new Set(owned.opportunities);
    const dependents = ids(
      db,
      `SELECT id FROM opportunities WHERE customer_id IN (${customerClause.sql})`,
      customerClause.params,
    ).filter((id) => !opportunityIds.has(id));
    if (dependents.length > 0) {
      throw new Error("Unrelated opportunity depends on a smoke customer");
    }
  }

  if (owned.customers.length > 0 || owned.opportunities.length > 0) {
    const conditions = [];
    const params = {};
    if (owned.customers.length > 0) {
      conditions.push(`customer_id IN (${customerClause.sql})`);
      Object.assign(params, customerClause.params);
    }
    if (owned.opportunities.length > 0) {
      conditions.push(`opportunity_id IN (${opportunityClause.sql})`);
      Object.assign(params, opportunityClause.params);
    }

    const quickRecordIds = new Set(owned.quickRecords);
    const unrelatedQuickRecords = ids(
      db,
      `SELECT id FROM quick_records WHERE ${conditions.join(" OR ")}`,
      params,
    ).filter((id) => !quickRecordIds.has(id));
    if (unrelatedQuickRecords.length > 0) {
      throw new Error("Unrelated quick record depends on smoke customer or opportunity data");
    }

    for (const table of ["solution_drafts", "action_items", "risk_items"]) {
      const count = Number(db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${conditions.join(" OR ")}`,
      ).get(params).count);
      if (count > 0) {
        throw new Error(`Unrelated dependent ${table} data refers to smoke rows`);
      }
    }
  }

  if (owned.quickRecords.length > 0) {
    for (const [table, column] of [
      ["manual_confirmations", "quick_record_id"],
      ["action_items", "source_record_id"],
    ]) {
      const count = Number(db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${quickRecordClause.sql})`,
      ).get(quickRecordClause.params).count);
      if (count > 0) {
        throw new Error(`Unrelated dependent ${table} data refers to smoke quick records`);
      }
    }
    const riskCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM risk_items
      WHERE source_type = 'quick_record'
        AND source_id IN (${quickRecordClause.sql})
    `).get(quickRecordClause.params).count);
    if (riskCount > 0) {
      throw new Error("Unrelated dependent risk data refers to smoke quick records");
    }
  }
}

function residualCounts(db, tokenHash, owned, idempotencyKeys) {
  return {
    customers: countByIds(db, "customers", "id", owned.customers),
    opportunities: countByIds(db, "opportunities", "id", owned.opportunities),
    quickRecords: countByIds(db, "quick_records", "id", owned.quickRecords),
    aiInsights: countByIds(db, "ai_insights", "id", owned.aiInsights),
    salesDecisions: countByIds(db, "sales_decision_analyses", "id", owned.salesDecisions),
    itineraries: countByIds(db, "visit_itineraries", "id", owned.itineraries),
    weeklyReports: countByIds(db, "weekly_reports", "id", owned.weeklyReports),
    auditLogs: countByIds(db, "audit_logs", "id", owned.auditLogs),
    authSessions: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = $tokenHash",
    ).get({ $tokenHash: tokenHash }).count),
    idempotencyKeys: countIdempotencyKeys(db, idempotencyKeys),
  };
}

function assertDiscoveredMatchesManifest(discovered, owned) {
  for (const key of CREATED_ID_KEYS) {
    if (discovered[key] !== owned[key].length) {
      throw new Error(
        `${key} manifest expected ${owned[key].length} rows but discovered ${discovered[key]}`,
      );
    }
  }
  if (discovered.authSessions !== 1) {
    throw new Error(`Smoke session manifest expected 1 row but discovered ${discovered.authSessions}`);
  }
}

export function cleanupProductionSmokeRun({
  databaseUrl,
  runId,
  account,
  sessionCookie,
  authSessionSecret,
  expectedDatabaseIdentity,
  createdIds,
  idempotencyKeys,
} = {}) {
  const { databasePath, databaseIdentity } = assertInputs({
    databaseUrl,
    runId,
    account,
    sessionCookie,
    authSessionSecret,
    expectedDatabaseIdentity,
  });
  const manifestOwned = normalizeCreatedIds(createdIds);
  const exactIdempotencyKeys = normalizeIdempotencyKeys(idempotencyKeys, { runId, account });
  const marker = `[smoke:${runId}]`;
  const runLabel = `smoke:${runId}`;
  const tokenHash = sessionHash(authSessionSecret, sessionCookie);
  const db = openDatabase({ databaseUrl: databasePath });

  try {
    return withImmediateTransaction(db, () => {
      const owned = discoverSmokeOwnedIds(db, manifestOwned, {
        marker,
        runLabel,
        account: account.trim(),
      });
      assertManifestOwnership(db, owned, {
        marker,
        runLabel,
        account: account.trim(),
      });
      assertNoUnrelatedDependents(db, owned);
      const discovered = residualCounts(db, tokenHash, owned, exactIdempotencyKeys);
      assertDiscoveredMatchesManifest(discovered, owned);

      const deleted = {
        auditLogs: deleteByIds(db, "audit_logs", "id", owned.auditLogs),
        salesDecisions: deleteByIds(db, "sales_decision_analyses", "id", owned.salesDecisions),
        aiInsights: deleteByIds(db, "ai_insights", "id", owned.aiInsights),
        quickRecords: deleteByIds(db, "quick_records", "id", owned.quickRecords),
        itineraries: deleteByIds(db, "visit_itineraries", "id", owned.itineraries),
        weeklyReports: deleteByIds(db, "weekly_reports", "id", owned.weeklyReports),
        opportunities: deleteByIds(db, "opportunities", "id", owned.opportunities),
        customers: deleteByIds(db, "customers", "id", owned.customers),
        authSessions: Number(db.prepare(
          "DELETE FROM auth_sessions WHERE token_hash = $tokenHash AND account = $account",
        ).run({ $tokenHash: tokenHash, $account: account.trim() }).changes),
        idempotencyKeys: deleteIdempotencyKeys(db, exactIdempotencyKeys),
      };

      const residual = residualCounts(db, tokenHash, owned, exactIdempotencyKeys);
      if (Object.values(residual).some((count) => count !== 0)) {
        throw new Error(`Smoke cleanup left residual data: ${JSON.stringify(residual)}`);
      }

      const quickCheckRows = db.prepare("PRAGMA quick_check").all();
      const quickCheck = quickCheckRows.length === 1
        ? String(quickCheckRows[0].quick_check)
        : JSON.stringify(quickCheckRows);
      const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
      if (quickCheck !== "ok" || foreignKeyViolations !== 0) {
        throw new Error(`Database integrity failed after cleanup: ${quickCheck}`);
      }

      return {
        status: "clean",
        runId,
        databaseIdentity,
        databasePath,
        discovered,
        deleted,
        residual,
        integrity: { quickCheck, foreignKeyViolations },
      };
    });
  } finally {
    db.close();
  }
}
