import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
} from "../scripts/db-maintenance.mjs";
import { all, openDatabase, run } from "../src/db.js";
import { createConnection } from "../src/db/connection.js";
import { seedDatabase } from "../src/seed.js";

function seedTestDatabase(databaseUrl) {
  const db = openDatabase({ databaseUrl });
  seedDatabase(db);
  db.close();
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

describe("sqlite maintenance", () => {
  it("backs up and restores the lightweight database with a pre-restore snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-db-maint-"));
    const databaseUrl = join(root, "data", "sales-workbench.sqlite");
    const backupDir = join(root, "backups");

    try {
      seedTestDatabase(databaseUrl);
      const before = inspectDatabase({ databaseUrl });
      const backup = backupDatabase({ databaseUrl, backupDir, label: "before-change" });

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
});
