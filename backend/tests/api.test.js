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
import {
  addDays,
  shanghaiDateParts,
  weekStartOf,
} from "../src/dailyDigest/digestContent.js";
import { openDatabase } from "../src/db.js";
import { createHospitalTenderRepository } from "../src/hospitalTender/repository.js";
import { KNOWN_STAGES } from "../src/opportunities/stageVocabulary.js";
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
    solutionWritesEnabled: true,
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
      // v0.9.2：种子 owner 词表统一为账号 id，机器身份对齐 jiangjz。
      weixinAgentOwner: "jiangjz",
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
    assert.deepEqual(
      summary.body.item.stageCounts.slice(0, KNOWN_STAGES.length).map((item) => item.stage),
      [...KNOWN_STAGES],
    );
    assert.ok(summary.body.item.stageCounts.every((item) => typeof item.amount === "string"));
    assert.match(summary.body.item.todayFocus.date, /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(summary.body.item.weeklyTrend.weekStart, weekStartOf(summary.body.item.todayFocus.date));
    assert.equal(
      summary.body.item.weeklyTrend.previousWeekStart,
      addDays(summary.body.item.weeklyTrend.weekStart, -7),
    );
  });

  it("aggregates today focus, natural-week trend, and the fixed-order stage funnel", async () => {
    await new Promise((resolve) => server.close(resolve));
    const dashboardDbUrl = join(tempDir, "dashboard.sqlite");
    const db = openDatabase({ databaseUrl: dashboardDbUrl });
    const now = new Date();
    const today = shanghaiDateParts(now).date;
    const weekStart = weekStartOf(today);
    const previousWeekStart = addDays(weekStart, -7);
    const shanghaiIso = (dateOnly, time) => new Date(`${dateOnly}T${time}+08:00`).toISOString();

    db.prepare("INSERT INTO customers (id, name, owner, relation) VALUES ('cus-dash', '济宁市第一人民医院', '继振', 80)").run();
    const insertOpportunity = db.prepare(
      "INSERT INTO opportunities (id, customer_id, name, stage, amount, probability, owner) VALUES ($id, 'cus-dash', $name, $stage, $amount, 60, 'jiangjz')",
    );
    insertOpportunity.run({ $id: "op-dash-1", $name: "济宁智慧医院一期", $stage: "线索", $amount: "120 万" });
    insertOpportunity.run({ $id: "op-dash-2", $name: "济宁智慧医院二期", $stage: "线索", $amount: "预计 200 万" });
    insertOpportunity.run({ $id: "op-dash-3", $name: "预算确认中项目", $stage: "预算确认", $amount: "80万" });
    insertOpportunity.run({ $id: "op-dash-4", $name: "词表外阶段项目", $stage: "招投标", $amount: "待定" });

    const planJson = JSON.stringify({
      stops: [
        { id: "stop-2", customerName: "济宁医学院附属医院" },
        { id: "stop-1", customerName: "济宁市第一人民医院", city: "济宁" },
      ],
      orderedStopIds: ["stop-1", "stop-2"],
    });
    const insertItinerary = db.prepare(`
      INSERT INTO visit_itineraries (id, title, visit_date, status, request_json, plan_json, created_by, updated_by)
      VALUES ($id, $title, $visitDate, $status, '{}', $planJson, '继振', '继振')
    `);
    insertItinerary.run({ $id: "itn-dash-today", $title: "济宁两院拜访", $visitDate: today, $status: "planned", $planJson: planJson });
    insertItinerary.run({ $id: "itn-dash-cancelled", $title: "已取消行程", $visitDate: today, $status: "cancelled", $planJson: planJson });
    insertItinerary.run({ $id: "itn-dash-past", $title: "昨日行程", $visitDate: addDays(today, -1), $status: "planned", $planJson: planJson });

    const insertAction = db.prepare(`
      INSERT INTO action_items (id, title, priority, status, remind_at, updated_at, owner)
      VALUES ($id, $title, $priority, $status, $remindAt, $updatedAt, 'jiangjz')
    `);
    insertAction.run({ $id: "act-dash-overdue", $title: "逾期回访", $priority: "高", $status: "pending", $remindAt: shanghaiIso(addDays(today, -1), "10:00:00"), $updatedAt: shanghaiIso(addDays(today, -1), "10:00:00") });
    insertAction.run({ $id: "act-dash-today", $title: "今日送方案", $priority: "中", $status: "in_progress", $remindAt: shanghaiIso(today, "23:00:00"), $updatedAt: shanghaiIso(today, "08:00:00") });
    insertAction.run({ $id: "act-dash-unscheduled", $title: "未排期待办", $priority: "低", $status: "pending", $remindAt: null, $updatedAt: shanghaiIso(today, "08:00:00") });
    // Completed todos exercise both historic updated_at formats and both
    // BETWEEN endpoints of each natural week.
    insertAction.run({ $id: "act-dash-done-monday", $title: "本周一完成", $priority: "中", $status: "done", $remindAt: null, $updatedAt: `${weekStart} 10:00:00` });
    insertAction.run({ $id: "act-dash-done-sunday", $title: "本周日完成", $priority: "中", $status: "done", $remindAt: null, $updatedAt: `${addDays(weekStart, 6)}T09:00:00.000Z` });
    insertAction.run({ $id: "act-dash-done-prev-monday", $title: "上周一完成", $priority: "中", $status: "done", $remindAt: null, $updatedAt: `${previousWeekStart}T08:00:00.000Z` });
    insertAction.run({ $id: "act-dash-done-prev-sunday", $title: "上周日完成", $priority: "中", $status: "done", $remindAt: null, $updatedAt: `${addDays(weekStart, -1)} 21:00:00` });

    db.prepare(`
      INSERT INTO risk_items (id, customer_id, title, target, severity, status, score, due, evidence, action)
      VALUES ('risk-dash-high', 'cus-dash', '预算路径未确认', '商机', '高', 'open', 86, '本周五', '会议纪要', '尽快对齐')
    `).run();

    const insertQuickRecord = db.prepare(
      "INSERT INTO quick_records (id, raw_content, occurred_at, status, owner) VALUES ($id, $rawContent, $occurredAt, 'recorded', 'jiangjz')",
    );
    insertQuickRecord.run({ $id: "qr-dash-monday", $rawContent: "周一拜访记录", $occurredAt: `${weekStart}T09:00:00+08:00` });
    insertQuickRecord.run({ $id: "qr-dash-sunday", $rawContent: "周日电话记录", $occurredAt: `${addDays(weekStart, 6)}T21:00:00+08:00` });
    insertQuickRecord.run({ $id: "qr-dash-prev", $rawContent: "上周记录", $occurredAt: `${addDays(weekStart, -3)}T09:00:00+08:00` });
    db.prepare(
      "INSERT INTO quick_records (id, raw_content, occurred_at, status, voided_at, owner) VALUES ('qr-dash-voided', '已作废记录', $occurredAt, 'recorded', $voidedAt, 'jiangjz')",
    ).run({ $occurredAt: `${weekStart}T10:00:00+08:00`, $voidedAt: shanghaiIso(today, "12:00:00") });

    const insertExpense = db.prepare(`
      INSERT INTO travel_expenses (id, reference_code, owner, occurred_on, category, purpose, invoice_status, created_by, updated_by, deleted_at)
      VALUES ($id, $ref, '继振', $occurredOn, 'transport', $purpose, 'pending', '继振', '继振', $deletedAt)
    `);
    const insertPayment = db.prepare(`
      INSERT INTO travel_expense_payments (id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents, funding_source, payment_method)
      VALUES ($id, $expenseId, 1, $paidAt, $cents, $cents, 'personal', 'wechat')
    `);
    insertExpense.run({ $id: "exp-dash-monday", $ref: "EXP-DASH-1", $occurredOn: weekStart, $purpose: "周一打车", $deletedAt: null });
    insertPayment.run({ $id: "exp-dash-monday-pay", $expenseId: "exp-dash-monday", $paidAt: `${weekStart}T10:00:00+08:00`, $cents: 4500 });
    insertExpense.run({ $id: "exp-dash-sunday", $ref: "EXP-DASH-2", $occurredOn: addDays(weekStart, 6), $purpose: "周日住宿", $deletedAt: null });
    insertPayment.run({ $id: "exp-dash-sunday-pay", $expenseId: "exp-dash-sunday", $paidAt: `${addDays(weekStart, 6)}T10:00:00+08:00`, $cents: 5500 });
    insertExpense.run({ $id: "exp-dash-prev", $ref: "EXP-DASH-3", $occurredOn: addDays(weekStart, -2), $purpose: "上周晚餐", $deletedAt: null });
    insertPayment.run({ $id: "exp-dash-prev-pay", $expenseId: "exp-dash-prev", $paidAt: `${addDays(weekStart, -2)}T19:00:00+08:00`, $cents: 61200 });
    insertExpense.run({ $id: "exp-dash-deleted", $ref: "EXP-DASH-4", $occurredOn: weekStart, $purpose: "已删除费用", $deletedAt: shanghaiIso(today, "12:00:00") });
    insertPayment.run({ $id: "exp-dash-deleted-pay", $expenseId: "exp-dash-deleted", $paidAt: `${weekStart}T11:00:00+08:00`, $cents: 99900 });

    const tenderRepository = createHospitalTenderRepository(db, { clock: () => now });
    const seedNotice = (id, relevance) => tenderRepository.upsertNotice({
      id,
      identityKey: `source-dash:${id}`,
      sourceId: "source-dash",
      sourceName: "山东政采",
      city: "济宁市",
      title: `济宁市第一人民医院信息化采购（${id}）`,
      url: `https://example.com/${id}`,
      publishedAt: now.toISOString(),
      noticeType: "tender",
      hospitalNames: ["济宁市第一人民医院"],
      sourceItemId: id,
      contentSha256: "a".repeat(64),
      relevance,
      deadlineText: "2026-09-05",
    });
    seedNotice("notice-dash-high", "high");
    seedNotice("notice-dash-medium", "medium");
    db.close();

    server = createServer({
      databaseUrl: dashboardDbUrl,
      seed: false,
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authRequired: false,
      authAccount: "",
      authPassword: "",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const summary = await request("/api/dashboard/summary");
    assert.equal(summary.response.status, 200);
    assertApiEntity("dashboardSummary", summary.body.item);

    const { todayFocus, weeklyTrend, stageCounts } = summary.body.item;
    assert.equal(todayFocus.date, today);
    assert.equal(todayFocus.itineraries.count, 1);
    assert.deepEqual(todayFocus.itineraries.items, [
      { id: "itn-dash-today", title: "济宁两院拜访", firstStop: "济宁市第一人民医院" },
    ]);
    assert.equal(todayFocus.todos.overdueCount, 1);
    assert.equal(todayFocus.todos.todayCount, 1);
    assert.deepEqual(todayFocus.todos.items.map((item) => [item.id, item.overdue]), [
      ["act-dash-overdue", true],
      ["act-dash-today", false],
    ]);
    assert.equal(todayFocus.risks.count, 1);
    assert.deepEqual(todayFocus.risks.items, [{
      id: "risk-dash-high",
      customerName: "济宁市第一人民医院",
      title: "预算路径未确认",
      score: 86,
      severity: "高",
    }]);
    assert.equal(todayFocus.tenders.highCount, 1);
    assert.deepEqual(todayFocus.tenders.items, [
      { id: "notice-dash-high", title: "济宁市第一人民医院信息化采购（notice-dash-high）", sourceName: "山东政采" },
    ]);

    assert.deepEqual(weeklyTrend, {
      weekStart,
      previousWeekStart,
      quickRecords: { current: 2, previous: 1 },
      expenseCents: { current: 10000, previous: 61200 },
      completedTodos: { current: 2, previous: 2 },
    });

    assert.deepEqual(
      stageCounts.slice(0, KNOWN_STAGES.length).map((item) => item.stage),
      [...KNOWN_STAGES],
    );
    assert.deepEqual(stageCounts.find((item) => item.stage === "线索"), { stage: "线索", count: 2, amount: "共 320 万" });
    assert.deepEqual(stageCounts.find((item) => item.stage === "预算确认"), { stage: "预算确认", count: 1, amount: "共 80 万" });
    assert.deepEqual(stageCounts.find((item) => item.stage === "初步沟通"), { stage: "初步沟通", count: 0, amount: "" });
    assert.deepEqual(stageCounts.at(-1), { stage: "招投标", count: 1, amount: "" });
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
        contact: "信息科 / 待确认",
        relation: 35,
        needs: ["未来规划初访"],
        risks: ["决策链待补齐"],
        opportunities: [],
        aliases: ["胶州医院别名"],
        tags: ["客户验收"],
      }),
    });

    assert.equal(createdCustomer.response.status, 201);
    assertApiEntity("customer", createdCustomer.body.item);
    assert.equal(createdCustomer.body.item.name, "胶州中医医院");
    assert.deepEqual(createdCustomer.body.item.aliases, ["胶州医院别名"]);
    assert.deepEqual(createdCustomer.body.item.tags, ["客户验收"]);
    assert.equal(typeof createdCustomer.body.item.createdAt, "string");
    assert.equal(typeof createdCustomer.body.item.updatedAt, "string");

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
    assert.deepEqual(updatedCustomer.body.item.aliases, createdCustomer.body.item.aliases);
    assert.deepEqual(updatedCustomer.body.item.tags, createdCustomer.body.item.tags);
    assert.equal(updatedCustomer.body.item.createdAt, createdCustomer.body.item.createdAt);
    const loadedCustomer = await request(`/api/customers/${createdCustomer.body.item.id}`);
    assert.equal(loadedCustomer.response.status, 200);
    assertApiEntity("customer", loadedCustomer.body.item);
    assert.deepEqual(loadedCustomer.body.item, updatedCustomer.body.item);

    const createdOpportunity = await request("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({
        customerId: createdCustomer.body.item.id,
        name: "胶州中医医院规划调研",
        customer: "胶州中医医院",
        stage: "线索",
        amount: "待定",
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

    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    assert.equal(analyzed.response.status, 201);

    const confirmed = await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(analyzed.body.quickRecord.version),
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
    // v0.9.0 L0 transition: the deep write-back assignee inherits the record
    // owner (account id) instead of the historical hard-coded display name.
    assert.equal(confirmed.body.action.assignee, confirmed.body.quickRecord.owner);
    assert.ok(confirmed.body.action.assignee);
    assert.notEqual(confirmed.body.action.assignee, "继振");
    assert.match(confirmed.body.customer.syncPreview.join("\n"), /快速记录已确认/);
    assert.match(confirmed.body.opportunity.sourceRecord, new RegExp(created.body.item.id));

    const actions = await request("/api/actions");
    assert.ok(actions.body.items.some((item) => item.sourceRecordId === created.body.item.id));

    const risks = await request("/api/risks");
    assert.equal(risks.response.status, 200);
    assertApiCollection("riskItem", risks.body.items);
    assert.ok(risks.body.items.some((item) => item.sourceType === "quick_record" && item.sourceId === created.body.item.id));
  });

  it("writes the users.display_name into the confirmed deep write-back assignee", async () => {
    // v0.9.1：登录用户确认快速记录后，动作展示列 assignee 应为 users.display_name（继振）。
    const passwordField = "pass" + "word";
    const loginValue = "unit-login-value";
    await new Promise((resolve) => server.close(resolve));
    const { hashPassword } = await import("../src/auth/password.js");
    server = createServer({
      databaseUrl: join(tempDir, "assignee-display.sqlite"),
      seed: true,
      aiAnalysisMode: "mock",
      modelApiKey: "",
      nodeEnv: "test",
      authRequired: true,
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword(loginValue, { salt: Buffer.alloc(16, 31) }),
      authSessionSecret: Buffer.alloc(32, 32).toString("base64url"),
      authCookieSecure: false,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const loggedIn = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "jiangjz", [passwordField]: loginValue }),
    });
    assert.equal(loggedIn.response.status, 200);
    const authHeaders = {
      Cookie: String(loggedIn.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
      "X-CSRF-Token": loggedIn.body.csrfToken,
    };

    const created = await request("/api/quick-records", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        rawContent: "黄岛区中医院下周需要带售前做双活机房调研，并进入本周周报。",
        occurredAt: "2026-08-29T10:00:00+08:00",
        sourceChannel: "现场拜访",
      }),
    });
    assert.equal(created.response.status, 201);
    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.equal(analyzed.response.status, 201);
    const confirmed = await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...authHeaders,
        ...ifMatch(analyzed.body.quickRecord.version),
        "Idempotency-Key": "api-confirm-display-name",
      },
      body: JSON.stringify({
        targets: ["customer", "opportunity"],
        confirmedBy: "继振",
        targetVersions: { customer: 1, opportunity: 1 },
      }),
    });
    assert.equal(confirmed.response.status, 201);
    assert.equal(confirmed.body.quickRecord.owner, "jiangjz");
    assert.equal(confirmed.body.action.assignee, "继振");
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

    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    assert.equal(analyzed.response.status, 201);
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(analyzed.body.quickRecord.version),
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
    assert.equal(report.body.item.source, "deterministic");
    assert.equal(report.body.item.fallbackReason, null);
    assert.match(report.body.item.content, /本周重点进展/);
    assert.ok(report.body.item.sourceRefs.some((ref) => ref.type === "quick_record"));
  });

  it("includes completed durable quick-record previews in weekly drafts", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent:
          "日照中医医院需要十五五规划材料，确认预览完成后也要进入本周周报草稿。",
        occurredAt: "2026-06-05T16:00:00+08:00",
        sourceChannel: "快速记录",
      }),
    });

    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, {
      method: "POST",
    });
    assert.equal(analyzed.response.status, 201, JSON.stringify(analyzed.body));
    const preview = await request(`/api/quick-records/${created.body.item.id}/confirmation-previews`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(preview.response.status, 201, JSON.stringify({
      analyzed: analyzed.body,
      preview: preview.body,
    }));
    const confirmed = await request(`/api/quick-record-confirmation-previews/${preview.body.item.id}/confirm-all`, {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        suggestionIdentity: preview.body.item.identity,
        expectedQuickRecordVersion: analyzed.body.quickRecord.version,
        analysisVersionId: preview.body.item.analysisVersionId,
        summaryHash: preview.body.item.summaryHash,
        evidenceHash: preview.body.item.evidenceHash,
      }),
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));

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
    assert.ok(report.body.item.sourceRefs.some((ref) => ref.type === "quick_record" && ref.id === created.body.item.id));
  });

  it("excludes recorded WeChat quick records from weekly drafts until analyzed", async () => {
    const created = await request("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent: "尚未分析的微信记录不应进入周报。",
        occurredAt: "2026-06-05T16:00:00+08:00",
        sourceChannel: "微信助手",
      }),
    });
    assert.equal(created.response.status, 201);
    const maintenanceDb = openDatabase({ databaseUrl });
    try {
      maintenanceDb.prepare(
        "UPDATE quick_records SET status = 'recorded' WHERE id = $id",
      ).run({ $id: created.body.item.id });
    } finally {
      maintenanceDb.close();
    }

    const report = await request("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
      }),
    });
    assert.equal(report.response.status, 201);
    assert.equal(
      report.body.item.sourceRefs.some((ref) => ref.type === "quick_record" && ref.id === created.body.item.id),
      false,
    );
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
    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    assert.equal(analyzed.response.status, 201);
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(analyzed.body.quickRecord.version),
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
    const contentDisposition = exported.headers.get("content-disposition") ?? "";
    assert.match(contentDisposition, /^attachment; filename\*=UTF-8''weekly-report-.*\.doc$/);
    assert.doesNotMatch(contentDisposition, /[\r\n"]/);
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
    const analyzed = await request(`/api/quick-records/${created.body.item.id}/analyze`, { method: "POST" });
    assert.equal(analyzed.response.status, 201);
    await request(`/api/quick-records/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: {
        ...ifMatch(analyzed.body.quickRecord.version),
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
    assert.equal(report.body.item.source, "deepseek");
    assert.equal(report.body.item.fallbackReason, null);
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
      solutionWritesEnabled: true,
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
    assert.equal(draft.body.item.source, "deepseek");
    assert.equal(draft.body.item.fallbackReason, null);
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
    assert.equal(suggestion.body.item.source, "deepseek");
    assert.equal(suggestion.body.item.fallbackReason, null);
    assert.doesNotMatch(JSON.stringify(suggestion.body.item), /test-provider-key/);
  });

  it("persists a bounded fallback reason when a direct suggestion has no model key", async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    server = createServer({
      databaseUrl,
      aiAnalysisMode: "model",
      modelProvider: "deepseek",
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

    const suggestion = await request("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        type: "customer_profile",
        title: "缺少模型 Key 时的建议",
        context: { customer: "日照中医医院" },
      }),
    });

    assert.equal(suggestion.response.status, 201);
    assert.equal(suggestion.body.item.source, "fallback");
    assert.equal(suggestion.body.item.fallbackReason, "manual_suggestion_missing_model_key");

    const history = await request("/api/ai/suggestions?sourceId=manual");
    assert.equal(history.response.status, 200);
    assert.equal(history.body.items[0].source, "fallback");
    assert.equal(history.body.items[0].fallbackReason, "manual_suggestion_missing_model_key");
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
