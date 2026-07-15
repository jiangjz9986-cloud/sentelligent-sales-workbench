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
import { canonicalMigrationSource, migrateDatabase, migrationChecksum } from "../src/db/migrate.js";

function withDatabase(testBody) {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-migrations-"));
  const databaseUrl = join(directory, "workbench.sqlite");

  try {
    testBody(databaseUrl);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("records baseline migration 0001 exactly once and remains idempotent on reopen", () => {
  withDatabase((databaseUrl) => {
    let first;
    let second;

    try {
      first = openDatabase({ databaseUrl });
      const firstMigrations = all(first, "SELECT version, checksum FROM schema_migrations ORDER BY version");

      second = openDatabase({ databaseUrl });
      const secondMigrations = all(second, "SELECT version, checksum FROM schema_migrations ORDER BY version");

      assert.equal(firstMigrations.length, 1);
      assert.equal(firstMigrations[0].version, "0001");
      assert.match(firstMigrations[0].checksum, /^[a-f0-9]{64}$/);
      assert.deepEqual(secondMigrations, firstMigrations);
    } finally {
      second?.close();
      first?.close();
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
      assert.equal(all(db, "SELECT version FROM schema_migrations").length, 1);
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
