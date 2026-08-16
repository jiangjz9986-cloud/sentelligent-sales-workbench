import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { runWeixinWorker } from "../src/weixin/worker.js";
import { normalizeInboundUpdate } from "../vendor/weixin-agent-sdk/dist/index.mjs";

function syntheticLabel(...parts) {
  return parts.join("-");
}

const senderA = "closure-sender-a";
const senderB = "closure-sender-b";
// Deliberately equal to the direct sender: without Task 5's chat/group scope
// projection, these two vendor-normalized conversations collide.
const groupId = senderA;
const machineToken = syntheticLabel("closure", "machine", "token", "not", "a", "real", "secret");
const confirmationSecret = syntheticLabel("closure", "confirmation", "secret", "is", "independent", "and", "at", "least", "thirty", "two", "bytes");
const sessionSecret = Buffer.alloc(32, 71).toString("base64url");
const deliveryDomain = "sentelligent/weixin-delivery-key/v1";

let tempDir;
let server;

function serverOptions(databaseUrl, seed) {
  return {
    databaseUrl,
    seed,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: false,
    authSessionSecret: sessionSecret,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "closure-owner",
    weixinAllowedSenderIds: `${senderA},${senderB}`,
    weixinAllowGroups: true,
    weixinAllowedGroupIds: groupId,
    assistantConfirmationSecret: confirmationSecret,
  };
}

async function listen(nextServer) {
  await new Promise((resolve) => nextServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${nextServer.address().port}`;
}

async function close(nextServer) {
  if (!nextServer?.listening) return;
  await new Promise((resolve, reject) => nextServer.close((error) => error ? reject(error) : resolve()));
}

function codeFrom(text) {
  const matches = String(text).match(/(?<!\d)\d{6}(?!\d)/gu) ?? [];
  assert.equal(matches.length, 1, `confirmation reply must contain exactly one six-digit code: ${text}`);
  return matches[0];
}

function differentCode(code) {
  return code === "000000" ? "111111" : "000000";
}

function inboundUpdate({ senderId, text, timestampMs, upstreamId }) {
  return {
    from_user_id: senderId,
    create_time_ms: timestampMs,
    message_id: upstreamId,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function createSend(agent, deliveryKey, deliveryState) {
  return async ({ senderId = senderA, text, chatType = "direct", group = undefined, replay = undefined }) => {
    const next = replay ?? normalizeInboundUpdate(inboundUpdate({
      senderId,
      text,
      timestampMs: ++deliveryState.timestampMs,
      upstreamId: `closure-delivery-${++deliveryState.sequence}`,
    }), {
      deliveryKey,
      ...(chatType === "group" ? { chatMetadata: { chatType, groupId: group } } : {}),
    });
    try {
      const reply = await agent.chat(next);
      return { request: next, reply };
    } catch (error) {
      Object.defineProperty(error, "testRequest", { value: next });
      throw error;
    }
  };
}

async function expectSafeRemoteFailure(operation) {
  try {
    await operation;
  } catch (error) {
    assert.equal(error?.code, "REMOTE_AGENT_REQUEST_FAILED");
    assert.equal(error?.message, "远程助手暂时不可用，请稍后重试");
    return error.testRequest;
  }
  assert.fail("the real remote adapter must reject a non-2xx confirmation response");
}

function count(db, sql, params = {}) {
  return db.prepare(sql).get(params).count;
}

function pendingRow(databaseUrl, actionId) {
  const db = openDatabase({ databaseUrl });
  try {
    return db.prepare("SELECT * FROM assistant_pending_actions WHERE id = $id").get({ $id: actionId });
  } finally {
    db.close();
  }
}

function assertNoSensitiveLogContent(logs, sensitiveValues) {
  for (const sensitive of sensitiveValues) {
    assert.equal(logs.includes(sensitive), false, "captured process logs must omit synthetic private input");
  }
}

afterEach(async () => {
  await close(server);
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("vendored WeChat worker to HTTP SQLite confirmation closure", () => {
  it("keeps confirmation text, scope, replay, restart, retry, cancel, resend, and privacy closed over the real process seams", async (t) => {
    tempDir = await mkdtemp(join(tmpdir(), "sentelligent-weixin-closure-"));
    const databaseUrl = join(tempDir, "closure.sqlite");
    server = createServer(serverOptions(databaseUrl, true));
    const baseUrl = await listen(server);

    const starts = [];
    let processLogs = "";
    const originalWrite = process.stdout.write;
    const originalErrorWrite = process.stderr.write;
    process.stdout.write = (chunk, ...args) => {
      processLogs += String(chunk);
      return originalWrite.call(process.stdout, chunk, ...args);
    };
    process.stderr.write = (chunk, ...args) => {
      processLogs += String(chunk);
      return originalErrorWrite.call(process.stderr, chunk, ...args);
    };
    t.after(() => {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrorWrite;
    });
    await runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          starts.push({ agent, options });
          return { wait: async () => {} };
        },
      },
      fetchImpl: fetch,
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: sessionSecret,
        weixinAgentApiToken: machineToken,
        weixinAgentBackendUrl: baseUrl,
      },
    });

    assert.equal(starts.length, 1);
    const expectedDeliveryKey = createHmac("sha256", Buffer.from(machineToken, "utf8"))
      .update(deliveryDomain, "utf8")
      .digest();
    assert.deepEqual(starts[0].options.deliveryKey, expectedDeliveryKey);
    const deliveryState = { timestampMs: 1_786_500_000_000, sequence: 0 };
    const send = createSend(starts[0].agent, starts[0].options.deliveryKey, deliveryState);

    const collected = await send({ text: "拜访闭包测试医院，已和采购负责人确认下周方案沟通。" });
    assert.match(collected.reply.text, /已暂存/);
    const preview = await send({ text: "记录" });
    assert.match(preview.reply.text, /待确认记录/);
    const pending = await send({ text: "录入" });
    assert.equal(pending.reply.status, "confirmation_required");
    assert.equal(Object.hasOwn(pending.reply, "confirmationCode"), false);
    const firstCode = codeFrom(pending.reply.text);

    // A genuine process restart must keep the file-backed action while the worker gets a new remote agent.
    await close(server);
    server = createServer(serverOptions(databaseUrl, false));
    const restartedUrl = await listen(server);
    let restartedAgent;
    await runWeixinWorker(["start"], {
      sdk: {
        start(agent, options) {
          restartedAgent = agent;
          assert.deepEqual(options.deliveryKey, expectedDeliveryKey);
          return { wait: async () => {} };
        },
      },
      fetchImpl: fetch,
      configOverrides: {
        nodeEnv: "test",
        authRequired: false,
        authSessionSecret: sessionSecret,
        weixinAgentApiToken: machineToken,
        weixinAgentBackendUrl: restartedUrl,
      },
    });
    const sendAfterRestart = createSend(restartedAgent, expectedDeliveryKey, deliveryState);
    const confirmed = await sendAfterRestart({ text: firstCode });
    assert.equal(confirmed.reply.status, "ok");
    assert.match(confirmed.reply.text, /已录入系统/);

    let db = openDatabase({ databaseUrl });
    try {
      assert.equal(count(db, "SELECT COUNT(*) AS count FROM quick_records WHERE owner = 'closure-owner'"), 1);
      assert.equal(count(db, "SELECT COUNT(*) AS count FROM assistant_tool_runs WHERE owner = 'closure-owner' AND tool_name = 'visit-capture.confirm' AND status = 'completed'"), 1);
    } finally {
      db.close();
    }

    const replay = await sendAfterRestart({ text: firstCode, replay: confirmed.request });
    assert.deepEqual(replay.reply, confirmed.reply);
    db = openDatabase({ databaseUrl });
    try {
      assert.equal(count(db, "SELECT COUNT(*) AS count FROM quick_records WHERE owner = 'closure-owner'"), 1);
      assert.equal(count(db, "SELECT COUNT(*) AS count FROM assistant_tool_runs WHERE owner = 'closure-owner' AND tool_name = 'visit-capture.confirm'"), 1);
    } finally {
      db.close();
    }

    const retryCollect = await sendAfterRestart({ text: "拜访错误确认计数医院。" });
    assert.match(retryCollect.reply.text, /已暂存/);
    const retryPending = await sendAfterRestart({ text: "录入" });
    const retryCode = codeFrom(retryPending.reply.text);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrongRequest = await expectSafeRemoteFailure(
        sendAfterRestart({ text: differentCode(retryCode) }),
      );
      if (attempt === 1) {
        await expectSafeRemoteFailure(
          sendAfterRestart({ text: differentCode(retryCode), replay: wrongRequest }),
        );
      }
    }
    assert.equal(pendingRow(databaseUrl, retryPending.reply.actionId).confirmation_attempts, 4);
    await expectSafeRemoteFailure(sendAfterRestart({ text: differentCode(retryCode) }));
    const lockedRow = pendingRow(databaseUrl, retryPending.reply.actionId);
    assert.equal(lockedRow.confirmation_attempts, 5);
    assert.equal(lockedRow.status, "failed");
    assert.equal(lockedRow.error_code, "ASSISTANT_CONFIRMATION_LOCKED");

    const cancelCollect = await sendAfterRestart({ senderId: senderB, text: "拜访取消确认医院。" });
    assert.match(cancelCollect.reply.text, /已暂存/);
    await sendAfterRestart({ senderId: senderB, text: "记录" });
    const cancellable = await sendAfterRestart({ senderId: senderB, text: "录入" });
    const cancelled = await sendAfterRestart({ senderId: senderB, text: "取消" });
    assert.equal(cancelled.reply.status, "cancel");
    assert.equal(pendingRow(databaseUrl, cancellable.reply.actionId).status, "cancelled");

    const scopedCollect = await sendAfterRestart({ text: "拜访范围隔离医院。" });
    assert.match(scopedCollect.reply.text, /已暂存/);
    await sendAfterRestart({ text: "记录" });
    const scopedPending = await sendAfterRestart({ text: "录入" });
    const scopedCode = codeFrom(scopedPending.reply.text);
    const groupDraft = await sendAfterRestart({ text: "记录", chatType: "group", group: groupId });
    assert.match(groupDraft.reply.text, /当前没有暂存内容/);
    await expectSafeRemoteFailure(sendAfterRestart({ senderId: senderB, text: scopedCode }));
    await expectSafeRemoteFailure(
      sendAfterRestart({ text: scopedCode, chatType: "group", group: groupId }),
    );
    assert.equal(pendingRow(databaseUrl, scopedPending.reply.actionId).status, "pending");

    const renewal = await sendAfterRestart({ text: "重发确认码" });
    assert.equal(renewal.reply.status, "confirmation_required");
    assert.equal(Object.hasOwn(renewal.reply, "confirmationCode"), false);
    const renewedCode = codeFrom(renewal.reply.text);
    assert.notEqual(renewedCode, scopedCode);
    await expectSafeRemoteFailure(sendAfterRestart({ text: scopedCode }));
    const renewed = await sendAfterRestart({ text: renewedCode });
    assert.equal(renewed.reply.status, "ok");
    assert.match(renewed.reply.text, /已录入系统/);

    db = openDatabase({ databaseUrl });
    try {
      assert.deepEqual(
        db.prepare("PRAGMA quick_check").all().map((row) => row.quick_check),
        ["ok"],
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      const persisted = db.prepare("SELECT response_json, payload_json FROM assistant_inbound_events").all();
      assert.equal(JSON.stringify(persisted).includes(firstCode), false);
      assert.equal(JSON.stringify(persisted).includes(renewedCode), false);
    } finally {
      db.close();
    }
    assertNoSensitiveLogContent(processLogs, [
      firstCode,
      retryCode,
      scopedCode,
      renewedCode,
      senderA,
      senderB,
      machineToken,
      confirmationSecret,
      "拜访闭包测试医院",
      "拜访错误确认计数医院",
      "拜访取消确认医院",
      "拜访范围隔离医院",
    ]);
  });
});
