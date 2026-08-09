import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_DEFINITIONS,
  TOOL_DEFINITIONS,
  createAgentRegistry,
} from "../src/assistant/agentRegistry.js";
import { createToolRegistry } from "../src/assistant/toolRegistry.js";

describe("assistant agent and tool registry", () => {
  it("registers the complete assistant agent set with executable instructions", () => {
    const registry = createAgentRegistry();
    const ids = registry.listAgents().map((agent) => agent.id);
    for (const id of ["system-router", "dashboard", "visit-capture", "customer", "opportunity", "sales-decision", "action-risk", "itinerary", "travel-expense", "payment-proof", "invoice", "advance-settlement", "reimbursement-report", "sales-report", "knowledge", "solution", "personal-finance"]) {
      assert.ok(ids.includes(id), id);
    }
    for (const item of registry.listAgents()) {
      assert.equal(typeof item.instructions, "string", `${item.id} instructions`);
      assert.ok(item.instructions.length >= 20, `${item.id} instructions must be actionable`);
    }
    assert.equal(registry.getAgent("solution").enabled, false);
    assert.equal(registry.getAgent("personal-finance").enabled, false);
  });

  it("exposes first-slice tool contracts without executable handlers", () => {
    const registry = createAgentRegistry();
    for (const name of ["customer.search", "visit-capture.collect", "visit-capture.preview", "visit-capture.confirm", "payment-proof.ingest", "invoice.ingest", "reimbursement-report.preview", "sales-report.preview"]) {
      const tool = registry.getTool(name);
      assert.equal(tool.name, name);
      assert.equal(typeof tool.execute, "undefined");
      assert.equal(typeof tool.arguments, "object");
    }
    assert.ok(AGENT_DEFINITIONS.length >= 17);
    assert.ok(TOOL_DEFINITIONS.length >= 7);
  });

  it("offers a standalone tool registry for future adapters", () => {
    const tools = createToolRegistry();
    assert.equal(tools.getTool("customer.search").agentId, "customer");
    assert.equal(tools.getTool("missing.tool"), null);
  });
});
