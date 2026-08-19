import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createVisitCaptureAssistantAdapter } from "../src/assistant/visitCaptureAssistantAdapter.js";

function modelResponse(overrides = {}) {
  return {
    customer: { id: "forged-customer", value: "示例医院", meta: "置信度 95%", tone: "blue" },
    opportunity: { id: "forged-opportunity", value: "数据中心升级", meta: "置信度 90%", tone: "green" },
    weekly: { value: "周三", meta: "记录时间待确认", tone: "amber" },
    summary: {
      request: { title: "客户诉求", text: "希望确认升级范围。" },
      feedback: { title: "客户反馈", text: "对实施窗口存在顾虑。" },
      risk: { title: "风险点", text: "预算路径未确认。" },
      action: { title: "建议动作", text: "安排下一次方案沟通。" },
    },
    ...overrides,
  };
}

function jsonModel(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

function ownerScopedSnapshot() {
  return {
    customerDetail({ owner, customerId }) {
      if (owner !== "owner-1" || customerId !== "customer-1") return null;
      return { id: "customer-1", name: "示例医院", region: "青岛" };
    },
    opportunityDetail({ owner, opportunityId }) {
      if (owner !== "owner-1" || opportunityId !== "opportunity-1") return null;
      return { id: "opportunity-1", customerId: "customer-1", name: "数据中心升级", stage: "发现" };
    },
    customerSearch({ owner, query }) {
      if (owner !== "owner-1" || !query.includes("示例医院")) return { items: [] };
      return { items: [{ id: "customer-1", name: "示例医院", region: "青岛" }] };
    },
    opportunitySearch({ owner, query }) {
      if (owner !== "owner-1" || !query.includes("数据中心升级")) return { items: [] };
      return { items: [{ id: "opportunity-1", customerId: "customer-1", name: "数据中心升级" }] };
    },
  };
}

describe("visit-capture assistant adapter", () => {
  it("normalizes model output, validates candidates through the owner-scoped snapshot, and records a preview run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "visit-run-1" });
    let calls = 0;
    const adapter = createVisitCaptureAssistantAdapter({
      config: { aiAnalysisMode: "model", modelProvider: "deepseek", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => {
        calls += 1;
        return jsonModel(modelResponse());
      },
      runRepository: runs,
      businessSnapshotAdapter: ownerScopedSnapshot(),
    });

    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "preview",
      rawContent: "拜访示例医院，讨论数据中心升级。",
      occurredAt: "2026-08-20T09:00:00+08:00",
      sourceChannel: "桌面端",
      draftId: "draft-1",
      businessContext: { customerId: "customer-1", opportunityId: "opportunity-1", owner: "forged-owner" },
    });

    assert.equal(calls, 1);
    assert.equal(result.status, "preview");
    assert.equal(result.agentId, "visit-capture");
    assert.equal(result.customerCandidate.id, "customer-1");
    assert.equal(result.customerCandidate.status, "context_verified");
    assert.equal(result.opportunityCandidate.id, "opportunity-1");
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.deepEqual(result.writebackPreview.actions, []);
    assert.ok(result.sourceRefs.some((item) => item.type === "customer" && item.id === "customer-1"));
    assert.equal(result.sourceRefs.some((item) => item.id === "forged-customer"), false);
    assert.equal(result.sourceRefs.some((item) => item.id === "forged-opportunity"), false);

    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "model");
    assert.equal(stored.confirmationStatus, "preview");
    assert.equal(stored.input.owner, undefined);
    assert.equal(stored.input.context.owner, undefined);
    db.close();
  });

  it("uses a bounded deterministic fallback and does not grant an unverified link", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "visit-run-fallback" });
    const adapter = createVisitCaptureAssistantAdapter({
      config: { aiAnalysisMode: "model", modelProvider: "deepseek", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => jsonModel({ invalid: true }),
      runRepository: runs,
      businessSnapshotAdapter: ownerScopedSnapshot(),
    });

    const result = await adapter.analyze({
      owner: "owner-1",
      eventId: "event-fallback",
      rawContent: "电话沟通，客户名称和商机都没有确认。",
      taskType: "normalize",
    });

    assert.equal(result.status, "fallback");
    assert.equal(result.persistedSource, "fallback");
    assert.equal(result.customerCandidate.id, null);
    assert.equal(result.opportunityCandidate.id, null);
    assert.equal(result.customer.id, null);
    assert.equal(result.opportunity.id, null);
    assert.ok(result.unknowns.some((item) => item.key === "customer"));
    assert.ok(result.unknowns.some((item) => item.key === "opportunity"));
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "fallback");
    assert.equal(stored.fallbackReason, "mock_model_fallback");
    db.close();
  });

  it("marks ambiguous owner-scoped matches for review and never trusts model IDs", async () => {
    const adapter = createVisitCaptureAssistantAdapter({
      config: { aiAnalysisMode: "mock" },
      businessSnapshotAdapter: {
        customerDetail: () => null,
        opportunityDetail: () => null,
        customerSearch: () => ({ items: [
          { id: "customer-a", name: "同名医院" },
          { id: "customer-b", name: "同名医院" },
        ] }),
        opportunitySearch: () => ({ items: [] }),
      },
    });

    const result = await adapter.analyze({
      owner: "owner-1",
      rawContent: "拜访同名医院，讨论项目。",
      taskType: "link_candidates",
    });
    assert.equal(result.status, "review_required");
    assert.equal(result.customerCandidate.status, "ambiguous");
    assert.equal(result.customerCandidate.id, null);
    assert.ok(result.unknowns.some((item) => item.key === "customer"));
  });

  it("replays a persisted event without calling the model again", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, {
      idFactory: (() => {
        let count = 0;
        return () => `visit-run-${++count}`;
      })(),
    });
    let calls = 0;
    const adapter = createVisitCaptureAssistantAdapter({
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => {
        calls += 1;
        return jsonModel(modelResponse());
      },
      runRepository: runs,
      businessSnapshotAdapter: ownerScopedSnapshot(),
    });
    const input = {
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-replay",
      eventId: "event-replay",
      rawContent: "拜访示例医院。",
    };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.deepEqual(replay.sourceRefs, first.sourceRefs);
    db.close();
  });
});
