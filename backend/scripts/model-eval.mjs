#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { analyzeQuickRecord } from "../src/modelAnalysis.js";

// The corpus is intentionally small, stable, and free of customer secrets.
// Every model/account/configuration comparison must run this exact input set.
export const EVAL_CASES = Object.freeze([
  Object.freeze({
    id: "rizhao-planning",
    rawContent: "日照中医医院需要十五五规划材料，移动云灾备和预算路径需要进入本周汇报。",
    expectedCustomerId: "rizhao",
    expectedOpportunityId: "op-rizhao-plan",
  }),
  Object.freeze({
    id: "huangdao-dual-active",
    rawContent: "黄岛区中医院下周带售前做双活机房调研并输出整体规划。",
    expectedCustomerId: "huangdao-tcm",
    expectedOpportunityId: "op-huangdao-tcm",
  }),
  Object.freeze({
    id: "generic-clarification",
    rawContent: "客户希望补充方案和预算信息，下一步需要确认关键人和时间窗口。",
    expectedCustomerId: null,
    expectedOpportunityId: null,
  }),
]);

const REQUIRED_SUMMARY_FIELDS = ["request", "feedback", "risk", "action"];

function validSummary(summary) {
  return summary && typeof summary === "object" && !Array.isArray(summary)
    && REQUIRED_SUMMARY_FIELDS.every((key) => {
      const item = summary[key];
      return item && typeof item === "object"
        && typeof item.title === "string" && item.title.trim()
        && typeof item.text === "string" && item.text.trim();
    });
}

export function scoreAnalysis(result, testCase) {
  const validJson = result && typeof result === "object" && !Array.isArray(result);
  const schemaValid = validJson
    && typeof result.source === "string"
    && Number.isFinite(Number(result.confidence))
    && result.customer && typeof result.customer === "object"
    && typeof result.customer.value === "string"
    && result.opportunity && typeof result.opportunity === "object"
    && typeof result.opportunity.value === "string"
    && validSummary(result.summary);
  const customerMatches = schemaValid && (result.customer.id ?? null) === testCase.expectedCustomerId;
  const opportunityMatches = schemaValid && (result.opportunity.id ?? null) === testCase.expectedOpportunityId;
  return {
    validJson,
    schemaValid,
    customerMatches,
    opportunityMatches,
    source: typeof result?.source === "string" ? result.source : "error",
    fallbackReason: result?.fallbackReason ?? null,
  };
}

export async function evaluateAnalyzer(analyzer, cases = EVAL_CASES) {
  if (typeof analyzer !== "function") throw new TypeError("analyzer must be a function");
  if (!Array.isArray(cases) || cases.length < 1) throw new TypeError("cases must be a non-empty array");

  const caseResults = [];
  for (const testCase of cases) {
    const started = performance.now();
    try {
      const result = await analyzer(testCase.rawContent, testCase);
      const score = scoreAnalysis(result, testCase);
      caseResults.push({
        id: testCase.id,
        ...score,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      });
    } catch {
      caseResults.push({
        id: testCase.id,
        validJson: false,
        schemaValid: false,
        customerMatches: false,
        opportunityMatches: false,
        source: "error",
        fallbackReason: null,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      });
    }
  }

  const sourceCounts = {};
  const fallbackReasons = {};
  for (const result of caseResults) {
    sourceCounts[result.source] = (sourceCounts[result.source] ?? 0) + 1;
    if (result.fallbackReason) fallbackReasons[result.fallbackReason] = (fallbackReasons[result.fallbackReason] ?? 0) + 1;
  }
  const latencyTotal = caseResults.reduce((sum, result) => sum + result.latencyMs, 0);
  return {
    total: caseResults.length,
    validJson: caseResults.filter((result) => result.validJson).length,
    schemaValid: caseResults.filter((result) => result.schemaValid).length,
    customerMatches: caseResults.filter((result) => result.customerMatches).length,
    opportunityMatches: caseResults.filter((result) => result.opportunityMatches).length,
    fallbackCount: caseResults.filter((result) => result.source === "fallback").length,
    sourceCounts,
    fallbackReasons,
    averageLatencyMs: Math.round((latencyTotal / caseResults.length) * 100) / 100,
    cases: caseResults,
  };
}

function envConfig(mode) {
  if (mode !== "model") return { aiAnalysisMode: "mock" };
  return {
    aiAnalysisMode: "model",
    modelProvider: process.env.MODEL_PROVIDER || "deepseek",
    modelApiKey: process.env.MODEL_API_KEY || "",
    modelBaseUrl: process.env.MODEL_BASE_URL || "https://api.deepseek.com",
    modelName: process.env.MODEL_NAME || "deepseek-v4-flash",
    modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 30_000),
  };
}

async function main() {
  const mode = process.env.EVAL_MODE || "deterministic";
  const label = process.env.EVAL_LABEL || mode;
  const config = envConfig(mode);
  if (mode === "model" && !config.modelApiKey) {
    console.log(JSON.stringify({ status: "not_run", label, reason: "model_key_missing", total: EVAL_CASES.length }));
    process.exitCode = 2;
    return;
  }

  const metrics = await evaluateAnalyzer((rawContent) => analyzeQuickRecord(rawContent, config), EVAL_CASES);
  console.log(JSON.stringify({
    status: "complete",
    label,
    mode,
    ...metrics,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
