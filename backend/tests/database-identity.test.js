import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createDatabaseIdentity } from "../src/db/databaseIdentity.js";
import { openDatabase } from "../src/db.js";

const temporaryDirectories = [];
const SECRET = "unit-backend-session-private-secret";

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createDatabase(name) {
  const directory = mkdtempSync(join(tmpdir(), "sent-zx-database-identity-"));
  temporaryDirectories.push(directory);
  const databaseUrl = join(directory, name);
  const db = openDatabase({ databaseUrl });
  db.close();
  return databaseUrl;
}

test("database identity is stable for the same file and opaque to callers", () => {
  const databaseUrl = createDatabase("workbench.sqlite");
  const first = createDatabaseIdentity({ databaseUrl, secret: SECRET });
  const second = createDatabaseIdentity({ databaseUrl, secret: SECRET });

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.includes(databaseUrl), false);
  assert.equal(first.includes(SECRET), false);
});

test("database identity differs for another database file", () => {
  const first = createDatabaseIdentity({ databaseUrl: createDatabase("first.sqlite"), secret: SECRET });
  const second = createDatabaseIdentity({ databaseUrl: createDatabase("second.sqlite"), secret: SECRET });

  assert.notEqual(first, second);
});

test("database identity rejects memory databases and weak secrets", () => {
  const databaseUrl = createDatabase("workbench.sqlite");

  assert.throws(
    () => createDatabaseIdentity({ databaseUrl: ":memory:", secret: SECRET }),
    /file-backed/i,
  );
  assert.throws(
    () => createDatabaseIdentity({ databaseUrl, secret: "too-short" }),
    /secret/i,
  );
});
