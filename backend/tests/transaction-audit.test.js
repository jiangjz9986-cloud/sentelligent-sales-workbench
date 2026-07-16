import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const account = "task10-auditor";
const passwordField = "pass" + "word";
const loginValue = "task10-login-value";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 10) });

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function withHarness(options, work) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-transaction-audit-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const server = createServer({
    databaseUrl,
    seed: true,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 10).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    ...options,
  });

  try {
    const baseUrl = await listen(server);
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, [passwordField]: loginValue }),
    });
    const loginBody = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    const cookie = cookiePair(loginResponse);
    const csrf = loginBody.csrfToken;

    const request = async (path, requestOptions = {}) => {
      const method = String(requestOptions.method ?? "GET").toUpperCase();
      const headers = {
        Cookie: cookie,
        ...(method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": csrf } : {}),
        ...(requestOptions.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(requestOptions.headers ?? {}),
      };
      const response = await fetch(`${baseUrl}${path}`, { ...requestOptions, headers });
      const text = await response.text();
      return { response, body: text ? JSON.parse(text) : null };
    };

    await work({ baseUrl, databaseUrl, request, server });
  } finally {
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function inspectDatabase(databaseUrl, work) {
  const db = createConnection({ databaseUrl });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function tableRows(databaseUrl, table) {
  const allowed = new Set([
    "customers",
    "opportunities",
    "quick_records",
    "ai_insights",
    "ai_suggestions",
    "action_items",
    "risk_items",
    "knowledge_items",
    "weekly_reports",
    "solution_drafts",
    "audit_logs",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported test table: ${table}`);
  return inspectDatabase(databaseUrl, (db) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

function executeSql(databaseUrl, sql) {
  inspectDatabase(databaseUrl, (db) => db.exec(sql));
}

function installAuditFailure(databaseUrl, action) {
  const escapedAction = String(action).replaceAll("'", "''");
  executeSql(databaseUrl, `
    DROP TRIGGER IF EXISTS reject_task10_audit;
    CREATE TRIGGER reject_task10_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = '${escapedAction}'
    BEGIN
      SELECT RAISE(ABORT, 'deterministic task10 audit failure');
    END;
  `);
}

function removeAuditFailure(databaseUrl) {
  executeSql(databaseUrl, "DROP TRIGGER IF EXISTS reject_task10_audit");
}

async function assertAuditRollback({ databaseUrl, request, action, table, path, options }) {
  const beforeRows = tableRows(databaseUrl, table);
  const beforeAudits = tableRows(databaseUrl, "audit_logs");
  installAuditFailure(databaseUrl, action);
  try {
    const result = await request(path, options);
    assert.equal(result.response.status, 500, `${action} must fail when its audit insert fails`);
    assert.equal(result.body.error.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(result.body), /deterministic task10 audit failure/i);
  } finally {
    removeAuditFailure(databaseUrl);
  }
  assert.deepEqual(tableRows(databaseUrl, table), beforeRows, `${action} business rows must roll back`);
  assert.deepEqual(tableRows(databaseUrl, "audit_logs"), beforeAudits, `${action} audit rows must roll back`);
}

async function createQuickRecord(request, suffix) {
  const created = await request("/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: `Task 10 analysis ${suffix}`,
      occurredAt: "2026-07-17T10:00:00+08:00",
      sourceChannel: "test",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
    }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

function analysisSnapshot(databaseUrl, quickRecordId) {
  return inspectDatabase(databaseUrl, (db) => ({
    quickRecord: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(quickRecordId),
    insights: db.prepare("SELECT * FROM ai_insights WHERE quick_record_id = ? ORDER BY id").all(quickRecordId),
    audits: db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'quick_record.analyze' AND entity_id = ? ORDER BY id",
    ).all(quickRecordId),
  }));
}

async function assertAnalysisRollback(triggerSql, suffix) {
  await withHarness({}, async ({ databaseUrl, request }) => {
    const quickRecord = await createQuickRecord(request, suffix);
    const before = analysisSnapshot(databaseUrl, quickRecord.id);
    executeSql(databaseUrl, triggerSql);
    try {
      const result = await request(`/api/quick-records/${quickRecord.id}/analyze`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(result.response.status, 500);
      assert.equal(result.body.error.code, "INTERNAL_ERROR");
    } finally {
      executeSql(databaseUrl, `
        DROP TRIGGER IF EXISTS reject_task10_insight;
        DROP TRIGGER IF EXISTS reject_task10_status;
        DROP TRIGGER IF EXISTS reject_task10_analysis_audit;
      `);
    }
    assert.deepEqual(analysisSnapshot(databaseUrl, quickRecord.id), before);
  });
}

describe("central audit repository", () => {
  it("removes sensitive keys and values at any depth while bounding evidence", async () => {
    const { sanitizeAuditValue } = await import("../src/audit/auditRepository.js");
    const sensitiveValues = [
      "plain-password",
      "session-token-value",
      "cookie-value",
      "csrf-value",
      "13800138000",
      "person@example.test",
      "wechat-secret-value",
      "sk-" + "model-secret-value",
    ];
    const sanitized = sanitizeAuditValue({
      password: sensitiveValues[0],
      nested: {
        token: sensitiveValues[1],
        cookie: sensitiveValues[2],
        csrfToken: sensitiveValues[3],
        mobile: sensitiveValues[4],
        email: sensitiveValues[5],
        wechatSecret: sensitiveValues[6],
        note: `Authorization: Bearer abc.def; providerApiKey=${sensitiveValues[7]}`,
      },
      message: `Call ${sensitiveValues[4]} or ${sensitiveValues[5]}; password=${sensitiveValues[0]}`,
      values: Array.from({ length: 25 }, (_, index) => index),
      deep: { one: { two: { three: { four: { five: { six: "discarded" } } } } } },
    });

    const serialized = JSON.stringify(sanitized);
    for (const value of sensitiveValues) assert.doesNotMatch(serialized, new RegExp(value, "i"));
    assert.equal(sanitized.values.length, 20);
    assert.equal(sanitized.deep.one.two.three.four.five, null);
  });

  it("uses the authenticated account and stores request, version, and sanitized snapshots", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const created = await request("/api/customers", {
        method: "POST",
        body: JSON.stringify({
          name: "Task 10 audited customer",
          owner: "request-controlled-owner",
          contact: "13800138000 person@example.test",
          stakeholders: [{ name: "Decision maker", phone: "13800138000", email: "person@example.test" }],
          summary: "before summary",
        }),
      });
      assert.equal(created.response.status, 201);

      const createAudit = inspectDatabase(databaseUrl, (db) => db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'customer.create' AND entity_id = ?",
      ).get(created.body.item.id));
      assert.equal(createAudit.actor, account);
      assert.equal(createAudit.request_id, created.response.headers.get("x-request-id"));
      assert.equal(createAudit.entity_version, created.body.item.version);
      assert.equal(JSON.parse(createAudit.before_json), null);
      assert.equal(JSON.parse(createAudit.after_json).name, "Task 10 audited customer");
      assert.doesNotMatch(
        `${createAudit.before_json}${createAudit.after_json}${createAudit.metadata_json}`,
        /13800138000|person@example\.test/i,
      );

      const updated = await request(`/api/customers/${created.body.item.id}`, {
        method: "PATCH",
        headers: { "If-Match": `"${created.body.item.version}"` },
        body: JSON.stringify({ owner: "another-request-owner", summary: "after summary" }),
      });
      assert.equal(updated.response.status, 200);

      const updateAudit = inspectDatabase(databaseUrl, (db) => db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'customer.update' AND entity_id = ?",
      ).get(created.body.item.id));
      assert.equal(updateAudit.actor, account);
      assert.equal(updateAudit.request_id, updated.response.headers.get("x-request-id"));
      assert.equal(updateAudit.entity_version, updated.body.item.version);
      assert.equal(JSON.parse(updateAudit.before_json).summary, "before summary");
      assert.equal(JSON.parse(updateAudit.after_json).summary, "after summary");
    });
  });

  it("never treats assignee, confirmedBy, or report owner as the audit principal", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const actions = await request("/api/actions");
      const action = actions.body.items[0];
      const updatedAction = await request(`/api/actions/${action.id}`, {
        method: "PATCH",
        headers: { "If-Match": `"${action.version}"` },
        body: JSON.stringify({ assignee: "request-controlled-assignee" }),
      });
      assert.equal(updatedAction.response.status, 200);

      const quickRecord = await createQuickRecord(request, "authenticated confirmer");
      const analyzed = await request(`/api/quick-records/${quickRecord.id}/analyze`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(analyzed.response.status, 201);
      const confirmed = await request(`/api/quick-records/${quickRecord.id}/confirm`, {
        method: "POST",
        headers: {
          "If-Match": `"${quickRecord.version}"`,
          "Idempotency-Key": "task10-authenticated-confirmer",
        },
        body: JSON.stringify({
          targets: ["weekly"],
          confirmedBy: "request-controlled-confirmer",
          note: "actor regression",
          analysisVersionId: analyzed.body.item.id,
          targetVersions: {},
        }),
      });
      assert.equal(confirmed.response.status, 201);

      const weekly = await request("/api/reports/weekly/draft", {
        method: "POST",
        body: JSON.stringify({
          owner: "request-controlled-report-owner",
          periodStart: "2026-07-13",
          periodEnd: "2026-07-19",
          knowledgeIds: [],
        }),
      });
      assert.equal(weekly.response.status, 201);

      const actors = inspectDatabase(databaseUrl, (db) => db.prepare(`
        SELECT action, actor
        FROM audit_logs
        WHERE action IN ('action.update', 'quick_record.confirm', 'weekly_report.draft')
        ORDER BY action
      `).all());
      assert.deepEqual(actors.map((item) => item.actor), [account, account, account]);
    });
  });
});

describe("business mutation and audit atomicity", () => {
  it("rolls back customer, opportunity, knowledge, and quick-record creates on audit failure", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "customer.create",
        table: "customers",
        path: "/api/customers",
        options: { method: "POST", body: JSON.stringify({ name: "Rollback customer", owner: "body-owner" }) },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "opportunity.create",
        table: "opportunities",
        path: "/api/opportunities",
        options: {
          method: "POST",
          body: JSON.stringify({ customerId: "rizhao", name: "Rollback opportunity", owner: "body-owner" }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "knowledge.create",
        table: "knowledge_items",
        path: "/api/knowledge",
        options: { method: "POST", body: JSON.stringify({ title: "Rollback knowledge" }) },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "quick_record.create",
        table: "quick_records",
        path: "/api/quick-records",
        options: { method: "POST", body: JSON.stringify({ rawContent: "Rollback quick record" }) },
      });
    });
  });

  it("rolls back customer, opportunity, action, risk, and knowledge updates on audit failure", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const customers = await request("/api/customers");
      const customer = customers.body.items.find((item) => item.id === "rizhao");
      const opportunities = await request("/api/opportunities");
      const opportunity = opportunities.body.items.find((item) => item.id === "op-rizhao-plan");
      const actions = await request("/api/actions");
      const action = actions.body.items[0];
      const risks = await request("/api/risks");
      const risk = risks.body.items[0];
      const knowledge = await request("/api/knowledge");
      const knowledgeItem = knowledge.body.items[0];

      await assertAuditRollback({
        databaseUrl,
        request,
        action: "customer.update",
        table: "customers",
        path: `/api/customers/${customer.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${customer.version}"` },
          body: JSON.stringify({ owner: "rollback-owner" }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "opportunity.update",
        table: "opportunities",
        path: `/api/opportunities/${opportunity.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${opportunity.version}"` },
          body: JSON.stringify({ owner: "rollback-owner" }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "action.update",
        table: "action_items",
        path: `/api/actions/${action.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${action.version}"` },
          body: JSON.stringify({ assignee: "rollback-assignee" }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "risk.update",
        table: "risk_items",
        path: `/api/risks/${risk.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${risk.version}"` },
          body: JSON.stringify({ assignee: "rollback-assignee" }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "knowledge.update",
        table: "knowledge_items",
        path: `/api/knowledge/${knowledgeItem.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${knowledgeItem.version}"` },
          body: JSON.stringify({ summary: "rollback summary" }),
        },
      });
    });
  });

  it("rolls back AI suggestion, weekly draft, and solution draft persistence on audit failure", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "ai.suggestion.generate",
        table: "ai_suggestions",
        path: "/api/ai/suggestions",
        options: {
          method: "POST",
          body: JSON.stringify({ type: "next_action", title: "Rollback suggestion", context: {} }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "weekly_report.draft",
        table: "weekly_reports",
        path: "/api/reports/weekly/draft",
        options: {
          method: "POST",
          body: JSON.stringify({
            owner: "request-weekly-owner",
            periodStart: "2026-07-13",
            periodEnd: "2026-07-19",
            knowledgeIds: [],
          }),
        },
      });
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "solution_draft.generate",
        table: "solution_drafts",
        path: "/api/solutions/draft",
        options: {
          method: "POST",
          body: JSON.stringify({
            owner: "request-solution-owner",
            customerId: "rizhao",
            opportunityId: "op-rizhao-plan",
            artifactType: "solution_framework",
            knowledgeIds: [],
          }),
        },
      });
    });
  });

  it("rolls back weekly and solution updates on audit failure", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const weekly = await request("/api/reports/weekly/draft", {
        method: "POST",
        body: JSON.stringify({
          owner: "weekly-owner",
          periodStart: "2026-07-13",
          periodEnd: "2026-07-19",
          knowledgeIds: [],
        }),
      });
      assert.equal(weekly.response.status, 201);
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "weekly_report.update",
        table: "weekly_reports",
        path: `/api/reports/weekly/${weekly.body.item.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${weekly.body.item.version}"` },
          body: JSON.stringify({ status: "saved" }),
        },
      });

      const solution = await request("/api/solutions/draft", {
        method: "POST",
        body: JSON.stringify({
          owner: "solution-owner",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          artifactType: "solution_framework",
          knowledgeIds: [],
        }),
      });
      assert.equal(solution.response.status, 201);
      await assertAuditRollback({
        databaseUrl,
        request,
        action: "solution_draft.update",
        table: "solution_drafts",
        path: `/api/solutions/${solution.body.item.id}`,
        options: {
          method: "PATCH",
          headers: { "If-Match": `"${solution.body.item.version}"` },
          body: JSON.stringify({ title: "rollback solution title" }),
        },
      });
    });
  });
});

describe("multi-write route rollback", () => {
  it("rolls back analysis when insight persistence fails", async () => {
    await assertAnalysisRollback(`
      CREATE TRIGGER reject_task10_insight
      BEFORE INSERT ON ai_insights
      BEGIN
        SELECT RAISE(ABORT, 'deterministic insight failure');
      END;
    `, "insight failure");
  });

  it("rolls back the insight when quick-record status persistence fails", async () => {
    await assertAnalysisRollback(`
      CREATE TRIGGER reject_task10_status
      BEFORE UPDATE ON quick_records
      WHEN NEW.status = 'analyzed'
      BEGIN
        SELECT RAISE(ABORT, 'deterministic status failure');
      END;
    `, "status failure");
  });

  it("rolls back insight and status when analysis audit persistence fails", async () => {
    await assertAnalysisRollback(`
      CREATE TRIGGER reject_task10_analysis_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'quick_record.analyze'
      BEGIN
        SELECT RAISE(ABORT, 'deterministic analysis audit failure');
      END;
    `, "audit failure");
  });

  it("rolls back every diagnosed risk when one risk write fails", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const sourceId = "task10-risk-batch-write-failure";
      executeSql(databaseUrl, `
        CREATE TRIGGER reject_task10_second_risk
        AFTER INSERT ON risk_items
        WHEN NEW.source_id = '${sourceId}'
          AND (SELECT COUNT(*) FROM risk_items WHERE source_id = '${sourceId}') = 2
        BEGIN
          SELECT RAISE(ABORT, 'deterministic second risk failure');
        END;
      `);
      try {
        const result = await request("/api/opportunities/op-rizhao-plan/diagnose-risks", {
          method: "POST",
          body: JSON.stringify({ sourceType: "task10_batch", sourceId }),
        });
        assert.equal(result.response.status, 500);
      } finally {
        executeSql(databaseUrl, "DROP TRIGGER IF EXISTS reject_task10_second_risk");
      }
      const persisted = inspectDatabase(databaseUrl, (db) => db.prepare(
        "SELECT * FROM risk_items WHERE source_id = ?",
      ).all(sourceId));
      assert.deepEqual(persisted, []);
    });
  });

  it("rolls back every diagnosed risk when one audit write fails", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const sourceId = "task10-risk-batch-audit-failure";
      const beforeAudits = tableRows(databaseUrl, "audit_logs");
      installAuditFailure(databaseUrl, "risk.diagnose");
      try {
        const result = await request("/api/opportunities/op-rizhao-plan/diagnose-risks", {
          method: "POST",
          body: JSON.stringify({ sourceType: "task10_batch", sourceId }),
        });
        assert.equal(result.response.status, 500);
      } finally {
        removeAuditFailure(databaseUrl);
      }
      const persisted = inspectDatabase(databaseUrl, (db) => db.prepare(
        "SELECT * FROM risk_items WHERE source_id = ?",
      ).all(sourceId));
      assert.deepEqual(persisted, []);
      assert.deepEqual(tableRows(databaseUrl, "audit_logs"), beforeAudits);
    });
  });
});
