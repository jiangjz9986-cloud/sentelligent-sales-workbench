import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createOpportunityAssistantAdapter } from "../src/assistant/opportunityAssistantAdapter.js";

function opportunity(id, customerId, overrides = {}) {
  return {
    id,
    customerId,
    name: `${id} 升级项目`,
    stage: "方案",
    amount: "120 万",
    probability: 65,
    days: 12,
    risk: "预算待确认",
    next: "安排技术交流",
    updatedAt: "2026-08-20T01:00:00Z",
    ...overrides,
  };
}

function snapshotAdapter() {
  return {
    customerDetail({ owner, customerId }) {
      if (owner !== "owner-1") return null;
      if (customerId === "customer-1") return { id: "customer-1", name: "示例医院" };
      if (customerId === "customer-2") return { id: "customer-2", name: "第二医院" };
      return null;
    },
    opportunityDetail({ owner, opportunityId }) {
      if (owner !== "owner-1") return null;
      if (opportunityId === "opportunity-1") return opportunity("opportunity-1", "customer-1");
      if (opportunityId === "opportunity-invalid") return opportunity("opportunity-invalid", "customer-hidden");
      return null;
    },
    opportunitySearch({ owner, query }) {
      if (owner !== "owner-1") return { items: [], truncated: false };
      if (query === "同名项目") return {
        items: [
          opportunity("opportunity-a", "customer-1", { name: "同名项目" }),
          opportunity("opportunity-b", "customer-2", { name: "同名项目" }),
        ],
        truncated: false,
      };
      if (query === "关系异常") return {
        items: [opportunity("opportunity-invalid", "customer-hidden")],
        truncated: false,
      };
      if (query.includes("示例")) return {
        items: [opportunity("opportunity-1", "customer-1")],
        truncated: false,
      };
      return { items: [], truncated: false };
    },
  };
}

describe("opportunity assistant adapter", () => {
  it("returns relationship-validated read-only facts and a durable opportunity-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "opportunity-run-1" });
    const adapter = createOpportunityAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "detail",
      opportunityId: "opportunity-1",
    });
    assert.equal(result.schemaVersion, "opportunity-v1");
    assert.equal(result.agentId, "opportunity");
    assert.equal(result.status, "ok");
    assert.equal(result.opportunity.customer, "示例医院");
    assert.deepEqual(result.relationship, { valid: true, customerId: "customer-1", reason: null });
    assert.ok(result.facts.some((item) => item.key === "stage" && item.value === "方案"));
    assert.ok(result.facts.some((item) => item.key === "amount" && item.value === "120 万"));
    assert.ok(result.facts.some((item) => item.key === "probability" && item.value === 65));
    assert.deepEqual(result.inferences, []);
    assert.equal(result.salesDecisionAdvice, null);
    assert.equal(result.writebackAllowed, false);
    assert.deepEqual(result.sourceRefs, [
      { type: "customer", id: "customer-1" },
      { type: "opportunity", id: "opportunity-1" },
    ]);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.contractVersion, "opportunity-v1");
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "deterministic");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("clarifies multiple relationship-valid matches without selecting one", async () => {
    const adapter = createOpportunityAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "search", query: "同名项目" });
    assert.equal(result.status, "clarify");
    assert.equal(result.opportunity, null);
    assert.equal(result.matches.length, 2);
    assert.ok(result.unknowns.some((item) => item.key === "ambiguity"));
    assert.deepEqual(result.sourceRefs, [
      { type: "customer", id: "customer-1" },
      { type: "opportunity", id: "opportunity-a" },
      { type: "customer", id: "customer-2" },
      { type: "opportunity", id: "opportunity-b" },
    ]);
  });

  it("fails closed when the opportunity customer relationship is not owner-visible", async () => {
    const adapter = createOpportunityAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "detail",
      opportunityId: "opportunity-invalid",
      query: "关系异常",
    });
    assert.equal(result.status, "review_required");
    assert.equal(result.opportunity, null);
    assert.deepEqual(result.relationship, {
      valid: false,
      customerId: null,
      reason: "商机与当前账号可见客户的关系无法验证。",
    });
    assert.deepEqual(result.facts, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.ok(result.unknowns.some((item) => item.key === "relationship"));
  });

  it("previews only non-protected text fields and never writes stage, amount, probability, or version", async () => {
    const adapter = createOpportunityAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      opportunityId: "opportunity-1",
      changes: {
        risk: "预算路径已补充",
        next: "等待本人确认后安排交流",
        stage: "成交",
        amount: "999 万",
        probability: 99,
        version: 999,
        customerId: "customer-2",
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["risk", "next"]);
    assert.deepEqual(result.changePreview.before, {
      risk: "预算待确认",
      next: "安排技术交流",
    });
    assert.deepEqual(result.changePreview.after, {
      risk: "预算路径已补充",
      next: "等待本人确认后安排交流",
    });
    assert.deepEqual(result.changePreview.rejectedFields, ["stage", "amount", "probability", "version", "customerId"]);
    assert.equal(result.changePreview.expectedVersion, null);
    assert.equal(result.writebackPreview.allowed, false);
    assert.equal(result.writebackAllowed, false);
  });

  it("reports the current stage without generating sales-decision advice", async () => {
    const adapter = createOpportunityAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "stage_review",
      opportunityId: "opportunity-1",
    });
    assert.equal(result.stageReview.currentStage, "方案");
    assert.equal(result.stageReview.nextStage, null);
    assert.equal(result.stageReview.recommendation, null);
    assert.equal(result.stageReview.requiresSalesDecisionAgent, true);
    assert.equal(result.salesDecisionAdvice, null);
  });

  it("replays the same event without re-reading the opportunity or its customer", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "opportunity-run-replay" });
    const source = snapshotAdapter();
    let opportunityReads = 0;
    let customerReads = 0;
    const adapter = createOpportunityAssistantAdapter({
      snapshotAdapter: {
        ...source,
        opportunityDetail(input) {
          opportunityReads += 1;
          return source.opportunityDetail(input);
        },
        customerDetail(input) {
          customerReads += 1;
          return source.customerDetail(input);
        },
      },
      runRepository: runs,
    });
    const input = {
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-replay",
      eventId: "event-replay",
      taskType: "detail",
      opportunityId: "opportunity-1",
    };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(opportunityReads, 1);
    assert.equal(customerReads, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
