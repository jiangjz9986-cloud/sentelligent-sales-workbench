import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITY_CATALOG,
  getCapability,
  listCapabilities,
} from "../src/assistant/capabilityCatalog.js";

const REQUIRED_CAPABILITY_IDS = [
  "dashboard",
  "customer.search",
  "customer.detail",
  "opportunity.detail",
  "visit-capture",
  "travel-expense.summary",
  "reimbursement-report",
  "sales-decision.preview",
  "sales-report",
  "action-risk",
  "knowledge.search",
];

describe("小小 capability metadata catalog", () => {
  it("lists the reviewed capabilities with stable readiness metadata", () => {
    const capabilities = listCapabilities();
    assert.ok(Array.isArray(capabilities));

    const byId = new Map(capabilities.map((item) => [item.id, item]));
    for (const id of REQUIRED_CAPABILITY_IDS) {
      const item = byId.get(id);
      assert.ok(item, `missing capability ${id}`);
      assert.equal(typeof item.name, "string");
      assert.ok(item.name.length > 0);
      assert.equal(typeof item.description, "string");
      assert.ok(item.description.length > 0);
      assert.ok(["ready", "partial", "planned", "disabled"].includes(item.status), `${id} status`);
      assert.ok(["none", "preview", "explicit"].includes(item.confirmationLevel), `${id} confirmation level`);
      assert.ok(item.mappings && typeof item.mappings === "object");
      assert.ok(Array.isArray(item.mappings.tools));
      assert.ok(Array.isArray(item.mappings.apis));
      assert.ok(item.wiring && Array.isArray(item.wiring.dependencies));
      assert.ok(item.unavailableReason === null || typeof item.unavailableReason === "string");
      assert.equal("execute" in item, false, `${id} must not expose an executable handler`);
      assert.equal("handler" in item, false, `${id} must not expose an executable handler`);
    }

    assert.ok(byId.get("customer.search").mappings.tools.includes("customer.search"));
    assert.ok(byId.get("visit-capture").mappings.tools.includes("visit-capture.collect"));
    assert.ok(byId.get("reimbursement-report").mappings.tools.includes("reimbursement-report.preview"));
    assert.equal(byId.get("sales-decision.preview").status, "ready");
    assert.equal(byId.get("sales-decision.preview").unavailableReason, null);
  });

  it("returns isolated snapshots so callers cannot mutate the internal catalog", () => {
    const listed = listCapabilities();
    const original = getCapability("dashboard");
    assert.ok(original);
    assert.notEqual(listed, CAPABILITY_CATALOG);

    try {
      listed.find((item) => item.id === "dashboard").name = "被调用方篡改";
    } catch {
      // A frozen snapshot is also an acceptable isolation strategy.
    }
    try {
      listed.find((item) => item.id === "dashboard").wiring.dependencies.push("unexpected");
    } catch {
      // A deeply frozen snapshot is also an acceptable isolation strategy.
    }

    assert.equal(getCapability("dashboard").name, original.name);
    assert.deepEqual(getCapability("dashboard").wiring.dependencies, original.wiring.dependencies);
    assert.equal(getCapability("missing.capability"), null);
  });

  it("maps reviewed capabilities only to real reviewed API surfaces", () => {
    const expectedApis = {
      dashboard: ["GET /api/dashboard/summary"],
      "customer.search": ["GET /api/customers"],
      "customer.detail": ["GET /api/customers/:id"],
      "opportunity.detail": ["GET /api/opportunities/:id"],
      "visit-capture": ["POST /api/quick-records/preview"],
      "travel-expense.summary": ["GET /api/travel-expenses"],
      "reimbursement-report": ["GET /api/travel-expenses"],
      "sales-decision.preview": ["POST /api/ai/sales-decisions"],
      "sales-report": [],
      "action-risk": ["GET /api/actions", "GET /api/risks"],
      "knowledge.search": ["POST /api/knowledge/search"],
    };

    for (const [id, apis] of Object.entries(expectedApis)) {
      assert.deepEqual(getCapability(id).mappings.apis, apis, id);
    }

    for (const id of [
      "dashboard",
      "customer.search",
      "customer.detail",
      "opportunity.detail",
      "action-risk",
      "knowledge.search",
    ]) {
      assert.equal(JSON.stringify(getCapability(id)).includes("当前账号可见"), false, id);
      assert.equal(JSON.stringify(getCapability(id)).includes("owner-scoped"), false, id);
    }

    const allApis = listCapabilities().flatMap((item) => item.mappings.apis);
    assert.equal(allApis.includes("POST /api/quick-records/:id/confirm"), false);
    assert.equal(allApis.includes("GET /api/travel-expenses/summary"), false);
    assert.equal(allApis.includes("POST /api/sales-decision/analyses"), false);
    assert.equal(allApis.some((api) => /\/api\/weekly-reports\b/.test(api)), false);
    assert.equal(allApis.some((api) => /\/api\/reports\/weekly\/draft\b/.test(api)), false);
  });
});
