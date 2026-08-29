import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createActionItemStore } from "../src/actionItems/actionItemStore.js";
import { createActionReminderScheduler } from "../src/actionReminders/reminderScheduler.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";

const OWNER = "assistant-owner";
const OWNER_B = "assistant-peer";
const NOW = "2026-08-28T02:00:00.000Z";

let dir;
let db;
let deliveries;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentelligent-action-reminder-"));
  db = openDatabase({ databaseUrl: join(dir, "reminders.sqlite") });
  deliveries = [{ account: OWNER, conversationId: "conversation-bound-1" }];
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeScheduler(overrides = {}) {
  const store = createActionItemStore(db, { clock: () => new Date(NOW) });
  const outboxRepository = createWeixinConfirmationOutboxRepository(db, { clock: () => new Date(NOW) });
  const scheduler = createActionReminderScheduler({
    db,
    store,
    outboxRepository,
    resolveDeliveries: () => deliveries,
    deliveryReady: () => true,
    clock: () => new Date(NOW),
    pollMs: 60_000,
    ...overrides,
  });
  return { store, outboxRepository, scheduler };
}

function seedDue(id, remindAt, extra = "", owner = OWNER) {
  db.exec(`
    INSERT INTO action_items (id, title, owner, remind_at${extra ? `, ${extra.split("=")[0]}` : ""})
    VALUES ('${id}', '给王工送方案', '${owner}', '${remindAt}'${extra ? `, ${extra.split("=")[1]}` : ""})
  `);
}

function outboxRows() {
  return db.prepare("SELECT * FROM weixin_confirmation_outbox ORDER BY created_at, id").all();
}

describe("action reminder scheduler", () => {
  it("enqueues a due reminder, marks reminded_at, and audits once", async () => {
    const { scheduler } = makeScheduler();
    seedDue("todo-due-01", "2026-08-28T01:00:00.000Z");
    const result = await scheduler.runOnce();
    assert.deepEqual(result, { status: "success", enqueuedCount: 1, lateCount: 0 });
    const rows = outboxRows();
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.kind, "action_reminder");
    assert.equal(payload.idSuffix, "due-01");
    assert.equal(rows[0].conversation_id, "conversation-bound-1");
    assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'todo-due-01'").get().reminded_at, NOW);
    const audits = db.prepare("SELECT * FROM audit_logs WHERE action = 'action.reminder.sent'").all();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, "system:action-reminder");
    // The second tick has nothing left to do.
    const idle = await scheduler.runOnce();
    assert.deepEqual(idle, { status: "success", enqueuedCount: 0, lateCount: 0 });
    assert.equal(outboxRows().length, 1);
  });

  it("leaves future, done, deleted, and unbound-owner rows untouched", async () => {
    const { scheduler } = makeScheduler();
    seedDue("todo-future", "2026-08-28T09:00:00.000Z");
    db.exec(`
      INSERT INTO action_items (id, title, owner, remind_at, status)
      VALUES ('todo-done', '完成项', '${OWNER}', '2026-08-28T01:00:00.000Z', 'done');
      INSERT INTO action_items (id, title, owner, remind_at, deleted_at)
      VALUES ('todo-deleted', '删除项', '${OWNER}', '2026-08-28T01:00:00.000Z', '2026-08-27T00:00:00.000Z');
      INSERT INTO action_items (id, title, owner, remind_at)
      VALUES ('todo-foreign', '他人项', '其他人', '2026-08-28T01:00:00.000Z');
    `);
    const result = await scheduler.runOnce();
    assert.deepEqual(result, { status: "success", enqueuedCount: 0, lateCount: 0 });
    assert.equal(outboxRows().length, 0);
    // 无绑定 owner 的到期项不扫描、不置 reminded_at（后补绑定即补发的前提）。
    assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'todo-foreign'").get().reminded_at, null);
  });

  it("multicasts per binding, keys per owner, and back-fills once a late binding appears", async () => {
    deliveries = [
      { account: OWNER, conversationId: "conversation-bound-1" },
      { account: OWNER_B, conversationId: "conversation-bound-2" },
    ];
    const { scheduler, outboxRepository } = makeScheduler();
    seedDue("todo-owner-a", "2026-08-28T01:00:00.000Z");
    seedDue("todo-owner-b", "2026-08-28T01:00:00.000Z", "", OWNER_B);
    const result = await scheduler.runOnce();
    assert.deepEqual(result, { status: "success", enqueuedCount: 2, lateCount: 0 });
    const rows = outboxRows();
    assert.deepEqual(
      rows.map((row) => [row.owner, row.conversation_id]).sort(),
      [[OWNER, "conversation-bound-1"], [OWNER_B, "conversation-bound-2"]].sort(),
    );
    // 幂等键含 owner 维度。
    const remindAtMs = Date.parse("2026-08-28T01:00:00.000Z");
    assert.equal(outboxRepository.hasKey({ owner: OWNER, idempotencyKey: `action-reminder:${OWNER}:todo-owner-a:${remindAtMs}` }), true);
    assert.equal(outboxRepository.hasKey({ owner: OWNER_B, idempotencyKey: `action-reminder:${OWNER_B}:todo-owner-b:${remindAtMs}` }), true);

    // 后补绑定即补发：第三 owner 的到期项在其绑定出现后被扫描并带过期标记。
    seedDue("todo-owner-late", "2026-08-26T01:00:00.000Z", "", "latebinder");
    const before = await scheduler.runOnce();
    assert.equal(before.enqueuedCount, 0);
    deliveries = [...deliveries, { account: "latebinder", conversationId: "conversation-bound-3" }];
    const after = await scheduler.runOnce();
    assert.deepEqual(after, { status: "success", enqueuedCount: 1, lateCount: 1 });
    const latePayload = outboxRows()
      .map((row) => JSON.parse(row.payload_json))
      .find((payload) => payload.actionItemId === "todo-owner-late");
    assert.equal(latePayload.late, true);
  });

  it("skips without marking anything while delivery is not ready", async () => {
    const { scheduler } = makeScheduler({ deliveryReady: () => false });
    seedDue("todo-offline", "2026-08-28T01:00:00.000Z");
    const result = await scheduler.runOnce();
    assert.deepEqual(result, { status: "skipped", reason: "delivery_not_ready" });
    assert.equal(outboxRows().length, 0);
    assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'todo-offline'").get().reminded_at, null);
  });

  it("replays the outbox key instead of duplicating after a cleared marker", async () => {
    const { scheduler } = makeScheduler();
    seedDue("todo-replay", "2026-08-28T01:00:00.000Z");
    await scheduler.runOnce();
    db.exec("UPDATE action_items SET reminded_at = NULL WHERE id = 'todo-replay'");
    const rerun = await scheduler.runOnce();
    assert.equal(rerun.status, "success");
    assert.equal(rerun.enqueuedCount, 1);
    assert.equal(outboxRows().length, 1, "the idempotency key must not duplicate the message");
    assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'todo-replay'").get().reminded_at, NOW);
  });

  it("recovers after a restart by scanning the table on the first tick", async () => {
    const first = makeScheduler();
    seedDue("todo-restart", "2026-08-28T01:00:00.000Z");
    // Simulate a crash before any tick: a fresh scheduler instance picks the
    // row up because the table itself is the queue.
    const second = makeScheduler();
    const result = await second.scheduler.runOnce();
    assert.equal(result.enqueuedCount, 1);
    assert.equal(first.store.dueReminders({ owner: OWNER, now: NOW }).length, 0);
  });

  it("marks reminders older than 24 hours as late", async () => {
    const { scheduler } = makeScheduler();
    seedDue("todo-late", "2026-08-26T01:00:00.000Z");
    const result = await scheduler.runOnce();
    assert.deepEqual(result, { status: "success", enqueuedCount: 1, lateCount: 1 });
    const payload = JSON.parse(outboxRows()[0].payload_json);
    assert.equal(payload.late, true);
  });

  it("keeps the reminder unmarked when the outbox enqueue throws", async () => {
    const { scheduler } = makeScheduler({
      outboxRepository: {
        enqueue() {
          throw new Error("outbox unavailable");
        },
      },
    });
    seedDue("todo-broken", "2026-08-28T01:00:00.000Z");
    const result = await scheduler.runOnce();
    assert.equal(result.status, "failed");
    assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'todo-broken'").get().reminded_at, null);
    assert.equal(scheduler.status().lastError, "outbox unavailable");
  });

  it("respects the batch limit and reports status fields", async () => {
    const { scheduler } = makeScheduler({ batchLimit: 2 });
    seedDue("todo-batch-1", "2026-08-28T00:00:00.000Z");
    seedDue("todo-batch-2", "2026-08-28T00:30:00.000Z");
    seedDue("todo-batch-3", "2026-08-28T01:00:00.000Z");
    const first = await scheduler.runOnce();
    assert.equal(first.enqueuedCount, 2);
    const second = await scheduler.runOnce();
    assert.equal(second.enqueuedCount, 1);
    const status = scheduler.status();
    assert.equal(status.lastStatus, "success");
    assert.equal(status.lastTickAt, NOW);
    assert.equal(status.pollMs, 60_000);
  });
});
