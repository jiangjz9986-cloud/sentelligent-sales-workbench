import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
} from "../scripts/db-maintenance.mjs";
import { all, openDatabase, run } from "../src/db.js";
import { seedDatabase } from "../src/seed.js";

function seedTestDatabase(databaseUrl) {
  const db = openDatabase({ databaseUrl });
  seedDatabase(db);
  db.close();
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
});
