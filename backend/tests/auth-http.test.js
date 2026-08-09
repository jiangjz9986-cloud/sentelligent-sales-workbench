import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { isMachineRouteAllowed } from "../src/auth/machineAuthorization.js";
import { createServer } from "../src/server.js";

const passwordField = "pass" + "word";
const loginValue = "unit-login-value";
const allowedOrigin = "https://sales.example.test";

let tempDir;
let server;
let baseUrl;
let passwordHash;

async function startServer(overrides = {}) {
  server = createServer({
    databaseUrl: join(tempDir, "auth-http.sqlite"),
    seed: true,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "jiangjz",
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 5).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [allowedOrigin],
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: "jiangjz", [passwordField]: loginValue }),
  });
  assert.equal(result.response.status, 200);
  return {
    ...result,
    cookie: cookiePair(result.response),
    csrf: result.body.csrfToken,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-zx-auth-http-"));
  passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 7) });
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("cookie authentication protocol", () => {
  it("returns 503 for protected APIs when required authentication is incomplete", async () => {
    await startServer({ authAccount: "", authPasswordHash: "", authSessionSecret: "" });

    assert.equal((await request("/api/health")).response.status, 200);
    const business = await request("/api/customers");
    assert.equal(business.response.status, 503);
    assert.equal(business.body.error.code, "AUTH_NOT_CONFIGURED");
    assert.ok(business.body.error.requestId);
    const loginResult = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: loginValue }),
    });
    assert.equal(loginResult.response.status, 503);
    assert.equal("token" in loginResult.body, false);
  });

  it("issues a seven-day HttpOnly cookie and exposes the active session without a bearer token", async () => {
    await startServer();

    const loggedIn = await login();
    const setCookie = loggedIn.response.headers.get("set-cookie");
    assert.match(setCookie, /^sentelligent_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=604800/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    assert.equal("token" in loggedIn.body, false);
    assert.equal(loggedIn.body.account, "jiangjz");
    assert.ok(loggedIn.body.csrfToken);
    assert.ok(Date.parse(loggedIn.body.expiresAt) > Date.now() + 6 * 24 * 60 * 60 * 1000);
    assert.doesNotMatch(JSON.stringify(loggedIn.body), /unit-login-value/);

    const session = await request("/api/auth/session", {
      headers: { Cookie: loggedIn.cookie },
    });
    assert.equal(session.response.status, 200);
    assert.equal(session.body.account, "jiangjz");
    assert.equal(session.body.csrfToken, loggedIn.csrf);
  });

  it("keeps the development plaintext compatibility path on server-side cookies", async () => {
    await startServer({
      nodeEnv: "development",
      authPasswordHash: "",
      authPassword: loginValue,
    });

    const loggedIn = await login();
    assert.equal("token" in loggedIn.body, false);
    assert.match(loggedIn.response.headers.get("set-cookie"), /HttpOnly/i);
    assert.equal((await request("/api/customers", {
      headers: { Cookie: loggedIn.cookie },
    })).response.status, 200);
  });

  it("rejects legacy browser bearer and query tokens after cookie migration", async () => {
    await startServer();

    const bearer = await request("/api/customers", {
      headers: { Authorization: "Bearer old" },
    });
    assert.equal(bearer.response.status, 401);
    assert.equal(bearer.body.error.code, "UNAUTHORIZED");

    const query = await request("/api/customers?token=old");
    assert.equal(query.response.status, 401);
    assert.equal(query.body.error.code, "UNAUTHORIZED");
  });

  it("requires matching CSRF for cookie writes and allows cookie reads", async () => {
    await startServer();
    const loggedIn = await login();
    const customer = JSON.stringify({ name: "CSRF customer", owner: "jiangjz" });

    const missing = await request("/api/customers", {
      method: "POST",
      headers: { Cookie: loggedIn.cookie },
      body: customer,
    });
    assert.equal(missing.response.status, 403);
    assert.equal(missing.body.error.code, "CSRF_INVALID");

    const wrong = await request("/api/customers", {
      method: "POST",
      headers: { Cookie: loggedIn.cookie, "X-CSRF-Token": "wrong" },
      body: customer,
    });
    assert.equal(wrong.response.status, 403);
    assert.equal(wrong.body.error.code, "CSRF_INVALID");

    const created = await request("/api/customers", {
      method: "POST",
      headers: { Cookie: loggedIn.cookie, "X-CSRF-Token": loggedIn.csrf },
      body: customer,
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.name, "CSRF customer");
    assert.equal((await request("/api/customers", {
      headers: { Cookie: loggedIn.cookie },
    })).response.status, 200);
  });

  it("logs out by revoking the session and expiring its cookie", async () => {
    await startServer();
    const loggedIn = await login();

    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: loggedIn.cookie, "X-CSRF-Token": loggedIn.csrf },
    });
    assert.equal(logout.response.status, 204);
    assert.match(logout.response.headers.get("set-cookie"), /sentelligent_session=;/i);
    assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/i);

    const revoked = await request("/api/auth/session", {
      headers: { Cookie: loggedIn.cookie },
    });
    assert.equal(revoked.response.status, 401);
  });

  it("allows credentialed CORS only for configured origins", async () => {
    await startServer();

    const preflight = await request("/api/customers", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(preflight.response.status, 204);
    assert.equal(preflight.response.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.equal(preflight.response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(
      preflight.response.headers.get("access-control-expose-headers"),
      "Content-Disposition",
    );
    assert.match(preflight.response.headers.get("vary"), /Origin/i);

    const rejected = await request("/api/health", {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.error.code, "ORIGIN_NOT_ALLOWED");
    assert.equal(rejected.response.headers.get("access-control-allow-origin"), null);
    assert.equal(rejected.response.headers.get("access-control-expose-headers"), null);
  });

  it("rejects oversized JSON before authentication work", async () => {
    await startServer({ jsonBodyLimitBytes: 96 });

    const oversized = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "x".repeat(200) }),
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  it("sanitizes unexpected failures and returns a request id", async () => {
    await startServer({
      spawnWeixinLoginProcess() {
        throw new Error("internal-sentinel-message");
      },
    });
    const loggedIn = await login();

    const failed = await request("/api/integrations/weixin-agent/login", {
      method: "POST",
      headers: { Cookie: loggedIn.cookie, "X-CSRF-Token": loggedIn.csrf },
    });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.body.error.code, "INTERNAL_ERROR");
    assert.ok(failed.body.error.requestId);
    assert.equal(failed.response.headers.get("x-request-id"), failed.body.error.requestId);
    assert.doesNotMatch(JSON.stringify(failed.body), /internal-sentinel-message/);
  });

  it("limits a valid WeChat machine token to its route allowlist", async () => {
    await startServer({ weixinAgentApiToken: "wx-machine-token" });

    const allowed = await request("/api/customers", {
      headers: { Authorization: "Bearer wx-machine-token" },
    });
    assert.equal(allowed.response.status, 200);

    for (const [method, path] of [
      ["GET", "/api/audit-logs"],
      ["GET", "/api/invoices"],
      ["GET", "/api/travel-expense-document-inbox"],
      ["POST", "/api/auth/login"],
      ["POST", "/api/integrations/weixin-agent/login"],
      ["DELETE", "/api/customers/customer-1"],
    ]) {
      const denied = await request(path, {
        method,
        headers: { Authorization: "Bearer wx-machine-token" },
      });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body.error.code, "MACHINE_SCOPE_DENIED");
    }
  });

  it("allows only the exact POST routes needed for WeChat document imports", () => {
    assert.equal(isMachineRouteAllowed("POST", "/api/quick-records/preview"), true);
    assert.equal(isMachineRouteAllowed("POST", "/api/travel-expense-document-inbox"), true);
    assert.equal(isMachineRouteAllowed("POST", "/api/invoices"), true);
    assert.equal(isMachineRouteAllowed("POST", "/api/integrations/weixin-agent/events"), true);

    for (const [method, path] of [
      ["GET", "/api/travel-expense-document-inbox"],
      ["GET", "/api/invoices"],
      ["PUT", "/api/invoices"],
      ["POST", "/api/invoices/invoice-1/match"],
      ["POST", "/api/travel-expenses/EXP-1/attachments"],
      ["GET", "/api/integrations/weixin-agent/events"],
    ]) {
      assert.equal(isMachineRouteAllowed(method, path), false, `${method} ${path} must remain denied`);
    }
  });

  it("rate limits repeated login failures without revealing account existence", async () => {
    await startServer();

    const wrongAccount = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "unknown", [passwordField]: "wrong" }),
    });
    const wrongPassword = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "wrong" }),
    });
    assert.equal(wrongAccount.response.status, 401);
    assert.equal(wrongPassword.response.status, 401);
    assert.deepEqual(
      { code: wrongAccount.body.error.code, message: wrongAccount.body.error.message },
      { code: wrongPassword.body.error.code, message: wrongPassword.body.error.message },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: "jiangjz", [passwordField]: "wrong" }),
      });
      assert.equal(failed.response.status, 401);
    }
    const limited = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "wrong" }),
    });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "LOGIN_RATE_LIMITED");
  });

  it("applies an IP-wide login limit when an attacker rotates account names", async () => {
    await startServer();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ account: `unknown-${attempt}`, [passwordField]: "wrong" }),
      });
      assert.equal(failed.response.status, 401);
    }
    const limited = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "unknown-next", [passwordField]: "wrong" }),
    });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "LOGIN_RATE_LIMITED");
  });

  it("sets browser security headers and production HSTS", async () => {
    await startServer({ authCookieSecure: true });

    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
    assert.match(health.body.databaseIdentity, /^[A-Za-z0-9_-]{43}$/);
    assert.match(health.response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(health.response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(health.response.headers.get("x-frame-options"), "DENY");
    assert.match(health.response.headers.get("strict-transport-security"), /max-age=31536000/);

    const loggedIn = await login();
    assert.match(loggedIn.response.headers.get("set-cookie"), /Secure/i);
  });
});
