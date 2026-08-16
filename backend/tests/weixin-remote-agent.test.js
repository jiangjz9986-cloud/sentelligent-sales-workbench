import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createRemoteClawbotAgent } from "../src/weixin/remoteAgent.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

const temporaryDirectories = [];

async function mediaPath() {
  const directory = await mkdtemp(join(tmpdir(), "sentelligent-remote-agent-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "receipt.png");
  await writeFile(filePath, VALID_PNG);
  return filePath;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("remote Clawbot agent adapter", () => {
  it("rejects plaintext remote backends while allowing loopback test endpoints", () => {
    assert.throws(
      () => createRemoteClawbotAgent({ backendUrl: "http://backend.example.test", apiToken: "token" }),
      /HTTPS|secure|TLS/i,
    );
    assert.doesNotThrow(() => createRemoteClawbotAgent({ backendUrl: "http://127.0.0.1:8787", apiToken: "token" }));
  });

  it("posts text and normalized media bytes without local-only fields", async () => {
    const calls = [];
    const filePath = await mediaPath();
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test/",
      apiToken: "test-machine-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ status: "ok", reply: "received" });
      },
    });

    const messageId = `weixin:delivery:v1:${"a".repeat(64)}`;
    const result = await agent.chat({
      conversationId: "conversation-1",
      text: " 午餐 48.50 元 ",
      senderId: "sender-1",
      messageId,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
      owner: "must-not-be-forwarded",
      rawUpdate: { secret: "must-not-be-forwarded" },
      media: { type: "image", filePath, mimeType: "image/*", fileName: "receipt.png" },
    });

    assert.deepEqual(result, { status: "ok", reply: "received" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sales.example.test/api/integrations/weixin-agent/events");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-machine-token");
    assert.equal(calls[0].options.headers["Idempotency-Key"], messageId);
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      conversationId: "conversation-1",
      text: " 午餐 48.50 元 ",
      sourceMessageId: messageId,
      senderId: "sender-1",
      chatType: "direct",
      media: {
        fileName: "receipt.png",
        mediaType: "image/png",
        contentBase64: VALID_PNG.toString("base64"),
        sha256: body.media.sha256,
        sourceRef: body.media.sourceRef,
      },
    });
    assert.doesNotMatch(calls[0].options.body, /must-not-be-forwarded|rawUpdate|filePath|test-machine-token|[A-Z]:\\/i);
  });

  it("keeps the legacy digest fallback available only when explicitly injected for tests", async () => {
    const calls = [];
    const filePath = await mediaPath();
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "token",
      allowSyntheticIdentity: true,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ status: "ok" });
      },
    });

    await agent.chat({ conversationId: "c-1", text: "same", media: { type: "image", filePath, mimeType: "image/*" } });
    await agent.chat({ conversationId: "c-1", text: "same", media: { type: "image", filePath, mimeType: "image/*" } });
    await agent.chat({ conversationId: "c-1", text: "different", media: { type: "image", filePath, mimeType: "image/*" } });

    const firstBody = JSON.parse(calls[0].options.body);
    const secondBody = JSON.parse(calls[1].options.body);
    const thirdBody = JSON.parse(calls[2].options.body);
    assert.equal(firstBody.sourceMessageId, secondBody.sourceMessageId);
    assert.equal(calls[0].options.headers["Idempotency-Key"], calls[1].options.headers["Idempotency-Key"]);
    assert.notEqual(firstBody.sourceMessageId, thirdBody.sourceMessageId);
    assert.notEqual(calls[0].options.headers["Idempotency-Key"], calls[2].options.headers["Idempotency-Key"]);
  });

  it("rejects production requests missing verified delivery metadata before fetch", async () => {
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => assert.fail("invalid delivery must not reach fetch"),
    });
    const delivery = {
      conversationId: "synthetic-conversation",
      text: "synthetic text",
      senderId: "synthetic-sender",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    };
    for (const missingField of ["senderId", "messageId", "chatType", "deliveryTimestampMs"]) {
      const request = { ...delivery };
      delete request[missingField];
      await assert.rejects(agent.chat(request), (error) => {
        assert.equal(error.code, "REMOTE_AGENT_INVALID_REQUEST");
        assert.doesNotMatch(error.message, /test-secret-token|[0-9a-f]{64}/i);
        return true;
      });
    }
  });

  it("rejects malformed direct/group delivery metadata before media normalization", async () => {
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "token",
      fetchImpl: async () => assert.fail("invalid delivery must not reach fetch"),
    });
    const delivery = {
      conversationId: "synthetic-conversation",
      text: " synthetic text ",
      senderId: "synthetic-sender",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
      media: { type: "image", filePath: "/must-not-be-read" },
    };
    for (const invalid of [
      { groupId: "forbidden-for-direct" },
      { chatType: "group", groupId: undefined },
      { senderId: "sender\ncontrol" },
      { conversationId: "c".repeat(501) },
      { conversationId: "" },
      { messageId: "weixin:delivery:v1:not-a-digest" },
      { deliveryTimestampMs: 0 },
    ]) {
      await assert.rejects(agent.chat({ ...delivery, ...invalid }), { code: "REMOTE_AGENT_INVALID_REQUEST" });
    }
  });

  it("rejects non-JSON or non-2xx responses with a safe error", async () => {
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => jsonResponse({ message: "internal C:\\private\\db.sqlite test-secret-token" }, 500),
    });

    await assert.rejects(
      agent.chat({
        conversationId: "c-1",
        text: "hello",
        senderId: "sender-1",
        messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
        chatType: "direct",
        deliveryTimestampMs: 1786500000123,
      }),
      (error) => {
        assert.equal(error.code, "REMOTE_AGENT_REQUEST_FAILED");
        assert.equal(error.message, "远程助手暂时不可用，请稍后重试");
        assert.doesNotMatch(error.message, /internal|private|sqlite|test-secret-token/i);
        return true;
      },
    );
  });

  it("forwards sender and chat metadata while keeping the owner server-owned", async () => {
    let requestBody;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "token",
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return jsonResponse({ status: "ok", text: "received" });
      },
    });

    const result = await agent.chat({
      conversationId: "c-1",
      text: "拜访医院",
      senderId: "sender-from-message",
      chatType: "group",
      groupId: "group-1",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      deliveryTimestampMs: 1786500000123,
      pendingActionId: "action-1",
      confirmationCode: "482913",
      owner: "attacker-owner",
    });

    assert.equal(result.text, "received");
    assert.equal(requestBody.senderId, "sender-from-message");
    assert.equal(requestBody.chatType, "group");
    assert.equal(requestBody.groupId, "group-1");
    assert.equal(requestBody.sourceMessageId, `weixin:delivery:v1:${"a".repeat(64)}`);
    assert.equal(Object.hasOwn(requestBody, "pendingActionId"), false);
    assert.equal(Object.hasOwn(requestBody, "confirmationCode"), false);
    assert.equal(Object.hasOwn(requestBody, "owner"), false);
  });
});
