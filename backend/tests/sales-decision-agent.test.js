import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDeterministicSalesDecision,
  buildSalesDecisionMessages,
  analyzeSalesDecision,
  resolveSalesDecisionModelTimeoutMs,
} from "../src/ai/agents/salesDecisionAgent.js";
import {
  normalizeSalesDecisionAnalysis,
} from "../src/ai/agents/salesDecisionSchema.js";

function baseContext(overrides = {}) {
  return {
    analysisType: "opportunity_diagnosis",
    industry: "medical",
    customer: {
      id: "customer-1",
      name: "示例医院",
      budget: null,
      stakeholders: [],
      decisionChain: [],
      summary: "正在评估数据中心基础设施升级。",
      needs: ["提升基础设施稳定性"],
      risks: [],
    },
    opportunity: {
      id: "opportunity-1",
      customerId: "customer-1",
      name: "数据中心升级项目",
      stage: "初步发现",
      amount: null,
      requirements: ["需要提交总体规划"],
      competitors: [],
      solutionDirection: [],
      risk: null,
      next: null,
    },
    quickRecord: {
      id: "record-1",
      rawContent: "客户确认现有平台存在稳定性问题，已经影响业务连续性，希望了解升级路径。",
      occurredAt: "2026-07-27T10:00:00+08:00",
      sourceChannel: "拜访",
    },
    actions: [],
    risks: [],
    knowledge: [],
    ...overrides,
  };
}

function modelResponse(analysis) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    }),
  };
}

function overconfidentModelAnalysis(context) {
  const analysis = buildDeterministicSalesDecision(context);
  return {
    ...analysis,
    decision: {
      ...analysis.decision,
      code: "advance",
      confidence: 95,
      reason: "模型认为可以直接推进。",
    },
    stage: {
      ...analysis.stage,
      recommended: "decision_commitment",
      gatePassed: true,
      missingGateEvidence: [],
    },
    score: {
      total: 100,
      dimensions: analysis.score.dimensions.map((item) => ({ ...item, score: item.max })),
    },
    unknowns: [],
    compliance: { status: "clear", flags: [], requiresEscalation: false },
  };
}

describe("sales decision agent v1", () => {
  it("reserves two minutes for long-tail structured model responses", () => {
    assert.equal(resolveSalesDecisionModelTimeoutMs({}), 120_000);
    assert.equal(resolveSalesDecisionModelTimeoutMs({ modelTimeoutMs: 60_000 }), 120_000);
    assert.equal(resolveSalesDecisionModelTimeoutMs({ modelTimeoutMs: 180_000 }), 180_000);
  });

  it("keeps facts, inferences, and unknowns separate and caps an under-evidenced opportunity", () => {
    const result = buildDeterministicSalesDecision(baseContext());

    assert.equal(result.schemaVersion, "sales-decision-v1");
    assert.equal(result.decision.code, "validate");
    assert.ok(result.score.total < 65);
    assert.ok(result.facts.length > 0);
    assert.ok(result.inferences.length > 0);
    assert.ok(result.unknowns.some((item) => /预算|经济决策者/.test(item.question)));
    assert.equal(result.stage.gatePassed, false);
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.deepEqual(result.writebackPreview.actions, []);
  });

  it("keeps budget approval as an explicit unknown when the economic buyer is known", () => {
    const context = baseContext();
    context.customer = {
      ...context.customer,
      stakeholders: [{
        name: "分管院长",
        title: "副院长",
        role: "economic_buyer",
        stance: "neutral",
        influence: "high",
        confidence: 80,
        evidence: "客户确认其负责预算审批。",
      }],
    };

    const result = buildDeterministicSalesDecision(context);

    assert.equal(result.unknowns.some((item) => /经济决策者/.test(item.question)), false);
    assert.equal(result.unknowns.some((item) => /预算由哪个部门/.test(item.question)), true);
    assert.equal(result.stage.gatePassed, false);
  });

  it("escalates compliance signals instead of suggesting sales tactics", () => {
    const result = buildDeterministicSalesDecision(baseContext({
      quickRecord: {
        id: "record-compliance",
        rawContent: "客户暗示可以通过回扣和陪标安排来影响采购结果。",
        occurredAt: "2026-07-27T11:00:00+08:00",
        sourceChannel: "电话",
      },
    }));

    assert.equal(result.decision.code, "escalate_review");
    assert.equal(result.compliance.status, "review_required");
    assert.equal(result.compliance.requiresEscalation, true);
    assert.ok(result.compliance.flags.length > 0);
    assert.ok(result.nextActions.some((item) => /合规|法务|管理/.test(item.action)));
  });

  it("normalizes a valid structured model response and rejects incomplete contracts", () => {
    const valid = buildDeterministicSalesDecision(baseContext());
    const normalized = normalizeSalesDecisionAnalysis(valid, { source: "deepseek" });
    const flagged = normalizeSalesDecisionAnalysis({
      ...valid,
      compliance: {
        status: "clear",
        flags: ["疑似不当利益安排"],
        requiresEscalation: false,
      },
    });

    assert.equal(normalized.source, "deepseek");
    assert.equal(normalized.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(flagged.compliance.status, "review_required");
    assert.equal(flagged.compliance.requiresEscalation, true);
    assert.throws(
      () => normalizeSalesDecisionAnalysis({ ...valid, decision: null }),
      /decision/,
    );
  });

  it("includes the selected playbook and structured contract in model messages", () => {
    const [system, user] = buildSalesDecisionMessages(baseContext());

    assert.equal(system.role, "system");
    assert.match(system.content, /事实|推断|假设|未知/);
    assert.match(system.content, /MEDDPICC|阶段门槛/);
    assert.match(system.content, /sales-decision-v1/);
    assert.match(system.content, /数组中的对象仅为字段模板/);
    assert.match(system.content, /"sourceId":null/);
    assert.match(system.content, /"max":20/);
    assert.match(system.content, /"completionEvidence"/);
    assert.equal(user.role, "user");
    assert.match(user.content, /数据中心升级项目/);
  });

  it("allocates enough completion tokens for a reasoning-capable structured response", async () => {
    const context = baseContext();
    let requestBody;

    await analyzeSalesDecision(
      context,
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      {
        fetchImpl: async (_url, options) => {
          requestBody = JSON.parse(options.body);
          return modelResponse(overconfidentModelAnalysis(context));
        },
      },
    );

    assert.equal(requestBody.max_tokens, 6400);
  });

  it("falls back safely when the configured model returns invalid JSON", async () => {
    const result = await analyzeSalesDecision(
      baseContext(),
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { content: "not-json" } }],
          }),
        }),
      },
    );

    assert.equal(result.source, "mock_model_fallback");
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
  });

  it("drops malformed optional writeback preview entries without discarding valid model analysis", async () => {
    const context = baseContext();
    const modelAnalysis = overconfidentModelAnalysis(context);
    modelAnalysis.writebackPreview = {
      requiresHumanConfirmation: false,
      customerFields: [{ field: "level", value: "S" }, "", " summary "],
      opportunityFields: [null, "stage"],
      actions: [{ action: "confirm budget" }],
      risks: [42, "budget owner is unknown"],
    };

    const result = await analyzeSalesDecision(
      context,
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      { fetchImpl: async () => modelResponse(modelAnalysis) },
    );

    assert.equal(result.source, "deepseek");
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.deepEqual(result.writebackPreview.customerFields, ["summary"]);
    assert.deepEqual(result.writebackPreview.opportunityFields, ["stage"]);
    assert.deepEqual(result.writebackPreview.actions, []);
    assert.deepEqual(result.writebackPreview.risks, ["budget owner is unknown"]);
  });

  it("normalizes model business stages without discarding valid analysis", async () => {
    const context = baseContext();
    const modelAnalysis = overconfidentModelAnalysis(context);
    modelAnalysis.stage.current = "qualification";
    modelAnalysis.stage.recommended = "proposal";

    const result = await analyzeSalesDecision(
      context,
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      { fetchImpl: async () => modelResponse(modelAnalysis) },
    );

    assert.equal(result.source, "deepseek");
    const currentStage = buildDeterministicSalesDecision(context).stage.current;
    assert.equal(result.stage.current, currentStage);
    assert.equal(result.stage.recommended, currentStage);
  });

  it("applies evidence caps and restores critical unknowns to a valid but overconfident model response", async () => {
    const context = baseContext();
    const overconfident = overconfidentModelAnalysis(context);
    overconfident.stakeholders = [{
      name: "模型虚构联系人",
      title: "院长",
      role: "economic_buyer",
      stance: "supportive",
      influence: "high",
      confidence: 90,
      evidence: "没有上下文证据。",
    }];
    const result = await analyzeSalesDecision(
      context,
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      { fetchImpl: async () => modelResponse(overconfident) },
    );

    assert.ok(result.score.total <= 64);
    assert.notEqual(result.decision.code, "advance");
    assert.equal(result.stage.gatePassed, false);
    assert.notEqual(result.stage.recommended, "decision_commitment");
    assert.ok(result.unknowns.some((item) => /经济决策者/.test(item.question)));
    assert.ok(result.unknowns.some((item) => /预算由哪个部门/.test(item.question)));
    assert.deepEqual(result.stakeholders, []);
  });

  it("forces compliance escalation when source evidence conflicts with a valid model response", async () => {
    const context = baseContext({
      quickRecord: {
        id: "record-compliance-model",
        rawContent: "客户提出可以通过回扣影响采购结果。",
        occurredAt: "2026-07-27T11:00:00+08:00",
        sourceChannel: "电话",
      },
    });
    const result = await analyzeSalesDecision(
      context,
      {
        aiAnalysisMode: "model",
        modelApiKey: "fixture",
        modelBaseUrl: "https://example.invalid",
        modelName: "deepseek-v4-flash",
      },
      { fetchImpl: async () => modelResponse(overconfidentModelAnalysis(context)) },
    );

    assert.equal(result.decision.code, "escalate_review");
    assert.ok(result.score.total <= 44);
    assert.equal(result.stage.gatePassed, false);
    assert.equal(result.compliance.status, "review_required");
    assert.equal(result.compliance.requiresEscalation, true);
    assert.ok(result.compliance.flags.length > 0);
  });
});
