import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createQuickRecordStore } from "../src/quickRecords/quickRecordStore.js";

const OWNER = "assistant-owner";
const OTHER_OWNER = "other-owner";

let db;
let store;
let nowMs;

function seedCustomer(id, name, { owner = OWNER } = {}) {
  db.prepare(
    "INSERT INTO customers (id, name, region, type, level, owner) VALUES ($id, $name, '日照', '医院', 'A', $owner)",
  ).run({ $id: id, $name: name, $owner: owner });
}

function seedOpportunity(id, customerId, name) {
  db.prepare(
    "INSERT INTO opportunities (id, customer_id, name) VALUES ($id, $customerId, $name)",
  ).run({ $id: id, $customerId: customerId, $name: name });
}

function seedRecord(id, {
  owner = OWNER,
  rawContent = "拜访记录原文",
  occurredAt = "2026-08-20T04:00:00.000Z",
  customerId = null,
  opportunityId = null,
  status = "analyzed",
  createdAt = "2026-08-20T04:00:00.000Z",
} = {}) {
  db.prepare(`
    INSERT INTO quick_records (id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status, created_at)
    VALUES ($id, $owner, $rawContent, $occurredAt, '微信助手', $customerId, $opportunityId, $status, $createdAt)
  `).run({
    $id: id,
    $owner: owner,
    $rawContent: rawContent,
    $occurredAt: occurredAt,
    $customerId: customerId,
    $opportunityId: opportunityId,
    $status: status,
    $createdAt: createdAt,
  });
}

function seedInsight(id, quickRecordId, summary, createdAt = "2026-08-20T04:05:00.000Z") {
  db.prepare(`
    INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json, created_at)
    VALUES ($id, $quickRecordId, 'mock', 70, $analysisJson, $createdAt)
  `).run({
    $id: id,
    $quickRecordId: quickRecordId,
    $analysisJson: JSON.stringify({
      source: "mock",
      summary: summary ?? {
        request: { title: "客户诉求", text: "原始诉求" },
        feedback: { title: "客户反馈", text: "原始反馈" },
        risk: { title: "风险点", text: "原始风险" },
        action: { title: "建议动作", text: "原始建议" },
      },
    }),
    $createdAt: createdAt,
  });
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  nowMs = Date.parse("2026-08-28T04:00:00.000Z");
  store = createQuickRecordStore(db, { clock: () => new Date(nowMs) });
});

afterEach(() => {
  db.close();
  db = null;
});

describe("quickRecordStore.search", () => {
  it("scopes to the owner, joins the customer name, and excludes voided rows", () => {
    seedCustomer("customer-1", "日照中医医院");
    seedRecord("record-mine-1", { customerId: "customer-1" });
    seedRecord("record-theirs", { owner: OTHER_OWNER });
    seedRecord("record-voided", {});
    db.prepare("UPDATE quick_records SET voided_at = '2026-08-21T00:00:00.000Z' WHERE id = 'record-voided'").run();

    const result = store.search({ owner: OWNER });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.items.map((item) => item.id), ["record-mine-1"]);
    assert.equal(result.items[0].customerName, "日照中医医院");
  });

  it("escapes LIKE wildcards in the query", () => {
    seedRecord("record-a", { rawContent: "谈了 100% 折扣方案" });
    seedRecord("record-b", { rawContent: "普通拜访" });
    assert.deepEqual(store.search({ owner: OWNER, query: "100%" }).items.map((item) => item.id), ["record-a"]);
    assert.equal(store.search({ owner: OWNER, query: "%_" }).items.length, 0);
  });

  it("matches by customer name through the join", () => {
    seedCustomer("customer-1", "日照中医医院");
    seedRecord("record-a", { customerId: "customer-1", rawContent: "现场沟通机房" });
    seedRecord("record-b", { rawContent: "别家医院的记录" });
    assert.deepEqual(store.search({ owner: OWNER, query: "日照中医" }).items.map((item) => item.id), ["record-a"]);
  });

  it("filters by date and falls back to created_at when occurred_at is null", () => {
    seedRecord("record-old", { occurredAt: "2026-08-10T04:00:00.000Z" });
    seedRecord("record-new", { occurredAt: null, createdAt: "2026-08-27T04:00:00.000Z" });
    const range = store.search({ owner: OWNER, dateStart: "2026-08-24", dateEnd: "2026-08-30" });
    assert.deepEqual(range.items.map((item) => item.id), ["record-new"]);
    const both = store.search({ owner: OWNER, dateStart: "2026-08-10", dateEnd: "2026-08-30" });
    assert.equal(both.items.length, 2);
  });

  it("reports truncation past the limit", () => {
    for (let index = 0; index < 7; index += 1) {
      seedRecord(`record-${index}`, { occurredAt: `2026-08-2${index}T04:00:00.000Z` });
    }
    const result = store.search({ owner: OWNER, limit: 5 });
    assert.equal(result.items.length, 5);
    assert.equal(result.truncated, true);
  });
});

describe("quickRecordStore.findByIdSuffix and latestEditable", () => {
  it("finds by unique id suffix within the owner only", () => {
    seedRecord("record-abc123");
    seedRecord("record-def456", { owner: OTHER_OWNER });
    assert.deepEqual(store.findByIdSuffix({ owner: OWNER, suffix: "abc123" }).items.map((item) => item.id), ["record-abc123"]);
    assert.equal(store.findByIdSuffix({ owner: OWNER, suffix: "def456" }).items.length, 0);
  });

  it("returns multiple matches for an ambiguous suffix and none for invalid suffixes", () => {
    seedRecord("record-1-999999");
    seedRecord("record-2-999999");
    assert.equal(store.findByIdSuffix({ owner: OWNER, suffix: "999999" }).items.length, 2);
    assert.equal(store.findByIdSuffix({ owner: OWNER, suffix: "99%99" }).items.length, 0);
  });

  it("selects the newest editable record within the window and skips voided rows", () => {
    seedRecord("record-old", { occurredAt: "2026-08-20T04:00:00.000Z" });
    seedRecord("record-new", { occurredAt: "2026-08-27T04:00:00.000Z" });
    seedRecord("record-newest-voided", { occurredAt: "2026-08-28T00:00:00.000Z" });
    db.prepare("UPDATE quick_records SET voided_at = '2026-08-28T01:00:00.000Z' WHERE id = 'record-newest-voided'").run();
    assert.equal(store.latestEditable({ owner: OWNER }).id, "record-new");
    nowMs = Date.parse("2026-09-10T04:00:00.000Z");
    assert.equal(store.latestEditable({ owner: OWNER }), null, "records older than the window are not editable targets");
  });
});

describe("quickRecordStore.updateFields", () => {
  it("updates occurred-at behind the version guard", () => {
    seedRecord("record-1");
    const result = store.updateFields({
      owner: OWNER,
      id: "record-1",
      expectedVersion: 1,
      occurredAt: "2026-08-27T04:00:00.000Z",
    });
    assert.equal(result.after.occurredAt, "2026-08-27T04:00:00.000Z");
    assert.equal(result.after.version, 2);
    assert.equal(result.before.version, 1);
  });

  it("throws a version conflict carrying the current version", () => {
    seedRecord("record-1");
    assert.throws(
      () => store.updateFields({ owner: OWNER, id: "record-1", expectedVersion: 9, occurredAt: "2026-08-27T04:00:00.000Z" }),
      (error) => error.code === "VERSION_CONFLICT" && error.fields.currentVersion === 1,
    );
  });

  it("rejects a customer/opportunity pair that does not match the database relationship", () => {
    seedCustomer("customer-1", "日照中医医院");
    seedCustomer("customer-2", "莒县人民医院");
    seedOpportunity("opportunity-1", "customer-2", "莒县项目");
    seedRecord("record-1", { opportunityId: "opportunity-1", customerId: "customer-2" });
    assert.throws(
      () => store.updateFields({ owner: OWNER, id: "record-1", expectedVersion: 1, customerId: "customer-1" }),
      (error) => error.code === "QUICK_RECORD_RELATIONSHIP_INVALID",
    );
    assert.throws(
      () => store.updateFields({ owner: OWNER, id: "record-1", expectedVersion: 1, customerId: "customer-missing" }),
      (error) => error.code === "QUICK_RECORD_RELATIONSHIP_INVALID",
    );
  });

  it("links a valid customer and opportunity pair", () => {
    seedCustomer("customer-1", "日照中医医院");
    seedOpportunity("opportunity-1", "customer-1", "日照项目");
    seedRecord("record-1");
    const result = store.updateFields({
      owner: OWNER,
      id: "record-1",
      expectedVersion: 1,
      customerId: "customer-1",
      opportunityId: "opportunity-1",
    });
    assert.equal(result.after.customerId, "customer-1");
    assert.equal(result.after.opportunityId, "opportunity-1");
  });

  it("returns not found for another owner's record", () => {
    seedRecord("record-1", { owner: OTHER_OWNER });
    assert.throws(
      () => store.updateFields({ owner: OWNER, id: "record-1", expectedVersion: 1, occurredAt: null }),
      (error) => error.code === "NOT_FOUND",
    );
  });
});

describe("quickRecordStore.updateInsightSummary", () => {
  it("replicates the PATCH semantics: bumps the record version and rewrites the latest insight in place", () => {
    seedRecord("record-1");
    seedInsight("insight-old", "record-1", undefined, "2026-08-20T04:01:00.000Z");
    seedInsight("insight-new", "record-1", undefined, "2026-08-20T04:05:00.000Z");
    const result = store.updateInsightSummary({
      owner: OWNER,
      id: "record-1",
      expectedVersion: 1,
      summaryPatch: { action: "周三前发对比材料给张主任" },
    });
    assert.equal(result.record.version, 2);
    assert.equal(result.analysis.id, "insight-new");
    assert.equal(result.analysis.summary.action.text, "周三前发对比材料给张主任");
    assert.equal(result.analysis.summary.request.text, "原始诉求");
    assert.equal(result.beforeAnalysis.summary.action.text, "原始建议");
    const oldRow = JSON.parse(db.prepare("SELECT analysis_json FROM ai_insights WHERE id = 'insight-old'").get().analysis_json);
    assert.equal(oldRow.summary.action.text, "原始建议", "older insights stay untouched");
  });

  it("supports the web path without an owner scope", () => {
    seedRecord("record-1");
    seedInsight("insight-1", "record-1");
    const result = store.updateInsightSummary({
      owner: null,
      id: "record-1",
      expectedVersion: 1,
      summaryPatch: { risk: "新的风险描述" },
    });
    assert.equal(result.analysis.summary.risk.text, "新的风险描述");
  });

  it("fails with not found when there is no insight and with data integrity when the summary shape is broken", () => {
    seedRecord("record-no-insight");
    assert.throws(
      () => store.updateInsightSummary({ owner: OWNER, id: "record-no-insight", expectedVersion: 1, summaryPatch: { action: "x" } }),
      (error) => error.code === "NOT_FOUND",
    );
    seedRecord("record-broken");
    db.prepare(`
      INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
      VALUES ('insight-broken', 'record-broken', 'mock', 70, '{"summary":{"action":"just-a-string"}}')
    `).run();
    assert.throws(
      () => store.updateInsightSummary({ owner: OWNER, id: "record-broken", expectedVersion: 1, summaryPatch: { action: "x" } }),
      (error) => error.code === "DATA_INTEGRITY_ERROR",
    );
  });

  it("rejects unknown summary keys and version conflicts", () => {
    seedRecord("record-1");
    seedInsight("insight-1", "record-1");
    assert.throws(
      () => store.updateInsightSummary({ owner: OWNER, id: "record-1", expectedVersion: 1, summaryPatch: { other: "x" } }),
      TypeError,
    );
    assert.throws(
      () => store.updateInsightSummary({ owner: OWNER, id: "record-1", expectedVersion: 5, summaryPatch: { action: "x" } }),
      (error) => error.code === "VERSION_CONFLICT" && error.fields.currentVersion === 1,
    );
  });
});

describe("quickRecordStore.void", () => {
  it("writes the first-ever voided_at columns and hides the record from reads", () => {
    seedRecord("record-1");
    const result = store.void({
      owner: OWNER,
      id: "record-1",
      expectedVersion: 1,
      voidedBy: OWNER,
      reason: "weixin-assistant-void",
    });
    assert.equal(result.after.voidedAt, "2026-08-28T04:00:00.000Z");
    assert.equal(result.after.voidedBy, OWNER);
    assert.equal(result.after.voidReason, "weixin-assistant-void");
    assert.equal(result.after.version, 2);
    assert.equal(store.search({ owner: OWNER }).items.length, 0);
    assert.equal(store.latestEditable({ owner: OWNER }), null);
    assert.equal(store.getWithLatestInsight({ owner: OWNER, id: "record-1" }), null);
  });

  it("conflicts on a repeated void and keeps the first evidence", () => {
    seedRecord("record-1");
    store.void({ owner: OWNER, id: "record-1", expectedVersion: 1, voidedBy: OWNER });
    assert.throws(
      () => store.void({ owner: OWNER, id: "record-1", expectedVersion: 2, voidedBy: OWNER }),
      (error) => error.code === "NOT_FOUND",
    );
  });

  it("guards the version before voiding", () => {
    seedRecord("record-1");
    assert.throws(
      () => store.void({ owner: OWNER, id: "record-1", expectedVersion: 3, voidedBy: OWNER }),
      (error) => error.code === "VERSION_CONFLICT" && error.fields.currentVersion === 1,
    );
  });
});
