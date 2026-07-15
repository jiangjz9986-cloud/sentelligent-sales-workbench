import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function read(filePath) {
  return readFileSync(resolve(filePath), "utf8");
}

function extractNavIds(source) {
  const block = source.match(/export const navItems = \[([\s\S]*?)\];/)?.[1] ?? "";
  return [...block.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function extractVisualPageNames(source) {
  const block = source.match(/const pages = \[([\s\S]*?)\];/)?.[1] ?? "";
  return [...block.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("business module delivery coverage", () => {
  it("renders a page branch for every sidebar module", () => {
    const navIds = extractNavIds(read("src/data/salesWorkbenchData.js"));
    const appSource = read("src/App.jsx");
    const missingBranches = navIds.filter((id) => !appSource.includes(`active === "${id}"`));

    assert.deepEqual(missingBranches, []);
  });

  it("keeps every sidebar module inside browser visual-rhythm QA", () => {
    const navIds = extractNavIds(read("src/data/salesWorkbenchData.js"));
    const visualPages = extractVisualPageNames(read("scripts/visual-rhythm.test.mjs"));
    const missingVisualCoverage = navIds.filter((id) => !visualPages.includes(id));

    assert.deepEqual(missingVisualCoverage, []);
  });

  it("keeps AI-backed modules represented in API and integration coverage", () => {
    const apiSource = read("src/api/salesWorkbenchApi.js");
    const apiTestSource = read("src/api/salesWorkbenchApi.test.js");
    const integrationSource = read("scripts/integration-qa.mjs");
    const requiredApiMethods = [
      "createQuickRecord",
      "analyzeQuickRecord",
      "confirmQuickRecord",
      "saveCustomer",
      "deleteCustomer",
      "saveOpportunity",
      "deleteOpportunity",
      "updateActionStatus",
      "deleteAction",
      "updateRiskStatus",
      "deleteRisk",
      "saveKnowledgeItem",
      "deleteKnowledgeItem",
      "searchKnowledge",
      "generateWeeklyDraft",
      "saveWeeklyReport",
      "generateSolutionDraft",
      "saveSolutionDraft",
      "generateAiSuggestion",
    ];

    const missingApiClient = requiredApiMethods.filter((method) => !apiSource.includes(`${method}(`));
    const missingApiTests = requiredApiMethods.filter((method) => !apiTestSource.includes(method));
    const missingIntegration = [
      "quick record",
      "customer",
      "opportunity",
      "action",
      "risk",
      "knowledge",
      "weekly",
      "solution",
      "kanban",
    ].filter((keyword) => !integrationSource.toLowerCase().includes(keyword));

    assert.deepEqual({ missingApiClient, missingApiTests, missingIntegration }, {
      missingApiClient: [],
      missingApiTests: [],
      missingIntegration: [],
    });
  });

  it("keeps solution assistant deliverables and actions wired in the page", () => {
    const pageSource = read("src/features/salesWorkbench/pages.jsx");
    const apiSource = read("src/api/salesWorkbenchApi.js");
    const requiredArtifactTypes = [
      "communication_outline",
      "presales_questions",
      "solution_framework",
      "report_outline",
      "competitive_talk",
    ];
    const requiredLabels = [
      "沟通提纲",
      "售前问题清单",
      "方案框架",
      "汇报材料大纲",
      "竞品应对话术",
      "生成交付物",
      "重新生成",
      "保存草稿",
      "来源与引用",
    ];

    assert.deepEqual(requiredArtifactTypes.filter((type) => !pageSource.includes(type)), []);
    assert.deepEqual(requiredLabels.filter((label) => !pageSource.includes(label)), []);
    assert.match(apiSource, /artifactType/);
  });
});
