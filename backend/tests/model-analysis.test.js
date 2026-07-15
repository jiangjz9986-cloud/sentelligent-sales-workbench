import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuickRecord,
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
