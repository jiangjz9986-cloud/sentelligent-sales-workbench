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
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] ??= "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

function assertValidation(result, field) {
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, "VALIDATION_ERROR");
  assert.ok(result.body.error.requestId);
  assert.equal(typeof result.body.error.fields?.[field], "string");
}

async function post(path, body) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

async function patch(path, body) {
  return request(path, { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-zx-request-validation-"));
  server = createServer({
    databaseUrl: join(tempDir, "validation.sqlite"),
    seed: true,
    nodeEnv: "test",
    authRequired: false,
    aiAnalysisMode: "mock",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("strict business request validation", () => {
  it("rejects unknown and client-controlled customer fields without writing a row", async () => {
    const before = await request("/api/customers");

    const unknown = await post("/api/customers", {
      name: "Validation customer",
      unexpectedField: true,
    });
    assertValidation(unknown, "unexpectedField");

    const clientId = await post("/api/customers", {
      id: "client-controlled-id",
      name: "Validation customer",
    });
    assertValidation(clientId, "id");

    const after = await request("/api/customers");
    assert.equal(after.body.items.length, before.body.items.length);
  });

  it("rejects prototype-like unknown keys before any customer write", async () => {
    const before = await request("/api/customers");
    const body = JSON.parse('{"name":"Prototype test","__proto__":{"polluted":true}}');

    const result = await post("/api/customers", body);

    assertValidation(result, "__proto__");
    assert.equal(Object.hasOwn(result.body.error.fields, "__proto__"), true);
    assert.equal((await request("/api/customers")).body.items.length, before.body.items.length);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it("requires a non-empty customer name no longer than 200 characters", async () => {
    for (const name of ["   ", "x".repeat(201)]) {
      const result = await post("/api/customers", { name });
      assertValidation(result, "name");
      assert.doesNotMatch(JSON.stringify(result.body), new RegExp(`x{50}`));
    }
  });

  it("requires opportunities to reference an existing customer and validates numeric bounds", async () => {
    const base = {
      customerId: "missing-customer",
      name: "Validated opportunity",
      probability: 50,
      days: 30,
    };
    assertValidation(await post("/api/opportunities", base), "customerId");

    const customer = (await request("/api/customers")).body.items[0];
    for (const [field, value] of [
      ["probability", -1],
      ["probability", 101],
      ["probability", 12.5],
      ["days", -1],
      ["days", 2.5],
      ["days", 10001],
    ]) {
      const result = await post("/api/opportunities", {
        ...base,
        customerId: customer.id,
        [field]: value,
      });
      assertValidation(result, field);
    }

    const created = await post("/api/opportunities", {
      ...base,
      customerId: customer.id,
    });
    assert.equal(created.response.status, 201);
    assertValidation(
      await patch(`/api/opportunities/${created.body.item.id}`, { customerId: "missing-customer" }),
      "customerId",
    );
  });

  it("derives opportunity customer names from the referenced active customer", async () => {
    const customers = (await request("/api/customers")).body.items;
    assert.ok(customers.length >= 2, "seed data must include two customers");
    const [firstCustomer, secondCustomer] = customers;

    const created = await post("/api/opportunities", {
      customerId: firstCustomer.id,
      customer: "Forged customer name",
      name: "Canonical customer opportunity",
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.customerId, firstCustomer.id);
    assert.equal(created.body.item.customer, firstCustomer.name);

    const reassigned = await patch(`/api/opportunities/${created.body.item.id}`, {
      customerId: secondCustomer.id,
    });
    assert.equal(reassigned.response.status, 200);
    assert.equal(reassigned.body.item.customerId, secondCustomer.id);
    assert.equal(reassigned.body.item.customer, secondCustomer.name);

    const audits = await request(`/api/audit-logs?entityType=opportunity&entityId=${created.body.item.id}`);
    const reassignmentAudit = audits.body.items.find((item) => item.action === "opportunity.update");
    assert.deepEqual(reassignmentAudit?.metadata.changedFields, ["customerId"]);

    const forgedPatch = await patch(`/api/opportunities/${created.body.item.id}`, {
      customer: "Another forged customer name",
    });
    assert.equal(forgedPatch.response.status, 200);
    assert.equal(forgedPatch.body.item.customerId, secondCustomer.id);
    assert.equal(forgedPatch.body.item.customer, secondCustomer.name);
  });

  it("rejects invalid action, risk, and weekly report statuses", async () => {
    const action = (await request("/api/actions")).body.items[0];
    assertValidation(await patch(`/api/actions/${action.id}`, { status: "invalid" }), "status");

    const risk = (await request("/api/risks")).body.items[0];
    assertValidation(await patch(`/api/risks/${risk.id}`, { status: "invalid" }), "status");

    const weekly = await post("/api/reports/weekly/draft", {
      owner: "Validation owner",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-07",
    });
    assert.equal(weekly.response.status, 201);
    assertValidation(
      await patch(`/api/reports/weekly/${weekly.body.item.id}`, { status: "invalid" }),
      "status",
    );
  });

  it("persists every accepted manual action field", async () => {
    const action = (await request("/api/actions")).body.items[0];
    const updated = await patch(`/api/actions/${action.id}`, {
      title: "Validated action title",
      reason: "Validated action reason",
      priority: "高",
      tone: "blue",
    });

    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.item.title, "Validated action title");
    assert.equal(updated.body.item.reason, "Validated action reason");
    assert.equal(updated.body.item.priority, "高");
    assert.equal(updated.body.item.tone, "blue");
  });

  it("rejects malformed arrays, nested objects, and overlong free text", async () => {
    assertValidation(
      await post("/api/customers", { name: "Bad list", stakeholders: { name: "not-a-list" } }),
      "stakeholders",
    );
    assertValidation(
      await post("/api/knowledge", { title: "Bad tags", tags: [{ nested: true }] }),
      "tags",
    );
    assertValidation(
      await post("/api/ai/suggestions", { type: "next", title: "Bad context", context: [] }),
      "context",
    );

    let deepContext = { value: "leaf" };
    for (let depth = 0; depth < 7; depth += 1) deepContext = { nested: deepContext };
    assertValidation(
      await post("/api/ai/suggestions", { type: "next", title: "Deep context", context: deepContext }),
      "context",
    );
    assertValidation(
      await post("/api/knowledge", { title: "Too long", content: "z".repeat(100001) }),
      "content",
    );
  });

  it("rejects confirmation targets outside customer, opportunity, and weekly", async () => {
    const quickRecord = await post("/api/quick-records", {
      rawContent: "Validation quick record",
      occurredAt: "2026-07-15T10:00:00.000Z",
      sourceChannel: "test",
    });
    assert.equal(quickRecord.response.status, 201);

    const result = await post(`/api/quick-records/${quickRecord.body.item.id}/confirm`, {
      targets: ["database"],
      confirmedBy: "tester",
      note: "must not persist",
    });
    assertValidation(result, "targets");
  });

  it("validates customer and opportunity relationships on quick records and solution drafts", async () => {
    const customers = (await request("/api/customers")).body.items;
    const opportunities = (await request("/api/opportunities")).body.items;
    const opportunity = opportunities[0];
    const otherCustomer = customers.find((item) => item.id !== opportunity.customerId);
    assert.ok(otherCustomer, "seed data must include a second customer");

    assertValidation(
      await post("/api/quick-records", {
        rawContent: "Mismatched references",
        customerId: otherCustomer.id,
        opportunityId: opportunity.id,
      }),
      "opportunityId",
    );
    assertValidation(
      await post("/api/solutions/draft", {
        owner: "tester",
        customerId: otherCustomer.id,
        opportunityId: opportunity.id,
        artifactType: "solution_framework",
      }),
      "opportunityId",
    );
  });

  it("rejects blank quick-record references with field-level validation errors", async () => {
    for (const [field, value] of [
      ["customerId", ""],
      ["customerId", "   "],
      ["opportunityId", ""],
      ["opportunityId", "   "],
    ]) {
      const result = await post("/api/quick-records", {
        rawContent: "Blank reference test",
        [field]: value,
      });
      assertValidation(result, field);
    }
  });

  it("rejects unknown fields before auxiliary writes or model work", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = null;
    let modelFetchCount = 0;
    server = createServer({
      databaseUrl: join(tempDir, "validation.sqlite"),
      seed: false,
      nodeEnv: "test",
      authRequired: false,
      aiAnalysisMode: "model",
      modelApiKey: "test",
      fetchImpl: async () => {
        modelFetchCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
        };
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const opportunity = (await request("/api/opportunities")).body.items[0];
    const solution = await post("/api/solutions/draft", {
      owner: "tester",
      customerId: opportunity.customerId,
      opportunityId: opportunity.id,
      artifactType: "competitive_talk",
    });
    assert.equal(solution.response.status, 201);
    modelFetchCount = 0;
    const risksBefore = (await request("/api/risks")).body.items.length;
    const auditsBefore = (await request("/api/audit-logs?limit=500")).body.items.length;
    const quickPreview = await post("/api/quick-records/preview", {
      rawContent: "Preview",
      extra: true,
    });
    assertValidation(quickPreview, "extra");

    assertValidation(
      await post("/api/knowledge/search", { query: "test", extra: true }),
      "extra",
    );
    assertValidation(
      await post(`/api/opportunities/${opportunity.id}/diagnose-risks`, { extra: true }),
      "extra",
    );
    assertValidation(
      await post("/api/ai/suggestions", {
        type: "next",
        title: "Suggestion",
        context: {},
        extra: true,
      }),
      "extra",
    );

    assertValidation(
      await patch(`/api/solutions/${solution.body.item.id}`, { status: "saved", extra: true }),
      "extra",
    );

    const risksAfter = (await request("/api/risks")).body.items.length;
    const auditsAfter = (await request("/api/audit-logs?limit=500")).body.items.length;
    assert.equal(modelFetchCount, 0);
    assert.equal(risksAfter, risksBefore);
    assert.equal(auditsAfter, auditsBefore);
  });

  it("rejects bodies on mutation routes whose contract is empty", async () => {
    const quickRecord = await post("/api/quick-records", {
      rawContent: "Empty-body contract",
    });
    assert.equal(quickRecord.response.status, 201);
    assertValidation(
      await post(`/api/quick-records/${quickRecord.body.item.id}/analyze`, { extra: true }),
      "extra",
    );

    const customer = await post("/api/customers", { name: "Delete body contract" });
    assert.equal(customer.response.status, 201);
    const rejectedDelete = await request(`/api/customers/${customer.body.item.id}`, {
      method: "DELETE",
      body: JSON.stringify({ extra: true }),
    });
    assertValidation(rejectedDelete, "extra");
    assert.equal((await request(`/api/customers/${customer.body.item.id}`)).response.status, 200);
  });

  it("does not echo rejected sensitive values in errors or audit records", async () => {
    const sensitiveField = "pass" + "word";
    const rejectedValue = ["private", "validation", "sentinel"].join("-");
    const result = await post("/api/customers", {
      name: "Sensitive validation",
      [sensitiveField]: rejectedValue,
    });
    assertValidation(result, sensitiveField);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(rejectedValue));

    const audits = await request("/api/audit-logs");
    assert.equal(audits.response.status, 200);
    assert.doesNotMatch(JSON.stringify(audits.body), new RegExp(rejectedValue));
  });
});
