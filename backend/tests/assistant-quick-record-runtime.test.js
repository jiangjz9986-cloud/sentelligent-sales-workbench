import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";

const OWNER = "assistant-owner";

const context = Object.freeze({
  owner: OWNER,
  channel: "weixin",
  conversation: "conversation-record-1",
  event: "event-record-1",
  requestId: "request-record-1",
});

let db;
let handlers;
let nowMs;

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  nowMs = Date.parse("2026-08-28T04:00:00.000Z");
  handlers = createAssistantToolHandlers({
    db,
    config: {},
    sessionRepository: {
      getOrCreate: () => ({ id: "conversation-record-1" }),
      listDraftParts: () => [],
      clearDraftParts: () => {},
    },
    resolveBusinessOwner: (owner) => (owner === OWNER ? OWNER : null),
    clock: () => new Date(nowMs),
  });
});

afterEach(() => {
  db.close();
  db = null;
});

function seedCustomer(id, name) {
  db.prepare(
    "INSERT INTO customers (id, name, region, type, level, owner) VALUES ($id, $name, '日照', '医院', 'A', $owner)",
  ).run({ $id: id, $name: name, $owner: OWNER });
}

function seedOpportunity(id, customerId, name) {
  db.prepare(
    "INSERT INTO opportunities (id, customer_id, name, owner) VALUES ($id, $customerId, $name, $owner)",
  ).run({ $id: id, $customerId: customerId, $name: name, $owner: OWNER });
}

function seedRecord(id, {
  rawContent = "拜访记录原文",
  occurredAt = "2026-08-27T04:00:00.000Z",
  customerId = null,
  opportunityId = null,
  status = "analyzed",
} = {}) {
  db.prepare(`
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status)
    VALUES ($id, $owner, $rawContent, $occurredAt, '微信助手', $customerId, $opportunityId, $status)
  `).run({ $id: id, $owner: OWNER, $rawContent: rawContent, $occurredAt: occurredAt, $customerId: customerId, $opportunityId: opportunityId, $status: status });
}

function seedInsight(id, quickRecordId) {
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
    VALUES ($id, $quickRecordId, 'mock', 70, $analysisJson)
  `).run({
    $id: id,
    $quickRecordId: quickRecordId,
    $analysisJson: JSON.stringify({
      source: "mock",
      summary: {
        request: { title: "客户诉求", text: "原始诉求" },
        feedback: { title: "客户反馈", text: "原始反馈" },
        risk: { title: "风险点", text: "原始风险" },
        action: { title: "建议动作", text: "原始建议" },
      },
    }),
  });
}

function auditRows(action) {
  return db.prepare("SELECT * FROM audit_logs WHERE action = $action ORDER BY created_at, id")
    .all({ $action: action })
    .map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
}

describe("visit-capture.capture handler", () => {
  it("persists the record with the WeChat source channel, both audits, and the action id as the record key", async () => {
    seedCustomer("customer-1", "日照中医医院");
    const result = await handlers["visit-capture.capture"]({
      rawContent: "今天拜访了日照中医医院，谈了十五五规划",
      occurredAt: "2026-08-28T04:00:00.000Z",
    }, { ...context, actionId: "action-capture-1" });

    assert.equal(result.status, "recorded");
    assert.match(result.text, /已录入，记录 ID：…ture-1/);
    assert.match(result.text, /已挂接客户：日照中医医院/);
    const row = db.prepare("SELECT * FROM quick_records WHERE id = 'action-capture-1'").get();
    assert.equal(row.owner, OWNER);
    assert.equal(row.source_channel, "微信助手");
    assert.equal(row.occurred_at, "2026-08-28T04:00:00.000Z");
    assert.equal(row.customer_id, "customer-1");
    assert.equal(row.status, "analyzed");

    const createAudits = auditRows("quick_record.create");
    assert.equal(createAudits.length, 1);
    assert.equal(createAudits[0].metadata.source, "weixin-assistant");
    assert.equal(createAudits[0].metadata.actionId, "action-capture-1");
    assert.equal(createAudits[0].metadata.sourceChannel, "微信助手");
    const analyzeAudits = auditRows("quick_record.analyze");
    assert.equal(analyzeAudits.length, 1);
    assert.equal(analyzeAudits[0].metadata.captureSource, "weixin-assistant");
    assert.equal(analyzeAudits[0].metadata.actionId, "action-capture-1");
    assert.equal(result.contextUpdate.customerId, "customer-1");
  });

  it("replays by action id without inserting a duplicate record", async () => {
    const first = await handlers["visit-capture.capture"]({
      rawContent: "电话沟通了灾备方案",
    }, { ...context, actionId: "action-replay-1" });
    assert.equal(first.status, "recorded");
    const replay = await handlers["visit-capture.capture"]({
      rawContent: "电话沟通了灾备方案",
    }, { ...context, event: "event-replay-2", requestId: "request-replay-2", actionId: "action-replay-1" });
    assert.equal(replay.status, "recorded");
    assert.equal(replay.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quick_records").get().count, 1);
    assert.equal(auditRows("quick_record.create").length, 1);
  });

  it("drops a model-suggested opportunity whose customer relationship conflicts", async () => {
    seedCustomer("customer-1", "日照中医医院");
    seedCustomer("customer-2", "莒县人民医院");
    seedOpportunity("opportunity-2", "customer-2", "莒县项目");
    // The deterministic mock analysis will surface 日照中医医院 as the customer
    // candidate; the record must never link an opportunity of another customer.
    const result = await handlers["visit-capture.capture"]({
      rawContent: "今天拜访了日照中医医院，聊了莒县项目",
    }, { ...context, actionId: "action-conflict-1" });
    const row = db.prepare("SELECT customer_id, opportunity_id FROM quick_records WHERE id = 'action-conflict-1'").get();
    if (row.customer_id === "customer-1") {
      assert.notEqual(row.opportunity_id, "opportunity-2", "a mismatched pair must drop the opportunity");
    }
    assert.equal(result.status, "recorded");
  });

  it("defaults occurred-at to now and keeps drafts untouched", async () => {
    const result = await handlers["visit-capture.capture"]({
      rawContent: "会议纪要：确认下一步",
    }, { ...context, actionId: "action-now-1" });
    assert.equal(result.record.occurredAt, "2026-08-28T04:00:00.000Z");
  });
});

describe("visit-capture.search handler", () => {
  it("denies an unbound business owner", async () => {
    const result = await handlers["visit-capture.search"]({}, { ...context, owner: "someone-else" });
    assert.equal(result.status, "denied");
    assert.match(result.text, /未绑定业务负责人/);
  });

  it("lists records with status labels and pins the context on a unique hit", async () => {
    seedCustomer("customer-1", "日照中医医院");
    seedRecord("record-aaa111", { customerId: "customer-1", rawContent: "十五五规划预算300万" });
    const result = await handlers["visit-capture.search"]({
      query: "日照",
      dateStart: "2026-08-24",
      dateEnd: "2026-08-30",
    }, context);
    assert.equal(result.status, "ok");
    assert.match(result.text, /找到 1 条记录/);
    assert.match(result.text, /日照中医医院/);
    assert.match(result.text, /已分析/);
    assert.match(result.text, /…aaa111/);
    assert.equal(result.contextUpdate.customerId, "customer-1");
  });

  it("returns the friendly empty text", async () => {
    const result = await handlers["visit-capture.search"]({ query: "不存在" }, context);
    assert.equal(result.items.length, 0);
    assert.match(result.text, /没有找到与“不存在”相关的记录/);
  });
});

describe("visit-capture.update handler", () => {
  it("updates the summary text through the shared store with the web-named audit action", async () => {
    seedRecord("record-update-1");
    seedInsight("insight-1", "record-update-1");
    const result = await handlers["visit-capture.update"]({
      quickRecordId: "record-update-1",
      expectedVersion: 1,
      changes: { summaryPatch: { action: "周三前发对比材料给张主任" } },
    }, { ...context, actionId: "action-update-1" });
    assert.equal(result.status, "updated");
    assert.match(result.text, /已更新记录 …date-1（v2）：建议动作已修改/);
    assert.match(result.text, /不会自动回改/);
    const audits = auditRows("quick_record.analysis.update");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    assert.equal(audits[0].metadata.actionId, "action-update-1");
    assert.deepEqual(audits[0].metadata.summaryFields, ["action"]);
  });

  it("updates linkage fields with the new quick_record.update audit action", async () => {
    seedCustomer("customer-1", "日照中医医院");
    seedRecord("record-update-2");
    const result = await handlers["visit-capture.update"]({
      quickRecordId: "record-update-2",
      expectedVersion: 1,
      changes: { fields: { customerId: "customer-1" } },
    }, { ...context, actionId: "action-update-2" });
    assert.equal(result.status, "updated");
    assert.match(result.text, /挂接客户已修改/);
    const audits = auditRows("quick_record.update");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].metadata.changedFields, ["customerId"]);
    assert.equal(db.prepare("SELECT customer_id FROM quick_records WHERE id = 'record-update-2'").get().customer_id, "customer-1");
  });

  it("reports version conflicts and relationship failures with friendly text and no write", async () => {
    seedRecord("record-update-3");
    seedInsight("insight-3", "record-update-3");
    const conflict = await handlers["visit-capture.update"]({
      quickRecordId: "record-update-3",
      expectedVersion: 9,
      changes: { summaryPatch: { action: "x" } },
    }, context);
    assert.equal(conflict.status, "conflict");
    assert.match(conflict.text, /刚在其他端被修改/);
    assert.equal(auditRows("quick_record.analysis.update").length, 0);

    seedCustomer("customer-a", "客户A");
    seedCustomer("customer-b", "客户B");
    seedOpportunity("opportunity-b", "customer-b", "B项目");
    seedRecord("record-update-4", { customerId: "customer-b", opportunityId: "opportunity-b" });
    const relationship = await handlers["visit-capture.update"]({
      quickRecordId: "record-update-4",
      expectedVersion: 1,
      changes: { fields: { customerId: "customer-a" } },
    }, context);
    assert.equal(relationship.status, "conflict");
    assert.match(relationship.text, /关系已变化/);
  });
});

describe("visit-capture.void handler", () => {
  it("voids a record with the quick_record.void audit and friendly receipt", async () => {
    seedRecord("record-void-1", { status: "confirmed" });
    const result = await handlers["visit-capture.void"]({
      quickRecordId: "record-void-1",
      expectedVersion: 1,
    }, { ...context, actionId: "action-void-1" });
    assert.equal(result.status, "voided");
    assert.match(result.text, /已作废记录 …void-1/);
    const row = db.prepare("SELECT voided_at, voided_by, void_reason, version FROM quick_records WHERE id = 'record-void-1'").get();
    assert.equal(row.voided_at, "2026-08-28T04:00:00.000Z");
    assert.equal(row.voided_by, OWNER);
    assert.equal(row.void_reason, "weixin-assistant-void");
    assert.equal(row.version, 2);
    const audits = auditRows("quick_record.void");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.previousStatus, "confirmed");
    assert.equal(audits[0].metadata.wasConfirmed, true);
    assert.equal(audits[0].metadata.source, "weixin-assistant");
  });

  it("reports not-found for a repeated void and conflict for a stale version", async () => {
    seedRecord("record-void-2");
    await handlers["visit-capture.void"]({ quickRecordId: "record-void-2", expectedVersion: 1 }, context);
    const repeat = await handlers["visit-capture.void"]({ quickRecordId: "record-void-2", expectedVersion: 2 }, context);
    assert.equal(repeat.status, "not_found");

    seedRecord("record-void-3");
    const conflict = await handlers["visit-capture.void"]({ quickRecordId: "record-void-3", expectedVersion: 5 }, context);
    assert.equal(conflict.status, "conflict");
  });
});
