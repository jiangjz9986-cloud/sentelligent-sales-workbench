import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createVisitTemperatureSuggestionGenerator,
  evidenceRuleSuggestion,
} from "../src/assistant/visitTemperatureGenerator.js";

const FACTS = [
  {
    key: "current_relation",
    label: "当前客户温度",
    value: 50,
    confidence: 100,
    sourceRefs: [{ type: "customer", id: "customer-a" }],
  },
  {
    key: "customer_feedback",
    label: "客户反馈",
    value: "客户认可试点范围，愿意安排下一次技术交流。",
    confidence: 90,
    sourceRefs: [{ type: "quick_record", id: "visit-a" }],
  },
];

function snapshot(facts = FACTS) {
  return {
    visit: { id: "visit-a", version: 3 },
    customer: { id: "customer-a", version: 2, relation: 50 },
    facts,
  };
}

function modelResponse(value) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
  };
}

describe("visit temperature suggestion generator", () => {
  it("makes only a small positive adjustment from positive evidence", () => {
    const result = evidenceRuleSuggestion(snapshot());
    assert.equal(result.suggestedValue, 58);
    assert.equal(result.confidence, 66);
    assert.deepEqual(result.inferences[0].basisKeys, ["customer_feedback"]);
  });

  it("makes only a small negative adjustment from negative evidence", () => {
    const result = evidenceRuleSuggestion(snapshot([
      FACTS[0],
      { ...FACTS[1], value: "客户暂缓推进，预算不足，存在竞品风险。" },
    ]));
    assert.equal(result.suggestedValue, 42);
    assert.deepEqual(result.inferences[0].basisKeys, ["customer_feedback"]);
  });

  it("keeps an ambiguous visit unchanged instead of inventing movement", () => {
    const result = evidenceRuleSuggestion(snapshot([
      FACTS[0],
      { ...FACTS[1], value: "双方交换了资料，后续再联系。" },
    ]));
    assert.equal(result.suggestedValue, 50);
    assert.equal(result.inferences[0].basisKeys[0], "current_relation");
  });

  it("uses the existing model boundary when a model is configured", async () => {
    let requestBody;
    const generator = createVisitTemperatureSuggestionGenerator({
      config: {
        aiAnalysisMode: "model",
        modelApiKey: "test-key",
        modelBaseUrl: "https://model.example.test",
        modelName: "test-model",
      },
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return modelResponse({
          suggestedValue: 58,
          confidence: 82,
          inferences: [{
            claim: "客户明确愿意安排下一次交流",
            confidence: 82,
            basisKeys: ["customer_feedback"],
          }],
        });
      },
    });
    const result = await generator(snapshot());
    assert.equal(result.suggestedValue, 58);
    assert.equal(result.confidence, 82);
    assert.equal(requestBody.model, "test-model");
    assert.match(requestBody.messages[1].content, /customer_feedback/u);
    assert.match(requestBody.messages[1].content, /客户认可试点范围/u, "model receives bounded evidence value rather than an unbounded record");
  });

  it("falls back on no credentials, provider failure, malformed, and out-of-range model output", async () => {
    let calls = 0;
    const fallback = createVisitTemperatureSuggestionGenerator({
      config: { aiAnalysisMode: "model", modelApiKey: "" },
      fetchImpl: async () => { calls += 1; return modelResponse({}); },
    });
    assert.equal((await fallback(snapshot())).suggestedValue, 58);
    assert.equal(calls, 0);

    const failing = createVisitTemperatureSuggestionGenerator({
      config: { aiAnalysisMode: "model", modelApiKey: "test-key" },
      fetchImpl: async () => { throw new Error("provider failure"); },
    });
    assert.equal((await failing(snapshot())).suggestedValue, 58);

    const invalid = createVisitTemperatureSuggestionGenerator({
      config: { aiAnalysisMode: "model", modelApiKey: "test-key" },
      fetchImpl: async () => modelResponse({
        suggestedValue: 101,
        confidence: 99,
        inferences: [{ claim: "bad", confidence: 99, basisKeys: ["customer_feedback"] }],
      }),
    });
    assert.equal((await invalid(snapshot())).suggestedValue, 58);

    const jump = createVisitTemperatureSuggestionGenerator({
      config: { aiAnalysisMode: "model", modelApiKey: "test-key" },
      fetchImpl: async () => modelResponse({
        suggestedValue: 90,
        confidence: 99,
        inferences: [{ claim: "合法范围但跳变过大", confidence: 99, basisKeys: ["customer_feedback"] }],
      }),
    });
    assert.equal((await jump(snapshot())).suggestedValue, 58);
  });

  it("clamps small rule changes at the relation boundaries", () => {
    assert.equal(evidenceRuleSuggestion(snapshot()).suggestedValue, 58);
    const high = snapshot([
      { ...FACTS[0], value: 98 },
      FACTS[1],
    ]);
    high.customer.relation = 98;
    assert.equal(evidenceRuleSuggestion(high).suggestedValue, 100);
    const low = snapshot([
      { ...FACTS[0], value: 2 },
      { ...FACTS[1], value: "客户拒绝推进，预算不足。" },
    ]);
    low.customer.relation = 2;
    assert.equal(evidenceRuleSuggestion(low).suggestedValue, 0);
  });
});
