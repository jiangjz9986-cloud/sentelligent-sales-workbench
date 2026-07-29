import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuickRecord,
  enhanceItineraryOrderWithModel,
  parseModelAnalysisContent,
} from "../src/modelAnalysis.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
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

describe("model-backed quick record analysis", () => {
  it("allocates enough completion tokens for reasoning-capable model output", async () => {
    let requestBody;
    await analyzeQuickRecord("Validate the budget owner and decision chain.", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "fixture",
      modelName: "deepseek-v4-flash",
    }, {
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return jsonResponse({
          choices: [{ message: { content: modelContent() } }],
        });
      },
    });

    assert.equal(requestBody.max_tokens, 3200);
  });

  it("calls an OpenAI-compatible JSON chat completion endpoint for model mode", async () => {
    const calls = [];
    const result = await analyzeQuickRecord("日照中医医院需要十五五规划材料", {
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "secret-model-key",
      modelBaseUrl: "https://api.deepseek.com/",
      modelName: "deepseek-v4-flash",
    }, {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          choices: [
            {
              message: {
                content: modelContent(),
              },
            },
          ],
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].options.headers.Authorization, "Bearer secret-model-key");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, false);
    assert.ok(body.messages.some((message) => /json/i.test(message.content)));

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
      modelApiKey: "fixture",
      modelBaseUrl: "https://api.deepseek.com/",
      modelName: "deepseek-v4-flash",
      modelTimeoutMs: 5000,
    }, {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            orderedStopIds: ["customer-b", "customer-a"],
            summary: "优先处理重点客户，再沿返程方向拜访客户甲。",
            advice: ["提前确认停车入口", "预留十分钟签到"],
          }) } }],
        });
      },
    });

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(JSON.stringify(body.messages), /customer-a/);
    assert.deepEqual(result, {
      orderedStopIds: ["customer-b", "customer-a"],
      summary: "优先处理重点客户，再沿返程方向拜访客户甲。",
      advice: ["提前确认停车入口", "预留十分钟签到"],
      source: "deepseek",
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
      }, {
        fetchImpl: async () => jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            orderedStopIds,
            summary: "无效顺序",
            advice: [],
          }) } }],
        }),
      });
      assert.deepEqual(result, fallback);
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
    assert.deepEqual(result, fallback);
  });
});
