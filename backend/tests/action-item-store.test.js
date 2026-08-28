import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createActionItemStore } from "../src/actionItems/actionItemStore.js";

const OWNER = "继振";

function withStore(work) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    return work(createActionItemStore(db, { clock: () => new Date("2026-08-28T02:00:00.000Z") }), db);
  } finally {
    db.close();
  }
}

describe("actionItemStore.create", () => {
  it("creates an owner-scoped todo with reminder columns and derived tone", () => {
    withStore((store, db) => {
      const item = store.create({
        owner: OWNER,
        title: "给王工送方案",
        due: "周五前",
        remindAt: "2026-08-28T01:00:00.000Z",
        priority: "高",
        id: "todo-create-1",
      });
      assert.equal(item.id, "todo-create-1");
      assert.equal(item.owner, OWNER);
      assert.equal(item.remindAt, "2026-08-28T01:00:00.000Z");
      assert.equal(item.status, "pending");
      assert.equal(item.version, 1);
      const row = db.prepare("SELECT * FROM action_items WHERE id = 'todo-create-1'").get();
      assert.equal(row.tone, "red");
      assert.equal(row.assignee, OWNER);
      assert.equal(row.source_record_id, null);
    });
  });

  it("rejects duplicate ids so handler-level replay can take over", () => {
    withStore((store) => {
      store.create({ owner: OWNER, title: "重复", id: "todo-dup-1" });
      assert.throws(() => store.create({ owner: OWNER, title: "重复", id: "todo-dup-1" }), /UNIQUE/iu);
    });
  });
});

describe("actionItemStore visibility", () => {
  it("sees own-column, customer-join, and opportunity-join rows but not others", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO customers (id, name, owner) VALUES ('customer-1', '日照中医医院', '${OWNER}');
        INSERT INTO customers (id, name, owner) VALUES ('customer-2', '外部医院', '别人');
        INSERT INTO opportunities (id, customer_id, name, owner) VALUES ('opp-1', 'customer-1', '信息化', '${OWNER}');
        INSERT INTO action_items (id, title, owner) VALUES ('own-column', '自有列待办', '${OWNER}');
        INSERT INTO action_items (id, title, customer_id) VALUES ('via-customer', '客户挂接待办', 'customer-1');
        INSERT INTO action_items (id, title, opportunity_id) VALUES ('via-opportunity', '商机挂接待办', 'opp-1');
        INSERT INTO action_items (id, title) VALUES ('orphan', '孤立待办');
        INSERT INTO action_items (id, title, customer_id) VALUES ('foreign', '他人待办', 'customer-2');
      `);
      const { items } = store.list({ owner: OWNER, limit: 10 });
      const ids = items.map((item) => item.id).sort();
      assert.deepEqual(ids, ["own-column", "via-customer", "via-opportunity"]);
      assert.equal(items.find((item) => item.id === "via-customer").customerName, "日照中医医院");
    });
  });

  it("windows the list on remind_at and hides no-reminder rows inside a window", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at) VALUES
          ('in-window', '今天', '${OWNER}', '2026-08-28T01:00:00.000Z'),
          ('out-window', '下周', '${OWNER}', '2026-09-03T01:00:00.000Z');
        INSERT INTO action_items (id, title, owner) VALUES ('no-reminder', '无提醒', '${OWNER}');
        INSERT INTO action_items (id, title, owner, remind_at, status) VALUES
          ('done-item', '已完成', '${OWNER}', '2026-08-28T01:30:00.000Z', 'done');
      `);
      const windowed = store.list({ owner: OWNER, dateStart: "2026-08-28", dateEnd: "2026-08-28" });
      assert.deepEqual(windowed.items.map((item) => item.id), ["in-window"]);
      const all = store.list({ owner: OWNER });
      assert.deepEqual(all.items.map((item) => item.id).sort(), ["in-window", "no-reminder", "out-window"]);
    });
  });
});

describe("actionItemStore targeting and writes", () => {
  it("resolves id suffixes and title queries within the owner scope only", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner) VALUES ('todo-abc123', '给王工送方案', '${OWNER}');
        INSERT INTO action_items (id, title, owner) VALUES ('todo-xyz789', '给李工送方案', '${OWNER}');
        INSERT INTO action_items (id, title, owner) VALUES ('todo-other1', '外部待办', '别人');
      `);
      assert.equal(store.findByIdSuffix({ owner: OWNER, suffix: "abc123" }).matches.length, 1);
      assert.equal(store.findByIdSuffix({ owner: OWNER, suffix: "other1" }).matches.length, 0);
      assert.equal(store.findByTitleQuery({ owner: OWNER, query: "送方案" }).matches.length, 2);
      assert.equal(store.findByTitleQuery({ owner: OWNER, query: "王工" }).matches.length, 1);
      assert.equal(store.findByTitleQuery({ owner: OWNER, query: "100%" }).matches.length, 0);
    });
  });

  it("completes, defers (clearing reminded_at), and soft-deletes under version guard", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at, reminded_at)
        VALUES ('todo-write-1', '推进项', '${OWNER}', '2026-08-27T01:00:00.000Z', '2026-08-27T01:01:00.000Z');
      `);
      assert.throws(
        () => store.complete({ owner: OWNER, id: "todo-write-1", expectedVersion: 9 }),
        (error) => error.code === "VERSION_CONFLICT" && error.fields.currentVersion === 1,
      );
      const deferred = store.defer({
        owner: OWNER,
        id: "todo-write-1",
        expectedVersion: 1,
        remindAt: "2026-08-29T01:00:00.000Z",
        due: "明天上午",
      });
      assert.equal(deferred.after.remindAt, "2026-08-29T01:00:00.000Z");
      assert.equal(deferred.after.remindedAt, null);
      assert.equal(deferred.after.status, "pending");
      assert.equal(deferred.after.version, 2);
      const completed = store.complete({ owner: OWNER, id: "todo-write-1", expectedVersion: 2 });
      assert.equal(completed.after.status, "done");
      const removed = store.softDelete({ owner: OWNER, id: "todo-write-1", expectedVersion: 3, deletedBy: "jiangjz" });
      assert.equal(Boolean(removed.after.deletedAt), true);
      assert.equal(db.prepare("SELECT deleted_by FROM action_items WHERE id = 'todo-write-1'").get().deleted_by, "jiangjz");
      assert.throws(
        () => store.complete({ owner: OWNER, id: "todo-write-1", expectedVersion: 4 }),
        (error) => error.code === "NOT_FOUND",
      );
    });
  });

  it("write-protects legacy rows without an owner column value", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO customers (id, name, owner) VALUES ('customer-1', '日照中医医院', '${OWNER}');
        INSERT INTO action_items (id, title, customer_id) VALUES ('legacy-1', '深写回待办', 'customer-1');
      `);
      assert.equal(store.list({ owner: OWNER }).items.length, 1, "legacy row stays visible");
      assert.throws(
        () => store.complete({ owner: OWNER, id: "legacy-1", expectedVersion: 1 }),
        (error) => error.code === "NOT_FOUND",
      );
    });
  });
});

describe("actionItemStore reminders", () => {
  it("scans due reminders for the owner and marks them exactly once", () => {
    withStore((store, db) => {
      db.exec(`
        INSERT INTO action_items (id, title, owner, remind_at) VALUES
          ('due-1', '到点一', '${OWNER}', '2026-08-28T01:00:00.000Z'),
          ('due-2', '未到点', '${OWNER}', '2026-08-28T09:00:00.000Z'),
          ('due-other', '他人到点', '别人', '2026-08-28T01:00:00.000Z');
        INSERT INTO action_items (id, title, owner, remind_at, status) VALUES
          ('due-done', '已完成', '${OWNER}', '2026-08-28T01:00:00.000Z', 'done');
        INSERT INTO action_items (id, title, owner, remind_at, deleted_at) VALUES
          ('due-deleted', '已删除', '${OWNER}', '2026-08-28T01:00:00.000Z', '2026-08-27T00:00:00.000Z');
      `);
      const due = store.dueReminders({ owner: OWNER, now: "2026-08-28T02:00:00.000Z" });
      assert.deepEqual(due.map((item) => item.id), ["due-1"]);
      assert.equal(store.markReminded({ id: "due-1", now: "2026-08-28T02:00:00.000Z" }).marked, true);
      assert.equal(store.markReminded({ id: "due-1", now: "2026-08-28T02:01:00.000Z" }).marked, false);
      assert.equal(store.dueReminders({ owner: OWNER, now: "2026-08-28T02:00:00.000Z" }).length, 0);
      assert.equal(db.prepare("SELECT reminded_at FROM action_items WHERE id = 'due-1'").get().reminded_at, "2026-08-28T02:00:00.000Z");
    });
  });
});
