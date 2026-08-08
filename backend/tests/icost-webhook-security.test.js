import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authenticateIcostWebhook,
  createFixedWindowLimiter,
  isIcostWebhookRouteAllowed,
  validateIcostTextPayload,
} from "../src/integrations/icostWebhook.js";

describe("iCost webhook security", () => {
  it("authenticates only the dedicated bearer token without leaking it", () => {
    const config = {
      icostWebhookToken: "unit-icost-token",
      icostWebhookOwner: "jiangjz",
    };

    assert.equal(authenticateIcostWebhook(undefined, config), null);
    assert.equal(authenticateIcostWebhook("Basic abc", config), null);
    assert.equal(authenticateIcostWebhook("Bearer wrong", config), null);
    assert.deepEqual(authenticateIcostWebhook("bearer unit-icost-token", config), {
      account: "jiangjz",
      integration: "icost",
      kind: "integration",
    });
    assert.doesNotMatch(
      JSON.stringify(authenticateIcostWebhook("Bearer unit-icost-token", config)),
      /unit-icost-token/,
    );
  });

  it("allows only the exact text-ingestion POST route", () => {
    assert.equal(isIcostWebhookRouteAllowed("POST", "/api/integrations/icost/expenses"), true);
    for (const [method, path] of [
      ["GET", "/api/integrations/icost/expenses"],
      ["PATCH", "/api/integrations/icost/expenses"],
      ["DELETE", "/api/integrations/icost/expenses"],
      ["POST", "/api/travel-expenses"],
      ["GET", "/api/travel-expenses"],
    ]) {
      assert.equal(isIcostWebhookRouteAllowed(method, path), false, `${method} ${path}`);
    }
  });

  it("accepts only the exact Sentelligent ledger and bounded text-only routing fields", () => {
    assert.deepEqual(validateIcostTextPayload({
      text: "2026-08-04 午餐 32.50元",
      ledger_name: "出差报销",
      idempotency_key: "shortcut-20260804-123000",
      source: "icost-shortcut",
      captured_at: "2026-08-04T12:30:00+08:00",
      source_id: "shortcut-entry-123000",
    }), {
      text: "2026-08-04 午餐 32.50元",
      ledgerName: "出差报销",
      idempotencyKey: "shortcut-20260804-123000",
      source: "icost-shortcut",
      capturedAt: "2026-08-04T12:30:00+08:00",
      sourceId: "shortcut-entry-123000",
    });

    for (const body of [
      {},
      { text: "", ledger_name: "出差报销", idempotency_key: "id-1", source: "icost-shortcut" },
      { text: "午餐 20元", ledger_name: "biubiu", idempotency_key: "id-2", source: "icost-shortcut" },
      { text: "午餐 20元", ledger_name: "出差报销 ", idempotency_key: "id-3", source: "icost-shortcut" },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "id-4", source: "qingyang-shortcut" },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "", source: "icost-shortcut" },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "x".repeat(201), source: "icost-shortcut" },
      { text: "x".repeat(12_001), ledger_name: "出差报销", idempotency_key: "id-5", source: "icost-shortcut" },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "id-6", source: "icost-shortcut", extra: true },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "id-7", source: "icost-shortcut", captured_at: "not-a-date" },
      { text: "午餐 20元", ledger_name: "出差报销", idempotency_key: "id-8", source: "icost-shortcut", source_id: "x".repeat(201) },
    ]) {
      assert.throws(
        () => validateIcostTextPayload(body),
        (error) => error.status === 422 && error.code === "VALIDATION_ERROR",
        JSON.stringify(body).slice(0, 120),
      );
    }
  });

  it("rate limits by a bounded fixed window and resets at the boundary", () => {
    let now = 1_000;
    const limiter = createFixedWindowLimiter({
      limit: 2,
      windowMs: 60_000,
      clock: () => now,
      maxKeys: 3,
    });

    assert.deepEqual(limiter.consume("token-a:ip-a"), {
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    assert.equal(limiter.consume("token-a:ip-a").allowed, true);
    const blocked = limiter.consume("token-a:ip-a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.retryAfterMs, 60_000);

    now += 60_000;
    assert.equal(limiter.consume("token-a:ip-a").allowed, true);
    assert.throws(() => limiter.consume(""), /key/i);
  });

  it("preserves an existing key window when key capacity is full", () => {
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      clock: () => 1_000,
      maxKeys: 2,
    });

    assert.equal(limiter.consume("token-a:ip-a").allowed, true);
    assert.equal(limiter.consume("token-b:ip-b").allowed, true);
    assert.deepEqual(limiter.consume("token-a:ip-a"), {
      allowed: false,
      remaining: 0,
      retryAfterMs: 60_000,
    });
  });

  it("rejects unsafe limiter construction values", () => {
    for (const options of [
      { limit: 0, windowMs: 60_000 },
      { limit: 2, windowMs: 0 },
      { limit: 2.5, windowMs: 60_000 },
      { limit: 2, windowMs: 60_000, maxKeys: 0 },
    ]) {
      assert.throws(() => createFixedWindowLimiter(options), /positive safe integer/i);
    }
  });
});
