import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantToolHandlers } from "../src/assistant/runtimeHandlers.js";
import { createOpportunity } from "../src/opportunities/opportunityStore.js";

const OWNER = "assistant-owner";

const context = Object.freeze({
  owner: OWNER,
  channel: "weixin",
  conversation: "conversation-opp-1",
  event: "event-opp-1",
  requestId: "request-opp-1",
});

const directServerData = Object.freeze({ auditMetadata: { chatType: "direct" } });

let db;
let previewCalls;
let previewImpl;

function buildHandlers(overrides = {}) {
  return createAssistantToolHandlers({
    db,
    sessionRepository: {
      getOrCreate: () => ({ id: "conversation-opp-1" }),
      listDraftParts: () => [],
      clearDraftParts: () => {},
    },
    resolveBusinessOwner: (owner) => (owner === OWNER ? OWNER : null),
    config: { opportunityStageReviewBudgetMs: 120 },
    salesLoopPreviewService: {
      previewSalesDecision: (input) => {
        previewCalls.push(input);
        return previewImpl(input);
      },
    },
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ databaseUrl: ":memory:" });
  previewCalls = [];
  previewImpl = async () => ({
    status: "preview",
    analysis: {
      decision: { code: "advance_with_conditions", confidence: 62 },
      stage: { gatePassed: false, missingGateEvidence: ["客户确认评估标准", "关键技术角色参与"] },
      score: { total: 58 },
      nextActions: [{ action: "请现有联系人邀请信息科负责人参加下次方案讨论" }],
    },
  });
  db.exec(`
    INSERT INTO customers (id, name, region, owner) VALUES
      ('customer-1', '日照中医医院', '日照', '${OWNER}');
  `);
  createOpportunity(db, {
    customerId: "customer-1",
    name: "十五五规划",
    customer: "日照中医医院",
    stage: "方案输出",
    amount: "规划类",
    next: "补齐规划材料",
    owner: OWNER,
  }, { id: "opp-write-abc001" });
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

function opportunityRow(id) {
  return db.prepare("SELECT * FROM opportunities WHERE id = $id").get({ $id: id });
}

describe("opportunity write runtime handlers", () => {
  it("moves the stage forward, audits stageReview=triggered atomically, and attaches the review block", async () => {
    const handlers = buildHandlers();
    const result = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001",
      expectedVersion: 1,
      stage: "方案交流",
    }, { ...context, actionId: "action-stage-1" });

    assert.equal(result.status, "updated");
    assert.equal(result.stageReview, "attached");
    assert.match(result.text, /【商机阶段已更新】/u);
    assert.match(result.text, /阶段：方案输出 → 方案交流/u);
    assert.match(result.text, /阶段升级检查（销售决策 agent）/u);
    assert.match(result.text, /advance_with_conditions（置信度 62）/u);
    assert.match(result.text, /未满足（缺：客户确认评估标准、关键技术角色参与）/u);
    assert.match(result.text, /评分：58/u);
    assert.equal(opportunityRow("opp-write-abc001").stage, "方案交流");
    assert.equal(opportunityRow("opp-write-abc001").version, 2);

    assert.equal(previewCalls.length, 1);
    assert.equal(previewCalls[0].opportunityId, "opp-write-abc001");
    assert.equal(previewCalls[0].analysisType, "opportunity_diagnosis");
    assert.equal(previewCalls[0].eventId, "assistant-action:action-stage-1:stage-review");

    const audits = auditRows("opportunity.update");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].metadata.changedFields, ["stage"]);
    assert.equal(audits[0].metadata.stageReview, "triggered");
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    assert.equal(audits[0].metadata.actionId, "action-stage-1");
    assert.equal(result.contextUpdate.opportunityId, "opp-write-abc001");
    assert.equal(result.contextUpdate.customerId, "customer-1");
  });

  it("commits the stage write even when the review exceeds the budget and reports the timeout", async () => {
    previewImpl = () => new Promise(() => {});
    const handlers = buildHandlers();
    const result = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001",
      expectedVersion: 1,
      stage: "方案交流",
    }, { ...context, actionId: "action-stage-timeout" });
    assert.equal(result.status, "updated");
    assert.equal(result.stageReview, "timeout");
    assert.match(result.text, /决策分析未在时限内完成，发送「项目分析 十五五规划」可查看完整分析。/u);
    assert.equal(opportunityRow("opp-write-abc001").stage, "方案交流", "business write survives the timeout");
    assert.equal(auditRows("opportunity.update")[0].metadata.stageReview, "triggered");
  });

  it("reports failed when the review service rejects or returns a non-preview result", async () => {
    previewImpl = async () => ({ status: "not_found" });
    const handlers = buildHandlers();
    const nonPreview = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 1, stage: "方案交流",
    }, { ...context, actionId: "action-stage-nonpreview" });
    assert.equal(nonPreview.stageReview, "failed");
    assert.match(nonPreview.text, /决策分析未在时限内完成/u);

    previewImpl = async () => { throw new Error("boom"); };
    const thrown = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 2, stage: "预算确认",
    }, { ...context, actionId: "action-stage-throw" });
    assert.equal(thrown.stageReview, "failed");
    assert.equal(opportunityRow("opp-write-abc001").stage, "预算确认");
  });

  it("skips the review for backward, unknown, and pause targets without calling the service", async () => {
    const handlers = buildHandlers();
    const backward = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 1, stage: "调研机会",
    }, { ...context, actionId: "action-stage-back" });
    assert.equal(backward.stageReview, "skipped_backward");
    assert.match(backward.text, /如需分析可发送「项目分析 十五五规划」。/u);

    const unknown = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 2, stage: "投标",
    }, { ...context, actionId: "action-stage-unknown" });
    assert.equal(unknown.stageReview, "skipped_unknown_stage");
    assert.equal(opportunityRow("opp-write-abc001").stage, "投标");

    db.prepare("UPDATE opportunities SET stage = '预算确认' WHERE id = 'opp-write-abc001'").run();
    const pause = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 3, stage: "暂停观察",
    }, { ...context, actionId: "action-stage-pause" });
    assert.equal(pause.stageReview, "skipped_pause");

    assert.equal(previewCalls.length, 0, "no review call for skipped directions");
    // created_at has second granularity, so same-second audit rows have no
    // stable order; compare as a multiset.
    const reviews = auditRows("opportunity.update").map((row) => row.metadata.stageReview).sort();
    assert.deepEqual(reviews, ["skipped_backward", "skipped_pause", "skipped_unknown_stage"]);
  });

  it("returns the friendly conflict text on a stale version without writing", async () => {
    const handlers = buildHandlers();
    const result = await handlers["opportunity.update-stage"]({
      opportunityId: "opp-write-abc001", expectedVersion: 9, stage: "方案交流",
    }, { ...context, actionId: "action-stage-conflict" });
    assert.equal(result.status, "conflict");
    assert.match(result.text, /商机资料刚在其他端被修改，本次未写入/u);
    assert.equal(opportunityRow("opp-write-abc001").stage, "方案输出");
    assert.equal(previewCalls.length, 0);
    assert.equal(auditRows("opportunity.update").length, 0);
  });

  it("updates the next step with a before→after receipt and no review linkage", async () => {
    const handlers = buildHandlers();
    const result = await handlers["opportunity.update-next"]({
      opportunityId: "opp-write-abc001",
      expectedVersion: 1,
      next: "下周带售前调研",
    }, { ...context, actionId: "action-next-1" });
    assert.equal(result.status, "updated");
    assert.match(result.text, /【商机下一步已更新】/u);
    assert.match(result.text, /补齐规划材料 → 下周带售前调研/u);
    assert.equal(opportunityRow("opp-write-abc001").next, "下周带售前调研");
    const audits = auditRows("opportunity.update");
    assert.deepEqual(audits[0].metadata.changedFields, ["next"]);
    assert.equal(Object.hasOwn(audits[0].metadata, "stageReview"), false);
    assert.equal(previewCalls.length, 0);
  });

  it("updates amount/name/risk through the R2 tool and ignores out-of-scope keys defensively", async () => {
    const handlers = buildHandlers();
    const result = await handlers["opportunity.update"]({
      opportunityId: "opp-write-abc001",
      expectedVersion: 1,
      changes: { amount: "5000 万", stage: "越权阶段", probability: 99 },
    }, { ...context, actionId: "action-update-1" });
    assert.equal(result.status, "updated");
    assert.match(result.text, /【商机已更新】/u);
    assert.match(result.text, /金额：规划类 → 5000 万/u);
    const row = opportunityRow("opp-write-abc001");
    assert.equal(row.amount, "5000 万");
    assert.equal(row.stage, "方案输出", "stage is not writable through opportunity.update");
    assert.equal(row.probability, 0);
    assert.deepEqual(auditRows("opportunity.update")[0].metadata.changedFields, ["amount"]);
  });

  it("creates with the pending action id as the durable key and replays without duplicates", async () => {
    const handlers = buildHandlers();
    const args = { name: "AI 算力项目", customerId: "customer-1", stage: "线索", amount: "500 万" };
    const first = await handlers["opportunity.create"](args, { ...context, actionId: "action-create-1" });
    assert.equal(first.status, "created");
    assert.match(first.text, /【商机已建档】/u);
    assert.match(first.text, /发送「商机详情 AI 算力项目」可查看。/u);
    const row = opportunityRow("action-create-1");
    assert.equal(row.owner, OWNER);
    assert.equal(row.customer, "日照中医医院");
    assert.equal(row.stage, "线索");
    const replay = await handlers["opportunity.create"](args, {
      ...context,
      event: "event-opp-replay",
      requestId: "request-opp-replay",
      actionId: "action-create-1",
    });
    assert.equal(replay.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count, 2);
    assert.equal(auditRows("opportunity.create").length, 1);
    assert.equal(auditRows("opportunity.create")[0].metadata.source, "weixin-assistant");
    assert.equal(first.contextUpdate.opportunityId, "action-create-1");
    assert.equal(first.contextUpdate.customerId, "customer-1");
  });

  it("refuses to create when the pinned customer is no longer visible", async () => {
    db.prepare("UPDATE customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'customer-1'").run();
    const handlers = buildHandlers();
    const result = await handlers["opportunity.create"]({
      name: "孤儿商机", customerId: "customer-1",
    }, { ...context, actionId: "action-create-orphan" });
    assert.equal(result.status, "not_found");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count, 1);
  });

  it("soft-deletes with the store audit and clears only the opportunity context", async () => {
    const handlers = buildHandlers();
    const result = await handlers["opportunity.delete"]({
      opportunityId: "opp-write-abc001",
      expectedVersion: 1,
    }, { ...context, actionId: "action-delete-1" });
    assert.equal(result.status, "deleted");
    assert.match(result.text, /【商机已删除（归档）】/u);
    assert.match(result.text, /如需恢复请联系管理员/u);
    assert.ok(opportunityRow("opp-write-abc001").deleted_at);
    const audits = auditRows("opportunity.delete");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].metadata.source, "weixin-assistant");
    assert.equal(audits[0].metadata.actionId, "action-delete-1");
    assert.equal(result.contextUpdate.opportunityId, null);
    assert.equal(result.contextUpdate.customerId, "customer-1", "the customer pin survives the delete");
  });

  it("denies every write for an unbound machine owner before touching the database", async () => {
    const handlers = buildHandlers();
    const foreign = { ...context, owner: "someone-else", actionId: "action-denied" };
    for (const [tool, args] of [
      ["opportunity.update-stage", { opportunityId: "opp-write-abc001", expectedVersion: 1, stage: "方案交流" }],
      ["opportunity.update-next", { opportunityId: "opp-write-abc001", expectedVersion: 1, next: "X" }],
      ["opportunity.update", { opportunityId: "opp-write-abc001", expectedVersion: 1, changes: { amount: "1 万" } }],
      ["opportunity.create", { name: "越权商机", customerId: "customer-1" }],
      ["opportunity.delete", { opportunityId: "opp-write-abc001", expectedVersion: 1 }],
    ]) {
      const result = await handlers[tool](args, foreign);
      assert.equal(result.status, "denied", tool);
    }
    assert.equal(opportunityRow("opp-write-abc001").version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opportunities").get().count, 1);
  });

  it("lists by query and by owner scope, pins context only on a unique hit, and rejects group chats", async () => {
    createOpportunity(db, {
      customerId: "customer-1", name: "双活机房建设", customer: "日照中医医院", stage: "调研机会", amount: "3000 万", owner: OWNER,
    }, { id: "opp-list-def002" });
    const handlers = buildHandlers();

    const all = await handlers["opportunity.list"]({}, context, directServerData);
    assert.equal(all.status, "ok");
    assert.match(all.text, /【商机列表】/u);
    assert.match(all.text, /十五五规划/u);
    assert.match(all.text, /双活机房建设/u);
    assert.match(all.text, /abc001/u);
    assert.equal(all.contextUpdate, undefined, "no pin for a multi-item list");

    const scoped = await handlers["opportunity.list"]({ query: "十五五" }, context, directServerData);
    assert.match(scoped.text, /【十五五 的商机】/u);
    assert.match(scoped.text, /方案输出 ｜ 规划类/u);
    assert.equal(scoped.contextUpdate.opportunityId, "opp-write-abc001");

    const missing = await handlers["opportunity.list"]({ query: "不存在" }, context, directServerData);
    assert.equal(missing.status, "not_found");

    const grouped = await handlers["opportunity.list"]({}, context, { auditMetadata: { chatType: "group" } });
    assert.equal(grouped.status, "denied");
  });
});
