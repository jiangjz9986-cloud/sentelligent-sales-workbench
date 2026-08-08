import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/db.js";
import { DATABASE_IDENTITY_PATTERN } from "../src/db/databaseIdentity.js";
import { withImmediateTransaction } from "../src/db/transaction.js";
import { readProductionDatabaseIdentity } from "./production-smoke-cleanup.mjs";

const ACCEPTANCE_SOURCE_ID_PATTERN = /^ACCEPTANCE-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_MANIFEST_KEYS = Object.freeze([
  "database_identity",
  "ingestion_id",
  "owner",
  "source_id",
]);
const OPTIONAL_MANIFEST_KEYS = Object.freeze(["expense_id", "payment_id"]);
const EXPECTED_AUDIT_ACTIONS = Object.freeze({
  accepted: Object.freeze([
    "travel_expense.ingestion.accept",
    "travel_expense.ingestion.receive",
  ]),
  review_required: Object.freeze([
    "travel_expense.ingestion.receive",
    "travel_expense.ingestion.review_required",
  ]),
});

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactText(value, label, max = 200) {
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

function optionalExactId(value, label) {
  if (value === undefined || value === null) return null;
  return exactText(value, label);
}

function normalizeManifest(value) {
  if (!isPlainObject(value)) throw new TypeError("An exact iCost acceptance manifest is required");
  const keys = Object.keys(value).sort();
  const allowedKeys = new Set([...REQUIRED_MANIFEST_KEYS, ...OPTIONAL_MANIFEST_KEYS]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new TypeError("The iCost acceptance manifest contains an unsupported field");
  }
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError("The iCost acceptance manifest is incomplete");
    }
  }

  const owner = exactText(value.owner, "manifest.owner");
  const sourceId = exactText(value.source_id, "manifest.source_id");
  if (!ACCEPTANCE_SOURCE_ID_PATTERN.test(sourceId)) {
    throw new TypeError("manifest.source_id must be an ACCEPTANCE UUID");
  }
  const ingestionId = exactText(value.ingestion_id, "manifest.ingestion_id");
  const expenseId = optionalExactId(value.expense_id, "manifest.expense_id");
  const paymentId = optionalExactId(value.payment_id, "manifest.payment_id");
  if ((expenseId === null) !== (paymentId === null)) {
    throw new TypeError("manifest.expense_id and manifest.payment_id must be supplied together");
  }
  const databaseIdentity = exactText(value.database_identity, "manifest.database_identity", 100);
  if (!DATABASE_IDENTITY_PATTERN.test(databaseIdentity)) {
    throw new TypeError("manifest.database_identity is invalid");
  }
  return {
    owner,
    sourceId,
    ingestionId,
    expenseId,
    paymentId,
    databaseIdentity,
  };
}

function assertDatabaseIdentity({ databaseUrl, authSessionSecret, expectedIdentity }) {
  const current = readProductionDatabaseIdentity({ databaseUrl, authSessionSecret });
  const actualBuffer = Buffer.from(current.databaseIdentity, "utf8");
  const expectedBuffer = Buffer.from(expectedIdentity, "utf8");
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("The server-local database identity does not match the acceptance manifest");
  }
  return current.databasePath;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function allForeignKeyReferences(db, parentTable, parentId) {
  const references = [];
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
    ORDER BY name
  `).all().filter(({ name }) => !name.startsWith("sqlite_"));

  for (const { name } of tables) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all();
    const matching = foreignKeys.filter((row) => row.table === parentTable);
    const groups = new Map();
    for (const row of matching) {
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    for (const group of groups.values()) {
      if (group.length !== 1 || group[0].to !== "id") {
        throw new Error("An unsupported foreign-key relationship blocks iCost acceptance cleanup");
      }
      const column = group[0].from;
      const rows = db.prepare(`
        SELECT rowid AS __cleanup_rowid__, *
        FROM ${quoteIdentifier(name)}
        WHERE ${quoteIdentifier(column)} = $parentId
      `).all({ $parentId: parentId });
      for (const row of rows) {
        references.push({ table: name, column, row });
      }
    }
  }
  return references;
}

function assertAllowedReference(reference, allowed) {
  return allowed.some((entry) => (
    reference.table === entry.table
    && reference.column === entry.column
    && String(reference.row.id ?? "") === entry.id
  ));
}

function assertNoUnrelatedFinancialDependents(db, { ingestionId, expenseId, paymentId }) {
  if (!expenseId) return;
  const expenseReferences = allForeignKeyReferences(db, "travel_expenses", expenseId);
  const allowedExpenseReferences = [
    { table: "travel_expense_ingestions", column: "expense_id", id: ingestionId },
    { table: "travel_expense_payments", column: "expense_id", id: paymentId },
  ];
  if (expenseReferences.some((reference) => !assertAllowedReference(reference, allowedExpenseReferences))) {
    throw new Error("An unrelated dependent business record refers to the manifested expense");
  }

  const paymentReferences = allForeignKeyReferences(db, "travel_expense_payments", paymentId);
  const allowedPaymentReferences = [
    { table: "travel_expense_ingestions", column: "payment_id", id: ingestionId },
  ];
  if (paymentReferences.some((reference) => !assertAllowedReference(reference, allowedPaymentReferences))) {
    throw new Error("An unrelated dependent business record refers to the manifested payment");
  }
}

function parseObjectJson(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exactAuditRows(db, ingestion, manifest) {
  const rows = db.prepare(`
    SELECT id, action, entity_type, entity_id, actor, request_id, metadata_json
    FROM audit_logs
    WHERE entity_type = 'travel_expense_ingestion' AND entity_id = $ingestionId
    ORDER BY action, id
  `).all({ $ingestionId: manifest.ingestionId });
  const expectedActions = EXPECTED_AUDIT_ACTIONS[ingestion.status];
  if (!expectedActions || rows.length !== expectedActions.length) {
    throw new Error("The iCost ingestion audit exact manifest is missing rows or contains extra rows");
  }
  const actualActions = rows.map((row) => row.action).sort();
  if (JSON.stringify(actualActions) !== JSON.stringify([...expectedActions].sort())) {
    throw new Error("The exact iCost ingestion audit actions do not match the acceptance record");
  }
  for (const row of rows) {
    const metadata = parseObjectJson(row.metadata_json);
    if (
      row.entity_type !== "travel_expense_ingestion"
      || row.entity_id !== manifest.ingestionId
      || row.actor !== "icost-webhook"
      || row.request_id !== manifest.sourceId
      || metadata?.owner !== manifest.owner
      || metadata?.source !== "icost"
    ) {
      throw new Error("The exact iCost ingestion audit ownership does not match the acceptance manifest");
    }
  }
  return rows;
}

function assertNoFinancialAudit(db, manifest) {
  if (!manifest.expenseId) return;
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_logs
    WHERE (entity_type = 'travel_expense' AND entity_id = $expenseId)
       OR (entity_type = 'travel_expense_payment' AND entity_id = $paymentId)
  `).get({
    $expenseId: manifest.expenseId,
    $paymentId: manifest.paymentId,
  }).count);
  if (count !== 0) {
    throw new Error("A financial audit indicates that the manifested acceptance record became business data");
  }
}

function loadAndValidateRows(db, manifest) {
  const ingestion = db.prepare(`
    SELECT *
    FROM travel_expense_ingestions
    WHERE id = $id
  `).get({ $id: manifest.ingestionId });
  if (!ingestion) throw new Error("The exact iCost acceptance ingestion was not found");
  if (
    ingestion.owner !== manifest.owner
    || ingestion.source !== "icost"
    || ingestion.source_id !== manifest.sourceId
    || ingestion.actor !== "icost-webhook"
  ) {
    throw new Error("The exact iCost ingestion ownership or source does not match the acceptance manifest");
  }

  const sourceRows = db.prepare(`
    SELECT id
    FROM travel_expense_ingestions
    WHERE source_id = $sourceId
  `).all({ $sourceId: manifest.sourceId });
  if (sourceRows.length !== 1 || sourceRows[0].id !== manifest.ingestionId) {
    throw new Error("The acceptance source id is not unique across ingestion owners");
  }

  if (!Object.hasOwn(EXPECTED_AUDIT_ACTIONS, ingestion.status)) {
    throw new Error("The iCost acceptance ingestion is not in a completed cleanup state");
  }

  let expense = null;
  let payment = null;
  if (ingestion.status === "review_required") {
    if (
      ingestion.expense_id !== null
      || ingestion.payment_id !== null
      || manifest.expenseId !== null
      || manifest.paymentId !== null
    ) {
      throw new Error("A review-required iCost ingestion must not include financial ids");
    }
  } else {
    if (
      !manifest.expenseId
      || !manifest.paymentId
      || ingestion.expense_id !== manifest.expenseId
      || ingestion.payment_id !== manifest.paymentId
    ) {
      throw new Error("The exact financial relationship does not match the acceptance manifest");
    }
    expense = db.prepare("SELECT * FROM travel_expenses WHERE id = $id").get({ $id: manifest.expenseId });
    if (
      !expense
      || expense.owner !== manifest.owner
      || expense.created_by !== "icost-webhook"
      || expense.updated_by !== "icost-webhook"
      || Number(expense.version) !== 1
      || expense.deleted_at !== null
    ) {
      throw new Error("The manifested expense is missing, changed, or not integration-owned");
    }
    payment = db.prepare("SELECT * FROM travel_expense_payments WHERE id = $id").get({ $id: manifest.paymentId });
    if (
      !payment
      || payment.expense_id !== manifest.expenseId
      || Number(payment.sequence) !== 1
      || payment.created_at !== payment.updated_at
    ) {
      throw new Error("The manifested payment is missing, changed, or belongs to another expense");
    }
    const paymentCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM travel_expense_payments
      WHERE expense_id = $expenseId
    `).get({ $expenseId: manifest.expenseId }).count);
    if (paymentCount !== 1) {
      throw new Error("The manifested expense has an extra or missing payment");
    }
  }

  const auditRows = exactAuditRows(db, ingestion, manifest);
  assertNoFinancialAudit(db, manifest);
  assertNoUnrelatedFinancialDependents(db, manifest);
  return { ingestion, expense, payment, auditRows };
}

function deleteExactAuditRows(db, rows) {
  const statement = db.prepare("DELETE FROM audit_logs WHERE id = $id");
  return rows.reduce(
    (total, row) => total + Number(statement.run({ $id: row.id }).changes),
    0,
  );
}

function exactResidualCounts(db, manifest, auditRows) {
  const auditStatement = db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE id = $id");
  const auditLogs = auditRows.reduce(
    (total, row) => total + Number(auditStatement.get({ $id: row.id }).count),
    0,
  );
  return {
    auditLogs,
    ingestions: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM travel_expense_ingestions WHERE id = $id",
    ).get({ $id: manifest.ingestionId }).count),
    payments: manifest.paymentId
      ? Number(db.prepare(
          "SELECT COUNT(*) AS count FROM travel_expense_payments WHERE id = $id",
        ).get({ $id: manifest.paymentId }).count)
      : 0,
    expenses: manifest.expenseId
      ? Number(db.prepare(
          "SELECT COUNT(*) AS count FROM travel_expenses WHERE id = $id",
        ).get({ $id: manifest.expenseId }).count)
      : 0,
  };
}

function databaseIntegrity(db) {
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const rows = db.prepare("PRAGMA quick_check").all();
  const quickCheck = rows.length === 1 ? String(rows[0].quick_check) : "failed";
  if (foreignKeyViolations !== 0 || quickCheck !== "ok") {
    throw new Error("Database integrity failed after iCost acceptance cleanup");
  }
  return { quickCheck, foreignKeyViolations };
}

export function cleanupIcostAcceptance({
  databaseUrl,
  authSessionSecret,
  manifest: manifestValue,
} = {}) {
  const manifest = normalizeManifest(manifestValue);
  const databasePath = assertDatabaseIdentity({
    databaseUrl,
    authSessionSecret,
    expectedIdentity: manifest.databaseIdentity,
  });
  const db = openDatabase({ databaseUrl: databasePath });
  try {
    return withImmediateTransaction(db, () => {
      const { auditRows } = loadAndValidateRows(db, manifest);
      const deleted = {
        auditLogs: deleteExactAuditRows(db, auditRows),
        ingestions: Number(db.prepare(`
          DELETE FROM travel_expense_ingestions
          WHERE id = $id
            AND owner = $owner
            AND source = 'icost'
            AND source_id = $sourceId
            AND actor = 'icost-webhook'
        `).run({
          $id: manifest.ingestionId,
          $owner: manifest.owner,
          $sourceId: manifest.sourceId,
        }).changes),
        payments: manifest.paymentId
          ? Number(db.prepare(`
              DELETE FROM travel_expense_payments
              WHERE id = $id AND expense_id = $expenseId
            `).run({ $id: manifest.paymentId, $expenseId: manifest.expenseId }).changes)
          : 0,
        expenses: manifest.expenseId
          ? Number(db.prepare(`
              DELETE FROM travel_expenses
              WHERE id = $id
                AND owner = $owner
                AND created_by = 'icost-webhook'
                AND updated_by = 'icost-webhook'
                AND version = 1
                AND deleted_at IS NULL
            `).run({ $id: manifest.expenseId, $owner: manifest.owner }).changes)
          : 0,
      };
      const expectedDeleted = {
        auditLogs: auditRows.length,
        ingestions: 1,
        payments: manifest.paymentId ? 1 : 0,
        expenses: manifest.expenseId ? 1 : 0,
      };
      if (JSON.stringify(deleted) !== JSON.stringify(expectedDeleted)) {
        throw new Error("The exact iCost acceptance deletion count did not match the manifest");
      }

      const residual = exactResidualCounts(db, manifest, auditRows);
      if (Object.values(residual).some((count) => count !== 0)) {
        throw new Error("The exact iCost acceptance cleanup left residual rows");
      }
      const integrity = databaseIntegrity(db);
      return {
        status: "clean",
        verified: {
          databaseIdentity: true,
          ingestion: true,
          relationships: true,
        },
        deleted,
        residual,
        integrity,
      };
    });
  } finally {
    db.close();
  }
}

function manifestPathFromArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !argv[0].startsWith("--manifest=")) {
    throw new TypeError("Exactly one --manifest=<path> argument is required");
  }
  const path = argv[0].slice("--manifest=".length);
  if (!path || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
    throw new TypeError("The manifest path is invalid");
  }
  return path;
}

export function runIcostAcceptanceCleanupCli({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const manifestPath = manifestPathFromArguments(argv);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return cleanupIcostAcceptance({
    databaseUrl: env.DATABASE_URL,
    authSessionSecret: env.AUTH_SESSION_SECRET,
    manifest,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = runIcostAcceptanceCleanupCli();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write("iCost acceptance cleanup failed\n");
    process.exitCode = 1;
  }
}
