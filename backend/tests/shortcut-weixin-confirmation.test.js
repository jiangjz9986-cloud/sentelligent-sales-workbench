import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const shortcutToken = "test-shortcut-token";
const machineToken = "test-machine-token";
const owner = "assistant-owner";
const sender = "sender-1";
const fixtureMaterial = Buffer.alloc(32, 0x41);

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

function eventHeaders(id) {
  return {
    Authorization: `Bearer ${machineToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `weixin:${id}`,
  };
}

async function leaseOutbox() {
  const leased = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: { Authorization: `Bearer ${machineToken}`, "X-Weixin-Worker-Id": "test-worker" },
  });
  assert.equal(leased.response.status, 200);
  assert.ok(leased.body.leaseToken);
  return leased.body;
}

async function ackOutbox(lease, ok = true) {
  const ack = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: lease.item.id, leaseToken: lease.leaseToken, ok }),
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
    assistantConfirmationSecret: fixtureMaterial,
    shortcutBookkeepingIdFactory: () => `entry-${++entrySequence}`,
    shortcutBookkeepingAssistantIdFactory: () => `action-${++actionSequence}`,
    weixinConfirmationOutboxIdFactory: () => `outbox-${++outboxSequence}`,
    travelExpenseAnalyzer: async () => analysis(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("快捷指令—小小—微信确认闭环", () => {
  it("holds a recognized expense, sends a redacted-at-rest draft, and writes only after the code", async () => {
    const received = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-1")),
    });
    assert.equal(received.response.status, 202);
    assert.equal(received.body.item.status, "review_required");
    assert.equal(received.body.item.confirmationPending, true);
    assert.ok(received.body.item.assistantActionId);

    const replayed = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-1")),
    });
    assert.equal(replayed.response.status, 202);
    assert.equal(replayed.body.item.status, "review_required");
    assert.equal(replayed.body.item.assistantActionId, received.body.item.assistantActionId);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    const rawOutbox = db.prepare("SELECT payload_json FROM weixin_confirmation_outbox").get().payload_json;
    assert.doesNotMatch(rawOutbox, /\d{6}/u);
    db.close();

    const lease = await leaseOutbox();
    assert.match(lease.item.message, /小小 AI 识别/);
    assert.match(lease.item.message, /12\.80 元/);
    const code = lease.item.message.match(/(?<!\d)\d{6}(?!\d)/u)?.[0];
    assert.ok(code);
    await ackOutbox(lease);

    const event = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-event-1"),
      body: JSON.stringify({
        conversationId: "provider-conversation-1",
        text: code,
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

  it("applies an explicit amount correction, rotates the code, and rejects a different sender", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-2")),
    });
    assert.equal(created.response.status, 202);
    const first = await leaseOutbox();
    const firstCode = first.item.message.match(/(?<!\d)\d{6}(?!\d)/u)?.[0];
    await ackOutbox(first);

    const denied = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-denied"),
      body: JSON.stringify({
        conversationId: "provider-conversation-other",
        text: firstCode,
        sourceMessageId: "shortcut-confirmation-denied",
        senderId: "not-allowlisted",
        chatType: "direct",
      }),
    });
    assert.equal(denied.response.status, 403);

    const corrected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-correction"),
      body: JSON.stringify({
        conversationId: "provider-conversation-2",
        text: "金额改为 18.50 元",
        sourceMessageId: "shortcut-confirmation-correction",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(corrected.response.status, 200);
    assert.match(corrected.body.text, /更新草稿|最新识别结果/);

    const second = await leaseOutbox();
    assert.match(second.item.message, /18\.50 元/);
    const secondCode = second.item.message.match(/(?<!\d)\d{6}(?!\d)/u)?.[0];
    assert.notEqual(secondCode, firstCode);
    await ackOutbox(second);

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-final"),
      body: JSON.stringify({
        conversationId: "provider-conversation-3",
        text: secondCode,
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

  it("rejects a conflicting structured confirmation code before any financial write", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${shortcutToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(shortcutBody("shortcut-confirmation-structured-mismatch")),
    });
    assert.equal(created.response.status, 202);

    const lease = await leaseOutbox();
    const textCode = lease.item.message.match(/(?<!\d)\d{6}(?!\d)/u)?.[0];
    assert.ok(textCode);
    await ackOutbox(lease);

    const conflicting = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("shortcut-confirmation-structured-mismatch"),
      body: JSON.stringify({
        conversationId: "provider-conversation-structured-mismatch",
        text: textCode,
        confirmationCode: textCode === "000000" ? "000001" : "000000",
        sourceMessageId: "shortcut-confirmation-structured-mismatch",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.equal(conflicting.response.status, 409);
    assert.equal(conflicting.body.status, "error");

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT status FROM shortcut_bookkeeping_entries").get().status, "review_required");
    db.close();
  });
});
