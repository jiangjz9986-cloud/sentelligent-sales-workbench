import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const account = "analysis-owner";
const loginPhrase = "analysis-customer-link-login";
const passwordField = "pass" + "word";
const passwordHash = await hashPassword(loginPhrase, { salt: Buffer.alloc(16, 93) });

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

function modelAnalysis(customer) {
  return {
    confidence: 91,
    customer: {
      id: customer.id ?? null,
      value: customer.value,
      meta: "model fixture",
      tone: "blue",
    },
    opportunity: {
      id: null,
      value: "待确认商机",
      meta: "model fixture",
      tone: "amber",
    },
    weekly: {
      id: null,
      value: "本周待归档",
      meta: "model fixture",
      tone: "amber",
    },
    summary: {
      request: { title: "客户诉求", text: "确认客户需求。" },
      feedback: { title: "客户反馈", text: "确认客户反馈。" },
      risk: { title: "风险点", text: "确认关联边界。" },
      action: { title: "建议动作", text: "人工确认后继续。" },
    },
  };
}

function modelResponse(analysis) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    }),
  };
}

async function withHarness(modelResponder, work) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-analysis-customer-link-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const modelCalls = [];
  const server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    aiAnalysisMode: "model",
    modelProvider: "fixture-provider",
    modelApiKey: "fixture-model-key",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 93).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    fetchImpl: async (url, options) => {
      const call = { url, options, body: JSON.parse(options.body) };
      modelCalls.push(call);
      const analysis = await modelResponder({ databaseUrl, call, callIndex: modelCalls.length - 1 });
      return modelResponse(analysis);
    },
  });

  try {
    const baseUrl = await listen(server);
    const rawRequest = async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, options);
      const text = await response.text();
      return { response, body: text ? JSON.parse(text) : null };
    };
    const login = await rawRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, [passwordField]: loginPhrase }),
    });
    assert.equal(login.response.status, 200);
    const cookie = cookiePair(login.response);
    const csrf = login.body.csrfToken;
    const request = async (path, options = {}) => {
      const method = String(options.method ?? "GET").toUpperCase();
      return rawRequest(path, {
        ...options,
        headers: {
          Cookie: cookie,
          ...(method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": csrf } : {}),
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
      });
    };

    await work({ databaseUrl, modelCalls, request });
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

function insertCustomer(databaseUrl, { id, name, owner = account, deleted = false }) {
  inspectDatabase(databaseUrl, (db) => {
    db.prepare(`
      INSERT INTO customers (id, name, owner, deleted_at)
      VALUES ($id, $name, $owner, $deletedAt)
    `).run({
      $id: id,
      $name: name,
      $owner: owner,
      $deletedAt: deleted ? "2026-09-02 08:00:00" : null,
    });
  });
}

async function createQuickRecord(request, suffix, customerId = null) {
  const created = await request("/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: `customer-link fixture ${suffix}`,
      sourceChannel: "api-test",
      ...(customerId ? { customerId } : {}),
    }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

async function analyzeQuickRecord(request, id) {
  return request(`/api/quick-records/${id}/analyze`, {
    method: "POST",
    body: "{}",
  });
}

function persistedAnalysis(databaseUrl, quickRecordId) {
  return inspectDatabase(databaseUrl, (db) => {
    const quickRecord = db.prepare("SELECT * FROM quick_records WHERE id = ?").get(quickRecordId);
    const insights = db.prepare(
      "SELECT * FROM ai_insights WHERE quick_record_id = ? ORDER BY created_at, id",
    ).all(quickRecordId);
    const audits = db.prepare(`
      SELECT * FROM audit_logs
      WHERE action = 'quick_record.analyze' AND entity_id = ?
      ORDER BY created_at, id
    `).all(quickRecordId);
    return { quickRecord, insights, audits };
  });
}

function parsedAnalyzeAudit(snapshot) {
  assert.equal(snapshot.audits.length, 1);
  const row = snapshot.audits[0];
  return {
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
    metadata: JSON.parse(row.metadata_json),
    entityVersion: Number(row.entity_version),
  };
}

describe("quick-record analysis customer linking", () => {
  it("links a verified owner customer by ID or by one exact active name and returns the latest record", async () => {
    const analyses = [
      modelAnalysis({ id: "customer-by-id", value: "客户甲" }),
      modelAnalysis({ id: null, value: "客户乙" }),
    ];
    await withHarness(async () => analyses.shift(), async ({ databaseUrl, modelCalls, request }) => {
      insertCustomer(databaseUrl, { id: "customer-by-id", name: "客户甲" });
      insertCustomer(databaseUrl, { id: "customer-by-name", name: "客户乙" });

      const byId = await createQuickRecord(request, "verified-id");
      const analyzedById = await analyzeQuickRecord(request, byId.id);
      assert.equal(analyzedById.response.status, 201);
      assert.equal(analyzedById.body.quickRecord.customerId, "customer-by-id");
      assert.equal(analyzedById.body.quickRecord.status, "analyzed");
      assert.equal(analyzedById.body.quickRecord.version, 2);

      const idSnapshot = persistedAnalysis(databaseUrl, byId.id);
      assert.equal(idSnapshot.quickRecord.customer_id, "customer-by-id");
      assert.equal(idSnapshot.quickRecord.status, "analyzed");
      assert.equal(idSnapshot.quickRecord.version, 2);
      assert.equal(idSnapshot.insights.length, 1);
      const idAudit = parsedAnalyzeAudit(idSnapshot);
      assert.equal(idAudit.before.quickRecord.customerId, null);
      assert.equal(idAudit.after.quickRecord.customerId, "customer-by-id");
      assert.equal(idAudit.metadata.customerId, "customer-by-id");
      assert.equal(idAudit.metadata.customerMatchSource, "analysis_id");
      assert.equal(idAudit.entityVersion, 2);

      const byName = await createQuickRecord(request, "unique-exact-name");
      const analyzedByName = await analyzeQuickRecord(request, byName.id);
      assert.equal(analyzedByName.response.status, 201);
      assert.equal(analyzedByName.body.quickRecord.customerId, "customer-by-name");
      assert.equal(analyzedByName.body.quickRecord.version, 2);
      assert.equal(analyzedByName.body.item.customer.id, "customer-by-name");
      assert.equal(analyzedByName.body.item.customer.value, "客户乙");

      const nameSnapshot = persistedAnalysis(databaseUrl, byName.id);
      assert.equal(nameSnapshot.quickRecord.customer_id, "customer-by-name");
      assert.equal(nameSnapshot.insights.length, 1);
      const nameAudit = parsedAnalyzeAudit(nameSnapshot);
      assert.equal(nameAudit.after.quickRecord.customerId, "customer-by-name");
      assert.equal(nameAudit.metadata.customerId, "customer-by-name");
      assert.equal(nameAudit.metadata.customerMatchSource, "exact_name");
      assert.equal(modelCalls.length, 2);
    });
  });

  it("leaves the link null for no match, case mismatch, ambiguity, deleted customers, cross-owner IDs, and forged IDs", async () => {
    const cases = [
      { suffix: "no-match", analysis: modelAnalysis({ id: null, value: "不存在的客户" }) },
      { suffix: "case-mismatch", analysis: modelAnalysis({ id: null, value: "owner unique" }) },
      { suffix: "ambiguous", analysis: modelAnalysis({ id: null, value: "同名客户" }) },
      { suffix: "deleted-id", analysis: modelAnalysis({ id: "deleted-customer", value: "已删除客户" }) },
      { suffix: "cross-owner-id", analysis: modelAnalysis({ id: "other-owner-customer", value: "跨账号同名" }) },
      { suffix: "forged-id", analysis: modelAnalysis({ id: "forged-customer-id", value: "Owner Unique" }) },
      { suffix: "id-name-disagree", analysis: modelAnalysis({ id: "owner-unique", value: "错误客户名称" }) },
    ];
    await withHarness(async ({ callIndex }) => cases[callIndex].analysis, async ({ databaseUrl, request }) => {
      insertCustomer(databaseUrl, { id: "owner-unique", name: "Owner Unique" });
      insertCustomer(databaseUrl, { id: "ambiguous-a", name: "同名客户" });
      insertCustomer(databaseUrl, { id: "ambiguous-b", name: "同名客户" });
      insertCustomer(databaseUrl, { id: "deleted-customer", name: "已删除客户", deleted: true });
      insertCustomer(databaseUrl, {
        id: "other-owner-customer",
        name: "跨账号同名",
        owner: "different-owner",
      });
      // This owner has one exact-name row, proving an invalid cross-owner ID
      // cannot bypass ID validation through the model's name field.
      insertCustomer(databaseUrl, { id: "same-name-current-owner", name: "跨账号同名" });

      for (const fixture of cases) {
        const created = await createQuickRecord(request, fixture.suffix);
        const analyzed = await analyzeQuickRecord(request, created.id);
        assert.equal(analyzed.response.status, 201, fixture.suffix);
        assert.equal(analyzed.body.quickRecord.customerId, null, fixture.suffix);
        assert.equal(analyzed.body.quickRecord.status, "analyzed", fixture.suffix);
        assert.equal(analyzed.body.quickRecord.version, 2, fixture.suffix);
        if (fixture.analysis.customer.id) {
          assert.equal(analyzed.body.item.customer.id, null, fixture.suffix);
          assert.equal(
            analyzed.body.item.customer.candidateId,
            fixture.analysis.customer.id,
            fixture.suffix,
          );
        }

        const snapshot = persistedAnalysis(databaseUrl, created.id);
        assert.equal(snapshot.quickRecord.customer_id, null, fixture.suffix);
        assert.equal(snapshot.quickRecord.status, "analyzed", fixture.suffix);
        assert.equal(snapshot.insights.length, 1, fixture.suffix);
        const audit = parsedAnalyzeAudit(snapshot);
        assert.equal(audit.after.quickRecord.customerId, null, fixture.suffix);
        assert.equal(audit.metadata.customerId, null, fixture.suffix);
        assert.equal(audit.metadata.customerMatchSource, "none", fixture.suffix);
      }
    });
  });

  it("preserves an existing user-selected customer even after soft deletion", async () => {
    await withHarness(
      async () => modelAnalysis({ id: "model-alternative", value: "模型候选客户" }),
      async ({ databaseUrl, request }) => {
        insertCustomer(databaseUrl, { id: "user-selected", name: "人工已选客户" });
        insertCustomer(databaseUrl, { id: "model-alternative", name: "模型候选客户" });
        const created = await createQuickRecord(request, "existing-link", "user-selected");
        inspectDatabase(databaseUrl, (db) => {
          db.prepare(`
            UPDATE customers
            SET deleted_at = '2026-09-02 09:00:00'
            WHERE id = 'user-selected'
          `).run();
        });

        const analyzed = await analyzeQuickRecord(request, created.id);
        assert.equal(analyzed.response.status, 201);
        assert.equal(analyzed.body.quickRecord.customerId, "user-selected");
        assert.equal(analyzed.body.quickRecord.version, 2);
        assert.equal(analyzed.body.item.customer.id, "user-selected");
        assert.equal(analyzed.body.item.customer.value, "人工已选客户");
        assert.equal(analyzed.body.item.customer.identityConflict, true);
        assert.equal(analyzed.body.item.customer.candidateId, "model-alternative");
        assert.equal(analyzed.body.item.customer.candidateValue, "模型候选客户");

        const snapshot = persistedAnalysis(databaseUrl, created.id);
        assert.equal(snapshot.quickRecord.customer_id, "user-selected");
        const audit = parsedAnalyzeAudit(snapshot);
        assert.equal(audit.before.quickRecord.customerId, "user-selected");
        assert.equal(audit.after.quickRecord.customerId, "user-selected");
        assert.equal(audit.metadata.customerId, "user-selected");
        assert.equal(audit.metadata.customerMatchSource, "existing");
        assert.equal(audit.metadata.customerIdentityConflict, true);
        const savedAnalysis = JSON.parse(snapshot.insights[0].analysis_json);
        assert.deepEqual(savedAnalysis.customer, analyzed.body.item.customer);
      },
    );
  });

  it("rolls back the customer link, analyzed status, version, and insight when the audit write fails", async () => {
    await withHarness(
      async () => modelAnalysis({ id: "atomic-customer", value: "事务客户" }),
      async ({ databaseUrl, request }) => {
        insertCustomer(databaseUrl, { id: "atomic-customer", name: "事务客户" });
        const created = await createQuickRecord(request, "audit-rollback");
        const before = persistedAnalysis(databaseUrl, created.id);
        inspectDatabase(databaseUrl, (db) => {
          db.exec(`
            CREATE TRIGGER reject_analysis_customer_link_audit
            BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'quick_record.analyze'
            BEGIN
              SELECT RAISE(ABORT, 'fixture analysis audit failure');
            END;
          `);
        });

        const analyzed = await analyzeQuickRecord(request, created.id);
        assert.equal(analyzed.response.status, 500);
        assert.equal(analyzed.body.error.code, "INTERNAL_ERROR");
        assert.doesNotMatch(JSON.stringify(analyzed.body), /fixture analysis audit failure/i);

        const after = persistedAnalysis(databaseUrl, created.id);
        assert.deepEqual(after, before);
        assert.equal(after.quickRecord.customer_id, null);
        assert.equal(after.quickRecord.status, "recorded");
        assert.equal(after.quickRecord.version, 1);
        assert.equal(after.insights.length, 0);
        assert.equal(after.audits.length, 0);
      },
    );
  });

  it("rechecks confirmation state after the model call before writing analysis", async () => {
    let quickRecordId = null;
    await withHarness(
      async ({ databaseUrl }) => {
        inspectDatabase(databaseUrl, (db) => {
          db.prepare(`
            UPDATE quick_records
            SET confirmation_preview_status = 'completed'
            WHERE id = $id
          `).run({ $id: quickRecordId });
        });
        return modelAnalysis({ id: "terminal-customer", value: "终态客户" });
      },
      async ({ databaseUrl, request }) => {
        insertCustomer(databaseUrl, { id: "terminal-customer", name: "终态客户" });
        const created = await createQuickRecord(request, "terminal-race");
        quickRecordId = created.id;

        const analyzed = await analyzeQuickRecord(request, created.id);
        assert.equal(analyzed.response.status, 409);
        assert.equal(analyzed.body.error.code, "QUICK_RECORD_CONFIRMATION_TERMINAL");

        const snapshot = persistedAnalysis(databaseUrl, created.id);
        assert.equal(snapshot.quickRecord.confirmation_preview_status, "completed");
        assert.equal(snapshot.quickRecord.customer_id, null);
        assert.equal(snapshot.quickRecord.status, "recorded");
        assert.equal(snapshot.quickRecord.version, 1);
        assert.equal(snapshot.insights.length, 0);
        assert.equal(snapshot.audits.length, 0);
      },
    );
  });

  it("rejects stale model output when the record changes during analysis", async () => {
    let quickRecordId = null;
    await withHarness(
      async ({ databaseUrl }) => {
        inspectDatabase(databaseUrl, (db) => {
          db.prepare(`
            UPDATE quick_records
            SET raw_content = 'corrected while model was running',
                customer_id = 'concurrent-customer',
                version = version + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $id
          `).run({ $id: quickRecordId });
        });
        return modelAnalysis({ id: "model-customer", value: "模型旧结果客户" });
      },
      async ({ databaseUrl, request }) => {
        insertCustomer(databaseUrl, { id: "concurrent-customer", name: "并发修正客户" });
        insertCustomer(databaseUrl, { id: "model-customer", name: "模型旧结果客户" });
        const created = await createQuickRecord(request, "stale-model-result");
        quickRecordId = created.id;

        const analyzed = await analyzeQuickRecord(request, created.id);
        assert.equal(analyzed.response.status, 409);
        assert.equal(analyzed.body.error.code, "QUICK_RECORD_ANALYSIS_STALE");
        assert.equal(analyzed.body.error.fields.expectedVersion, 1);
        assert.equal(analyzed.body.error.fields.currentVersion, 2);

        const snapshot = persistedAnalysis(databaseUrl, created.id);
        assert.equal(snapshot.quickRecord.raw_content, "corrected while model was running");
        assert.equal(snapshot.quickRecord.customer_id, "concurrent-customer");
        assert.equal(snapshot.quickRecord.status, "recorded");
        assert.equal(snapshot.quickRecord.version, 2);
        assert.equal(snapshot.insights.length, 0);
        assert.equal(snapshot.audits.length, 0);
      },
    );
  });
});
