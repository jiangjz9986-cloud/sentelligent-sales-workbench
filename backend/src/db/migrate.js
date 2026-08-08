import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apply as applyPhase1WriteIntegrity } from "./migrations/0002_phase1_write_integrity.mjs";
import { apply as applyQuickRecordRiskIdentity } from "./migrations/0003_quick_record_risk_identity.mjs";
import { apply as applyVisitItineraries } from "./migrations/0005_visit_itineraries.mjs";
import { apply as applySalesDecisionAnalyses } from "./migrations/0006_sales_decision_analyses.mjs";
import { apply as applyTravelExpenses } from "./migrations/0007_travel_expenses.mjs";
import { apply as applyExpenseIngestionInvoices } from "./migrations/0008_expense_ingestion_invoices.mjs";
import { apply as applyLosslessDocumentBlobs } from "./migrations/0009_lossless_document_blobs.mjs";
import { apply as applyIdempotencyClaimLeases } from "./migrations/0010_idempotency_claim_leases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  {
    version: "0001",
    path: resolve(here, "migrations", "0001_baseline.sql"),
    type: "sql",
  },
  {
    version: "0002",
    path: resolve(here, "migrations", "0002_phase1_write_integrity.mjs"),
    type: "module",
    apply: applyPhase1WriteIntegrity,
  },
  {
    version: "0003",
    path: resolve(here, "migrations", "0003_quick_record_risk_identity.mjs"),
    type: "module",
    apply: applyQuickRecordRiskIdentity,
  },
  {
    version: "0005",
    path: resolve(here, "migrations", "0005_visit_itineraries.mjs"),
    type: "module",
    apply: applyVisitItineraries,
  },
  {
    version: "0006",
    path: resolve(here, "migrations", "0006_sales_decision_analyses.mjs"),
    type: "module",
    apply: applySalesDecisionAnalyses,
  },
  {
    version: "0007",
    path: resolve(here, "migrations", "0007_travel_expenses.mjs"),
    type: "module",
    apply: applyTravelExpenses,
  },
  {
    version: "0008",
    path: resolve(here, "migrations", "0008_expense_ingestion_invoices.mjs"),
    type: "module",
    apply: applyExpenseIngestionInvoices,
  },
  {
    version: "0009",
    path: resolve(here, "migrations", "0009_lossless_document_blobs.mjs"),
    type: "module",
    apply: applyLosslessDocumentBlobs,
  },
  {
    version: "0010",
    path: resolve(here, "migrations", "0010_idempotency_claim_leases.mjs"),
    type: "module",
    apply: applyIdempotencyClaimLeases,
  },
];

const baselineRepairs = [
  { table: "action_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "due", definition: "TEXT" },
  { table: "solution_drafts", column: "artifact_type", definition: "TEXT NOT NULL DEFAULT 'solution_framework'" }
];

export function canonicalMigrationSource(source) {
  return source.replace(/\r\n/g, "\n");
}

export function migrationChecksum(source) {
  return createHash("sha256").update(canonicalMigrationSource(source)).digest("hex");
}

function repairBaselineColumns(db) {
  for (const repair of baselineRepairs) {
    const columns = db.prepare(`PRAGMA table_info(${repair.table})`).all();
    if (!columns.some((column) => column.name === repair.column)) {
      db.exec(`ALTER TABLE ${repair.table} ADD COLUMN ${repair.column} ${repair.definition}`);
    }
  }
}

export function executeMigration(db, migration, source) {
  if (migration.type === "sql") {
    db.exec(source);
    return;
  }
  if (migration.type !== "module") {
    throw new Error(`Unknown migration type for ${migration.version}: ${migration.type}`);
  }
  if (typeof migration.apply !== "function") {
    throw new Error(`Module migration ${migration.version} must export a synchronous apply function`);
  }
  if (migration.apply.constructor?.name === "AsyncFunction") {
    throw new Error(`Module migration ${migration.version} apply function must be synchronous`);
  }

  const result = migration.apply(db);
  if (result && typeof result.then === "function") {
    throw new Error(`Module migration ${migration.version} returned a Promise; apply must be synchronous`);
  }
}

export function migrateDatabase(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const findMigration = db.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = :version"
    );
    const recordMigration = db.prepare(`
      INSERT INTO schema_migrations (version, checksum, applied_at)
      VALUES (:version, :checksum, CURRENT_TIMESTAMP)
    `);
    for (const migration of migrations) {
      const source = canonicalMigrationSource(readFileSync(migration.path, "utf8"));
      const checksum = migrationChecksum(source);
      const applied = findMigration.get({ version: migration.version });

      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(`Checksum mismatch for migration ${migration.version}`);
        }
        continue;
      }

      executeMigration(db, migration, source);
      if (migration.version === "0001") repairBaselineColumns(db);
      recordMigration.run({ version: migration.version, checksum });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
