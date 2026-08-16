import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  normalizeInboundUpdate,
  start,
} from "../vendor/weixin-agent-sdk/dist/index.mjs";

const DELIVERY_KEY = Buffer.alloc(32, 7);
const DELIVERY_PREFIX = "weixin:delivery:v1:";
const DELIVERY_DOMAIN = "sentelligent/weixin-delivery-id/v1";

function syntheticLabel(...parts) {
  return parts.join("-");
}

function textUpdate(overrides = {}) {
  return {
    from_user_id: "synthetic-sender-a",
    create_time_ms: 1786500000123,
    item_list: [{ type: 1, text_item: { text: "synthetic hello" } }],
    ...overrides,
  };
}

function expectedDeliveryId(parts, deliveryKey = DELIVERY_KEY) {
  const encoded = Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.byteLength);
    return Buffer.concat([length, value]);
  }));
  return DELIVERY_PREFIX + createHmac("sha256", deliveryKey).update(encoded).digest("hex");
}

async function withSyntheticAccount(label, run) {
  const stateDir = await mkdtemp(join(tmpdir(), `sentelligent-weixin-${label}-`));
  const accountId = `synthetic-${label}`;
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  await mkdir(accountDir, { recursive: true });
  await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
  await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({
    token: syntheticLabel("unit", "account", "token"),
    baseUrl: "https://synthetic-weixin.invalid",
    userId: "synthetic-bot-user",
  }));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousFetch = globalThis.fetch;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await run({ accountId, stateDir });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function snapshotInternalLogs() {
  const logDir = join(tmpdir(), "openclaw");
  const offsets = new Map();
  let names = [];
  try {
    names = await readdir(logDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const filePath = join(logDir, name);
    offsets.set(filePath, (await stat(filePath)).size);
  }
  return offsets;
}

async function readInternalLogDelta(offsets) {
  const logDir = join(tmpdir(), "openclaw");
  let names = [];
  try {
    names = await readdir(logDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const chunks = [];
  for (const name of names) {
    const filePath = join(logDir, name);
    const content = await readFile(filePath);
    chunks.push(content.subarray(offsets.get(filePath) ?? 0).toString("utf8"));
  }
  return chunks.join("\n");
}

describe("vendored Weixin inbound adapter", () => {
  it("uses the only canonical upstream id and returns the same opaque id for a retry", () => {
    const update = textUpdate({ message_id: "synthetic-message-a" });
    const request = normalizeInboundUpdate(update, { deliveryKey: DELIVERY_KEY });
    const retry = normalizeInboundUpdate(structuredClone(update), { deliveryKey: DELIVERY_KEY });

    assert.deepEqual(request, {
      conversationId: "synthetic-sender-a",
      text: "synthetic hello",
      senderId: "synthetic-sender-a",
      messageId: request.messageId,
      chatType: "direct",
      deliveryTimestampMs: 1786500000123,
    });
    assert.match(request.messageId, /^weixin:delivery:v1:[0-9a-f]{64}$/u);
    assert.equal(request.messageId, retry.messageId);
    assert.equal(
      request.messageId,
      expectedDeliveryId([
        DELIVERY_DOMAIN,
        "synthetic-sender-a",
        "synthetic-message-a",
      ]),
    );
    assert.equal(request.messageId.includes("synthetic-message-a"), false);
    assert.equal(Object.isFrozen(request), true);
  });

  it("rejects two different non-empty upstream id candidates", () => {
    assert.throws(
      () => normalizeInboundUpdate(textUpdate({
        message_id: undefined,
        msg_id: "synthetic-message-a",
        client_id: "synthetic-message-b",
      }), { deliveryKey: DELIVERY_KEY }),
      /upstream.*id|message.*id|ambiguous/iu,
    );

    const request = normalizeInboundUpdate(textUpdate({
      message_id: "synthetic-message-a",
      msg_id: "synthetic-message-a",
      client_id: "",
    }), { deliveryKey: DELIVERY_KEY });
    assert.equal(request.messageId, expectedDeliveryId([
      DELIVERY_DOMAIN,
      "synthetic-sender-a",
      "synthetic-message-a",
    ]));
  });

  it("uses the numeric provider message_id before an auxiliary client_id", () => {
    const request = normalizeInboundUpdate(textUpdate({
      message_id: 123456789,
      client_id: "synthetic-client-generated-id",
    }), { deliveryKey: DELIVERY_KEY });

    assert.equal(request.messageId, expectedDeliveryId([
      DELIVERY_DOMAIN,
      "synthetic-sender-a",
      "123456789",
    ]));
  });

  it("preserves an unsafe 64-bit provider message_id before normalization", async () => {
    await withSyntheticAccount("numeric-provider-id", async ({ accountId }) => {
      const abortController = new AbortController();
      const providerMessageId = "1234567890123456789";
      let request;
      let updatePolls = 0;
      globalThis.fetch = async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) {
            const raw = JSON.stringify({
              ret: 0,
              get_updates_buf: "synthetic-numeric-provider-id-cursor",
              msgs: [textUpdate({
                message_id: "synthetic-numeric-provider-id-placeholder",
                client_id: "synthetic-client-generated-id",
                group_id: "",
              })],
            }).replace('"synthetic-numeric-provider-id-placeholder"', providerMessageId);
            return new Response(raw, { status: 200 });
          }
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        if (endpoint.endsWith("/sendmessage")) return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat(value) {
          request = value;
          return { text: "synthetic numeric-id reply" };
        },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        log() {},
      });
      await bot.wait();

      assert.equal(request.messageId, expectedDeliveryId([
        DELIVERY_DOMAIN,
        "synthetic-sender-a",
        providerMessageId,
      ]));
    });
  });

  it("falls back to sender timestamp ordered item types text media sha and normalized filename", () => {
    const decomposedName = "../private/cafe\u0301.png";
    const media = {
      sha256: "1f".repeat(32),
      fileName: decomposedName,
    };
    const update = textUpdate({
      item_list: [
        { type: 1, text_item: { text: "synthetic hello" } },
        { type: 2, image_item: { url: "https://cdn.invalid/private" } },
      ],
    });
    const request = normalizeInboundUpdate(update, { deliveryKey: DELIVERY_KEY, media });
    const canonicalMaterial = JSON.stringify({
      itemTypes: [1, 2],
      text: "synthetic hello",
      mediaSha256: "1f".repeat(32),
      fileName: "café.png",
    });

    assert.equal(request.messageId, expectedDeliveryId([
      DELIVERY_DOMAIN,
      "synthetic-sender-a",
      "1786500000123",
      canonicalMaterial,
    ]));

    for (const invalidName of ["bad\u0000name.png", "..\\bad\nname.png"]) {
      const invalidNameRequest = normalizeInboundUpdate(update, {
        deliveryKey: DELIVERY_KEY,
        media: { ...media, fileName: invalidName },
      });
      const invalidNameMaterial = JSON.stringify({
        itemTypes: [1, 2],
        text: "synthetic hello",
        mediaSha256: "1f".repeat(32),
        fileName: null,
      });
      assert.equal(invalidNameRequest.messageId, expectedDeliveryId([
        DELIVERY_DOMAIN,
        "synthetic-sender-a",
        "1786500000123",
        invalidNameMaterial,
      ]));
    }
  });

  it("distinguishes identical six-digit text sent at different millisecond timestamps", () => {
    const first = normalizeInboundUpdate(textUpdate({
      create_time_ms: 1786500000123,
      item_list: [{ type: 1, text_item: { text: "123456" } }],
    }), { deliveryKey: DELIVERY_KEY });
    const second = normalizeInboundUpdate(textUpdate({
      create_time_ms: 1786500000124,
      item_list: [{ type: 1, text_item: { text: "123456" } }],
    }), { deliveryKey: DELIVERY_KEY });

    assert.notEqual(first.messageId, second.messageId);
  });

  it("rejects missing sender unsafe timestamp empty item list control characters and oversized identifiers", async (t) => {
    const cases = [
      ["missing sender", textUpdate({ from_user_id: undefined })],
      ["zero timestamp", textUpdate({ create_time_ms: 0 })],
      ["unsafe timestamp", textUpdate({ create_time_ms: Number.MAX_SAFE_INTEGER + 1 })],
      ["empty items", textUpdate({ item_list: [] })],
      ["sender control character", textUpdate({ from_user_id: "sender\nvalue" })],
      ["upstream id control character", textUpdate({ message_id: "message\u0000value" })],
      ["oversized sender", textUpdate({ from_user_id: "s".repeat(501) })],
      ["oversized upstream id", textUpdate({ message_id: "m".repeat(501) })],
    ];

    for (const [name, update] of cases) {
      await t.test(name, () => {
        assert.throws(
          () => normalizeInboundUpdate(update, { deliveryKey: DELIVERY_KEY }),
          TypeError,
        );
      });
    }

    assert.throws(
      () => normalizeInboundUpdate(textUpdate(), { deliveryKey: Buffer.alloc(31) }),
      TypeError,
    );
  });

  it("defaults to direct only when no group signal exists", () => {
    const request = normalizeInboundUpdate(textUpdate(), { deliveryKey: DELIVERY_KEY });
    assert.equal(request.chatType, "direct");
    assert.equal("groupId" in request, false);

    for (const placeholder of [
      { group_id: "" },
      { room_id: null },
      { chat_type: undefined },
    ]) {
      const placeholderRequest = normalizeInboundUpdate(textUpdate(placeholder), {
        deliveryKey: DELIVERY_KEY,
      });
      assert.equal(placeholderRequest.chatType, "direct");
      assert.equal("groupId" in placeholderRequest, false);
    }

    for (const signal of [
      { group_id: "synthetic-group-a" },
      { room_id: "synthetic-group-a" },
      { chat_type: "group" },
      { is_group: true },
    ]) {
      assert.throws(
        () => normalizeInboundUpdate(textUpdate(signal), { deliveryKey: DELIVERY_KEY }),
        /group|chat.*metadata|unrecognized/iu,
      );
    }
  });

  it("requires groupId for an explicit group and rejects contradictory direct/group fields", () => {
    const group = normalizeInboundUpdate(textUpdate(), {
      deliveryKey: DELIVERY_KEY,
      chatMetadata: { chatType: "group", groupId: "synthetic-group-a" },
    });
    assert.equal(group.chatType, "group");
    assert.equal(group.groupId, "synthetic-group-a");
    assert.equal(group.conversationId, "synthetic-group-a");

    for (const chatMetadata of [
      { chatType: "group" },
      { chatType: "direct", groupId: "synthetic-group-a" },
      { chatType: "group", groupId: "group\nvalue" },
      { chatType: "unknown", groupId: "synthetic-group-a" },
      { chatType: "group", groupId: "g".repeat(501) },
    ]) {
      assert.throws(
        () => normalizeInboundUpdate(textUpdate(), { deliveryKey: DELIVERY_KEY, chatMetadata }),
        /group|chat.*metadata|contradict/iu,
      );
    }
  });

  it("does not expose context_token encrypted media parameters CDN URLs or the raw update", () => {
    const update = textUpdate({
      context_token: syntheticLabel("unit", "context", "token"),
      message_id: "synthetic-message-a",
      item_list: [{
        type: 2,
        image_item: {
          aes_key: "synthetic-aes-secret",
          encrypt_query_param: "synthetic-encrypted-parameter",
          url: "https://cdn.invalid/synthetic-private-path",
        },
      }],
    });
    const requestMedia = Object.freeze({
      type: "image",
      filePath: "/tmp/synthetic-safe-image.png",
      mimeType: "image/png",
      fileName: "synthetic-safe-image.png",
    });
    const request = normalizeInboundUpdate(update, {
      deliveryKey: DELIVERY_KEY,
      media: {
        sha256: "2a".repeat(32),
        fileName: "synthetic-safe-image.png",
        requestMedia,
      },
    });

    assert.deepEqual(request.media, requestMedia);
    assert.equal("rawUpdate" in request, false);
    const serialized = JSON.stringify(request);
    for (const secret of [
      "unit-context-token",
      "synthetic-aes-secret",
      "synthetic-encrypted-parameter",
      "cdn.invalid",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  it("copies the delivery key before asynchronous monitor handoff", async () => {
    await withSyntheticAccount("delivery-key-copy", async ({ accountId }) => {
      const deliveryKey = Buffer.alloc(32, 9);
      const expectedKey = Buffer.from(deliveryKey);
      const abortController = new AbortController();
      let request;
      let updatePolls = 0;
      let releaseFirstPoll;
      const firstPollGate = new Promise((resolve) => { releaseFirstPoll = resolve; });
      globalThis.fetch = async (url, init) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) {
            await firstPollGate;
            return new Response(JSON.stringify({
              ret: 0,
              get_updates_buf: "synthetic-key-copy-cursor",
              msgs: [textUpdate({ message_id: "synthetic-key-copy-message" })],
            }), { status: 200 });
          }
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) {
          return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        }
        if (endpoint.endsWith("/sendmessage")) {
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        }
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat(value) {
          request = value;
          return { text: "synthetic reply" };
        },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey,
        log() {},
      });
      deliveryKey.fill(3);
      releaseFirstPoll();
      await bot.wait();

      assert.equal(request.messageId, expectedDeliveryId([
        DELIVERY_DOMAIN,
        "synthetic-sender-a",
        "synthetic-key-copy-message",
      ], expectedKey));
    });
  });

  it("fails closed when downloadable inbound media cannot be processed", async () => {
    await withSyntheticAccount("media-failure", async ({ accountId }) => {
      const abortController = new AbortController();
      let chatCalls = 0;
      const logLines = [];
      let updatePolls = 0;
      globalThis.fetch = async (url, init) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-media-failure-cursor",
            msgs: [textUpdate({
              message_id: "synthetic-media-failure-message",
              item_list: [{
                type: 2,
                image_item: { media: { full_url: "https://cdn.invalid/unavailable-image" } },
              }],
            })],
          }), { status: 200 });
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) {
          return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        }
        if (url === "https://cdn.invalid/unavailable-image") {
          return new Response("unavailable", { status: 503 });
        }
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat() {
          chatCalls += 1;
          return { text: "must not be sent" };
        },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        log(message) { logLines.push(message); },
      });
      await bot.wait();
      assert.equal(chatCalls, 0);
      const logs = logLines.join("\n");
      for (const secret of [
        "https://cdn.invalid/unavailable-image",
        "synthetic-provider-token-secret",
        "synthetic-media-failure-message",
        "synthetic-raw-error-secret",
      ]) assert.equal(logs.includes(secret), false);
    });
  });

  it("keeps the previous polling cursor until a failed batch is retried successfully", async () => {
    await withSyntheticAccount("cursor-retry", async ({ accountId, stateDir }) => {
      const abortController = new AbortController();
      const oldCursor = "synthetic-old-cursor";
      const newCursor = "synthetic-new-cursor";
      const batch = [
        textUpdate({
          message_id: "synthetic-cursor-retry-message-a",
          context_token: syntheticLabel("synthetic", "cursor", "retry", "context"),
          item_list: [{ type: 1, text_item: { text: "synthetic first" } }],
        }),
        textUpdate({
          message_id: "synthetic-cursor-retry-message-b",
          context_token: syntheticLabel("synthetic", "cursor", "retry", "context"),
          item_list: [{ type: 1, text_item: { text: "synthetic second" } }],
        }),
      ];
      const syncFilePath = join(stateDir, "openclaw-weixin", "accounts", `${accountId}.sync.json`);
      await writeFile(syncFilePath, JSON.stringify({ get_updates_buf: oldCursor }));
      const requestedCursors = [];
      let updatePolls = 0;
      let chatCalls = 0;
      const logLines = [];
      const assertPersistedCursor = async (expected) => {
        try {
          assert.deepEqual(JSON.parse(await readFile(syncFilePath, "utf8")), { get_updates_buf: expected });
        } catch (error) {
          abortController.abort();
          throw error;
        }
      };
      globalThis.fetch = async (url, init) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          requestedCursors.push(JSON.parse(init.body).get_updates_buf);
          if (updatePolls === 2) {
            await assertPersistedCursor(oldCursor);
            return new Response(JSON.stringify({
              ret: 0,
              get_updates_buf: newCursor,
              msgs: batch,
            }), { status: 200 });
          }
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: newCursor,
            msgs: batch,
          }), { status: 200 });
          await assertPersistedCursor(newCursor);
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        if (endpoint.endsWith("/sendmessage")) return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat() {
          chatCalls += 1;
          if (chatCalls === 1) throw new Error("synthetic processing failure");
          return { text: `synthetic retry reply ${chatCalls}` };
        },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        log(message) { logLines.push(message); },
      });
      await bot.wait();

      assert.deepEqual(requestedCursors, [oldCursor, oldCursor, newCursor], logLines.join("\n"));
      assert.equal(chatCalls, 3);
      assert.deepEqual(JSON.parse(await readFile(syncFilePath, "utf8")), { get_updates_buf: newCursor });
    });
  });

  it("normalizes downloadable media only after decrypting, saving, and hashing it", async () => {
    await withSyntheticAccount("media-success", async ({ accountId }) => {
      const abortController = new AbortController();
      const plaintext = Buffer.from("synthetic decrypted image bytes", "utf8");
      const aesKey = Buffer.alloc(16, 4);
      const cipher = createCipheriv("aes-128-ecb", aesKey, null);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const expectedSha256 = createHash("sha256").update(plaintext).digest("hex");
      const mediaUrl = "https://cdn.invalid/synthetic-success-image";
      let updatePolls = 0;
      const requests = [];
      globalThis.fetch = async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-media-success-cursor",
            msgs: [textUpdate({
              item_list: [{
                type: 2,
                image_item: { media: { full_url: mediaUrl, aes_key: aesKey.toString("base64") } },
              }],
            })],
          }), { status: 200 });
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        if (url === mediaUrl) return new Response(encrypted, { status: 200 });
        throw new Error("synthetic-media-success-unexpected-endpoint");
      };

      const bot = start({
        async chat(request) {
          requests.push(request);
          return {};
        },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        log() {},
      });
      await bot.wait();

      assert.equal(requests.length, 1);
      assert.equal(requests[0].media.type, "image");
      assert.equal(requests[0].media.filePath.endsWith(".bin"), true);
      assert.equal(requests[0].messageId, expectedDeliveryId([
        DELIVERY_DOMAIN,
        "synthetic-sender-a",
        "1786500000123",
        JSON.stringify({
          itemTypes: [2],
          text: "",
          mediaSha256: expectedSha256,
          fileName: null,
        }),
      ]));
      assert.equal(requests[0].media.filePath.includes("synthetic decrypted"), false);
    });
  });

  it("classifies clear before side effects and clears the normalized conversation scope", async () => {
    await withSyntheticAccount("group-clear", async ({ accountId }) => {
      const abortController = new AbortController();
      const cleared = [];
      const classifierInputs = [];
      let updatePolls = 0;
      globalThis.fetch = async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-group-clear-cursor",
            msgs: [textUpdate({
              message_id: "synthetic-group-clear-message",
              item_list: [{ type: 1, text_item: { text: "/clear" } }],
            })],
          }), { status: 200 });
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) {
          return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        }
        if (endpoint.endsWith("/sendmessage")) {
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        }
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat() { throw new Error("clear must not call chat"); },
        clearSession(conversationId) { cleared.push(conversationId); },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        classifyChat(input) {
          classifierInputs.push(input);
          assert.equal(Object.isFrozen(input), true);
          assert.deepEqual(Object.keys(input), []);
          return { chatType: "group", groupId: "synthetic-group-clear" };
        },
        log() {},
      });
      await bot.wait();
      assert.deepEqual(cleared, ["synthetic-group-clear"]);
      assert.equal(classifierInputs.length, 1);
    });
  });

  it("keeps direct /clear behavior after normalization", async () => {
    await withSyntheticAccount("direct-clear", async ({ accountId }) => {
      const abortController = new AbortController();
      const cleared = [];
      let updatePolls = 0;
      let replies = 0;
      globalThis.fetch = async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-direct-clear-cursor",
            msgs: [textUpdate({
              message_id: "synthetic-direct-clear-message",
              context_token: syntheticLabel("synthetic", "direct", "clear", "context"),
              item_list: [{ type: 1, text_item: { text: "/clear" } }],
            })],
          }), { status: 200 });
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        if (endpoint.endsWith("/sendmessage")) {
          replies += 1;
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        }
        throw new Error("synthetic-direct-clear-unexpected-endpoint");
      };
      const bot = start({
        async chat() { throw new Error("direct clear must not call chat"); },
        clearSession(conversationId) { cleared.push(conversationId); },
      }, { accountId, abortSignal: abortController.signal, deliveryKey: DELIVERY_KEY, log() {} });
      await bot.wait();
      assert.deepEqual(cleared, ["synthetic-sender-a"]);
      assert.equal(replies, 1);
    });
  });

  it("does not clear or reply when /clear has invalid sender, time, items, or group metadata", async (t) => {
    const cases = [
      ["sender", textUpdate({ from_user_id: undefined })],
      ["timestamp", textUpdate({ create_time_ms: 0 })],
      ["items", textUpdate({ item_list: [] })],
      ["group metadata", textUpdate({ group_id: "synthetic-untrusted-group" })],
    ];
    for (const [name, update] of cases) {
      await t.test(name, async () => {
        await withSyntheticAccount(`invalid-clear-${name.replaceAll(" ", "-")}`, async ({ accountId }) => {
          const abortController = new AbortController();
          let clearCalls = 0;
          let replies = 0;
          let updatePolls = 0;
          globalThis.fetch = async (url) => {
            const endpoint = new URL(url).pathname;
            if (endpoint.endsWith("/getupdates")) {
              updatePolls += 1;
              if (updatePolls === 1) return new Response(JSON.stringify({
                ret: 0,
                get_updates_buf: `synthetic-invalid-clear-${name}-cursor`,
                msgs: [{ ...update, item_list: update.item_list?.length ? [{ type: 1, text_item: { text: "/clear" } }] : [] }],
              }), { status: 200 });
              abortController.abort();
              throw new DOMException("aborted", "AbortError");
            }
            if (endpoint.endsWith("/getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
            if (endpoint.endsWith("/sendmessage")) {
              replies += 1;
              return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
            }
            throw new Error("synthetic-invalid-clear-unexpected-endpoint");
          };
          const bot = start({
            async chat() { throw new Error("invalid clear must not call chat"); },
            clearSession() { clearCalls += 1; },
          }, { accountId, abortSignal: abortController.signal, deliveryKey: DELIVERY_KEY, log() {} });
          await bot.wait();
          assert.equal(clearCalls, 0);
          assert.equal(replies, 0);
        });
      });
    }
  });

  it("rejects invalid clear classification before any clear or reply side effect", async () => {
    await withSyntheticAccount("invalid-clear", async ({ accountId }) => {
      const abortController = new AbortController();
      let clearCalls = 0;
      let replies = 0;
      let updatePolls = 0;
      globalThis.fetch = async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith("/getupdates")) {
          updatePolls += 1;
          if (updatePolls === 1) return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "synthetic-invalid-clear-cursor",
            msgs: [textUpdate({
              message_id: "synthetic-invalid-clear-message",
              item_list: [{ type: 1, text_item: { text: "/clear" } }],
            })],
          }), { status: 200 });
          abortController.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) {
          return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
        }
        if (endpoint.endsWith("/sendmessage")) {
          replies += 1;
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
        }
        throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
      };

      const bot = start({
        async chat() { throw new Error("invalid clear must not call chat"); },
        clearSession() { clearCalls += 1; },
      }, {
        accountId,
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        classifyChat() {
          return { chatType: "group" };
        },
        log() {},
      });
      await bot.wait();
      assert.equal(clearCalls, 0);
      assert.equal(replies, 0);
    });
  });

  it("does not handle production /echo or /toggle-debug commands and does not log sender body token or response JSON", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "sentelligent-weixin-vendor-test-"));
    const accountDir = join(stateDir, "openclaw-weixin", "accounts");
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify(["synthetic-account"]));
    await writeFile(join(accountDir, "synthetic-account.json"), JSON.stringify({
      token: syntheticLabel("unit", "account", "token"),
      baseUrl: "https://synthetic-weixin.invalid",
      userId: "synthetic-bot-user",
    }));

    const requests = [];
    const logLines = [];
    const abortController = new AbortController();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousFetch = globalThis.fetch;
    const previousConsoleLog = console.log;
    const previousConsoleError = console.error;
    const internalLogOffsets = await snapshotInternalLogs();
    const consoleLines = [];
    let updatePolls = 0;
    globalThis.fetch = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith("/getupdates")) {
        updatePolls += 1;
        if (updatePolls === 1) return new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: "synthetic-next-cursor",
          msgs: [
            textUpdate({
              from_user_id: "synthetic-command-sender",
              context_token: syntheticLabel("unit", "command", "token"),
              message_id: "synthetic-command-message-1",
              item_list: [{ type: 1, text_item: { text: "/echo synthetic-command-body" } }],
            }),
            textUpdate({
              from_user_id: "synthetic-command-sender",
              context_token: syntheticLabel("unit", "command", "token"),
              message_id: "synthetic-command-message-2",
              item_list: [{ type: 1, text_item: { text: "/toggle-debug" } }],
            }),
          ],
        }), { status: 200 });
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (endpoint.endsWith("/getconfig")) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: "" }), { status: 200 });
      }
      if (endpoint.endsWith("/sendmessage")) {
        if (requests.length === 2) abortController.abort();
        return new Response(JSON.stringify({
          ret: 0,
          response_json: "synthetic-response-json-secret",
        }), { status: 200 });
      }
      throw new Error(`unexpected synthetic endpoint: ${endpoint}`);
    };
    process.env.OPENCLAW_STATE_DIR = stateDir;
    console.log = (...args) => { consoleLines.push(args.join(" ")); };
    console.error = (...args) => { consoleLines.push(args.join(" ")); };

    try {
      const bot = start({
        async chat(request) {
          requests.push(request);
          return { text: "synthetic-response-json-secret" };
        },
      }, {
        accountId: "synthetic-account",
        abortSignal: abortController.signal,
        deliveryKey: DELIVERY_KEY,
        log(message) { logLines.push(message); },
      });
      await bot.wait();

      assert.deepEqual(requests.map(({ text }) => text), [
        "/echo synthetic-command-body",
        "/toggle-debug",
      ]);
      assert.equal(requests.every((request) => request.senderId === "synthetic-command-sender"), true);
      const logs = [
        logLines.join("\n"),
        consoleLines.join("\n"),
        await readInternalLogDelta(internalLogOffsets),
      ].join("\n");
      for (const secret of [
        "synthetic-command-sender",
        "synthetic-command-body",
        "unit-command-token",
        "synthetic-response-json-secret",
        "unit-account-token",
        "synthetic-weixin.invalid",
        "synthetic-provider-url-secret.invalid",
        "synthetic-raw-error-secret",
        "/tmp/",
      ]) {
        assert.equal(logs.includes(secret), false);
      }

      await assert.rejects(readFile(
        join(stateDir, "openclaw-weixin", "debug-mode.json"),
        "utf8",
      ), { code: "ENOENT" });
    } finally {
      globalThis.fetch = previousFetch;
      console.log = previousConsoleLog;
      console.error = previousConsoleError;
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
