import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";

const OWNER = "assistant-owner";

const context = Object.freeze({
  owner: OWNER,
  channel: "weixin",
  conversation: "conversation-write-1",
  event: "event-write-1",
  requestId: "request-write-1",
});

let db;
let handlers;

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  handlers = createAssistantToolHandlers({
    db,
    sessionRepository: {
      getOrCreate: () => ({ id: "conversation-write-1" }),
      listDraftParts: () => [],
      clearDraftParts: () => {},
    },
    resolveBusinessOwner: (owner) => (owner === OWNER ? OWNER : null),
  });
});

afterEach(() => {
  db.close();
  db = null;
});

function auditRows(action) {
  return db.prepare("SELECT * FROM audit_logs WHERE action = $action ORDER BY created_at, id")
    .all({ $action: action })
    .map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
}

describe("customer write runtime handlers", () => {
  it("creates a customer with the resolved owner, aliases, tags, and a full audit row", async () => {
    const result = await handlers["customer.create"]({
      name: "莒县人民医院",
      region: "日照",
      type: "医院",
      level: "B",
      contact: "王科长",
      aliases: ["莒县医院"],
      tags: ["信创"],
    }, { ...context, actionId: "action-create-1" });

    assert.equal(result.status, "created");
    assert.match(result.text, /已建档：莒县人民医院/);
    assert.match(result.text, /action-create-1/);
    const row = db.prepare("SELECT * FROM customers WHERE id = 'action-create-1'").get();
    assert.equal(row.owner, OWNER);
    assert.equal(row.name, "莒县人民医院");
    assert.deepEqual(JSON.parse(row.aliases), ["莒县医院"]);
    assert.deepEqual(JSON.parse(row.tags), ["信创"]);
    assert.equal(row.version, 1);

    const audits = auditRows("customer.create");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, OWNER);
    assert.equal(audits[0].entity_id, "action-create-1");
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    assert.equal(audits[0].metadata.actionId, "action-create-1");
    assert.deepEqual(result.contextUpdate.customerId, "action-create-1");
  });

  it("replays a create with the same action id without inserting a duplicate", async () => {
    const first = await handlers["customer.create"]({ name: "重放医院" }, { ...context, actionId: "action-replay-1" });
    assert.equal(first.status, "created");
    const replay = await handlers["customer.create"]({ name: "重放医院" }, {
      ...context,
      event: "event-write-replay",
      requestId: "request-write-replay",
      actionId: "action-replay-1",
    });
    assert.equal(replay.status, "created");
    assert.equal(replay.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 1);
    assert.equal(auditRows("customer.create").length, 1);
  });

  it("refuses an unbound machine owner before touching the database", async () => {
    const result = await handlers["customer.create"]({ name: "越权医院" }, {
      ...context,
      owner: "someone-else",
      actionId: "action-denied-1",
    });
    assert.equal(result.status, "denied");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 0);
  });

  it("updates fields under the pinned version and records before/after audit", async () => {
    db.prepare("INSERT INTO customers (id, name, region, level, owner) VALUES ('customer-u1', '示例医院', '青岛', 'B', $owner)")
      .run({ $owner: OWNER });
    const result = await handlers["customer.update"]({
      customerId: "customer-u1",
      expectedVersion: 1,
      changes: { level: "A", aliases: ["示例人民医院"] },
    }, { ...context, actionId: "action-update-1" });

    assert.equal(result.status, "updated");
    assert.match(result.text, /已更新：示例医院（v2）/);
    assert.match(result.text, /级别 B→A/);
    assert.match(result.text, /别名 （空）→示例人民医院/);
    const row = db.prepare("SELECT * FROM customers WHERE id = 'customer-u1'").get();
    assert.equal(row.level, "A");
    assert.equal(row.version, 2);
    assert.deepEqual(JSON.parse(row.aliases), ["示例人民医院"]);

    const audits = auditRows("customer.update");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].metadata.changedFields, ["level", "aliases"]);
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    const before = JSON.parse(audits[0].before_json);
    const after = JSON.parse(audits[0].after_json);
    assert.equal(before.level, "B");
    assert.equal(after.level, "A");
  });

  it("fails a stale-version update with a friendly message and writes nothing", async () => {
    db.prepare("INSERT INTO customers (id, name, level, owner) VALUES ('customer-u2', '并发医院', 'B', $owner)")
      .run({ $owner: OWNER });
    const result = await handlers["customer.update"]({
      customerId: "customer-u2",
      expectedVersion: 9,
      changes: { level: "A" },
    }, { ...context, actionId: "action-update-2" });

    assert.equal(result.status, "conflict");
    assert.match(result.text, /刚在其他端被修改/);
    const row = db.prepare("SELECT level, version FROM customers WHERE id = 'customer-u2'").get();
    assert.equal(row.level, "B");
    assert.equal(row.version, 1);
    assert.equal(auditRows("customer.update").length, 0);
  });

  it("refuses to update a customer owned by another business owner", async () => {
    db.prepare("INSERT INTO customers (id, name, owner) VALUES ('customer-u3', '他人医院', 'other-owner')").run();
    const result = await handlers["customer.update"]({
      customerId: "customer-u3",
      expectedVersion: 1,
      changes: { level: "A" },
    }, { ...context, actionId: "action-update-3" });
    assert.equal(result.status, "not_found");
    assert.equal(db.prepare("SELECT level FROM customers WHERE id = 'customer-u3'").get().level, null);
  });

  it("soft-deletes a customer, hides it and its opportunities from the assistant reads", async () => {
    db.exec(`
      INSERT INTO customers (id, name, owner) VALUES ('customer-d1', '删除医院', 'assistant-owner');
      INSERT INTO opportunities (id, customer_id, name) VALUES ('opp-d1', 'customer-d1', '信息化一期');
    `);
    const result = await handlers["customer.delete"]({
      customerId: "customer-d1",
      expectedVersion: 1,
    }, { ...context, actionId: "action-delete-1" });

    assert.equal(result.status, "deleted");
    assert.match(result.text, /已删除（归档）：删除医院/);
    const row = db.prepare("SELECT deleted_at, deleted_by, version FROM customers WHERE id = 'customer-d1'").get();
    assert.ok(row.deleted_at);
    assert.equal(row.deleted_by, OWNER);
    assert.equal(row.version, 2);

    const audits = auditRows("customer.delete");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    assert.equal(audits[0].metadata.name, "删除医院");

    const detail = await handlers["customer.detail"]({ customerId: "customer-d1" }, {
      ...context,
      event: "event-post-delete",
      requestId: "request-post-delete",
    });
    assert.equal(detail.status, "not_found");
    const search = await handlers["customer.search"]({ query: "删除医院" }, {
      ...context,
      event: "event-post-delete-search",
      requestId: "request-post-delete-search",
    });
    assert.equal(search.items.length, 0);
  });

  it("rejects a stale delete without archiving anything", async () => {
    db.prepare("INSERT INTO customers (id, name, owner) VALUES ('customer-d2', '保留医院', $owner)")
      .run({ $owner: OWNER });
    const result = await handlers["customer.delete"]({
      customerId: "customer-d2",
      expectedVersion: 4,
    }, { ...context, actionId: "action-delete-2" });
    assert.equal(result.status, "conflict");
    assert.equal(db.prepare("SELECT deleted_at FROM customers WHERE id = 'customer-d2'").get().deleted_at, null);
  });

  it("finds customers through aliases in the assistant search and shows the profile card", async () => {
    db.prepare(`
      INSERT INTO customers (id, name, region, type, level, owner, contact, budget, summary, aliases, tags)
      VALUES ('customer-a1', '日照市中医医院', '日照', '医院', 'A', $owner, '张主任', '约300万', '推进十五五规划',
              '["日照中医院"]', '["十五五","信创"]')
    `).run({ $owner: OWNER });

    const search = await handlers["customer.search"]({ query: "日照中医院" }, {
      ...context,
      event: "event-alias-search",
      requestId: "request-alias-search",
    });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].id, "customer-a1");

    const detail = await handlers["customer.detail"]({ customerId: "customer-a1" }, {
      ...context,
      event: "event-alias-detail",
      requestId: "request-alias-detail",
    });
    assert.equal(detail.status, "ok");
    assert.match(detail.text, /客户画像：日照市中医医院 \[customer-a1\]/);
    assert.match(detail.text, /联系人：张主任/);
    assert.match(detail.text, /预算：约300万/);
    assert.match(detail.text, /别名：日照中医院/);
    assert.match(detail.text, /标签：十五五、信创/);
    assert.match(detail.text, /在办商机 0 个/);
  });
});
