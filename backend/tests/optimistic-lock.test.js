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

async function createCustomer(name = "optimistic-customer") {
  const created = await request("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name, owner: "tester", relation: 20 }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

async function createDrafts() {
  const weekly = await request("/api/reports/weekly/draft", {
    method: "POST",
    body: JSON.stringify({
      owner: "tester",
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
    }),
  });
  const solution = await request("/api/solutions/draft", {
    method: "POST",
    body: JSON.stringify({
      owner: "tester",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
    }),
  });
  assert.equal(weekly.response.status, 201);
  assert.equal(solution.response.status, 201);
  return { weekly: weekly.body.item, solution: solution.body.item };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-optimistic-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    solutionWritesEnabled: true,
    authRequired: false,
    authAccount: "",
    authPassword: "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("optimistic entity versions", () => {
  it("exposes a positive integer version for every mutable public entity", async () => {
    const quickRecord = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({ rawContent: "version contract record" }),
    });
    const { weekly, solution } = await createDrafts();
    const collections = await Promise.all([
      request("/api/customers"),
      request("/api/opportunities"),
      request("/api/actions"),
      request("/api/risks"),
      request("/api/knowledge"),
    ]);
    const entities = [
      ...collections.map((result) => result.body.items[0]),
      quickRecord.body.item,
      weekly,
      solution,
    ];

    assert.equal(entities.length, 8);
    for (const entity of entities) {
      assert.equal(Number.isSafeInteger(entity.version), true);
      assert.ok(entity.version > 0);
    }
  });

  it("updates an entity when If-Match equals the current version", async () => {
    const customer = await createCustomer();
    const updated = await request(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${customer.version}"` },
      body: JSON.stringify({ level: "qualified", relation: 45 }),
    });

    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.item.level, "qualified");
    assert.equal(updated.body.item.relation, 45);
    assert.equal(updated.body.item.version, customer.version + 1);
  });

  it("returns 409 VERSION_CONFLICT for a stale If-Match without changing data", async () => {
    const customer = await createCustomer();
    const firstUpdate = await request(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${customer.version}"` },
      body: JSON.stringify({ level: "current", relation: 51 }),
    });
    assert.equal(firstUpdate.response.status, 200);

    const staleUpdate = await request(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${customer.version}"` },
      body: JSON.stringify({ level: "stale", relation: 99 }),
    });
    assert.equal(staleUpdate.response.status, 409);
    assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");
    assert.equal(staleUpdate.body.error.fields.currentVersion, firstUpdate.body.item.version);

    const loaded = await request(`/api/customers/${customer.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.item.level, "current");
    assert.equal(loaded.body.item.relation, 51);
    assert.equal(loaded.body.item.version, firstUpdate.body.item.version);
  });

  it("rejects missing malformed non-positive unsafe and ambiguous If-Match values", async () => {
    const customer = await createCustomer();
    const cases = [
      ["missing", undefined],
      ["unquoted", "1"],
      ["zero", "\"0\""],
      ["negative", "\"-1\""],
      ["unsafe", "\"9007199254740992\""],
      ["duplicate", "\"1\", \"1\""],
      ["ambiguous", "\"1\", \"2\""],
      ["decimal", "\"1.0\""],
      ["weak", "W/\"1\""],
    ];

    for (const [label, value] of cases) {
      const headers = value === undefined ? {} : { "If-Match": value };
      const result = await request(`/api/customers/${customer.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ level: label }),
      });
      assert.equal(result.response.status, 428, label);
      assert.equal(result.body.error.code, "PRECONDITION_REQUIRED", label);
    }

    const loaded = await request(`/api/customers/${customer.id}`);
    assert.equal(loaded.body.item.level, null);
    assert.equal(loaded.body.item.version, customer.version);
  });

  it("requires If-Match on every business PATCH and DELETE route", async () => {
    const { weekly, solution } = await createDrafts();
    const [customers, opportunities, actions, risks, knowledge] = await Promise.all([
      request("/api/customers"),
      request("/api/opportunities"),
      request("/api/actions"),
      request("/api/risks"),
      request("/api/knowledge"),
    ]);
    const customer = customers.body.items[0];
    const opportunity = opportunities.body.items[0];
    const action = actions.body.items[0];
    const risk = risks.body.items[0];
    const knowledgeItem = knowledge.body.items[0];
    const patches = [
      [`/api/customers/${customer.id}`, { level: "blocked" }],
      [`/api/opportunities/${opportunity.id}`, { stage: "blocked" }],
      [`/api/actions/${action.id}`, { status: "in_progress" }],
      [`/api/risks/${risk.id}`, { status: "in_progress" }],
      [`/api/knowledge/${knowledgeItem.id}`, { summary: "blocked" }],
      [`/api/reports/weekly/${weekly.id}`, { status: "saved" }],
      [`/api/solutions/${solution.id}`, { status: "saved" }],
    ];
    for (const [path, body] of patches) {
      const result = await request(path, { method: "PATCH", body: JSON.stringify(body) });
      assert.equal(result.response.status, 428, path);
      assert.equal(result.body.error.code, "PRECONDITION_REQUIRED", path);
    }

    const deletes = [
      `/api/customers/${customer.id}`,
      `/api/opportunities/${opportunity.id}`,
      `/api/actions/${action.id}`,
      `/api/risks/${risk.id}`,
      `/api/knowledge/${knowledgeItem.id}`,
      `/api/reports/weekly/${weekly.id}`,
    ];
    for (const path of deletes) {
      const result = await request(path, { method: "DELETE" });
      assert.equal(result.response.status, 428, path);
      assert.equal(result.body.error.code, "PRECONDITION_REQUIRED", path);
    }
  });

  it("returns 428 before body existence and dependency validation", async () => {
    const { weekly, solution } = await createDrafts();
    const [customers, opportunities, actions, risks, knowledge] = await Promise.all([
      request("/api/customers"),
      request("/api/opportunities"),
      request("/api/actions"),
      request("/api/risks"),
      request("/api/knowledge"),
    ]);
    const patchPaths = [
      `/api/customers/${customers.body.items[0].id}`,
      `/api/opportunities/${opportunities.body.items[0].id}`,
      `/api/actions/${actions.body.items[0].id}`,
      `/api/risks/${risks.body.items[0].id}`,
      `/api/knowledge/${knowledge.body.items[0].id}`,
      `/api/reports/weekly/${weekly.id}`,
      `/api/solutions/${solution.id}`,
    ];
    for (const path of patchPaths) {
      const result = await request(path, {
        method: "PATCH",
        body: JSON.stringify({ unexpected: true }),
      });
      assert.equal(result.response.status, 428, path);
      assert.equal(result.body.error.code, "PRECONDITION_REQUIRED", path);
    }

    const deletePaths = [
      `/api/customers/${customers.body.items[0].id}`,
      `/api/opportunities/${opportunities.body.items[0].id}`,
      `/api/actions/${actions.body.items[0].id}`,
      `/api/risks/${risks.body.items[0].id}`,
      `/api/knowledge/${knowledge.body.items[0].id}`,
      `/api/reports/weekly/${weekly.id}`,
    ];
    for (const path of deletePaths) {
      const result = await request(path, {
        method: "DELETE",
        body: JSON.stringify({ unexpected: true }),
      });
      assert.equal(result.response.status, 428, path);
      assert.equal(result.body.error.code, "PRECONDITION_REQUIRED", path);
    }

    const malformedBody = await request(`/api/customers/${customers.body.items[0].id}`, {
      method: "PATCH",
      headers: { "If-Match": "not-a-version" },
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(malformedBody.response.status, 428);

    const nonexistent = await request("/api/opportunities/does-not-exist", {
      method: "PATCH",
      body: JSON.stringify({ stage: "qualified" }),
    });
    assert.equal(nonexistent.response.status, 428);

    const invalidDependency = await request(`/api/opportunities/${opportunities.body.items[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ customerId: "missing-customer" }),
    });
    assert.equal(invalidDependency.response.status, 428);
  });
});
