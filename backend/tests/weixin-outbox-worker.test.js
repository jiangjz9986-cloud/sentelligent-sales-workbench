import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWeixinOutboxHttpClient, runWeixinOutboxPump } from "../src/weixin/outboxWorker.js";

function response(status, body = "") {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("WeChat confirmation outbox worker boundary", () => {
  it("leases, sends through the SDK bot, and acknowledges without exposing credentials", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") {
        return response(200, JSON.stringify({
          item: { id: "outbox-1", owner: "owner", conversationId: "conversation-1", deliveryScope: "delivery-scope-1", message: "金额 18.50 元\n确认码：123456" },
          leaseToken: "test-token",
        }));
      }
      if (JSON.parse(options.body).check === true) {
        return response(200, JSON.stringify({ current: true }));
      }
      return response(200, JSON.stringify({ item: { id: "outbox-1", status: "sent" } }));
    };
    const client = createWeixinOutboxHttpClient({ backendUrl: "http://127.0.0.1:8787", apiToken: "machine-secret", fetchImpl, workerId: "worker-1" });
    const sent = [];
    const controller = new AbortController();
    const pump = runWeixinOutboxPump({
      client,
      bot: {
        getDeliveryStatus() { return { ready: true, status: "ready" }; },
        async sendMessage(message) { sent.push(message); controller.abort(); },
      },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    await pump;
    assert.deepEqual(sent, ["金额 18.50 元\n确认码：123456"]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.headers.Authorization, "Bearer machine-secret");
    assert.equal(calls[0].options.headers["X-Weixin-Worker-Id"], "worker-1");
    assert.equal(calls[0].options.headers["X-Weixin-Delivery-Status"], "ready");
    assert.doesNotMatch(String(calls[1].options.body), /123456|machine-secret/u);
    assert.doesNotMatch(String(calls[2].options.body), /123456|machine-secret/u);
  });

  it("acks a bounded retry code when the SDK cannot send", async () => {
    const bodies = [];
    const fetchImpl = async (_url, options) => {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (body.check === true) return response(200, JSON.stringify({ current: true }));
      }
      if (options.method === "GET") return response(200, JSON.stringify({ item: { id: "outbox-2", owner: "owner", conversationId: "c", deliveryScope: "delivery-scope-2", message: "draft" }, leaseToken: "test-token" }));
      return response(200, JSON.stringify({ item: { id: "outbox-2", status: "queued", lastErrorCode: "WEIXIN_SEND_FAILED" } }));
    };
    const client = createWeixinOutboxHttpClient({ backendUrl: "http://127.0.0.1:8787", apiToken: "machine-secret", fetchImpl });
    const controller = new AbortController();
    let attempts = 0;
    const pump = runWeixinOutboxPump({
      client,
      bot: {
        getDeliveryStatus() { return { ready: true, status: "ready" }; },
        async sendMessage() { attempts += 1; controller.abort(); throw new Error("private provider detail"); },
      },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    await pump;
    assert.equal(attempts, 1);
    assert.equal(bodies[1].ok, false);
    assert.equal(bodies[1].errorCode, "WEIXIN_SEND_FAILED");
    assert.equal(JSON.stringify(bodies).includes("private provider detail"), false);
  });

  it("reports missing context without leasing or consuming a delivery attempt", async () => {
    const controller = new AbortController();
    const calls = [];
    const client = createWeixinOutboxHttpClient({
      backendUrl: "http://127.0.0.1:8787",
      apiToken: "machine-secret",
      fetchImpl: async (_url, options) => {
        calls.push(options);
        controller.abort();
        return response(204);
      },
    });
    let sendCalls = 0;
    await runWeixinOutboxPump({
      client,
      bot: {
        getDeliveryStatus() {
          return { ready: false, status: "not_ready", reason: "context_token_missing" };
        },
        async sendMessage() { sendCalls += 1; },
      },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["X-Weixin-Delivery-Status"], "not_ready");
    assert.equal(calls[0].headers["X-Weixin-Delivery-Reason"], "context_token_missing");
    assert.equal(sendCalls, 0);
  });

  it("does not acknowledge an unexpected legacy-backend lease while locally not ready", async () => {
    const controller = new AbortController();
    const acknowledgements = [];
    let sendCalls = 0;
    let reportedDelivery;
    await runWeixinOutboxPump({
      client: {
        async lease(delivery) {
          reportedDelivery = delivery;
          controller.abort();
          return {
            item: { id: "legacy-lease", owner: "owner", conversationId: "scope", message: "draft" },
            leaseToken: ["legacy", "lease"].join("-"),
          };
        },
        async ack(value) { acknowledgements.push(value); },
        async isCurrent() { return true; },
      },
      bot: {
        getDeliveryStatus() {
          return { ready: false, status: "not_ready", reason: "context_token_missing" };
        },
        async sendMessage() { sendCalls += 1; },
      },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.equal(reportedDelivery.status, "not_ready");
    assert.equal(sendCalls, 0);
    assert.deepEqual(acknowledgements, []);
  });

  it("fails closed when the SDK has no delivery readiness capability", async () => {
    const controller = new AbortController();
    let reportedDelivery;
    await runWeixinOutboxPump({
      client: {
        async lease(delivery) {
          reportedDelivery = delivery;
          controller.abort();
          return null;
        },
        async ack() { assert.fail("no lease may be acknowledged"); },
        async isCurrent() { return true; },
      },
      bot: { async sendMessage() { assert.fail("not-ready SDK must not send"); } },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.deepEqual(reportedDelivery, {
      ready: false,
      status: "not_ready",
      reason: "sdk_status_unavailable",
    });
  });

  it("rejects a legacy backend lease that has no bound delivery scope", async () => {
    const client = createWeixinOutboxHttpClient({
      backendUrl: "http://127.0.0.1:8787",
      apiToken: "machine-secret",
      fetchImpl: async () => response(200, JSON.stringify({
        item: { id: "legacy-outbox", owner: "owner", conversationId: "legacy-conversation", message: "draft" },
        leaseToken: ["legacy", "lease"].join("-"),
      })),
    });
    await assert.rejects(
      client.lease({ ready: true, status: "ready" }),
      /outbox_lease_invalid/u,
    );
  });

  it("rechecks the lease immediately before provider send and drops a superseded draft", async () => {
    const controller = new AbortController();
    let sendCalls = 0;
    let ackCalls = 0;
    await runWeixinOutboxPump({
      client: {
        async lease() {
          return {
            item: { id: "superseded-outbox", owner: "owner", conversationId: "scope", deliveryScope: "scope", message: "stale draft" },
            leaseToken: ["superseded", "lease"].join("-"),
          };
        },
        async isCurrent() {
          controller.abort();
          return false;
        },
        async ack() { ackCalls += 1; },
      },
      bot: {
        getDeliveryStatus() { return { ready: true, status: "ready" }; },
        async sendMessage() { sendCalls += 1; },
      },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.equal(sendCalls, 0);
    assert.equal(ackCalls, 0);
  });

  it("terminally rejects an outbox item outside the configured delivery scope", async () => {
    const controller = new AbortController();
    const acknowledgements = [];
    let sendCalls = 0;
    await runWeixinOutboxPump({
      client: {
        async lease() {
          return {
            item: { id: "outbox-scope", owner: "wrong-owner", conversationId: "wrong-scope", message: "draft" },
            leaseToken: "test-token",
          };
        },
        async ack(value) {
          acknowledgements.push(value);
          controller.abort();
        },
        async isCurrent() { return true; },
      },
      bot: {
        getDeliveryStatus() { return { ready: true, status: "ready" }; },
        async sendMessage() { sendCalls += 1; },
      },
      authorizeDelivery: () => false,
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.equal(sendCalls, 0);
    assert.deepEqual(acknowledgements, [{
      id: "outbox-scope",
      leaseToken: "test-token",
      ok: false,
      terminal: true,
      errorCode: "WEIXIN_DELIVERY_SCOPE_MISMATCH",
    }]);
  });

  it("terminally rejects a delivery-target race reported by the bound SDK", async () => {
    const controller = new AbortController();
    const acknowledgements = [];
    await runWeixinOutboxPump({
      client: {
        async lease() {
          return {
            item: { id: "outbox-target-race", owner: "owner", deliveryScope: "scope", message: "draft" },
            leaseToken: ["target", "race", "lease"].join("-"),
          };
        },
        async ack(value) {
          acknowledgements.push(value);
          controller.abort();
        },
        async isCurrent() { return true; },
      },
      bot: {
        getDeliveryStatus() { return { ready: true, status: "ready" }; },
        async sendMessage() {
          const error = new Error("private target detail");
          error.code = "WEIXIN_DELIVERY_TARGET_MISMATCH";
          throw error;
        },
      },
      authorizeDelivery: () => true,
      pollMs: 500,
      abortSignal: controller.signal,
    });
    assert.deepEqual(acknowledgements, [{
      id: "outbox-target-race",
      leaseToken: ["target", "race", "lease"].join("-"),
      ok: false,
      terminal: true,
      errorCode: "WEIXIN_DELIVERY_SCOPE_MISMATCH",
    }]);
    assert.doesNotMatch(JSON.stringify(acknowledgements), /private target detail/u);
  });
});
