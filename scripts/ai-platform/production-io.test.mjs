import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { privateFile, atomicReplace, backupSqlite } from "./production-io.mjs";
import { hashBytes } from "./production-contract.mjs";

test("protected files reject links and drift before a configuration replacement", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "transition-files-")));
  const path = join(root, "config.env");
  const options = { ownerUid: process.getuid?.() ?? 0 };
  try {
    writeFileSync(path, "SETTING=old\n", { mode: 0o600 });
    const expected = hashBytes(readFileSync(path));
    symlinkSync(path, join(root, "linked.env"));
    assert.throws(() => privateFile(join(root, "linked.env"), expected, options));
    assert.throws(() => atomicReplace(path, "SETTING=new\n", "0".repeat(64), options));
    assert.equal(readFileSync(path, "utf8"), "SETTING=old\n");
    assert.throws(() => atomicReplace(path, "SETTING=new\n", null, options));
    atomicReplace(path, "SETTING=new\n", expected, options);
    assert.equal(readFileSync(path, "utf8"), "SETTING=new\n");
    linkSync(path, join(root, "hard.env"));
    assert.throws(() => privateFile(path, null, options));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SQLite backup captures committed WAL data without overwriting an existing snapshot", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "transition-db-")));
  const path = join(root, "live.sqlite");
  const destination = join(root, "backup.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1,'committed');");
    const result = await backupSqlite(path, destination);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(snapshot.prepare("SELECT value FROM records").get().value, "committed"); } finally { snapshot.close(); }
    assert.equal(existsSync(`${destination}-wal`), false);
    assert.equal(existsSync(`${destination}-shm`), false);
    assert.equal(existsSync(`${destination}-journal`), false);
    await assert.rejects(backupSqlite(path, destination), /exist/i);
    assert.equal(hashBytes(readFileSync(destination)), result.sha256);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
