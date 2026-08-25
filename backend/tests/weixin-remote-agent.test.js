import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { validateWeixinAssistantEvent } from "../src/assistant/weixinEvent.js";
import { createRemoteClawbotAgent } from "../src/weixin/remoteAgent.js";
import { VALID_JPEG, VALID_PNG } from "./helpers/image-fixtures.js";

const temporaryDirectories = [];

async function mediaPath() {
  const directory = await mkdtemp(join(tmpdir(), "sentelligent-remote-agent-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "receipt.png");
  await writeFile(filePath, VALID_PNG);
  return filePath;
}

async function jpegMediaPath() {
  const directory = await mkdtemp(join(tmpdir(), "sentelligent-remote-agent-jpeg-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "payment-proof.jpg");
  await writeFile(filePath, VALID_JPEG);
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
        type: "image",
        fileName: "receipt.png",
        mediaType: "image/png",
        contentBase64: VALID_PNG.toString("base64"),
        sha256: body.media.sha256,
        sourceRef: body.media.sourceRef,
      },
    });
    assert.doesNotMatch(calls[0].options.body, /must-not-be-forwarded|rawUpdate|filePath|test-machine-token|[A-Z]:\\/i);
  });

  it("carries a real file-path JPEG through the remote HTTP body and strict event validator", async () => {
    const filePath = await jpegMediaPath();
    let postedBody;
    let validatedEvent;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-machine-token",
      fetchImpl: async (_url, options) => {
        postedBody = JSON.parse(options.body);
        validatedEvent = await validateWeixinAssistantEvent(postedBody);
        return jsonResponse({ status: "ok", reply: "received" });
      },
    });

    const result = await agent.chat({
      conversationId: "conversation-jpeg",
      text: "",
      senderId: "sender-1",
      messageId: `weixin:delivery:v1:${"b".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1_786_500_000_123,
      media: { type: "image", filePath, mimeType: "image/*", fileName: "payment-proof.jpg" },
    });

    assert.deepEqual(result, { status: "ok", reply: "received" });
    assert.equal(postedBody.media.type, "image");
    assert.equal(postedBody.media.mediaType, "image/jpeg");
    assert.equal(postedBody.media.contentBase64, VALID_JPEG.toString("base64"));
    assert.equal(validatedEvent.media.mediaType, "image/jpeg");
    assert.equal(validatedEvent.media.contentBase64, VALID_JPEG.toString("base64"));
    assert.equal(Object.hasOwn(postedBody.media, "filePath"), false);
  });

  it("preserves only the exact image and file media kinds at the remote boundary", async () => {
    const filePath = await mediaPath();
    const postedTypes = [];
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-machine-token",
      fetchImpl: async (_url, options) => {
        postedTypes.push(JSON.parse(options.body).media.type);
        return jsonResponse({ status: "ok" });
      },
    });
    const delivery = {
      conversationId: "conversation-media-kind",
      text: "",
      senderId: "sender-1",
      chatType: "direct",
      deliveryTimestampMs: 1_786_500_000_123,
    };

    for (const [index, type] of ["image", "file"].entries()) {
      await agent.chat({
        ...delivery,
        messageId: `weixin:delivery:v1:${String(index + 1).repeat(64)}`,
        media: { type, filePath, mimeType: "image/png", fileName: "receipt.png" },
      });
    }
    for (const [index, type] of [" image ", "IMAGE", "audio"].entries()) {
      await assert.rejects(agent.chat({
        ...delivery,
        messageId: `weixin:delivery:v1:${String(index + 3).repeat(64)}`,
        media: { type, filePath, mimeType: "image/png", fileName: "receipt.png" },
      }), { code: "REMOTE_AGENT_MEDIA_INVALID" });
    }

    assert.deepEqual(postedTypes, ["image", "file"]);
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

  it("returns only strict bounded 409 business replies to WeChat", async () => {
    let reply = { status: "clarify", text: "请引用对应的最新记账草稿。" };
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => jsonResponse(reply, 409),
    });
    const request = {
      conversationId: "c-1",
      text: "修改备注为客户拜访",
      senderId: "sender-1",
      messageId: `weixin:delivery:v1:${"a".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    };

    for (const status of ["clarify", "review_required", "error"]) {
      reply = { status, text: `bounded-${status}` };
      assert.deepEqual(await agent.chat(request), reply);
    }
  });

  it("rejects malformed or expanded 409 response shapes as permanent safe errors", async () => {
    let responseBody = { status: "clarify", text: "valid", debug: { path: "/private/db" } };
    let rawResponse = null;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => rawResponse ?? jsonResponse(responseBody, 409),
    });
    const request = {
      conversationId: "c-1",
      text: "修改备注为客户拜访",
      senderId: "sender-1",
      messageId: `weixin:delivery:v1:${"b".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    };
    const invalidBodies = [
      responseBody,
      { status: "ok", text: "not-allowlisted" },
      { status: "clarify", text: "" },
      { status: "clarify", text: "   " },
      { status: "clarify", text: "contains\ncontrol" },
      { status: "clarify", text: "x".repeat(20_001) },
      { status: "clarify" },
      ["clarify", "text"],
    ];

    for (const invalidBody of invalidBodies) {
      responseBody = invalidBody;
      await assert.rejects(agent.chat(request), (error) => {
        assert.equal(error.code, "REMOTE_AGENT_REQUEST_FAILED");
        assert.equal(error.message, "远程助手暂时不可用，请稍后重试");
        assert.equal(error.permanent, true);
        return true;
      });
    }

    rawResponse = { ok: false, status: 409, text: async () => "{not-json" };
    await assert.rejects(agent.chat(request), { code: "REMOTE_AGENT_REQUEST_FAILED", permanent: true });
  });

  it("keeps authorization and server failures exceptional", async () => {
    let backendStatus = 401;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => jsonResponse({ status: "clarify", text: "must not be returned" }, backendStatus),
    });
    const request = {
      conversationId: "c-1",
      text: "hello",
      senderId: "sender-1",
      messageId: `weixin:delivery:v1:${"c".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    };

    for (const status of [401, 403, 500]) {
      backendStatus = status;
      await assert.rejects(agent.chat(request), (error) => {
        assert.equal(error.code, "REMOTE_AGENT_REQUEST_FAILED");
        assert.equal(error.permanent, status < 500);
        return true;
      });
    }
  });

  it("marks permanent backend authorization responses so one message cannot poison retries", async () => {
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => jsonResponse({ error: { code: "WEIXIN_SENDER_NOT_ALLOWED" } }, 403),
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
        assert.equal(error.permanent, true);
        return true;
      },
    );
  });

  it("bounds chunked backend responses before buffering them in memory", async () => {
    const chunk = new Uint8Array(600 * 1024);
    let reads = 0;
    let cancelled = false;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "test-secret-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => (reads++ < 2 ? { value: chunk, done: false } : { value: undefined, done: true }),
            cancel: async () => { cancelled = true; },
            releaseLock: () => {},
          }),
        },
        text: async () => assert.fail("streaming responses must not fall back to text()"),
      }),
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
        assert.equal(error.code, "REMOTE_AGENT_INVALID_RESPONSE");
        assert.equal(error.message, "远程助手暂时不可用，请稍后重试");
        return true;
      },
    );
    assert.equal(cancelled, true);
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

  it("forwards only bounded structured quote fields for precise pending-draft selection", async () => {
    let requestBody;
    const agent = createRemoteClawbotAgent({
      backendUrl: "https://sales.example.test",
      apiToken: "token",
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return jsonResponse({ status: "ok", text: "received" });
      },
    });

    await agent.chat({
      conversationId: "c-quote",
      text: "确认",
      quotedMessageId: "provider-outbound-1",
      quotedText: "检测到一笔新记账\n待确认编号：BK-0123456789AB",
      senderId: "sender-from-message",
      chatType: "direct",
      messageId: `weixin:delivery:v1:${"b".repeat(64)}`,
      deliveryTimestampMs: 1786500000123,
      rawUpdate: { private: "must-not-be-forwarded" },
    });

    assert.equal(requestBody.quotedMessageId, "provider-outbound-1");
    assert.equal(requestBody.quotedText, "检测到一笔新记账\n待确认编号：BK-0123456789AB");
    assert.equal(Object.hasOwn(requestBody, "rawUpdate"), false);
  });
});
