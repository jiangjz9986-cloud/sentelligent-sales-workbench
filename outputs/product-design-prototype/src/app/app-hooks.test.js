import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isCurrentBootstrapAttempt } from "./workbenchState.js";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("workbench navigation helpers", () => {
  it("exports route helper utilities from the navigation hook module", () => {
    const source = read("./useWorkbenchNavigation.jsx");
    assert.match(source, /export function activeFromRoute\(route\)/);
    assert.match(source, /export function routeFilterValue\(route, key\)/);
    assert.match(source, /export function editorModeFromRoute\(route, page\)/);
    assert.match(source, /ACTIVE_BY_ROUTE_PAGE\[route\?\.page\]/);
    assert.match(source, /route\?\.filters\?\.\[key\]\?\.\[0\]/);
    assert.match(source, /route\.mode === "new"/);
  });

  it("keeps selection refs synchronized in the navigation hook source", () => {
    const source = read("./useWorkbenchNavigation.jsx");
    assert.match(source, /selectedCustomerIdRef\.current = customerId/);
    assert.match(source, /selectedOpportunityIdRef\.current = opportunityId/);
    assert.match(source, /setSelectedOpportunityId\(route\.entityId\)/);
    assert.match(source, /addEventListener\("popstate"/);
  });

  it("resets quick-record session state when leaving the quick page", () => {
    const source = read("./useWorkbenchNavigation.jsx");
    assert.match(source, /onEnterQuick/);
    assert.match(source, /navigateTo\("quick"/);
  });
});

describe("workbench data helpers", () => {
  it("guards stale bootstrap responses with generation checks", () => {
    assert.equal(isCurrentBootstrapAttempt(2, 2, { aborted: false }), true);
    assert.equal(isCurrentBootstrapAttempt(3, 2, { aborted: false }), false);
    assert.equal(isCurrentBootstrapAttempt(2, 2, { aborted: true }), false);
  });

  it("normalizes collection setters through bootstrap data helpers", () => {
    const source = read("./useWorkbenchData.jsx");
    assert.match(source, /function updateWorkbenchCollection\(key, nextValue\)/);
    assert.match(source, /normalizeBootstrapData\(/);
    assert.match(source, /if \(active !== "overview" \|\| !apiClient\.isEnabled \|\| backendStatus !== "connected"\) return undefined;/);
  });
});

describe("workbench handlers", () => {
  it("clears dependent selection before navigating away from deleted entities", () => {
    const source = read("./useWorkbenchHandlers.jsx");
    assert.match(source, /handleDeleteCustomer[\s\S]*?nav\.setSelectedOpportunityId\(null\)/);
    assert.match(source, /handleDeleteOpportunity[\s\S]*?nav\.setSelectedOpportunityId\(\(current\) => current === id \? null : current\)/);
    assert.match(source, /handleDeleteKnowledge[\s\S]*?nav\.setSelectedKnowledgeId\(\(current\) => current === id \? null : current\)/);
    assert.match(source, /handleDeleteAction[\s\S]*?nav\.setSelectedActionId\(\(current\) => current === id \? null : current\)/);
    assert.match(source, /handleDeleteRisk[\s\S]*?nav\.setSelectedRiskId\(\(current\) => current === id \? null : current\)/);
  });

  it("applies every asynchronous deletion to the latest React collection state", () => {
    const source = read("./useWorkbenchHandlers.jsx");
    for (const setter of [
      "setWorkbenchCustomers",
      "setWorkbenchOpportunities",
      "setWorkbenchKnowledge",
      "setWorkbenchActions",
      "setWorkbenchRisks",
    ]) {
      assert.match(
        source,
        new RegExp(`${setter}\\(\\(current\\) => removeEntityById\\(current, id\\)\\)`),
      );
    }
    assert.doesNotMatch(
      source,
      /const remaining(?:Customers|Opportunities|Knowledge|Actions|Risks)\s*=/,
    );
  });

  it("exposes safe no-op defaults outside providers", () => {
    const handlersSource = read("./useWorkbenchHandlers.jsx");
    const quickSource = read("./useQuickRecordSession.jsx");
    const weeklySource = read("./useWeeklySession.jsx");
    assert.match(handlersSource, /handleSaveCustomer: async \(\) => \{\}/);
    assert.match(quickSource, /recordMode: "voice"/);
    assert.match(quickSource, /recordText: ""/);
    assert.match(weeklySource, /weeklyView: "daily"/);
    assert.match(weeklySource, /weeklyDraft: null/);
  });

  it("routes proactive confirmations through the shared handler and merges both result types", () => {
    const source = read("./useWorkbenchHandlers.jsx");
    assert.match(source, /handleConfirmProactiveWriteback: async \(\) => \{\}/);
    assert.match(source, /async function handleConfirmProactiveWriteback\(\{ item, target, preview, confirmationPreview \} = \{\}\)/);
    assert.match(source, /confirmationPreview\.suggestionId !== item\.id/);
    assert.match(source, /confirmationPreview\.previewDigest/);
    assert.match(source, /apiClient\.confirmProactiveWriteback\(item\.id/);
    assert.match(source, /setWorkbenchActions\(\(current\) => mergeById\(current, outcome\.action\)\)/);
    assert.match(source, /setWorkbenchRisks\(\(current\) => mergeById\(current, outcome\.risk\)\)/);
    assert.match(source, /reloadBootstrap\(\)\.catch\(\(\) => \{\}\)/);
  });
});

describe("route chunk boundary", () => {
  it("renders reload controls with explicit button types", () => {
    const source = read("./SalesWorkbenchShell.jsx");
    assert.match(source, /class RouteChunkBoundary extends Component/);
    assert.match(source, /data-testid="route-chunk-error"/);
    assert.match(source, /type="button" onClick=\{\(\) => window\.location\.reload\(\)\}/);
    assert.match(source, /return this\.props\.children/);
  });
});
