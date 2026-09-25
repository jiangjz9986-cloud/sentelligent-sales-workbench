// v0.9.3 scope 矩阵红线（测试先写）：`conversation_id ≡ deliveryScope ≡ hash(owner, senderId)`
// 不变式 + lease/worker 双保险 + 绑定生命周期 + multi:v1 就绪协议。投错人=越权泄露，
// 本矩阵全绿是 v0.9.3 的发布门禁。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import { createActionReminderScheduler } from "../src/actionReminders/reminderScheduler.js";
import { createDailyDigestScheduler } from "../src/dailyDigest/digestScheduler.js";
import { shanghaiDateParts } from "../src/dailyDigest/digestContent.js";
import { createInAppDeliveryAdapter } from "../src/notifications/inAppDelivery.js";
import { createOpsAlertService } from "../src/ops/opsAlertService.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";
import { createWeixinBindingsRepository } from "../src/weixin/bindingsRepository.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import { createWeixinOutboxHttpClient, runWeixinOutboxPump } from "../src/weixin/outboxWorker.js";
import { authorizeWeixinBoundDelivery } from "../src/weixin/worker.js";

const machineToken = "weixin-scope-test-machine-token";
const confirmationSecret = ["unit", "scope", "matrix", "secret", "0123456789abcdef"].join("-");
const adminHash = await hashPassword("unit-admin-password", { salt: Buffer.alloc(16, 55) });

const OWNER_A = "jiangjz";
const OWNER_B = "testb";
const SENDER_A = "sender-a";
const SENDER_B = "sender-b";
const MULTI_SCOPE = "weixin:multi:v1";

const convA = shortcutBookkeepingConversationId(OWNER_A, SENDER_A);
const convB = shortcutBookkeepingConversationId(OWNER_B, SENDER_B);

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let db;
let bindings;
let outbox;
let outboxSequence;
let fixedNow;
let pushplusCalls;

function clock() {
  return new Date(fixedNow);
}

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function workerHeaders(scope = MULTI_SCOPE) {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "matrix-worker",
    "X-Weixin-Delivery-Status": "ready",
    ...(scope ? { "X-Weixin-Delivery-Scope": scope } : {}),
  };
}

async function leaseOnce(scope = MULTI_SCOPE) {
  return read(await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    headers: workerHeaders(scope),
  }));
}

async function postEvent(senderId, text, id) {
  return read(await fetch(`${baseUrl}/api/integrations/weixin-agent/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `weixin:${id}`,
    },
    body: JSON.stringify({
      conversationId: `wx-${senderId}`,
      text,
      sourceMessageId: id,
      senderId,
      chatType: "direct",
    }),
  }));
}

function outboxRows() {
  return db.prepare("SELECT * FROM weixin_confirmation_outbox ORDER BY created_at, id").all();
}

function pendingCount() {
  return Number(db.prepare(
    "SELECT COUNT(*) AS count FROM weixin_confirmation_outbox WHERE status IN ('queued', 'processing')",
  ).get().count);
}

function makeBot({ deliverable = [SENDER_A, SENDER_B] } = {}) {
  const targets = new Set(deliverable);
  const calls = [];
  return {
    calls,
    getDeliveryStatus: () => ({ ready: true, status: "ready", deliveryScope: MULTI_SCOPE }),
    async sendMessage(message, outboxId, { targetSenderId } = {}) {
      if (typeof targetSenderId !== "string" || !targets.has(targetSenderId)) {
        const error = new Error("WeChat delivery target is not reachable");
        error.code = "WEIXIN_CONTEXT_NOT_READY";
        throw error;
      }
      calls.push({ target: targetSenderId, message, outboxId });
      return { messageId: `provider-${outboxId}` };
    },
  };
}

async function drainOutbox({ bot, mutateLease = null, timeoutMs = 8_000 } = {}) {
  const realClient = createWeixinOutboxHttpClient({
    backendUrl: baseUrl,
    apiToken: machineToken,
    workerId: "matrix-worker",
  });
  const client = mutateLease
    ? {
        lease: async (delivery) => {
          const lease = await realClient.lease(delivery);
          return lease ? mutateLease(lease) : lease;
        },
        ack: (input) => realClient.ack(input),
        isCurrent: (input) => realClient.isCurrent(input),
      }
    : realClient;
  const abort = new AbortController();
  const pump = runWeixinOutboxPump({
    client,
    bot,
    authorizeDelivery: authorizeWeixinBoundDelivery,
    pollMs: 500,
    // Production intentionally paces recovered backlog at 1 second per
    // message; this matrix tests routing, so disable the delay here.
    sendDelayMs: 0,
    abortSignal: abort.signal,
  });
  const startedAt = Date.now();
  while (pendingCount() > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  abort.abort();
  await pump;
  assert.equal(pendingCount(), 0, "outbox must drain to terminal states within the test budget");
}

function digestBuilderStub(kind) {
  return async ({ owner, now }) => {
    const date = shanghaiDateParts(now ?? clock()).date;
    if (kind === "daily") {
      return {
        empty: false,
        payload: {
          kind: "daily_digest",
          digestDate: date,
          headline: null,
          sections: [{ heading: "今日速览", lines: [`· matrix-daily-${owner}`] }],
          footer: "回复处理。",
        },
        stats: { itineraryCount: 1 },
      };
    }
    return {
      empty: false,
      payload: {
        kind: "friday_closeout",
        digestDate: date,
        weekStart: date,
        sections: [{ heading: "周报", lines: [`· matrix-friday-${owner}`] }],
        footer: "补传请在差旅页操作。",
      },
      stats: { reportCount: 0 },
    };
  };
}

function reminderStoreStub(itemsByOwner) {
  return {
    dueReminders: ({ owner }) => (itemsByOwner.get(owner) ?? []).filter((item) => !item.reminded),
    markReminded: ({ id }) => {
      for (const items of itemsByOwner.values()) {
        const found = items.find((item) => item.id === id);
        if (found) {
          found.reminded = true;
          return { marked: true };
        }
      }
      return { marked: false };
    },
  };
}

function tenderNotice(title, customerIds) {
  return {
    title,
    sourceName: "合成来源",
    publishedAt: "2026-08-29",
    url: "https://tenders.example.test/notice",
    match: { matchedCustomerIds: customerIds },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-weixin-scope-matrix-"));
  databaseUrl = join(tempDir, "scope-matrix.sqlite");
  outboxSequence = 0;
  pushplusCalls = [];
  fixedNow = "2026-08-28T09:00:00.000Z"; // 周五 17:00 Asia/Shanghai：晨报与周五收尾同 tick 补发
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    authAccount: OWNER_A,
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 56).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: OWNER_A,
    weixinBookkeepingConfirmationEnabled: true,
    hospitalTenderPushplusToken: ["fixture", "pushplus", "token"].join("-"),
    pushplusFetchImpl: async (url, options) => {
      pushplusCalls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ code: 200, data: `fixture-${pushplusCalls.length}` }) };
    },
    assistantConfirmationSecret: confirmationSecret,
    assistantClock: clock,
    weixinConfirmationOutboxClock: clock,
    opsAlertClock: clock,
    travelExpenseAnalyzer: async () => ({
      status: "ready",
      confidence: 0.98,
      expense: {
        occurredOn: "2026-08-26",
        amountCents: 1880,
        reimbursementCents: 1880,
        purpose: "matrix 交通",
        merchant: "matrix 商户",
        paidAt: "2026-08-26T12:00:00+08:00",
        fundingSource: "personal",
        paymentMethod: "wechat",
      },
      warnings: [],
      source: { provider: "test", model: null },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  db = createConnection({ databaseUrl });
  const nowIso = clock().toISOString();
  db.prepare(`
    INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($account, '同事乙', $hash, 'member', 'active', $now, $now)
  `).run({ $account: OWNER_B, $hash: adminHash, $now: nowIso });
  bindings = createWeixinBindingsRepository(db, { clock });
  bindings.bind({ senderId: SENDER_A, account: OWNER_A, boundBy: "unit-fixture", financialEnabled: true });
  bindings.bind({ senderId: SENDER_B, account: OWNER_B, boundBy: "unit-fixture", financialEnabled: false });
  outbox = createWeixinConfirmationOutboxRepository(db, {
    clock,
    idFactory: () => `matrix-outbox-${++outboxSequence}`,
  });
});

async function createBookkeepingOutboxRow({
  senderId = SENDER_A,
  owner = senderId === SENDER_B ? OWNER_B : OWNER_A,
  messageId = "scope-matrix-bookkeeping",
} = {}) {
  const existingIds = new Set(outboxRows().map((candidate) => candidate.id));
  const result = await postEvent(senderId, `支出 2026-08-26 打车 18.80元 ${messageId}`, messageId);
  assert.equal(result.response.status, 200);
  const row = outboxRows().find((candidate) => candidate.owner === owner
    && candidate.status === "queued"
    && !existingIds.has(candidate.id));
  assert.ok(row, "bookkeeping should create a queued WeChat confirmation");
  return row;
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  db?.close();
  db = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("weixin outbox scope matrix", () => {
  it("keeps Clawbot bookkeeping-only and stores every other notice in its dedicated channel", async () => {
    // 1) 记账确认卡（A，financial=1，经真实事件入口）。
    const card = await postEvent(SENDER_A, "支出 2026-08-26 打车 18.80元 matrix 交通", "matrix-card-a");
    assert.equal(card.response.status, 200);

    // financial=0 的 B 发记账文本：财务闸拒绝、零出站。
    const refused = await postEvent(SENDER_B, "支出 2026-08-26 打车 18.80元 matrix 交通", "matrix-card-b");
    assert.match(refused.body.text, /财务|绑定/u, "financial gate must refuse instead of previewing");
    assert.doesNotMatch(refused.body.text, /待确认记账/u);
    assert.equal(
      outboxRows().filter((row) => row.owner === OWNER_B).length,
      0,
      "a financial-disabled binding must not enqueue bookkeeping confirmations",
    );

    const inAppDelivery = createInAppDeliveryAdapter({
      repository: server.inAppNotificationRepository,
      renderMessage: (payload) => `${payload.kind}:${payload.summary ?? payload.title ?? payload.digestDate ?? ""}`,
    });
    const activeUsers = () => [OWNER_A, OWNER_B].map((account) => ({ account, owner: account, conversationId: "in-app" }));

    // 2) 晨报 + 周五收尾多播（双 owner 各自进入站内通知）。
    const digestScheduler = createDailyDigestScheduler({
      db,
      outboxRepository: inAppDelivery,
      buildDailyDigest: digestBuilderStub("daily"),
      buildFridayCloseout: digestBuilderStub("friday"),
      resolveDeliveries: activeUsers,
      deliveryReady: () => true,
      clock,
      pollMs: 60_000,
      dailyTime: { hour: 9, minute: 0 },
      fridayTime: { hour: 16, minute: 30 },
    });
    await digestScheduler.runOnce();

    // 3) 待办提醒进入站内通知中心，不受微信 digest 开关影响。
    const reminderScheduler = createActionReminderScheduler({
      db,
      store: reminderStoreStub(new Map([
        [OWNER_A, [{ id: "act-a-1", title: "matrix-reminder-A", remindAt: "2026-08-27T00:00:00.000Z", priority: "高", customerName: null, reason: null }]],
        [OWNER_B, [{ id: "act-b-1", title: "matrix-reminder-B", remindAt: "2026-08-27T00:00:00.000Z", priority: "中", customerName: null, reason: null }]],
      ])),
      outboxRepository: inAppDelivery,
      resolveDeliveries: activeUsers,
      deliveryReady: () => true,
      clock,
      pollMs: 60_000,
    });
    await reminderScheduler.runOnce();

    // 4) 招标通过 PushPlus；transport 是 stub，不访问真实 provider。
    const notified = await server.hospitalTenderPushplusNotifier.notify({
      cycleNumber: 3,
      batchCustomerIds: ["cust-a", "cust-b"],
      notices: [
        tenderNotice("matrix-tender-A 公告", ["cust-a"]),
        tenderNotice("matrix-tender-B 公告", ["cust-b"]),
      ],
    });
    assert.equal(notified, 2);
    assert.equal(pushplusCalls.length, 1);

    // 5) 运维告警进入管理员的站内通知。
    const opsAlerts = createOpsAlertService({
      outboxRepository: inAppDelivery,
      deliveryMode: "in_app",
      resolveDeliveries: () => [{ account: OWNER_A, owner: OWNER_A, conversationId: "in-app" }],
      clock,
    });
    await opsAlerts.receive(
      { source: "backend", severity: "critical", summary: "matrix-alert 摘要" },
      { actor: "ops-monitor" },
    );

    const rows = outboxRows();
    assert.equal(rows.length, 1, "only a bookkeeping confirmation may enter the WeChat outbox");
    assert.equal(rows[0].owner, OWNER_A);
    assert.equal(rows[0].conversation_id, convA);
    assert.notEqual(JSON.parse(rows[0].payload_json).kind, "ops_alert");
    assert.equal(server.inAppNotificationRepository.count({ owner: OWNER_A }), 4);
    assert.equal(server.inAppNotificationRepository.count({ owner: OWNER_B }), 3);
    assert.equal(server.hospitalTenderPushplusDeliveryRepository.statusCounts().accepted, 1);

    const bot = makeBot();
    await drainOutbox({ bot });

    const sentByTarget = new Map([[SENDER_A, []], [SENDER_B, []]]);
    for (const call of bot.calls) sentByTarget.get(call.target)?.push(call.message);
    assert.equal(sentByTarget.get(SENDER_A).length, 1);
    assert.equal(sentByTarget.get(SENDER_B).length, 0);
    const joinedA = sentByTarget.get(SENDER_A).join("\n---\n");
    const joinedB = sentByTarget.get(SENDER_B).join("\n---\n");
    assert.doesNotMatch(joinedA, /matrix-daily|matrix-reminder|matrix-tender|matrix-alert/u);
    assert.equal(joinedB, "");

    // 逐行核销：每一次实际投递的目标 sender 必须与该行 owner 的绑定一致。
    const expectedTarget = new Map([[OWNER_A, SENDER_A], [OWNER_B, SENDER_B]]);
    for (const call of bot.calls) {
      const row = db.prepare("SELECT owner, status FROM weixin_confirmation_outbox WHERE id = $id").get({ $id: call.outboxId });
      assert.equal(call.target, expectedTarget.get(row.owner), `outbox ${call.outboxId} delivered to the wrong sender`);
      assert.equal(row.status, "sent");
    }
  });

  it("fails closed on forged, mismatched, and ghost-owner rows at the lease gate", async () => {
    // owner=A 但会话被指向 B：lease 闸判废。
    const original = await createBookkeepingOutboxRow({ messageId: "matrix-forged-cross" });
    const originalLease = await leaseOnce();
    assert.equal(originalLease.response.status, 200);
    await read(await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: originalLease.body.item.id, leaseToken: originalLease.body.leaseToken, ok: true }),
    }));
    const forgedRow = outbox.enqueue({
      owner: OWNER_A,
      conversationId: convB,
      idempotencyKey: "matrix-forged-cross-conversation",
      payload: JSON.parse(original.payload_json),
      availableAt: new Date(Date.parse(fixedNow) - 1_000),
    });
    const forged = await leaseOnce();
    assert.equal(forged.response.status, 204);
    let row = outboxRows().find((item) => item.id === forgedRow.id);
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");

    // 无绑定 ghost owner：判废。
    const ghostRow = outbox.enqueue({
      owner: "ghostacct",
      conversationId: shortcutBookkeepingConversationId("ghostacct", "sender-ghost"),
      idempotencyKey: "matrix-ghost-owner",
      payload: JSON.parse(original.payload_json),
    });
    const ghost = await leaseOnce();
    assert.equal(ghost.response.status, 204, JSON.stringify(ghost.body));
    row = outboxRows().find((item) => item.id === ghostRow.id);
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");

    // 合法行：lease 响应携带 targetSenderId 且 deliveryScope ≡ conversationId。
    const legitimate = outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-legit-a",
      payload: JSON.parse(original.payload_json),
    });
    const legit = await leaseOnce();
    assert.equal(legit.response.status, 200);
    assert.equal(legit.body.item.id, legitimate.id);
    assert.equal(legit.body.item.targetSenderId, SENDER_A);
    assert.equal(legit.body.item.deliveryScope, legit.body.item.conversationId);
    assert.equal(legit.body.item.conversationId, convA);
  });

  it("re-verifies the hash on the worker and terminally rejects tampered lease targets", async () => {
    const tampered = await createBookkeepingOutboxRow({ messageId: "matrix-tampered" });
    const bot = makeBot();
    await drainOutbox({
      bot,
      mutateLease: (lease) => ({
        ...lease,
        item: { ...lease.item, targetSenderId: SENDER_B },
      }),
    });
    assert.equal(bot.calls.length, 0, "a tampered target must never reach the SDK send path");
    const row = outboxRows().find((item) => item.id === tampered.id);
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");

    // 纯函数矩阵：重算哈希三者一致才放行。
    assert.equal(authorizeWeixinBoundDelivery({
      owner: OWNER_A, targetSenderId: SENDER_A, conversationId: convA, deliveryScope: convA,
    }), true);
    assert.equal(authorizeWeixinBoundDelivery({
      owner: OWNER_A, targetSenderId: SENDER_B, conversationId: convA, deliveryScope: convA,
    }), false);
    assert.equal(authorizeWeixinBoundDelivery({
      owner: OWNER_A, targetSenderId: SENDER_A, conversationId: convA, deliveryScope: convB,
    }), false);
    assert.equal(authorizeWeixinBoundDelivery({
      owner: OWNER_A, conversationId: convA, deliveryScope: convA,
    }), false);
  });

  it("acks an unreachable delivery target as retryable context-not-ready instead of terminal", async () => {
    const unreachable = await createBookkeepingOutboxRow({ messageId: "matrix-unreachable" });
    const bot = makeBot({ deliverable: [SENDER_B] });
    const client = createWeixinOutboxHttpClient({ backendUrl: baseUrl, apiToken: machineToken, workerId: "matrix-worker" });
    const abort = new AbortController();
    const pump = runWeixinOutboxPump({
      client,
      bot,
      authorizeDelivery: authorizeWeixinBoundDelivery,
      pollMs: 500,
      abortSignal: abort.signal,
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const row = outboxRows().find((item) => item.id === unreachable.id);
      if (row && row.attempt_count >= 1 && row.status === "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    abort.abort();
    await pump;
    const row = outboxRows().find((item) => item.id === unreachable.id);
    assert.equal(row.status, "queued", "context-not-ready must stay retryable");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error_code, "WEIXIN_CONTEXT_NOT_READY");
  });

  it("discards in-flight rows after unbind and rebind while newly bound senders receive fresh rows", async () => {
    db.prepare("UPDATE weixin_bindings SET financial_enabled=1 WHERE sender_id=$sender").run({ $sender: SENDER_B });
    const lifecycleA = await createBookkeepingOutboxRow({ messageId: "matrix-lifecycle-a" });
    const lifecycleB = await createBookkeepingOutboxRow({ senderId: SENDER_B, messageId: "matrix-lifecycle-b" });

    // 解绑 B：其在途行判废、A 不受影响。
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    // 一账号至多一条 active：B 未解绑前重复绑定新 sender 必须 409（此处已解绑，先验证换绑成功后再验证冲突）。
    const bot = makeBot({ deliverable: [SENDER_A, "sender-b2"] });
    await drainOutbox({ bot });
    const rowA = outboxRows().find((item) => item.id === lifecycleA.id);
    const rowB = outboxRows().find((item) => item.id === lifecycleB.id);
    assert.equal(rowA.status, "sent", JSON.stringify({ status: rowA.status, code: rowA.last_error_code, payload: JSON.parse(rowA.payload_json) }));
    assert.equal(bot.calls.filter((call) => call.target === SENDER_A).length, 1);
    assert.equal(rowB.status, "failed");
    assert.equal(rowB.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");
    assert.equal(bot.calls.filter((call) => call.target === SENDER_B).length, 0);

    // 换绑 senderB2：旧会话行判废、新行到达新 sender。
    bindings.bind({ senderId: "sender-b2", account: OWNER_B, boundBy: "unit-fixture", financialEnabled: true });
    assert.throws(
      () => bindings.bind({ senderId: "sender-b3", account: OWNER_B, boundBy: "unit-fixture" }),
      (error) => error?.code === "ACCOUNT_ALREADY_BOUND",
      "one active binding per account is enforced",
    );
    const stale = outbox.enqueue({
      owner: OWNER_B,
      conversationId: convB,
      idempotencyKey: "matrix-lifecycle-stale",
      payload: JSON.parse(lifecycleB.payload_json),
    });
    const fresh = outbox.enqueue({
      owner: OWNER_B,
      conversationId: shortcutBookkeepingConversationId(OWNER_B, "sender-b2"),
      idempotencyKey: "matrix-lifecycle-fresh",
      payload: JSON.parse(lifecycleB.payload_json),
    });
    const rebindBot = makeBot({ deliverable: [SENDER_A, "sender-b2"] });
    await drainOutbox({ bot: rebindBot });
    const staleRow = outboxRows().find((item) => item.id === stale.id);
    const freshRow = outboxRows().find((item) => item.id === fresh.id);
    assert.equal(staleRow.status, "failed", "pre-rebind rows must never chase the new sender");
    assert.equal(freshRow.status, "sent", JSON.stringify({ code: freshRow.last_error_code, payload: JSON.parse(freshRow.payload_json), conversation: freshRow.conversation_id }));
    assert.deepEqual(rebindBot.calls.map((call) => call.target), ["sender-b2"]);
  });

  it("routes every tender notice through PushPlus independently of WeChat bindings", async () => {
    const count = await server.hospitalTenderPushplusNotifier.notify({
      cycleNumber: 7,
      batchCustomerIds: ["cust-x"],
      notices: [tenderNotice("matrix-unrouted 公告", ["cust-x"])],
    });
    assert.equal(count, 1);
    assert.equal(pushplusCalls.length, 1);
    assert.equal(server.hospitalTenderPushplusDeliveryRepository.statusCounts().accepted, 1);
    assert.equal(outboxRows().length, 0);

    // 停用全部微信绑定不影响医院招标的 PushPlus 投递。
    bindings.disable(SENDER_A, { by: "unit-fixture" });
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    const secondCount = await server.hospitalTenderPushplusNotifier.notify({
      cycleNumber: 8,
      batchCustomerIds: ["cust-x"],
      notices: [tenderNotice("matrix-orphan 公告", ["cust-x"])],
    });
    assert.equal(secondCount, 1);
    assert.equal(pushplusCalls.length, 2);
    assert.equal(server.hospitalTenderPushplusDeliveryRepository.statusCounts().accepted, 2);
    assert.equal(outboxRows().length, 0);
  });

  it("upgrades the readiness protocol to the multi sentinel and fails closed for stale workers", async () => {
    const protocol = await createBookkeepingOutboxRow({ messageId: "matrix-protocol" });

    // 旧 worker 报旧 scope：不放租约、行保持 queued。
    const legacy = await leaseOnce(convA);
    assert.equal(legacy.response.status, 204);
    assert.equal(pendingCount(), 1);

    // 缺 scope：同样不放。
    const missing = await leaseOnce(null);
    assert.equal(missing.response.status, 204);
    assert.equal(pendingCount(), 1);

    // multi:v1 哨兵：放租约。
    const granted = await leaseOnce(MULTI_SCOPE);
    assert.equal(granted.response.status, 200);
    assert.equal(granted.body.item.id, protocol.id);
    assert.equal(granted.body.item.targetSenderId, SENDER_A);

    // hasActive()=false → configuration_incomplete，不再发租约也不判废行。
    await read(await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: granted.body.item.id, leaseToken: granted.body.leaseToken, ok: true }),
    }));
    const protocol2 = outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-protocol-2",
      payload: JSON.parse(protocol.payload_json),
    });
    bindings.disable(SENDER_A, { by: "unit-fixture" });
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    const unconfigured = await leaseOnce(MULTI_SCOPE);
    assert.equal(unconfigured.response.status, 204);
    const untouched = outboxRows().find((item) => item.id === protocol2.id);
    assert.equal(untouched.status, "queued", "configuration_incomplete must not burn rows");
  });
});
