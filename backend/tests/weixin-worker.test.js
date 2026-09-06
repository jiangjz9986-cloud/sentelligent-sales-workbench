import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { deriveWeixinProviderClientId, runWeixinWorker } from "../src/weixin/worker.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

function syntheticLabel(...parts) {
  return parts.join("-");
}

describe("WeChat worker wiring", () => {
  it("injects a stable 32-byte delivery key and forwards verified SDK metadata", async () => {
    const capturedStarts = [];
    const requests = [];
    const sdk = {
      start(agent, options) {
        capturedStarts.push({ agent, options });
        return { wait: async () => {} };
      },
    };
    const workerOptions = {
      sdk,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", text: "已处理" }) };
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 14).toString("base64url"),
        weixinAgentApiToken: syntheticLabel("worker", "token", "sentinel"),
        weixinAgentBackendUrl: "https://sales.example.test",
        weixinAllowedSenderIds: ["sender-1"],
      },
    };
    const result = await runWeixinWorker(["start"], workerOptions);
    await runWeixinWorker(["start"], workerOptions);
    await runWeixinWorker(["start"], {
      ...workerOptions,
      configOverrides: { ...workerOptions.configOverrides, weixinAgentApiToken: syntheticLabel("other", "worker", "token") },
    });

    assert.equal(result.status, "stopped");
    assert.equal(capturedStarts.length, 3);
    const expectedDeliveryKey = createHmac("sha256", Buffer.from(syntheticLabel("worker", "token", "sentinel"), "utf8"))
      .update("sentelligent/weixin-delivery-key/v1", "utf8")
      .digest();
    assert.ok(Buffer.isBuffer(capturedStarts[0].options.deliveryKey));
    assert.equal(capturedStarts[0].options.deliveryKey.length, 32);
    assert.deepEqual(capturedStarts[0].options.deliveryKey, expectedDeliveryKey);
    assert.deepEqual(capturedStarts[0].options.deliveryKey, capturedStarts[1].options.deliveryKey);
    assert.notDeepEqual(capturedStarts[0].options.deliveryKey, capturedStarts[2].options.deliveryKey);
    assert.equal(capturedStarts[0].options.authorizeInbound({
      senderId: "sender-1",
      chatType: "direct",
    }), true);
    // v0.9.3：sender 白名单入 DB——worker 放行全部私聊（未绑定者由后端入口闸
    // 回固定绑定引导）；群规则本地保留。
    assert.equal(capturedStarts[0].options.authorizeInbound({
      senderId: "unlisted-sender",
      chatType: "direct",
    }), true);
    assert.equal(capturedStarts[0].options.authorizeInbound({
      senderId: "sender-1",
      chatType: "group",
      groupId: "unlisted-group",
    }), false);

    const reply = await capturedStarts[0].agent.chat({
      conversationId: "worker-conversation",
      senderId: "sender-1",
      text: "拜访医院",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    });
    assert.equal(reply.text, "已处理");
    const eventRequests = requests.filter(({ url }) => url.endsWith("/api/integrations/weixin-agent/events"));
    assert.equal(eventRequests.length, 1);
    assert.equal(eventRequests[0].url, "https://sales.example.test/api/integrations/weixin-agent/events");
    assert.equal(JSON.parse(eventRequests[0].options.body).senderId, "sender-1");
  });

  it("fails closed for missing SDK delivery metadata without leaking worker secrets", async () => {
    let capturedAgent;
    const sdk = {
      start(agent, options) {
        capturedAgent = agent;
        assert.ok(Buffer.isBuffer(options.deliveryKey));
        return { wait: async () => {} };
      },
    };
    await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async () => assert.fail("invalid delivery must not reach fetch"),
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 15).toString("base64url"),
        weixinAgentApiToken: syntheticLabel("worker", "secret", "token", "sentinel"),
        weixinAgentBackendUrl: "https://sales.example.test",
      },
    });
    for (const missingField of ["senderId", "messageId", "chatType", "deliveryTimestampMs"]) {
      const request = {
        conversationId: "sdk-user-id",
        text: "客户电话沟通",
        senderId: "sender-1",
        messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
        chatType: "direct",
        deliveryTimestampMs: 1786500000123,
      };
      delete request[missingField];
      await assert.rejects(capturedAgent.chat(request), (error) => {
        assert.equal(error.code, "REMOTE_AGENT_INVALID_REQUEST");
        assert.doesNotMatch(error.message, /worker-secret-token-sentinel|[0-9a-f]{64}/i);
        return true;
      });
    }
  });

  it("delivers a leased item to the lease-designated target after re-verifying the hash", async () => {
    let releaseWait;
    const waitForAck = new Promise((resolve) => { releaseWait = resolve; });
    const sent = [];
    const requests = [];
    let leaseReturned = false;
    const sdk = {
      start() {
        return {
          getDeliveryStatus() { return { ready: true, status: "ready" }; },
          isDeliveryTarget(senderId) { return senderId === "sender-1"; },
          async sendMessageTo(senderId, message, options) { sent.push({ senderId, message, options }); },
          async wait() { await waitForAck; },
        };
      },
    };
    await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith("/api/integrations/weixin-agent/confirmation-outbox") && options.method === "GET") {
          if (leaseReturned) return new Response(null, { status: 204 });
          leaseReturned = true;
          return new Response(JSON.stringify({
            item: {
              id: "outbox-bound",
              owner: "assistant-owner",
              conversationId: shortcutBookkeepingConversationId("assistant-owner", "sender-1"),
              deliveryScope: shortcutBookkeepingConversationId("assistant-owner", "sender-1"),
              targetSenderId: "sender-1",
              message: "synthetic bookkeeping draft",
            },
            leaseToken: syntheticLabel("lease", "bound"),
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/api/integrations/weixin-agent/confirmation-outbox") && options.method === "POST") {
          if (JSON.parse(options.body).check === true) {
            return new Response(JSON.stringify({ current: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          releaseWait();
          return new Response(JSON.stringify({ item: { id: "outbox-bound", status: "sent" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected worker request: ${url}`);
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 16).toString("base64url"),
        weixinAgentApiToken: syntheticLabel("worker", "bound", "token"),
        weixinAgentBackendUrl: "https://sales.example.test",
        weixinAgentOwner: "assistant-owner",
        weixinBookkeepingConfirmationEnabled: true,
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].senderId, "sender-1");
    assert.equal(sent[0].message, "synthetic bookkeeping draft");
    const deliveryKey = createHmac("sha256", Buffer.from(syntheticLabel("worker", "bound", "token"), "utf8"))
      .update("sentelligent/weixin-delivery-key/v1", "utf8")
      .digest();
    assert.equal(
      sent[0].options.clientId,
      deriveWeixinProviderClientId(deliveryKey, "outbox-bound"),
    );
    assert.match(sent[0].options.clientId, /^sentelligent:[0-9a-f]{64}$/u);
    // v0.9.3 协议 v2：多绑定就绪哨兵取代唯一 scope 回显。
    const leaseRequest = requests.find(({ options }) => options.method === "GET");
    assert.equal(leaseRequest.options.headers["X-Weixin-Delivery-Status"], "ready");
    assert.equal(leaseRequest.options.headers["X-Weixin-Delivery-Scope"], "weixin:multi:v1");
  });

  it("terminally rejects a tampered lease target and acks unreachable targets as retryable", async () => {
    const acks = [];
    let phase = "tampered";
    let releaseWait;
    const waitForAcks = new Promise((resolve) => { releaseWait = resolve; });
    let sendCalls = 0;
    const sdk = {
      start() {
        return {
          getDeliveryStatus() { return { ready: true, status: "ready" }; },
          // 联系人列表尚未同步：目标暂不可达。
          isDeliveryTarget() { return false; },
          async sendMessageTo() { sendCalls += 1; },
          async wait() { await waitForAcks; },
        };
      },
    };
    const leaseBody = (targetSenderId) => JSON.stringify({
      item: {
        id: `outbox-${phase}`,
        owner: "assistant-owner",
        conversationId: shortcutBookkeepingConversationId("assistant-owner", "sender-1"),
        deliveryScope: shortcutBookkeepingConversationId("assistant-owner", "sender-1"),
        ...(targetSenderId ? { targetSenderId } : {}),
        message: "synthetic bookkeeping draft",
      },
      leaseToken: syntheticLabel("lease", phase),
    });
    await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async (url, options) => {
        if (options.method === "GET") {
          if (phase === "tampered") return new Response(leaseBody("sender-forged"), { status: 200, headers: { "Content-Type": "application/json" } });
          if (phase === "unreachable") return new Response(leaseBody("sender-1"), { status: 200, headers: { "Content-Type": "application/json" } });
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(options.body);
        if (body.check === true) {
          return new Response(JSON.stringify({ current: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        acks.push(body);
        phase = phase === "tampered" ? "unreachable" : "drained";
        if (acks.length === 2) releaseWait();
        return new Response(JSON.stringify({ item: { id: body.id, status: "queued" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 17).toString("base64url"),
        weixinAgentApiToken: syntheticLabel("worker", "mismatch", "token"),
        weixinAgentBackendUrl: "https://sales.example.test",
        weixinAgentOwner: "assistant-owner",
        weixinBookkeepingConfirmationEnabled: true,
      },
    });
    assert.equal(sendCalls, 0, "neither a forged nor an unreachable target may reach the SDK send");
    assert.equal(acks.length, 2);
    // 篡改目标（重算哈希不等）→ 终态 mismatch。
    assert.equal(acks[0].id, "outbox-tampered");
    assert.equal(acks[0].ok, false);
    assert.equal(acks[0].terminal, true);
    assert.equal(acks[0].errorCode, "WEIXIN_DELIVERY_SCOPE_MISMATCH");
    // 目标暂不可达 → 可重试 context-not-ready（8 次耗尽自然 failed）。
    assert.equal(acks[1].id, "outbox-unreachable");
    assert.equal(acks[1].ok, false);
    assert.notEqual(acks[1].terminal, true);
    assert.equal(acks[1].errorCode, "WEIXIN_CONTEXT_NOT_READY");
  });

  it("reports bookkeeping_not_configured while the confirmation surface is disabled", async () => {
    let releaseWait;
    const waitForPoll = new Promise((resolve) => { releaseWait = resolve; });
    const requests = [];
    const sdk = {
      start() {
        return {
          getDeliveryStatus() { return { ready: true, status: "ready" }; },
          isDeliveryTarget() { return true; },
          async sendMessageTo() {},
          async wait() { await waitForPoll; },
        };
      },
    };
    await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        releaseWait();
        return new Response(null, { status: 204 });
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 18).toString("base64url"),
        weixinAgentApiToken: syntheticLabel("worker", "disabled", "token"),
        weixinAgentBackendUrl: "https://sales.example.test",
        weixinAgentOwner: "assistant-owner",
        weixinBookkeepingConfirmationEnabled: false,
      },
    });
    assert.equal(requests[0].options.headers["X-Weixin-Delivery-Status"], "not_ready");
    assert.equal(requests[0].options.headers["X-Weixin-Delivery-Reason"], "bookkeeping_not_configured");
  });

  it("keeps help and worker errors free of tokens, keys, and deprecated fallback names", async () => {
    const token = syntheticLabel("worker", "help", "token", "sentinel");
    const deliveryKey = createHmac("sha256", Buffer.from(token, "utf8"))
      .update("sentelligent/weixin-delivery-key/v1", "utf8")
      .digest("hex");
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      output += String(chunk);
      return true;
    };
    try {
      await runWeixinWorker(["help"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.doesNotMatch(output, /worker-help-token-sentinel|WEIXIN_AGENT_SENDER_ID|WEIXIN_AGENT_CHAT_TYPE/i);
    assert.doesNotMatch(output, new RegExp(deliveryKey, "i"));
    await assert.rejects(
      runWeixinWorker(["unknown"], { configOverrides: { weixinAgentApiToken: token } }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(`worker-help-token-sentinel|${deliveryKey}`, "i"));
        return true;
      },
    );
  });
});
