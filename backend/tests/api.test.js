import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  assertApiCollection,
  assertApiEntity,
} from "../../shared/salesWorkbenchApiContract.mjs";
import { hashPassword } from "../src/auth/password.js";
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
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

function ifMatch(version) {
  return { "If-Match": `"${version}"` };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-api-"));
  databaseUrl = join(tempDir, "test.sqlite");
  server = createServer({
    databaseUrl,
    seed: true,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: false,
    authAccount: "",
    authPassword: "",
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

function modelTextCompletion(content) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ content }),
            },
          },
        ],
      }),
  };
}

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("sales workbench backend API", () => {
  it("exposes health and seeded customer/opportunity records", async () => {
    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.database, "ready");

    const customers = await request("/api/customers");
    assert.equal(customers.response.status, 200);
    assertApiCollection("customer", customers.body.items);
    assert.ok(customers.body.items.some((customer) => customer.name === "日照中医医院"));
    assert.ok(customers.body.items[0].stakeholders.length > 0);

    const opportunities = await request("/api/opportunities");
    assert.equal(opportunities.response.status, 200);
    assertApiCollection("opportunity", opportunities.body.items);
    assert.ok(opportunities.body.items.some((opportunity) => opportunity.name === "日照中医医院十五五规划"));
    assert.ok(opportunities.body.items[0].requirements.length > 0);

    const actions = await request("/api/actions");
    assert.equal(actions.response.status, 200);
    assert.ok(Array.isArray(actions.body.items));
    assert.ok(actions.body.items.length > 0);
    assert.equal(typeof actions.body.items[0].title, "string");
    assert.equal(typeof actions.body.items[0].status, "string");

    const risks = await request("/api/risks");
    assert.equal(risks.response.status, 200);
    assertApiCollection("riskItem", risks.body.items);
    assert.ok(risks.body.items.length > 0);
    assert.ok(risks.body.items.some((risk) => risk.status === "open" && risk.assignee && risk.due));
  });

  it("requires configured login credentials and protects business APIs", async () => {
    const passwordField = "pass" + "word";
    await new Promise((resolve) => server.close(resolve));
    server = createServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword("unit-secret", { salt: Buffer.alloc(16, 7) }),
      authSessionSecret: "unit-session-secret",
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const publicHealth = await request("/api/health");
    assert.equal(publicHealth.response.status, 200);
    assert.equal(publicHealth.body.authEnabled, true);

    const lockedCustomers = await request("/api/customers");
    assert.equal(lockedCustomers.response.status, 401);
    assert.equal(lockedCustomers.body.error.code, "UNAUTHORIZED");

    const invalidLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "wrong" }),
    });
    assert.equal(invalidLogin.response.status, 401);
    assert.doesNotMatch(JSON.stringify(invalidLogin.body), /unit-secret|unit-session-secret/);

    const validLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "unit-secret" }),
    });
    assert.equal(validLogin.response.status, 200);
    assert.equal(validLogin.body.account, "jiangjz");
    assert.equal("token" in validLogin.body, false);
    assert.ok(Date.parse(validLogin.body.expiresAt) > Date.now() + 6 * 24 * 60 * 60 * 1000);
    const cookie = validLogin.response.headers.get("set-cookie").split(";", 1)[0];
    assert.doesNotMatch(JSON.stringify(validLogin.body), /unit-secret|unit-session-secret/);

    const unlockedCustomers = await request("/api/customers", {
      headers: { Cookie: cookie },
    });
    assert.equal(unlockedCustomers.response.status, 200);
    assert.ok(unlockedCustomers.body.items.length >= 1);
  });

  it("fails closed when authentication is required but credentials are incomplete", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createServer({
      databaseUrl,
      seed: true,
      authRequired: true,
      authAccount: "",
      authPassword: "",
      authPasswordHash: "",
      authSessionSecret: "",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    assert.equal((await request("/api/health")).response.status, 200);
    const customers = await request("/api/customers");
    assert.equal(customers.response.status, 503);
    assert.equal(customers.body.error.code, "AUTH_NOT_CONFIGURED");
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", password: "wrong" }),
    });
    assert.equal(login.response.status, 503);
  });

  it("does not accept a missing password for hash-only credentials", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      authRequired: true,
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword("unit-login-secret", {
        salt: Buffer.alloc(16, 7),
      }),
      authSessionSecret: "unit-session-secret",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz" }),
    });
    assert.equal(login.response.status, 422);
    assert.equal("token" in login.body, false);
    assert.equal((await request("/api/customers")).response.status, 401);
  });

  it("allows a configured WeChat agent machine token without using the user password", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword("unit-secret", { salt: Buffer.alloc(16, 8) }),
      authSessionSecret: "unit-session-secret",
      weixinAgentApiToken: "wx-token",
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const lockedCustomers = await request("/api/customers", {
      headers: { Authorization: "Bearer wrong-machine-token" },
    });
    assert.equal(lockedCustomers.response.status, 401);

    const unlockedCustomers = await request("/api/customers", {
      headers: { Authorization: "Bearer wx-token" },
    });
    assert.equal(unlockedCustomers.response.status, 200);
    assert.ok(unlockedCustomers.body.items.length >= 1);
    assert.doesNotMatch(JSON.stringify(unlockedCustomers.body), /unit-secret|unit-session-secret/);
  });

  it("builds a dashboard summary from live backend records", async () => {
    const summary = await request("/api/dashboard/summary");
    assert.equal(summary.response.status, 200);
    assertApiEntity("dashboardSummary", summary.body.item);
    assert.equal(summary.body.item.metrics.opportunities.value, 2);
    assert.equal(summary.body.item.metrics.risks.value, 1);
    assert.ok(summary.body.item.priorityActions.length > 0);
    assert.ok(summary.body.item.customerHeat.some((item) => item.customerId === "rizhao" && item.value === 82));
    assert.ok(summary.body.item.opportunities.some((item) => item.id === "op-rizhao-plan"));
    assert.ok(summary.body.item.stageCounts.some((item) => item.count > 0));
  });

  it("creates a quick record and returns deterministic mock AI analysis", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent:
          "周三现场拜访日照中医医院，客户反馈移动云资源计费、平台封闭、数据导出和后台管理权存在问题，需要输出十五五规划材料。",
        occurredAt: "2026-06-03T09:00:00+08:00",
        sourceChannel: "现场拜访",
      }),
    });

    assert.equal(created.response.status, 201);
    assertApiEntity("quickRecord", created.body.item);
    assert.equal(created.body.item.status, "recorded");
    assert.equal(created.body.item.sourceChannel, "现场拜访");

    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
      method: "POST",
    });

    assert.equal(analyzed.response.status, 201);
    assertApiEntity("aiInsight", analyzed.body.item);
    assert.equal(analyzed.body.item.source, "mock");
    assert.equal(analyzed.body.item.customer.value, "日照中医医院");
    assert.equal(analyzed.body.item.opportunity.value, "日照中医医院十五五规划");
    assert.match(analyzed.body.item.summary.risk.text, /预算路径/);
  });

  it("previews quick record analysis without creating a quick record", async () => {
    const before = await request("/api/quick-records");
    const preview = await request("/api/quick-records/preview", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "周三拜访日照中医医院，客户需要十五五规划材料。",
      }),
    });
    const after = await request("/api/quick-records");

    assert.equal(preview.response.status, 200);
    assertApiEntity("aiInsight", preview.body.item);
    assert.equal(preview.body.item.source, "mock");
    assert.equal(preview.body.item.customer.value, "日照中医医院");
    assert.equal(after.body.items.length, before.body.items.length);
  });

  it("uses the configured model provider for quick record analysis without exposing the key", async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const providerCalls = [];

    server = createServer({
      databaseUrl: join(tempDir, "model-test.sqlite"),
      seed: true,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "test-provider-key",
      modelBaseUrl: "https://api.deepseek.com",
      modelName: "deepseek-v4-flash",
      authRequired: false,
      authAccount: "",
      authPassword: "",
      fetchImpl: async (url, options = {}) => {
        providerCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      customer: { id: "rizhao", value: "日照中医医院", meta: "置信度 90%", tone: "blue" },
                      opportunity: { id: "op-rizhao-plan", value: "日照中医医院十五五规划", meta: "置信度 85%", tone: "green" },
                      weekly: { value: "周三 / 06-03", meta: "本周记录", tone: "amber" },
                      summary: {
                        request: { title: "客户诉求", text: "输出十五五规划材料。" },
                        feedback: { title: "客户反馈", text: "移动云数据导出存在顾虑。" },
                        risk: { title: "风险点", text: "预算路径待确认。" },
                        action: { title: "建议动作", text: "同步商机并生成周报草稿。" },
                      },
                    }),
                  },
                },
              ],
            }),
        };
      },
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.aiAnalysisMode, "model");
    assert.equal(health.body.modelProvider, "deepseek");
    assert.equal(health.body.modelName, "deepseek-v4-flash");
    assert.equal(health.body.modelReady, true);
    assert.doesNotMatch(JSON.stringify(health.body), /test-provider-key/);

    const preview = await request("/api/quick-records/preview", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "日照中医医院需要输出十五五规划材料。",
      }),
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.item.source, "deepseek");
    assert.equal(providerCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(preview.body.item), /test-provider-key/);

    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "日照中医医院需要输出十五五规划材料。",
        occurredAt: "2026-06-03T09:00:00+08:00",
      }),
    });
    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
      method: "POST",
    });

    assert.equal(analyzed.response.status, 201);
    assert.equal(analyzed.body.item.source, "deepseek");
    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[0].options.headers.Authorization, "Bearer test-provider-key");
    assert.equal(providerCalls[1].options.headers.Authorization, "Bearer test-provider-key");
    assert.doesNotMatch(JSON.stringify(analyzed.body.item), /test-provider-key/);
  });

  it("creates and updates customer and opportunity records", async () => {
    const createdCustomer = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({
        name: "胶州中医医院",
        region: "青岛胶州",
        type: "二级医院",
        level: "新建线索",
        owner: "继振",
        contact: "信息科 / 待确认",
        relation: 35,
        needs: ["未来规划初访"],
        risks: ["决策链待补齐"],
        opportunities: [],
      }),
    });

    assert.equal(createdCustomer.response.status, 201);
    assertApiEntity("customer", createdCustomer.body.item);
    assert.equal(createdCustomer.body.item.name, "胶州中医医院");

    const updatedCustomer = await request(`/api/customers/${createdCustomer.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(createdCustomer.body.item.version),
      body: JSON.stringify({
        level: "重点培育",
        relation: 52,
        budget: "Q4 初步沟通",
        needs: ["未来规划初访", "补齐现有基础架构"],
      }),
    });

    assert.equal(updatedCustomer.response.status, 200);
    assertApiEntity("customer", updatedCustomer.body.item);
    assert.equal(updatedCustomer.body.item.level, "重点培育");
    assert.equal(updatedCustomer.body.item.relation, 52);
    assert.deepEqual(updatedCustomer.body.item.needs, ["未来规划初访", "补齐现有基础架构"]);

    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({
        customerId: createdCustomer.body.item.id,
        name: "胶州中医医院规划调研",
        customer: "胶州中医医院",
        stage: "线索",
        amount: "待定",
        owner: "继振",
        probability: 30,
        days: 0,
        requirements: ["现状调研"],
        competitors: ["暂未明确"],
        solutionDirection: ["先建立客户画像"],
      }),
    });

    assert.equal(createdOpportunity.response.status, 201);
    assertApiEntity("opportunity", createdOpportunity.body.item);
    assert.equal(createdOpportunity.body.item.customerId, createdCustomer.body.item.id);

    const updatedOpportunity = await request(`/api/opportunities/${createdOpportunity.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(createdOpportunity.body.item.version),
      body: JSON.stringify({
        stage: "初步沟通",
        probability: 45,
        requirements: ["现状调研", "基础架构清单"],
        next: "约信息科确认现场调研时间。",
        risk: "客户真实预算尚未打开。",
      }),
    });

    assert.equal(updatedOpportunity.response.status, 200);
    assertApiEntity("opportunity", updatedOpportunity.body.item);
    assert.equal(updatedOpportunity.body.item.stage, "初步沟通");
    assert.equal(updatedOpportunity.body.item.probability, 45);
    assert.deepEqual(updatedOpportunity.body.item.requirements, ["现状调研", "基础架构清单"]);
    assert.match(updatedOpportunity.body.item.next, /现场调研/);
  });

  it("deletes manually managed business records", async () => {
    const createdCustomer = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({
        name: "delete-customer",
        region: "test",
        type: "test",
        level: "manual",
        owner: "tester",
        contact: "tester",
        relation: 10,
      }),
    });

    assert.equal(createdCustomer.response.status, 201);

    const deletedCustomer = await request(`/api/customers/${createdCustomer.body.item.id}`, {
      method: "DELETE",
      headers: ifMatch(createdCustomer.body.item.version),
    });
    assert.equal(deletedCustomer.response.status, 200);
    assert.equal(deletedCustomer.body.deleted.id, createdCustomer.body.item.id);

    const missingCustomer = await request(`/api/customers/${createdCustomer.body.item.id}`);
    assert.equal(missingCustomer.response.status, 404);

    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({
        customerId: "rizhao",
        name: "delete-opportunity",
        customer: "Rizhao",
        stage: "manual",
      }),
    });

    assert.equal(createdOpportunity.response.status, 201);

    const deletedOpportunity = await request(`/api/opportunities/${createdOpportunity.body.item.id}`, {
      method: "DELETE",
      headers: ifMatch(createdOpportunity.body.item.version),
    });
    assert.equal(deletedOpportunity.response.status, 200);
    assert.equal(deletedOpportunity.body.deleted.id, createdOpportunity.body.item.id);

    const createdKnowledge = await request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: "delete-knowledge",
        category: "manual",
        tags: ["manual"],
      }),
    });

    assert.equal(createdKnowledge.response.status, 201);

    const deletedKnowledge = await request(`/api/knowledge/${createdKnowledge.body.item.id}`, {
      method: "DELETE",
      headers: ifMatch(createdKnowledge.body.item.version),
    });
    assert.equal(deletedKnowledge.response.status, 200);
    assert.equal(deletedKnowledge.body.deleted.id, createdKnowledge.body.item.id);

    const action = (await request("/api/actions")).body.items[0];
    const deletedAction = await request(`/api/actions/${action.id}`, {
      method: "DELETE",
      headers: ifMatch(action.version),
    });
    assert.equal(deletedAction.response.status, 200);
    assert.equal(deletedAction.body.deleted.id, action.id);

    const risk = (await request("/api/risks")).body.items[0];
    const deletedRisk = await request(`/api/risks/${risk.id}`, {
      method: "DELETE",
      headers: ifMatch(risk.version),
    });
    assert.equal(deletedRisk.response.status, 200);
    assert.equal(deletedRisk.body.deleted.id, risk.id);
  });

  it("requires manual confirmation before writing quick record targets", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "黄岛区中医院下周需要带售前做双活机房调研，并进入本周周报。",
        occurredAt: "2026-06-05T14:00:00+08:00",
        sourceChannel: "现场拜访",
      }),
    });

    await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });

    const confirmed = await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(created.body.item.version),
        "Idempotency-Key": "api-confirm-all-targets",
      },
      body: JSON.stringify({
        targets: ["customer", "opportunity", "weekly"],
        confirmedBy: "继振",
        note: "人工确认同步到客户、商机和周报草稿",
        targetVersions: { customer: 1, opportunity: 1 },
      }),
    });

    assert.equal(confirmed.response.status, 201);
    assertApiCollection("manualConfirmation", confirmed.body.confirmations);
    assertApiEntity("quickRecord", confirmed.body.quickRecord);
    assert.deepEqual(
      confirmed.body.confirmations.map((item) => item.target).sort(),
      ["customer", "opportunity", "weekly"],
    );
    assert.equal(confirmed.body.quickRecord.status, "confirmed");
    assertApiEntity("customer", confirmed.body.customer);
    assertApiEntity("opportunity", confirmed.body.opportunity);
    assert.equal(confirmed.body.action.sourceRecordId, created.body.item.id);
    assert.match(confirmed.body.customer.syncPreview.join("\n"), /快速记录已确认/);
    assert.match(confirmed.body.opportunity.sourceRecord, new RegExp(created.body.item.id));

    const actions = await request("/api/actions");
    assert.ok(actions.body.items.some((item) => item.sourceRecordId === created.body.item.id));

    const risks = await request("/api/risks");
    assert.equal(risks.response.status, 200);
    assertApiCollection("riskItem", risks.body.items);
    assert.ok(risks.body.items.some((item) => item.sourceType === "quick_record" && item.sourceId === created.body.item.id));
  });

  it("builds a weekly draft from confirmed quick records with source references", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent:
          "日照中医医院需要十五五规划材料，黄岛区中医院需要下周机房调研，两个事项都进入本周周报草稿。",
        occurredAt: "2026-06-05T16:00:00+08:00",
        sourceChannel: "快速记录",
      }),
    });

    await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(created.body.item.version),
        "Idempotency-Key": "api-weekly-draft-source",
      },
      body: JSON.stringify({
        targets: ["weekly"],
        confirmedBy: "继振",
      }),
    });

    const report = await request("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
      }),
    });

    assert.equal(report.response.status, 201);
    assertApiEntity("weeklyReport", report.body.item);
    assert.equal(report.body.item.status, "draft");
    assert.match(report.body.item.content, /本周重点进展/);
    assert.ok(report.body.item.sourceRefs.some((ref) => ref.type === "quick_record"));
  });

  it("adds explicitly selected knowledge references to weekly drafts", async () => {
    const knowledge = await request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: "领导周报可引用的移动云问题口径",
        category: "周报材料",
        tags: ["周报", "移动云"],
        summary: "把移动云平台封闭、计费和数据导出问题整理为管理汇报口径。",
        content: "本周需向管理层同步移动云灾备体验、资源计费和后台权限问题。",
        source: "销售复盘",
      }),
    });

    const report = await request("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
        knowledgeIds: [knowledge.body.item.id],
      }),
    });

    assert.equal(report.response.status, 201);
    assertApiEntity("weeklyReport", report.body.item);
    assert.match(report.body.item.content, /知识库引用/);
    assert.match(report.body.item.content, /领导周报可引用的移动云问题口径/);
    assert.ok(report.body.item.sourceRefs.some((ref) => ref.type === "knowledge" && ref.id === knowledge.body.item.id));
  });

  it("saves edited weekly reports and exports a Word-compatible document", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "周报记录：日照中医医院十五五规划材料已经补齐，需要本周汇报。",
        occurredAt: "2026-06-05T16:00:00+08:00",
        sourceChannel: "快速记录",
      }),
    });
    await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(created.body.item.version),
        "Idempotency-Key": "api-weekly-edit-source",
      },
      body: JSON.stringify({
        targets: ["weekly"],
        confirmedBy: "继振",
      }),
    });

    const report = await request("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
      }),
    });

    const editedContent = "# 已确认周报\n\n本周重点：日照中医医院十五五规划材料已补齐。";
    const saved = await request(`/api/reports/weekly/${report.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(report.body.item.version),
      body: JSON.stringify({
        status: "ready",
        content: editedContent,
      }),
    });
    assert.equal(saved.response.status, 200);
    assertApiEntity("weeklyReport", saved.body.item);
    assert.equal(saved.body.item.status, "ready");
    assert.equal(saved.body.item.content, editedContent);

    const loaded = await request(`/api/reports/weekly/${report.body.item.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.item.status, "ready");

    const exported = await fetch(`${baseUrl}/api/reports/weekly/${report.body.item.id}/export?format=word`);
    const exportedText = await exported.text();
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /application\/msword/);
    assert.match(exported.headers.get("content-disposition") ?? "", /weekly-report-.*\.doc/);
    assert.match(exportedText, /已确认周报/);
    assert.match(exportedText, /日照中医医院十五五规划材料已补齐/);

    const invalid = await request(`/api/reports/weekly/${report.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(saved.body.item.version),
      body: JSON.stringify({ status: "unknown" }),
    });
    assert.equal(invalid.response.status, 422);
  });

  it("uses the configured DeepSeek model when generating weekly drafts", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "日照中医医院周报记录，移动云灾备和十五五规划需要进入本周汇报。",
        occurredAt: "2026-06-05T16:00:00+08:00",
        sourceChannel: "快速记录",
      }),
    });
    await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(created.body.item.version),
        "Idempotency-Key": "api-weekly-model-source",
      },
      body: JSON.stringify({
        targets: ["weekly"],
        confirmedBy: "继振",
      }),
    });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const providerCalls = [];
    server = createServer({
      databaseUrl,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "test-provider-key",
      modelBaseUrl: "https://api.deepseek.com",
      modelName: "deepseek-v4-flash",
      authRequired: false,
      authAccount: "",
      authPassword: "",
      fetchImpl: async (url, options = {}) => {
        providerCalls.push({ url, options });
        return modelTextCompletion("# DeepSeek weekly draft\n\n## 本周重点进展\n模型已提炼周报。");
      },
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const report = await request("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
      }),
    });

    assert.equal(report.response.status, 201);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(providerCalls[0].options.headers.Authorization, "Bearer test-provider-key");
    assert.equal(JSON.parse(providerCalls[0].options.body).model, "deepseek-v4-flash");
    assert.match(report.body.item.content, /DeepSeek weekly draft/);
    assert.doesNotMatch(JSON.stringify(report.body.item), /test-provider-key/);
  });

  it("builds a solution draft from customer, opportunity, and action context", async () => {
    const draft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
      }),
    });

    assert.equal(draft.response.status, 201);
    assertApiEntity("solutionDraft", draft.body.item);
    assert.equal(draft.body.item.artifactType, "solution_framework");
    assert.equal(draft.body.item.customerId, "rizhao");
    assert.equal(draft.body.item.opportunityId, "op-rizhao-plan");
    assert.match(draft.body.item.content, /客户现状与痛点/);
    assert.match(draft.body.item.content, /方案方向/);
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "customer" && ref.id === "rizhao"));
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "opportunity" && ref.id === "op-rizhao-plan"));
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "action"));

    const loaded = await request(`/api/solutions/${draft.body.item.id}`);
    assert.equal(loaded.response.status, 200);
    assertApiEntity("solutionDraft", loaded.body.item);
    assert.equal(loaded.body.item.id, draft.body.item.id);
  });

  it("lists real solution drafts and filters drafts whose opportunity dependency was deleted", async () => {
    const opportunityDraft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "solution-list-test",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
      }),
    });
    const customerDraft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "solution-list-test",
        customerId: "huangdao-tcm",
        opportunityId: "op-huangdao-tcm",
      }),
    });
    assert.equal(opportunityDraft.response.status, 201);
    assert.equal(customerDraft.response.status, 201);

    const listed = await request("/api/solutions");
    assert.equal(listed.response.status, 200);
    assertApiCollection("solutionDraft", listed.body.items);
    assert.ok(listed.body.items.some((item) => item.id === opportunityDraft.body.item.id));
    assert.ok(listed.body.items.some((item) => item.id === customerDraft.body.item.id));

    const opportunities = await request("/api/opportunities");
    const opportunityDependency = opportunities.body.items.find((item) => item.id === "op-rizhao-plan");
    const deletedOpportunity = await request(`/api/opportunities/${opportunityDependency.id}`, {
      method: "DELETE",
      headers: ifMatch(opportunityDependency.version),
    });
    assert.equal(deletedOpportunity.response.status, 200);
    const customers = await request("/api/customers");
    const customerDependency = customers.body.items.find((item) => item.id === "huangdao-tcm");
    const deletedCustomer = await request(`/api/customers/${customerDependency.id}`, {
      method: "DELETE",
      headers: ifMatch(customerDependency.version),
    });
    assert.equal(deletedCustomer.response.status, 200);

    const filtered = await request("/api/solutions");
    assert.equal(filtered.response.status, 200);
    assertApiCollection("solutionDraft", filtered.body.items);
    assert.equal(filtered.body.items.some((item) => item.id === opportunityDraft.body.item.id), false);
    assert.equal(filtered.body.items.some((item) => item.id === customerDraft.body.item.id), false);
  });

  it("generates dedicated solution assistant artifacts by type", async () => {
    const cases = [
      ["communication_outline", /沟通提纲/, /会议目标|开场/],
      ["presales_questions", /售前问题清单/, /基础架构|预算/],
      ["report_outline", /汇报材料大纲/, /领导关注|汇报结构/],
      ["competitive_talk", /竞品应对话术/, /竞品|应对/],
    ];

    for (const [artifactType, titlePattern, contentPattern] of cases) {
      const draft = await request("/api/solutions/draft", {
        method: "POST",
        body: JSON.stringify({
          owner: "继振",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          artifactType,
        }),
      });

      assert.equal(draft.response.status, 201);
      assertApiEntity("solutionDraft", draft.body.item);
      assert.equal(draft.body.item.artifactType, artifactType);
      assert.match(draft.body.item.title, titlePattern);
      assert.match(draft.body.item.content, contentPattern);
      assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "artifact" && ref.id === artifactType));
    }
  });

  it("saves edited solution assistant artifacts", async () => {
    const draft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
        artifactType: "communication_outline",
      }),
    });

    const saved = await request(`/api/solutions/${draft.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(draft.body.item.version),
      body: JSON.stringify({
        content: "# 修改后的沟通提纲\n\n## 会议目标\n确认预算路径。",
        status: "saved",
      }),
    });

    assert.equal(saved.response.status, 200);
    assertApiEntity("solutionDraft", saved.body.item);
    assert.equal(saved.body.item.artifactType, "communication_outline");
    assert.equal(saved.body.item.status, "saved");
    assert.match(saved.body.item.content, /修改后的沟通提纲/);

    const invalid = await request(`/api/solutions/${draft.body.item.id}`, {
      method: "PATCH",
      headers: ifMatch(saved.body.item.version),
      body: JSON.stringify({ status: "unknown" }),
    });
    assert.equal(invalid.response.status, 422);
  });

  it("forces explicitly selected knowledge into solution draft citations", async () => {
    const knowledge = await request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: "胶州迁移割接方案模板",
        category: "方案材料",
        tags: ["迁移", "割接"],
        summary: "用于迁移割接会议，不依赖当前客户关键词自动命中。",
        content: "迁移割接需说明窗口、回退、责任边界和数据校验。",
        source: "售前模板",
      }),
    });

    const draft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
        knowledgeIds: [knowledge.body.item.id],
      }),
    });

    assert.equal(draft.response.status, 201);
    assertApiEntity("solutionDraft", draft.body.item);
    assert.match(draft.body.item.content, /知识库引用/);
    assert.match(draft.body.item.content, /胶州迁移割接方案模板/);
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "knowledge" && ref.id === knowledge.body.item.id));
  });

  it("uses the configured DeepSeek model when generating solution drafts", async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const providerCalls = [];
    server = createServer({
      databaseUrl: join(tempDir, "solution-model.sqlite"),
      seed: true,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "test-provider-key",
      modelBaseUrl: "https://api.deepseek.com/",
      modelName: "deepseek-v4-flash",
      authRequired: false,
      authAccount: "",
      authPassword: "",
      fetchImpl: async (url, options = {}) => {
        providerCalls.push({ url, options });
        return modelTextCompletion("# DeepSeek solution draft\n\n## 客户现状与痛点\n模型已生成方案草稿。\n\n## 知识库引用\n保留来源。");
      },
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const draft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
      }),
    });

    assert.equal(draft.response.status, 201);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(providerCalls[0].options.headers.Authorization, "Bearer test-provider-key");
    assert.equal(JSON.parse(providerCalls[0].options.body).model, "deepseek-v4-flash");
    assert.match(draft.body.item.content, /DeepSeek solution draft/);
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "customer" && ref.id === "rizhao"));
    assert.doesNotMatch(JSON.stringify(draft.body.item), /test-provider-key/);
  });

  it("generates a manual AI suggestion from business context", async () => {
    const suggestion = await request("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "生成客户画像补全建议",
        context: {
          customer: "日照中医医院",
          summary: "客户关注十五五规划、本地数据中心健壮度和移动云灾备。",
        },
      }),
    });

    assert.equal(suggestion.response.status, 201);
    assertApiEntity("aiSuggestion", suggestion.body.item);
    assert.equal(suggestion.body.item.type, "customer_profile");
    assert.match(suggestion.body.item.content, /日照中医医院/);
    assert.ok(suggestion.body.item.sourceRefs.some((ref) => ref.type === "customer_profile"));
  });

  it("uses the configured DeepSeek model when generating manual AI suggestions", async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const providerCalls = [];
    server = createServer({
      databaseUrl: join(tempDir, "suggestion-model.sqlite"),
      seed: true,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "test-provider-key",
      modelBaseUrl: "https://api.deepseek.com/",
      modelName: "deepseek-v4-flash",
      authRequired: false,
      authAccount: "",
      authPassword: "",
      fetchImpl: async (url, options = {}) => {
        providerCalls.push({ url, options });
        return modelTextCompletion("## DeepSeek 建议\n模型已生成客户画像补全建议。");
      },
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const suggestion = await request("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "生成客户画像补全建议",
        context: {
          customer: "日照中医医院",
          summary: "客户关注十五五规划、本地数据中心健壮度和移动云灾备。",
        },
      }),
    });

    assert.equal(suggestion.response.status, 201);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(providerCalls[0].options.headers.Authorization, "Bearer test-provider-key");
    assert.equal(JSON.parse(providerCalls[0].options.body).model, "deepseek-v4-flash");
    assert.match(suggestion.body.item.content, /DeepSeek 建议/);
    assert.doesNotMatch(JSON.stringify(suggestion.body.item), /test-provider-key/);
  });

  it("stores, searches, and cites knowledge items in solution drafts", async () => {
    const listed = await request("/api/knowledge");
    assert.equal(listed.response.status, 200);
    assertApiCollection("knowledgeItem", listed.body.items);
    assert.ok(listed.body.items.some((item) => item.title === "移动云灾备对比清单"));

    const created = await request("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: "日照十五五规划知识卡",
        category: "方案材料",
        tags: ["日照", "十五五", "移动云"],
        summary: "用于把移动云灾备问题转成院内可汇报的规划材料。",
        content: "围绕本地稳态运行、灾备自主权、数据导出和预算路径形成三段式对比。",
        source: "手动沉淀",
      }),
    });
    assert.equal(created.response.status, 201);
    assertApiEntity("knowledgeItem", created.body.item);
    assert.equal(created.body.item.title, "日照十五五规划知识卡");

    const searched = await request("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({
        query: "日照 移动云 十五五",
        tags: ["移动云"],
      }),
    });
    assert.equal(searched.response.status, 200);
    assertApiCollection("knowledgeItem", searched.body.items);
    assert.ok(searched.body.items.some((item) => item.id === created.body.item.id));

    const draft = await request("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        customerId: "rizhao",
        opportunityId: "op-rizhao-plan",
      }),
    });
    assert.equal(draft.response.status, 201);
    assert.match(draft.body.item.content, /知识库引用/);
    assert.match(draft.body.item.content, /日照十五五规划知识卡/);
    assert.ok(draft.body.item.sourceRefs.some((ref) => ref.type === "knowledge" && ref.id === created.body.item.id));
  });

  it("diagnoses opportunity risks and persists traceable risk items", async () => {
    const diagnosed = await request("/api/opportunities/op-rizhao-plan/diagnose-risks", {
      method: "POST",
      body: JSON.stringify({
        sourceType: "manual_audit",
        sourceId: "audit-risk-1",
      }),
    });

    assert.equal(diagnosed.response.status, 201);
    assert.ok(Array.isArray(diagnosed.body.items));
    assert.ok(diagnosed.body.items.length >= 1);
    assertApiEntity("riskItem", diagnosed.body.items[0]);
    assert.equal(diagnosed.body.items[0].opportunityId, "op-rizhao-plan");
    assert.equal(diagnosed.body.items[0].sourceType, "manual_audit");
    assert.equal(diagnosed.body.items[0].sourceId, "audit-risk-1");
    assert.match(diagnosed.body.items.map((item) => item.evidence).join("\n"), /预算|移动云|数据自主权/);

    const risks = await request("/api/risks");
    assert.equal(risks.response.status, 200);
    assertApiCollection("riskItem", risks.body.items);
    assert.ok(risks.body.items.some((item) => item.sourceId === "audit-risk-1"));
  });

  it("keeps identical diagnosed risk source identities separate across opportunities", async () => {
    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({
        customerId: "rizhao",
        name: "Second planning opportunity",
        customer: "Rizhao",
        stage: "planning",
        amount: "pending",
        owner: "Task 9 tester",
        probability: 30,
        days: 0,
        requirements: ["budget approval"],
        competitors: [],
        solutionDirection: [],
      }),
    });
    assert.equal(createdOpportunity.response.status, 201);

    const diagnosisBody = JSON.stringify({
      sourceType: "shared_manual_audit",
      sourceId: "shared-risk-source",
    });
    const first = await request("/api/opportunities/op-rizhao-plan/diagnose-risks", {
      method: "POST",
      body: diagnosisBody,
    });
    const second = await request(
      `/api/opportunities/${createdOpportunity.body.item.id}/diagnose-risks`,
      { method: "POST", body: diagnosisBody },
    );
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);

    const firstByTitle = new Map(first.body.items.map((item) => [item.title, item]));
    const secondRisk = second.body.items.find((item) => firstByTitle.has(item.title));
    assert.ok(secondRisk, "expected both opportunities to generate at least one identical risk title");
    const firstRisk = firstByTitle.get(secondRisk.title);
    assert.notEqual(secondRisk.id, firstRisk.id);
    assert.equal(firstRisk.opportunityId, "op-rizhao-plan");
    assert.equal(secondRisk.opportunityId, createdOpportunity.body.item.id);

    const risks = await request("/api/risks");
    const persisted = risks.body.items.filter((item) =>
      item.title === secondRisk.title &&
      item.sourceType === "shared_manual_audit" &&
      item.sourceId === "shared-risk-source");
    assert.equal(persisted.length, 2);
    assert.deepEqual(
      persisted.map((item) => item.opportunityId).sort(),
      ["op-rizhao-plan", createdOpportunity.body.item.id].sort(),
    );
  });

  it("transitions risk status with a persisted handling note", async () => {
    const diagnosed = await request("/api/opportunities/op-rizhao-plan/diagnose-risks", {
      method: "POST",
      body: JSON.stringify({
        sourceType: "manual_audit",
        sourceId: "audit-risk-status",
      }),
    });
    const risk = diagnosed.body.items[0];

    const started = await request(`/api/risks/${risk.id}`, {
      method: "PATCH",
      headers: ifMatch(risk.version),
      body: JSON.stringify({
        status: "in_progress",
        assignee: "售前李工",
        due: "周三 18:00",
        action: "已安排售前和销售共同确认预算路径。",
      }),
    });
    assert.equal(started.response.status, 200);
    assertApiEntity("riskItem", started.body.item);
    assert.equal(started.body.item.status, "in_progress");
    assert.equal(started.body.item.assignee, "售前李工");
    assert.equal(started.body.item.due, "周三 18:00");
    assert.match(started.body.item.action, /售前/);

    const deferred = await request(`/api/risks/${risk.id}`, {
      method: "PATCH",
      headers: ifMatch(started.body.item.version),
      body: JSON.stringify({
        status: "deferred",
        action: "客户会议延期，风险处理顺延到下周。",
        assignee: "售前李工",
        due: "下周一 10:00",
      }),
    });
    assert.equal(deferred.response.status, 200);
    assert.equal(deferred.body.item.status, "deferred");
    assert.equal(deferred.body.item.due, "下周一 10:00");

    const closed = await request(`/api/risks/${risk.id}`, {
      method: "PATCH",
      headers: ifMatch(deferred.body.item.version),
      body: JSON.stringify({
        status: "closed",
        assignee: "继振",
        action: "客户已确认预算路径，风险关闭。",
      }),
    });
    assert.equal(closed.response.status, 200);
    assert.equal(closed.body.item.status, "closed");
    assert.equal(closed.body.item.assignee, "继振");

    const invalid = await request(`/api/risks/${risk.id}`, {
      method: "PATCH",
      headers: ifMatch(closed.body.item.version),
      body: JSON.stringify({ status: "unknown" }),
    });
    assert.equal(invalid.response.status, 422);

    const risks = await request("/api/risks");
    assert.ok(risks.body.items.some((item) => item.id === risk.id && item.status === "closed" && item.assignee === "继振" && item.due === "下周一 10:00"));
  });

  it("updates action owner, due date, and status with validation", async () => {
    const actionsBefore = await request("/api/actions");
    assert.equal(actionsBefore.response.status, 200);
    const action = actionsBefore.body.items[0];
    assertApiEntity("actionItem", action);

    const updated = await request(`/api/actions/${action.id}`, {
      method: "PATCH",
      headers: ifMatch(action.version),
      body: JSON.stringify({
        status: "deferred",
        due: "周五 17:00",
        assignee: "售前李工",
      }),
    });
    assert.equal(updated.response.status, 200);
    assertApiEntity("actionItem", updated.body.item);
    assert.equal(updated.body.item.status, "deferred");
    assert.equal(updated.body.item.due, "周五 17:00");
    assert.equal(updated.body.item.assignee, "售前李工");

    const completed = await request(`/api/actions/${action.id}`, {
      method: "PATCH",
      headers: ifMatch(updated.body.item.version),
      body: JSON.stringify({
        status: "done",
        assignee: "继振",
      }),
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.item.status, "done");
    assert.equal(completed.body.item.assignee, "继振");

    const invalid = await request(`/api/actions/${action.id}`, {
      method: "PATCH",
      headers: ifMatch(completed.body.item.version),
      body: JSON.stringify({ status: "blocked" }),
    });
    assert.equal(invalid.response.status, 422);

    const actionsAfter = await request("/api/actions");
    assert.ok(actionsAfter.body.items.some((item) => item.id === action.id && item.status === "done" && item.assignee === "继振"));
  });

  it("records auditable business operations without exposing model secrets", async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    server = createServer({
      databaseUrl: join(tempDir, "audit-log.sqlite"),
      seed: true,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
      modelApiKey: "test-provider-key",
      modelBaseUrl: "https://api.deepseek.com",
      modelName: "deepseek-v4-flash",
      authRequired: false,
      authAccount: "",
      authPassword: "",
      fetchImpl: async () => modelTextCompletion("## DeepSeek 建议\n已生成可审计建议。"),
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const customer = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({
        name: "审计测试医院",
        region: "青岛",
        type: "医疗 KA",
        level: "重点培育",
        owner: "继振",
        contact: "信息科",
      }),
    });
    assert.equal(customer.response.status, 201);

    const action = (await request("/api/actions")).body.items[0];
    const actionUpdate = await request(`/api/actions/${action.id}`, {
      method: "PATCH",
      headers: ifMatch(action.version),
      body: JSON.stringify({
        status: "done",
        assignee: "继振",
        due: "周五 17:00",
      }),
    });
    assert.equal(actionUpdate.response.status, 200);

    const suggestion = await request("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "生成客户画像补全建议",
        context: {
          customer: "审计测试医院",
          summary: "需要补全画像和预算路径。",
        },
      }),
    });
    assert.equal(suggestion.response.status, 201);

    const logs = await request("/api/audit-logs");
    assert.equal(logs.response.status, 200);
    assert.ok(Array.isArray(logs.body.items));
    assert.ok(logs.body.items.length >= 3);
    assert.ok(logs.body.items.some((item) => item.action === "customer.create" && item.entityId === customer.body.item.id));
    assert.ok(logs.body.items.some((item) => item.action === "action.update" && item.entityId === action.id));
    assert.ok(logs.body.items.some((item) => item.action === "ai.suggestion.generate" && item.entityId === suggestion.body.item.id));
    assert.doesNotMatch(JSON.stringify(logs.body), /test-provider-key/);

    const customerLogs = await request(`/api/audit-logs?entityType=customer&entityId=${customer.body.item.id}`);
    assert.equal(customerLogs.response.status, 200);
    assert.ok(customerLogs.body.items.length >= 1);
    assert.ok(customerLogs.body.items.every((item) => item.entityType === "customer" && item.entityId === customer.body.item.id));
  });
});
