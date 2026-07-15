import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { all, openDatabase, run } from "../src/db.js";

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
      run(db, "UPDATE schema_migrations SET checksum = :checksum WHERE version = :version", {
        checksum: "not-the-baseline-checksum",
        version: "0001"
      });
    } finally {
      db?.close();
    }

    assert.throws(
      () => openDatabase({ databaseUrl }),
      /migration 0001/i
    );
  });
});
