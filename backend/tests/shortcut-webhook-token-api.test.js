import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";

const password = "test-token-api-password";
const account = "jiangjz";
const legacyToken = "test-token";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function login() {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(response.response.status, 200);
  return { cookie: cookiePair(response.response), csrf: response.body.csrfToken };
}

async function startServer() {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-webhook-token-api-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPasswordHash: await hashPassword(password, { salt: Buffer.alloc(16, 7) }),
    authSessionSecret: Buffer.alloc(32, 5).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    shortcutWebhookToken: legacyToken,
    shortcutWebhookOwner: "legacy-owner",
    travelExpenseAnalyzer: async () => ({
      status: "ready",
      confidence: 1,
      expense: {
        occurredOn: "2026-08-16",
        amountCents: 1280,
        reimbursementCents: 1280,
        purpose: "打车",
        merchant: "示例商户",
        paidAt: "2026-08-16T12:00:00+08:00",
        fundingSource: "personal",
        paymentMethod: "alipay",
      },
      warnings: [],
      source: { provider: "test", model: null },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(startServer);
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  baseUrl = null;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Shortcut webhook token management API", () => {
  it("requires a cookie session and CSRF for management writes", async () => {
    assert.equal((await request("/api/integrations/shortcut/tokens")).response.status, 401);
    const session = await login();
    const missingCsrf = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie },
      body: JSON.stringify({ label: "iPhone" }),
    });
    assert.equal(missingCsrf.response.status, 403);
    assert.equal(missingCsrf.body.error.code, "CSRF_INVALID");

    const invalidLabel = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ label: 123 }),
    });
    assert.equal(invalidLabel.response.status, 422);
    assert.equal(invalidLabel.body.error.fields.label, "string");
  });

  it("creates, lists, revokes, and uses a database token mapped to the logged-in account", async () => {
    const session = await login();
    const created = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ label: "iPhone 截图记账" }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.account, account);
    assert.match(created.body.item.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(created.body.item.label, "iPhone 截图记账");

    const verified = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${created.body.item.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "error");
    assert.equal(verified.body.tokenValid, true);
    assert.equal(verified.body.bookkeepingReady, false);
    assert.equal(verified.body.error.code, "SHORTCUT_BOOKKEEPING_NOT_READY");
    assert.equal(verified.body.error.message, "Token 验证成功，但记账写入功能尚未开放");

    const listed = await request("/api/integrations/shortcut/tokens", {
      headers: { Cookie: session.cookie },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal("token" in listed.body.items[0], false);
    assert.equal(listed.body.items[0].lastUsedAt !== null, true);

    const revoked = await request(`/api/integrations/shortcut/tokens/${created.body.item.id}`, {
      method: "DELETE",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
    });
    assert.equal(revoked.response.status, 200);
    assert.ok(revoked.body.item.revokedAt);

    const rejected = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${created.body.item.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.tokenValid, false);
    assert.equal(rejected.body.error.code, "SHORTCUT_TOKEN_INVALID");
  });

  it("keeps the legacy env token fallback working", async () => {
    const response = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${legacyToken}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.body.tokenValid, true);
    assert.equal(response.body.bookkeepingReady, false);
    assert.equal(response.body.error.code, "SHORTCUT_BOOKKEEPING_NOT_READY");
  });
});
