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
          item: { id: "outbox-1", owner: "owner", conversationId: "conversation-1", message: "金额 18.50 元\n确认码：123456" },
          leaseToken: "test-token",
        }));
      }
      return response(200, JSON.stringify({ item: { id: "outbox-1", status: "sent" } }));
    };
    const client = createWeixinOutboxHttpClient({ backendUrl: "http://127.0.0.1:8787", apiToken: "machine-secret", fetchImpl, workerId: "worker-1" });
    const sent = [];
    const controller = new AbortController();
    const pump = runWeixinOutboxPump({
      client,
      bot: { async sendMessage(message) { sent.push(message); controller.abort(); } },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    await pump;
    assert.deepEqual(sent, ["金额 18.50 元\n确认码：123456"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Authorization, "Bearer machine-secret");
    assert.equal(calls[0].options.headers["X-Weixin-Worker-Id"], "worker-1");
    assert.doesNotMatch(String(calls[1].options.body), /123456|machine-secret/u);
  });

  it("acks a bounded retry code when the SDK cannot send", async () => {
    const bodies = [];
    const fetchImpl = async (_url, options) => {
      if (options.method === "POST") bodies.push(JSON.parse(options.body));
      if (options.method === "GET") return response(200, JSON.stringify({ item: { id: "outbox-2", owner: "owner", conversationId: "c", message: "draft" }, leaseToken: "test-token" }));
      return response(200, JSON.stringify({ item: { id: "outbox-2", status: "queued", lastErrorCode: "WEIXIN_SEND_FAILED" } }));
    };
    const client = createWeixinOutboxHttpClient({ backendUrl: "http://127.0.0.1:8787", apiToken: "machine-secret", fetchImpl });
    const controller = new AbortController();
    let attempts = 0;
    const pump = runWeixinOutboxPump({
      client,
      bot: { async sendMessage() { attempts += 1; controller.abort(); throw new Error("private provider detail"); } },
      pollMs: 500,
      abortSignal: controller.signal,
    });
    await pump;
    assert.equal(attempts, 1);
    assert.equal(bodies[0].ok, false);
    assert.equal(bodies[0].errorCode, "WEIXIN_SEND_FAILED");
    assert.equal(JSON.stringify(bodies).includes("private provider detail"), false);
  });
});
