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
    assert.equal(registry.get("dashboard").contractVersion, "dashboard-v1");
    assert.equal(registry.get("dashboard").modelPolicy, "none");
    for (const id of ["travel-expense", "payment-proof", "invoice", "reimbursement-report"]) {
      assert.equal(registry.get(id).lifecycle, "disabled", id);
      assert.equal(registry.get(id).modelPolicy, "disabled_until_data_boundary_approved", id);
    }
    const settlement = registry.get("advance-settlement");
    assert.equal(settlement.contractVersion, "advance-settlement-v1");
    assert.equal(settlement.lifecycle, "active");
    assert.equal(settlement.modelPolicy, "none");
    assert.deepEqual(settlement.tools, ["advance-settlement.preview"]);
    assert.equal(settlement.confirmation.write, "explicit");
    assert.equal(Object.hasOwn(settlement.inputSchema.properties, "advanceId"), false);
    for (const field of ["settlementSnapshotHash", "requiresHumanReview", "acceptsConfirmation", "writebackAllowed"]) {
      assert.ok(settlement.outputSchema.required.includes(field), field);
    }
    assert.equal(settlement.outputSchema.properties.settlementSnapshotHash, "sha256");
    assert.equal(settlement.outputSchema.properties.requiresHumanReview, "boolean");
    assert.equal(settlement.outputSchema.properties.acceptsConfirmation, "boolean");
    assert.equal(settlement.outputSchema.properties.writebackAllowed, "boolean");
    assert.match(settlement.systemPrompt, /非公司直付的可报销金额/u);
    assert.match(settlement.systemPrompt, /不接受确认或写回/u);
    assert.equal(registry.get("solution").enabled, false);
    assert.equal(registry.get("personal-finance").enabled, false);
  });

  it("registers the customer write tools and preview task types on the customer manifest", () => {
    const registry = createAgentManifestRegistry();
    const customer = registry.get("customer");
    assert.deepEqual(customer.tools, [
      "customer.search",
      "customer.detail",
      "customer.create",
      "customer.update",
      "customer.delete",
    ]);
    assert.deepEqual(customer.taskTypes, [
      "search",
      "detail",
      "summarize",
      "change_preview",
      "create_preview",
      "delete_preview",
    ]);
    assert.equal(customer.confirmation.write, "explicit");
    assert.equal(Object.hasOwn(customer.inputSchema.properties, "changes"), true);
    assert.equal(Object.hasOwn(customer.inputSchema.properties, "expectedVersion"), true);
    assert.match(customer.systemPrompt, /六位确认码/u);
    assert.match(customer.systemPrompt, /服务端执行/u);
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
