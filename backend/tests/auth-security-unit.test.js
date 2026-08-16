import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  authenticateMachineRequest,
  assertMachineRouteAllowed,
} from "../src/auth/machineAuthorization.js";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  pruneLoginRateLimits,
  recordLoginFailure,
} from "../src/auth/loginRateLimit.js";
import { openDatabase } from "../src/db.js";

function withDatabase(testBody) {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-auth-security-"));
  const db = openDatabase({ databaseUrl: join(root, "auth-security.sqlite") });
  try {
    testBody(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("machine authorization", () => {
  it("authenticates only the configured machine bearer without leaking it", () => {
    const config = {
      weixinAgentApiToken: "wx-unit-token",
      authAccount: "personal-owner",
      weixinAgentOwner: "weixin-owner",
    };

    assert.equal(authenticateMachineRequest(undefined, config), null);
    assert.equal(authenticateMachineRequest("Basic abc", config), null);
    assert.equal(authenticateMachineRequest("Bearer wrong", config), null);
    assert.deepEqual(authenticateMachineRequest("bearer wx-unit-token", config), {
      account: "weixin-owner",
      integration: "weixin-agent",
      kind: "machine",
    });
    assert.deepEqual(authenticateMachineRequest("Bearer wx-unit-token", config), {
      account: "weixin-owner",
      integration: "weixin-agent",
      kind: "machine",
    });

    assert.equal(authenticateMachineRequest("Bearer wx-unit-token", {
      weixinAgentApiToken: "wx-unit-token",
      authAccount: "personal-owner",
    }).account, "personal-owner");
  });

  it("allows only the declared machine capabilities", () => {
    for (const [method, pathname] of [
      ["GET", "/api/customers"],
      ["POST", "/api/quick-records"],
      ["POST", "/api/quick-records/record-1/analyze"],
      ["POST", "/api/reports/weekly/draft"],
    ]) {
      assert.doesNotThrow(() => assertMachineRouteAllowed(method, pathname));
    }

    for (const [method, pathname] of [
      ["GET", "/api/customers/customer-1"],
      ["PATCH", "/api/customers/customer-1"],
      ["DELETE", "/api/customers/customer-1"],
      ["GET", "/api/audit-logs"],
      ["GET", "/api/reports/weekly/report-1/export"],
      ["POST", "/api/integrations/weixin-agent/login"],
      ["GET", "/api/integrations/weixin-agent/events"],
      ["POST", "/api/integrations/weixin-agent/events/"],
      ["POST", "/api/integrations/weixin-agent/events/extra"],
    ]) {
      assert.throws(
        () => assertMachineRouteAllowed(method, pathname),
        (error) => error.status === 403 && error.code === "MACHINE_SCOPE_DENIED",
      );
    }

    assert.doesNotThrow(() => assertMachineRouteAllowed(
      "POST",
      "/api/integrations/weixin-agent/events",
    ));
  });
});

describe("persistent login rate limiting", () => {
  it("uses a normalized, purpose-separated HMAC key", () => {
    const first = loginRateLimitKey("unit-rate-secret", " JiangJZ ", "127.0.0.1");
    const normalized = loginRateLimitKey("unit-rate-secret", "jiangjz", "127.0.0.1");
    const otherAddress = loginRateLimitKey("unit-rate-secret", "jiangjz", "127.0.0.2");

    assert.equal(first, normalized);
    assert.notEqual(first, otherAddress);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(first, /jiangjz|127\.0\.0\.1/i);
    assert.throws(() => loginRateLimitKey("", "jiangjz", "127.0.0.1"), /secret/i);
  });

  it("blocks after five failures for fifteen minutes and resets at the boundary", () => {
    withDatabase((db) => {
      const key = loginRateLimitKey("unit-rate-secret", "jiangjz", "127.0.0.1");
      const now = Date.UTC(2026, 6, 15, 10, 0, 0);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.doesNotThrow(() => assertLoginAllowed(db, key, now + attempt));
        recordLoginFailure(db, key, now + attempt);
      }
      assert.throws(
        () => assertLoginAllowed(db, key, now + 5),
        (error) => error.status === 429 && error.code === "LOGIN_RATE_LIMITED",
      );
      assert.doesNotThrow(() => assertLoginAllowed(db, key, now + 15 * 60 * 1000 + 4));

      recordLoginFailure(db, key, now + 15 * 60 * 1000 + 4);
      assert.equal(
        db.prepare("SELECT failures FROM login_rate_limits WHERE key = ?").get(key).failures,
        1,
      );
    });
  });

  it("clears only the successful login key", () => {
    withDatabase((db) => {
      const first = loginRateLimitKey("unit-rate-secret", "jiangjz", "127.0.0.1");
      const second = loginRateLimitKey("unit-rate-secret", "other", "127.0.0.1");
      const now = Date.UTC(2026, 6, 15, 10, 0, 0);
      recordLoginFailure(db, first, now);
      recordLoginFailure(db, second, now);

      assert.equal(clearLoginFailures(db, first).changes, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_rate_limits").get().count, 1);
      assert.doesNotThrow(() => assertLoginAllowed(db, first, now));
    });
  });

  it("uses the current time when limiter calls omit an explicit timestamp", () => {
    withDatabase((db) => {
      const key = loginRateLimitKey("unit-rate-secret", "jiangjz", "127.0.0.1");

      assert.doesNotThrow(() => assertLoginAllowed(db, key));
      assert.doesNotThrow(() => recordLoginFailure(db, key));
      const row = db.prepare(
        "SELECT failures, window_started_at AS windowStartedAt FROM login_rate_limits WHERE key = ?",
      ).get(key);
      assert.equal(row.failures, 1);
      assert.ok(Math.abs(Date.parse(row.windowStartedAt) - Date.now()) < 5_000);
    });
  });

  it("prunes expired failure windows while preserving active rows", () => {
    withDatabase((db) => {
      const stale = loginRateLimitKey("unit-rate-secret", "stale", "127.0.0.1");
      const active = loginRateLimitKey("unit-rate-secret", "active", "127.0.0.1");
      const now = Date.UTC(2026, 6, 15, 10, 0, 0);
      recordLoginFailure(db, stale, now - 16 * 60 * 1000);
      recordLoginFailure(db, active, now - 1_000);

      assert.equal(pruneLoginRateLimits(db, now).changes, 1);
      assert.deepEqual(
        db.prepare("SELECT key FROM login_rate_limits ORDER BY key").all().map((row) => row.key),
        [active],
      );
    });
  });
});
