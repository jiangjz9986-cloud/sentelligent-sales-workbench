import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWeixinWorker } from "../src/weixin/worker.js";

describe("WeChat worker wiring", () => {
  it("uses the remote persistent assistant event adapter", async () => {
    let capturedAgent;
    const requests = [];
    const sdk = {
      start(agent) {
        capturedAgent = agent;
        return { wait: async () => {} };
      },
    };
    const result = await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", text: "已处理" }) };
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 14).toString("base64url"),
        weixinAgentApiToken: "test-machine-token",
        weixinAgentBackendUrl: "https://sales.example.test",
        weixinAgentSenderId: "sender-1",
      },
    });

    assert.equal(result.status, "stopped");
    assert.ok(capturedAgent);
    const reply = await capturedAgent.chat({
      conversationId: "worker-conversation",
      senderId: "sender-1",
      text: "拜访医院",
    });
    assert.equal(reply.text, "已处理");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://sales.example.test/api/integrations/weixin-agent/events");
    assert.equal(JSON.parse(requests[0].options.body).senderId, "sender-1");
  });

  it("uses the SDK conversation id as the sender identity when the SDK has no sender field", async () => {
    let capturedAgent;
    const requests = [];
    const sdk = {
      start(agent) {
        capturedAgent = agent;
        return { wait: async () => {} };
      },
    };
    await runWeixinWorker(["start"], {
      sdk,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", text: "已处理" }) };
      },
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: Buffer.alloc(32, 15).toString("base64url"),
        weixinAgentApiToken: "test-machine-token",
        weixinAgentBackendUrl: "https://sales.example.test",
      },
    });
    await capturedAgent.chat({ conversationId: "sdk-user-id", text: "客户电话沟通" });
    assert.equal(JSON.parse(requests[0].options.body).senderId, "sdk-user-id");
  });
});
