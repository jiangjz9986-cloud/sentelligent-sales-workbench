import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";

function fixtureLabel(...parts) {
  return parts.join("-");
}

const owner = "继振";
const accountValue = fixtureLabel("xiaoxiao", "sales", "loop", "password");
const machineValue = fixtureLabel("xiaoxiao", "sales", "loop", "machine", "token");
const senderId = "xiaoxiao-sales-loop-sender";
const conversationId = "xiaoxiao-sales-loop-conversation";
const now = new Date("2026-08-18T10:00:00+08:00");

let tempDir;
let databaseUrl;
let server;
let baseUrl;
let userCookie;
let userCsrf;
let sequence;

function amapFixture() {
  const points = new Map([
    ["青岛市黄岛区秀兰禧悦山", { lng: 120.149201, lat: 35.987754 }],
    ["日照市东港区日照中医医院", { lng: 119.526888, lat: 35.416377 }],
  ]);
  return {
    async geocode({ address }) {
      const location = points.get(address);
      if (!location) throw new Error(`unknown fixture address: ${address}`);
      return { formattedAddress: address, location };
    },
    async drivingMatrix({ locations }) {
      const durations = locations.map((_, from) => locations.map((__, to) => from === to ? 0 : 1800));
      const distances = durations.map((row) => row.map((duration) => duration * 20));
      return { durations, distances };
    },
    async drivingRoute({ origin, destination }) {
      return {
        distanceMeters: 36000,
        durationSeconds: 1800,
        tollsCny: 0,
        trafficLights: 8,
        polyline: [origin, destination],
        steps: [],
      };
    },
  };
}

async function rawRequest(path, options = {}) {
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

async function userRequest(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  return rawRequest(path, {
    ...options,
    headers: {
      Cookie: userCookie,
      ...(method === "POST" || method === "PATCH" || method === "DELETE"
        ? { "X-CSRF-Token": userCsrf }
        : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function machineEvent(text, sourceMessageId, overrides = {}) {
  return rawRequest("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineValue}`,
      "Idempotency-Key": `weixin:${sourceMessageId}`,
    },
    body: JSON.stringify({
      conversationId,
      text,
      sourceMessageId,
      senderId,
      chatType: "direct",
      ...overrides,
    }),
  });
}

function confirmationCode(text) {
  const matches = String(text).match(/(?<!\d)\d{6}(?!\d)/gu) ?? [];
  assert.equal(matches.length, 1, `expected one confirmation code in: ${text}`);
  return matches[0];
}

function countRows(db, sql, params = {}) {
  return db.prepare(sql).get(params).count;
}

function businessCounts(db) {
  return Object.fromEntries([
    ["quickRecords", "quick_records"],
    ["weeklyReports", "weekly_reports"],
    ["travelExpenses", "travel_expenses"],
    ["itineraries", "visit_itineraries"],
  ].map(([key, table]) => [key, countRows(db, `SELECT COUNT(*) AS count FROM ${table}`)]));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-xiaoxiao-sales-loop-"));
  databaseUrl = join(tempDir, "sales-loop.sqlite");
  server = createServer({
    databaseUrl,
    seed: true,
    nodeEnv: "test",
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: owner,
    authPassword: "",
    authPasswordHash: await hashPassword(accountValue, { salt: Buffer.alloc(16, 51) }),
    authSessionSecret: Buffer.alloc(32, 52).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineValue,
    weixinAgentOwner: owner,
    weixinAllowedSenderIds: senderId,
    weixinAllowGroups: false,
    assistantConfirmationSecret: Buffer.alloc(32, 53).toString("base64url"),
    assistantClock: () => now,
    itineraryClock: () => now,
    travelExpenseClock: () => now,
    now: () => now,
    amapClient: amapFixture(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  sequence = 0;

  const login = await rawRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: owner, password: accountValue }),
  });
  assert.equal(login.response.status, 200);
  userCookie = String(login.response.headers.get("set-cookie")).split(";", 1)[0];
  userCsrf = login.body.csrfToken;
});

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("小小一天销售闭环 HTTP 验收矩阵", () => {
  it("从微信入口贯通战情、客户/项目、拜访确认、动作风险与销售周报", async () => {
    const dashboard = await machineEvent("战情总览", `loop-${++sequence}-dashboard`);
    assert.equal(dashboard.response.status, 200);
    assert.match(dashboard.body.text, /战情总览/);
    assert.match(dashboard.body.text, /客户 2/);
    assert.match(dashboard.body.text, /商机 2/);

    const customer = await machineEvent("/customer.search 日照中医医院", `loop-${++sequence}-customer`);
    assert.equal(customer.response.status, 200);
    assert.match(customer.body.text, /rizhao/);
    assert.match(customer.body.text, /日照中医医院/);

    const project = await machineEvent("项目分析 op-rizhao-plan", `loop-${++sequence}-project`);
    assert.equal(project.response.status, 200);
    assert.match(project.body.text, /项目分析预览/);
    assert.match(project.body.text, /方案输出/);

    const collected = await machineEvent(
      "拜访日照中医医院，客户确认十五五规划材料需要补齐，预算路径尚未确认。",
      `loop-${++sequence}-visit-collect`,
    );
    assert.equal(collected.response.status, 200);
    assert.match(collected.body.text, /已暂存/);

    const preview = await machineEvent("记录", `loop-${++sequence}-visit-preview`);
    assert.equal(preview.response.status, 200);
    assert.match(preview.body.text, /待确认记录/);
    assert.match(preview.body.text, /日照中医医院/);

    const pending = await machineEvent("录入", `loop-${++sequence}-visit-pending`);
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.equal(Object.hasOwn(pending.body, "confirmationCode"), false);
    const code = confirmationCode(pending.body.text);

    const confirmed = await machineEvent(code, `loop-${++sequence}-visit-confirmed`);
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已录入系统/);

    const db = openDatabase({ databaseUrl });
    try {
      assert.equal(countRows(db, "SELECT COUNT(*) AS count FROM quick_records WHERE owner = $owner", { $owner: owner }), 1);
      const record = db.prepare(
        "SELECT status, customer_id, opportunity_id, raw_content FROM quick_records WHERE owner = $owner",
      ).get({ $owner: owner });
      assert.equal(record.status, "analyzed");
      assert.equal(record.customer_id, "rizhao");
      assert.equal(record.opportunity_id, "op-rizhao-plan");
      assert.match(record.raw_content, /预算路径尚未确认/);
    } finally {
      db.close();
    }

    const actionRisk = await machineEvent("动作风险", `loop-${++sequence}-action-risk`);
    assert.equal(actionRisk.response.status, 200);
    assert.match(actionRisk.body.text, /动作风险摘要/);
    assert.match(actionRisk.body.text, /补齐日照中医医院十五五规划材料/);
    assert.match(actionRisk.body.text, /预算路径未确认/);

    const report = await machineEvent("销售周报", `loop-${++sequence}-sales-report`);
    assert.equal(report.response.status, 200);
    assert.match(report.body.text, /销售周报预览/);
    assert.match(report.body.text, /已保存周报 0 条/);
    assert.match(report.body.text, /基于 1 条已确认拜访记录生成未保存预览/);
    assert.match(report.body.text, /尚未写入周报/);
    assert.match(report.body.text, /日照中医医院/);
  });

  it("把行程、差旅和报销摘要接回同一业务日，并保持只读助手无写副作用", async () => {
    const itinerary = await userRequest("/api/itineraries", {
      method: "POST",
      body: JSON.stringify({
        title: "日照中医医院客户拜访",
        visitDate: "2026-08-18",
        status: "planned",
        departureAddress: "青岛市黄岛区秀兰禧悦山",
        departureCity: "青岛",
        departureAt: "2026-08-18T08:00:00+08:00",
        stops: [{
          id: "rizhao-stop",
          customerId: "rizhao",
          customerName: "日照中医医院",
          address: "日照市东港区日照中医医院",
          city: "日照",
          priority: "high",
          visitMinutes: 60,
        }],
      }),
    });
    assert.equal(itinerary.response.status, 201);

    const expense = await userRequest("/api/travel-expenses", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-18",
        category: "transport",
        purpose: "日照中医医院拜访",
        customerId: "rizhao",
        payments: [{
          paidAt: "2026-08-18T07:30:00+08:00",
          amountCents: 8800,
          reimbursementCents: 8800,
          fundingSource: "personal",
          paymentMethod: "wechat",
        }],
      }),
    });
    assert.equal(expense.response.status, 201);

    const before = openDatabase({ databaseUrl });
    const businessBefore = businessCounts(before);
    before.close();

    const itinerarySummary = await machineEvent("行程摘要", `loop-${++sequence}-itinerary-summary`);
    assert.equal(itinerarySummary.response.status, 200);
    assert.match(itinerarySummary.body.text, /行程摘要/);
    assert.match(itinerarySummary.body.text, /日照中医医院客户拜访/);

    const travel = await machineEvent("差旅汇总", `loop-${++sequence}-travel-summary`);
    assert.equal(travel.response.status, 200);
    assert.match(travel.body.text, /差旅汇总/);
    assert.match(travel.body.text, /1 笔/);
    assert.match(travel.body.text, /88\.00 元/);

    const reimbursement = await machineEvent("报销周汇总", `loop-${++sequence}-reimbursement-summary`);
    assert.equal(reimbursement.response.status, 200);
    assert.match(reimbursement.body.text, /报销周汇总预览/);
    assert.match(reimbursement.body.text, /1 笔/);

    const after = openDatabase({ databaseUrl });
    try {
      assert.deepEqual(businessCounts(after), businessBefore);
    } finally {
      after.close();
    }
  });

  it("要求入口幂等且拒绝 sender、owner 和机器路由越权", async () => {
    const first = await machineEvent("战情总览", "loop-replay-dashboard");
    const replay = await machineEvent("战情总览", "loop-replay-dashboard");
    assert.equal(first.response.status, 200);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);

    const forgedDb = openDatabase({ databaseUrl });
    try {
      forgedDb.exec(`
        INSERT INTO customers (id, name, region, owner)
        VALUES ('other-owner-customer', '越权医院', '山东', 'other-owner');
        INSERT INTO opportunities (id, customer_id, name, stage, owner)
        VALUES ('other-owner-opportunity', 'other-owner-customer', '越权项目', 'lead', 'other-owner');
      `);
    } finally {
      forgedDb.close();
    }

    const hiddenCustomer = await machineEvent("/customer.search 越权医院", `loop-${++sequence}-owner-search`);
    assert.equal(hiddenCustomer.response.status, 200);
    assert.match(hiddenCustomer.body.text, /未找到客户/);
    assert.doesNotMatch(hiddenCustomer.body.text, /other-owner-customer/);

    const hiddenProject = await machineEvent("商机详情 other-owner-opportunity", `loop-${++sequence}-owner-project`);
    assert.equal(hiddenProject.response.status, 200);
    assert.match(hiddenProject.body.text, /未找到该商机/);
    assert.doesNotMatch(hiddenProject.body.text, /other-owner-opportunity/);

    const deniedSender = await machineEvent(
      "战情总览",
      `loop-${++sequence}-sender-denied`,
      { senderId: "not-allowlisted-sender" },
    );
    assert.equal(deniedSender.response.status, 403);
    assert.equal(deniedSender.body.error.code, "WEIXIN_SENDER_NOT_ALLOWED");

    const machineWrite = await rawRequest("/api/travel-expenses", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineValue}` },
      body: JSON.stringify({}),
    });
    assert.equal(machineWrite.response.status, 403);
    assert.equal(machineWrite.body.error.code, "MACHINE_SCOPE_DENIED");
  });
});
