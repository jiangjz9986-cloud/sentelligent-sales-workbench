import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const shortcutToken = "test-shortcut-token";
const machineToken = "weixin-machine-test-token";
const owner = "assistant-owner";
const sender = "sender-1";
const confirmationSecret = ["test", "shortcut", "confirmation", "secret"].join("-");

let tempDir;
let server;
let baseUrl;
let entrySequence;
let actionSequence;
let outboxSequence;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function analysis(overrides = {}) {
  return {
    status: "ready",
    confidence: 0.98,
    expense: {
      occurredOn: "2026-08-18",
      amountCents: 1280,
      reimbursementCents: 1280,
      purpose: "客户拜访交通",
      merchant: "济南出租车",
      paidAt: "2026-08-18T12:00:00+08:00",
      fundingSource: "personal",
      paymentMethod: "wechat",
    },
    warnings: [],
    source: { provider: "test", model: null },
    ...overrides,
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}) },
  });
  return read(response);
}

function shortcutBody(idempotencyKey, text = "2026-08-18 打车 12.80元") {
  return {
    text,
    selection_path: "出差报销 · 支出 · 交通 · 打车",
    note: "客户拜访",
    idempotency_key: idempotencyKey,
    source: "shortcut",
  };
}

function incomeBody(idempotencyKey, text = "2026-08-18 收到出差报销 12.80元") {
  return {
    text,
    selection_path: "出差报销 · 收入 · 出差 · 报销",
    note: "差旅款到账",
    idempotency_key: idempotencyKey,
    source: "shortcut",
  };
}

function eventHeaders(id) {
  return {
    Authorization: `Bearer ${machineToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `weixin:${id}`,
  };
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "test-worker",
    "X-Weixin-Delivery-Status": "ready",
    "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(owner, sender),
  };
}

async function reportWorkerReady() {
  const reported = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: workerHeaders(),
  });
  assert.equal(reported.response.status, 204);
}

async function deliveryStatus(entryId) {
  return request(`/api/integrations/shortcut/bookkeeping/status?entryId=${encodeURIComponent(entryId)}`, {
    headers: { Authorization: `Bearer ${shortcutToken}` },
  });
}

async function retryDelivery(entryId) {
  return request("/api/integrations/shortcut/bookkeeping/delivery-retry", {
    method: "POST",
    headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
}

async function leaseOutbox() {
  const leased = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: workerHeaders(),
  });
  assert.equal(leased.response.status, 200);
  assert.ok(leased.body.leaseToken);
  return leased.body;
}

async function ackOutbox(lease, ok = true, providerMessageId = null) {
  const ack = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: lease.item.id,
      leaseToken: lease.leaseToken,
      ok,
      ...(providerMessageId ? { providerMessageId } : {}),
    }),
  });
  assert.equal(ack.response.status, 200);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-weixin-confirmation-"));
  entrySequence = 0;
  actionSequence = 0;
  outboxSequence = 0;
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    shortcutWebhookToken: shortcutToken,
    shortcutWebhookOwner: owner,
    shortcutWeixinConfirmationEnabled: true,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: owner,
    weixinBookkeepingOwner: owner,
    weixinBookkeepingSenderId: sender,
    weixinAllowedSenderIds: sender,
    weixinAllowGroups: false,
    assistantConfirmationSecret: confirmationSecret,
    shortcutBookkeepingIdFactory: () => `entry-${++entrySequence}`,
    shortcutBookkeepingAssistantIdFactory: () => `action-${++actionSequence}`,
    weixinConfirmationOutboxIdFactory: () => `outbox-${++outboxSequence}`,
    travelExpenseAnalyzer: async () => analysis(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await reportWorkerReady();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("快捷指令—小小—微信自然语言确认闭环", () => {
  it("holds a recognized expense and writes only after an explicit confirmation", async () => {
    const received = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-1")),
    });
    assert.equal(received.response.status, 202);
    assert.equal(received.body.item.status, "review_required");
    assert.equal(received.body.item.confirmationPending, true);
    assert.deepEqual(received.body.item.confirmationDelivery, { status: "queued" });
    assert.ok(received.body.item.assistantActionId);

    const queued = await deliveryStatus(received.body.item.id);
    assert.equal(queued.response.status, 200);
    assert.deepEqual(queued.body.item.confirmationDelivery, { status: "queued" });

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    const rawOutbox = db.prepare("SELECT payload_json FROM weixin_confirmation_outbox").get().payload_json;
    assert.doesNotMatch(rawOutbox, /\d{6}/u);
    db.close();

    const lease = await leaseOutbox();
    assert.deepEqual((await deliveryStatus(received.body.item.id)).body.item.confirmationDelivery, { status: "sending" });
    assert.match(lease.item.message, /^检测到一笔新记账，请确认！/u);
    assert.match(lease.item.message, /时间：2026年08月18日 12:00/u);
    assert.match(lease.item.message, /12\.80 元/);
    assert.match(lease.item.message, /费用类别：支出 \/ 交通 \/ 打车/u);
    assert.match(lease.item.message, /备注：客户拜访/u);
    assert.doesNotMatch(lease.item.message, /商户：|用途：/u);
    assert.match(lease.item.message, /回复“确认”/u);
    assert.match(lease.item.message, /以“修改”开头/u);
    assert.match(lease.item.message, /回复“取消”/u);
    assert.doesNotMatch(lease.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    await ackOutbox(lease);
    assert.equal((await deliveryStatus(received.body.item.id)).body.item.confirmationDelivery.status, "sent");

    const event = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-event-1"),
      body: JSON.stringify({
        conversationId: "provider-conversation-1",
        text: "确认",
        sourceMessageId: "shortcut-confirmation-event-1",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(event.response.status, 200);
    assert.match(event.body.text, /已确认并录入森特智行/);

    const after = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
    assert.equal(after.prepare("SELECT status FROM shortcut_bookkeeping_entries").get().status, "accepted");
    assert.equal(after.prepare("SELECT status FROM assistant_pending_actions").get().status, "executed");
    after.close();
  });

  it("requires the current draft to be delivered before accepting '确认'", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-current-draft-gate")),
    });
    assert.equal(created.response.status, 202);
    const lease = await leaseOutbox();

    const premature = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-current-draft-premature"),
      body: JSON.stringify({
        conversationId: "current-draft-gate",
        text: "确认",
        sourceMessageId: "shortcut-current-draft-premature",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(premature.response.status, 409);
    assert.equal(premature.body.status, "review_required");
    assert.match(premature.body.text, /最新记账草稿/u);
    const before = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(before.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    before.close();

    await ackOutbox(lease);
    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-current-draft-confirmed"),
      body: JSON.stringify({
        conversationId: "current-draft-gate",
        text: "确认",
        sourceMessageId: "shortcut-current-draft-confirmed",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");
  });

  it("confirms an income record without creating travel-expense rows", async () => {
    const received = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(incomeBody("shortcut-income-confirmation")),
    });
    assert.equal(received.response.status, 202);
    assert.equal(received.body.item.entryType, "income");

    const lease = await leaseOutbox();
    assert.match(lease.item.message, /^检测到一笔新记账，请确认！/u);
    assert.match(lease.item.message, /费用类别：收入 \/ 出差 \/ 报销/u);
    assert.match(lease.item.message, /备注：差旅款到账/u);
    await ackOutbox(lease);

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-income-confirmation-event"),
      body: JSON.stringify({
        conversationId: "provider-income-conversation",
        text: "确认",
        sourceMessageId: "shortcut-income-confirmation-event",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(confirmed.response.status, 200);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const entry = db.prepare("SELECT status, entry_type, expense_id, payment_id FROM shortcut_bookkeeping_entries").get();
    assert.deepEqual({ ...entry }, {
      status: "accepted",
      entry_type: "income",
      expense_id: null,
      payment_id: null,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);
    db.close();
  });

  it("applies an explicit amount correction, resends the draft, and rejects a different sender", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-2")),
    });
    assert.equal(created.response.status, 202);
    const first = await leaseOutbox();
    assert.doesNotMatch(first.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    await ackOutbox(first);

    const denied = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-denied"),
      body: JSON.stringify({
        conversationId: "provider-conversation-other",
        text: "确认",
        sourceMessageId: "shortcut-confirmation-denied",
        senderId: "not-allowlisted",
        chatType: "direct",
      }),
    });
    assert.equal(denied.response.status, 403);

    const missingPrefix = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-correction-missing-prefix"),
      body: JSON.stringify({
        conversationId: "provider-conversation-2",
        text: "金额改为 18.50 元",
        sourceMessageId: "shortcut-confirmation-correction-missing-prefix",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(missingPrefix.response.status, 200);
    assert.equal(missingPrefix.body.status, "clarify");
    assert.match(missingPrefix.body.text, /“修改…”/u);

    const corrected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-correction"),
      body: JSON.stringify({
        conversationId: "provider-conversation-2",
        text: "修改金额为 18.50 元",
        sourceMessageId: "shortcut-confirmation-correction",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(corrected.response.status, 200);
    assert.match(corrected.body.text, /更新草稿|最新识别结果/);

    const second = await leaseOutbox();
    assert.match(second.item.message, /18\.50 元/);
    assert.doesNotMatch(second.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    await ackOutbox(second);

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-final"),
      body: JSON.stringify({
        conversationId: "provider-conversation-3",
        text: "确认",
        sourceMessageId: "shortcut-confirmation-final",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(confirmed.response.status, 200);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT amount_cents FROM shortcut_bookkeeping_entries").get().amount_cents, 1850);
    assert.equal(db.prepare("SELECT amount_cents FROM travel_expense_payments").get().amount_cents, 1850);
    db.close();
  });

  it("cancels a pending draft without any financial write", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-structured-mismatch")),
    });
    assert.equal(created.response.status, 202);

    const lease = await leaseOutbox();
    assert.doesNotMatch(lease.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    await ackOutbox(lease);

    const cancelled = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-structured-mismatch"),
      body: JSON.stringify({
        conversationId: "provider-conversation-structured-mismatch",
        text: "取消",
        sourceMessageId: "shortcut-confirmation-structured-mismatch",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.status, "cancel");

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    const rejected = db.prepare("SELECT status, raw_text, analysis_json, amount_cents, merchant, purpose, note FROM shortcut_bookkeeping_entries").get();
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.raw_text, "[已取消]");
    assert.equal(rejected.analysis_json, null);
    assert.equal(rejected.amount_cents, null);
    assert.equal(rejected.merchant, null);
    assert.equal(rejected.purpose, null);
    assert.equal(rejected.note, null);
    db.close();
  });

  it("requeues only an explicitly selected transient delivery failure", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-explicit-delivery-retry")),
    });
    assert.equal(created.response.status, 202);
    const lease = await leaseOutbox();
    const failed = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: lease.item.id,
        leaseToken: lease.leaseToken,
        ok: false,
        terminal: true,
        errorCode: "WEIXIN_SEND_FAILED",
      }),
    });
    assert.equal(failed.response.status, 200);
    assert.equal((await deliveryStatus(created.body.item.id)).body.item.confirmationDelivery.status, "failed");

    const replayedSubmission = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-explicit-delivery-retry")),
    });
    assert.equal(replayedSubmission.response.status, 503);
    assert.equal(replayedSubmission.body.error.code, "SHORTCUT_WEIXIN_DELIVERY_FAILED");

    const retried = await retryDelivery(created.body.item.id);
    assert.equal(retried.response.status, 200);
    assert.deepEqual(retried.body.item.confirmationDelivery, { status: "queued" });
    const retryLease = await leaseOutbox();
    assert.equal(retryLease.item.id, lease.item.id);
    await ackOutbox(retryLease);
    assert.equal((await deliveryStatus(created.body.item.id)).body.item.confirmationDelivery.status, "sent");
  });

  it("rejects broad affirmative language and writes only for the exact command '确认'", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-text-confirm-rejected")),
    });
    assert.equal(created.response.status, 202);
    const lease = await leaseOutbox();
    await ackOutbox(lease);

    for (const [index, text] of ["好的", "同意", "确认入账", "确认。", " 确认", "确认 ", "确认\n"].entries()) {
      const clarified = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(`shortcut-text-confirm-rejected-event-${index}`),
        body: JSON.stringify({
          conversationId: "text-confirm-rejected",
          text,
          sourceMessageId: `shortcut-text-confirm-rejected-event-${index}`,
          senderId: sender,
          chatType: "direct",
        }),
      });
      assert.equal(clarified.response.status, 200);
      assert.equal(clarified.body.status, "clarify");
      assert.match(clarified.body.text, /只接受“确认”、“修改…”或“取消”/u);
    }
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    db.close();

    const accepted = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-text-confirm-explicit-event"),
      body: JSON.stringify({
        conversationId: "text-confirm-rejected",
        text: "确认",
        sourceMessageId: "shortcut-text-confirm-explicit-event",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.status, "ok");
  });

  it("explains that typed and structured six-digit codes are not used", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-structured-code")),
    });
    assert.equal(created.response.status, 202);
    const lease = await leaseOutbox();
    await ackOutbox(lease);

    const rejected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-structured-code-rejected"),
      body: JSON.stringify({
        conversationId: "structured-code",
        text: "123456",
        confirmationCode: "123456",
        sourceMessageId: "shortcut-structured-code-rejected",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.status, "clarify");
    assert.match(rejected.body.text, /不使用六位确认码/u);
    const before = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(before.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    before.close();

    const accepted = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-structured-code-explicit-confirm"),
      body: JSON.stringify({
        conversationId: "structured-code",
        text: "确认",
        sourceMessageId: "shortcut-structured-code-explicit-confirm",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.status, "ok");
  });

  it("keeps multiple drafts pending and applies a quoted decision only to the referenced draft", async () => {
    const first = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-pending-first")),
    });
    assert.equal(first.response.status, 202);
    const second = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-pending-second", "2026-08-18 停车 20元")),
    });
    assert.equal(second.response.status, 202);
    const firstLease = await leaseOutbox();
    const firstReference = /BK-[0-9A-F]{12}/u.exec(firstLease.item.message)?.[0];
    assert.ok(firstReference);
    await ackOutbox(firstLease, true, "provider-draft-first");
    const secondLease = await leaseOutbox();
    const secondReference = /BK-[0-9A-F]{12}/u.exec(secondLease.item.message)?.[0];
    assert.ok(secondReference);
    await ackOutbox(secondLease, true, "provider-draft-second");

    const ambiguous = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-pending-ambiguous"),
      body: JSON.stringify({
        conversationId: "provider-conversation-pending",
        text: "确认",
        sourceMessageId: "shortcut-pending-ambiguous",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(ambiguous.response.status, 409);
    assert.equal(ambiguous.body.status, "clarify");
    assert.match(ambiguous.body.text, /多笔待确认|引用/u);

    const confirmedFirst = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-pending-confirm-first"),
      body: JSON.stringify({
        conversationId: "provider-conversation-pending",
        text: "确认",
        quotedMessageId: "provider-draft-first",
        quotedText: `检测到一笔新记账，请确认！\n待确认编号：${firstReference}`,
        sourceMessageId: "shortcut-pending-confirm-first",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(confirmedFirst.response.status, 200);
    assert.equal(confirmedFirst.body.status, "ok");

    const cancelledSecond = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-pending-cancel-second"),
      body: JSON.stringify({
        conversationId: "provider-conversation-pending",
        text: "取消",
        quotedText: `检测到一笔新记账，请确认！\n待确认编号：${secondReference}`,
        sourceMessageId: "shortcut-pending-cancel-second",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(cancelledSecond.response.status, 200);
    assert.equal(cancelledSecond.body.status, "cancel");

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const rows = db.prepare("SELECT id, status FROM shortcut_bookkeeping_entries ORDER BY id").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: first.body.item.id, status: "accepted" },
      { id: second.body.item.id, status: "rejected" },
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    db.close();
  });

  it("supersedes an unleased draft when it is corrected or cancelled", async () => {
    const corrected = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-stale-correction")),
    });
    assert.equal(corrected.response.status, 202);
    const correction = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-stale-correction-event"),
      body: JSON.stringify({
        conversationId: "stale-correction",
        text: "修改金额为 18.50 元",
        sourceMessageId: "shortcut-stale-correction-event",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(correction.response.status, 200);
    const correctedLease = await leaseOutbox();
    assert.match(correctedLease.item.message, /18\.50 元/u);
    assert.doesNotMatch(correctedLease.item.message, /12\.80 元/u);
    assert.doesNotMatch(correctedLease.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    await ackOutbox(correctedLease);

    const finishFirst = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-stale-correction-finish"),
      body: JSON.stringify({
        conversationId: "stale-correction",
        text: "确认",
        sourceMessageId: "shortcut-stale-correction-finish",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(finishFirst.response.status, 200);
    const acceptedLease = await leaseOutbox();
    assert.match(acceptedLease.item.message, /已确认并录入森特智行/u);
    await ackOutbox(acceptedLease);

    const cancelled = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-stale-cancel")),
    });
    assert.equal(cancelled.response.status, 202);
    const cancellation = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-stale-cancel-event"),
      body: JSON.stringify({
        conversationId: "stale-cancel",
        text: "取消",
        sourceMessageId: "shortcut-stale-cancel-event",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(cancellation.response.status, 200);
    assert.equal(cancellation.body.status, "cancel");
    const cancellationLease = await leaseOutbox();
    assert.match(cancellationLease.item.message, /已取消快捷记账/u);
    assert.doesNotMatch(cancellationLease.item.message, /待确认快捷记账/u);
    await ackOutbox(cancellationLease);
  });
});
