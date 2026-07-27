import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSalesWorkbenchApi } from "./salesWorkbenchApi.js";

function decisionItem(overrides = {}) {
  return {
    id: "decision-1",
    version: 1,
    analysisType: "opportunity_diagnosis",
    industry: "medical",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    quickRecordId: null,
    input: { opportunityId: "op-rizhao-plan" },
    analysis: {
      schemaVersion: "sales-decision-v1",
      analysisType: "opportunity_diagnosis",
      headline: "需要继续验证",
      decision: {
        code: "validate",
        confidence: 68,
        reason: "预算待确认",
        counterEvidence: [],
        evidenceNeededToChange: ["确认预算"],
      },
      stage: {
        current: "initial_discovery",
        recommended: "initial_discovery",
        gatePassed: false,
        missingGateEvidence: ["预算"],
      },
      score: {
        total: 48,
        dimensions: [{ name: "pain_and_impact", score: 11, max: 20, reason: "问题已记录" }],
      },
      facts: [],
      inferences: [],
      unknowns: [{ question: "预算是什么", impact: "影响采购判断", priority: "high" }],
      stakeholders: [],
      risks: [],
      nextActions: [],
      suggestedQuestions: ["预算是什么"],
      writebackPreview: {
        requiresHumanConfirmation: true,
        customerFields: [],
        opportunityFields: [],
        actions: [],
        risks: [],
      },
      compliance: { status: "clear", flags: [], requiresEscalation: false },
      source: "mock",
    },
    source: "mock",
    createdBy: "jiangjz",
    createdAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

describe("sales decision API client", () => {
  it("loads filtered history, creates a diagnosis, and reads one immutable item", async () => {
    const calls = [];
    const item = decisionItem();
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url.includes("/api/ai/sales-decisions?") && !options.method) return jsonResponse({ items: [item] });
        if (url.endsWith("/api/ai/sales-decisions") && options.method === "POST") return jsonResponse({ item });
        if (url.endsWith("/api/ai/sales-decisions/decision-1")) return jsonResponse({ item });
        return jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
      },
    });

    const history = await api.listSalesDecisionAnalyses({ opportunityId: "op-rizhao-plan" });
    const created = await api.createSalesDecisionAnalysis({
      opportunityId: "op-rizhao-plan",
      analysisType: "opportunity_diagnosis",
      industry: "medical",
    });
    const loaded = await api.getSalesDecisionAnalysis("decision-1");

    assert.equal(history.items[0].id, "decision-1");
    assert.equal(created.id, "decision-1");
    assert.equal(loaded.id, "decision-1");
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/ai/sales-decisions?opportunityId=op-rizhao-plan");
    assert.deepEqual(calls[1].body, {
      opportunityId: "op-rizhao-plan",
      analysisType: "opportunity_diagnosis",
      industry: "medical",
    });
  });
});
