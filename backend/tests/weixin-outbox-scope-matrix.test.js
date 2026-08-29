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
import { createHospitalTenderWeixinNotifier } from "../src/hospitalTender/weixinNotifier.js";
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

function makeTenderNotifier(overrides = {}) {
  return createHospitalTenderWeixinNotifier({
    outboxRepository: outbox,
    resolveDigestDeliveries: () => bindings.listDigestTargets(),
    resolveAdminDeliveries: () => bindings.listAdminTargets()
      .filter((target) => bindings.activeByAccount(target.account)?.digestEnabled === true),
    resolveCustomerOwners: (customerIds) => {
      const map = new Map();
      for (const id of customerIds) {
        if (id === "cust-a") map.set(id, OWNER_A);
        if (id === "cust-b") map.set(id, OWNER_B);
      }
      return map;
    },
    ...overrides,
  });
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
    assistantConfirmationSecret: confirmationSecret,
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

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  db?.close();
  db = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("weixin outbox scope matrix", () => {
  it("delivers all five producers strictly to each owner's bound sender with zero crossover", async () => {
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

    // 2) 晨报 + 周五收尾多播（双 owner 各自内容）。
    const digestScheduler = createDailyDigestScheduler({
      db,
      outboxRepository: outbox,
      buildDailyDigest: digestBuilderStub("daily"),
      buildFridayCloseout: digestBuilderStub("friday"),
      resolveDeliveries: () => bindings.listDigestTargets(),
      deliveryReady: () => true,
      clock,
      pollMs: 60_000,
      dailyTime: { hour: 9, minute: 0 },
      fridayTime: { hour: 16, minute: 30 },
    });
    await digestScheduler.runOnce();

    // 3) 待办提醒多播。
    const reminderScheduler = createActionReminderScheduler({
      db,
      store: reminderStoreStub(new Map([
        [OWNER_A, [{ id: "act-a-1", title: "matrix-reminder-A", remindAt: "2026-08-27T00:00:00.000Z", priority: "高", customerName: null, reason: null }]],
        [OWNER_B, [{ id: "act-b-1", title: "matrix-reminder-B", remindAt: "2026-08-27T00:00:00.000Z", priority: "中", customerName: null, reason: null }]],
      ])),
      outboxRepository: outbox,
      resolveDeliveries: () => bindings.listDigestTargets(),
      deliveryReady: () => true,
      clock,
      pollMs: 60_000,
    });
    await reminderScheduler.runOnce();

    // 4) 招标按客户 owner 分组推送。
    const notifier = makeTenderNotifier();
    const notified = await notifier({
      cycleNumber: 3,
      batchCustomerIds: ["cust-a", "cust-b"],
      notices: [
        tenderNotice("matrix-tender-A 公告", ["cust-a"]),
        tenderNotice("matrix-tender-B 公告", ["cust-b"]),
      ],
    });
    assert.equal(notified, 2);

    // 5) 运维告警：只投 active admin 绑定（A），member 绑定 B 不收。
    const opsAlerts = createOpsAlertService({
      outboxRepository: outbox,
      resolveDeliveries: () => bindings.listAdminTargets(),
      weixinDeliveryReady: () => true,
      clock,
    });
    await opsAlerts.receive(
      { source: "backend", severity: "critical", summary: "matrix-alert 摘要" },
      { actor: "ops-monitor" },
    );

    const rows = outboxRows();
    const rowsA = rows.filter((row) => row.owner === OWNER_A);
    const rowsB = rows.filter((row) => row.owner === OWNER_B);
    assert.equal(rowsA.length, 6, "A: card + daily + friday + reminder + tender + alert");
    assert.equal(rowsB.length, 4, "B: daily + friday + reminder + tender");
    assert.ok(rowsA.every((row) => row.conversation_id === convA), "invariant: A rows carry hash(A, senderA)");
    assert.ok(rowsB.every((row) => row.conversation_id === convB), "invariant: B rows carry hash(B, senderB)");

    const bot = makeBot();
    await drainOutbox({ bot });

    const sentByTarget = new Map([[SENDER_A, []], [SENDER_B, []]]);
    for (const call of bot.calls) sentByTarget.get(call.target)?.push(call.message);
    assert.equal(sentByTarget.get(SENDER_A).length, 6);
    assert.equal(sentByTarget.get(SENDER_B).length, 4);
    const joinedA = sentByTarget.get(SENDER_A).join("\n---\n");
    const joinedB = sentByTarget.get(SENDER_B).join("\n---\n");
    assert.match(joinedA, /matrix-daily-jiangjz/);
    assert.match(joinedA, /matrix-reminder-A/);
    assert.match(joinedA, /matrix-tender-A 公告/);
    assert.match(joinedA, /matrix-alert 摘要/);
    assert.doesNotMatch(joinedA, /matrix-daily-testb|matrix-reminder-B|matrix-tender-B/);
    assert.match(joinedB, /matrix-daily-testb/);
    assert.match(joinedB, /matrix-reminder-B/);
    assert.match(joinedB, /matrix-tender-B 公告/);
    assert.doesNotMatch(joinedB, /matrix-daily-jiangjz|matrix-reminder-A|matrix-tender-A|matrix-alert/);

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
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convB,
      idempotencyKey: "matrix-forged-cross",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "forged", occurredAt: fixedNow },
    });
    const forged = await leaseOnce();
    assert.equal(forged.response.status, 204);
    let row = outboxRows().find((item) => item.idempotency_key_hash && JSON.parse(item.payload_json).summary === "forged");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");

    // 无绑定 ghost owner：判废。
    outbox.enqueue({
      owner: "ghostacct",
      conversationId: shortcutBookkeepingConversationId("ghostacct", "sender-ghost"),
      idempotencyKey: "matrix-ghost-owner",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "ghost", occurredAt: fixedNow },
    });
    const ghost = await leaseOnce();
    assert.equal(ghost.response.status, 204);
    row = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "ghost");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");

    // 合法行：lease 响应携带 targetSenderId 且 deliveryScope ≡ conversationId。
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-legit-a",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "legit", occurredAt: fixedNow },
    });
    const legit = await leaseOnce();
    assert.equal(legit.response.status, 200);
    assert.equal(legit.body.item.targetSenderId, SENDER_A);
    assert.equal(legit.body.item.deliveryScope, legit.body.item.conversationId);
    assert.equal(legit.body.item.conversationId, convA);
  });

  it("re-verifies the hash on the worker and terminally rejects tampered lease targets", async () => {
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-tampered",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "tampered", occurredAt: fixedNow },
    });
    const bot = makeBot();
    await drainOutbox({
      bot,
      mutateLease: (lease) => ({
        ...lease,
        item: { ...lease.item, targetSenderId: SENDER_B },
      }),
    });
    assert.equal(bot.calls.length, 0, "a tampered target must never reach the SDK send path");
    const row = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "tampered");
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
    outbox.enqueue({
      owner: OWNER_B,
      conversationId: convB,
      idempotencyKey: "matrix-unreachable",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "unreachable", occurredAt: fixedNow },
    });
    const bot = makeBot({ deliverable: [SENDER_A] });
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
      const row = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "unreachable");
      if (row && row.attempt_count >= 1 && row.status === "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    abort.abort();
    await pump;
    const row = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "unreachable");
    assert.equal(row.status, "queued", "context-not-ready must stay retryable");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error_code, "WEIXIN_CONTEXT_NOT_READY");
  });

  it("discards in-flight rows after unbind and rebind while newly bound senders receive fresh rows", async () => {
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-lifecycle-a",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "lifecycle-a", occurredAt: fixedNow },
    });
    outbox.enqueue({
      owner: OWNER_B,
      conversationId: convB,
      idempotencyKey: "matrix-lifecycle-b",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "lifecycle-b", occurredAt: fixedNow },
    });

    // 解绑 B：其在途行判废、A 不受影响。
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    // 一账号至多一条 active：B 未解绑前重复绑定新 sender 必须 409（此处已解绑，先验证换绑成功后再验证冲突）。
    const bot = makeBot({ deliverable: [SENDER_A, "sender-b2"] });
    await drainOutbox({ bot });
    const rowA = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "lifecycle-a");
    const rowB = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "lifecycle-b");
    assert.equal(rowA.status, "sent");
    assert.equal(bot.calls.filter((call) => call.target === SENDER_A).length, 1);
    assert.equal(rowB.status, "failed");
    assert.equal(rowB.last_error_code, "WEIXIN_DELIVERY_SCOPE_MISMATCH");
    assert.equal(bot.calls.filter((call) => call.target === SENDER_B).length, 0);

    // 换绑 senderB2：旧会话行判废、新行到达新 sender。
    bindings.bind({ senderId: "sender-b2", account: OWNER_B, boundBy: "unit-fixture", financialEnabled: false });
    assert.throws(
      () => bindings.bind({ senderId: "sender-b3", account: OWNER_B, boundBy: "unit-fixture" }),
      (error) => error?.code === "ACCOUNT_ALREADY_BOUND",
      "one active binding per account is enforced",
    );
    outbox.enqueue({
      owner: OWNER_B,
      conversationId: convB,
      idempotencyKey: "matrix-lifecycle-stale",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "lifecycle-stale", occurredAt: fixedNow },
    });
    outbox.enqueue({
      owner: OWNER_B,
      conversationId: shortcutBookkeepingConversationId(OWNER_B, "sender-b2"),
      idempotencyKey: "matrix-lifecycle-fresh",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "lifecycle-fresh", occurredAt: fixedNow },
    });
    const rebindBot = makeBot({ deliverable: [SENDER_A, "sender-b2"] });
    await drainOutbox({ bot: rebindBot });
    const stale = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "lifecycle-stale");
    const fresh = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "lifecycle-fresh");
    assert.equal(stale.status, "failed", "pre-rebind rows must never chase the new sender");
    assert.equal(fresh.status, "sent");
    assert.deepEqual(rebindBot.calls.map((call) => call.target), ["sender-b2"]);
  });

  it("routes unowned tender notices to digest-enabled admin bindings and audits pushless leftovers", async () => {
    const unroutedEvents = [];
    const notifier = makeTenderNotifier({
      resolveCustomerOwners: () => new Map(),
      recordUnrouted: (event) => unroutedEvents.push(event),
    });
    const count = await notifier({
      cycleNumber: 7,
      batchCustomerIds: ["cust-x"],
      notices: [tenderNotice("matrix-unrouted 公告", ["cust-x"])],
    });
    assert.equal(count, 1);
    const adminRows = outboxRows().filter((row) => JSON.parse(row.payload_json).kind === "hospital_tender_notice");
    assert.equal(adminRows.length, 1, "unrouted notices fall back to the admin digest binding");
    assert.equal(adminRows[0].owner, OWNER_A);
    assert.equal(adminRows[0].conversation_id, convA);
    assert.equal(unroutedEvents.length, 0);

    // admin 绑定也不在（B 停用 + A 停用）→ 审计 unrouted 后视为已处理。
    bindings.disable(SENDER_A, { by: "unit-fixture" });
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    const orphanNotifier = makeTenderNotifier({
      resolveCustomerOwners: () => new Map(),
      recordUnrouted: (event) => unroutedEvents.push(event),
    });
    const orphanCount = await orphanNotifier({
      cycleNumber: 8,
      batchCustomerIds: ["cust-x"],
      notices: [tenderNotice("matrix-orphan 公告", ["cust-x"])],
    });
    assert.equal(orphanCount, 1, "audited unrouted notices count as handled for the scheduler contract");
    assert.equal(unroutedEvents.length, 1);
    assert.equal(unroutedEvents[0].count, 1);
  });

  it("upgrades the readiness protocol to the multi sentinel and fails closed for stale workers", async () => {
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-protocol",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "protocol", occurredAt: fixedNow },
    });

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
    assert.equal(granted.body.item.targetSenderId, SENDER_A);

    // hasActive()=false → configuration_incomplete，不再发租约也不判废行。
    await read(await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: granted.body.item.id, leaseToken: granted.body.leaseToken, ok: true }),
    }));
    outbox.enqueue({
      owner: OWNER_A,
      conversationId: convA,
      idempotencyKey: "matrix-protocol-2",
      payload: { kind: "ops_alert", origin: "backend", severity: "warning", summary: "protocol-2", occurredAt: fixedNow },
    });
    bindings.disable(SENDER_A, { by: "unit-fixture" });
    bindings.disable(SENDER_B, { by: "unit-fixture" });
    const unconfigured = await leaseOnce(MULTI_SCOPE);
    assert.equal(unconfigured.response.status, 204);
    const untouched = outboxRows().find((item) => JSON.parse(item.payload_json).summary === "protocol-2");
    assert.equal(untouched.status, "queued", "configuration_incomplete must not burn rows");
  });
});
