import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDeterministicSalesDecision } from "../src/ai/agents/salesDecisionAgent.js";
import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createSalesDecisionAssistantAdapter } from "../src/assistant/salesDecisionAssistantAdapter.js";

function fixture(overrides = {}) {
  return {
    customer: {
      id: "customer-1",
      name: "示例医院",
      type: "医院",
      summary: "正在评估基础设施升级。",
      needs: ["提升稳定性"],
      stakeholders: [],
    },
    opportunity: {
      id: "opportunity-1",
      customerId: "customer-1",
      name: "数据中心升级项目",
      stage: "初步发现",
      amount: "1200000",
      requirements: ["总体规划"],
      next: "安排技术交流",
    },
    quickRecord: {
      id: "record-1",
      rawContent: "客户确认现有平台存在稳定性问题，希望了解升级路径。",
      occurredAt: "2026-08-19T10:00:00+08:00",
      sourceChannel: "拜访",
    },
    actions: [{ id: "action-1", title: "补充技术资料", status: "pending" }],
    risks: [{ id: "risk-1", title: "决策链未知", severity: "high", status: "open" }],
    knowledge: [{ id: "knowledge-1", title: "医院采购流程", summary: "需要核对采购路径。" }],
    sourceRefs: [{ type: "opportunity", id: "opportunity-1" }],
    ...overrides,
  };
}

function modelResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

describe("小小 sales-decision assistant adapter", () => {
  it("calls the existing sales-decision-v1 agent and persists a preview run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-run-1" });
    let called = false;
    const context = {
      analysisType: "opportunity_diagnosis",
      industry: "medical",
      ...fixture(),
    };
    const expected = buildDeterministicSalesDecision({
      ...context,
      customer: context.customer,
      opportunity: context.opportunity,
    });
    const adapter = createSalesDecisionAssistantAdapter({
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async (_url, options) => {
        called = true;
        assert.match(options.headers.Authorization, /^Bearer /);
        return modelResponse(expected);
      },
      runRepository: runs,
    });

    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      analysisType: "opportunity_diagnosis",
      industry: "medical",
      analysisAt: "2026-08-20T09:00:00+08:00",
      businessSnapshot: fixture(),
    });
    assert.equal(called, true);
    assert.equal(result.status, "preview");
    assert.equal(result.agentId, "sales-decision");
    assert.equal(result.contractVersion, "sales-decision-v1");
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.analysis.writebackPreview.requiresHumanConfirmation, true);
    assert.ok(result.sourceRefs.some((item) => item.id === "opportunity-1"));
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "model");
    assert.equal(stored.confirmationStatus, "preview");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("uses the deterministic fallback on model failure and records the reason", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-run-fallback" });
    const adapter = createSalesDecisionAssistantAdapter({
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => modelResponse({ invalid: true }),
      runRepository: runs,
    });
    const result = await adapter.analyze({
      owner: "owner-1",
      eventId: "event-fallback",
      businessSnapshot: fixture(),
    });
    assert.equal(result.status, "preview");
    assert.equal(result.source, "mock_model_fallback");
    assert.equal(result.analysis.compliance.requiresEscalation, false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "fallback");
    assert.equal(stored.fallbackReason, "mock_model_fallback");
    db.close();
  });

  it("rejects missing or cross-linked evidence before calling the model", async () => {
    let called = false;
    const adapter = createSalesDecisionAssistantAdapter({
      config: { aiAnalysisMode: "model", modelApiKey: "fixture" },
      fetchImpl: async () => {
        called = true;
        return modelResponse({});
      },
    });
    await assert.rejects(
      () => adapter.analyze({
        owner: "owner-1",
        businessSnapshot: { customer: fixture().customer },
      }),
      /opportunity evidence/i,
    );
    await assert.rejects(
      () => adapter.analyze({
        owner: "owner-1",
        businessSnapshot: fixture({
          opportunity: { ...fixture().opportunity, customerId: "other-customer" },
        }),
      }),
      /relationship/i,
    );
    assert.equal(called, false);
  });

  it("does not persist caller-controlled owner or secret fields", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-run-safe" });
    const adapter = createSalesDecisionAssistantAdapter({
      config: { aiAnalysisMode: "mock" },
      runRepository: runs,
    });
    const result = await adapter.analyze({
      owner: "server-owner",
      eventId: "event-safe",
      businessSnapshot: {
        ...fixture(),
        owner: "forged-owner",
        token: "must-not-enter",
      },
    });
    const stored = runs.get(result.runId, { owner: "server-owner" }).item;
    assert.equal(stored.input.owner, undefined);
    assert.equal(stored.input.token, undefined);
    assert.equal(stored.owner, "server-owner");
    db.close();
  });

  it("drops model-invented source references instead of presenting them as evidence", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "sales-run-source-safe" });
    const adapter = createSalesDecisionAssistantAdapter({
      config: { aiAnalysisMode: "model", modelApiKey: "fixture", modelBaseUrl: "https://example.invalid" },
      fetchImpl: async () => {
        const analysis = buildDeterministicSalesDecision({
          analysisType: "opportunity_diagnosis",
          industry: "medical",
          ...fixture(),
        });
        analysis.facts = [
          ...analysis.facts,
          { claim: "模型虚构事实", sourceType: "opportunity", sourceId: "forged-opportunity", occurredAt: null, confidence: 90 },
        ];
        return modelResponse(analysis);
      },
      runRepository: runs,
    });
    const result = await adapter.analyze({ owner: "owner-1", eventId: "event-source-safe", businessSnapshot: fixture() });
    assert.equal(result.sourceRefs.some((item) => item.id === "forged-opportunity"), false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.sourceRefs.some((item) => item.id === "forged-opportunity"), false);
    db.close();
  });
});
