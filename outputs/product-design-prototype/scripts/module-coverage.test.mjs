import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readSalesWorkbenchPagesSource } from "./pages-source.mjs";
import { readAppSource } from "./app-source.mjs";

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

function extractSubnavIds(source, parent) {
  const block = source.match(new RegExp(`${parent}:\\s*\\[([\\s\\S]*?)\\](?:,|\\n\\})`))?.[1] ?? "";
  return [...block.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function extractVisualPageNames(source) {
  const block = source.match(/const pages = \[([\s\S]*?)\];/)?.[1] ?? "";
  return [...block.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("business module delivery coverage", () => {
  it("groups the workbench into nine top-level modules with the approved customer, opportunity, and settings children", () => {
    const dataSource = read("src/data/salesWorkbenchData.js");
    assert.deepEqual(
      extractNavIds(dataSource),
      ["overview", "quick", "customer", "opportunity", "itinerary", "expense", "weekly", "knowledge", "settings"],
    );
    assert.deepEqual(
      Object.fromEntries(["customer", "opportunity", "settings"].map((parent) => [parent, extractSubnavIds(dataSource, parent)])),
      {
        customer: ["customer", "hospital-tenders"],
        opportunity: ["opportunity", "risk", "actions", "kanban"],
        // v0.9.1 认证层：settings 组新增 admin 专属"用户管理"子页。
        settings: ["settings", "settings-users", "weixin", "settings-notifications", "settings-tender-schedule", "settings-bookkeeping-log"],
      },
    );
  });

  it("wires grouped subnavigation to entity context rather than only restyling the sidebar", () => {
    const shellSource = read("src/app/SalesWorkbenchShell.jsx");
    const navSource = readAppSource();
    const subnavSource = read("src/components/ModuleSubnav.jsx");

    assert.match(shellSource, /<ModuleSubnav/);
    assert.match(shellSource, /customerId=\{tenderCustomerId\}/);
    assert.match(shellSource, /item\.opportunityId === scopedOpportunityId/);
    assert.match(navSource, /setSelectedOpportunityId\(route\.entityId\)/);
    assert.match(navSource, /route\.filters\?\.opportunityId/);
    assert.match(navSource, /addEventListener\("popstate"/);
    assert.match(subnavSource, /aria-current=\{isActive \? "page" : undefined\}/);
    assert.match(subnavSource, /module-subnav-item/);
    assert.match(subnavSource, /onClearContext/);
  });

  it("re-fetches the dashboard summary whenever the overview becomes active", () => {
    const dataSource = read("src/app/useWorkbenchData.jsx");

    // v0.8.3 deep-test finding: itinerary/travel-expense writes do not pass
    // through refreshOverviewSummary, so the overview must refresh on entry
    // for the today-focus and weekly-trend cards to reflect them.
    assert.match(dataSource, /if \(active !== "overview" \|\| !apiClient\.isEnabled \|\| backendStatus !== "connected"\) return undefined;/);
    assert.match(dataSource, /\.getDashboardSummary\(\)\s*\n\s*\.then\(\(summary\) => \{\s*\n\s*if \(!cancelled\) setOverviewSummary\(summary\);/);
    assert.match(dataSource, /\}, \[active, apiClient, backendStatus\]\);/);
  });

  it("renders a page branch for every sidebar module", () => {
    const navIds = extractNavIds(read("src/data/salesWorkbenchData.js"));
    const shellSource = read("src/app/SalesWorkbenchShell.jsx");
    const missingBranches = navIds.filter((id) => !shellSource.includes(`active === "${id}"`));

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
      "createAction",
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
      "listVisitItineraries",
      "getVisitItinerary",
      "saveVisitItinerary",
      "deleteVisitItinerary",
      "listTravelExpenses",
      "getTravelExpense",
      "saveTravelExpense",
      "deleteTravelExpense",
      "addTravelExpenseAttachment",
      "getTravelExpenseAttachmentContentUrl",
      "deleteTravelExpenseAttachment",
      "listTravelExpenseAdvances",
      "saveTravelExpenseAdvance",
      "deleteTravelExpenseAdvance",
      "listInvoices",
      "uploadInvoice",
      "getInvoice",
      "getInvoiceContentUrl",
      "reviewInvoice",
      "deleteInvoice",
      "listInvoiceMatches",
      "createInvoiceMatch",
      "revokeInvoiceMatch",
      "listNoInvoiceConfirmations",
      "confirmNoInvoice",
      "revokeNoInvoice",
      "getWeekInvoiceCoverage",
      "listInvoiceCandidates",
      "generateInvoiceCandidates",
      "acceptInvoiceCandidate",
      "rejectInvoiceCandidate",
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
      "itinerary",
      "expense",
    ].filter((keyword) => !integrationSource.toLowerCase().includes(keyword));

    assert.deepEqual({ missingApiClient, missingApiTests, missingIntegration }, {
      missingApiClient: [],
      missingApiTests: [],
      missingIntegration: [],
    });
  });

  it("keeps the deferred solution assistant out of responsive primary navigation", () => {
    const dataSource = read("src/data/salesWorkbenchData.js");
    const shellSource = read("src/app/SalesWorkbenchShell.jsx");
    const navBlock = extractNavBlock(dataSource);

    assert.doesNotMatch(navBlock, /\bid:\s*"solution"|方案辅助/);
    assert.match(shellSource, /<aside className="sidebar">[\s\S]*\{navItems\.map/);
    assert.doesNotMatch(readAppSource(), /setActive\("solution"\)/);
  });

  it("keeps the historical solution compatibility state read-only", () => {
    const pageSource = readSalesWorkbenchPagesSource();
    const shellSource = read("src/app/SalesWorkbenchShell.jsx");
    const solutionPageSource = pageSource.match(
      /export function SolutionPage\([\s\S]*?(?=\nexport function WeeklyPage)/,
    )?.[0] ?? "";

    assert.match(shellSource, /active === "solution"/);
    assert.match(solutionPageSource, /data-testid="solution-history-view"/);
    assert.match(solutionPageSource, /solutionDocs\.map/);
    assert.match(solutionPageSource, /selected\?\.content/);
    assert.doesNotMatch(
      solutionPageSource,
      /generateSolutionDraft|saveSolutionDraft|<textarea|生成交付物|重新生成|保存草稿/,
    );
    assert.doesNotMatch(pageSource, /引用到方案/);
  });

  it("lazy-loads at least fifteen route chunks behind a suspense fallback", () => {
    const shellSource = read("src/app/SalesWorkbenchShell.jsx");
    const lazyImports = shellSource.match(/lazy\(\(\) => import\(/g) ?? [];
    assert.ok(lazyImports.length >= 15, `expected >=15 lazy imports, got ${lazyImports.length}`);
    assert.match(shellSource, /import \{ Overview \} from/);
    assert.match(shellSource, /data-testid="route-chunk-loading"/);
    assert.match(shellSource, /data-testid="route-chunk-error"/);
  });

  it("keeps entity workspace templates centralized for the five business list pages", () => {
    const workspaceSource = read("src/features/salesWorkbench/pages/EntityWorkspace.jsx");
    const pageSource = readSalesWorkbenchPagesSource();

    assert.match(workspaceSource, /sticky-subview-toolbar/);
    assert.match(workspaceSource, /ConfirmDialog/);
    assert.match(workspaceSource, /detail-surface/);
    assert.match(workspaceSource, /config\.emptyNoItems/);
    assert.match(workspaceSource, /config\.emptyNoMatch/);
    assert.match(workspaceSource, /action=\{config\.createAction/);

    for (const page of ["CustomerPage", "OpportunityPage", "ActionsPage", "RiskPage", "KnowledgePage"]) {
      assert.match(pageSource, new RegExp(`export function ${page}[\\s\\S]*?<EntityWorkspace`));
    }
    for (const token of ["customer-create-detail", "opportunity-create-detail", "knowledge-create-detail", "actions-create-detail"]) {
      assert.match(pageSource, new RegExp(`testId:\\s*"${token}"`));
    }
    assert.doesNotMatch(read("src/features/salesWorkbench/pages/RiskPage.jsx"), /createAction:/);
    assert.match(read("src/features/salesWorkbench/pages/ActionsPage.jsx"), /renderRowActions:/);
  });
});
