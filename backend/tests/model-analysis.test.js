import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuickRecord,
  composeWeeklyDraftWithModel,
  enhanceSolutionDraftWithModel,
  enhanceWeeklyDraftWithModel,
  enhanceItineraryOrderWithModel,
  generateManualSuggestion,
  parseModelAnalysisContent,
} from "../src/modelAnalysis.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function completionRuntime(responseFactory, calls = []) {
  return {
    enabled: () => true,
    configured: () => true,
    createCompletionClient(metadata) {
      const call = { metadata };
      calls.push(call);
      return {
        complete: async (request) => {
          call.request = request;
          return typeof responseFactory === "function"
            ? responseFactory({ metadata, request, call })
            : responseFactory;
        },
      };
    },
  };
}

function modelContent(overrides = {}) {
  return JSON.stringify({
    customer: {
      id: "rizhao",
      value: "日照中医医院",
      meta: "置信度 90%",
      tone: "blue",
    },
    opportunity: {
      id: "op-rizhao-plan",
      value: "日照中医医院十五五规划",
      meta: "置信度 85%",
      tone: "green",
    },
    weekly: {
      value: "周三 / 06-03",
      meta: "本周记录",
      tone: "amber",
    },
    summary: {
      request: { title: "客户诉求", text: "补齐本地数据中心健壮度。" },
      feedback: { title: "客户反馈", text: "移动云资源计费和数据导出存在顾虑。" },
      risk: { title: "风险点", text: "预算路径仍未确认。" },
      action: { title: "建议动作", text: "同步商机并输出规划材料。" },
    },
    ...overrides,
  });
}

function draftContent(content = "# 模型草稿\n\n基于已确认业务事实整理。") {
  return JSON.stringify({ content });
}

function draftFixture(overrides = {}) {
  return {
    title: "销售草稿",
    content: "# 确定性草稿\n\n请人工补充待确认事实。",
    sourceRefs: [{ type: "customer", id: "customer-a" }],
    ...overrides,
  };
}

function modelConfig(overrides = {}) {
  const { aiPlatformRuntime, ...rest } = overrides;
  return {
    aiAnalysisMode: "model",
    modelProvider: "deepseek",
    modelName: "deepseek-v4-flash",
    ...rest,
    aiPlatformRuntime: aiPlatformRuntime ?? completionRuntime(
      () => jsonResponse({ choices: [{ message: { content: draftContent() } }] }),
    ),
  };
}

function modelDraftFetch(content = draftContent()) {
  return async () => jsonResponse({
    choices: [{ message: { content } }],
  });
}

describe("model-backed quick record analysis", () => {
  it("allocates enough completion tokens and disables DeepSeek thinking for bounded extraction", async () => {
    const calls = [];
    await analyzeQuickRecord("Validate the budget owner and decision chain.", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      aiPlatformRuntime: completionRuntime(
        () => jsonResponse({ choices: [{ message: { content: modelContent() } }] }),
        calls,
      ),
    }, {
      fetchImpl: async () => { throw new Error("must not call provider directly"); },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.max_tokens, 3200);
    assert.deepEqual(calls[0].request.thinking, { type: "disabled" });
  });

  it("omits the DeepSeek thinking extension for other providers", async () => {
    const calls = [];
    await analyzeQuickRecord("Validate the budget owner and decision chain.", {
      aiAnalysisMode: "model",
      modelProvider: "openai-compatible",
      modelName: "fixture-model",
      aiPlatformRuntime: completionRuntime(
        () => jsonResponse({ choices: [{ message: { content: modelContent() } }] }),
        calls,
      ),
    }, {
      fetchImpl: async () => { throw new Error("must not call provider directly"); },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.max_tokens, 3200);
    assert.equal(Object.hasOwn(calls[0].request, "thinking"), false);
  });

  it("routes model mode through the AI Platform completion runtime", async () => {
    const calls = [];
    const result = await analyzeQuickRecord("日照中医医院需要十五五规划材料", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      aiPlatformTargetModel: "gpt-5.6-luna",
      aiPlatformRuntime: completionRuntime(
        () => jsonResponse({ choices: [{ message: { content: modelContent() } }] }),
        calls,
      ),
    }, {
      fetchImpl: async () => { throw new Error("must not call provider directly"); },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].metadata.taskType, "quick-record.analyze");
    assert.equal(calls[0].metadata.feature, "quick_record_analysis");
    assert.equal(calls[0].metadata.channel, "web");
    assert.equal(calls[0].metadata.owner, "sentelligent-sales-workbench");
    assert.equal(calls[0].request.model, "gpt-5.6-luna");
    assert.deepEqual(calls[0].request.response_format, { type: "json_object" });
    assert.deepEqual(calls[0].request.thinking, { type: "disabled" });
    assert.equal(calls[0].request.stream, false);
    assert.ok(calls[0].request.messages.some((message) => /json/i.test(message.content)));

    assert.equal(result.source, "deepseek");
    assert.equal(result.customer.id, "rizhao");
    assert.equal(result.opportunity.id, "op-rizhao-plan");
    assert.match(result.summary.risk.text, /预算路径/);
    assert.doesNotMatch(JSON.stringify(result), /secret-model-key/);
  });

  it("falls back to deterministic mock analysis when model mode has no key", async () => {
    let called = false;
    const result = await analyzeQuickRecord("黄岛区中医院下周带售前做双活机房调研", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "",
    }, {
      fetchImpl: async () => {
        called = true;
        throw new Error("should not call provider without key");
      },
    });

    assert.equal(called, false);
    assert.equal(result.source, "mock_missing_model_key");
    assert.equal(result.customer.id, "huangdao-tcm");
  });

  it("injects retrieved knowledge into the prompt and appends server-side knowledge refs", async () => {
    const calls = [];
    const result = await analyzeQuickRecord("日照中医医院需要移动云双活方案", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      aiPlatformRuntime: completionRuntime(
        () => jsonResponse({ choices: [{ message: { content: modelContent() } }] }),
        calls,
      ),
    }, {
      fetchImpl: async () => { throw new Error("must not call provider directly"); },
      knowledgeItems: [
        { id: "kn-mobile-cloud", title: "移动云双活方案要点", summary: "双活机房与计费策略。" },
        { id: "kn-hospital-case", title: "医院行业成功案例", summary: "地市医院上云案例。" },
      ],
    });

    assert.equal(calls.length, 1);
    const body = calls[0].request;
    const systemMessage = body.messages.find((message) => message.role === "system");
    assert.match(systemMessage.content, /知识库条目/);
    assert.match(systemMessage.content, /kn-mobile-cloud/);
    assert.match(systemMessage.content, /移动云双活方案要点/);
    assert.deepEqual(result.knowledgeRefs, [
      { type: "knowledge", id: "kn-mobile-cloud", title: "移动云双活方案要点" },
      { type: "knowledge", id: "kn-hospital-case", title: "医院行业成功案例" },
    ]);
  });

  it("keeps knowledge refs on deterministic mock analysis and omits them without retrieval", async () => {
    let called = false;
    const mockResult = await analyzeQuickRecord("黄岛区中医院下周带售前做双活机房调研", {
      aiAnalysisMode: "mock",
    }, {
      fetchImpl: async () => {
        called = true;
        throw new Error("must not call model in mock mode");
      },
      knowledgeItems: [{ id: "kn-dual-active", title: "双活机房调研清单", summary: "调研问题列表。" }],
    });
    assert.equal(called, false);
    assert.equal(mockResult.source, "mock");
    assert.deepEqual(mockResult.knowledgeRefs, [
      { type: "knowledge", id: "kn-dual-active", title: "双活机房调研清单" },
    ]);

    const plainResult = await analyzeQuickRecord("黄岛区中医院下周带售前做双活机房调研", {
      aiAnalysisMode: "mock",
    }, {});
    assert.equal(Object.hasOwn(plainResult, "knowledgeRefs"), false);
  });

  it("rejects model JSON that is missing the required summary structure", () => {
    const invalid = JSON.parse(modelContent());
    invalid.summary.request = { title: "客户诉求" };

    assert.throws(
      () => parseModelAnalysisContent(JSON.stringify(invalid), "deepseek"),
      /summary\.request\.text/,
    );
  });
});

describe("model-backed itinerary ordering", () => {
  const fallback = {
    orderedStopIds: ["customer-a", "customer-b"],
    summary: "按预约时间和行车时长生成基础顺序。",
    advice: ["出发前确认预约。"],
    source: "deterministic",
  };
  const context = {
    departureAt: "2026-07-28T00:00:00.000Z",
    stops: [
      { id: "customer-a", customerName: "客户甲", priority: "normal", visitMinutes: 45 },
      { id: "customer-b", customerName: "客户乙", priority: "high", visitMinutes: 60 },
    ],
    durationMatrix: [[0, 600, 1200], [600, 0, 900], [1200, 900, 0]],
  };

  it("accepts a complete unique permutation from JSON model output", async () => {
    const calls = [];
    const result = await enhanceItineraryOrderWithModel(fallback, context, {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      aiPlatformRuntime: completionRuntime(
        () => jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            orderedStopIds: ["customer-b", "customer-a"],
            summary: "优先处理重点客户，再沿返程方向拜访客户甲。",
            advice: ["提前确认停车入口", "预留十分钟签到"],
          }) } }],
        }),
        calls,
      ),
    }, {
      fetchImpl: async () => { throw new Error("must not call provider directly"); },
    });

    assert.equal(calls.length, 1);
    const body = calls[0].request;
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(JSON.stringify(body.messages), /customer-a/);
    assert.deepEqual(result, {
      orderedStopIds: ["customer-b", "customer-a"],
      summary: "优先处理重点客户，再沿返程方向拜访客户甲。",
      advice: ["提前确认停车入口", "预留十分钟签到"],
      source: "deepseek",
      fallbackReason: null,
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture/);
  });

  it("falls back when model output is missing, duplicate, or contains an unknown stop ID", async () => {
    const invalidOrders = [
      ["customer-a"],
      ["customer-a", "customer-a"],
      ["customer-a", "unknown"],
    ];
    for (const orderedStopIds of invalidOrders) {
      const result = await enhanceItineraryOrderWithModel(fallback, context, {
        aiAnalysisMode: "model",
        modelProvider: "deepseek",
        modelApiKey: "model-key",
        aiPlatformRuntime: completionRuntime(() => jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            orderedStopIds,
            summary: "无效顺序",
            advice: [],
          }) } }],
        })),
      }, {
        fetchImpl: async () => { throw new Error("must not call provider directly"); },
      });
      assert.equal(result.source, "fallback");
      assert.equal(result.fallbackReason, "itinerary_order_model_failure");
      const { source: _source, fallbackReason: _fallbackReason, ...base } = result;
      const { source: _fallbackSource, ...fallbackBase } = fallback;
      assert.deepEqual(base, fallbackBase);
    }
  });

  it("does not call the model when model mode or credentials are unavailable", async () => {
    let called = false;
    const result = await enhanceItineraryOrderWithModel(fallback, context, {
      aiAnalysisMode: "mock",
      modelApiKey: "",
    }, {
      fetchImpl: async () => {
        called = true;
        throw new Error("must not call model");
      },
    });

    assert.equal(called, false);
    assert.equal(result.source, "deterministic");
    assert.equal(result.fallbackReason, null);
    const { source: _source, fallbackReason: _fallbackReason, ...base } = result;
    const { source: _fallbackSource, ...fallbackBase } = fallback;
    assert.deepEqual(base, fallbackBase);
  });
});

describe("model provenance for drafts and suggestions", () => {
  const weeklyContext = {
    periodStart: "2026-08-17",
    periodEnd: "2026-08-23",
    records: [{
      id: "record-1",
      occurredAt: "2026-08-19T09:00:00+08:00",
      sourceChannel: "manual",
      rawContent: "客户确认下周安排技术交流。",
      analysis: {},
    }],
    knowledge: [],
    sourceRefs: [{ type: "quick_record", id: "record-1" }],
  };
  const solutionContext = {
    owner: "owner-1",
    artifactType: "solution_framework",
    customer: { id: "customer-a", name: "客户甲" },
    opportunity: { id: "opportunity-a", name: "升级项目" },
    actions: [{ title: "确认技术交流时间" }],
    knowledge: [],
  };
  const manualInput = {
    type: "customer_profile",
    title: "客户画像补全建议",
    context: { customer: "客户甲", customerId: "customer-a" },
  };

  it("marks direct weekly enhancement as model-generated on valid output", async () => {
    const calls = [];
    const result = await enhanceWeeklyDraftWithModel(
      draftFixture(),
      weeklyContext,
      modelConfig({
        aiPlatformRuntime: completionRuntime(
          () => jsonResponse({ choices: [{ message: { content: draftContent("# 周报模型正文") } }] }),
          calls,
        ),
      }),
      { fetchImpl: async () => { throw new Error("must not call provider directly"); } },
    );

    assert.equal(result.content, "# 周报模型正文");
    assert.equal(result.source, "deepseek");
    assert.equal(result.fallbackReason, null);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0].request, "thinking"), false);
  });

  it("marks weekly and solution drafts as deterministic when model mode is disabled", async () => {
    const weekly = await enhanceWeeklyDraftWithModel(
      draftFixture(),
      weeklyContext,
      { aiAnalysisMode: "mock", modelApiKey: "" },
      { fetchImpl: async () => { throw new Error("must not call model"); } },
    );
    const solution = await enhanceSolutionDraftWithModel(
      draftFixture(),
      solutionContext,
      { aiAnalysisMode: "mock", modelApiKey: "" },
      { fetchImpl: async () => { throw new Error("must not call model"); } },
    );

    for (const result of [weekly, solution]) {
      assert.equal(result.source, "deterministic");
      assert.equal(result.fallbackReason, null);
      assert.equal(result.content, draftFixture().content);
    }
  });

  it("distinguishes a missing model key for weekly, solution, and manual suggestions", async () => {
    const config = { aiAnalysisMode: "model", modelProvider: "deepseek", modelApiKey: "" };
    const fetchImpl = async () => { throw new Error("must not call model without a key"); };
    const weekly = await enhanceWeeklyDraftWithModel(draftFixture(), weeklyContext, config, { fetchImpl });
    const composed = await composeWeeklyDraftWithModel(draftFixture(), weeklyContext, config, { fetchImpl });
    const solution = await enhanceSolutionDraftWithModel(draftFixture(), solutionContext, config, { fetchImpl });
    const suggestion = await generateManualSuggestion(manualInput, config, { fetchImpl });

    assert.deepEqual(
      [weekly, composed, solution, suggestion].map(({ source, fallbackReason }) => ({ source, fallbackReason })),
      [
        { source: "fallback", fallbackReason: "weekly_draft_missing_model_key" },
        { source: "fallback", fallbackReason: "weekly_draft_missing_model_key" },
        { source: "fallback", fallbackReason: "solution_draft_missing_model_key" },
        { source: "fallback", fallbackReason: "manual_suggestion_missing_model_key" },
      ],
    );
  });

  it("keeps the disabled solution Agent off the model path even when a platform is available", async () => {
    const calls = [];
    const result = await enhanceSolutionDraftWithModel(
      draftFixture(),
      solutionContext,
      modelConfig({
        aiPlatformRuntime: completionRuntime(
          () => jsonResponse({ choices: [{ message: { content: draftContent("must not be used") } }] }),
          calls,
        ),
      }),
      { fetchImpl: async () => { throw new Error("must not call legacy provider"); } },
    );

    assert.equal(calls.length, 0);
    assert.equal(result.source, "fallback");
    assert.equal(result.fallbackReason, "solution_draft_agent_disabled");
    assert.equal(result.content, draftFixture().content);
  });

  it("keeps the legacy weekly failure reason for an otherwise unclassified provider error", async () => {
    const result = await enhanceWeeklyDraftWithModel(
      draftFixture(),
      weeklyContext,
      modelConfig({
        aiPlatformRuntime: completionRuntime(() => {
          throw new Error("provider unavailable");
        }),
      }),
      { fetchImpl: async () => { throw new Error("must not call provider directly"); } },
    );

    assert.equal(result.source, "fallback");
    assert.equal(result.fallbackReason, "weekly_draft_model_failure");
    assert.equal(result.content, draftFixture().content);
  });

  it("attributes invalid JSON, timeout, and network failures without exposing provider errors", async () => {
    const invalidJson = await enhanceWeeklyDraftWithModel(
      draftFixture(),
      weeklyContext,
      modelConfig({
        aiPlatformRuntime: completionRuntime(() => jsonResponse({
          choices: [{ message: { content: "{not-json" } }],
        })),
      }),
    );
    const timeoutError = Object.assign(new Error("upstream deadline exceeded"), { name: "TimeoutError" });
    const timeout = await generateManualSuggestion(
      manualInput,
      modelConfig({
        aiPlatformRuntime: completionRuntime(() => { throw timeoutError; }),
      }),
    );
    const network = await enhanceWeeklyDraftWithModel(
      draftFixture(),
      weeklyContext,
      modelConfig({
        aiPlatformRuntime: completionRuntime(() => {
          throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
        }),
      }),
    );

    assert.equal(invalidJson.source, "fallback");
    assert.equal(invalidJson.fallbackReason, "weekly_draft_invalid_json");
    assert.equal(timeout.source, "fallback");
    assert.equal(timeout.fallbackReason, "manual_suggestion_timeout");
    assert.equal(network.source, "fallback");
    assert.equal(network.fallbackReason, "weekly_draft_network_error");
    assert.doesNotMatch(JSON.stringify({ invalidJson, timeout, network }), /deadline|ECONNRESET|fetch failed/);
  });

  it("marks a valid-but-constrained-invalid itinerary response as a model fallback", async () => {
    const fallback = {
      orderedStopIds: ["customer-a", "customer-b"],
      summary: "按预约时间和行车时长生成基础顺序。",
      advice: ["出发前确认预约。"],
      source: "deterministic",
    };
    const context = {
      stops: [{ id: "customer-a" }, { id: "customer-b" }],
    };
    const result = await enhanceItineraryOrderWithModel(
      fallback,
      context,
      modelConfig({
        aiPlatformRuntime: completionRuntime(() => jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            orderedStopIds: ["customer-a", "customer-a"],
            summary: "重复停靠点",
            advice: [],
          }) } }],
        })),
      }),
      {
        fetchImpl: async () => { throw new Error("must not call provider directly"); },
      },
    );

    assert.equal(result.source, "fallback");
    assert.equal(result.fallbackReason, "itinerary_order_model_failure");
    assert.deepEqual(result.orderedStopIds, fallback.orderedStopIds);
  });
});
