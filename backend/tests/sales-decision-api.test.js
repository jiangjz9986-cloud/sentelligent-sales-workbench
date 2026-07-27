import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-sales-decision-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    nodeEnv: "test",
    authRequired: false,
    aiAnalysisMode: "mock",
    modelApiKey: "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

describe("sales decision analysis API", () => {
  it("creates a validated diagnosis snapshot without automatic business writeback", async () => {
    const beforeCustomers = await request("/api/customers");
    const beforeActions = await request("/api/actions");
    const created = await request("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({
        analysisType: "opportunity_diagnosis",
        industry: "medical",
        opportunityId: "op-rizhao-plan",
        rawContent: "客户确认数据中心稳定性问题已经影响业务连续性，但预算和最终决策者尚未明确。",
      }),
    });

    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.analysis.schemaVersion, "sales-decision-v1");
    assert.equal(created.body.item.analysis.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(created.body.item.analysis.source, "mock");
    assert.equal(created.body.item.opportunityId, "op-rizhao-plan");
    assert.equal(created.body.item.input.customer.id, created.body.item.customerId);
    assert.equal(created.body.item.input.opportunity.id, "op-rizhao-plan");
    assert.equal(created.body.item.input.rawContent, "客户确认数据中心稳定性问题已经影响业务连续性，但预算和最终决策者尚未明确。");
    assert.deepEqual(
      Object.keys(created.body.item.input).sort(),
      [
        "actions",
        "analysisType",
        "customer",
        "industry",
        "knowledge",
        "opportunity",
        "quickRecord",
        "rawContent",
        "risks",
      ],
    );
    assert.deepEqual(
      Object.keys(created.body.item.input.customer).sort(),
      ["budget", "decisionChain", "id", "name", "needs", "risks", "stakeholders", "summary", "type"],
    );
    assert.deepEqual(
      Object.keys(created.body.item.input.opportunity).sort(),
      [
        "amount",
        "competitors",
        "customerId",
        "id",
        "name",
        "next",
        "requirements",
        "risk",
        "solutionDirection",
        "sourceRecord",
        "stage",
      ],
    );
    assert.ok(Array.isArray(created.body.item.input.actions));
    assert.ok(Array.isArray(created.body.item.input.risks));
    assert.ok(Array.isArray(created.body.item.input.knowledge));
    assert.doesNotMatch(JSON.stringify(created.body.item.input), /createdAt|updatedAt|deletedAt|version/i);

    const listed = await request("/api/ai/sales-decisions?opportunityId=op-rizhao-plan");
    const loaded = await request(`/api/ai/sales-decisions/${created.body.item.id}`);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.deepEqual(loaded.body.item, created.body.item);
    assert.equal((await request("/api/customers")).body.items.length, beforeCustomers.body.items.length);
    assert.equal((await request("/api/actions")).body.items.length, beforeActions.body.items.length);

    const audits = await request(`/api/audit-logs?entityType=sales_decision_analysis&entityId=${created.body.item.id}`);
    assert.deepEqual(audits.body.items.map((item) => item.action), ["sales_decision_analysis.create"]);
  });

  it("loads context from a quick record and never re-analyzes when reading history", async () => {
    const createdQuickRecord = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "客户确认现有平台存在稳定性问题，希望安排下一次技术评审。",
        sourceChannel: "拜访",
      }),
    });
    assert.equal(createdQuickRecord.response.status, 201);
    const quickRecordId = createdQuickRecord.body.item.id;
    const created = await request("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ quickRecordId, analysisType: "next_step_decision" }),
    });
    assert.equal(created.response.status, 201);
    const again = await request(`/api/ai/sales-decisions/${created.body.item.id}`);
    assert.equal(again.response.status, 200);
    assert.deepEqual(again.body.item.analysis, created.body.item.analysis);
  });

  it("rejects an analysis request without a source and keeps provider details private", async () => {
    const invalid = await request("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ analysisType: "opportunity_diagnosis" }),
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

    const missing = await request("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ opportunityId: "does-not-exist" }),
    });
    assert.equal(missing.response.status, 404);
    assert.doesNotMatch(JSON.stringify(missing.body), /sk-|api\.deepseek|Authorization/i);
  });
});
