import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  HttpError,
  errorBody,
  errorStatus,
} from "../src/http/errors.js";
import { readJsonBody } from "../src/http/request.js";
import {
  securityHeaders,
  sendDocument,
  sendError,
  sendJson,
} from "../src/http/response.js";
import {
  assertCsrfToken,
  buildSessionCookie,
  constantTimeEqual,
  corsHeaders,
  csrfTokensMatch,
  parseCookies,
} from "../src/http/security.js";
import {
  assertMachineScope,
  isMachineRouteAllowed,
  verifyMachineToken,
} from "../src/auth/machineAuthorization.js";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  recordLoginFailure,
} from "../src/auth/loginRateLimit.js";
import { openDatabase } from "../src/db.js";

const WINDOW_MS = 15 * 60 * 1000;

function captureResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function temporaryDatabase() {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-http-security-"));
  const databaseUrl = join(root, "workbench.sqlite");
  return {
    root,
    databaseUrl,
    db: openDatabase({ databaseUrl }),
  };
}

test("formats typed HTTP errors and sanitizes unexpected failures", () => {
  const requestId = "req-unit-1";
  const typed = new HttpError(422, "VALIDATION_ERROR", "提交内容有误", {
    account: "账号不能为空",
  });

  assert.equal(typed.name, "HttpError");
  assert.equal(errorStatus(typed), 422);
  assert.deepEqual(errorBody(typed, requestId), {
    error: {
      code: "VALIDATION_ERROR",
      message: "提交内容有误",
      fields: { account: "账号不能为空" },
      requestId,
    },
  });

  const unexpected = errorBody(
    new Error("sqlite failed at C:\\private\\workbench.sqlite using secret-value"),
    requestId,
  );
  assert.equal(errorStatus(new Error("boom")), 500);
  assert.equal(unexpected.error.code, "INTERNAL_ERROR");
  assert.equal(unexpected.error.requestId, requestId);
  assert.equal(unexpected.error.fields, null);
  assert.doesNotMatch(JSON.stringify(unexpected), /sqlite|private|secret-value/i);
});

test("reads valid JSON and treats a byte-empty request as an empty object", async () => {
  assert.deepEqual(await readJsonBody(Readable.from([])), {});
  assert.deepEqual(
    await readJsonBody(Readable.from([Buffer.from('{"name":"测试"}')]), {
      maxBytes: 17,
    }),
    { name: "测试" },
  );
});

test("maps malformed JSON to a typed 400 error", async () => {
  await assert.rejects(
    readJsonBody(Readable.from([Buffer.from("{not-json")])),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_JSON");
      return true;
    },
  );
});

test("stops consuming and buffering as soon as JSON exceeds the byte limit", async () => {
  let pulls = 0;
  let iteratorClosed = false;
  async function* chunks() {
    try {
      pulls += 1;
      yield Buffer.alloc(9, "a");
      pulls += 1;
      yield Buffer.alloc(1024 * 1024, "b");
    } finally {
      iteratorClosed = true;
    }
  }

  await assert.rejects(readJsonBody(chunks(), { maxBytes: 8 }), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 413);
    assert.equal(error.code, "PAYLOAD_TOO_LARGE");
    return true;
  });
  assert.equal(pulls, 1);
  assert.equal(iteratorClosed, true);

  await assert.rejects(
    readJsonBody(Readable.from([]), { maxBytes: -1 }),
    /maxBytes must be a non-negative safe integer/i,
  );
});

test("parses valid cookies while ignoring malformed percent encoding", () => {
  assert.deepEqual(
    parseCookies("session=good%20value; broken=%E0%A4%A; encoded%20name=a%3Db; no-equals"),
    {
      session: "good value",
      "encoded name": "a=b",
    },
  );
  assert.deepEqual(parseCookies(), {});
});

test("builds seven-day and clearing cookies without allowing header injection", () => {
  const config = {
    authCookieName: "sentelligent_session",
    authCookieSecure: false,
  };
  assert.equal(
    buildSessionCookie(config, "value/with spaces"),
    "sentelligent_session=value%2Fwith%20spaces; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800",
  );
  assert.equal(
    buildSessionCookie({ ...config, authCookieSecure: true }, "token-value"),
    "sentelligent_session=token-value; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure",
  );
  assert.equal(
    buildSessionCookie(config, "ignored", { clear: true }),
    "sentelligent_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );

  assert.throws(
    () => buildSessionCookie({ ...config, authCookieName: "session\r\nX-Evil" }, "token"),
    /cookie name/i,
  );
  assert.throws(
    () => buildSessionCookie(config, "token\r\nSet-Cookie: injected=true"),
    /cookie value/i,
  );
});

test("allows credentialed CORS for exact configured origins only", () => {
  const config = { corsAllowedOrigins: ["https://sales.example.test"] };
  assert.deepEqual(corsHeaders(undefined, config), {});
  assert.deepEqual(corsHeaders("https://sales.example.test", config), {
    "Access-Control-Allow-Origin": "https://sales.example.test",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "Content-Disposition",
    "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token,Idempotency-Key,If-Match",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  });
  assert.throws(
    () => corsHeaders("https://sales.example.test.attacker.invalid", config),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "ORIGIN_NOT_ALLOWED");
      return true;
    },
  );
});

test("applies browser security headers to JSON and document responses", () => {
  const config = { authCookieSecure: true };
  const expected = securityHeaders(config);
  assert.match(expected["Content-Security-Policy"], /default-src 'self'/);
  assert.match(expected["Content-Security-Policy"], /img-src 'self' data: blob:/);
  assert.match(expected["Content-Security-Policy"], /style-src 'self' 'unsafe-inline'/);
  assert.match(expected["Content-Security-Policy"], /script-src 'self'/);
  assert.match(expected["Content-Security-Policy"], /connect-src 'self'/);
  assert.match(expected["Content-Security-Policy"], /object-src 'none'/);
  assert.match(expected["Content-Security-Policy"], /base-uri 'self'/);
  assert.match(expected["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(expected["X-Content-Type-Options"], "nosniff");
  assert.equal(expected["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(expected["X-Frame-Options"], "DENY");
  assert.equal(
    expected["Strict-Transport-Security"],
    "max-age=31536000; includeSubDomains",
  );
  assert.equal("Strict-Transport-Security" in securityHeaders({ authCookieSecure: false }), false);

  const json = captureResponse();
  sendJson(json, 200, { ok: true }, {
    config,
    headers: { "X-Request-Id": "req-json" },
  });
  assert.equal(json.statusCode, 200);
  assert.equal(json.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(json.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(json.headers["X-Request-Id"], "req-json");
  assert.equal(json.body, '{"ok":true}');

  const document = captureResponse();
  sendDocument(document, 200, "report", {
    config,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  assert.equal(document.statusCode, 200);
  assert.equal(document.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(document.headers["X-Frame-Options"], "DENY");
  assert.equal(document.body, "report");
});

test("matches CSRF tokens using the constant-time comparison helper", () => {
  assert.equal(constantTimeEqual("same-token", "same-token"), true);
  assert.equal(constantTimeEqual("same-token", "different-token"), false);
  assert.equal(constantTimeEqual("short", "longer-token"), false);
  assert.equal(constantTimeEqual(null, "null"), false);
  assert.equal(csrfTokensMatch("csrf-token", "csrf-token"), true);
  assert.equal(csrfTokensMatch("", ""), false);
  assert.equal(csrfTokensMatch(undefined, "csrf-token"), false);
});

test("rejects blank JSON bodies and missing or invalid CSRF tokens", async () => {
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from(" \r\n\t ")])), {});

  for (const token of [undefined, "different-token"]) {
    assert.throws(() => assertCsrfToken(token, "csrf-token"), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "CSRF_INVALID");
      return true;
    });
  }
  assert.doesNotThrow(() => assertCsrfToken("csrf-token", "csrf-token"));
});

test("sends typed errors with security, CORS, and request ID headers", () => {
  const response = captureResponse();
  sendError(
    response,
    new HttpError(400, "INVALID_JSON", "请求体不是合法 JSON"),
    {
      config: { corsAllowedOrigins: ["https://sales.example.test"] },
      origin: "https://sales.example.test",
      requestId: "req-error-1",
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["X-Request-Id"], "req-error-1");
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://sales.example.test");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_JSON",
      message: "请求体不是合法 JSON",
      fields: null,
      requestId: "req-error-1",
    },
  });
});

test("validates the WeChat machine token and enforces its fixed route allowlist", () => {
  const config = { weixinAgentApiToken: "machine-secret", weixinAgentOwner: "weixin-agent" };
  assert.deepEqual(verifyMachineToken("machine-secret", config), {
    account: "weixin-agent",
    integration: "weixin-agent",
  });
  assert.equal(verifyMachineToken("machine-secre", config), null);
  assert.equal(verifyMachineToken("machine-secret-extra", config), null);
  assert.equal(verifyMachineToken("", { weixinAgentApiToken: "" }), null);

  for (const [method, pathname] of [
    ["GET", "/api/customers"],
    ["POST", "/api/quick-records"],
    ["POST", "/api/quick-records/record-1/analyze"],
    ["POST", "/api/reports/weekly/draft"],
  ]) {
    assert.equal(isMachineRouteAllowed(method, pathname), true);
    assert.doesNotThrow(() => assertMachineScope(method, pathname));
  }

  for (const [method, pathname] of [
    ["GET", "/api/audit-logs"],
    ["DELETE", "/api/customers/customer-1"],
    ["PATCH", "/api/customers/customer-1"],
    ["GET", "/api/reports/weekly/report-1/export"],
    ["POST", "/api/integrations/weixin-agent/login"],
    ["GET", "/api/customers/"],
  ]) {
    assert.equal(isMachineRouteAllowed(method, pathname), false);
    assert.throws(() => assertMachineScope(method, pathname), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "MACHINE_SCOPE_DENIED");
      return true;
    });
  }
});

test("derives an opaque login limiter key from normalized account and remote IP", () => {
  const limiterKeyMaterial = "rate-limit-secret";
  const key = loginRateLimitKey(limiterKeyMaterial, "  Admin@Example.COM ", "203.0.113.7");
  assert.equal(
    key,
    createHmac("sha256", limiterKeyMaterial)
      .update("admin@example.com|203.0.113.7")
      .digest("base64url"),
  );
  assert.equal(key, loginRateLimitKey(limiterKeyMaterial, "admin@example.com", "203.0.113.7"));
  assert.doesNotMatch(key, /admin|203\.0\.113\.7/i);
  assert.throws(
    () => loginRateLimitKey("", "admin@example.com", "203.0.113.7"),
    /secret/i,
  );
});

test("persists a block starting with the fifth login failure and clears it on success", () => {
  const state = temporaryDatabase();
  const now = Date.UTC(2026, 6, 15, 8, 0, 0);
  const key = loginRateLimitKey("rate-limit-secret", "admin", "203.0.113.7");

  try {
    for (let failures = 1; failures <= 4; failures += 1) {
      assert.doesNotThrow(() => assertLoginAllowed(state.db, key, now + failures));
      recordLoginFailure(state.db, key, now + failures);
      assert.equal(
        state.db.prepare("SELECT failures FROM login_rate_limits WHERE key = ?").get(key).failures,
        failures,
      );
    }
    recordLoginFailure(state.db, key, now + 5);
    const row = state.db.prepare(
      "SELECT failures, blocked_until AS blockedUntil FROM login_rate_limits WHERE key = ?",
    ).get(key);
    assert.equal(row.failures, 5);
    assert.equal(row.blockedUntil, new Date(now + 5 + WINDOW_MS).toISOString());

    state.db.close();
    state.db = openDatabase({ databaseUrl: state.databaseUrl });
    assert.throws(() => assertLoginAllowed(state.db, key, now + 6), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "LOGIN_RATE_LIMITED");
      return true;
    });

    assert.equal(clearLoginFailures(state.db, key).changes, 1);
    assert.doesNotThrow(() => assertLoginAllowed(state.db, key, now + 7));
    assert.equal(
      state.db.prepare("SELECT COUNT(*) AS count FROM login_rate_limits WHERE key = ?").get(key).count,
      0,
    );
  } finally {
    state.db.close();
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("resets expired login windows and rejects unsafe limiter parameters", () => {
  const state = temporaryDatabase();
  const now = Date.UTC(2026, 6, 15, 8, 0, 0);
  const key = loginRateLimitKey("rate-limit-secret", "admin", "203.0.113.7");

  try {
    recordLoginFailure(state.db, key, now);
    recordLoginFailure(state.db, key, now + WINDOW_MS);
    const reset = state.db.prepare(
      "SELECT failures, window_started_at AS windowStartedAt, blocked_until AS blockedUntil FROM login_rate_limits WHERE key = ?",
    ).get(key);
    assert.deepEqual({ ...reset }, {
      failures: 1,
      windowStartedAt: new Date(now + WINDOW_MS).toISOString(),
      blockedUntil: null,
    });

    assert.throws(() => recordLoginFailure(state.db, key, Number.NaN), /now must be a valid timestamp/i);
    assert.throws(() => assertLoginAllowed(state.db, "", now), /key must be a valid limiter key/i);
    assert.throws(() => clearLoginFailures(state.db, "bad\r\nkey"), /key must be a valid limiter key/i);
  } finally {
    state.db.close();
    rmSync(state.root, { recursive: true, force: true });
  }
});
