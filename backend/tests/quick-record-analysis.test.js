import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const account = "quick-record-editor";
const loginValue = "quick-record-test-login";
const passwordField = "pass" + "word";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 14) });

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
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-quick-analysis-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const modelCalls = [];
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
    authSessionSecret: Buffer.alloc(32, 14).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    fetchImpl: async (...args) => {
      modelCalls.push(args);
      throw new Error("model calls are forbidden in this test");
    },
    ...options,
  });

  try {
    const baseUrl = await listen(server);
    const rawRequest = async (path, requestOptions = {}) => {
      const response = await fetch(`${baseUrl}${path}`, requestOptions);
      const text = await response.text();
      return { response, body: text ? JSON.parse(text) : null };
    };
    const login = await rawRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, [passwordField]: loginValue }),
    });
    assert.equal(login.response.status, 200);
    const cookie = cookiePair(login.response);
    const csrf = login.body.csrfToken;
    const request = async (path, requestOptions = {}) => {
      const method = String(requestOptions.method ?? "GET").toUpperCase();
      const headers = {
        Cookie: cookie,
        ...(method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": csrf } : {}),
        ...(requestOptions.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(requestOptions.headers ?? {}),
      };
      return rawRequest(path, { ...requestOptions, headers });
    };

    await work({ baseUrl, databaseUrl, modelCalls, rawRequest, request, cookie, csrf });
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

function seedPersistedHistory(databaseUrl) {
  inspectDatabase(databaseUrl, (db) => {
    db.exec(`
      INSERT INTO quick_records (
        id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status,
        version, created_at, updated_at
      ) VALUES
        ('qr-history', 'quick-record-editor', '真实历史记录', '2026-07-18T09:00:00+08:00', 'test', 'rizhao', 'op-rizhao-plan', 'confirmed', 4, '2026-07-18 01:00:00', '2026-07-18 01:05:00'),
        ('qr-no-analysis', 'quick-record-editor', '尚未分析记录', '2026-07-18T08:00:00+08:00', 'test', NULL, NULL, 'recorded', 1, '2026-07-18 00:00:00', '2026-07-18 00:00:00');

      INSERT INTO quick_records (
        id, owner, raw_content, status, version, voided_at, voided_by, void_reason, created_at, updated_at
      ) VALUES (
        'qr-voided', 'quick-record-editor', 'voided record', 'recorded', 2, '2026-07-18 02:00:00', 'quick-record-editor',
        'superseded', '2026-07-18 00:30:00', '2026-07-18 02:00:00'
      );

      INSERT INTO ai_insights (
        id, quick_record_id, source, confidence, analysis_json, created_at
      ) VALUES
        ('insight-old', 'qr-history', 'persisted', 70,
          '{"source":"persisted","confidence":70,"customer":{"id":"rizhao","value":"日照中医医院","meta":"旧版本","tone":"blue"},"opportunity":{"id":"op-rizhao-plan","value":"规划项目","meta":"旧版本","tone":"green"},"weekly":{"value":"周五","meta":"旧版本","tone":"amber"},"summary":{"request":{"title":"客户诉求","text":"旧分析内容"},"feedback":{"title":"客户反馈","text":"旧反馈"},"risk":{"title":"风险点","text":"旧风险"},"action":{"title":"建议动作","text":"旧动作"}}}',
          '2026-07-18 01:01:00'),
        ('insight-latest', 'qr-history', 'persisted', 88,
          '{"source":"persisted","confidence":88,"customer":{"id":"rizhao","value":"日照中医医院","meta":"最新版本","tone":"blue"},"opportunity":{"id":"op-rizhao-plan","value":"规划项目","meta":"最新版本","tone":"green"},"weekly":{"value":"周五","meta":"最新版本","tone":"amber"},"summary":{"request":{"title":"客户诉求","text":"最新已保存分析"},"feedback":{"title":"客户反馈","text":"最新反馈"},"risk":{"title":"风险点","text":"最新风险"},"action":{"title":"建议动作","text":"最新动作"}}}',
          '2026-07-18 01:02:00');

      INSERT INTO manual_confirmations (
        id, quick_record_id, target, confirmed_by, note, created_at
      ) VALUES
        ('confirm-customer', 'qr-history', 'customer', '测试用户', '已同步客户', '2026-07-18 01:03:00'),
        ('confirm-weekly', 'qr-history', 'weekly', '测试用户', '已进入周报', '2026-07-18 01:04:00');
    `);
  });
}

async function createAnalyzedRecord(request) {
  const created = await request("/api/quick-records", {
    method: "POST",
    body: JSON.stringify({
      rawContent: "拜访日照中医医院，客户需要补齐本地数据中心和灾备规划。",
      occurredAt: "2026-07-18T10:00:00+08:00",
      sourceChannel: "test",
    }),
  });
  assert.equal(created.response.status, 201);
  const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(analyzed.response.status, 201);
  return {
    quickRecord: analyzed.body.quickRecord ?? created.body.item,
    analysis: analyzed.body.item,
  };
}

function summaryPatch(requestText) {
  return {
    summary: {
      request: requestText,
      feedback: "客户确认先评估现网。",
      risk: "预算窗口仍需确认。",
      action: "下周提交规划清单。",
    },
  };
}

describe("persisted quick-record analysis", () => {
  it("keeps WeChat machine quick-record reads and writes inside the machine owner scope", async () => {
    const machineOwnerCredential = ["machine", "owner", "token"].join("-");
    await withHarness({
      weixinAgentApiToken: machineOwnerCredential,
      weixinAgentOwner: "wechat-owner",
    }, async ({ databaseUrl, rawRequest, request }) => {
      inspectDatabase(databaseUrl, (db) => {
        db.prepare(`
          INSERT INTO quick_records (id, owner, raw_content, status)
          VALUES ($id, $owner, $rawContent, 'recorded')
        `).run({
          $id: "qr-other-owner",
          $owner: "different-owner",
          $rawContent: "不应被微信机器身份读取的内容",
        });
        db.prepare(`
          INSERT INTO quick_records (id, owner, raw_content, status)
          VALUES ($id, $owner, $rawContent, 'recorded')
        `).run({
          $id: "qr-wechat-owner",
          $owner: "wechat-owner",
          $rawContent: "微信机器身份自己的记录",
        });
        db.prepare(`
          INSERT INTO customers (id, name, owner)
          VALUES ($id, $name, $owner)
        `).run({
          $id: "customer-other-owner",
          $name: "其他 owner 客户",
          $owner: "different-owner",
        });
      });

      const machineHeaders = {
        Authorization: `Bearer ${machineOwnerCredential}`,
        "Content-Type": "application/json",
      };
      const browserDenied = await request("/api/quick-records/qr-other-owner/analyze", {
        method: "POST",
        body: "{}",
      });
      assert.equal(browserDenied.response.status, 404);

      const denied = await rawRequest("/api/quick-records/qr-other-owner/analyze", {
        method: "POST",
        headers: machineHeaders,
        body: "{}",
      });
      assert.equal(denied.response.status, 404);

      const crossOwnerCreate = await rawRequest("/api/quick-records", {
        method: "POST",
        headers: machineHeaders,
        body: JSON.stringify({
          rawContent: "不应绑定其他 owner 客户",
          customerId: "customer-other-owner",
          sourceChannel: "wechat_text",
        }),
      });
      assert.equal(crossOwnerCreate.response.status, 422);
    });
  });

  it("lists the latest saved analysis and confirmation state without calling the model", async () => {
    await withHarness({ aiAnalysisMode: "model", modelApiKey: "test-model-key" }, async ({
      databaseUrl,
      modelCalls,
      request,
    }) => {
      seedPersistedHistory(databaseUrl);

      const listed = await request("/api/quick-records");

      assert.equal(listed.response.status, 200);
      const history = listed.body.items.find((item) => item.id === "qr-history");
      const noAnalysis = listed.body.items.find((item) => item.id === "qr-no-analysis");
      assert.equal(listed.body.items.some((item) => item.id === "qr-voided"), false);
      assert.equal(history.analysis.id, "insight-latest");
      assert.equal(history.analysis.summary.request.text, "最新已保存分析");
      assert.deepEqual(history.confirmedTargets, ["customer", "weekly"]);
      assert.deepEqual(history.confirmations.map((item) => item.target), ["customer", "weekly"]);
      assert.deepEqual(history.syncLog, history.confirmations);
      assert.equal(noAnalysis.analysis, null);
      assert.deepEqual(noAnalysis.confirmedTargets, []);
      assert.deepEqual(noAnalysis.confirmations, []);
      assert.deepEqual(noAnalysis.syncLog, []);
      assert.equal(modelCalls.length, 0);
    });
  });

  it("requires authentication, CSRF, and If-Match before saving summary-only analysis changes", async () => {
    await withHarness({}, async ({ rawRequest, request, cookie, csrf }) => {
      const fixture = await createAnalyzedRecord(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/analysis`;
      const body = JSON.stringify(summaryPatch("保存后的客户真实诉求"));

      const anonymous = await rawRequest(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": `"${fixture.quickRecord.version}"` },
        body,
      });
      assert.equal(anonymous.response.status, 401);

      const missingCsrf = await rawRequest(path, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "If-Match": `"${fixture.quickRecord.version}"`,
        },
        body,
      });
      assert.equal(missingCsrf.response.status, 403);
      assert.equal(missingCsrf.body.error.code, "CSRF_INVALID");

      const missingVersion = await rawRequest(path, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
        },
        body,
      });
      assert.equal(missingVersion.response.status, 428);
      assert.equal(missingVersion.body.error.code, "PRECONDITION_REQUIRED");

      const widenedPayload = await request(path, {
        method: "PATCH",
        headers: { "If-Match": `"${fixture.quickRecord.version}"` },
        body: JSON.stringify({ ...summaryPatch("不得保存"), customer: { id: "rizhao" } }),
      });
      assert.equal(widenedPayload.response.status, 422);
      assert.equal(widenedPayload.body.error.fields.customer, "unknown");
    });
  });

  it("saves one concurrent revision, audits it transactionally, survives refresh, and confirms from the saved content", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request);
      const path = `/api/quick-records/${fixture.quickRecord.id}/analysis`;
      const requests = ["并发修订甲", "并发修订乙"].map((text) => request(path, {
        method: "PATCH",
        headers: { "If-Match": `"${fixture.quickRecord.version}"` },
        body: JSON.stringify(summaryPatch(text)),
      }));

      const results = await Promise.all(requests);
      assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
      const saved = results.find((item) => item.response.status === 200).body;
      const conflict = results.find((item) => item.response.status === 409).body;
      assert.equal(saved.analysis.id, fixture.analysis.id);
      assert.equal(saved.quickRecord.version, fixture.quickRecord.version + 1);
      assert.match(saved.analysis.summary.request.text, /^并发修订[甲乙]$/);
      assert.equal(conflict.error.code, "VERSION_CONFLICT");
      assert.equal(conflict.error.fields.currentVersion, saved.quickRecord.version);

      const refreshed = await request("/api/quick-records");
      const restored = refreshed.body.items.find((item) => item.id === fixture.quickRecord.id);
      assert.equal(restored.analysis.id, fixture.analysis.id);
      assert.equal(restored.analysis.summary.request.text, saved.analysis.summary.request.text);
      assert.equal(restored.version, saved.quickRecord.version);

      const auditRows = inspectDatabase(databaseUrl, (db) => db.prepare(`
        SELECT * FROM audit_logs
        WHERE action = 'quick_record.analysis.update' AND entity_id = ?
        ORDER BY created_at, id
      `).all(fixture.quickRecord.id));
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].actor, account);
      assert.equal(auditRows[0].entity_version, saved.quickRecord.version);
      assert.equal(JSON.parse(auditRows[0].before_json).analysis.summary.request.text.includes("并发修订"), false);
      assert.equal(JSON.parse(auditRows[0].after_json).analysis.summary.request.text, saved.analysis.summary.request.text);

      const customers = await request("/api/customers");
      const customerVersion = customers.body.items.find((item) => item.id === "rizhao").version;
      const confirmed = await request(`/api/quick-records/${fixture.quickRecord.id}/confirm`, {
        method: "POST",
        headers: {
          "Idempotency-Key": "confirm-saved-analysis-content",
          "If-Match": `"${saved.quickRecord.version}"`,
        },
        body: JSON.stringify({
          targets: ["customer"],
          confirmedBy: account,
          analysisVersionId: saved.analysis.id,
          targetVersions: { customer: customerVersion },
        }),
      });
      assert.equal(confirmed.response.status, 201);
      assert.ok(confirmed.body.customer.syncPreview.some((item) => item.includes(saved.analysis.summary.request.text)));
    });
  });

  it("rolls back the insight and quick-record version when audit insertion fails", async () => {
    await withHarness({}, async ({ databaseUrl, request }) => {
      const fixture = await createAnalyzedRecord(request);
      const before = inspectDatabase(databaseUrl, (db) => ({
        record: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(fixture.quickRecord.id),
        insight: db.prepare("SELECT * FROM ai_insights WHERE id = ?").get(fixture.analysis.id),
      }));
      inspectDatabase(databaseUrl, (db) => db.exec(`
        CREATE TRIGGER reject_quick_analysis_audit
        BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'quick_record.analysis.update'
        BEGIN
          SELECT RAISE(ABORT, 'deterministic quick analysis audit failure');
        END;
      `));

      const failed = await request(`/api/quick-records/${fixture.quickRecord.id}/analysis`, {
        method: "PATCH",
        headers: { "If-Match": `"${fixture.quickRecord.version}"` },
        body: JSON.stringify(summaryPatch("不得留下的修订")),
      });
      assert.equal(failed.response.status, 500);

      const after = inspectDatabase(databaseUrl, (db) => ({
        record: db.prepare("SELECT * FROM quick_records WHERE id = ?").get(fixture.quickRecord.id),
        insight: db.prepare("SELECT * FROM ai_insights WHERE id = ?").get(fixture.analysis.id),
        audits: db.prepare("SELECT * FROM audit_logs WHERE action = 'quick_record.analysis.update' AND entity_id = ?").all(fixture.quickRecord.id),
      }));
      assert.deepEqual(after.record, before.record);
      assert.deepEqual(after.insight, before.insight);
      assert.deepEqual(after.audits, []);
    });
  });
});
