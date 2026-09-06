import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(process.cwd());
const componentSource = readFileSync(resolve(root, "src/components/ai/ManualAiSuggestionPanel.jsx"), "utf8");
const fenceSource = readFileSync(resolve(root, "src/components/ai/aiSuggestionRequestFence.js"), "utf8");
const apiSource = readFileSync(resolve(root, "src/api/salesWorkbenchApi.js"), "utf8");
const pages = ["CustomerPage.jsx", "OpportunityPage.jsx", "KnowledgePage.jsx"]
  .map((file) => readFileSync(resolve(root, "src/features/salesWorkbench/pages", file), "utf8"));

describe("unified AI suggestion page integration", () => {
  it("replaces all three placeholder confirmation boxes with real persisted suggestion cards", () => {
    for (const source of pages) {
      assert.match(source, /ManualAiSuggestionPanel/u);
      assert.doesNotMatch(source, /ManualConfirmBox/u);
      assert.doesNotMatch(source, /generateBusinessSuggestion/u);
    }
    assert.match(pages[0], /type="customer_profile"/u);
    assert.match(pages[1], /type="opportunity_push"/u);
    assert.match(pages[2], /type="knowledge_talk"/u);
  });

  it("loads history through GET and only generates after an explicit click", () => {
    assert.match(componentSource, /listAiSuggestions/u);
    assert.match(componentSource, /generateSuggestion/u);
    assert.match(componentSource, /onClick=\{generateSuggestion\}/u);
    assert.match(componentSource, /已恢复待确认建议；不会重新调用模型，可继续编辑、确认或取消/u);
    const historyEffect = componentSource.slice(
      componentSource.indexOf("useEffect(() =>"),
      componentSource.indexOf("}, [apiClient, sourceId, type]);") + "}, [apiClient, sourceId, type]);".length,
    );
    assert.match(historyEffect, /listAiSuggestions/u);
    assert.doesNotMatch(historyEffect, /generateAiSuggestion/u);
    assert.match(apiSource, /async listAiSuggestions/u);
    assert.match(apiSource, /async generateAiSuggestion/u);
  });

  it("persists only an explicit review result and states that no business record was written", () => {
    assert.match(componentSource, /onConfirm=\{confirmSuggestion\}/u);
    assert.match(componentSource, /onCancel=\{cancelSuggestion\}/u);
    assert.match(componentSource, /保存人工确认草稿/u);
    assert.match(componentSource, /客户、商机和知识库均未自动修改/u);
    assert.match(componentSource, /status: "conflict"/u);
    assert.doesNotMatch(
      componentSource,
      /saveCustomer|saveOpportunity|saveKnowledge|updateCustomer|updateOpportunity|createAction|createRisk/u,
    );
  });

  it("restores pending history as actionable, locks terminal history, and cancels stale requests", () => {
    assert.match(componentSource, /historyReadOnly=\{historyReadOnly\}/u);
    assert.match(componentSource, /aiSuggestionHistoryIsReadOnly\(active\)/u);
    assert.match(componentSource, /aiSuggestionHistoryIsReadOnly\(item\)/u);
    assert.match(fenceSource, /new AbortController\(\)/u);
    assert.match(componentSource, /15_000/u);
    assert.match(fenceSource, /current\?\.controller\.abort\(\)/u);
    assert.match(componentSource, /requestIsCurrent/u);
    assert.match(componentSource, /const panelBusy = historyLoading \|\| generating \|\| reviewing/u);
    assert.match(componentSource, /busy=\{panelBusy\}/u);
    assert.match(componentSource, /disabled=\{panelBusy\}/u);
    assert.doesNotMatch(componentSource, /setStatus\(error\?\.message/u);
    assert.match(componentSource, /role="status"/u);
    assert.match(componentSource, /aria-live="polite"/u);
  });
});
