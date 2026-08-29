import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

const machineToken = "test-machine-token";
let tempDir;
let server;
let baseUrl;
let nowMs;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function eventBody(overrides = {}) {
  return {
    conversationId: "conversation-todo-1",
    text: "帮助",
    sourceMessageId: "message-todo-1",
    senderId: "sender-1",
    chatType: "direct",
    ...overrides,
  };
}

async function send(sourceMessageId, overrides = {}) {
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Idempotency-Key": `weixin:${sourceMessageId}`,
    },
    body: JSON.stringify(eventBody({ sourceMessageId, ...overrides })),
  });
}

function confirmationCodeFrom(text) {
  const matches = String(text).match(/(?<!\d)\d{6}(?!\d)/gu) ?? [];
  assert.equal(matches.length, 1, "the live confirmation text must contain exactly one code");
  return matches[0];
}

function withDb(work) {
  const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

async function startServer(overrides = {}) {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "assistantowner",
    authPassword: "",
    authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 13) }),
    authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "assistantowner",
    weixinAllowedSenderIds: "sender-1,sender-2",
    weixinAllowGroups: false,
    weixinBookkeepingOwner: "assistantowner",
    weixinBookkeepingSenderId: "sender-1",
    weixinBookkeepingConfirmationEnabled: true,
    assistantClock: () => new Date(nowMs),
    actionReminderSchedulerClock: () => new Date(nowMs),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-action-item-http-"));
  // Friday 2026-08-28 10:00 Asia/Shanghai.
  nowMs = Date.parse("2026-08-28T02:00:00.000Z");
  withDb((db) => {
    db.exec(`
      INSERT INTO customers (id, name, region, type, level, owner)
      VALUES ('customer-seeded-1', '日照中医医院', '日照', '医院', 'A', 'assistantowner');
    `);
  });
  await startServer();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("todo agent HTTP boundary", () => {
  it("creates a todo through the affirm card and writes it on 确认", async () => {
    const pending = await send("todo-create-1", {
      conversationId: "conversation-create-1",
      text: "提醒我明天上午十点给日照中医医院王主任送方案",
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "action-risk.create");
    assert.equal(pending.body.risk, "R1");
    assert.equal(Object.hasOwn(pending.body, "confirmationCode"), false);
    assert.match(pending.body.text, /【小小提醒！新建待办】/u);
    assert.match(pending.body.text, /提醒：08-29（周六）10:00/u);
    assert.match(pending.body.text, /请回复“确认”或“取消”。/u);
    assert.equal(/(?<!\d)\d{6}(?!\d)/u.test(pending.body.text), false, "no six-digit code in the affirm card");

    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count, 0, "nothing before 确认");
    });

    const confirmed = await send("todo-create-2", { conversationId: "conversation-create-1", text: "确认" });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /【待办已创建】/u);
    assert.match(confirmed.body.text, /发送“本周待办”可随时查看。/u);

    withDb((db) => {
      const row = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: pending.body.actionId });
      assert.ok(row, "the pending action id is the durable todo key");
      assert.equal(row.owner, "assistantowner");
      assert.equal(row.remind_at, "2026-08-29T02:00:00.000Z");
      assert.equal(row.status, "pending");
      assert.equal(row.source_record_id, null);
      for (const action of ["action.create", "assistant.action.create", "assistant.action.confirm", "assistant.action.execute"]) {
        assert.ok(
          db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = $action").get({ $action: action }).count >= 1,
          action,
        );
      }
    });
  });

  it("keeps money-worded reminders as todos and clarifies bookkeeping-verb leads", async () => {
    const reminder = await send("todo-money-1", {
      conversationId: "conversation-money-1",
      text: "提醒我明天报销打车费 50 元",
    });
    assert.equal(reminder.body.status, "confirmation_required");
    assert.equal(reminder.body.toolName, "action-risk.create");
    const clarified = await send("todo-money-2", {
      conversationId: "conversation-money-2",
      text: "待办：记账 50 元打车",
    });
    assert.equal(clarified.body.status, "clarify");
    assert.match(clarified.body.text ?? clarified.body.question, /现在记账|待办提醒/u);
  });

  it("lists, completes, defers, and deletes through the confirmation ladder", async () => {
    withDb((db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at, priority)
        VALUES ('todo-seeded-abc123', '给王工送方案', 'assistantowner', '2026-08-28T06:00:00.000Z', '中');
      `);
    });

    const list = await send("todo-list-1", { conversationId: "conversation-list-1", text: "今天有什么待办" });
    assert.equal(list.body.status, "ok");
    assert.match(list.body.text, /【待办清单】/u);
    assert.match(list.body.text, /给王工送方案/u);
    assert.match(list.body.text, /abc123/u);

    const empty = await send("todo-list-2", { conversationId: "conversation-list-2", text: "明天有什么待办" });
    assert.match(empty.body.text, /没有待办/u);

    // Complete with the lightweight confirmation.
    const completePending = await send("todo-complete-1", { conversationId: "conversation-write-1", text: "完成待办 abc123" });
    assert.equal(completePending.body.status, "confirmation_required");
    assert.match(completePending.body.text, /【小小提醒！完成待办】/u);
    assert.equal(/(?<!\d)\d{6}(?!\d)/u.test(completePending.body.text), false);
    const completed = await send("todo-complete-2", { conversationId: "conversation-write-1", text: "确认" });
    assert.match(completed.body.text, /【待办已完成】/u);
    withDb((db) => {
      assert.equal(db.prepare("SELECT status FROM action_items WHERE id = 'todo-seeded-abc123'").get().status, "done");
    });
    const listAfter = await send("todo-list-3", { conversationId: "conversation-list-3", text: "今天有什么待办" });
    assert.match(listAfter.body.text, /没有待办/u);

    // Defer a fresh row and verify the reminder columns move.
    withDb((db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at, reminded_at)
        VALUES ('todo-defer-def456', '回访张主任', 'assistantowner', '2026-08-28T01:00:00.000Z', '2026-08-28T01:30:00.000Z');
      `);
    });
    const deferPending = await send("todo-defer-1", { conversationId: "conversation-write-2", text: "待办 def456 推迟到明天上午" });
    assert.equal(deferPending.body.status, "confirmation_required");
    assert.match(deferPending.body.text, /【小小提醒！推迟待办】/u);
    assert.match(deferPending.body.text, /→ 08-29（周六）09:00/u);
    const deferred = await send("todo-defer-2", { conversationId: "conversation-write-2", text: "确认" });
    assert.match(deferred.body.text, /【待办已顺延】/u);
    withDb((db) => {
      const row = db.prepare("SELECT remind_at, reminded_at, status FROM action_items WHERE id = 'todo-defer-def456'").get();
      assert.equal(row.remind_at, "2026-08-29T01:00:00.000Z");
      assert.equal(row.reminded_at, null);
      assert.equal(row.status, "pending");
    });

    // Delete stays behind the six-digit code.
    const deletePending = await send("todo-delete-1", { conversationId: "conversation-write-3", text: "删除待办 def456" });
    assert.equal(deletePending.body.status, "confirmation_required");
    assert.match(deletePending.body.text, /【小小提醒！删除待办】/u);
    const code = confirmationCodeFrom(deletePending.body.text);
    const deleted = await send("todo-delete-2", { conversationId: "conversation-write-3", text: code });
    assert.match(deleted.body.text, /【待办已删除】/u);
    withDb((db) => {
      assert.ok(db.prepare("SELECT deleted_at FROM action_items WHERE id = 'todo-defer-def456'").get().deleted_at);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'action.delete'").get().count,
        1,
      );
    });
  });

  it("rejects group chats for todo writes and queries", async () => {
    const grouped = await send("todo-group-1", {
      conversationId: "conversation-group-1",
      chatType: "group",
      groupId: "group-1",
      text: "提醒我明天上午十点交材料",
    });
    // The HTTP boundary already fails closed for group chats
    // (weixinAllowGroups=false); the provider write gate stays as defense in
    // depth behind it.
    assert.equal(grouped.response.status, 403);
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count, 0);
    });
  });

  it("keeps todo phrasings out of an active bookkeeping draft and vice versa", async () => {
    const draft = await send("todo-bk-1", { conversationId: "conversation-bound-1", text: "支出 50 元 打车" });
    assert.equal(draft.response.status, 200);
    const pending = await send("todo-bk-2", { conversationId: "conversation-bound-1", text: "提醒我明天上午十点补交发票" });
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(pending.body.toolName, "action-risk.create");
    const confirmed = await send("todo-bk-3", { conversationId: "conversation-bound-1", text: "确认" });
    assert.match(confirmed.body.text, /【待办已创建】/u, "确认 must confirm the todo, not the bookkeeping draft");
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_items").get().count, 1);
    });
  });

  it("pushes due reminders through the scheduler into the outbox exactly once", async () => {
    withDb((db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at, priority, reason)
        VALUES ('todo-remind-xyz789', '给王工送方案', 'assistantowner', '2026-08-28T01:00:00.000Z', '高', '存在竞标风险');
      `);
    });
    const first = await server.actionReminderScheduler.runOnce();
    assert.equal(first.status, "success");
    assert.equal(first.enqueuedCount, 1);
    const second = await server.actionReminderScheduler.runOnce();
    assert.equal(second.enqueuedCount, 0, "reminded_at must stop the second tick");
    withDb((db) => {
      const rows = db.prepare("SELECT * FROM weixin_confirmation_outbox").all();
      assert.equal(rows.length, 1);
      const payload = JSON.parse(rows[0].payload_json);
      assert.equal(payload.kind, "action_reminder");
      assert.equal(payload.idSuffix, "xyz789");
      assert.equal(payload.customerName, null);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'action.reminder.sent'").get().count,
        1,
      );
    });
    const status = await request("/api/actions/reminders/status", {
      headers: { Authorization: `Bearer ${machineToken}` },
    });
    assert.equal(
      [401, 403].includes(status.response.status),
      true,
      "machine tokens must not read the admin endpoint",
    );
  });
});
