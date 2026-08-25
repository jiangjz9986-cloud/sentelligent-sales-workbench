import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const machineHeaderValue = "advance-machine-credential";
const owner = "advance-owner";
const sender = "advance-sender";
const confirmationMaterial = "advance-weixin-confirmation-material-123456";

let dir;
let server;
let baseUrl;
let entryNo = 0;
let actionNo = 0;
let outboxNo = 0;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function request(path, options = {}) {
  return read(await fetch(`${baseUrl}${path}`, options));
}

function eventHeaders(id) {
  return {
    Authorization: `Bearer ${machineHeaderValue}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `weixin:${id}`,
  };
}

async function sendBookkeeping(id, text) {
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders(id),
    body: JSON.stringify({
      conversationId: "advance-conversation",
      text,
      sourceMessageId: id,
      senderId: sender,
      chatType: "direct",
    }),
  });
}

async function workerReady() {
  return request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: {
    Authorization: `Bearer ${machineHeaderValue}`,
      "X-Weixin-Worker-Id": "advance-test-worker",
      "X-Weixin-Delivery-Status": "ready",
      "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(owner, sender),
    },
  });
}

async function lease() {
  const result = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: {
    Authorization: `Bearer ${machineHeaderValue}`,
      "X-Weixin-Worker-Id": "advance-test-worker",
      "X-Weixin-Delivery-Status": "ready",
      "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(owner, sender),
    },
  });
  assert.equal(result.response.status, 200);
  return result.body;
}

async function ack(item, providerMessageId) {
  const result = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${machineHeaderValue}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.item.id, leaseToken: item.leaseToken, ok: true, providerMessageId }),
  });
  assert.equal(result.response.status, 200);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "shortcut-advance-weixin-"));
  entryNo = 0;
  actionNo = 0;
  outboxNo = 0;
  server = createServer({
    databaseUrl: join(dir, "assistant.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    weixinBookkeepingConfirmationEnabled: true,
    weixinAgentApiToken: machineHeaderValue,
    weixinAgentOwner: owner,
    weixinBookkeepingOwner: owner,
    weixinBookkeepingSenderId: sender,
    weixinAllowedSenderIds: sender,
    weixinAllowGroups: false,
    assistantConfirmationSecret: confirmationMaterial,
    shortcutBookkeepingIdFactory: () => `entry-${++entryNo}`,
    shortcutBookkeepingAssistantIdFactory: () => `action-${++actionNo}`,
    weixinConfirmationOutboxIdFactory: () => `outbox-${++outboxNo}`,
    travelExpenseAnalyzer: async (text) => ({
      status: "ready",
      confidence: 1,
      expense: {
        occurredOn: text.includes("借款") ? "2026-08-26" : "2026-08-25",
        amountCents: text.includes("借款") ? 200000 : 50000,
        reimbursementCents: text.includes("借款") ? 200000 : 50000,
        purpose: text.includes("借款") ? "出差借款" : "餐饮",
        paidAt: text.includes("借款") ? "2026-08-26T10:00:00+08:00" : "2026-08-25T12:00:00+08:00",
        fundingSource: "personal",
        paymentMethod: "wechat",
      },
      warnings: [],
      source: { provider: "test" },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await workerReady()).response.status, 204);
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

test("loan income creates a pool and natural-language week assignment allocates it", async () => {
  const expense = await sendBookkeeping("advance-expense-1", "支出 2026-08-25 餐饮 500元");
  assert.equal(expense.response.status, 200);
  const expenseDraft = await lease();
  await ack(expenseDraft, "expense-draft-message");
  const expenseConfirm = await request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders("advance-expense-confirm"),
    body: JSON.stringify({
      conversationId: "advance-conversation",
      text: "确认入账",
      sourceMessageId: "advance-expense-confirm",
      senderId: sender,
      chatType: "direct",
      quotedMessageId: "expense-draft-message",
    }),
  });
  assert.equal(expenseConfirm.response.status, 200);
  const expenseAcceptedReceipt = await lease();
  await ack(expenseAcceptedReceipt, "expense-accepted-message");

  const loan = await sendBookkeeping("advance-income-1", "收入 2026-08-26 收到出差借款 2000元");
  assert.equal(loan.response.status, 200);
  const loanDraft = await lease();
  await ack(loanDraft, "loan-draft-message");
  const loanConfirm = await request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders("advance-income-confirm"),
    body: JSON.stringify({
      conversationId: "advance-conversation",
      text: "确认入账",
      sourceMessageId: "advance-income-confirm",
      senderId: sender,
      chatType: "direct",
      quotedMessageId: "loan-draft-message",
    }),
  });
  assert.equal(loanConfirm.response.status, 200);
  const acceptedReceipt = await lease();
  await ack(acceptedReceipt, "loan-accepted-message");
  const allocationPrompt = await lease();
  assert.match(allocationPrompt.item.message, /借款到账待归属/u);
  await ack(allocationPrompt, "loan-allocation-message");
  const allocation = await request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders("advance-allocation-week"),
    body: JSON.stringify({
      conversationId: "advance-conversation",
      text: "这笔借款用于本周",
      sourceMessageId: "advance-allocation-week",
      senderId: sender,
      chatType: "direct",
      quotedMessageId: "loan-allocation-message",
    }),
  });
  assert.equal(allocation.response.status, 200);
  assert.match(allocation.body.text, /借款已入账并完成分配/u);

  const db = openDatabase({ databaseUrl: join(dir, "assistant.sqlite") });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_advance_allocations WHERE status = 'active'").get().count, 1);
  assert.equal(db.prepare("SELECT allocated_cents FROM travel_expense_advance_allocations WHERE status = 'active'").get().allocated_cents, 50000);
  const advanceFacts = db.prepare("SELECT requested_cents, requested_on, received_cents FROM travel_expense_advances").get();
  assert.equal(advanceFacts.requested_cents, 0);
  assert.equal(advanceFacts.requested_on, null);
  assert.equal(advanceFacts.received_cents, 200000);
  db.close();
});

test("cancelling the allocation follow-up defers only allocation and preserves received income", async () => {
  const loan = await sendBookkeeping(
    "advance-income-cancel-allocation",
    "收入 2026-08-26 收到出差借款 2000元",
  );
  assert.equal(loan.response.status, 200);
  const loanDraft = await lease();
  await ack(loanDraft, "loan-cancel-draft-message");
  const loanConfirm = await request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders("advance-income-cancel-confirm"),
    body: JSON.stringify({
      conversationId: "advance-cancel-conversation",
      text: "确认入账",
      sourceMessageId: "advance-income-cancel-confirm",
      senderId: sender,
      chatType: "direct",
      quotedMessageId: "loan-cancel-draft-message",
    }),
  });
  assert.equal(loanConfirm.response.status, 200);
  const acceptedReceipt = await lease();
  await ack(acceptedReceipt, "loan-cancel-accepted-message");
  const allocationPrompt = await lease();
  await ack(allocationPrompt, "loan-cancel-allocation-message");
  const deferred = await request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: eventHeaders("advance-allocation-cancel"),
    body: JSON.stringify({
      conversationId: "advance-cancel-conversation",
      text: "取消",
      sourceMessageId: "advance-allocation-cancel",
      senderId: sender,
      chatType: "direct",
      quotedMessageId: "loan-cancel-allocation-message",
    }),
  });
  assert.equal(deferred.response.status, 200);
  assert.match(deferred.body.text, /暂不分配/u);
  const db = openDatabase({ databaseUrl: join(dir, "assistant.sqlite") });
  assert.equal(db.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE entry_type = 'income'").get().status, "accepted");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_advance_allocations").get().count, 0);
  db.close();
});
