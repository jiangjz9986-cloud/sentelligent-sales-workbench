import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createMockAmapClient } from "../src/maps/amapMockClient.js";
import { createServer } from "../src/server.js";

// v0.9.2 隔离矩阵（测试先写：现状越权即红，实施后全绿）。双账号夹具：
// A=jiangjz（admin，0030/启动兜底种子），B=testb（member，经 admin API 建号）。
// 契约红线：跨账号一律 404（绝不 409/currentVersion 泄露）、全部 POST 忽略/拒绝
// body owner、机器路径（weixin-agent）行为不变。

const passwordField = "pass" + "word";
const loginValueA = "matrix-login-secret-a";
const loginValueB = "matrix-login-secret-b";
const machineToken = "test-machine-token";
const allowedOrigin = "https://sales.example.test";

let tempDir;
let server;
let baseUrl;
let db;
let sessionA;
let sessionB;

// A 的固定数据集（fixture 建立后全程只读，各域断言引用）。
const fixtures = {};

async function rawRequest(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function sessionRequest(session) {
  return (path, options = {}) => rawRequest(path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

const asA = (path, options) => sessionRequest(sessionA)(path, options);
const asB = (path, options) => sessionRequest(sessionB)(path, options);
const asMachine = (path, options = {}) => rawRequest(path, {
  ...options,
  headers: { Authorization: `Bearer ${machineToken}`, ...(options.headers ?? {}) },
});

function versionHeader(version) {
  return { "If-Match": `"${version}"` };
}

async function login(account, secret) {
  const result = await rawRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: secret }),
  });
  assert.equal(result.response.status, 200, `login ${account}`);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
    account,
  };
}

// 契约红线断言器：跨账号写入必须 404 且响应体绝不携带 currentVersion（版本探测
// 面）。正确与错误的 expectedVersion 都必须得到同一响应，防枚举与防区分。
async function expectCrossWrite404(path, { version, patchBody = "{}" }) {
  const rightVersion = await asB(path, {
    method: "PATCH",
    headers: versionHeader(version),
    body: patchBody,
  });
  assert.equal(rightVersion.response.status, 404, `B PATCH ${path} right version`);
  assert.equal(JSON.stringify(rightVersion.body).includes("currentVersion"), false, `B PATCH ${path} leaks currentVersion`);
  const wrongVersion = await asB(path, {
    method: "PATCH",
    headers: versionHeader(version + 7),
    body: patchBody,
  });
  assert.equal(wrongVersion.response.status, 404, `B PATCH ${path} wrong version`);
  const deleted = await asB(path, {
    method: "DELETE",
    headers: versionHeader(version),
  });
  assert.equal(deleted.response.status, 404, `B DELETE ${path}`);
}

describe("owner isolation matrix (v0.9.2)", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sent-owner-matrix-"));
    const databaseUrl = join(tempDir, "matrix.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword(loginValueA, { salt: Buffer.alloc(16, 9) }),
      authSessionSecret: Buffer.alloc(32, 6).toString("base64url"),
      authCookieSecure: false,
      corsAllowedOrigins: [allowedOrigin],
      weixinAgentApiToken: machineToken,
      weixinAgentOwner: "jiangjz",
      amapClient: createMockAmapClient(),
      solutionWritesEnabled: true,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    db = createConnection({ databaseUrl });

    sessionA = await login("jiangjz", loginValueA);
    const created = await asA("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        account: "testb",
        displayName: "同事乙",
        [passwordField]: loginValueB,
        role: "member",
      }),
    });
    assert.equal(created.response.status, 201, "create testb");
    sessionB = await login("testb", loginValueB);

    // —— A 的业务数据集（各域一行）——
    const customer = await asA("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "A客户-隔离矩阵", region: "济南", summary: "移动云灾备评估" }),
    });
    assert.equal(customer.response.status, 201, "A create customer");
    fixtures.customer = customer.body.item;

    const opportunity = await asA("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id, name: "A商机-隔离矩阵", stage: "调研机会" }),
    });
    assert.equal(opportunity.response.status, 201, "A create opportunity");
    fixtures.opportunity = opportunity.body.item;

    const knowledge = await asA("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({ title: "A知识-移动云灾备对比矩阵", category: "话术材料", summary: "对比清单" }),
    });
    assert.equal(knowledge.response.status, 201, "A create knowledge");
    fixtures.knowledge = knowledge.body.item;

    const quickRecord = await asA("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({ rawContent: "拜访A客户，确认预算窗口，下一步补齐方案材料。", customerId: fixtures.customer.id }),
    });
    assert.equal(quickRecord.response.status, 201, "A create quick record");
    fixtures.quickRecord = quickRecord.body.item;

    const confirmWeekly = await asA(`/api/quick-records/${fixtures.quickRecord.id}/confirm`, {
      method: "POST",
      headers: { ...versionHeader(fixtures.quickRecord.version), "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ targets: ["weekly"] }),
    });
    assert.equal(confirmWeekly.response.status, 201, "A confirm quick record to weekly");
    fixtures.quickRecord = confirmWeekly.body.quickRecord;

    const weekly = await asA("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({ periodStart: "2026-08-24", periodEnd: "2026-08-30" }),
    });
    assert.equal(weekly.response.status, 201, "A weekly draft");
    fixtures.weekly = weekly.body.item;

    const solution = await asA("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id, opportunityId: fixtures.opportunity.id }),
    });
    assert.equal(solution.response.status, 201, "A solution draft");
    fixtures.solution = solution.body.item;

    const itinerary = await asA("/api/itineraries", {
      method: "POST",
      body: JSON.stringify({
        title: "A行程-隔离矩阵",
        visitDate: "2026-09-01",
        departureAddress: "青岛市黄岛区江山路 100 号",
        departureCity: "青岛",
        departureAt: "2026-09-01T08:30:00+08:00",
        stops: [{
          id: "stop-1",
          customerId: fixtures.customer.id,
          customerName: "A客户-隔离矩阵",
          address: "青岛市黄岛区长江路 200 号",
          city: "青岛",
          priority: "high",
          visitMinutes: 60,
        }],
      }),
    });
    assert.equal(itinerary.response.status, 201, "A create itinerary");
    fixtures.itinerary = itinerary.body.item;

    const decision = await asA("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id, analysisType: "customer_analysis" }),
    });
    assert.equal(decision.response.status, 201, "A sales decision");
    fixtures.decision = decision.body.item;

    const suggestion = await asA("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({ type: "knowledge_talk", title: "A建议-隔离矩阵" }),
    });
    assert.equal(suggestion.response.status, 201, "A ai suggestion");
    fixtures.suggestion = suggestion.body.item;

    // 行动/风险没有 Web POST 端点：按生产等价形态直插（owner=jiangjz，触发器要求非空）。
    fixtures.action = { id: "action-matrix-a", version: 1 };
    db.prepare(`
      INSERT INTO action_items (id, customer_id, opportunity_id, title, customer, reason, due, priority, status, tone, owner, remind_at)
      VALUES ($id, $customerId, $opportunityId, 'A待办-隔离矩阵', 'A客户-隔离矩阵', '矩阵夹具', '今天 18:00', '高', 'pending', 'red', 'jiangjz', $remindAt)
    `).run({
      $id: fixtures.action.id,
      $customerId: fixtures.customer.id,
      $opportunityId: fixtures.opportunity.id,
      $remindAt: new Date(Date.now() - 60_000).toISOString(),
    });
    fixtures.risk = { id: "risk-matrix-a", version: 1 };
    db.prepare(`
      INSERT INTO risk_items (id, customer_id, opportunity_id, title, target, score, severity, status, evidence, action, source_type, source_id, tone, owner)
      VALUES ($id, $customerId, $opportunityId, 'A风险-隔离矩阵', 'A客户/A商机', 86, '高', 'open', '矩阵夹具证据', '确认预算路径', 'opportunity', $opportunityId, 'red', 'jiangjz')
    `).run({ $id: fixtures.risk.id, $customerId: fixtures.customer.id, $opportunityId: fixtures.opportunity.id });

    // 全局招标公告，匹配到 A 的客户（公告=全局情报，匹配名映射=按账号过滤）。
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO hospital_tender_notices (
        id, identity_key, source_id, source_name, title, url, published_at,
        notice_type, relevance, match_customer_ids_json, match_score, first_seen_at, last_seen_at
      ) VALUES (
        'tender-matrix-1', 'tender-matrix-key-1', 'src-matrix', '矩阵测试源', '某医院数据中心招标公告',
        'https://tenders.example.test/matrix-1', $publishedAt, 'tender', 'high', $matchIds, 80, $seenAt, $seenAt
      )
    `).run({
      $publishedAt: nowIso,
      $matchIds: JSON.stringify([fixtures.customer.id]),
      $seenAt: nowIso,
    });

    // B 的自有最小数据集（验证 B 侧写路径与反向不可见）。
    const customerB = await asB("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "B客户-隔离矩阵" }),
    });
    assert.equal(customerB.response.status, 201, "B create customer");
    fixtures.customerB = customerB.body.item;
    const opportunityB = await asB("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customerB.id, name: "B商机-隔离矩阵" }),
    });
    assert.equal(opportunityB.response.status, 201, "B create opportunity");
    fixtures.opportunityB = opportunityB.body.item;
  });

  after(async () => {
    db?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("customers: hard-scoped lists, cross-account 404, owner field rejected", async () => {
    const listA = await asA("/api/customers");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.customer.id), true);
    const listB = await asB("/api/customers");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.customer.id), false);
    const detailB = await asB(`/api/customers/${fixtures.customer.id}`);
    assert.equal(detailB.response.status, 404);
    await expectCrossWrite404(`/api/customers/${fixtures.customer.id}`, {
      version: fixtures.customer.version,
      patchBody: JSON.stringify({ name: "越权改名" }),
    });
    const withOwner = await asB("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "B客户-带owner", owner: "jiangjz" }),
    });
    assert.equal(withOwner.response.status, 422, "POST body.owner must be rejected");
    const patchOwner = await asB(`/api/customers/${fixtures.customerB.id}`, {
      method: "PATCH",
      headers: versionHeader(fixtures.customerB.version),
      body: JSON.stringify({ owner: "jiangjz" }),
    });
    assert.equal(patchOwner.response.status, 422, "PATCH body.owner must be rejected");
    const detailA = await asA(`/api/customers/${fixtures.customer.id}`);
    assert.equal(detailA.response.status, 200);
  });

  it("opportunities: hard-scoped lists, cross-account 404, cross-owner customer rejected", async () => {
    const listA = await asA("/api/opportunities");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.opportunity.id), true);
    const listB = await asB("/api/opportunities");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.opportunity.id), false);
    const detailB = await asB(`/api/opportunities/${fixtures.opportunity.id}`);
    assert.equal(detailB.response.status, 404);
    await expectCrossWrite404(`/api/opportunities/${fixtures.opportunity.id}`, {
      version: fixtures.opportunity.version,
      patchBody: JSON.stringify({ stage: "越权阶段" }),
    });
    const crossCustomer = await asB("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id, name: "B商机-挂A客户" }),
    });
    assert.equal(crossCustomer.response.status, 422, "B referencing A customer must fail validation");
    const withOwner = await asB("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customerB.id, name: "B商机-带owner", owner: "jiangjz" }),
    });
    assert.equal(withOwner.response.status, 422, "POST body.owner must be rejected");
    const detailA = await asA(`/api/opportunities/${fixtures.opportunity.id}`);
    assert.equal(detailA.response.status, 200);
  });

  it("actions: hard-scoped list and cross-account 404 before version checks", async () => {
    const listA = await asA("/api/actions");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.action.id), true);
    const listB = await asB("/api/actions");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.action.id), false);
    await expectCrossWrite404(`/api/actions/${fixtures.action.id}`, {
      version: fixtures.action.version,
      patchBody: JSON.stringify({ status: "done" }),
    });
    const patchA = await asA(`/api/actions/${fixtures.action.id}`, {
      method: "PATCH",
      headers: versionHeader(fixtures.action.version),
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(patchA.response.status, 200, "A can patch own action");
    fixtures.action.version = patchA.body.item.version;
  });

  it("risks: hard-scoped list and cross-account 404 before version checks", async () => {
    const listA = await asA("/api/risks");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.risk.id), true);
    const listB = await asB("/api/risks");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.risk.id), false);
    await expectCrossWrite404(`/api/risks/${fixtures.risk.id}`, {
      version: fixtures.risk.version,
      patchBody: JSON.stringify({ status: "in_progress" }),
    });
    const patchA = await asA(`/api/risks/${fixtures.risk.id}`, {
      method: "PATCH",
      headers: versionHeader(fixtures.risk.version),
      body: JSON.stringify({ status: "accepted" }),
    });
    assert.equal(patchA.response.status, 200, "A can patch own risk");
    fixtures.risk.version = patchA.body.item.version;
  });

  it("knowledge: per-account library, search and analysis injection scoped", async () => {
    const listA = await asA("/api/knowledge");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.knowledge.id), true);
    const listB = await asB("/api/knowledge");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.knowledge.id), false);
    await expectCrossWrite404(`/api/knowledge/${fixtures.knowledge.id}`, {
      version: fixtures.knowledge.version,
      patchBody: JSON.stringify({ title: "越权改知识" }),
    });
    const searchB = await asB("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query: "移动云灾备" }),
    });
    assert.equal(searchB.body.items.length, 0, "B search must not see A knowledge");
    const searchA = await asA("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query: "移动云灾备" }),
    });
    assert.equal(searchA.body.items.some((item) => item.id === fixtures.knowledge.id), true);
    const previewB = await asB("/api/quick-records/preview", {
      method: "POST",
      body: JSON.stringify({ rawContent: "客户提到移动云灾备对比矩阵的问题，需要话术材料。" }),
    });
    assert.equal(
      (previewB.body.item.knowledgeRefs ?? []).some((ref) => ref.id === fixtures.knowledge.id),
      false,
      "B analysis preview must not inject A knowledge",
    );
    const previewA = await asA("/api/quick-records/preview", {
      method: "POST",
      body: JSON.stringify({ rawContent: "客户提到移动云灾备对比矩阵的问题，需要话术材料。" }),
    });
    assert.equal(
      (previewA.body.item.knowledgeRefs ?? []).some((ref) => ref.id === fixtures.knowledge.id),
      true,
      "A analysis preview keeps own knowledge injection",
    );
  });

  it("quick records: existing isolation is pinned, target validation is owner-scoped", async () => {
    const listB = await asB("/api/quick-records");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.quickRecord.id), false);
    const listA = await asA("/api/quick-records");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.quickRecord.id), true);
    const analyzeB = await asB(`/api/quick-records/${fixtures.quickRecord.id}/analyze`, { method: "POST" });
    assert.equal(analyzeB.response.status, 404);
    const patchB = await asB(`/api/quick-records/${fixtures.quickRecord.id}/analysis`, {
      method: "PATCH",
      headers: versionHeader(fixtures.quickRecord.version),
      body: JSON.stringify({ summary: { action: "越权改分析" } }),
    });
    assert.equal(patchB.response.status, 404);
    const confirmB = await asB(`/api/quick-records/${fixtures.quickRecord.id}/confirm`, {
      method: "POST",
      headers: { ...versionHeader(fixtures.quickRecord.version), "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ targets: ["weekly"] }),
    });
    assert.equal(confirmB.response.status, 404);
    const crossCustomer = await asB("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({ rawContent: "B想挂A的客户", customerId: fixtures.customer.id }),
    });
    assert.equal(crossCustomer.response.status, 422, "B quick record referencing A customer must fail");
  });

  it("ai sales decisions: list/get scoped, context references cross-account 404, owner persisted", async () => {
    const listA = await asA("/api/ai/sales-decisions");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.decision.id), true);
    const listB = await asB("/api/ai/sales-decisions");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.decision.id), false);
    const detailB = await asB(`/api/ai/sales-decisions/${fixtures.decision.id}`);
    assert.equal(detailB.response.status, 404);
    const byCustomer = await asB("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id }),
    });
    assert.equal(byCustomer.response.status, 404, "B referencing A customer");
    const byOpportunity = await asB("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ opportunityId: fixtures.opportunity.id }),
    });
    assert.equal(byOpportunity.response.status, 404, "B referencing A opportunity");
    const byQuickRecord = await asB("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ quickRecordId: fixtures.quickRecord.id }),
    });
    assert.equal(byQuickRecord.response.status, 404, "B referencing A quick record");
    const ownerA = db.prepare("SELECT owner FROM sales_decision_analyses WHERE id = $id").get({ $id: fixtures.decision.id });
    assert.equal(ownerA?.owner, "jiangjz", "A decision row carries owner");
    const ownB = await asB("/api/ai/sales-decisions", {
      method: "POST",
      body: JSON.stringify({ rawContent: "B自己的分析素材", analysisType: "next_step_decision" }),
    });
    assert.equal(
      db.prepare("SELECT owner FROM sales_decision_analyses WHERE id = $id").get({ $id: ownB.body.item.id })?.owner,
      "testb",
      "B decision row carries owner",
    );
  });

  it("ai suggestions: owner injected on insert", async () => {
    assert.equal(
      db.prepare("SELECT owner FROM ai_suggestions WHERE id = $id").get({ $id: fixtures.suggestion.id })?.owner,
      "jiangjz",
    );
    const suggestionB = await asB("/api/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({ type: "knowledge_talk", title: "B建议-隔离矩阵" }),
    });
    assert.equal(
      db.prepare("SELECT owner FROM ai_suggestions WHERE id = $id").get({ $id: suggestionB.body.item.id })?.owner,
      "testb",
    );
  });

  it("weekly reports: draft aggregates own records only, id endpoints cross-account 404", async () => {
    const draftB = await asB("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({ periodStart: "2026-08-24", periodEnd: "2026-08-30", owner: "jiangjz" }),
    });
    assert.equal(draftB.response.status, 201);
    assert.equal(draftB.body.item.owner, "testb", "web draft owner comes from the session, body owner ignored");
    assert.equal(draftB.body.item.sourceRefs.length, 0, "B draft must not aggregate A quick records");
    assert.equal(fixtures.weekly.sourceRefs.length >= 1, true, "A draft aggregated own confirmed record");
    const getB = await asB(`/api/reports/weekly/${fixtures.weekly.id}`);
    assert.equal(getB.response.status, 404);
    const exportB = await asB(`/api/reports/weekly/${fixtures.weekly.id}/export?format=word`);
    assert.equal(exportB.response.status, 404);
    await expectCrossWrite404(`/api/reports/weekly/${fixtures.weekly.id}`, {
      version: fixtures.weekly.version,
      patchBody: JSON.stringify({ status: "saved" }),
    });
  });

  it("solutions: hard-scoped list, cross-account 404, references validated per owner", async () => {
    const listA = await asA("/api/solutions");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.solution.id), true);
    const listB = await asB("/api/solutions");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.solution.id), false);
    const detailB = await asB(`/api/solutions/${fixtures.solution.id}`);
    assert.equal(detailB.response.status, 404);
    const patchRight = await asB(`/api/solutions/${fixtures.solution.id}`, {
      method: "PATCH",
      headers: versionHeader(fixtures.solution.version),
      body: JSON.stringify({ title: "越权改方案" }),
    });
    assert.equal(patchRight.response.status, 404);
    assert.equal(JSON.stringify(patchRight.body).includes("currentVersion"), false);
    const crossDraft = await asB("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({ customerId: fixtures.customer.id, opportunityId: fixtures.opportunity.id }),
    });
    assert.equal(crossDraft.response.status, 422, "B referencing A customer/opportunity must fail");
    const ownDraftB = await asB("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        customerId: fixtures.customerB.id,
        opportunityId: fixtures.opportunityB.id,
        owner: "jiangjz",
      }),
    });
    assert.equal(ownDraftB.response.status, 201);
    assert.equal(ownDraftB.body.item.owner, "testb", "web solution owner comes from the session, body owner ignored");
  });

  it("itineraries: hard-scoped list, cross-account 404, owner persisted", async () => {
    const listA = await asA("/api/itineraries");
    assert.equal(listA.body.items.some((item) => item.id === fixtures.itinerary.id), true);
    const listB = await asB("/api/itineraries");
    assert.equal(listB.body.items.some((item) => item.id === fixtures.itinerary.id), false);
    const detailB = await asB(`/api/itineraries/${fixtures.itinerary.id}`);
    assert.equal(detailB.response.status, 404);
    await expectCrossWrite404(`/api/itineraries/${fixtures.itinerary.id}`, {
      version: fixtures.itinerary.version,
      patchBody: JSON.stringify({
        title: "越权改行程",
        visitDate: "2026-09-01",
        departureAddress: "别处",
        departureAt: "2026-09-01T08:30:00+08:00",
        stops: [{
          id: "stop-x",
          customerName: "越权客户",
          address: "越权地址",
          priority: "normal",
          visitMinutes: 30,
        }],
      }),
    });
    const detailA = await asA(`/api/itineraries/${fixtures.itinerary.id}`);
    assert.equal(detailA.response.status, 200);
    assert.equal(
      db.prepare("SELECT owner FROM visit_itineraries WHERE id = $id").get({ $id: fixtures.itinerary.id })?.owner,
      "jiangjz",
    );
    const createB = await asB("/api/itineraries", {
      method: "POST",
      body: JSON.stringify({
        title: "B行程-隔离矩阵",
        visitDate: "2026-09-02",
        departureAddress: "青岛市市南区香港中路 10 号",
        departureCity: "青岛",
        departureAt: "2026-09-02T08:30:00+08:00",
        stops: [{
          id: "stop-b1",
          customerName: "B客户-隔离矩阵",
          address: "青岛市崂山区科苑纬一路 1 号",
          city: "青岛",
          priority: "normal",
          visitMinutes: 45,
        }],
      }),
    });
    assert.equal(createB.response.status, 201);
    const listA2 = await asA("/api/itineraries");
    assert.equal(listA2.body.items.some((item) => item.id === createB.body.item.id), false, "A must not see B itinerary");
  });

  it("dashboard summary: B sees zeros, A keeps own counts", async () => {
    const summaryB = await asB("/api/dashboard/summary");
    assert.equal(summaryB.body.item.metrics.quickRecords.value, 0);
    assert.equal(
      summaryB.body.item.opportunities.some((item) => item.id === fixtures.opportunity.id),
      false,
      "B dashboard must not embed A opportunities",
    );
    assert.equal(summaryB.body.item.metrics.risks.value, 0);
    assert.equal(summaryB.body.item.todayFocus.todos.overdueCount + summaryB.body.item.todayFocus.todos.todayCount, 0);
    const summaryA = await asA("/api/dashboard/summary");
    assert.equal(summaryA.body.item.metrics.quickRecords.value >= 1, true);
    assert.equal(summaryA.body.item.metrics.opportunities.value >= 1, true);
  });

  it("hospital tenders: global notices stay visible, matched customers render per owner", async () => {
    const listB = await asB("/api/hospital-tenders");
    const noticeB = listB.body.items.find((item) => item.id === "tender-matrix-1");
    assert.notEqual(noticeB, undefined, "tender notices stay global for every account");
    assert.equal(noticeB.matchedCustomerNames.length, 0, "B must not see A customer names on matches");
    const filtered = await asB(`/api/hospital-tenders?customerId=${encodeURIComponent(fixtures.customer.id)}`);
    assert.equal(filtered.body.items.length, 0, "customerId filter for another owner returns an empty set");
    const listA = await asA("/api/hospital-tenders");
    const noticeA = listA.body.items.find((item) => item.id === "tender-matrix-1");
    assert.equal(noticeA.matchedCustomerNames.includes("A客户-隔离矩阵"), true);
  });

  it("digest run: admin gated and dry run scoped to the caller", async () => {
    const runB = await asB("/api/digest/run?dryRun=1", { method: "POST" });
    assert.equal(runB.response.status, 403, "member digest run must be admin gated");
    const runA = await asA("/api/digest/run?dryRun=1", { method: "POST" });
    assert.equal(runA.response.status, 200, "admin dry run renders own digest");
  });

  it("action reminder status: pending count is owner-scoped", async () => {
    const statusA = await asA("/api/actions/reminders/status");
    assert.equal(statusA.body.pendingCount >= 1, true, "A sees own pending reminder");
    const statusB = await asB("/api/actions/reminders/status");
    assert.equal(statusB.body.pendingCount, 0, "B pending count must be zero");
  });

  it("audit logs: accounts only see their own actor trail", async () => {
    const listB = await asB("/api/audit-logs");
    assert.equal(listB.body.items.some((item) => item.actor === "jiangjz"), false);
    const listA = await asA("/api/audit-logs");
    assert.equal(listA.body.items.some((item) => item.actor === "jiangjz"), true);
  });

  it("machine paths: weixin-agent keeps the single-owner behavior", async () => {
    const machineList = await asMachine("/api/customers");
    assert.equal(machineList.body.items.some((item) => item.id === fixtures.customer.id), true, "machine sees jiangjz rows");
    assert.equal(machineList.body.items.some((item) => item.id === fixtures.customerB.id), false, "machine must not see testb rows");
    const machineRecord = await asMachine("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({ rawContent: "微信侧记录一条，行为照旧。" }),
    });
    assert.equal(machineRecord.response.status, 201);
    assert.equal(machineRecord.body.item.owner, "jiangjz", "machine quick record lands on the machine owner");
    const machineAnalyze = await asMachine(`/api/quick-records/${machineRecord.body.item.id}/analyze`, { method: "POST" });
    assert.equal(machineAnalyze.response.status, 201, "machine analyze on own record keeps working");
  });
});
