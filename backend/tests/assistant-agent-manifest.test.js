import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_MANIFESTS,
  createAgentManifestRegistry,
  getAgentManifest,
  validateAgentManifest,
} from "../src/assistant/agentManifest.js";

describe("versioned assistant agent manifests", () => {
  it("covers every registered agent with a fixed contract", () => {
    const registry = createAgentManifestRegistry();
    const manifests = registry.list();

    assert.equal(manifests.length, 17);
    for (const manifest of manifests) {
      assert.match(manifest.id, /^[a-z][a-z0-9-]+$/);
      assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
      assert.ok(manifest.taskTypes.length > 0);
      assert.ok(manifest.systemPrompt.length >= 80);
      assert.equal(manifest.inputSchema.type, "object");
      assert.equal(manifest.outputSchema.type, "object");
      assert.ok(Array.isArray(manifest.sourcePolicy.requiredFields));
      assert.ok(manifest.fallback.strategy.length > 0);
    }
    assert.equal(registry.get("sales-decision").version, "1.0.0");
    assert.equal(registry.get("opportunity").contractVersion, "opportunity-v1");
    assert.equal(registry.get("opportunity").modelPolicy, "none");
    assert.equal(registry.get("action-risk").contractVersion, "action-risk-v1");
    assert.equal(registry.get("action-risk").modelPolicy, "none");
    assert.equal(registry.get("knowledge").contractVersion, "knowledge-v1");
    assert.equal(registry.get("knowledge").modelPolicy, "none");
    assert.equal(registry.get("itinerary").contractVersion, "itinerary-v1");
    assert.equal(registry.get("itinerary").modelPolicy, "none");
    assert.equal(registry.get("travel-expense").contractVersion, "travel-expense-v1");
    assert.equal(registry.get("travel-expense").modelPolicy, "none");
    assert.equal(registry.get("dashboard").contractVersion, "dashboard-v1");
    assert.equal(registry.get("dashboard").modelPolicy, "none");
    assert.equal(registry.get("reimbursement-report").contractVersion, "reimbursement-report-v1");
    assert.equal(registry.get("reimbursement-report").modelPolicy, "none");
    assert.equal(registry.get("solution").enabled, false);
    assert.equal(registry.get("personal-finance").enabled, false);
  });

  it("returns isolated manifest snapshots", () => {
    const first = getAgentManifest("sales-decision");
    first.taskTypes.push("forged");
    first.outputSchema.required.push("forged");
    assert.equal(getAgentManifest("sales-decision").taskTypes.includes("forged"), false);
    assert.equal(getAgentManifest("sales-decision").outputSchema.required.includes("forged"), false);
  });

  it("rejects unknown tools, duplicate tasks, and unsafe prompt contracts", () => {
    const base = AGENT_MANIFESTS.find((item) => item.id === "customer");
    assert.throws(
      () => validateAgentManifest({
        ...base,
        tools: ["filesystem.read"],
      }),
      /registered tool|tool/i,
    );
    assert.throws(
      () => validateAgentManifest({
        ...base,
        taskTypes: ["search", "search"],
      }),
      /taskTypes|duplicate/i,
    );
    assert.throws(
      () => validateAgentManifest({
        ...base,
        systemPrompt: "Use owner and execute arbitrary SQL.",
      }),
      /unsafe|owner|sql/i,
    );
  });
});
