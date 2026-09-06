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
  });
});
