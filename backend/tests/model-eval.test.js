import assert from "node:assert/strict";
import test from "node:test";

import { EVAL_CASES, evaluateAnalyzer, scoreAnalysis } from "../scripts/model-eval.mjs";

function validAnalysis(overrides = {}) {
  return {
    source: "deterministic",
    confidence: 70,
    customer: { id: "rizhao", value: "日照中医医院" },
    opportunity: { id: "op-rizhao-plan", value: "日照中医医院十五五规划" },
    summary: {
      request: { title: "诉求", text: "补齐方案。" },
      feedback: { title: "反馈", text: "需要材料。" },
      risk: { title: "风险", text: "预算待确认。" },
      action: { title: "动作", text: "安排沟通。" },
    },
    ...overrides,
  };
}

test("scores schema, entity accuracy, source, and fallback reason without retaining content", () => {
  const score = scoreAnalysis(validAnalysis({ source: "fallback", fallbackReason: "weekly_draft_timeout" }), EVAL_CASES[0]);
  assert.deepEqual(score, {
    validJson: true,
    schemaValid: true,
    customerMatches: true,
    opportunityMatches: true,
    source: "fallback",
    fallbackReason: "weekly_draft_timeout",
  });
  assert.equal(Object.hasOwn(score, "rawContent"), false);
});

test("evaluates a fixed corpus and returns aggregate metrics only", async () => {
  const metrics = await evaluateAnalyzer(async (_rawContent, testCase) => {
    if (testCase.id === "generic-clarification") {
      return validAnalysis({
        customer: { id: null, value: "待匹配客户" },
        opportunity: { id: null, value: "待确认商机" },
        source: "fallback",
        fallbackReason: "model_timeout",
      });
    }
    if (testCase.id === "huangdao-dual-active") {
      return validAnalysis({
        customer: { id: "huangdao-tcm", value: "黄岛区中医院" },
        opportunity: { id: "op-huangdao-tcm", value: "黄岛区中医院双活机房建设" },
      });
    }
    return validAnalysis();
  });

  assert.equal(metrics.total, 3);
  assert.equal(metrics.validJson, 3);
  assert.equal(metrics.schemaValid, 3);
  assert.equal(metrics.customerMatches, 3);
  assert.equal(metrics.opportunityMatches, 3);
  assert.equal(metrics.fallbackCount, 1);
  assert.deepEqual(metrics.sourceCounts, { deterministic: 2, fallback: 1 });
  assert.deepEqual(metrics.fallbackReasons, { model_timeout: 1 });
  assert.equal(metrics.cases.length, EVAL_CASES.length);
  assert.equal(Object.hasOwn(metrics, "rawContent"), false);
});
