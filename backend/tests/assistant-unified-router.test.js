import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentRegistry } from "../src/assistant/agentRegistry.js";
import { getCapability } from "../src/assistant/capabilityCatalog.js";
import { getToolPolicy } from "../src/assistant/policy.js";
import { createAssistantRouter } from "../src/assistant/router.js";

const READ_TOOLS = [
  "dashboard.summary",
  "customer.detail",
  "opportunity.detail",
  "sales-decision.preview",
  "action-risk.summary",
  "itinerary.summary",
  "travel-expense.summary",
  "knowledge.search",
];

describe("unified 小小 assistant routing", () => {
  it("keeps the existing registry and policy as the only executable tool source", () => {
    const registry = createAgentRegistry();
    for (const name of READ_TOOLS) {
      const tool = registry.getTool(name);
      assert.ok(tool, name);
      assert.equal(tool.name, name);
      assert.equal(getToolPolicy(name).denied, false, name);
      assert.equal(getToolPolicy(name).confirmation, "none", name);
    }
  });

  it("routes the reviewed read-only intents through registered tools", () => {
    const router = createAssistantRouter();
    const cases = [
      ["战情总览", "dashboard.summary", {}],
      ["客户详情 customer-a", "customer.detail", { customerId: "customer-a" }],
      ["商机详情 opportunity-a", "opportunity.detail", { opportunityId: "opportunity-a" }],
      ["项目分析 opportunity-a", "sales-decision.preview", { opportunityId: "opportunity-a" }],
      ["动作风险", "action-risk.summary", {}],
      ["行程摘要", "itinerary.summary", {}],
      ["差旅汇总", "travel-expense.summary", { week: "current" }],
      ["知识检索 医院采购", "knowledge.search", { query: "医院采购" }],
    ];

    for (const [text, toolName, args] of cases) {
      const plan = router.route({ text });
      assert.equal(plan.status, "planned", text);
      assert.equal(plan.toolName, toolName, text);
      assert.deepEqual(plan.arguments, args, text);
      assert.equal(plan.requiresConfirmation, false, text);
    }
  });

  it("clarifies missing identifiers and preserves weekly-report intent conflicts", () => {
    const router = createAssistantRouter();
    for (const text of ["客户详情", "商机详情", "项目分析", "知识检索"]) {
      const plan = router.route({ text });
      assert.equal(plan.status, "clarify", text);
      assert.ok(plan.question, text);
    }
    const weekly = router.route({ text: "帮我做周报" });
    assert.equal(weekly.status, "clarify");
    assert.match(weekly.question, /销售|报销/);
    assert.equal(router.route({ text: "报销周汇总" }).toolName, "reimbursement-report.preview");
    assert.equal(router.route({ text: "差旅汇总" }).toolName, "travel-expense.summary");
  });

  it("does not weaken the existing confirmation boundary for visit writes", () => {
    const router = createAssistantRouter();
    const write = router.route({ text: "/visit-capture.confirm draft-a" });
    assert.equal(write.status, "confirmation_required");
    assert.equal(write.requiresConfirmation, true);
    assert.equal(write.risk, "R2");
  });

  it("publishes runtime readiness without turning the catalog into a second registry", () => {
    const expected = {
      dashboard: "dashboard.summary",
      "customer.detail": "customer.detail",
      "opportunity.detail": "opportunity.detail",
      "sales-decision.preview": "sales-decision.preview",
      "action-risk": "action-risk.summary",
      "itinerary.summary": "itinerary.summary",
      "travel-expense.summary": "travel-expense.summary",
      "knowledge.search": "knowledge.search",
    };
    for (const [capabilityId, toolName] of Object.entries(expected)) {
      const capability = getCapability(capabilityId);
      assert.ok(capability, capabilityId);
      assert.equal(capability.status, "ready", capabilityId);
      assert.ok(capability.mappings.tools.includes(toolName), capabilityId);
      assert.equal("handler" in capability, false);
      assert.equal("execute" in capability, false);
    }
  });
});
