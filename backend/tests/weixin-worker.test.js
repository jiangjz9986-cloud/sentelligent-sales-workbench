import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { runWeixinWorker } from "../src/weixin/worker.js";

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

    const reply = await capturedStarts[0].agent.chat({
      conversationId: "worker-conversation",
      senderId: "sender-1",
      text: "拜访医院",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    });
    assert.equal(reply.text, "已处理");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://sales.example.test/api/integrations/weixin-agent/events");
    assert.equal(JSON.parse(requests[0].options.body).senderId, "sender-1");
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
