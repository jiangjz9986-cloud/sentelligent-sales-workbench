import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decisionLabel,
  decisionTone,
  salesDecisionHistoryLabel,
  salesDecisionViewModel,
} from "./salesDecisionViewModel.js";

function item(overrides = {}) {
  return {
    id: "decision-1",
    createdAt: "2026-07-27T12:00:00.000Z",
    analysis: {
      headline: "需要继续验证",
      decision: { code: "validate", confidence: 68, reason: "预算待确认" },
      stage: { current: "initial_discovery", recommended: "initial_discovery", missingGateEvidence: ["预算"] },
      score: { total: 48 },
      unknowns: [{ question: "预算是什么", priority: "high" }],
      risks: [],
      nextActions: [],
      compliance: { status: "clear", flags: [], requiresEscalation: false },
      writebackPreview: { requiresHumanConfirmation: true },
    },
    ...overrides,
  };
}

describe("sales decision view model", () => {
  it("maps every decision code to a readable label and tone", () => {
    assert.equal(decisionLabel("validate"), "继续验证");
    assert.equal(decisionLabel("escalate_review"), "升级审查");
    assert.equal(decisionTone("advance"), "green");
    assert.equal(decisionTone("disqualify"), "red");
  });

  it("summarizes evidence gaps and keeps the human confirmation boundary visible", () => {
    const view = salesDecisionViewModel(item());
    assert.equal(view.decisionLabel, "继续验证");
    assert.equal(view.scoreLabel, "48 / 100");
    assert.equal(view.unknownCount, 1);
    assert.equal(view.requiresHumanConfirmation, true);
    assert.match(salesDecisionHistoryLabel(item()), /07-27/);
  });
});
