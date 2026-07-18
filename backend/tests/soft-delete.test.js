import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { get, openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;
let databaseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text && response.headers.get("content-type")?.includes("application/json")) {
    body = JSON.parse(text);
  }
  return { response, body, text };
}

async function createCustomer(name, overrides = {}) {
  const created = await request("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name, owner: "tester", relation: 20, ...overrides }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

async function createWeeklyReport() {
  const created = await request("/api/reports/weekly/draft", {
    method: "POST",
    body: JSON.stringify({
      owner: "tester",
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
    }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-soft-delete-"));
  databaseUrl = join(tempDir, "test.sqlite");
  server = createServer({
    databaseUrl,
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

describe("soft deletion", () => {
  it("soft-deletes an entity with the current version and hides it from list/get", async () => {
    const sensitiveContact = "private-contact-13800000000";
    const customer = await createCustomer("soft-delete-customer", { contact: sensitiveContact });
    const deleted = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted.id, customer.id);
    assert.equal(deleted.body.deleted.version, customer.version + 1);

    const listed = await request("/api/customers");
    const loaded = await request(`/api/customers/${customer.id}`);
    const dashboard = await request("/api/dashboard/summary");
    assert.equal(listed.body.items.some((item) => item.id === customer.id), false);
    assert.equal(loaded.response.status, 404);
    assert.equal(dashboard.body.item.customerHeat.some((item) => item.customerId === customer.id), false);

    const audit = await request(`/api/audit-logs?entityType=customer&entityId=${customer.id}`);
    const deletion = audit.body.items.find((item) => item.action === "customer.delete");
    assert.ok(deletion);
    assert.doesNotMatch(JSON.stringify({ before: deletion.before, after: deletion.after }), new RegExp(sensitiveContact));
    assert.equal(deletion.before.id, customer.id);
    assert.equal(deletion.after.version, customer.version + 1);

    const db = openDatabase({ databaseUrl });
    try {
      const row = get(db, "SELECT * FROM customers WHERE id = $id", { $id: customer.id });
      assert.ok(row);
      assert.equal(row.version, customer.version + 1);
      assert.equal(row.deleted_by, "anonymous");
      assert.ok(row.deleted_at);
    } finally {
      db.close();
    }
  });

  it("never exposes nested customer secrets in soft-delete audit snapshots", async () => {
    const secrets = {
      contact: "audit-contact-value-4101",
      cookie: "audit-cookie-value-4102",
      csrf: "audit-csrf-value-4103",
      credential: "audit-credential-value-4104",
      wechat: "audit-wechat-value-4105",
      provider: "audit-provider-value-4106",
      bearer: ["Bearer", "audit-authorization-value-4107"].join(" "),
      openAi: ["s", "k-audit-openai-value-4108"].join(""),
    };
    const customer = await createCustomer("audit-secret-customer", {
      contact: secrets.contact,
      region: secrets.bearer,
      level: secrets.openAi,
      stakeholders: [{
        cookie: secrets.cookie,
        csrfToken: secrets.csrf,
        credential: secrets.credential,
        wechatSecret: secrets.wechat,
        providerKey: secrets.provider,
        Authorization: secrets.bearer,
        arbitraryScalar: secrets.openAi,
      }],
      infrastructure: [{ nested: { sessionCookie: secrets.cookie } }],
    });

    const deleted = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(deleted.response.status, 200);

    const audit = await request(`/api/audit-logs?entityType=customer&entityId=${customer.id}`);
    assert.equal(audit.response.status, 200);
    const auditJson = JSON.stringify(audit.body);
    for (const [label, secret] of Object.entries(secrets)) {
      assert.equal(auditJson.includes(secret), false, label);
    }
    const deletion = audit.body.items.find((item) => item.action === "customer.delete");
    assert.ok(deletion.requestId);
    assert.equal(deletion.entityVersion, customer.version + 1);
    assert.equal(deletion.before.id, customer.id);
    assert.equal(deletion.before.version, customer.version);
    assert.equal(deletion.after.version, customer.version + 1);
    assert.ok(deletion.after.deletedAt);
    for (const disallowedField of ["contact", "stakeholders", "infrastructure", "summary", "needs", "risks"]) {
      assert.equal(Object.hasOwn(deletion.before, disallowedField), false, disallowedField);
      assert.equal(Object.hasOwn(deletion.after, disallowedField), false, disallowedField);
    }
  });

  it("hides opportunities whose parent customer is soft-deleted", async () => {
    const customer = await createCustomer("deleted-parent-customer");
    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({
        customerId: customer.id,
        name: "orphaned-opportunity",
        stage: "qualified",
      }),
    });
    assert.equal(createdOpportunity.response.status, 201);
    const opportunity = createdOpportunity.body.item;

    const deleted = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(deleted.response.status, 200);

    const listed = await request("/api/opportunities");
    const loaded = await request(`/api/opportunities/${opportunity.id}`);
    const dashboard = await request("/api/dashboard/summary");
    assert.equal(listed.body.items.some((item) => item.id === opportunity.id), false);
    assert.equal(loaded.response.status, 404);
    assert.equal(dashboard.body.item.opportunities.some((item) => item.id === opportunity.id), false);

    const diagnosed = await request(`/api/opportunities/${opportunity.id}/diagnose-risks`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(diagnosed.response.status, 404);
    const solution = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "tester",
        customerId: customer.id,
        opportunityId: opportunity.id,
      }),
    });
    assert.equal(solution.response.status, 422);
  });

  it("hides solution drafts whose customer or opportunity dependency is inactive", async () => {
    const customer = await createCustomer("deleted-solution-parent");
    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: customer.id, name: "deleted-solution-opportunity" }),
    });
    assert.equal(createdOpportunity.response.status, 201);
    const opportunity = createdOpportunity.body.item;
    const createdSolution = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({ owner: "tester", customerId: customer.id, opportunityId: opportunity.id }),
    });
    assert.equal(createdSolution.response.status, 201);

    const deleted = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(deleted.response.status, 200);

    const loaded = await request(`/api/solutions/${createdSolution.body.item.id}`);
    assert.equal(loaded.response.status, 404);
  });

  it("returns 404 for a deleted entity while retaining its audit snapshot", async () => {
    const report = await createWeeklyReport();
    const deleted = await request(`/api/reports/weekly/${report.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${report.version}"` },
    });
    assert.equal(deleted.response.status, 200);

    const loaded = await request(`/api/reports/weekly/${report.id}`);
    const exported = await request(`/api/reports/weekly/${report.id}/export?format=word`);
    assert.equal(loaded.response.status, 404);
    assert.equal(exported.response.status, 404);

    const audit = await request(`/api/audit-logs?entityType=weekly_report&entityId=${report.id}`);
    const deletion = audit.body.items.find((item) => item.action === "weekly_report.delete");
    assert.ok(deletion);
    assert.equal(deletion.before.id, report.id);
    assert.equal(deletion.before.version, report.version);
    assert.equal(deletion.after.id, report.id);
    assert.equal(deletion.after.version, report.version + 1);
    assert.ok(deletion.after.deletedAt);
    assert.equal(deletion.entityVersion, report.version + 1);
  });

  it("returns VERSION_CONFLICT for a stale delete without deleting the row", async () => {
    const customer = await createCustomer("stale-delete-customer");
    const updated = await request(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${customer.version}"` },
      body: JSON.stringify({ level: "updated" }),
    });
    assert.equal(updated.response.status, 200);

    const staleDelete = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(staleDelete.response.status, 409);
    assert.equal(staleDelete.body.error.code, "VERSION_CONFLICT");
    assert.equal(staleDelete.body.error.fields.currentVersion, updated.body.item.version);

    const loaded = await request(`/api/customers/${customer.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.item.level, "updated");
    assert.equal(loaded.body.item.version, updated.body.item.version);
  });

  it("soft-deletes all six configured entity types and excludes them from dependency reads", async () => {
    const customer = await createCustomer("all-soft-delete-customer");
    const opportunityResult = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: "rizhao", name: "all-soft-delete-opportunity" }),
    });
    const knowledgeResult = await request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({ title: "all-soft-delete-knowledge", tags: ["hidden-tag"] }),
    });
    const report = await createWeeklyReport();
    const [actions, risks] = await Promise.all([request("/api/actions"), request("/api/risks")]);
    const opportunity = opportunityResult.body.item;
    const knowledge = knowledgeResult.body.item;
    const action = actions.body.items[0];
    const risk = risks.body.items[0];
    const entities = [
      ["customers", customer],
      ["opportunities", opportunity],
      ["actions", action],
      ["risks", risk],
      ["knowledge", knowledge],
      ["reports/weekly", report],
    ];

    for (const [route, entity] of entities) {
      const deleted = await request(`/api/${route}/${entity.id}`, {
        method: "DELETE",
        headers: { "If-Match": `"${entity.version}"` },
      });
      assert.equal(deleted.response.status, 200, route);
      assert.equal(deleted.body.deleted.version, entity.version + 1, route);
    }

    for (const [route, entity] of entities.slice(0, 5)) {
      const listed = await request(`/api/${route}`);
      assert.equal(listed.body.items.some((item) => item.id === entity.id), false, route);
    }
    const searched = await request("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query: "hidden-tag", tags: ["hidden-tag"] }),
    });
    assert.equal(searched.body.items.some((item) => item.id === knowledge.id), false);
  });

  it("rolls back a customer delete when the audit insert fails", async () => {
    const customer = await createCustomer("audit-rollback-customer");
    const triggerDb = openDatabase({ databaseUrl });
    try {
      triggerDb.exec(`
        CREATE TRIGGER fail_customer_delete_audit
        BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'customer.delete'
        BEGIN
          SELECT RAISE(ABORT, 'forced customer delete audit failure');
        END;
      `);
    } finally {
      triggerDb.close();
    }

    const failedDelete = await request(`/api/customers/${customer.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${customer.version}"` },
    });
    assert.equal(failedDelete.response.status, 500);
    assert.equal(failedDelete.body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(failedDelete.body).includes("forced customer delete audit failure"), false);

    const loaded = await request(`/api/customers/${customer.id}`);
    const listed = await request("/api/customers");
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.item.version, customer.version);
    assert.equal(listed.body.items.some((item) => item.id === customer.id), true);

    const verifyDb = openDatabase({ databaseUrl });
    try {
      const row = get(verifyDb, "SELECT version, deleted_at, deleted_by FROM customers WHERE id = $id", {
        $id: customer.id,
      });
      assert.equal(row.version, customer.version);
      assert.equal(row.deleted_at, null);
      assert.equal(row.deleted_by, null);
    } finally {
      verifyDb.close();
    }
    const audit = await request(`/api/audit-logs?entityType=customer&entityId=${customer.id}`);
    assert.equal(audit.body.items.some((item) => item.action === "customer.delete"), false);
  });
});
