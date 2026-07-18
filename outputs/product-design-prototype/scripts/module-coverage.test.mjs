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

function extractNavBlock(source) {
  return source.match(/export const navItems = \[([\s\S]*?)\];/)?.[1] ?? "";
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

  it("keeps the deferred solution assistant out of responsive primary navigation", () => {
    const dataSource = read("src/data/salesWorkbenchData.js");
    const appSource = read("src/App.jsx");
    const navBlock = extractNavBlock(dataSource);

    assert.doesNotMatch(navBlock, /\bid:\s*"solution"|方案辅助/);
    assert.match(appSource, /<aside className="sidebar">[\s\S]*\{navItems\.map/);
    assert.doesNotMatch(appSource, /setActive\("solution"\)/);
  });

  it("keeps the historical solution compatibility state read-only", () => {
    const pageSource = read("src/features/salesWorkbench/pages.jsx");
    const appSource = read("src/App.jsx");
    const solutionPageSource = pageSource.match(
      /export function SolutionPage\([\s\S]*?(?=\nexport function WeeklyPage)/,
    )?.[0] ?? "";

    assert.match(appSource, /active === "solution"/);
    assert.match(solutionPageSource, /data-testid="solution-history-view"/);
    assert.match(solutionPageSource, /solutionDocs\.map/);
    assert.match(solutionPageSource, /selected\?\.content/);
    assert.doesNotMatch(
      solutionPageSource,
      /generateSolutionDraft|saveSolutionDraft|<textarea|生成交付物|重新生成|保存草稿/,
    );
    assert.doesNotMatch(pageSource, /引用到方案/);
  });
});
