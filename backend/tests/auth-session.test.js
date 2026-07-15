import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readPasswordLine } from "../scripts/hash-password.mjs";
import {
  hashPassword,
  validatePasswordHashEncoding,
  verifyPassword,
} from "../src/auth/password.js";
import {
  createCsrfToken,
  createSession,
  getActiveSession,
  revokeSession,
} from "../src/auth/session.js";
import { openDatabase } from "../src/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function withDatabase(testBody) {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-auth-session-"));
  const databaseUrl = join(root, "workbench.sqlite");
  const db = openDatabase({ databaseUrl });
  try {
    testBody(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("verifies a fixed-parameter scrypt hash without storing the password", async () => {
  const encoded = await hashPassword("unit-secret", { salt: Buffer.alloc(16, 7) });

  assert.match(encoded, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword("unit-secret", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
  assert.equal(validatePasswordHashEncoding(encoded), true);
  assert.doesNotMatch(encoded, /unit-secret/);
});

test("rejects malformed or unsupported scrypt encodings without throwing", async () => {
  for (const encoded of [
    "",
    "pbkdf2$16384$8$1$salt$hash",
    "scrypt$999999999$8$1$c2FsdA$aGFzaA",
    "scrypt$016384$8$1$c2FsdA$aGFzaA",
    "scrypt$1.6384e4$8$1$c2FsdA$aGFzaA",
    "scrypt$+16384$8$1$c2FsdA$aGFzaA",
    "scrypt$16384$8$1$invalid!$invalid!",
    "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$c2FsdA",
  ]) {
    assert.equal(await verifyPassword("unit-secret", encoded), false);
    assert.equal(validatePasswordHashEncoding(encoded), false);
  }
  assert.equal(await verifyPassword(Buffer.from("unit-secret"), "scrypt$16384$8$1$c2FsdA$aGFzaA"), false);
  assert.equal(await verifyPassword("x".repeat(1025), await hashPassword("valid-password")), false);
  await assert.rejects(() => hashPassword(Buffer.from("unit-secret")), /password must be a string/i);
  await assert.rejects(() => hashPassword("x".repeat(1025)), /password is too long/i);
});

test("persists only token hashes and revokes one session without affecting another", () => {
  withDatabase((db) => {
    const now = Date.UTC(2026, 6, 15, 8, 0, 0);
    const config = { authSessionSecret: "unit-session-secret" };
    const first = createSession(db, config, { account: "jiangjz", now });
    const second = createSession(db, config, { account: "jiangjz", now: now + 1 });
    const rows = db.prepare("SELECT id, token_hash, account, expires_at, revoked_at FROM auth_sessions ORDER BY created_at").all();

    assert.equal(rows.length, 2);
    assert.equal(rows.some((row) => row.token_hash.includes(first.cookieValue)), false);
    assert.equal(rows.some((row) => JSON.stringify(row).includes(first.cookieValue)), false);
    assert.match(first.cookieValue, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      rows[0].token_hash,
      createHmac("sha256", config.authSessionSecret)
        .update(`session-store:v1:${first.cookieValue}`)
        .digest("base64url"),
    );
    assert.equal("cookieValue" in first, true);
    assert.equal(JSON.stringify(first).includes(first.cookieValue), false);
    assert.equal(first.expiresAt, new Date(now + 7 * DAY_MS).toISOString());
    assert.equal(first.csrfToken, createCsrfToken(config, first.id));
    assert.notEqual(first.csrfToken, second.csrfToken);
    assert.deepEqual(getActiveSession(db, config, first.cookieValue, now + 2), {
      id: first.id,
      account: "jiangjz",
      expiresAt: first.expiresAt,
    });

    assert.equal(revokeSession(db, config, first.cookieValue, now + 3).changes, 1);
    assert.equal(revokeSession(db, config, first.cookieValue, now + 4).changes, 0);
    assert.equal(getActiveSession(db, config, first.cookieValue, now + 4), null);
    assert.equal(getActiveSession(db, config, second.cookieValue, now + 4)?.id, second.id);
  });
});

test("rejects expired sessions, wrong secrets, and missing session secrets", () => {
  withDatabase((db) => {
    const now = Date.UTC(2026, 6, 15, 8, 0, 0);
    const config = { authSessionSecret: "unit-session-secret" };
    const created = createSession(db, config, { account: "jiangjz", now });

    assert.equal(getActiveSession(db, config, created.cookieValue, now + 7 * DAY_MS - 1)?.id, created.id);
    assert.equal(getActiveSession(db, config, created.cookieValue, now + 7 * DAY_MS), null);
    assert.equal(
      getActiveSession(db, { authSessionSecret: "rotated-session-secret" }, created.cookieValue, now + 1),
      null,
    );
    assert.throws(
      () => createSession(db, { authSessionSecret: "" }, { account: "jiangjz", now }),
      /session secret is required/i,
    );
  });
});

test("hash-password command reads stdin and prints only an encoded hash", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/hash-password.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {
    input: "cli-secret\n",
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const encoded = result.stdout.trim();
  assert.match(encoded, /^scrypt\$/);
  assert.equal(result.stdout, `${encoded}\n`);
  assert.doesNotMatch(result.stdout, /cli-secret/);
  assert.equal(await verifyPassword("cli-secret", encoded), true);

  const rejectedArgument = spawnSync(process.execPath, [scriptPath, "cli-secret"], {
    input: "ignored-stdin\n",
    encoding: "utf8",
  });
  assert.equal(rejectedArgument.status, 1);
  assert.doesNotMatch(rejectedArgument.stdout, /scrypt\$/);
  assert.match(rejectedArgument.stderr, /standard input/i);
});

test("hash-password command disables terminal echo while reading a password", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (enabled) => rawModes.push(enabled);
  let promptText = "";

  const passwordPromise = readPasswordLine({
    input,
    promptOutput: {
      write(chunk) {
        promptText += String(chunk);
      },
    },
  });
  input.end("tty-secret\r");

  assert.equal(await passwordPromise, "tty-secret");
  assert.deepEqual(rawModes, [true, false]);
  assert.match(promptText, /Password:/);
  assert.doesNotMatch(promptText, /tty-secret/);
});
