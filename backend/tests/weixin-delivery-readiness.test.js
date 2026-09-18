import assert from "node:assert/strict";
import test from "node:test";

import { createWeixinDeliveryReadiness } from "../src/weixin/deliveryReadiness.js";

test("Weixin delivery readiness expires safely and exposes only bounded state", () => {
  let current = Date.parse("2026-08-21T00:00:00.000Z");
  const readiness = createWeixinDeliveryReadiness({
    clock: () => current,
    staleMs: 5_000,
  });
  assert.deepEqual(readiness.snapshot(), {
    status: "not_ready",
    reason: "worker_unavailable",
  });
  assert.deepEqual(readiness.report({
    status: "not_ready",
    reason: "context_token_missing",
  }), {
    status: "not_ready",
    reason: "context_token_missing",
    reportedAt: "2026-08-21T00:00:00.000Z",
  });
  readiness.report({ status: "ready" });
  assert.equal(readiness.snapshot().status, "ready");
  current += 5_001;
  assert.deepEqual(readiness.snapshot(), {
    status: "not_ready",
    reason: "worker_unavailable",
    reportedAt: "2026-08-21T00:00:00.000Z",
  });
});

test("accepts only canonical UTC expiry timestamps and retains the last report when stale", () => {
  let current = Date.parse("2026-08-21T00:00:00.000Z");
  const readiness = createWeixinDeliveryReadiness({
    clock: () => current,
    staleMs: 5_000,
  });

  assert.deepEqual(readiness.report({
    status: "ready",
    expiresAt: "2026-08-21T23:00:00.000Z",
  }), {
    status: "ready",
    expiresAt: "2026-08-21T23:00:00.000Z",
    reportedAt: "2026-08-21T00:00:00.000Z",
  });

  for (const expiresAt of [
    "2026-08-21T23:00:00.000+00:00",
    " 2026-08-21T23:00:00.000Z",
    "2026-08-21T23:00:00Z",
    "not-a-date",
  ]) {
    assert.throws(
      () => readiness.report({ status: "ready", expiresAt }),
      /expiresAt is invalid/u,
      expiresAt,
    );
  }

  current += 5_001;
  assert.deepEqual(readiness.snapshot(), {
    status: "not_ready",
    reason: "worker_unavailable",
    expiresAt: "2026-08-21T23:00:00.000Z",
    reportedAt: "2026-08-21T00:00:00.000Z",
  });
});

test("fails closed when a ready report reaches its context expiry", () => {
  let current = Date.parse("2026-08-21T22:59:59.000Z");
  const readiness = createWeixinDeliveryReadiness({
    clock: () => current,
    staleMs: 5_000,
  });

  readiness.report({
    status: "ready",
    expiresAt: "2026-08-21T23:00:00.000Z",
  });
  assert.equal(readiness.snapshot().status, "ready");

  current = Date.parse("2026-08-21T23:00:00.000Z");
  assert.deepEqual(readiness.snapshot(), {
    status: "not_ready",
    reason: "context_token_expired",
    expiresAt: "2026-08-21T23:00:00.000Z",
    reportedAt: "2026-08-21T22:59:59.000Z",
  });
});
