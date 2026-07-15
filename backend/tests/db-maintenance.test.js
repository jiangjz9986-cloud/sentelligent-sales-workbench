import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  backupDatabase,
  installRestoreCandidate,
  inspectDatabase,
  restoreDatabase,
  snapshotRestoreSource,
} from "../scripts/db-maintenance.mjs";
import { all, openDatabase, run } from "../src/db.js";
import {
  createConnection,
  databaseMaintenanceLockPath,
  databaseOpeningMarkerPrefix,
} from "../src/db/connection.js";
import { seedDatabase } from "../src/seed.js";

function seedTestDatabase(databaseUrl) {
  const db = openDatabase({ databaseUrl });
  seedDatabase(db);
  db.close();
}

function runDbCheck(databaseUrl) {
  const scriptPath = fileURLToPath(new URL("../scripts/db-check.mjs", import.meta.url));
  const backendRoot = fileURLToPath(new URL("..", import.meta.url));
  return spawnSync(process.execPath, [scriptPath], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
}

function createLegacyActionDatabase(databaseUrl) {
  const db = createConnection({ databaseUrl });
  try {
    db.exec(`
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
      )
    `);
    run(db, "INSERT INTO action_items (id, title) VALUES ('legacy-action', 'Legacy action')");
  } finally {
    db.close();
  }
}

function corruptTableRootPage(databaseUrl, tableName) {
  const db = createConnection({ databaseUrl });
  let pageSize;
  let rootPage;
  try {
    pageSize = db.prepare("PRAGMA page_size").get().page_size;
    rootPage = db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName).rootpage;
  } finally {
    db.close();
  }
  const bytes = readFileSync(databaseUrl);
  const offset = (rootPage - 1) * pageSize;
  bytes.fill(0, offset, Math.min(offset + 16, bytes.length));
  writeFileSync(databaseUrl, bytes);
}

describe("sqlite maintenance", () => {
  it("backs up and restores the lightweight database with a pre-restore snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupDir = join(root, "backups");

    try {
      seedTestDatabase(databaseUrl);
      const before = inspectDatabase({ databaseUrl });
      const backup = backupDatabase({ databaseUrl, backupDir, label: "before-change" });

      assert.equal(before.quickCheck, "ok");
      assert.deepEqual(before.foreignKeyViolations, []);
      assert.equal(before.pragmas.foreignKeys, 1);
      assert.equal(before.pragmas.journalMode, "wal");
      assert.equal(before.pragmas.busyTimeout, 5000);
      assert.equal(Object.keys(before.tableCounts).length, 12);
      assert.deepEqual(before.tables, before.tableCounts);
      assert.equal(backup.status, "backed_up");
      assert.equal(existsSync(backup.backupPath), true);
      assert.equal(backup.databasePath, databaseUrl);

      const db = openDatabase({ databaseUrl });
      run(db, "DELETE FROM customers WHERE id = $id", { $id: "rizhao" });
      const reducedCount = all(db, "SELECT * FROM customers").length;
      db.close();
      assert.equal(reducedCount, before.tables.customers - 1);

      const restored = restoreDatabase({
        databaseUrl,
        backupPath: backup.backupPath,
        backupDir,
      });

      assert.equal(restored.status, "restored");
      assert.equal(existsSync(restored.preRestoreBackupPath), true);
      assert.match(readFileSync(restored.preRestoreBackupPath).subarray(0, 16).toString("utf8"), /SQLite format/);

      const info = inspectDatabase({ databaseUrl });
      assert.equal(info.status, "ready");
      assert.equal(info.tables.customers, before.tables.customers);
      assert.equal(info.tables.opportunities, before.tables.opportunities);
      assert.equal(existsSync(databaseMaintenanceLockPath(databaseUrl)), false);
      assert.equal(readdirSync(join(root, "data")).some((name) => name.includes("restore-rollback")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses restore while the live database has active WAL sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-wal-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const sourceBackupDir = join(root, "source-backups");
    const backupDir = join(root, "restore-backups");
    let liveDatabase;

    try {
      seedTestDatabase(databaseUrl);
      const backup = backupDatabase({ databaseUrl, backupDir: sourceBackupDir, label: "before-wal-write" });

      liveDatabase = openDatabase({ databaseUrl });
      run(liveDatabase, "DELETE FROM customers WHERE id = $id", { $id: "rizhao" });
      const expectedCustomers = all(liveDatabase, "SELECT id FROM customers ORDER BY id").map((row) => row.id);

      assert.equal(existsSync(`${databaseUrl}-wal`), true);
      assert.equal(existsSync(`${databaseUrl}-shm`), true);
      assert.equal(existsSync(backupDir), false);
      const beforeRestore = {
        rootEntries: readdirSync(root).sort(),
        databaseEntries: readdirSync(join(root, "data")).sort(),
        database: readFileSync(databaseUrl),
        wal: readFileSync(`${databaseUrl}-wal`),
        shm: readFileSync(`${databaseUrl}-shm`)
      };
      assert.throws(
        () => restoreDatabase({ databaseUrl, backupPath: backup.backupPath, backupDir }),
        /stop the service and checkpoint first/i
      );
      assert.equal(existsSync(backupDir), false);
      assert.deepEqual(readdirSync(root).sort(), beforeRestore.rootEntries);
      assert.deepEqual(readdirSync(join(root, "data")).sort(), beforeRestore.databaseEntries);
      assert.deepEqual(readFileSync(databaseUrl), beforeRestore.database);
      assert.deepEqual(readFileSync(`${databaseUrl}-wal`), beforeRestore.wal);
      assert.deepEqual(readFileSync(`${databaseUrl}-shm`), beforeRestore.shm);
      assert.deepEqual(
        all(liveDatabase, "SELECT id FROM customers ORDER BY id").map((row) => row.id),
        expectedCustomers
      );

      liveDatabase.close();
      liveDatabase = null;
      const reopened = openDatabase({ databaseUrl });
      try {
        assert.deepEqual(
          all(reopened, "SELECT id FROM customers ORDER BY id").map((row) => row.id),
          expectedCustomers
        );
      } finally {
        reopened.close();
      }
    } finally {
      liveDatabase?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints a healthy 12-table integrity report from the db-check command", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-"));
    const databaseUrl = join(root, "sales-workbench.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      const result = runDbCheck(databaseUrl);

      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.databasePath, databaseUrl);
      assert.equal(report.quickCheck, "ok");
      assert.deepEqual(report.foreignKeyViolations, []);
      assert.equal(report.pragmas.busyTimeout, 5000);
      assert.equal(Object.keys(report.tableCounts).length, 12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a failing db-check report for foreign key violations", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-foreign-key-"));
    const databaseUrl = join(root, "sales-workbench.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      const invalid = createConnection({ databaseUrl });
      try {
        invalid.exec("PRAGMA foreign_keys = OFF");
        const update = run(
          invalid,
          "UPDATE opportunities SET customer_id = 'missing-customer' WHERE id = (SELECT id FROM opportunities LIMIT 1)",
        );
        assert.equal(update.changes, 1);
      } finally {
        invalid.close();
      }

      assert.equal(inspectDatabase({ databaseUrl }).status, "invalid");
      const result = runDbCheck(databaseUrl);
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.quickCheck, "ok");
      assert.equal(report.foreignKeyViolations.length, 1);
      assert.equal(report.foreignKeyViolations[0].table, "opportunities");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects a DELETE-journal database without changing its file or directory entries", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-read-only-"));
    const databaseUrl = join(root, "sales-workbench.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      const db = createConnection({ databaseUrl });
      db.exec("PRAGMA journal_mode = DELETE");
      db.close();
      const beforeBytes = readFileSync(databaseUrl);
      const beforeEntries = readdirSync(root).sort();

      const report = inspectDatabase({ databaseUrl });

      assert.equal(report.status, "ready");
      assert.equal(report.pragmas.journalMode, "delete");
      assert.deepEqual(readFileSync(databaseUrl), beforeBytes);
      assert.deepEqual(readdirSync(root).sort(), beforeEntries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects a clean WAL database without creating persistent sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-clean-wal-"));
    const databaseUrl = join(root, "sales-workbench.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      assert.equal(existsSync(`${databaseUrl}-wal`), false);
      assert.equal(existsSync(`${databaseUrl}-shm`), false);
      const beforeBytes = readFileSync(databaseUrl);
      const beforeEntries = readdirSync(root).sort();

      const report = inspectDatabase({ databaseUrl });

      assert.equal(report.status, "ready");
      assert.equal(report.pragmas.journalMode, "wal");
      assert.deepEqual(readFileSync(databaseUrl), beforeBytes);
      assert.deepEqual(readdirSync(root).sort(), beforeEntries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an active WAL database as busy without changing its sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-active-wal-"));
    const databaseUrl = join(root, "sales-workbench.sqlite");
    let active;

    try {
      seedTestDatabase(databaseUrl);
      active = openDatabase({ databaseUrl });
      run(active, "UPDATE customers SET summary = 'active write' WHERE id = 'rizhao'");
      const beforeWal = readFileSync(`${databaseUrl}-wal`);
      const beforeShm = readFileSync(`${databaseUrl}-shm`);

      const directReport = inspectDatabase({ databaseUrl });
      assert.equal(directReport.status, "invalid");
      assert.equal(directReport.error.code, "DATABASE_BUSY");

      const result = runDbCheck(databaseUrl);
      assert.equal(result.status, 1);
      const cliReport = JSON.parse(result.stdout);
      assert.equal(cliReport.error.code, "DATABASE_BUSY");
      assert.deepEqual(readFileSync(`${databaseUrl}-wal`), beforeWal);
      assert.deepEqual(readFileSync(`${databaseUrl}-shm`), beforeShm);
    } finally {
      active?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create a database when db-check targets a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-missing-"));
    const databaseUrl = join(root, "missing.sqlite");

    try {
      const directReport = inspectDatabase({ databaseUrl });
      assert.equal(directReport.status, "invalid");
      assert.equal(directReport.error.code, "DATABASE_NOT_FOUND");
      assert.equal(existsSync(databaseUrl), false);

      const result = runDbCheck(databaseUrl);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.error.code, "DATABASE_NOT_FOUND");
      assert.equal(report.quickCheck, "error");
      assert.equal(report.foreignKeyViolations, null);
      assert.equal(Object.keys(report.tableCounts).length, 12);
      assert.equal(existsSync(databaseUrl), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns stable JSON without modifying a corrupt database", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-check-corrupt-"));
    const databaseUrl = join(root, "corrupt.sqlite");

    try {
      writeFileSync(databaseUrl, "not a sqlite database");
      const beforeBytes = readFileSync(databaseUrl);
      const beforeEntries = readdirSync(root).sort();

      const result = runDbCheck(databaseUrl);

      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.error.code, "INSPECTION_FAILED");
      assert.equal(report.quickCheck, "error");
      assert.equal(report.foreignKeyViolations, null);
      assert.equal(Object.keys(report.tableCounts).length, 12);
      assert.deepEqual(readFileSync(databaseUrl), beforeBytes);
      assert.deepEqual(readdirSync(root).sort(), beforeEntries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a checksum-drifted offline database byte-for-byte before restoring", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-drifted-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupDir = join(root, "backups");

    try {
      seedTestDatabase(databaseUrl);
      const backup = backupDatabase({ databaseUrl, backupDir, label: "known-good" });
      const knownGood = openDatabase({ databaseUrl });
      const knownGoodChecksum = all(knownGood, "SELECT checksum FROM schema_migrations WHERE version = '0001'")[0].checksum;
      knownGood.close();
      const drifted = createConnection({ databaseUrl });
      try {
        run(drifted, "UPDATE schema_migrations SET checksum = 'drifted-checksum' WHERE version = '0001'");
      } finally {
        drifted.close();
      }
      const driftedBytes = readFileSync(databaseUrl);
      assert.equal(existsSync(`${databaseUrl}-wal`), false);
      assert.equal(existsSync(`${databaseUrl}-shm`), false);

      const restored = restoreDatabase({ databaseUrl, backupPath: backup.backupPath, backupDir });

      assert.deepEqual(readFileSync(restored.preRestoreBackupPath), driftedBytes);
      const db = openDatabase({ databaseUrl });
      try {
        assert.equal(all(db, "SELECT checksum FROM schema_migrations WHERE version = '0001'")[0].checksum, knownGoodChecksum);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves an unstamped legacy live database byte-identical when candidate validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-invalid-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupPath = join(root, "invalid-backup.sqlite");
    const backupDir = join(root, "backups");

    try {
      createLegacyActionDatabase(databaseUrl);
      writeFileSync(backupPath, "not a sqlite database");
      const liveBytes = readFileSync(databaseUrl);
      assert.equal(existsSync(`${databaseUrl}-wal`), false);
      assert.equal(existsSync(`${databaseUrl}-shm`), false);

      assert.throws(() => restoreDatabase({ databaseUrl, backupPath, backupDir }));

      assert.deepEqual(readFileSync(databaseUrl), liveBytes);
      const live = createConnection({ databaseUrl });
      try {
        assert.equal(all(live, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").length, 0);
        assert.equal(all(live, "PRAGMA table_info(action_items)").some((column) => column.name === "assignee"), false);
      } finally {
        live.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a structurally empty sqlite backup before migrations can make it look valid", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-empty-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupPath = join(root, "empty.sqlite");
    const backupDir = join(root, "backups");

    try {
      seedTestDatabase(databaseUrl);
      const empty = createConnection({ databaseUrl: backupPath });
      empty.exec("PRAGMA journal_mode = DELETE");
      empty.close();
      const liveBytes = readFileSync(databaseUrl);

      assert.throws(
        () => restoreDatabase({ databaseUrl, backupPath, backupDir }),
        /missing required tables/i,
      );
      assert.deepEqual(readFileSync(databaseUrl), liveBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a backup source with active WAL sidecars before copying stale data", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-source-wal-"));
    const databaseUrl = join(root, "live", "sales-workbench.sqlite");
    const sourceDatabaseUrl = join(root, "source", "backup.sqlite");
    const backupDir = join(root, "restore-backups");
    let sourceDatabase;

    try {
      seedTestDatabase(databaseUrl);
      seedTestDatabase(sourceDatabaseUrl);
      sourceDatabase = openDatabase({ databaseUrl: sourceDatabaseUrl });
      run(sourceDatabase, "DELETE FROM customers WHERE id = $id", { $id: "rizhao" });
      assert.equal(existsSync(`${sourceDatabaseUrl}-wal`), true);
      assert.equal(existsSync(`${sourceDatabaseUrl}-shm`), true);
      const liveBytes = readFileSync(databaseUrl);
      const walBytes = readFileSync(`${sourceDatabaseUrl}-wal`);
      const shmBytes = readFileSync(`${sourceDatabaseUrl}-shm`);

      assert.throws(
        () => restoreDatabase({ databaseUrl, backupPath: sourceDatabaseUrl, backupDir }),
        /backup source.*WAL sidecars/i,
      );
      assert.deepEqual(readFileSync(databaseUrl), liveBytes);
      assert.deepEqual(readFileSync(`${sourceDatabaseUrl}-wal`), walBytes);
      assert.deepEqual(readFileSync(`${sourceDatabaseUrl}-shm`), shmBytes);
      assert.equal(existsSync(backupDir), false);
    } finally {
      sourceDatabase?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a transactionally consistent candidate from a WAL-backed source", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-snapshot-"));
    const sourceDatabaseUrl = join(root, "source.sqlite");
    const candidatePath = join(root, "candidate.sqlite");
    let sourceDatabase;

    try {
      seedTestDatabase(sourceDatabaseUrl);
      sourceDatabase = openDatabase({ databaseUrl: sourceDatabaseUrl });
      run(sourceDatabase, "DELETE FROM customers WHERE id = $id", { $id: "rizhao" });
      const expectedCustomerIds = all(sourceDatabase, "SELECT id FROM customers ORDER BY id")
        .map((row) => row.id);
      assert.equal(existsSync(`${sourceDatabaseUrl}-wal`), true);

      snapshotRestoreSource({ sourcePath: sourceDatabaseUrl, candidatePath });

      const candidate = openDatabase({ databaseUrl: candidatePath });
      try {
        assert.deepEqual(
          all(candidate, "SELECT id FROM customers ORDER BY id").map((row) => row.id),
          expectedCustomerIds,
        );
      } finally {
        candidate.close();
      }
    } finally {
      sourceDatabase?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt restore candidate before replacing the live database", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-corrupt-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupDir = join(root, "backups");
    const corruptBackupPath = join(root, "corrupt.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      const backup = backupDatabase({ databaseUrl, backupDir, label: "valid" });
      copyFileSync(backup.backupPath, corruptBackupPath);
      corruptTableRootPage(corruptBackupPath, "customers");
      const liveBytes = readFileSync(databaseUrl);

      assert.throws(
        () => restoreDatabase({ databaseUrl, backupPath: corruptBackupPath, backupDir }),
        /integrity|quick_check|malformed/i
      );
      assert.deepEqual(readFileSync(databaseUrl), liveBytes);
      const live = openDatabase({ databaseUrl });
      try {
        assert.equal(all(live, "PRAGMA quick_check")[0].quick_check, "ok");
      } finally {
        live.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a restore candidate with foreign key violations", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-foreign-key-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupDir = join(root, "backups");
    const invalidBackupPath = join(root, "foreign-key-violation.sqlite");

    try {
      seedTestDatabase(databaseUrl);
      const backup = backupDatabase({ databaseUrl, backupDir, label: "valid" });
      copyFileSync(backup.backupPath, invalidBackupPath);
      const invalid = createConnection({ databaseUrl: invalidBackupPath });
      try {
        invalid.exec("PRAGMA foreign_keys = OFF");
        const result = run(
          invalid,
          "UPDATE opportunities SET customer_id = 'missing-customer' WHERE id = (SELECT id FROM opportunities LIMIT 1)"
        );
        assert.equal(result.changes, 1);
      } finally {
        invalid.close();
      }
      const liveBytes = readFileSync(databaseUrl);

      assert.throws(
        () => restoreDatabase({ databaseUrl, backupPath: invalidBackupPath, backupDir }),
        /foreign.key/i
      );
      assert.deepEqual(readFileSync(databaseUrl), liveBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the previous database file when installed-candidate validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-rollback-"));
    const databaseUrl = join(root, "live.sqlite");
    const candidatePath = join(root, "candidate.sqlite");

    try {
      writeFileSync(databaseUrl, "original-live-database");
      writeFileSync(candidatePath, "replacement-candidate");

      assert.throws(
        () => installRestoreCandidate({
          databaseUrl,
          candidatePath,
          validate: (installedPath) => {
            assert.equal(installedPath, databaseUrl);
            assert.equal(readFileSync(databaseUrl, "utf8"), "replacement-candidate");
            const rollbackName = readdirSync(root).find((name) => name.includes("restore-rollback"));
            assert.ok(rollbackName);
            assert.equal(readFileSync(join(root, rollbackName), "utf8"), "original-live-database");
            throw new Error("post-install validation failed");
          },
        }),
        /post-install validation failed/
      );
      assert.equal(readFileSync(databaseUrl, "utf8"), "original-live-database");
      assert.equal(existsSync(candidatePath), false);
      assert.equal(existsSync(databaseMaintenanceLockPath(databaseUrl)), false);
      assert.equal(readdirSync(root).some((name) => name.includes("restore-rollback")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to install a restore candidate that still has sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-candidate-wal-"));
    const databaseUrl = join(root, "live.sqlite");
    const candidatePath = join(root, "candidate.sqlite");

    try {
      writeFileSync(databaseUrl, "original-live-database");
      writeFileSync(candidatePath, "replacement-candidate");
      writeFileSync(`${candidatePath}-wal`, "active wal");
      writeFileSync(`${candidatePath}-shm`, "active shm");

      assert.throws(
        () => installRestoreCandidate({ databaseUrl, candidatePath, validate: () => {} }),
        /restore candidate.*WAL sidecars/i,
      );
      assert.equal(readFileSync(databaseUrl, "utf8"), "original-live-database");
      assert.equal(readFileSync(candidatePath, "utf8"), "replacement-candidate");
      assert.equal(readFileSync(`${candidatePath}-wal`, "utf8"), "active wal");
      assert.equal(readFileSync(`${candidatePath}-shm`, "utf8"), "active shm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not remove a maintenance lock owned by another restore process", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-existing-lock-"));
    const databaseUrl = join(root, "live.sqlite");
    const candidatePath = join(root, "candidate.sqlite");
    const lockPath = databaseMaintenanceLockPath(databaseUrl);

    try {
      writeFileSync(databaseUrl, "original-live-database");
      writeFileSync(candidatePath, "replacement-candidate");
      writeFileSync(lockPath, "owned by another process");

      assert.throws(
        () => installRestoreCandidate({ databaseUrl, candidatePath, validate: () => {} }),
        /maintenance is already in progress/i,
      );
      assert.equal(readFileSync(lockPath, "utf8"), "owned by another process");
      assert.equal(readFileSync(databaseUrl, "utf8"), "original-live-database");
      assert.equal(readFileSync(candidatePath, "utf8"), "replacement-candidate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to swap files while another process is opening the live database", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-opening-"));
    const databaseUrl = join(root, "live.sqlite");
    const candidatePath = join(root, "candidate.sqlite");
    const openingMarker = `${databaseOpeningMarkerPrefix(databaseUrl)}other-process.lock`;

    try {
      writeFileSync(databaseUrl, "original-live-database");
      writeFileSync(candidatePath, "replacement-candidate");
      writeFileSync(openingMarker, "connection opening");

      assert.throws(
        () => installRestoreCandidate({ databaseUrl, candidatePath, validate: () => {} }),
        /database connection is opening/i,
      );
      assert.equal(readFileSync(databaseUrl, "utf8"), "original-live-database");
      assert.equal(readFileSync(candidatePath, "utf8"), "replacement-candidate");
      assert.equal(readFileSync(openingMarker, "utf8"), "connection opening");
      assert.equal(existsSync(databaseMaintenanceLockPath(databaseUrl)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
