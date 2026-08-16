import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

const account = "settings-owner";
const password = "unit-password";
const passwordHash = await hashPassword(password, { salt: Buffer.alloc(16, 91) });
const encryptionKey = Buffer.alloc(32, 92).toString("base64url");

let tempDir;
let databaseUrl;
let server;
let baseUrl;

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startServer(overrides = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-settings-api-"));
  databaseUrl = join(tempDir, "settings.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 93).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    settingsEncryptionKey: encryptionKey,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return { cookie: cookiePair(result.response), csrf: result.body.csrfToken };
}

beforeEach(() => {
  tempDir = null;
  databaseUrl = null;
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("secure system settings API", () => {
  it("requires an encryption key before exposing persisted settings", async () => {
    await startServer({ settingsEncryptionKey: "" });
    const auth = await login();
    const result = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, "SECURE_SETTINGS_NOT_CONFIGURED");
  });

  it("returns an iCost token once, then only metadata, while storing ciphertext", async () => {
    await startServer();
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };

    const rotated = await request("/api/settings/icost-token/rotate", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(rotated.response.status, 201);
    assert.match(rotated.body.item.token, /^icost_[A-Za-z0-9_-]{43}$/);
    const token = rotated.body.item.token;

    const listed = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.item.icost.configured, true);
    assert.equal(listed.body.item.icost.masked.includes(token), false);
    assert.equal("token" in listed.body.item.icost, false);

    const second = await request("/api/settings/icost-token", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(second.response.status, 201);
    assert.notEqual(second.body.item.token, token);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    const db = openDatabase({ databaseUrl });
    const row = db.prepare("SELECT ciphertext FROM secure_settings WHERE setting_key = 'icost_webhook_token'").get();
    db.close();
    assert.ok(row.ciphertext);
    assert.doesNotMatch(row.ciphertext, /icost_/);
  });

  it("never returns a DeepSeek key and requires explicit confirmation to clear it", async () => {
    await startServer();
    const auth = await login();
    const headers = { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf };
    const fixtureValue = "synthetic-deepseek-key";

    const saved = await request("/api/settings/deepseek-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ apiKey: fixtureValue }),
    });
    assert.equal(saved.response.status, 200);
    assert.doesNotMatch(JSON.stringify(saved.body), new RegExp(fixtureValue));
    assert.equal(saved.body.item.configured, true);
    assert.equal(saved.body.item.masked.includes(fixtureValue), false);

    const missingConfirmation = await request("/api/settings/deepseek-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "no" }),
    });
    assert.equal(missingConfirmation.response.status, 428);

    const cleared = await request("/api/settings/deepseek-key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirmation: "CLEAR" }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.item.configured, false);

    const listed = await request("/api/settings/security", { headers: { Cookie: auth.cookie } });
    assert.equal(listed.body.item.deepseek.status, "cleared");
  });
});
