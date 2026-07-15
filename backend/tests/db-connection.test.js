import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createConnection, resolveDatabasePath } from "../src/db/connection.js";

test("resolves file URLs to filesystem paths", () => {
  const databasePath = join(tmpdir(), "sentelligent-workbench.sqlite");
  assert.equal(
    resolveDatabasePath(pathToFileURL(databasePath).href),
    databasePath
  );
});

test("file-backed connections apply the SQLite durability and concurrency policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "sentelligent-db-connection-"));
  const databaseUrl = join(directory, "nested", "workbench.sqlite");

  try {
    const db = createConnection({ databaseUrl });
    try {
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
      assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory connections keep foreign keys and timeout policy without requiring WAL", () => {
  const db = createConnection({ databaseUrl: ":memory:" });
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "memory");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 1);
  } finally {
    db.close();
  }
});
