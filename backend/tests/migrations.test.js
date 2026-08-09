import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { all, openDatabase, run } from "../src/db.js";
import { createConnection } from "../src/db/connection.js";
import {
  canonicalMigrationSource,
  executeMigration,
  migrateDatabase,
  migrationChecksum,
} from "../src/db/migrate.js";
import { apply as applyPhase1WriteIntegrity } from "../src/db/migrations/0002_phase1_write_integrity.mjs";

const businessTables = [
  "customers",
  "opportunities",
  "quick_records",
  "ai_insights",
  "manual_confirmations",
  "weekly_reports",
  "solution_drafts",
  "ai_suggestions",
  "action_items",
  "risk_items",
  "knowledge_items",
  "audit_logs",
];

const writeIntegrityColumns = {
  customers: ["version", "deleted_at", "deleted_by"],
  opportunities: ["version", "deleted_at", "deleted_by"],
  quick_records: ["version", "voided_at", "voided_by", "void_reason", "owner"],
  weekly_reports: ["version", "deleted_at", "deleted_by"],
  solution_drafts: ["version"],
  action_items: ["version", "deleted_at", "deleted_by"],
  risk_items: ["version", "deleted_at", "deleted_by"],
  knowledge_items: ["version", "deleted_at", "deleted_by"],
};

function columnNames(db, table) {
  return all(db, `PRAGMA table_info(${table})`).map((row) => row.name);
}

function columnInfo(db, table, column) {
  return all(db, `PRAGMA table_info(${table})`).find((row) => row.name === column);
}

function indexColumns(db, index) {
  return all(db, `PRAGMA index_info(${index})`).map((row) => row.name);
}

function databaseTableNames(db) {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

function tableCounts(db) {
  return Object.fromEntries(
    businessTables.map((table) => [table, all(db, `SELECT COUNT(*) AS count FROM ${table}`)[0].count]),
  );
}

function rowsHash(db, table, omittedColumns = []) {
  const omitted = new Set(omittedColumns);
  const rows = all(db, `SELECT * FROM ${table} ORDER BY id`).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !omitted.has(column))),
  );
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function seedLegacyBusinessRows(db) {
  const baselinePath = fileURLToPath(new URL("../src/db/migrations/0001_baseline.sql", import.meta.url));
  db.exec(readFileSync(baselinePath, "utf8"));
  db.exec(`
    INSERT INTO customers (id, name, region, relation)
    VALUES ('legacy-customer', 'Legacy customer', 'north', 71);
    INSERT INTO opportunities (id, customer_id, name, stage, probability)
    VALUES ('legacy-opportunity', 'legacy-customer', 'Legacy opportunity', 'discovery', 45);
    INSERT INTO quick_records (id, raw_content, customer_id, opportunity_id, status)
    VALUES ('legacy-record', 'Legacy record', 'legacy-customer', 'legacy-opportunity', 'recorded');
    INSERT INTO ai_insights (id, quick_record_id, analysis_json)
    VALUES ('legacy-insight', 'legacy-record', '{"summary":"legacy"}');
    INSERT INTO manual_confirmations (id, quick_record_id, target, confirmed_by)
    VALUES ('legacy-confirmation', 'legacy-record', 'customer', 'legacy-owner');
    INSERT INTO weekly_reports (id, owner, period_start, period_end, content)
    VALUES ('legacy-weekly', 'legacy-owner', '2026-07-06', '2026-07-12', 'Legacy weekly report');
    INSERT INTO solution_drafts (id, owner, title, customer_id, opportunity_id, content)
    VALUES ('legacy-solution', 'legacy-owner', 'Legacy solution', 'legacy-customer', 'legacy-opportunity', 'Legacy content');
    INSERT INTO ai_suggestions (id, type, title, content)
    VALUES ('legacy-suggestion', 'next_action', 'Legacy suggestion', 'Legacy suggestion content');
    INSERT INTO action_items (id, customer_id, opportunity_id, title, source_record_id)
    VALUES ('legacy-action', 'legacy-customer', 'legacy-opportunity', 'Legacy action', 'legacy-record');
    INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, evidence, action)
    VALUES ('legacy-risk', 'legacy-customer', 'legacy-opportunity', 'Legacy risk', 'Legacy target', 'Legacy evidence', 'Legacy mitigation');
    INSERT INTO knowledge_items (id, title, category, content)
    VALUES ('legacy-knowledge', 'Legacy knowledge', 'reference', 'Legacy knowledge content');
    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor)
    VALUES ('legacy-audit', 'create', 'customer', 'legacy-customer', 'legacy-owner');
  `);
}

function withDatabase(testBody) {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-migrations-"));
  const databaseUrl = join(directory, "workbench.sqlite");

  try {
    testBody(databaseUrl);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function migrateThrough0002(db) {
  const migrationPaths = [
    fileURLToPath(new URL("../src/db/migrations/0001_baseline.sql", import.meta.url)),
    fileURLToPath(new URL("../src/db/migrations/0002_phase1_write_integrity.mjs", import.meta.url)),
  ];
  const sources = migrationPaths.map((path) => readFileSync(path, "utf8"));
  db.exec("BEGIN IMMEDIATE");
  try {
    executeMigration(db, { version: "0001", type: "sql" }, sources[0]);
    executeMigration(db, {
      version: "0002",
      type: "module",
      apply: applyPhase1WriteIntegrity,
    }, sources[1]);
    db.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const insert = db.prepare(`
      INSERT INTO schema_migrations (version, checksum, applied_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    insert.run("0001", migrationChecksum(sources[0]));
    insert.run("0002", migrationChecksum(sources[1]));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("records versioned migrations exactly once and remains idempotent on reopen", () => {
  withDatabase((databaseUrl) => {
    let first;
    let second;

    try {
      first = openDatabase({ databaseUrl });
      const firstMigrations = all(first, "SELECT version, checksum FROM schema_migrations ORDER BY version");

      second = openDatabase({ databaseUrl });
      const secondMigrations = all(second, "SELECT version, checksum FROM schema_migrations ORDER BY version");

      assert.equal(firstMigrations.length, 11);
      assert.equal(firstMigrations[0].version, "0001");
      assert.equal(firstMigrations[1].version, "0002");
      assert.equal(firstMigrations[2].version, "0003");
      assert.equal(firstMigrations[3].version, "0005");
      assert.equal(firstMigrations[4].version, "0006");
      assert.equal(firstMigrations[5].version, "0007");
      assert.equal(firstMigrations[6].version, "0008");
      assert.equal(firstMigrations[7].version, "0009");
      assert.equal(firstMigrations[8].version, "0010");
      assert.equal(firstMigrations[9].version, "0011");
      assert.equal(firstMigrations[10].version, "0012");
      assert.match(firstMigrations[0].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[1].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[2].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[3].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[4].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[5].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[6].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[7].checksum, /^[a-f0-9]{64}$/);
      assert.match(firstMigrations[8].checksum, /^[a-f0-9]{64}$/);
      const migrationSources = [
        "../src/db/migrations/0001_baseline.sql",
        "../src/db/migrations/0002_phase1_write_integrity.mjs",
        "../src/db/migrations/0003_quick_record_risk_identity.mjs",
        "../src/db/migrations/0005_visit_itineraries.mjs",
        "../src/db/migrations/0006_sales_decision_analyses.mjs",
        "../src/db/migrations/0007_travel_expenses.mjs",
        "../src/db/migrations/0008_expense_ingestion_invoices.mjs",
        "../src/db/migrations/0009_lossless_document_blobs.mjs",
        "../src/db/migrations/0010_idempotency_claim_leases.mjs",
        "../src/db/migrations/0011_assistant_runtime_persistence.mjs",
        "../src/db/migrations/0012_assistant_owner_and_plan_digest.mjs",
      ].map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
      assert.equal(firstMigrations[0].checksum, migrationChecksum(migrationSources[0]));
      assert.equal(firstMigrations[1].checksum, migrationChecksum(migrationSources[1]));
      assert.equal(firstMigrations[2].checksum, migrationChecksum(migrationSources[2]));
      assert.equal(firstMigrations[3].checksum, migrationChecksum(migrationSources[3]));
      assert.equal(firstMigrations[4].checksum, migrationChecksum(migrationSources[4]));
      assert.equal(firstMigrations[5].checksum, migrationChecksum(migrationSources[5]));
      assert.equal(firstMigrations[6].checksum, migrationChecksum(migrationSources[6]));
      assert.equal(firstMigrations[7].checksum, migrationChecksum(migrationSources[7]));
      assert.equal(firstMigrations[8].checksum, migrationChecksum(migrationSources[8]));
      assert.equal(firstMigrations[9].checksum, migrationChecksum(migrationSources[9]));
      assert.equal(firstMigrations[10].checksum, migrationChecksum(migrationSources[10]));
      assert.deepEqual(secondMigrations, firstMigrations);
    } finally {
      second?.close();
      first?.close();
    }
  });
});

test("migration 0003 reconciles active quick-record risk duplicates and enforces partial uniqueness", () => {
  withDatabase((databaseUrl) => {
    const db = createConnection({ databaseUrl });
    try {
      migrateThrough0002(db);
      db.exec(`
        INSERT INTO risk_items (
          id, title, target, evidence, action, source_type, source_id,
          version, created_at, updated_at
        ) VALUES
          ('risk-old', 'Old active', 'target', 'evidence', 'action', 'quick_record', 'qr-duplicate', 2, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'),
          ('risk-current', 'Current active', 'target', 'evidence', 'action', 'quick_record', 'qr-duplicate', 5, '2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z'),
          ('risk-history', 'Deleted history', 'target', 'evidence', 'action', 'quick_record', 'qr-duplicate', 9, '2026-07-13T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),
          ('risk-single', 'Single active', 'target', 'evidence', 'action', 'quick_record', 'qr-single', 4, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
        UPDATE risk_items
        SET deleted_at = '2026-07-15T12:00:00.000Z', deleted_by = 'legacy-user'
        WHERE id = 'risk-history';
      `);

      migrateDatabase(db);

      const rows = all(db, `
        SELECT id, version, deleted_at, deleted_by, title, updated_at
        FROM risk_items
        WHERE source_type = 'quick_record' AND source_id = 'qr-duplicate'
        ORDER BY id
      `);
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(rows.filter((row) => row.deleted_at === null).length, 1);
      assert.equal(byId.get("risk-current").deleted_at, null);
      assert.equal(byId.get("risk-current").version, 5);
      assert.equal(byId.get("risk-current").title, "Current active");
      assert.ok(byId.get("risk-old").deleted_at);
      assert.equal(byId.get("risk-old").deleted_by, "migration:0003");
      assert.equal(byId.get("risk-old").version, 3);
      assert.equal(byId.get("risk-old").title, "Old active");
      assert.equal(byId.get("risk-history").deleted_at, "2026-07-15T12:00:00.000Z");
      assert.equal(byId.get("risk-history").deleted_by, "legacy-user");
      assert.equal(byId.get("risk-history").version, 9);
      assert.equal(byId.get("risk-history").updated_at, "2026-07-17T00:00:00.000Z");
      const single = all(
        db,
        "SELECT id, version, deleted_at, deleted_by FROM risk_items WHERE id = 'risk-single'",
      )[0];
      assert.equal(single.id, "risk-single");
      assert.equal(single.version, 4);
      assert.equal(single.deleted_at, null);
      assert.equal(single.deleted_by, null);

      const migration = all(db, "SELECT version, checksum FROM schema_migrations WHERE version = '0003'");
      assert.equal(migration.length, 1);
      assert.match(migration[0].checksum, /^[a-f0-9]{64}$/);
      const index = all(db, `
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'ux_risk_items_active_quick_record_source'
      `);
      assert.equal(index.length, 1);
      assert.match(index[0].sql, /UNIQUE/i);
      assert.match(index[0].sql, /source_type\s*=\s*'quick_record'/i);
      assert.match(index[0].sql, /source_id\s+IS\s+NOT\s+NULL/i);
      assert.match(index[0].sql, /deleted_at\s+IS\s+NULL/i);

      assert.throws(() => db.exec(`
        INSERT INTO risk_items (id, title, target, evidence, action, source_type, source_id)
        VALUES ('risk-active-conflict', 'conflict', 'target', 'evidence', 'action', 'quick_record', 'qr-duplicate')
      `), /UNIQUE constraint failed/i);
      db.exec(`
        INSERT INTO risk_items (id, title, target, evidence, action, source_type, source_id, deleted_at)
        VALUES ('risk-deleted-extra', 'history', 'target', 'evidence', 'action', 'quick_record', 'qr-duplicate', CURRENT_TIMESTAMP);
        INSERT INTO risk_items (id, title, target, evidence, action, source_type, source_id)
        VALUES ('risk-non-quick', 'other source', 'target', 'evidence', 'action', 'manual', 'qr-duplicate');
      `);

      const beforeReopen = all(db, `
        SELECT id, version, deleted_at, deleted_by
        FROM risk_items
        WHERE source_type = 'quick_record' AND source_id = 'qr-duplicate'
        ORDER BY id
      `);
      migrateDatabase(db);
      assert.deepEqual(all(db, `
        SELECT id, version, deleted_at, deleted_by
        FROM risk_items
        WHERE source_type = 'quick_record' AND source_id = 'qr-duplicate'
        ORDER BY id
      `), beforeReopen);
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0003'").length, 1);
    } finally {
      db.close();
    }
  });
});

test("rejects a stored checksum that does not match migration 0002", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      run(db, "INSERT INTO customers (id, name) VALUES (:id, :name)", {
        id: "checksum-0002-customer",
        name: "Checksum 0002 customer",
      });
      const update = run(db, "UPDATE schema_migrations SET checksum = :checksum WHERE version = :version", {
        checksum: "not-the-write-integrity-checksum",
        version: "0002",
      });
      assert.equal(update.changes, 1);
    } finally {
      db.close();
    }

    assert.throws(
      () => {
        const unexpected = openDatabase({ databaseUrl });
        unexpected.close();
      },
      /Checksum mismatch for migration 0002/,
    );

    const readable = createConnection({ databaseUrl });
    try {
      assert.equal(
        all(readable, "SELECT name FROM customers WHERE id = 'checksum-0002-customer'")[0].name,
        "Checksum 0002 customer",
      );
      assert.equal(
        all(readable, "SELECT checksum FROM schema_migrations WHERE version = '0002'")[0].checksum,
        "not-the-write-integrity-checksum",
      );
    } finally {
      readable.close();
    }
  });
});

test("upgrades all legacy business data into the phase one write-integrity schema", () => {
  withDatabase((databaseUrl) => {
    const legacy = createConnection({ databaseUrl });
    seedLegacyBusinessRows(legacy);
    const countsBefore = tableCounts(legacy);
    const hashesBefore = Object.fromEntries(
      Object.entries(writeIntegrityColumns).map(([table, omittedColumns]) => [
        table,
        rowsHash(legacy, table, omittedColumns),
      ]),
    );
    legacy.close();

    const migrated = openDatabase({ databaseUrl });
    try {
      for (const [table, expectedColumns] of Object.entries(writeIntegrityColumns)) {
        const actualColumns = columnNames(migrated, table);
        for (const column of expectedColumns) assert.equal(actualColumns.includes(column), true);
      }
      for (const table of Object.keys(writeIntegrityColumns)) {
        const version = columnInfo(migrated, table, "version");
        assert.equal(version.type, "INTEGER");
        assert.equal(version.notnull, 1);
        assert.equal(version.dflt_value, "1");
      }
      for (const table of [
        "customers",
        "opportunities",
        "weekly_reports",
        "action_items",
        "risk_items",
        "knowledge_items",
      ]) {
        assert.equal(columnInfo(migrated, table, "deleted_at").type, "TEXT");
        assert.equal(columnInfo(migrated, table, "deleted_by").type, "TEXT");
      }
      const auditColumns = columnNames(migrated, "audit_logs");
      for (const column of ["request_id", "before_json", "after_json", "entity_version"]) {
        assert.equal(auditColumns.includes(column), true);
      }
      assert.equal(columnInfo(migrated, "audit_logs", "before_json").notnull, 1);
      assert.equal(columnInfo(migrated, "audit_logs", "before_json").dflt_value, "'{}'");
      assert.equal(columnInfo(migrated, "audit_logs", "after_json").notnull, 1);
      assert.equal(columnInfo(migrated, "audit_logs", "after_json").dflt_value, "'{}'");
      const tables = databaseTableNames(migrated);
      for (const table of ["auth_sessions", "idempotency_keys", "login_rate_limits"]) {
        assert.equal(tables.includes(table), true);
      }
      assert.deepEqual(
        indexColumns(migrated, "idx_auth_sessions_active"),
        ["token_hash", "expires_at", "revoked_at"],
      );
      assert.deepEqual(indexColumns(migrated, "idx_idempotency_expiry"), ["expires_at"]);
      assert.equal(columnInfo(migrated, "idempotency_keys", "claim_token").type, "TEXT");
      assert.deepEqual(
        ["actor", "method", "request_path", "key"].map((column) =>
          columnInfo(migrated, "idempotency_keys", column).pk),
        [1, 2, 3, 4],
      );

      run(migrated, `
        INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
        VALUES ('session-1', 'token-hash', 'legacy-owner', '2026-07-20', '2026-07-15')
      `);
      assert.throws(() => run(migrated, `
        INSERT INTO auth_sessions (id, token_hash, account, expires_at, created_at)
        VALUES ('session-2', 'token-hash', 'legacy-owner', '2026-07-20', '2026-07-15')
      `), /UNIQUE constraint failed/i);
      assert.throws(() => run(migrated, `
        INSERT INTO idempotency_keys (
          actor, method, request_path, key, request_hash, state, created_at, expires_at
        ) VALUES (
          'legacy-owner', 'POST', '/api/customers', 'invalid-state', 'request-hash',
          'invalid', '2026-07-15', '2026-07-16'
        )
      `), /CHECK constraint failed/i);

      assert.deepEqual(tableCounts(migrated), countsBefore);
      const hashesAfter = Object.fromEntries(
        Object.entries(writeIntegrityColumns).map(([table, omittedColumns]) => [
          table,
          rowsHash(migrated, table, omittedColumns),
        ]),
      );
      assert.deepEqual(hashesAfter, hashesBefore);
      assert.deepEqual(
        all(migrated, "SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version),
        ["0001", "0002", "0003", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012"],
      );
    } finally {
      migrated.close();
    }
  });
});

test("rejects a stored checksum that does not match migration 0001", () => {
  withDatabase((databaseUrl) => {
    let db;

    try {
      db = openDatabase({ databaseUrl });
      run(db, "INSERT INTO customers (id, name) VALUES (:id, :name)", {
        id: "checksum-customer",
        name: "Checksum customer"
      });
      run(db, "UPDATE schema_migrations SET checksum = :checksum WHERE version = :version", {
        checksum: "not-the-baseline-checksum",
        version: "0001"
      });
    } finally {
      db?.close();
    }

    let driftError;
    let unexpectedDatabase;
    try {
      unexpectedDatabase = openDatabase({ databaseUrl });
    } catch (error) {
      driftError = error;
    } finally {
      unexpectedDatabase?.close();
    }
    assert.equal(driftError?.message, "Checksum mismatch for migration 0001");

    const readable = createConnection({ databaseUrl });
    try {
      assert.equal(all(readable, "SELECT name FROM customers WHERE id = :id", { id: "checksum-customer" })[0].name, "Checksum customer");
      assert.equal(all(readable, "SELECT checksum FROM schema_migrations WHERE version = :version", { version: "0001" })[0].checksum, "not-the-baseline-checksum");
    } finally {
      readable.close();
    }
  });
});

test("uses the same migration checksum for LF and CRLF source text", () => {
  const lf = "CREATE TABLE example (id TEXT PRIMARY KEY);\nCREATE INDEX example_id ON example(id);\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
  assert.notEqual(migrationChecksum(lf), migrationChecksum(`${lf}-- changed\n`));
});

test("rejects unknown, missing, and asynchronous module migration executors", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    assert.throws(
      () => executeMigration(db, { version: "test", type: "unknown" }, ""),
      /Unknown migration type/i,
    );
    assert.throws(
      () => executeMigration(db, { version: "test", type: "module" }, ""),
      /must export a synchronous apply function/i,
    );

    let asyncApplyCalled = false;
    assert.throws(
      () => executeMigration(db, {
        version: "test",
        type: "module",
        apply: async () => { asyncApplyCalled = true; },
      }, ""),
      /must be synchronous/i,
    );
    assert.equal(asyncApplyCalled, false);

    assert.throws(
      () => executeMigration(db, {
        version: "test",
        type: "module",
        apply: () => Promise.resolve(),
      }, ""),
      /returned a Promise/i,
    );
  } finally {
    db.close();
  }
});

test("rejects a raw CRLF checksum for baseline migration 0001 without mutating rows", () => {
  withDatabase((databaseUrl) => {
    const baselinePath = fileURLToPath(new URL("../src/db/migrations/0001_baseline.sql", import.meta.url));
    const canonicalSource = canonicalMigrationSource(readFileSync(baselinePath, "utf8"));
    const rawCrlfChecksum = createHash("sha256")
      .update(canonicalSource.replace(/\n/g, "\r\n"))
      .digest("hex");
    const db = openDatabase({ databaseUrl });
    try {
      run(db, "INSERT INTO customers (id, name) VALUES ('raw-checksum-customer', 'Raw checksum customer')");
      run(db, "UPDATE schema_migrations SET checksum = :checksum WHERE version = '0001'", {
        checksum: rawCrlfChecksum
      });
    } finally {
      db.close();
    }

    let driftError;
    let unexpectedDatabase;
    try {
      unexpectedDatabase = openDatabase({ databaseUrl });
    } catch (error) {
      driftError = error;
    } finally {
      unexpectedDatabase?.close();
    }
    assert.equal(driftError?.message, "Checksum mismatch for migration 0001");

    const reopened = createConnection({ databaseUrl });
    try {
      assert.equal(
        all(reopened, "SELECT checksum FROM schema_migrations WHERE version = '0001'")[0].checksum,
        rawCrlfChecksum
      );
      assert.equal(
        all(reopened, "SELECT name FROM customers WHERE id = 'raw-checksum-customer'")[0].name,
        "Raw checksum customer"
      );
    } finally {
      reopened.close();
    }
  });
});

test("adopts legacy baseline tables by adding missing columns without losing rows", () => {
  withDatabase((databaseUrl) => {
    const db = createConnection({ databaseUrl });
    try {
      db.exec(`
        CREATE TABLE solution_drafts (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          title TEXT NOT NULL,
          customer_id TEXT,
          opportunity_id TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          content TEXT NOT NULL,
          source_refs TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE action_items (
          id TEXT PRIMARY KEY,
          customer_id TEXT,
          opportunity_id TEXT,
          title TEXT NOT NULL,
          customer TEXT,
          reason TEXT,
          due TEXT,
          priority TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'pending',
          source_record_id TEXT UNIQUE,
          tone TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE risk_items (
          id TEXT PRIMARY KEY,
          customer_id TEXT,
          opportunity_id TEXT,
          title TEXT NOT NULL,
          target TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 60,
          severity TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'open',
          evidence TEXT NOT NULL,
          action TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'opportunity',
          source_id TEXT,
          tone TEXT NOT NULL DEFAULT 'amber',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      run(db, "INSERT INTO solution_drafts (id, owner, title, content) VALUES ('legacy-solution', 'owner', 'Legacy solution', 'content')");
      run(db, "INSERT INTO action_items (id, title) VALUES ('legacy-action', 'Legacy action')");
      run(db, "INSERT INTO risk_items (id, title, target, evidence, action) VALUES ('legacy-risk', 'Legacy risk', 'target', 'evidence', 'action')");

      migrateDatabase(db);

      assert.equal(all(db, "SELECT title, assignee FROM action_items WHERE id = 'legacy-action'")[0].title, "Legacy action");
      assert.equal(all(db, "SELECT assignee, due FROM risk_items WHERE id = 'legacy-risk'")[0].due, null);
      assert.equal(all(db, "SELECT artifact_type FROM solution_drafts WHERE id = 'legacy-solution'")[0].artifact_type, "solution_framework");
      assert.equal(all(db, "SELECT version FROM schema_migrations").length, 11);
    } finally {
      db.close();
    }
  });
});

test("rolls back every 0002 schema change when the module migration fails partway", () => {
  withDatabase((databaseUrl) => {
    const db = createConnection({ databaseUrl });
    try {
      seedLegacyBusinessRows(db);
      const baselinePath = fileURLToPath(new URL("../src/db/migrations/0001_baseline.sql", import.meta.url));
      const baselineChecksum = migrationChecksum(readFileSync(baselinePath, "utf8"));
      db.exec(`
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE auth_sessions (id TEXT PRIMARY KEY);
      `);
      run(db, `
        INSERT INTO schema_migrations (version, checksum, applied_at)
        VALUES ('0001', :checksum, CURRENT_TIMESTAMP)
      `, { checksum: baselineChecksum });
      const countsBefore = tableCounts(db);
      const hashesBefore = Object.fromEntries(
        Object.entries(writeIntegrityColumns).map(([table, omittedColumns]) => [
          table,
          rowsHash(db, table, omittedColumns),
        ]),
      );

      assert.throws(() => migrateDatabase(db), /token_hash/i);

      for (const [table, expectedColumns] of Object.entries(writeIntegrityColumns)) {
        const actualColumns = columnNames(db, table);
        for (const column of expectedColumns) assert.equal(actualColumns.includes(column), false);
      }
      const auditColumnsAfterFailure = columnNames(db, "audit_logs");
      for (const column of ["request_id", "before_json", "after_json", "entity_version"]) {
        assert.equal(auditColumnsAfterFailure.includes(column), false);
      }
      assert.equal(databaseTableNames(db).includes("idempotency_keys"), false);
      assert.equal(databaseTableNames(db).includes("login_rate_limits"), false);
      assert.deepEqual(tableCounts(db), countsBefore);
      const hashesAfterFailure = Object.fromEntries(
        Object.entries(writeIntegrityColumns).map(([table, omittedColumns]) => [
          table,
          rowsHash(db, table, omittedColumns),
        ]),
      );
      assert.deepEqual(hashesAfterFailure, hashesBefore);
      assert.deepEqual(
        all(db, "SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version),
        ["0001"],
      );

      db.exec("DROP TABLE auth_sessions");
      migrateDatabase(db);
      assert.equal(columnNames(db, "customers").includes("version"), true);
      assert.deepEqual(
        all(db, "SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version),
        ["0001", "0002", "0003", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012"],
      );
    } finally {
      db.close();
    }
  });
});

test("does not stamp migration 0001 when the baseline transaction fails", () => {
  withDatabase((databaseUrl) => {
    const db = createConnection({ databaseUrl });
    try {
      db.exec("CREATE TABLE idx_action_items_status (id TEXT PRIMARY KEY)");

      assert.throws(() => migrateDatabase(db));
      assert.equal(
        all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").length,
        0
      );
    } finally {
      db.close();
    }
  });
});

function startMigrationChild(scriptPath, databaseUrl) {
  const child = fork(scriptPath, [], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  let resolveBeforeBegin;
  let rejectBeforeBegin;
  const beforeBegin = new Promise((resolve, reject) => {
    resolveBeforeBegin = resolve;
    rejectBeforeBegin = reject;
  });
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  child.on("message", (message) => {
    if (message?.type === "before-begin") resolveBeforeBegin();
  });
  child.on("error", (error) => {
    rejectBeforeBegin(error);
    rejectCompleted(error);
  });
  child.on("exit", (code, signal) => {
    if (code === 0) resolveCompleted();
    else rejectCompleted(new Error(`Concurrent opener exited with code ${code}, signal ${signal}`));
  });

  return { child, beforeBegin, completed, rejectBeforeBegin };
}

function withinTimeout(promise, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 5000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

test("acquires BEGIN IMMEDIATE before selecting applied migration versions", () => {
  const migrationPath = fileURLToPath(new URL("../src/db/migrate.js", import.meta.url));
  const source = readFileSync(migrationPath, "utf8");
  const beginIndex = source.indexOf('db.exec("BEGIN IMMEDIATE")');
  const selectIndex = source.indexOf("SELECT checksum FROM schema_migrations");

  assert.ok(beginIndex >= 0);
  assert.ok(selectIndex >= 0);
  assert.ok(beginIndex < selectIndex);
});

test("serializes blocked concurrent startup without duplicate baseline records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-migrations-concurrent-"));
  const databaseUrl = join(directory, "workbench.sqlite");
  const childScriptPath = join(directory, "migration-child.mjs");
  const parent = createConnection({ databaseUrl });
  const children = [];

  try {
    const connectionUrl = pathToFileURL(fileURLToPath(new URL("../src/db/connection.js", import.meta.url))).href;
    const migrationUrl = pathToFileURL(fileURLToPath(new URL("../src/db/migrate.js", import.meta.url))).href;
    writeFileSync(childScriptPath, `
      import { createConnection } from ${JSON.stringify(connectionUrl)};
      import { migrateDatabase } from ${JSON.stringify(migrationUrl)};
      const db = createConnection({ databaseUrl: process.env.DATABASE_URL });
      const guardedDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql) => {
              if (sql === "BEGIN IMMEDIATE") process.send?.({ type: "before-begin" });
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      try {
        migrateDatabase(guardedDb);
      } finally {
        db.close();
      }
    `);
    parent.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    parent.exec("BEGIN IMMEDIATE");
    children.push(startMigrationChild(childScriptPath, databaseUrl), startMigrationChild(childScriptPath, databaseUrl));
    await withinTimeout(
      Promise.all(children.map((child) => child.beforeBegin)),
      "Timed out waiting for concurrent migrations to reach BEGIN IMMEDIATE"
    );
    parent.exec("COMMIT");
    await withinTimeout(
      Promise.all(children.map((child) => child.completed)),
      "Timed out waiting for concurrent migrations to finish"
    );

    const db = openDatabase({ databaseUrl });
    try {
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0001'").length, 1);
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0002'").length, 1);
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0003'").length, 1);
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0005'").length, 1);
      assert.equal(all(db, "SELECT version FROM schema_migrations WHERE version = '0006'").length, 1);
    } finally {
      db.close();
    }
  } finally {
    try {
      parent.exec("ROLLBACK");
    } catch {
      // The parent transaction has already committed.
    }
    parent.close();
    for (const child of children) {
      if (child.child.exitCode === null) child.child.kill();
      child.rejectBeforeBegin(new Error("Concurrent migration cleanup"));
    }
    await Promise.allSettled(children.map((child) => child.completed));
    rmSync(directory, { recursive: true, force: true });
  }
});
