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
import { apply as applySecureSettings } from "../src/db/migrations/0015_secure_settings.mjs";
import { apply as applySecureSettingsPushplus } from "../src/db/migrations/0021_secure_settings_pushplus.mjs";
import { apply as applySecureSettingsAsr } from "../src/db/migrations/0033_secure_settings_asr.mjs";

const SECURE_SETTINGS_ASR_CHECKSUM = "acada172a32c458427845fe973730bcbf4e8c6903547614fb19495131b663ed5";
const secureSettingsColumns = [
  "setting_key",
  "ciphertext",
  "status",
  "created_at",
  "rotated_at",
  "updated_at",
  "last_success_at",
  "last_failure_at",
  "last_error_code",
  "last_delivery_count",
  "last_chunk_count",
];

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
  customers: ["version", "deleted_at", "deleted_by", "aliases", "tags"],
  opportunities: ["version", "deleted_at", "deleted_by"],
  quick_records: [
    "version",
    "voided_at",
    "voided_by",
    "void_reason",
    "owner",
    "confirmation_preview_id",
    "confirmation_preview_status",
  ],
  weekly_reports: ["version", "deleted_at", "deleted_by", "entries_json"],
  solution_drafts: ["version"],
  action_items: ["version", "deleted_at", "deleted_by", "owner", "remind_at", "reminded_at"],
  risk_items: ["version", "deleted_at", "deleted_by"],
  knowledge_items: ["version", "deleted_at", "deleted_by"],
};

// 0031 会清扫历史 owner 词表并给 ✗ 表补 owner 列，跨迁移行哈希对全部业务表
// 统一忽略 owner（业务内容不变性仍由其余列保证）。
const rowsHashOmittedColumns = Object.fromEntries(
  Object.entries(writeIntegrityColumns).map(([table, columns]) => [
    table,
    columns.includes("owner") ? columns : [...columns, "owner"],
  ]),
);

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
    INSERT INTO customers (id, name, region, relation, owner)
    VALUES ('legacy-customer', 'Legacy customer', 'north', 71, 'legacy-owner');
    INSERT INTO opportunities (id, customer_id, name, stage, probability, owner)
    VALUES ('legacy-opportunity', 'legacy-customer', 'Legacy opportunity', 'discovery', 45, 'legacy-owner');
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

function secureSettingsRows(db) {
  return db.prepare("SELECT * FROM secure_settings ORDER BY setting_key").all()
    .map((row) => ({ ...row }));
}

function seedSecureSettingsMatrix(db, status) {
  const active = status === "active";
  const insert = db.prepare(`
    INSERT INTO secure_settings (
      setting_key, ciphertext, status, created_at, rotated_at, updated_at,
      last_success_at, last_failure_at, last_error_code,
      last_delivery_count, last_chunk_count
    ) VALUES (
      $key, $ciphertext, $status, $createdAt, $rotatedAt, $updatedAt,
      $lastSuccessAt, $lastFailureAt, $lastErrorCode,
      $lastDeliveryCount, $lastChunkCount
    )
  `);
  for (const [index, key] of [
    "icost_webhook_token",
    "deepseek_api_key",
    "hospital_tender_pushplus_token",
  ].entries()) {
    insert.run({
      $key: key,
      $ciphertext: active ? `ciphertext-${index + 1}` : null,
      $status: status,
      $createdAt: `2026-08-2${index}T01:02:03.00${index}Z`,
      $rotatedAt: index === 0 ? null : `2026-08-2${index}T02:03:04.00${index}Z`,
      $updatedAt: `2026-08-2${index}T03:04:05.00${index}Z`,
      $lastSuccessAt: index === 0 ? null : `2026-08-2${index}T04:05:06.00${index}Z`,
      $lastFailureAt: index === 2 ? `2026-08-2${index}T05:06:07.00${index}Z` : null,
      $lastErrorCode: index === 2 ? "synthetic_delivery_failure" : null,
      $lastDeliveryCount: index,
      $lastChunkCount: index + 1,
    });
  }
}

function rebuildDatabaseAs0032(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX idx_quick_records_confirmation_preview;
      DROP TABLE quick_record_confirmation_previews;
      ALTER TABLE quick_records DROP COLUMN confirmation_preview_id;
      ALTER TABLE quick_records DROP COLUMN confirmation_preview_status;
      ALTER TABLE weekly_reports DROP COLUMN entries_json;
      CREATE TABLE secure_settings_0032_fixture (
        setting_key TEXT PRIMARY KEY NOT NULL CHECK (
          setting_key IN (
            'icost_webhook_token',
            'deepseek_api_key',
            'hospital_tender_pushplus_token'
          )
        ),
        ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) > 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        updated_at TEXT NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
        last_delivery_count INTEGER CHECK (last_delivery_count IS NULL OR last_delivery_count >= 0),
        last_chunk_count INTEGER CHECK (last_chunk_count IS NULL OR last_chunk_count >= 0),
        CHECK ((status = 'active' AND ciphertext IS NOT NULL) OR (status = 'cleared' AND ciphertext IS NULL))
      );
      INSERT INTO secure_settings_0032_fixture (
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      )
      SELECT
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      FROM secure_settings
      WHERE setting_key IN (
        'icost_webhook_token',
        'deepseek_api_key',
        'hospital_tender_pushplus_token'
      );
      DROP TABLE secure_settings;
      ALTER TABLE secure_settings_0032_fixture RENAME TO secure_settings;
      DELETE FROM schema_migrations WHERE version IN ('0033', '0034', '0035');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
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

      assert.equal(firstMigrations.length, 34);
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
      assert.equal(firstMigrations[11].version, "0013");
      assert.equal(firstMigrations[12].version, "0014");
      assert.equal(firstMigrations[13].version, "0015");
      assert.equal(firstMigrations[14].version, "0016");
      assert.equal(firstMigrations[15].version, "0017");
      assert.equal(firstMigrations[16].version, "0018");
      assert.equal(firstMigrations[17].version, "0019");
      assert.equal(firstMigrations[18].version, "0020");
      assert.equal(firstMigrations[19].version, "0021");
      assert.equal(firstMigrations[20].version, "0022");
      assert.equal(firstMigrations[21].version, "0023");
      assert.equal(firstMigrations[22].version, "0024");
      assert.equal(firstMigrations[23].version, "0025");
      assert.equal(firstMigrations[24].version, "0026");
      assert.equal(firstMigrations[25].version, "0027");
      assert.equal(firstMigrations[26].version, "0028");
      assert.equal(firstMigrations[27].version, "0029");
      assert.equal(firstMigrations[28].version, "0030");
      assert.equal(firstMigrations[29].version, "0031");
      assert.equal(firstMigrations[30].version, "0032");
      assert.equal(firstMigrations[31].version, "0033");
      assert.equal(firstMigrations[32].version, "0034");
      assert.equal(firstMigrations[33].version, "0035");
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
        "../src/db/migrations/0013_assistant_confirmation_closure.mjs",
        "../src/db/migrations/0014_hospital_tender_monitor.mjs",
        "../src/db/migrations/0015_secure_settings.mjs",
        "../src/db/migrations/0016_hospital_tender_scheduler.mjs",
        "../src/db/migrations/0017_shortcut_webhook_tokens.mjs",
        "../src/db/migrations/0018_shortcut_bookkeeping_entries.mjs",
        "../src/db/migrations/0019_shortcut_weixin_confirmation.mjs",
        "../src/db/migrations/0020_shortcut_income_entries.mjs",
        "../src/db/migrations/0021_secure_settings_pushplus.mjs",
        "../src/db/migrations/0022_assistant_agent_runs.mjs",
        "../src/db/migrations/0023_assistant_business_context.mjs",
        "../src/db/migrations/0024_shortcut_advance_allocation.mjs",
        "../src/db/migrations/0025_travel_expense_region_profiles.mjs",
        "../src/db/migrations/0026_hospital_tender_active_window.mjs",
        "../src/db/migrations/0027_customer_profile_aliases.mjs",
        "../src/db/migrations/0028_action_item_reminders.mjs",
        "../src/db/migrations/0029_owner_vocabulary_cleanup.mjs",
        "../src/db/migrations/0030_users_table.mjs",
        "../src/db/migrations/0031_owner_isolation_tightening.mjs",
        "../src/db/migrations/0032_weixin_bindings.mjs",
        "../src/db/migrations/0033_secure_settings_asr.mjs",
        "../src/db/migrations/0034_quick_record_confirmation_previews.mjs",
        "../src/db/migrations/0035_visit_temperature_suggestions.mjs",
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
      assert.equal(firstMigrations[11].checksum, migrationChecksum(migrationSources[11]));
      assert.equal(firstMigrations[12].checksum, migrationChecksum(migrationSources[12]));
      assert.equal(firstMigrations[13].checksum, migrationChecksum(migrationSources[13]));
      assert.equal(firstMigrations[14].checksum, migrationChecksum(migrationSources[14]));
      assert.equal(firstMigrations[15].checksum, migrationChecksum(migrationSources[15]));
      assert.equal(firstMigrations[16].checksum, migrationChecksum(migrationSources[16]));
      assert.equal(firstMigrations[17].checksum, migrationChecksum(migrationSources[17]));
      assert.equal(firstMigrations[18].checksum, migrationChecksum(migrationSources[18]));
      assert.equal(firstMigrations[19].checksum, migrationChecksum(migrationSources[19]));
      assert.equal(firstMigrations[20].checksum, migrationChecksum(migrationSources[20]));
      assert.equal(firstMigrations[21].checksum, migrationChecksum(migrationSources[21]));
      assert.equal(firstMigrations[22].checksum, migrationChecksum(migrationSources[22]));
      assert.equal(firstMigrations[23].checksum, migrationChecksum(migrationSources[23]));
      assert.equal(firstMigrations[24].checksum, migrationChecksum(migrationSources[24]));
      assert.equal(firstMigrations[25].checksum, migrationChecksum(migrationSources[25]));
      assert.equal(firstMigrations[26].checksum, migrationChecksum(migrationSources[26]));
      assert.equal(firstMigrations[27].checksum, migrationChecksum(migrationSources[27]));
      assert.equal(firstMigrations[28].checksum, migrationChecksum(migrationSources[28]));
      assert.equal(firstMigrations[29].checksum, migrationChecksum(migrationSources[29]));
      assert.equal(firstMigrations[30].checksum, migrationChecksum(migrationSources[30]));
      assert.equal(firstMigrations[31].checksum, migrationChecksum(migrationSources[31]));
      assert.equal(firstMigrations[32].checksum, migrationChecksum(migrationSources[32]));
      assert.equal(firstMigrations[33].checksum, migrationChecksum(migrationSources[33]));
      assert.deepEqual(secondMigrations, firstMigrations);
    } finally {
      second?.close();
      first?.close();
    }
  });
});

test("migration 0024 creates immutable revisions and advance allocation overlay tables", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    assert.deepEqual(columnNames(db, "shortcut_bookkeeping_revisions"), [
      "id", "owner", "entry_id", "version", "changes_json", "source", "created_by", "created_at",
    ]);
    assert.deepEqual(columnNames(db, "travel_expense_advance_sources"), [
      "id", "owner", "entry_id", "advance_id", "amount_cents", "received_on", "week_start",
      "status", "created_by", "created_at", "reversed_by", "reversed_at",
    ]);
    assert.deepEqual(columnNames(db, "travel_expense_advance_allocation_plans"), [
      "id", "owner", "advance_id", "week_start", "scope", "status", "plan_hash",
      "requested_cents", "allocated_cents", "remaining_cents", "uncovered_cents", "overage_cents",
      "created_by", "created_at", "superseded_by", "superseded_at",
    ]);
    assert.deepEqual(columnNames(db, "travel_expense_advance_allocations"), [
      "id", "owner", "plan_id", "advance_id", "expense_id", "payment_id", "week_start",
      "allocated_cents", "allocation_kind", "status", "created_by", "created_at", "reversed_by",
      "reversed_at", "reason",
    ]);
    assert.equal(
      all(db, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0024'")[0].count,
      1,
    );
  } finally {
    db.close();
  }
});

test("migration 0025 creates owner-week region profiles and expense region snapshots", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    assert.deepEqual(columnNames(db, "travel_expense_region_profiles"), [
      "owner", "week_start", "version", "cities_json", "default_city",
      "date_overrides_json", "created_by", "updated_by", "created_at", "updated_at",
    ]);
    const expenseColumns = columnNames(db, "travel_expenses");
    assert.equal(expenseColumns.includes("trip_region"), true);
    assert.equal(expenseColumns.includes("trip_region_source"), true);
    assert.equal(
      all(db, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0025'")[0].count,
      1,
    );
  } finally {
    db.close();
  }
});

test("migration 0020 preserves the Shortcut ledger and permits accepted income without travel-expense rows", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      const columns = all(db, "PRAGMA table_info(shortcut_bookkeeping_entries)").map((row) => row.name);
      for (const column of [
        "id",
        "owner",
        "target_system",
        "ledger_name",
        "idempotency_key_hash",
        "request_hash",
        "status",
        "attempt_count",
        "remote_id",
        "remote_reference",
        "remote_status",
        "expense_id",
        "payment_id",
      ]) assert.equal(columns.includes(column), true, column);
      const indexes = all(db, "PRAGMA index_list(shortcut_bookkeeping_entries)")
        .map((row) => row.name);
      for (const index of [
        "idx_shortcut_bookkeeping_remote_identity",
        "idx_shortcut_bookkeeping_target",
        "idx_shortcut_bookkeeping_owner_status",
      ]) assert.equal(indexes.includes(index), true, index);
      assert.equal(
        all(db, "SELECT version FROM schema_migrations WHERE version = '0018'").length,
        1,
      );
      assert.match(
        all(db, "SELECT checksum FROM schema_migrations WHERE version = '0018'")[0].checksum,
        /^[a-f0-9]{64}$/u,
      );
      assert.equal(
        all(db, "SELECT version FROM schema_migrations WHERE version = '0020'").length,
        1,
      );
      const insertEntry = db.prepare(`
        INSERT INTO shortcut_bookkeeping_entries (
          id, owner, actor, target_system, ledger_name, entry_type, category,
          idempotency_key_hash, request_hash, raw_text, status
        ) VALUES (
          $id, 'owner-a', 'actor-a', 'sentelligent', '出差报销', $entryType, '交通',
          $idempotencyKeyHash, $requestHash, 'synthetic text', $status
        )
      `);
      insertEntry.run({
        $id: "valid-income-received",
        $entryType: "income",
        $idempotencyKeyHash: "a".repeat(64),
        $requestHash: "b".repeat(64),
        $status: "received",
      });
      insertEntry.run({
        $id: "valid-income-accepted",
        $entryType: "income",
        $idempotencyKeyHash: "e".repeat(64),
        $requestHash: "f".repeat(64),
        $status: "accepted",
      });
      assert.equal(
        all(db, "SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries WHERE entry_type = 'income'")[0].count,
        2,
      );
      assert.throws(
        () => insertEntry.run({
          $id: "invalid-accepted-without-finance-records",
          $entryType: "expense",
          $idempotencyKeyHash: "c".repeat(64),
          $requestHash: "d".repeat(64),
          $status: "accepted",
        }),
        /CHECK constraint failed/i,
      );
    } finally {
      db.close();
    }
  });
});

test("migration 0021 preserves encrypted settings and adds bounded PushPlus delivery metadata", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    db.exec(`
      CREATE TABLE secure_settings (
        setting_key TEXT PRIMARY KEY NOT NULL CHECK (setting_key IN ('icost_webhook_token', 'deepseek_api_key')),
        ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) > 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'active' AND ciphertext IS NOT NULL) OR (status = 'cleared' AND ciphertext IS NULL))
      );
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
      VALUES ('deepseek_api_key', 'ciphertext-fixture', 'active', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    `);

    applySecureSettingsPushplus(db);

    assert.deepEqual(columnNames(db, "secure_settings"), [
      "setting_key", "ciphertext", "status", "created_at", "rotated_at", "updated_at",
      "last_success_at", "last_failure_at", "last_error_code", "last_delivery_count", "last_chunk_count",
    ]);
    assert.deepEqual(
      {
        ...db.prepare("SELECT setting_key, ciphertext, status FROM secure_settings WHERE setting_key = 'deepseek_api_key'").get(),
      },
      { setting_key: "deepseek_api_key", ciphertext: "ciphertext-fixture", status: "active" },
    );

    db.prepare(`
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
      VALUES ('hospital_tender_pushplus_token', 'pushplus-ciphertext', 'active', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
    `).run();
    db.prepare(`
      UPDATE secure_settings
      SET last_delivery_count = 1, last_chunk_count = 1, last_error_code = 'notification_failed'
      WHERE setting_key = 'hospital_tender_pushplus_token'
    `).run();

    assert.throws(
      () => db.prepare(`
        INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
        VALUES ('hospital_tender_pushplus_token', NULL, 'active', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
      `).run(),
      /UNIQUE constraint failed|CHECK constraint failed/i,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
        VALUES ('invalid-setting', 'ciphertext', 'active', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
      `).run(),
      /CHECK constraint failed/i,
    );
  } finally {
    db.close();
  }
});

test("migration 0033 upgrades the direct 0021 active matrix without changing any existing field", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    applySecureSettings(db);
    applySecureSettingsPushplus(db);
    seedSecureSettingsMatrix(db, "active");
    const before = secureSettingsRows(db);

    db.exec("BEGIN IMMEDIATE");
    try {
      applySecureSettingsAsr(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    assert.deepEqual(columnNames(db, "secure_settings"), secureSettingsColumns);
    assert.deepEqual(secureSettingsRows(db), before);
    const tableSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secure_settings'
    `).get().sql;
    assert.match(tableSql, /asr_api_key/u);
    db.prepare(`
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
      VALUES ('asr_api_key', 'synthetic-asr-ciphertext', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run();
    assert.throws(() => db.prepare(`
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
      VALUES ('unknown_api_key', 'ciphertext', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run(), /CHECK constraint failed/i);
  } finally {
    db.close();
  }
});

test("migration 0033 upgrades the direct 0021 cleared matrix without changing any existing field", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    applySecureSettings(db);
    applySecureSettingsPushplus(db);
    seedSecureSettingsMatrix(db, "cleared");
    const before = secureSettingsRows(db);
    const beforeKeys = before.map((row) => row.setting_key);

    db.exec("BEGIN IMMEDIATE");
    try {
      applySecureSettingsAsr(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const after = secureSettingsRows(db);
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((row) => row.setting_key), beforeKeys);
    assert.equal(after.length, before.length);
  } finally {
    db.close();
  }
});

test("current migrations upgrade a complete 0032 database through 0033, 0034, and 0035 in order", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      rebuildDatabaseAs0032(db);
      seedSecureSettingsMatrix(db, "active");
      const rowsBefore = secureSettingsRows(db);
      const ledgerBefore = db.prepare(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      ).all().map((row) => ({ ...row }));
      assert.equal(ledgerBefore.length, 31);
      assert.equal(ledgerBefore.at(-1).version, "0032");
      assert.equal(databaseTableNames(db).includes("quick_record_confirmation_previews"), false);
      assert.equal(columnNames(db, "quick_records").includes("confirmation_preview_id"), false);
      assert.equal(columnNames(db, "quick_records").includes("confirmation_preview_status"), false);
      assert.equal(columnNames(db, "weekly_reports").includes("entries_json"), false);

      migrateDatabase(db);

      const ledgerAfter = db.prepare(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      ).all().map((row) => ({ ...row }));
      const added = ledgerAfter.filter((row) => !ledgerBefore.some((before) => before.version === row.version));
      assert.equal(ledgerAfter.length, 34);
      assert.deepEqual(added.map((row) => row.version), ["0033", "0034", "0035"]);
      assert.deepEqual(
        ledgerAfter.filter((row) => !["0033", "0034", "0035"].includes(row.version)),
        ledgerBefore,
      );
      const source = readFileSync(
        fileURLToPath(new URL("../src/db/migrations/0033_secure_settings_asr.mjs", import.meta.url)),
        "utf8",
      );
      assert.equal(migrationChecksum(source), SECURE_SETTINGS_ASR_CHECKSUM);
      assert.equal(added.find((row) => row.version === "0033").checksum, SECURE_SETTINGS_ASR_CHECKSUM);
      assert.deepEqual(secureSettingsRows(db), rowsBefore);
      assert.equal(databaseTableNames(db).includes("quick_record_confirmation_previews"), true);
      assert.equal(columnNames(db, "quick_records").includes("confirmation_preview_id"), true);
      assert.equal(columnNames(db, "quick_records").includes("confirmation_preview_status"), true);
      assert.equal(columnNames(db, "weekly_reports").includes("entries_json"), true);
    } finally {
      db.close();
    }
  });
});

test("migration 0033 remains idempotent on reopen without changing its ledger timestamp", () => {
  withDatabase((databaseUrl) => {
    const first = openDatabase({ databaseUrl });
    const firstLedger = { ...first.prepare(
      "SELECT version, checksum, applied_at FROM schema_migrations WHERE version = '0033'",
    ).get() };
    first.close();

    const second = openDatabase({ databaseUrl });
    try {
      const secondLedger = { ...second.prepare(
        "SELECT version, checksum, applied_at FROM schema_migrations WHERE version = '0033'",
      ).get() };
      assert.deepEqual(secondLedger, firstLedger);
      assert.equal(second.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0033'",
      ).get().count, 1);
    } finally {
      second.close();
    }
  });
});

test("migration 0033 restores the original table rows and ledger after a post-DDL failure", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      rebuildDatabaseAs0032(db);
      seedSecureSettingsMatrix(db, "cleared");
      const rowsBefore = secureSettingsRows(db);
      const tableSqlBefore = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secure_settings'
      `).get().sql;
      const ledgerBefore = db.prepare(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      ).all().map((row) => ({ ...row }));
      let injected = false;
      const guardedDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql) => {
              const result = target.exec(sql);
              if (
                !injected
                && typeof sql === "string"
                && sql.includes("ALTER TABLE secure_settings_next RENAME TO secure_settings")
              ) {
                injected = true;
                throw new Error("synthetic 0033 post-DDL failure");
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      assert.throws(
        () => migrateDatabase(guardedDb),
        /synthetic 0033 post-DDL failure/u,
      );
      assert.equal(injected, true);
      assert.equal(db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secure_settings'
      `).get().sql, tableSqlBefore);
      assert.deepEqual(secureSettingsRows(db), rowsBefore);
      assert.deepEqual(
        db.prepare("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version")
          .all().map((row) => ({ ...row })),
        ledgerBefore,
      );
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'secure_settings_next'
      `).get().count, 0);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0033'",
      ).get().count, 0);
    } finally {
      db.close();
    }
  });
});

test("migration 0033 checksum drift fails closed without changing settings or the stored ledger", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    db.prepare(`
      INSERT INTO secure_settings (setting_key, ciphertext, status, created_at, updated_at)
      VALUES ('asr_api_key', 'synthetic-asr-ciphertext', 'active', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run();
    const rowsBefore = secureSettingsRows(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'invalid-0033-checksum' WHERE version = '0033'").run();
    db.close();

    assert.throws(() => {
      const unexpected = openDatabase({ databaseUrl });
      unexpected.close();
    }, /Checksum mismatch for migration 0033/u);

    const readable = createConnection({ databaseUrl });
    try {
      assert.deepEqual(secureSettingsRows(readable), rowsBefore);
      assert.equal(
        readable.prepare("SELECT checksum FROM schema_migrations WHERE version = '0033'").get().checksum,
        "invalid-0033-checksum",
      );
    } finally {
      readable.close();
    }
  });
});

test("reconciles the former settings migration 0019 before applying Shortcut migrations", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      const settingsPath = fileURLToPath(
        new URL("../src/db/migrations/0021_secure_settings_pushplus.mjs", import.meta.url),
      );
      const legacySettingsChecksum = migrationChecksum(readFileSync(settingsPath, "utf8"));
      db.exec(`
        DROP TABLE weixin_confirmation_outbox;
        DELETE FROM schema_migrations WHERE version IN ('0019', '0020', '0021', '0022', '0023', '0024', '0025');
      `);
      db.prepare(`
        INSERT INTO schema_migrations (version, checksum, applied_at)
        VALUES ('0019', $checksum, '2026-08-20T00:00:00.000Z')
      `).run({ $checksum: legacySettingsChecksum });

      migrateDatabase(db);

      const reconciled = db.prepare(`
        SELECT version, checksum FROM schema_migrations
        WHERE version IN ('0019', '0020', '0021')
        ORDER BY version
      `).all();
      assert.deepEqual(reconciled.map((row) => row.version), ["0019", "0020", "0021"]);
      assert.equal(reconciled[2].checksum, legacySettingsChecksum);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
        34,
      );
    } finally {
      db.close();
    }
  });
});

test("refuses to relabel settings-as-0019 when the expected PushPlus schema is absent", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      const settingsPath = fileURLToPath(
        new URL("../src/db/migrations/0021_secure_settings_pushplus.mjs", import.meta.url),
      );
      const legacySettingsChecksum = migrationChecksum(readFileSync(settingsPath, "utf8"));
      db.exec(`
        DELETE FROM schema_migrations WHERE version IN ('0019', '0021');
        DROP TABLE secure_settings;
        CREATE TABLE secure_settings (
          setting_key TEXT PRIMARY KEY NOT NULL,
          ciphertext TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          rotated_at TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO schema_migrations (version, checksum, applied_at)
        VALUES ('0019', $checksum, '2026-08-20T00:00:00.000Z')
      `).run({ $checksum: legacySettingsChecksum });

      assert.throws(
        () => migrateDatabase(db),
        /Cannot reconcile legacy migration 0019/u,
      );
      assert.equal(
        db.prepare("SELECT version FROM schema_migrations WHERE version = '0019'").get().version,
        "0019",
      );
      assert.equal(
        db.prepare("SELECT version FROM schema_migrations WHERE version = '0021'").get(),
        undefined,
      );
    } finally {
      db.close();
    }
  });
});

test("migration 0013 adds constrained assistant confirmation closure state", () => {
  withDatabase((databaseUrl) => {
    const db = openDatabase({ databaseUrl });
    try {
      const attempts = columnInfo(db, "assistant_pending_actions", "confirmation_attempts");
      assert.deepEqual(
        { type: attempts?.type, notnull: attempts?.notnull, defaultValue: attempts?.dflt_value },
        { type: "INTEGER", notnull: 1, defaultValue: "0" },
      );
      assert.equal(columnInfo(db, "assistant_pending_actions", "confirmation_locked_at")?.type, "TEXT");
      assert.deepEqual(columnNames(db, "assistant_pending_actions"), [
        "id", "owner", "channel", "conversation_id", "action_type", "payload_json", "status",
        "version", "confirmation_code_hash", "lease_token_hash", "lease_expires_at", "expires_at",
        "result_json", "error_code", "created_at", "updated_at", "plan_digest",
        "confirmation_attempts", "confirmation_locked_at",
      ]);
      assert.deepEqual(indexColumns(db, "idx_assistant_actions_status"), [
        "owner", "channel", "status", "expires_at",
      ]);
      assert.deepEqual(indexColumns(db, "idx_assistant_actions_one_active_per_conversation"), [
        "owner", "channel", "conversation_id",
      ]);
      const activeIndexSql = all(db, `
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_assistant_actions_one_active_per_conversation'
      `)[0]?.sql;
      assert.match(activeIndexSql, /WHERE conversation_id IS NOT NULL AND status IN \('pending', 'processing', 'confirmed'\)/i);

      const pendingSql = all(db, `
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'assistant_pending_actions'
      `)[0]?.sql;
      assert.match(pendingSql, /CHECK\s*\(confirmation_attempts BETWEEN 0 AND 5\)/i);
      assert.throws(
        () => run(db, `
          INSERT INTO assistant_pending_actions (
            id, owner, channel, action_type, payload_json, confirmation_code_hash,
            expires_at, confirmation_attempts
          ) VALUES (
            'constraint-probe', 'synthetic-owner', 'weixin', 'create_expense', '{}',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '2026-08-12T12:00:00.000Z', 6
          )
        `),
        /CHECK constraint failed/i,
      );

      assert.deepEqual(
        all(db, "PRAGMA table_info(assistant_confirmation_attempts)")
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        ["action_id", "event_id_hash"],
      );
      const foreignKey = all(db, "PRAGMA foreign_key_list(assistant_confirmation_attempts)")[0];
      assert.deepEqual(
        { table: foreignKey?.table, from: foreignKey?.from, to: foreignKey?.to, onDelete: foreignKey?.on_delete },
        { table: "assistant_pending_actions", from: "action_id", to: "id", onDelete: "CASCADE" },
      );
    } finally {
      db.close();
    }
  });
});

test("migration 0013 preserves a legacy assistant action payload and plan digest", async () => {
  const syntheticLeaseDigest = "c".repeat(64);
  assert.match(syntheticLeaseDigest, /^[0-9a-f]{64}$/);
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE assistant_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE assistant_pending_actions (
        id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT REFERENCES assistant_conversations(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'confirmed', 'executed', 'expired', 'cancelled', 'failed')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        confirmation_code_hash TEXT NOT NULL CHECK (length(confirmation_code_hash) = 64 AND confirmation_code_hash NOT GLOB '*[^0-9a-f]*'),
        lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
        lease_expires_at TEXT,
        expires_at TEXT NOT NULL,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        plan_digest TEXT
      );
      CREATE INDEX idx_assistant_actions_status ON assistant_pending_actions(owner, channel, status, expires_at);
      CREATE UNIQUE INDEX idx_assistant_actions_one_active_per_conversation
        ON assistant_pending_actions(owner, channel, conversation_id)
        WHERE conversation_id IS NOT NULL AND status IN ('pending', 'processing', 'confirmed');
      INSERT INTO assistant_conversations (id) VALUES ('synthetic-conversation');
      INSERT INTO assistant_pending_actions (
        id, owner, channel, conversation_id, action_type, payload_json, status, version,
        confirmation_code_hash, lease_token_hash, lease_expires_at, expires_at, result_json,
        error_code, created_at, updated_at, plan_digest
      ) VALUES (
        'synthetic-action', 'synthetic-owner', 'weixin', 'synthetic-conversation', 'create_expense',
        '{"plan":{"toolName":"create_expense","arguments":{"amountCents":12850}}}', 'processing', 7,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '${syntheticLeaseDigest}',
        '2026-08-12T11:01:00.000Z', '2026-08-12T12:00:00.000Z',
        '{"syntheticResult":true}', 'SYNTHETIC_ERROR',
        '2026-08-12T10:00:00.000Z', '2026-08-12T11:00:00.000Z',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
    `);

    const { apply } = await import("../src/db/migrations/0013_assistant_confirmation_closure.mjs");
    apply(db);

    const row = db.prepare("SELECT * FROM assistant_pending_actions WHERE id = 'synthetic-action'").get();
    assert.equal(row.confirmation_attempts, 0);
    assert.equal(row.confirmation_locked_at, null);
    assert.deepEqual({ ...row }, {
      id: "synthetic-action",
      owner: "synthetic-owner",
      channel: "weixin",
      conversation_id: "synthetic-conversation",
      action_type: "create_expense",
      payload_json: '{"plan":{"toolName":"create_expense","arguments":{"amountCents":12850}}}',
      status: "processing",
      version: 7,
      confirmation_code_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lease_token_hash: syntheticLeaseDigest,
      lease_expires_at: "2026-08-12T11:01:00.000Z",
      expires_at: "2026-08-12T12:00:00.000Z",
      result_json: '{"syntheticResult":true}',
      error_code: "SYNTHETIC_ERROR",
      created_at: "2026-08-12T10:00:00.000Z",
      updated_at: "2026-08-12T11:00:00.000Z",
      plan_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      confirmation_attempts: 0,
      confirmation_locked_at: null,
    });

    db.prepare(`
      INSERT INTO assistant_confirmation_attempts (action_id, event_id_hash, created_at)
      VALUES ('synthetic-action', $hash, '2026-08-12T01:00:00.000Z')
    `).run({ $hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" });
    db.prepare("DELETE FROM assistant_pending_actions WHERE id = 'synthetic-action'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_confirmation_attempts").get().count, 0);
  } finally {
    db.close();
  }
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
      run(db, "INSERT INTO customers (id, name, owner) VALUES (:id, :name, 'jiangjz')", {
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
      Object.entries(rowsHashOmittedColumns).map(([table, omittedColumns]) => [
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
        Object.entries(rowsHashOmittedColumns).map(([table, omittedColumns]) => [
          table,
          rowsHash(migrated, table, omittedColumns),
        ]),
      );
      assert.deepEqual(hashesAfter, hashesBefore);
      assert.deepEqual(
        all(migrated, "SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version),
        ["0001", "0002", "0003", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035"],
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
      run(db, "INSERT INTO customers (id, name, owner) VALUES (:id, :name, 'jiangjz')", {
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
      run(db, "INSERT INTO customers (id, name, owner) VALUES ('raw-checksum-customer', 'Raw checksum customer', 'jiangjz')");
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
      assert.equal(all(db, "SELECT version FROM schema_migrations").length, 34);
    } finally {
      db.close();
    }
  });
});

test("migration 0029 normalizes legacy owner vocabulary", async () => {
  const { apply } = await import("../src/db/migrations/0029_owner_vocabulary_cleanup.mjs");
  // 0029 运行时点在 0031 触发器之前：用 pre-0031 最小表形态承载 NULL/别名 owner 夹具
  //（全链库的 owner 触发器会拒绝这类历史脏值的直插）。
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    db.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY, name TEXT, owner TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE opportunities (id TEXT PRIMARY KEY, customer_id TEXT, name TEXT, owner TEXT);
      CREATE TABLE action_items (id TEXT PRIMARY KEY, title TEXT, owner TEXT);
      CREATE TABLE quick_records (id TEXT PRIMARY KEY, raw_content TEXT, owner TEXT);
      CREATE TABLE weekly_reports (id TEXT PRIMARY KEY, owner TEXT, period_start TEXT, period_end TEXT, content TEXT);
      CREATE TABLE solution_drafts (id TEXT PRIMARY KEY, owner TEXT, title TEXT, content TEXT);
    `);
    db.exec(`
      INSERT INTO customers (id, name, owner) VALUES
        ('c-alias', '别名客户', '继振'),
        ('c-keep', '白名单外客户', 'other-user'),
        ('c-normal', '规范客户', 'jiangjz');
      INSERT INTO opportunities (id, customer_id, name, owner) VALUES
        ('o-alias', 'c-alias', '别名商机', '继振');
      INSERT INTO action_items (id, title, owner) VALUES
        ('a-alias', '别名待办', '继振'),
        ('a-null', '无主待办', NULL);
      INSERT INTO quick_records (id, raw_content, owner) VALUES
        ('q-legacy', '历史记录', 'legacy');
      INSERT INTO weekly_reports (id, owner, period_start, period_end, content) VALUES
        ('w-alias', '继振', '2026-07-06', '2026-07-12', '周报');
      INSERT INTO solution_drafts (id, owner, title, content) VALUES
        ('s-question', '??', '占位方案', '内容');
    `);
    const rowSnapshot = (table) => db.prepare(
      `SELECT * FROM ${table} ORDER BY id`,
    ).all().map((row) => {
      const { owner: _owner, ...rest } = row;
      return rest;
    });
    const beforeRows = Object.fromEntries(
      ["customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts"]
        .map((table) => [table, JSON.stringify(rowSnapshot(table))]),
    );
    const customerMetaBefore = db.prepare(
      "SELECT id, version, updated_at FROM customers ORDER BY id",
    ).all();

    apply(db);

    const owners = (table) => db.prepare(`SELECT id, owner FROM ${table} ORDER BY id`).all()
      .map((row) => ({ id: row.id, owner: row.owner }));
    assert.deepEqual(owners("customers"), [
      { id: "c-alias", owner: "jiangjz" },
      { id: "c-keep", owner: "other-user" },
      { id: "c-normal", owner: "jiangjz" },
    ]);
    assert.deepEqual(owners("opportunities"), [{ id: "o-alias", owner: "jiangjz" }]);
    assert.deepEqual(owners("action_items"), [
      { id: "a-alias", owner: "jiangjz" },
      { id: "a-null", owner: "jiangjz" },
    ]);
    assert.deepEqual(owners("quick_records"), [{ id: "q-legacy", owner: "jiangjz" }]);
    assert.deepEqual(owners("weekly_reports"), [{ id: "w-alias", owner: "jiangjz" }]);
    assert.deepEqual(owners("solution_drafts"), [{ id: "s-question", owner: "jiangjz" }]);

    // Everything except owner (including version and updated_at) is untouched.
    for (const [table, hash] of Object.entries(beforeRows)) {
      assert.equal(JSON.stringify(rowSnapshot(table)), hash, table);
    }
    assert.deepEqual(
      db.prepare("SELECT id, version, updated_at FROM customers ORDER BY id").all(),
      customerMetaBefore,
    );

    // Whitelist idempotence: a second run changes nothing at all.
    const fullSnapshot = () => JSON.stringify(
      ["customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts"]
        .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()),
    );
    const afterFirstApply = fullSnapshot();
    apply(db);
    assert.equal(fullSnapshot(), afterFirstApply);
  } finally {
    db.close();
  }
});

test("migration 0030 creates users and seeds the env admin", async () => {
  const { apply } = await import("../src/db/migrations/0030_users_table.mjs");
  const { hashPassword } = await import("../src/auth/password.js");
  const seedHashValue = await hashPassword("unit-seed-password", { salt: Buffer.alloc(16, 41) });
  const previousAccount = process.env.AUTH_ACCOUNT;
  const previousHash = process.env.AUTH_PASSWORD_HASH;
  const restoreEnv = () => {
    if (previousAccount === undefined) delete process.env.AUTH_ACCOUNT;
    else process.env.AUTH_ACCOUNT = previousAccount;
    if (previousHash === undefined) delete process.env.AUTH_PASSWORD_HASH;
    else process.env.AUTH_PASSWORD_HASH = previousHash;
  };
  const prepareActionItems = (db) => {
    db.exec(`
      CREATE TABLE action_items (id TEXT PRIMARY KEY, title TEXT, assignee TEXT);
      INSERT INTO action_items (id, title, assignee) VALUES
        ('a-owner', '账号 id 展示行', 'jiangjz'),
        ('a-other', '外部人名行', '张三'),
        ('a-null', '无主行', NULL);
    `);
  };

  try {
    // (a) 合法 env → 种子行 + assignee 回填（'张三' 与 NULL 不动）。
    process.env.AUTH_ACCOUNT = "jiangjz";
    process.env.AUTH_PASSWORD_HASH = seedHashValue;
    const seeded = createConnection({ databaseUrl: ":memory:" });
    try {
      prepareActionItems(seeded);
      apply(seeded);
      const user = seeded.prepare(
        "SELECT account, display_name, password_hash, role, status, version FROM users",
      ).get();
      assert.deepEqual({ ...user }, {
        account: "jiangjz",
        display_name: "继振",
        password_hash: seedHashValue,
        role: "admin",
        status: "active",
        version: 1,
      });
      assert.deepEqual(
        seeded.prepare("SELECT id, assignee FROM action_items ORDER BY id").all().map((row) => ({ ...row })),
        [
          { id: "a-null", assignee: null },
          { id: "a-other", assignee: "张三" },
          { id: "a-owner", assignee: "继振" },
        ],
      );

      // (c) CHECK 拒绝矩阵（与 0030 DDL 一致）。
      const insertUser = (overrides) => seeded.prepare(`
        INSERT INTO users (account, display_name, password_hash, role, status, version, created_at, updated_at)
        VALUES ($account, '校验', $hash, $role, $status, $version, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
      `).run({
        $account: "checkuser",
        $hash: seedHashValue,
        $role: "member",
        $status: "active",
        $version: 1,
        ...overrides,
      });
      assert.throws(() => insertUser({ $account: "UPPER" }), /CHECK constraint failed/i);
      assert.throws(() => insertUser({ $hash: "plain-text" }), /CHECK constraint failed/i);
      assert.throws(() => insertUser({ $role: "owner" }), /CHECK constraint failed/i);
      assert.throws(() => insertUser({ $status: "archived" }), /CHECK constraint failed/i);
      assert.throws(() => insertUser({ $version: 0 }), /CHECK constraint failed/i);
    } finally {
      seeded.close();
    }

    // (b) env 缺席（env-less 彩排语境）→ 建表成功、种子跳过、回填空转。
    delete process.env.AUTH_ACCOUNT;
    delete process.env.AUTH_PASSWORD_HASH;
    const envless = createConnection({ databaseUrl: ":memory:" });
    try {
      prepareActionItems(envless);
      apply(envless);
      assert.equal(envless.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
      assert.deepEqual(
        envless.prepare("SELECT id, assignee FROM action_items ORDER BY id").all().map((row) => ({ ...row })),
        [
          { id: "a-null", assignee: null },
          { id: "a-other", assignee: "张三" },
          { id: "a-owner", assignee: "jiangjz" },
        ],
      );
    } finally {
      envless.close();
    }

    // (d) 全链二跑幂等由版本账本保证：复跑 openDatabase 仍 1 行。
    process.env.AUTH_ACCOUNT = "jiangjz";
    process.env.AUTH_PASSWORD_HASH = seedHashValue;
    withDatabase((databaseUrl) => {
      const first = openDatabase({ databaseUrl });
      try {
        assert.equal(first.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
      } finally {
        first.close();
      }
      const second = openDatabase({ databaseUrl });
      try {
        assert.equal(second.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
        assert.equal(
          second.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0030'").get().count,
          1,
        );
      } finally {
        second.close();
      }
    });
  } finally {
    restoreEnv();
  }
});

test("migration 0031 tightens owner isolation", async () => {
  const { apply } = await import("../src/db/migrations/0031_owner_isolation_tightening.mjs");
  const addOwnerTables = [
    "risk_items", "visit_itineraries", "sales_decision_analyses", "knowledge_items", "ai_suggestions",
  ];
  const sweepTables = [
    "customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts",
  ];
  const guardTables = ["customers", "opportunities", "quick_records", "action_items"];
  const indexTables = [
    "customers", "opportunities", "action_items", "risk_items", "knowledge_items",
    "visit_itineraries", "sales_decision_analyses", "solution_drafts", "weekly_reports",
  ];
  // 0030 时点的最小表形态：SWEEP 六表已有 owner 列（0001/0012/0029 轨迹），✗五表无 owner 列。
  const prepareTables = (db) => {
    db.exec(`
      CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
      CREATE TABLE opportunities (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
      CREATE TABLE action_items (id TEXT PRIMARY KEY, title TEXT, owner TEXT);
      CREATE TABLE quick_records (id TEXT PRIMARY KEY, raw_content TEXT, owner TEXT);
      CREATE TABLE weekly_reports (id TEXT PRIMARY KEY, content TEXT, owner TEXT);
      CREATE TABLE solution_drafts (id TEXT PRIMARY KEY, title TEXT, owner TEXT);
      CREATE TABLE risk_items (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE visit_itineraries (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE sales_decision_analyses (id TEXT PRIMARY KEY, analysis_type TEXT);
      CREATE TABLE knowledge_items (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE ai_suggestions (id TEXT PRIMARY KEY, title TEXT);
    `);
    for (const table of sweepTables) {
      db.prepare(`INSERT INTO ${table} (id, owner) VALUES ($nullId, NULL), ($aliasId, '王五'), ($keepId, 'testb')`).run({
        $nullId: `${table}-null`,
        $aliasId: `${table}-alias`,
        $keepId: `${table}-keep`,
      });
    }
    for (const table of addOwnerTables) {
      db.prepare(`INSERT INTO ${table} (id) VALUES ($id)`).run({ $id: `${table}-legacy` });
    }
  };
  const owners = (db, table) => db.prepare(`SELECT id, owner FROM ${table} ORDER BY id`).all()
    .map((row) => ({ id: row.id, owner: row.owner }));

  // (a) 有 users 表：✗五表补列且存量回填 jiangjz；SWEEP 六表 NULL/词表外归一、词表内保留。
  const withUsers = createConnection({ databaseUrl: ":memory:" });
  try {
    prepareTables(withUsers);
    withUsers.exec(`
      CREATE TABLE users (account TEXT PRIMARY KEY);
      INSERT INTO users (account) VALUES ('jiangjz'), ('testb');
    `);
    apply(withUsers);
    for (const table of addOwnerTables) {
      const ownerColumn = withUsers.prepare(`PRAGMA table_info(${table})`).all()
        .find((column) => column.name === "owner");
      assert.equal(ownerColumn?.notnull, 1, `${table}.owner must be NOT NULL`);
      assert.equal(ownerColumn?.dflt_value, "'jiangjz'", `${table}.owner default`);
      assert.equal(
        withUsers.prepare(`SELECT owner FROM ${table} WHERE id = $id`).get({ $id: `${table}-legacy` })?.owner,
        "jiangjz",
        `${table} legacy row backfilled`,
      );
    }
    for (const table of sweepTables) {
      assert.deepEqual(owners(withUsers, table), [
        { id: `${table}-alias`, owner: "jiangjz" },
        { id: `${table}-keep`, owner: "testb" },
        { id: `${table}-null`, owner: "jiangjz" },
      ], `${table} sweep`);
    }

    // (c) 触发器矩阵：四表 NULL owner 的 INSERT 与 UPDATE 均 ABORT，带 owner 写入成功。
    for (const table of guardTables) {
      assert.throws(
        () => withUsers.prepare(`INSERT INTO ${table} (id, owner) VALUES ($id, NULL)`).run({ $id: `${table}-trigger-null` }),
        /owner must not be NULL/u,
        `${table} insert trigger`,
      );
      assert.throws(
        () => withUsers.prepare(`UPDATE ${table} SET owner = NULL WHERE id = $id`).run({ $id: `${table}-keep` }),
        /owner must not be NULL/u,
        `${table} update trigger`,
      );
      withUsers.prepare(`INSERT INTO ${table} (id, owner) VALUES ($id, 'jiangjz')`).run({ $id: `${table}-trigger-ok` });
      assert.equal(
        withUsers.prepare(`SELECT owner FROM ${table} WHERE id = $id`).get({ $id: `${table}-trigger-ok` })?.owner,
        "jiangjz",
        `${table} owner insert allowed`,
      );
    }

    // (d) 二次 apply 幂等：列/触发器/索引不重复、数据零变更。
    const snapshot = () => JSON.stringify([...sweepTables, ...addOwnerTables].map((table) => (
      withUsers.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    )));
    const beforeSecondApply = snapshot();
    apply(withUsers);
    assert.equal(snapshot(), beforeSecondApply, "second apply changes nothing");
    for (const table of guardTables) {
      assert.equal(
        withUsers.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = $table AND name LIKE 'trg_%owner_required%'",
        ).get({ $table: table }).count,
        2,
        `${table} keeps exactly two owner triggers`,
      );
    }

    // (e) 九枚 owner 过滤索引在位。
    for (const table of indexTables) {
      assert.equal(
        withUsers.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = $name",
        ).get({ $name: `idx_${table}_owner` }).count,
        1,
        `idx_${table}_owner`,
      );
    }
  } finally {
    withUsers.close();
  }

  // (b) 无 users 表（直连旧库单测语境）：仅 NULL 归一，词表外值保留。
  const withoutUsers = createConnection({ databaseUrl: ":memory:" });
  try {
    prepareTables(withoutUsers);
    apply(withoutUsers);
    for (const table of sweepTables) {
      assert.deepEqual(owners(withoutUsers, table), [
        { id: `${table}-alias`, owner: "王五" },
        { id: `${table}-keep`, owner: "testb" },
        { id: `${table}-null`, owner: "jiangjz" },
      ], `${table} null-only sweep`);
    }
  } finally {
    withoutUsers.close();
  }
});

test("migration 0032 creates weixin bindings and seeds the env binding", async () => {
  const { apply } = await import("../src/db/migrations/0032_weixin_bindings.mjs");
  const { hashPassword } = await import("../src/auth/password.js");
  const seedHashValue = await hashPassword("unit-seed-password", { salt: Buffer.alloc(16, 42) });
  const previousEnv = {
    AUTH_ACCOUNT: process.env.AUTH_ACCOUNT,
    WEIXIN_BOOKKEEPING_OWNER: process.env.WEIXIN_BOOKKEEPING_OWNER,
    WEIXIN_BOOKKEEPING_SENDER_ID: process.env.WEIXIN_BOOKKEEPING_SENDER_ID,
  };
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const prepareUsers = (db) => {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE users (
        account TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO users (account, display_name, password_hash, created_at, updated_at)
      VALUES ('jiangjz', '继振', $hash, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
    `).run({ $hash: seedHashValue });
  };

  try {
    // (a) 带 env → 种子行 financial=1/digest=1/active，bound_by=system:bootstrap。
    process.env.WEIXIN_BOOKKEEPING_OWNER = "jiangjz";
    process.env.WEIXIN_BOOKKEEPING_SENDER_ID = "seed-sender-1";
    const seeded = createConnection({ databaseUrl: ":memory:" });
    try {
      prepareUsers(seeded);
      apply(seeded);
      const binding = seeded.prepare(
        "SELECT sender_id, account, display_name, financial_enabled, digest_enabled, status, bound_by, version FROM weixin_bindings",
      ).get();
      assert.deepEqual({ ...binding }, {
        sender_id: "seed-sender-1",
        account: "jiangjz",
        display_name: null,
        financial_enabled: 1,
        digest_enabled: 1,
        status: "active",
        bound_by: "system:bootstrap",
        version: 1,
      });

      // (c) CHECK 矩阵：status 非法、financial=2、双 active 同 account 违反 partial index、FK 拒绝幽灵账号。
      const insertBinding = (overrides = {}) => seeded.prepare(`
        INSERT INTO weixin_bindings
          (sender_id, account, financial_enabled, digest_enabled, status, bound_at, bound_by, created_at, updated_at)
        VALUES ($senderId, $account, $financial, 1, $status, '2026-08-29T00:00:00.000Z', 'unit', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
      `).run({
        $senderId: "check-sender",
        $account: "jiangjz",
        $financial: 0,
        $status: "active",
        ...overrides,
      });
      assert.throws(() => insertBinding({ $status: "archived" }), /CHECK constraint failed/i);
      assert.throws(() => insertBinding({ $financial: 2 }), /CHECK constraint failed/i);
      assert.throws(() => insertBinding(), /UNIQUE constraint failed/i, "one active binding per account");
      assert.throws(
        () => insertBinding({ $account: "ghostacct", $senderId: "ghost-sender" }),
        /FOREIGN KEY constraint failed/i,
      );
      // disabled 行不占 one-active 名额。
      insertBinding({ $status: "disabled" });
      assert.equal(seeded.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 2);

      // codes 表可写、码明文列不存在（只有 code_hash）。
      const codeColumns = seeded.prepare("PRAGMA table_info(weixin_binding_codes)").all().map((row) => row.name);
      assert.deepEqual(codeColumns, ["code_hash", "account", "expires_at", "used_at", "created_by", "created_at"]);
    } finally {
      seeded.close();
    }

    // (b) env-less 彩排：建表成功、种子跳过。
    delete process.env.WEIXIN_BOOKKEEPING_OWNER;
    delete process.env.WEIXIN_BOOKKEEPING_SENDER_ID;
    delete process.env.AUTH_ACCOUNT;
    const envless = createConnection({ databaseUrl: ":memory:" });
    try {
      prepareUsers(envless);
      apply(envless);
      assert.equal(envless.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 0);
    } finally {
      envless.close();
    }

    // (b2) 带 sender 但 users 无该账号（种子前置缺席）：跳过种子而不是违反 FK。
    process.env.WEIXIN_BOOKKEEPING_OWNER = "ghostacct";
    process.env.WEIXIN_BOOKKEEPING_SENDER_ID = "seed-sender-1";
    const ghost = createConnection({ databaseUrl: ":memory:" });
    try {
      prepareUsers(ghost);
      apply(ghost);
      assert.equal(ghost.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 0);
    } finally {
      ghost.close();
    }

    // (d) 全链二跑幂等：版本账本保证 0032 只应用一次。
    process.env.AUTH_ACCOUNT = "jiangjz";
    process.env.WEIXIN_BOOKKEEPING_OWNER = "jiangjz";
    process.env.WEIXIN_BOOKKEEPING_SENDER_ID = "seed-sender-1";
    const previousHash = process.env.AUTH_PASSWORD_HASH;
    process.env.AUTH_PASSWORD_HASH = seedHashValue;
    try {
      withDatabase((databaseUrl) => {
        const first = openDatabase({ databaseUrl });
        try {
          assert.equal(first.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 1);
        } finally {
          first.close();
        }
        const second = openDatabase({ databaseUrl });
        try {
          assert.equal(second.prepare("SELECT COUNT(*) AS count FROM weixin_bindings").get().count, 1);
          assert.equal(
            second.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '0032'").get().count,
            1,
          );
        } finally {
          second.close();
        }
      });
    } finally {
      if (previousHash === undefined) delete process.env.AUTH_PASSWORD_HASH;
      else process.env.AUTH_PASSWORD_HASH = previousHash;
    }
  } finally {
    restoreEnv();
  }
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
        Object.entries(rowsHashOmittedColumns).map(([table, omittedColumns]) => [
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
        Object.entries(rowsHashOmittedColumns).map(([table, omittedColumns]) => [
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
        ["0001", "0002", "0003", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035"],
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
