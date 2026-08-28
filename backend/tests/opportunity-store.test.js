import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  activeOpportunityEntityRow,
  countOpportunityReferences,
  createOpportunity,
  findActiveOpportunityByExactName,
  findOpportunityByIdSuffix,
  getActiveOpportunity,
  listOwnerOpportunities,
  opportunityFromRow,
  softDeleteOpportunity,
  updateOpportunity,
} from "../src/opportunities/opportunityStore.js";

const OWNER = "assistant-owner";

let db;

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  db.exec(`
    INSERT INTO customers (id, name, region, owner) VALUES
      ('customer-1', '日照中医医院', '日照', '${OWNER}'),
      ('customer-2', '黄岛区中医院', '青岛', '${OWNER}'),
      ('customer-other', '外部医院', '外地', 'someone-else');
  `);
});

afterEach(() => {
  db.close();
  db = null;
});

describe("opportunity store", () => {
  it("creates an opportunity with full fields, JSON columns, and an optional explicit id", () => {
    const created = createOpportunity(db, {
      customerId: "customer-1",
      name: "十五五规划",
      customer: "日照中医医院",
      stage: "方案输出",
      amount: "规划类",
      owner: OWNER,
      probability: 66,
      days: 12,
      requirements: ["双活机房"],
      competitors: ["移动云"],
      solutionDirection: ["三段式"],
      sourceRecord: "qr-1",
      risk: "数据自主权矛盾",
      next: "补齐规划材料",
      tone: "blue",
    }, { id: "opp-fixed-id-1" });
    assert.equal(created.id, "opp-fixed-id-1");
    assert.equal(created.version, 1);
    assert.equal(created.stage, "方案输出");
    assert.deepEqual(created.requirements, ["双活机房"]);
    assert.deepEqual(created.competitors, ["移动云"]);
    assert.equal(created.owner, OWNER);

    const random = createOpportunity(db, { customerId: "customer-1", name: "随机编号商机" });
    assert.ok(random.id && random.id !== "opp-fixed-id-1");
    assert.equal(random.probability, 0);
    assert.deepEqual(random.requirements, []);
  });

  it("updates with patch-value semantics, bumps the version, and keeps untouched fields", () => {
    const created = createOpportunity(db, {
      customerId: "customer-1",
      name: "十五五规划",
      customer: "日照中医医院",
      stage: "方案输出",
      amount: "规划类",
      risk: "原始风险",
      requirements: ["原始需求"],
    }, { id: "opp-update-1" });
    const updated = updateOpportunity(db, "opp-update-1", { stage: "方案交流" }, created.version);
    assert.equal(updated.version, 2);
    assert.equal(updated.stage, "方案交流");
    assert.equal(updated.amount, "规划类");
    assert.equal(updated.risk, "原始风险");
    assert.deepEqual(updated.requirements, ["原始需求"]);
  });

  it("throws 409 VERSION_CONFLICT with the current version and 404 for missing rows", () => {
    createOpportunity(db, { customerId: "customer-1", name: "版本冲突商机" }, { id: "opp-conflict-1" });
    updateOpportunity(db, "opp-conflict-1", { stage: "线索" }, 1);
    assert.throws(
      () => updateOpportunity(db, "opp-conflict-1", { stage: "初步沟通" }, 1),
      (error) => error.status === 409 && error.code === "VERSION_CONFLICT" && error.fields.currentVersion === 2,
    );
    assert.equal(updateOpportunity(db, "opp-missing", { stage: "线索" }, 1), null);
  });

  it("soft-deletes with an opportunity.delete audit row and rejects a second delete", () => {
    createOpportunity(db, {
      customerId: "customer-1", name: "删除商机", stage: "线索", owner: OWNER,
    }, { id: "opp-delete-1" });
    const deleted = softDeleteOpportunity(db, {
      id: "opp-delete-1",
      expectedVersion: 1,
      deletedBy: OWNER,
      requestId: "request-1",
      metadata: { source: "weixin-assistant", actionId: "action-1" },
    });
    assert.equal(deleted.version, 2);
    assert.ok(deleted.deletedAt);
    assert.equal(getActiveOpportunity(db, "opp-delete-1"), null);
    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'opportunity.delete'").all();
    assert.equal(audit.length, 1);
    const metadata = JSON.parse(audit[0].metadata_json);
    assert.equal(metadata.name, "删除商机");
    assert.equal(metadata.customerId, "customer-1");
    assert.equal(metadata.stage, "线索");
    assert.equal(metadata.source, "weixin-assistant");
    assert.equal(metadata.actionId, "action-1");
    const before = JSON.parse(audit[0].before_json);
    assert.equal(before.version, 1);
    assert.throws(
      () => softDeleteOpportunity(db, { id: "opp-delete-1", expectedVersion: 2, deletedBy: OWNER }),
      (error) => error.status === 404,
    );
  });

  it("finds by id suffix inside the owner-visible OR scope with LIKE escaping", () => {
    createOpportunity(db, { customerId: "customer-1", name: "自有商机", owner: OWNER }, { id: "opp-own-abc123" });
    createOpportunity(db, { customerId: "customer-1", name: "继承商机", owner: null }, { id: "opp-null-abc123" });
    createOpportunity(db, { customerId: "customer-other", name: "他人商机", owner: "someone-else" }, { id: "opp-else-abc123" });
    createOpportunity(db, { customerId: "customer-2", name: "唯一商机", owner: OWNER }, { id: "opp-unique-def456" });

    const multi = findOpportunityByIdSuffix(db, { owner: OWNER, suffix: "abc123" });
    assert.deepEqual(multi.matches.map((item) => item.id).sort(), ["opp-null-abc123", "opp-own-abc123"]);
    assert.equal(multi.matches.every((item) => item.customer), true, "candidates carry the joined customer name");

    const unique = findOpportunityByIdSuffix(db, { owner: OWNER, suffix: "def456" });
    assert.equal(unique.matches.length, 1);
    assert.equal(unique.matches[0].id, "opp-unique-def456");

    assert.deepEqual(findOpportunityByIdSuffix(db, { owner: OWNER, suffix: "%_%" }).matches, []);
    assert.deepEqual(findOpportunityByIdSuffix(db, { owner: OWNER, suffix: "短" }).matches, []);
    assert.deepEqual(findOpportunityByIdSuffix(db, { owner: "", suffix: "abc123" }).matches, []);
  });

  it("hides suffix matches whose customer is deleted", () => {
    createOpportunity(db, { customerId: "customer-2", name: "客户删档商机", owner: OWNER }, { id: "opp-hidden-zzz999" });
    db.prepare("UPDATE customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'customer-2'").run();
    assert.deepEqual(findOpportunityByIdSuffix(db, { owner: OWNER, suffix: "zzz999" }).matches, []);
  });

  it("lists owner-visible opportunities most recently updated first with a truncation flag", () => {
    for (let index = 0; index < 4; index += 1) {
      createOpportunity(db, { customerId: "customer-1", name: `列表商机${index}`, owner: OWNER }, { id: `opp-list-${index}` });
    }
    createOpportunity(db, { customerId: "customer-other", name: "不可见商机", owner: "someone-else" }, { id: "opp-list-hidden" });
    const page = listOwnerOpportunities(db, { owner: OWNER, limit: 3 });
    assert.equal(page.items.length, 3);
    assert.equal(page.truncated, true);
    assert.equal(page.items.every((item) => item.id !== "opp-list-hidden"), true);
    const all = listOwnerOpportunities(db, { owner: OWNER, limit: 9 });
    assert.equal(all.items.length, 4);
    assert.equal(all.truncated, false);
    assert.deepEqual(listOwnerOpportunities(db, { owner: "" }).items, []);
  });

  it("deduplicates by exact name only inside the same customer", () => {
    createOpportunity(db, { customerId: "customer-1", name: "同名项目", owner: OWNER }, { id: "opp-dup-1" });
    const hit = findActiveOpportunityByExactName(db, { customerId: "customer-1", name: " 同名项目 " });
    assert.equal(hit.id, "opp-dup-1");
    assert.equal(findActiveOpportunityByExactName(db, { customerId: "customer-2", name: "同名项目" }), null);
    assert.equal(findActiveOpportunityByExactName(db, { customerId: "customer-1", name: "" }), null);
    db.prepare("UPDATE opportunities SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'opp-dup-1'").run();
    assert.equal(findActiveOpportunityByExactName(db, { customerId: "customer-1", name: "同名项目" }), null);
  });

  it("counts live references across actions, risks, quick records, and solution drafts", () => {
    createOpportunity(db, { customerId: "customer-1", name: "引用商机", owner: OWNER }, { id: "opp-ref-1" });
    db.exec(`
      INSERT INTO action_items (id, opportunity_id, title) VALUES
        ('act-1', 'opp-ref-1', '行动一'),
        ('act-2', 'opp-ref-1', '行动二');
      INSERT INTO action_items (id, opportunity_id, title, deleted_at) VALUES
        ('act-deleted', 'opp-ref-1', '已删行动', CURRENT_TIMESTAMP);
      INSERT INTO risk_items (id, opportunity_id, title, target, evidence, action) VALUES
        ('risk-1', 'opp-ref-1', '风险一', '目标', '证据', '处理');
      INSERT INTO quick_records (id, raw_content, opportunity_id) VALUES
        ('qr-1', '记录一', 'opp-ref-1'),
        ('qr-2', '记录二', 'opp-ref-1'),
        ('qr-3', '记录三', 'opp-ref-1');
      INSERT INTO quick_records (id, raw_content, opportunity_id, voided_at) VALUES
        ('qr-voided', '已作废', 'opp-ref-1', CURRENT_TIMESTAMP);
      INSERT INTO solution_drafts (id, owner, title, customer_id, opportunity_id, content) VALUES
        ('sd-1', '${OWNER}', '方案草稿', 'customer-1', 'opp-ref-1', '正文');
    `);
    assert.deepEqual(countOpportunityReferences(db, "opp-ref-1"), {
      actions: 2,
      risks: 1,
      quickRecords: 3,
      solutionDrafts: 1,
    });
    assert.deepEqual(countOpportunityReferences(db, "opp-none"), {
      actions: 0,
      risks: 0,
      quickRecords: 0,
      solutionDrafts: 0,
    });
  });

  it("keeps the entity-row projection contract used by the web routes", () => {
    createOpportunity(db, { customerId: "customer-1", name: "投影商机", owner: OWNER }, { id: "opp-proj-1" });
    const row = activeOpportunityEntityRow(db, "opp-proj-1");
    const entity = opportunityFromRow(row);
    assert.equal(entity.id, "opp-proj-1");
    assert.equal(entity.version, 1);
    assert.equal(entity.customerId, "customer-1");
    assert.equal(activeOpportunityEntityRow(db, "opp-proj-1", "someone-else"), undefined);
  });
});
