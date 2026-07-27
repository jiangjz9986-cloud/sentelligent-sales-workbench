import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(process.cwd());
const pageSource = readFileSync(resolve(root, "src/features/salesWorkbench/pages.jsx"), "utf8");
const panelSource = readFileSync(resolve(root, "src/features/salesWorkbench/SalesDecisionPanel.jsx"), "utf8");
const apiSource = readFileSync(resolve(root, "src/api/salesWorkbenchApi.js"), "utf8");
const combinedPageSource = `${pageSource}\n${panelSource}`;

describe("sales decision page delivery", () => {
  it("exposes an explicit diagnosis panel and read-only history path", () => {
    assert.match(combinedPageSource, /SalesDecisionPanel/);
    assert.match(combinedPageSource, /sales-decision-panel/);
    assert.match(combinedPageSource, /sales-decision-analyze/);
    assert.match(combinedPageSource, /sales-decision-history/);
    assert.match(combinedPageSource, /requiresHumanConfirmation/);
  });

  it("keeps history reads separate from the POST analyze action", () => {
    assert.match(apiSource, /listSalesDecisionAnalyses/);
    assert.match(apiSource, /createSalesDecisionAnalysis/);
    assert.match(apiSource, /getSalesDecisionAnalysis/);
    assert.match(apiSource, /POST/);
  });

  it("announces async status and exposes the selected history item", () => {
    assert.match(panelSource, /aria-live="polite"/);
    assert.match(panelSource, /role="status"/);
    assert.match(panelSource, /aria-pressed=/);
  });
});
