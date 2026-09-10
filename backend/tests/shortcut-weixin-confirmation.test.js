import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { resolveItineraryTripRegion } from "../src/assistant/bookkeepingTripRegion.js";
import { openDatabase } from "../src/db.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";
import { createRemoteClawbotAgent } from "../src/weixin/remoteAgent.js";
import { minimalPdf, VALID_JPEG, VALID_PNG } from "./helpers/image-fixtures.js";
import { seedWeixinBinding } from "./helpers/weixin-binding-fixtures.js";

const machineToken = "weixin-machine-test-token";
// v0.9.3：owner 必须是合法 users 账号（bindings FK + CHECK 词表）。
const owner = "assistantowner";
const sender = "sender-1";
const confirmationSecret = ["test", "shortcut", "confirmation", "secret"].join("-");

let tempDir;
let server;
let baseUrl;
let entrySequence;
let actionSequence;
let outboxSequence;
let latestQuoteMessageId;
let lastRecognitionOptions;
let driftingRecognitionCalls;
let concurrentRecognitionCalls;
let concurrentRecognitionWaiters;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function analysis(overrides = {}) {
  return {
    status: "ready",
    confidence: 0.98,
    expense: {
      occurredOn: "2026-08-18",
      amountCents: 1280,
      reimbursementCents: 1280,
      purpose: "出差消费",
      merchant: "合成商户",
      paidAt: "2026-08-18T12:00:00+08:00",
      fundingSource: "personal",
      paymentMethod: "wechat",
    },
    warnings: [],
    source: { provider: "test", model: null },
    ...overrides,
  };
}

async function request(path, options = {}) {
  let requestOptions = options;
  if (path === "/api/integrations/weixin-agent/events" && typeof options.body === "string") {
    const body = JSON.parse(options.body);
    const suppressQuote = body.suppressQuote === true;
    delete body.suppressQuote;
    if (!suppressQuote && !body.quotedMessageId && !body.quotedText && latestQuoteMessageId) {
      body.quotedMessageId = latestQuoteMessageId;
    }
    requestOptions = { ...options, body: JSON.stringify(body) };
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestOptions,
    headers: { ...(requestOptions.headers ?? {}) },
  });
  return read(response);
}

function multiRowRecognition() {
  const token = (text, left, top, width, line, word) => ({
    page: 1, block: 1, paragraph: 1, line, word,
    left, top, width, height: 34, confidence: 95, text,
  });
  return {
    extractedText: [
      "合成包子铺 -12.34",
      "8月18日 09:10",
      "合成烧烤店 -56.78",
      "8月18日 18:20",
    ].join("\n"),
    evidence: { amountCents: 1234, occurredOn: null, paidTime: null, merchant: "合成包子铺", paymentMethod: "bank_card" },
    confidence: 0.98,
    warnings: [],
    source: { provider: "test", model: null },
    layout: {
      pageWidth: 1280,
      pageHeight: 520,
      tokens: [
        token("合成包子铺", 240, 45, 220, 1, 1),
        token("-12.34", 1120, 45, 120, 1, 2),
        token("8月18日", 240, 105, 140, 2, 1),
        token("09:10", 400, 105, 100, 2, 2),
        token("合成烧烤店", 240, 290, 220, 3, 1),
        token("-56.78", 1120, 290, 120, 3, 2),
        token("8月18日", 240, 355, 140, 4, 1),
        token("18:20", 400, 355, 100, 4, 2),
      ],
    },
  };
}

function eventHeaders(id) {
  return {
    Authorization: `Bearer ${machineToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `weixin:${id}`,
  };
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "test-worker",
    "X-Weixin-Delivery-Status": "ready",
    // v0.9.3 协议 v2：多绑定就绪哨兵（单绑定哈希 scope 由 lease 行内校验）。
    "X-Weixin-Delivery-Scope": "weixin:multi:v1",
  };
}

async function reportWorkerReady() {
  const reported = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: workerHeaders(),
  });
  assert.equal(reported.response.status, 204);
}

async function leaseOutbox() {
  const leased = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    headers: workerHeaders(),
  });
  assert.equal(leased.response.status, 200);
  assert.ok(leased.body.leaseToken);
  return leased.body;
}

async function ackOutbox(lease, ok = true, providerMessageId = null) {
  const deliveredMessageId = providerMessageId ?? `provider-${lease.item.id}`;
  const ack = await request("/api/integrations/weixin-agent/confirmation-outbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: lease.item.id,
      leaseToken: lease.leaseToken,
      ok,
      providerMessageId: deliveredMessageId,
    }),
  });
  assert.equal(ack.response.status, 200);
  if (ok) latestQuoteMessageId = deliveredMessageId;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-weixin-confirmation-"));
  entrySequence = 0;
  actionSequence = 0;
  outboxSequence = 0;
  latestQuoteMessageId = null;
  lastRecognitionOptions = null;
  driftingRecognitionCalls = 0;
  concurrentRecognitionCalls = 0;
  concurrentRecognitionWaiters = [];
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    weixinBookkeepingConfirmationEnabled: true,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: owner,
    weixinBookkeepingOwner: owner,
    weixinBookkeepingSenderId: sender,
    weixinAllowedSenderIds: [sender, "sender-2"],
    weixinAllowGroups: true,
    weixinAllowedGroupIds: "allowed-bookkeeping-test-group",
    assistantConfirmationSecret: confirmationSecret,
    assistantClock: () => new Date("2026-08-25T06:24:00.000Z"),
    shortcutBookkeepingIdFactory: () => `entry-${++entrySequence}`,
    shortcutBookkeepingAssistantIdFactory: () => `action-${++actionSequence}`,
    weixinConfirmationOutboxIdFactory: () => `outbox-${++outboxSequence}`,
    travelExpenseAnalyzer: async () => analysis(),
    paymentProofRecognizer: async ({ fileName }, recognitionOptions = {}) => {
      lastRecognitionOptions = recognitionOptions;
      if (fileName === "multi.png") return multiRowRecognition();
      if (fileName === "drift.png") {
        driftingRecognitionCalls += 1;
        return driftingRecognitionCalls === 1
          ? {
              documentKind: "payment_proof",
              extractedText: null,
              evidence: {
                amountCents: 1800,
                occurredOn: "2026-08-25",
                paidTime: "09:00",
                merchant: "合成早餐店",
                paymentMethod: "wechat",
              },
              transactions: [
                { amountCents: 1800, occurredOn: "2026-08-25", paidTime: "09:00", merchant: "合成早餐店", paymentMethod: "wechat" },
                { amountCents: 2800, occurredOn: "2026-08-25", paidTime: "12:00", merchant: "合成午餐店", paymentMethod: "wechat" },
              ],
              confidence: 0.99,
              warnings: [],
              source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
            }
          : {
              documentKind: "payment_proof",
              extractedText: null,
              evidence: {
                amountCents: 9900,
                occurredOn: "2026-08-25",
                paidTime: "22:00",
                merchant: "漂移商户",
                paymentMethod: "alipay",
              },
              confidence: 0.5,
              warnings: [],
              source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
            };
      }
      if (fileName === "concurrent.png") {
        concurrentRecognitionCalls += 1;
        const call = concurrentRecognitionCalls;
        await new Promise((resolve) => {
          concurrentRecognitionWaiters.push(resolve);
          if (concurrentRecognitionWaiters.length === 2) {
            for (const release of concurrentRecognitionWaiters.splice(0)) release();
          }
        });
        const transactions = [
          { amountCents: 1100, occurredOn: "2026-08-25", paidTime: "09:00", merchant: "并发早餐", paymentMethod: "wechat" },
          { amountCents: 2200, occurredOn: "2026-08-25", paidTime: "12:00", merchant: "并发午餐", paymentMethod: "wechat" },
          ...(call === 2
            ? [{ amountCents: 3300, occurredOn: "2026-08-25", paidTime: "18:00", merchant: "并发晚餐", paymentMethod: "wechat" }]
            : []),
        ];
        return {
          documentKind: "payment_proof",
          extractedText: null,
          evidence: transactions[0],
          transactions,
          confidence: 0.99,
          warnings: [],
          source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
        };
      }
      if (fileName === "visual-document.png") return {
        documentKind: "invoice",
        extractedText: null,
        evidence: null,
        confidence: 0.99,
        warnings: [],
        source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
      };
      if (fileName === "vision-only.png") return {
        documentKind: "payment_proof",
        extractedText: null,
        evidence: {
          amountCents: 3710,
          occurredOn: "2026-08-20",
          paidTime: "11:29",
          merchant: "合成平台",
          paymentMethod: "bank_card",
        },
        confidence: 0.99,
        warnings: [],
        source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
      };
      if (fileName === "reclass.png") return {
        documentKind: "payment_proof",
        extractedText: null,
        evidence: {
          amountCents: 3000,
          occurredOn: "2026-08-25",
          paidTime: "12:00",
          merchant: "合成商贸",
          paymentMethod: "wechat",
        },
        confidence: 0.99,
        warnings: [],
        source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
      };
      if (fileName === "stale-category-warning.png") return {
        documentKind: "payment_proof",
        extractedText: "2026年8月25日 支付时间12:00 合成商贸 50元 出差消费",
        evidence: {
          amountCents: 5000,
          occurredOn: "2026-08-25",
          paidTime: "12:00",
          merchant: "合成商贸",
          paymentMethod: "wechat",
        },
        confidence: 0.99,
        warnings: ["missing_category", "invalid_category"],
        source: { provider: "test", model: "deepseek-v4-flash-vision-exp" },
      };
      if (fileName === "generic-invoice.png") return {
          extractedText: "电子发票 发票号码 00000000 购买方 合成公司 销售方 合成商户 价税合计 219.00",
          evidence: null,
          confidence: 0.99,
          warnings: [],
          source: { provider: "test", model: null },
        };
      if (fileName === "income.png") return {
          extractedText: "2026年8月20日 收到出差借款 +2000.00",
          evidence: {
            amountCents: 200000,
            occurredOn: "2026-08-20",
            paidTime: "10:20",
            merchant: "出差借款到账",
            paymentMethod: "bank_card",
          },
          confidence: 0.99,
          warnings: [],
          source: { provider: "test", model: null },
        };
      if (fileName === "scan.png") return {
          extractedText: "电子发票 发票号码 000001 购买方 合成公司 销售方 合成商户 价税合计 219.00",
          evidence: { amountCents: 21900, occurredOn: null, paidTime: null, merchant: "合成商户", paymentMethod: null },
          confidence: 0.95,
          warnings: [],
          source: { provider: "test", model: null },
        };
      return {
        extractedText: "华住酒店集团 2026年8月18日 17:36 -219.00",
        evidence: {
          amountCents: 21900,
          occurredOn: "2026-08-18",
          paidTime: "17:36",
          merchant: "华住酒店集团",
          paymentMethod: "bank_card",
        },
        confidence: 0.99,
        warnings: [],
        source: { provider: "test", model: null },
      };
    },
    invoiceRecognizer: async () => ({
      status: "unmatched",
      extractedText: "电子发票 华住酒店集团 219.00",
      conflicts: [],
      warnings: [],
      fields: {
        invoiceCode: "INV-TEST-1",
        invoiceNumber: "NO-TEST-1",
        issuedOn: "2026-08-18",
        sellerName: "华住酒店集团",
        buyerName: "森特智行",
        amountExTaxCents: 20467,
        taxCents: 1433,
        totalCents: 21900,
        suggestedCategory: "lodging",
      },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  {
    // v0.9.3：sender 白名单入 DB——为 harness owner 建 users 行与 active 绑定。
    const seedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      seedWeixinBinding(seedDb, { account: owner, senderId: sender, financialEnabled: true });
    } finally {
      seedDb.close();
    }
  }
  await reportWorkerReady();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("小小微信图片记账与自然语言确认闭环", () => {
  it("resolves only one active owner/date itinerary city and fails closed on ambiguity or overflow", () => {
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const insert = ({ id, rowOwner = owner, date = "2026-08-20", status = "planned", city = "济宁", deletedAt = null }) => {
      db.prepare(`
        INSERT INTO visit_itineraries (
          id, title, visit_date, status, request_json, plan_json,
          created_by, updated_by, created_at, updated_at, deleted_at, deleted_by
        ) VALUES (
          $id, '合成行程', $date, $status, $request, $plan,
          $owner, $owner, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z',
          $deletedAt, $deletedBy
        )
      `).run({
        $id: id,
        $date: date,
        $status: status,
        $request: JSON.stringify({ stops: [{ city }] }),
        $plan: JSON.stringify({ stops: [{ city }] }),
        $owner: rowOwner,
        $deletedAt: deletedAt,
        $deletedBy: deletedAt ? rowOwner : null,
      });
    };
    insert({ id: "region-active" });
    insert({ id: "region-other-owner", rowOwner: "other-owner", city: "青岛" });
    insert({ id: "region-other-date", date: "2026-08-21", city: "枣庄" });
    insert({ id: "region-cancelled", status: "cancelled", city: "临沂" });
    insert({ id: "region-deleted", deletedAt: "2026-08-19T01:00:00.000Z", city: "泰安" });
    assert.equal(resolveItineraryTripRegion(db, { owner, occurredOn: "2026-08-20" }), "济宁");
    insert({ id: "region-ambiguous", city: "潍坊" });
    assert.equal(resolveItineraryTripRegion(db, { owner, occurredOn: "2026-08-20" }), null);
    db.prepare("UPDATE visit_itineraries SET deleted_at = '2026-08-19T02:00:00.000Z', deleted_by = $owner WHERE id = 'region-ambiguous'").run({ $owner: owner });
    for (let index = 0; index < 20; index += 1) insert({ id: `region-overflow-${index}` });
    assert.equal(resolveItineraryTripRegion(db, { owner, occurredOn: "2026-08-20" }), null);
    db.close();
  });

  it("requires a natural-week region before confirming a meal and refreshes the automatic note after assignment", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-required-capture"),
      body: JSON.stringify({
        conversationId: "conversation-region-required",
        text: "",
        sourceMessageId: "weixin-region-required-capture",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "reclass.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(captured.response.status, 200);
    const initialDraft = await leaseOutbox();
    assert.match(initialDraft.item.message, /出差区域待确认/u);
    assert.match(initialDraft.item.message, /这笔餐饮还没有唯一出差区域，当前不能确认/u);
    assert.match(initialDraft.item.message, /请先回复“20260824-20260830区域是济南”/u);
    assert.match(initialDraft.item.message, /多城市时请同时说明各日期范围和城市/u);
    assert.match(initialDraft.item.message, /请引用最新消息回复“确认”/u);
    assert.match(initialDraft.item.message, /请引用本消息并回复/u);
    assert.doesNotMatch(initialDraft.item.message, /“本周区域是济南”/u);
    await ackOutbox(initialDraft, true, "provider-region-required-initial");

    const blocked = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-required-confirm-blocked"),
      body: JSON.stringify({
        conversationId: "conversation-region-required",
        text: "确认",
        sourceMessageId: "weixin-region-required-confirm-blocked",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-required-initial",
      }),
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.status, "review_required");
    assert.match(blocked.body.text, /区域/u);

    const configured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-required-assign"),
      body: JSON.stringify({
        conversationId: "conversation-region-required",
        text: "本周区域是济南",
        sourceMessageId: "weixin-region-required-assign",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(configured.response.status, 200);
    assert.equal(configured.body.status, "review_required");
    assert.match(configured.body.text, /2026-08-24/u);
    assert.match(configured.body.text, /济南/u);

    const refreshedDraft = await leaseOutbox();
    assert.match(refreshedDraft.item.message, /备注：8\.25济南午餐/u);
    assert.match(refreshedDraft.item.message, /请引用本消息并回复/u);
    assert.doesNotMatch(refreshedDraft.item.message, /请先回复出差区域/u);
    await ackOutbox(refreshedDraft, true, "provider-region-required-refreshed");

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-required-confirmed"),
      body: JSON.stringify({
        conversationId: "conversation-region-required",
        text: "确认",
        sourceMessageId: "weixin-region-required-confirmed",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-required-refreshed",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      const profile = db.prepare(`
        SELECT version, cities_json, default_city
        FROM travel_expense_region_profiles
        WHERE owner = $owner AND week_start = '2026-08-24'
      `).get({ $owner: owner });
      assert.equal(profile.version, 1);
      assert.deepEqual(JSON.parse(profile.cities_json), ["济南"]);
      assert.equal(profile.default_city, "济南");
      const expense = db.prepare(`
        SELECT notes, trip_region, trip_region_source FROM travel_expenses
      `).get();
      assert.deepEqual({ ...expense }, {
        notes: "8.25济南午餐",
        trip_region: "济南",
        trip_region_source: "week_default",
      });
    } finally {
      db.close();
    }

  });

  it("rotates a pending meal draft when WeChat changes its weekly region", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-change-capture"),
      body: JSON.stringify({
        conversationId: "conversation-region-change",
        text: "",
        sourceMessageId: "weixin-region-change-capture",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "reclass.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(captured.response.status, 200);
    const initial = await leaseOutbox();
    await ackOutbox(initial, true, "provider-region-change-initial");

    for (const [city, id] of [["济南", "jn"], ["青岛", "qd"]]) {
      const configured = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(`weixin-region-change-${id}`),
        body: JSON.stringify({
          conversationId: "conversation-region-change",
          text: `本周区域是${city}`,
          sourceMessageId: `weixin-region-change-${id}`,
          senderId: sender,
          chatType: "direct",
          suppressQuote: true,
        }),
      });
      assert.equal(configured.response.status, 200);
      const refreshed = await leaseOutbox();
      assert.match(refreshed.item.message, new RegExp(`备注：8\\.25${city}午餐`, "u"));
      await ackOutbox(refreshed, true, `provider-region-change-${id}`);
    }

    const stale = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-change-stale-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-region-change",
        text: "确认",
        sourceMessageId: "weixin-region-change-stale-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-change-jn",
      }),
    });
    assert.equal(stale.response.status, 409);
    const beforeConfirmDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(beforeConfirmDb.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    beforeConfirmDb.close();

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-change-current-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-region-change",
        text: "确认",
        sourceMessageId: "weixin-region-change-current-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-change-qd",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    const acceptedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const expense = acceptedDb.prepare("SELECT notes, trip_region, trip_region_source FROM travel_expenses").get();
    assert.deepEqual({ ...expense }, {
      notes: "8.25青岛午餐",
      trip_region: "青岛",
      trip_region_source: "week_default",
    });
    acceptedDb.close();
  });

  it("reopens a transiently failed refreshed draft before allowing confirmation", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-recovery-capture"),
      body: JSON.stringify({
        conversationId: "conversation-region-recovery",
        text: "",
        sourceMessageId: "weixin-region-recovery-capture",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "reclass.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(captured.response.status, 200);
    const initial = await leaseOutbox();
    await ackOutbox(initial, true, "provider-region-recovery-initial");

    const configured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-recovery-assign"),
      body: JSON.stringify({
        conversationId: "conversation-region-recovery",
        text: "本周区域是济南",
        sourceMessageId: "weixin-region-recovery-assign",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
    const refreshed = await leaseOutbox();
    assert.match(refreshed.item.message, /备注：8\.25济南午餐/u);
    await ackOutbox(refreshed, true, "provider-region-recovery-refreshed");

    const failedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    failedDb.prepare(`
      UPDATE weixin_confirmation_outbox
      SET status = 'failed', last_error_code = 'WEIXIN_SEND_FAILED',
          lease_proof_hash = NULL, lease_until = NULL, updated_at = '2026-08-25T06:30:00.000Z'
      WHERE id = $id
    `).run({ $id: refreshed.item.id });
    const failed = failedDb.prepare("SELECT status, last_error_code FROM weixin_confirmation_outbox WHERE id = $id").get({ $id: refreshed.item.id });
    assert.deepEqual({ ...failed }, { status: "failed", last_error_code: "WEIXIN_SEND_FAILED" });
    failedDb.close();

    // Repeating the same region assignment must reopen the failed row and make
    // the current-version draft deliverable again; merely replaying a failed
    // idempotency key would leave confirmation blocked forever.
    const retried = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-recovery-retry"),
      body: JSON.stringify({
        conversationId: "conversation-region-recovery",
        text: "本周区域是济南",
        sourceMessageId: "weixin-region-recovery-retry",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
    const recovered = await leaseOutbox();
    assert.equal(recovered.item.id, refreshed.item.id);
    assert.equal(recovered.item.status, "processing");
    await ackOutbox(recovered, true, "provider-region-recovery-retried");

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-recovery-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-region-recovery",
        text: "确认",
        sourceMessageId: "weixin-region-recovery-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-recovery-retried",
      }),
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.match(confirmed.body.text, /已确认并录入/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const expense = db.prepare("SELECT notes, trip_region FROM travel_expenses").get();
    assert.deepEqual({ ...expense }, { notes: "8.25济南午餐", trip_region: "济南" });
    db.close();
  });

  it("does not overwrite a manually corrected meal note when a week region is assigned", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-manual-note-capture"),
      body: JSON.stringify({
        conversationId: "conversation-region-manual-note",
        text: "",
        sourceMessageId: "weixin-region-manual-note-capture",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "reclass.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(captured.response.status, 200);
    const draft = await leaseOutbox();
    await ackOutbox(draft, true, "provider-region-manual-note-initial");

    const corrected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-manual-note-correct"),
      body: JSON.stringify({
        conversationId: "conversation-region-manual-note",
        text: "修改备注为客户自定义",
        sourceMessageId: "weixin-region-manual-note-correct",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-manual-note-initial",
      }),
    });
    assert.equal(corrected.response.status, 200);
    const correctedDraft = await leaseOutbox();
    assert.match(correctedDraft.item.message, /备注：客户自定义/u);
    await ackOutbox(correctedDraft, true, "provider-region-manual-note-corrected");

    const configured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-manual-note-assign"),
      body: JSON.stringify({
        conversationId: "conversation-region-manual-note",
        text: "本周区域是青岛",
        sourceMessageId: "weixin-region-manual-note-assign",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(configured.response.status, 200);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      const entry = db.prepare(`
        SELECT note, analysis_json FROM shortcut_bookkeeping_entries
        WHERE owner = $owner AND status = 'review_required'
      `).get({ $owner: owner });
      assert.equal(entry.note, "客户自定义");
      assert.equal(JSON.parse(entry.analysis_json).noteAutomation, null);
    } finally {
      db.close();
    }

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-manual-note-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-region-manual-note",
        text: "确认",
        sourceMessageId: "weixin-region-manual-note-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-region-manual-note-corrected",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    const acceptedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      const expense = acceptedDb.prepare("SELECT notes, trip_region, trip_region_source FROM travel_expenses").get();
      assert.deepEqual({ ...expense }, {
        notes: "客户自定义",
        trip_region: "青岛",
        trip_region_source: "week_default",
      });
    } finally {
      acceptedDb.close();
    }
  });

  it("applies an explicit last-week region to only that week's pending meal drafts", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-last-week-region-capture"),
      body: JSON.stringify({
        conversationId: "conversation-last-week-region",
        text: "",
        sourceMessageId: "weixin-last-week-region-capture",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "vision-only.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(captured.response.status, 200);
    const initial = await leaseOutbox();
    assert.match(initial.item.message, /周期：20260817-20260823/u);
    assert.match(initial.item.message, /这笔餐饮还没有唯一出差区域，当前不能确认/u);
    assert.match(initial.item.message, /请先回复“20260817-20260823区域是济南”/u);
    assert.doesNotMatch(initial.item.message, /“本周区域是济南”/u);
    await ackOutbox(initial, true, "provider-last-week-region-initial");

    const configured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-last-week-region-assign"),
      body: JSON.stringify({
        conversationId: "conversation-last-week-region",
        text: "上周的区域是济南",
        sourceMessageId: "weixin-last-week-region-assign",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(configured.response.status, 200);
    assert.match(configured.body.text, /2026-08-17/u);
    assert.match(configured.body.text, /2026-08-23/u);
    const refreshed = await leaseOutbox();
    assert.match(refreshed.item.message, /备注：8\.20济南午餐/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM travel_expense_region_profiles
        WHERE owner = $owner AND week_start = '2026-08-17' AND default_city = '济南'
      `).get({ $owner: owner }).count, 1);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM travel_expense_region_profiles
        WHERE owner = $owner AND week_start = '2026-08-24'
      `).get({ $owner: owner }).count, 0);
    } finally {
      db.close();
    }
  });

  it("rejects a week-region command from an unbound sender and a group chat", async () => {
    // v0.9.3：未绑定 sender 在入口即被固定拒答（200 denied，不入编排）；
    // 群聊来自已绑定 sender 仍进编排，由财务闸以 403 拒绝。
    const unbound = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-denied-other-sender"),
      body: JSON.stringify({
        conversationId: "conversation-region-denied-other-sender",
        text: "本周区域是济南",
        sourceMessageId: "weixin-region-denied-other-sender",
        senderId: "sender-2",
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(unbound.response.status, 200);
    assert.equal(unbound.body.status, "denied");
    assert.match(unbound.body.text, /尚未绑定/u);

    const group = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-region-denied-group"),
      body: JSON.stringify({
        conversationId: "conversation-region-denied-group",
        text: "本周区域是济南",
        sourceMessageId: "weixin-region-denied-group",
        senderId: sender,
        chatType: "group",
        groupId: "allowed-bookkeeping-test-group",
        suppressQuote: true,
      }),
    });
    assert.equal(group.response.status, 403);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_region_profiles").get().count, 0);
    } finally {
      db.close();
    }
  });

  it("carries a real JPEG file through the remote agent and local HTTP server into a bookkeeping draft", async () => {
    const filePath = join(tempDir, "remote-payment.jpg");
    await writeFile(filePath, VALID_JPEG);
    const agent = createRemoteClawbotAgent({
      backendUrl: baseUrl,
      apiToken: machineToken,
    });

    const received = await agent.chat({
      conversationId: "conversation-remote-image",
      text: "",
      senderId: sender,
      messageId: `weixin:delivery:v1:${"c".repeat(64)}`,
      chatType: "direct",
      deliveryTimestampMs: 1_786_500_000_123,
      media: {
        type: "image",
        filePath,
        mimeType: "image/*",
        fileName: "remote-payment.jpg",
      },
    });

    assert.equal(received.status, "ok");
    assert.match(received.text, /付款凭证/u);
    const draft = await leaseOutbox();
    assert.match(draft.item.message, /【小小提醒！新增一条待记账信息】/u);
    assert.match(draft.item.message, /类型：支出/u);
    assert.match(draft.item.message, /金额：219\.00 元/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 1);
    db.close();
  });

  it("uses vision-only evidence without OCR text and supplies the Shanghai reference date", async () => {
    const itineraryDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    itineraryDb.prepare(`
      INSERT INTO visit_itineraries (
        id, title, visit_date, status, request_json, plan_json,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'meal-itinerary', '合成出差行程', '2026-08-20', 'planned', $request, $plan,
        $owner, $owner, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
      )
    `).run({
      $owner: owner,
      $request: JSON.stringify({ stops: [{ city: "济宁" }] }),
      $plan: JSON.stringify({ stops: [{ city: "济宁" }] }),
    });
    itineraryDb.prepare(`
      INSERT INTO visit_itineraries (
        id, title, visit_date, status, request_json, plan_json,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'meal-itinerary-next-day', '合成次日出差行程', '2026-08-21', 'planned', $request, $plan,
        $owner, $owner, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
      )
    `).run({
      $owner: owner,
      $request: JSON.stringify({ stops: [{ city: "枣庄" }] }),
      $plan: JSON.stringify({ stops: [{ city: "枣庄" }] }),
    });
    itineraryDb.close();

    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-vision-only-proof"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "",
        sourceMessageId: "weixin-vision-only-proof",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "vision-only.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });

    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    assert.equal(lastRecognitionOptions?.referenceDate, "2026-08-25");
    const draft = await leaseOutbox();
    assert.match(draft.item.message, /编号：202608201129/u);
    assert.match(draft.item.message, /金额：37\.10 元/u);
    assert.match(draft.item.message, /费用类别：餐饮/u);
    assert.doesNotMatch(draft.item.message, /费用类别：餐饮-午餐/u);
    assert.match(draft.item.message, /备注：8\.20济宁午餐/u);
    assert.match(draft.item.message, /周期：20260817-20260823/u);
    assert.match(draft.item.message, /AI 状态：已识别，待你确认/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const row = db.prepare("SELECT amount_cents, occurred_on, category, subcategory, note FROM shortcut_bookkeeping_entries").get();
    assert.equal(row.amount_cents, 3710);
    assert.equal(row.occurred_on, "2026-08-20");
    assert.equal(row.category, "餐饮");
    assert.equal(row.subcategory, "午餐");
    assert.equal(row.note, "8.20济宁午餐");
    db.close();

    await ackOutbox(draft, true, "provider-meal-original");
    const changedDate = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-change-date"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "修改日期为2026-08-21",
        sourceMessageId: "weixin-meal-change-date",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-meal-original",
      }),
    });
    assert.equal(changedDate.response.status, 200, JSON.stringify(changedDate.body));
    const dateDraft = await leaseOutbox();
    assert.match(dateDraft.item.message, /备注：8\.21枣庄午餐/u);
    await ackOutbox(dateDraft, true, "provider-meal-date");

    const changedMeal = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-change-subcategory"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "修改小类为晚餐",
        sourceMessageId: "weixin-meal-change-subcategory",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-meal-date",
      }),
    });
    assert.equal(changedMeal.response.status, 200, JSON.stringify(changedMeal.body));
    const mealDraft = await leaseOutbox();
    assert.match(mealDraft.item.message, /备注：8\.21枣庄晚餐/u);
    await ackOutbox(mealDraft, true, "provider-meal-subcategory");

    const invalidCategory = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-invalid-category"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "修改费用类别为不存在",
        sourceMessageId: "weixin-meal-invalid-category",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-meal-subcategory",
      }),
    });
    assert.equal(invalidCategory.response.status, 200, JSON.stringify(invalidCategory.body));
    assert.equal(invalidCategory.body.status, "clarify");
    const unchangedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(unchangedDb.prepare("SELECT status FROM shortcut_bookkeeping_entries").get().status, "review_required");
    assert.equal(unchangedDb.prepare("SELECT status FROM assistant_pending_actions").get().status, "pending");
    unchangedDb.close();
    const noInvalidDraft = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(noInvalidDraft.response.status, 204);

    const changedCategory = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-change-category"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "修改费用类别为交通",
        sourceMessageId: "weixin-meal-change-category",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-meal-subcategory",
      }),
    });
    assert.equal(changedCategory.response.status, 200, JSON.stringify(changedCategory.body));
    const categoryDraft = await leaseOutbox();
    assert.match(categoryDraft.item.message, /费用类别：交通/u);
    assert.match(categoryDraft.item.message, /备注：无/u);
    await ackOutbox(categoryDraft, true, "provider-meal-category");

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-proof",
        text: "确认",
        sourceMessageId: "weixin-meal-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-meal-category",
      }),
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    const acceptedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      { ...acceptedDb.prepare(`
        SELECT expense.category, expense.notes, payment.paid_at
        FROM travel_expenses expense
        JOIN travel_expense_payments payment ON payment.expense_id = expense.id
      `).get() },
      { category: "transport", notes: null, paid_at: "2026-08-21T11:29:00+08:00" },
    );
    acceptedDb.close();
  });

  it("re-runs automatic meal classification after amount/time corrections but honors a manual category", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-reclass-proof"),
      body: JSON.stringify({
        conversationId: "conversation-meal-reclass-proof",
        text: "",
        sourceMessageId: "weixin-meal-reclass-proof",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "reclass.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    const initial = await leaseOutbox();
    assert.match(initial.item.message, /费用类别：餐饮/u);
    assert.match(initial.item.message, /备注：8\.25午餐/u);
    await ackOutbox(initial, true, "provider-reclass-initial");

    const zeroAmount = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-reclass-zero"),
      body: JSON.stringify({
        conversationId: "conversation-meal-reclass-proof",
        text: "修改金额为0元",
        sourceMessageId: "weixin-meal-reclass-zero",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-reclass-initial",
      }),
    });
    assert.equal(zeroAmount.response.status, 200, JSON.stringify(zeroAmount.body));
    assert.equal(zeroAmount.body.status, "clarify");
    const zeroDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      { ...zeroDb.prepare(`
        SELECT entry.amount_cents, entry.status, action.version AS action_version
        FROM shortcut_bookkeeping_entries entry
        JOIN assistant_pending_actions action
          ON json_extract(action.payload_json, '$.entryId') = entry.id
      `).get() },
      { amount_cents: 3000, status: "review_required", action_version: 1 },
    );
    zeroDb.close();
    const noZeroDraft = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(noZeroDraft.response.status, 204);

    const revise = async ({ id, text, quotedMessageId }) => {
      const response = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(id),
        body: JSON.stringify({
          conversationId: "conversation-meal-reclass-proof",
          text,
          sourceMessageId: id,
          senderId: sender,
          chatType: "direct",
          quotedMessageId,
        }),
      });
      assert.equal(response.response.status, 200, JSON.stringify(response.body));
      return leaseOutbox();
    };

    const overLimit = await revise({
      id: "weixin-meal-reclass-over-limit",
      text: "修改金额为40.01元",
      quotedMessageId: "provider-reclass-initial",
    });
    assert.match(overLimit.item.message, /费用类别：其他/u);
    assert.match(overLimit.item.message, /备注：无/u);
    await ackOutbox(overLimit, true, "provider-reclass-over-limit");

    const lowAmount = await revise({
      id: "weixin-meal-reclass-low",
      text: "修改金额为30元",
      quotedMessageId: "provider-reclass-over-limit",
    });
    assert.match(lowAmount.item.message, /费用类别：餐饮/u);
    assert.match(lowAmount.item.message, /备注：8\.25午餐/u);
    await ackOutbox(lowAmount, true, "provider-reclass-low");

    const dinner = await revise({
      id: "weixin-meal-reclass-time",
      text: "修改时间为18:00",
      quotedMessageId: "provider-reclass-low",
    });
    assert.match(dinner.item.message, /费用类别：餐饮/u);
    assert.match(dinner.item.message, /备注：8\.25晚餐/u);
    await ackOutbox(dinner, true, "provider-reclass-time");

    const manualCategory = await revise({
      id: "weixin-meal-reclass-manual",
      text: "修改费用类别为交通",
      quotedMessageId: "provider-reclass-time",
    });
    assert.match(manualCategory.item.message, /费用类别：交通/u);
    assert.match(manualCategory.item.message, /备注：无/u);
    await ackOutbox(manualCategory, true, "provider-reclass-manual");

    const afterManual = await revise({
      id: "weixin-meal-reclass-after-manual",
      text: "修改金额为20元",
      quotedMessageId: "provider-reclass-manual",
    });
    assert.match(afterManual.item.message, /费用类别：交通/u);
    assert.match(afterManual.item.message, /备注：无/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const stored = db.prepare(`
      SELECT category, subcategory, note, amount_cents, analysis_json
      FROM shortcut_bookkeeping_entries
    `).get();
    assert.deepEqual(
      {
        category: stored.category,
        subcategory: stored.subcategory,
        note: stored.note,
        amountCents: stored.amount_cents,
        categoryAutomation: JSON.parse(stored.analysis_json).categoryAutomation,
      },
      {
        category: "交通",
        subcategory: null,
        note: null,
        amountCents: 2000,
        categoryAutomation: null,
      },
    );
    db.close();
  });

  it("clears stale category warnings when an amount correction reclassifies 50 yuan at noon as lunch", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-stale-category-proof"),
      body: JSON.stringify({
        conversationId: "conversation-meal-stale-category-proof",
        text: "",
        sourceMessageId: "weixin-meal-stale-category-proof",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "stale-category-warning.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    const initial = await leaseOutbox();
    assert.match(initial.item.message, /金额：50\.00 元/u);
    assert.match(initial.item.message, /费用类别：其他/u);
    assert.match(initial.item.message, /AI 状态：待复核：信息待补充/u);
    await ackOutbox(initial, true, "provider-stale-category-initial");

    const revised = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-meal-stale-category-correction"),
      body: JSON.stringify({
        conversationId: "conversation-meal-stale-category-proof",
        text: "修改金额为30元",
        sourceMessageId: "weixin-meal-stale-category-correction",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-stale-category-initial",
      }),
    });
    assert.equal(revised.response.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.status, "review_required");
    const revisedDraft = await leaseOutbox();
    assert.match(revisedDraft.item.message, /金额：30\.00 元/u);
    assert.match(revisedDraft.item.message, /费用类别：餐饮/u);
    assert.match(revisedDraft.item.message, /备注：8\.25午餐/u);
    assert.match(revisedDraft.item.message, /AI 状态：待复核：出差区域待确认/u);
    assert.match(revisedDraft.item.message, /请先回复“20260824-20260830区域是济南”/u);
    assert.doesNotMatch(revisedDraft.item.message, /信息待补充/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const stored = db.prepare(`
      SELECT category, subcategory, analysis_json
      FROM shortcut_bookkeeping_entries
    `).get();
    const storedWarnings = JSON.parse(stored.analysis_json).warnings;
    assert.deepEqual(
      { category: stored.category, subcategory: stored.subcategory },
      { category: "餐饮", subcategory: "午餐" },
    );
    assert.equal(storedWarnings.includes("missing_category"), false);
    assert.equal(storedWarnings.includes("invalid_category"), false);
    db.close();
  });

  it("routes a vision-only formal invoice classification to invoice ingestion", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-vision-only-invoice"),
      body: JSON.stringify({
        conversationId: "conversation-vision-only-invoice",
        text: "",
        sourceMessageId: "weixin-vision-only-invoice",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "visual-document.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });

    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    assert.match(received.body.text, /发票已存入/u);
    assert.equal(lastRecognitionOptions?.referenceDate, "2026-08-25");
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
    db.close();
  });

  it("rejects an otherwise allowlisted but unbound sender before persisting a bookkeeping draft", async () => {
    const denied = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-unbound-sender"),
      body: JSON.stringify({
        conversationId: "conversation-unbound-sender",
        text: "",
        sourceMessageId: "weixin-image-unbound-sender",
        senderId: "sender-2",
        chatType: "direct",
        media: {
          type: "image",
          fileName: "proof.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    // v0.9.3：未绑定 sender 在入口即固定拒答（不入编排、不落库、不写 blob）。
    assert.equal(denied.response.status, 200);
    assert.equal(denied.body.status, "denied");
    assert.match(denied.body.text, /尚未绑定工作台账号/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_document_inbox").get().count, 0);
    db.close();
  });

  it("accepts the same text description as two distinct WeChat events", async () => {
    for (const suffix of ["one", "two"]) {
      const received = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(`weixin-text-repeat-${suffix}`),
        body: JSON.stringify({
          conversationId: "conversation-text-repeat",
          text: "支出 18.50 元 打车",
          sourceMessageId: `weixin-text-repeat-${suffix}`,
          senderId: sender,
          chatType: "direct",
          suppressQuote: true,
        }),
      });
      assert.equal(received.response.status, 200, JSON.stringify(received.body));
    }
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 2);
    db.close();
  });

  it("classifies an image-only loan arrival from OCR as income", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-income-image"),
      body: JSON.stringify({
        conversationId: "conversation-income-image",
        text: "",
        sourceMessageId: "weixin-income-image",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "income.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    const draft = await leaseOutbox();
    assert.match(draft.item.message, /类型：收入/u);
    assert.match(draft.item.message, /费用类别：出差-借款/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT entry_type FROM shortcut_bookkeeping_entries").get().entry_type, "income");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    db.close();
  });

  it("routes a bare invoice image to the invoice repository instead of creating an expense draft", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-bare-invoice-image"),
      body: JSON.stringify({
        conversationId: "conversation-bare-invoice",
        text: "",
        sourceMessageId: "weixin-bare-invoice-image",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "scan.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    assert.match(received.body.text, /发票已存入/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
    db.close();
  });

  it("classifies a generic bare image as an invoice from OCR markers", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-generic-invoice-image"),
      body: JSON.stringify({
        conversationId: "conversation-generic-invoice",
        text: "",
        sourceMessageId: "weixin-generic-invoice-image",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "generic-invoice.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    assert.match(received.body.text, /发票已存入/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
    db.close();
  });

  it("rejects an invoice from an allowlisted but unbound sender before persistence", async () => {
    const denied = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-invoice-unbound-sender"),
      body: JSON.stringify({
        conversationId: "conversation-invoice-unbound-sender",
        text: "发票",
        sourceMessageId: "weixin-invoice-unbound-sender",
        senderId: "sender-2",
        chatType: "direct",
        media: {
          type: "image",
          fileName: "电子发票.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    // v0.9.3：未绑定 sender 在入口即固定拒答，发票 blob 不落库。
    assert.equal(denied.response.status, 200);
    assert.equal(denied.body.status, "denied");
    assert.match(denied.body.text, /尚未绑定工作台账号/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_matches").get().count, 0);
    db.close();
  });

  it("accepts a bare WeChat payment image, sends the fixed draft, and attaches the original after quote confirmation", async () => {
    const sourceMessageId = "weixin-image-bookkeeping-1";
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-image-1",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "IMG_6119.jpg",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    assert.match(received.body.text, /付款凭证/);

    const lease = await leaseOutbox();
    assert.equal(lease.item.message, [
      "【小小提醒！新增一条待记账信息】",
      "编号：202608181736",
      "类型：支出",
      "金额：219.00 元",
      "费用类别：住宿费",
      "备注：无",
      "周期：20260817-20260823",
      "AI 状态：已识别，待你确认",
      "",
      "请引用本消息并回复",
    ].join("\n"));
    await ackOutbox(lease, true, "provider-image-bookkeeping-1");

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-bookkeeping-confirm-1"),
      body: JSON.stringify({
        conversationId: "conversation-image-1",
        text: "确认",
        sourceMessageId: "weixin-image-bookkeeping-confirm-1",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-image-bookkeeping-1",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.body.text, /已确认并录入/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments").get().count, 1);
    assert.equal(db.prepare("SELECT status FROM travel_expense_document_inbox").get().status, "matched");
    assert.equal(db.prepare("SELECT amount_cents, reimbursement_cents, funding_source FROM travel_expense_payments").get().amount_cents, 21900);
    assert.equal(db.prepare("SELECT reimbursement_cents FROM travel_expense_payments").get().reimbursement_cents, 21900);
    assert.equal(db.prepare("SELECT funding_source FROM travel_expense_payments").get().funding_source, "personal");
    db.close();
  });

  it("updates a compact quoted note correction and keeps the row and analysis snapshot in sync", async () => {
    const sourceMessageId = "weixin-image-note-correction";
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-image-note-correction",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "note-correction.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200, JSON.stringify(received.body));

    const original = await leaseOutbox();
    assert.match(original.item.message, /备注：无/u);
    await ackOutbox(original, true, "provider-note-correction-original");

    const corrected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-note-correction-reply"),
      body: JSON.stringify({
        conversationId: "conversation-image-note-correction",
        text: "修改备注8.18晚餐：继振、宫涛",
        sourceMessageId: "weixin-image-note-correction-reply",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-note-correction-original",
      }),
    });
    assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
    assert.equal(corrected.body.status, "review_required");

    const revised = await leaseOutbox();
    assert.match(revised.item.message, /备注：8\.18晚餐：继振、宫涛/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const row = db.prepare("SELECT note, analysis_json FROM shortcut_bookkeeping_entries").get();
    assert.equal(row.note, "8.18晚餐：继振、宫涛");
    assert.equal(JSON.parse(row.analysis_json).note, row.note);
    db.close();

    const staleConfirmation = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-note-correction-stale-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-image-note-correction",
        text: "确认",
        sourceMessageId: "weixin-image-note-correction-stale-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-note-correction-original",
      }),
    });
    assert.equal(staleConfirmation.response.status, 409, JSON.stringify(staleConfirmation.body));
    assert.equal(staleConfirmation.body.status, "error");

    await ackOutbox(revised, true, "provider-note-correction-revised");
    const accepted = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-note-correction-current-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-image-note-correction",
        text: "确认",
        sourceMessageId: "weixin-image-note-correction-current-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-note-correction-revised",
      }),
    });
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    assert.match(accepted.body.text, /已确认并录入/u);
    const acceptedDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(acceptedDb.prepare("SELECT status FROM shortcut_bookkeeping_entries").get().status, "accepted");
    assert.equal(acceptedDb.prepare("SELECT notes FROM travel_expenses").get().notes, "8.18晚餐：继振、宫涛");
    acceptedDb.close();
  });

  it("uses the uniquely recent draft when Weixin omits quote metadata and keeps older pending work untouched", async () => {
    const capture = async (sourceMessageId, fileName, content, mimeType) => request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-missing-provider-quote",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName,
          mimeType,
          contentBase64: content.toString("base64"),
        },
      }),
    });

    assert.equal((await capture("weixin-missing-quote-old", "old-proof.png", VALID_PNG, "image/png")).response.status, 200);
    const oldDraft = await leaseOutbox();
    await ackOutbox(oldDraft, true, "provider-missing-quote-old");
    let db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    db.prepare(`
      UPDATE assistant_pending_actions
      SET created_at = '2026-08-25T04:00:00.000Z', updated_at = '2026-08-25T04:00:00.000Z'
      WHERE id = 'action-1'
    `).run();
    db.close();

    assert.equal((await capture("weixin-missing-quote-new", "new-proof.jpg", VALID_JPEG, "image/jpeg")).response.status, 200);
    const corrected = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-missing-quote-correction"),
      body: JSON.stringify({
        conversationId: "conversation-missing-provider-quote",
        text: "修改备注8.18晚餐：继振、宫涛",
        sourceMessageId: "weixin-missing-quote-correction",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
    assert.equal(corrected.body.status, "review_required");

    const revisedDraft = await leaseOutbox();
    assert.match(revisedDraft.item.message, /备注：8\.18晚餐：继振、宫涛/u);
    await ackOutbox(revisedDraft, true, "provider-missing-quote-revised");
    db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      db.prepare("SELECT id, note FROM shortcut_bookkeeping_entries ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "entry-1", note: null }, { id: "entry-2", note: "8.18晚餐：继振、宫涛" }],
    );
    assert.deepEqual(
      db.prepare("SELECT id, version FROM assistant_pending_actions ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "action-1", version: 1 }, { id: "action-2", version: 2 }],
    );
    db.close();

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-missing-quote-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-missing-provider-quote",
        text: "确认",
        sourceMessageId: "weixin-missing-quote-confirm",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.match(confirmed.body.text, /已确认并录入/u);
    db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      db.prepare("SELECT id, status FROM shortcut_bookkeeping_entries ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "entry-1", status: "review_required" }, { id: "entry-2", status: "accepted" }],
    );
    assert.equal(db.prepare("SELECT notes FROM travel_expenses").get().notes, "8.18晚餐：继振、宫涛");
    db.close();
  });

  it("keeps the bookkeeping-field 修改 corpus in the correction chain after the customer-write yield narrowing", async () => {
    const captured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-correction-corpus-capture"),
      body: JSON.stringify({
        conversationId: "conversation-correction-corpus",
        text: "支出 2026-08-18 打车 12.80元 语料回归",
        sourceMessageId: "weixin-correction-corpus-capture",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(captured.response.status, 200, JSON.stringify(captured.body));

    const send = async (index, text, quotedMessageId = null) => {
      const sourceMessageId = `weixin-correction-corpus-${index}`;
      const result = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(sourceMessageId),
        body: JSON.stringify({
          conversationId: "conversation-correction-corpus",
          text,
          sourceMessageId,
          senderId: sender,
          chatType: "direct",
          ...(quotedMessageId ? { quotedMessageId } : { suppressQuote: true }),
        }),
      });
      assert.equal(result.response.status, 200, `${text}: ${JSON.stringify(result.body)}`);
      return result.body;
    };

    const REVISED = /已按你的修改更新草稿/u;
    const MENU_CLARIFY = /费用类别或小类不在当前三级记账菜单中/u;
    // Every entry must stay inside the bookkeeping chain (no router toolName)
    // even though 修改客户/修改商机 now yield to the deterministic router.
    const corpus = [
      ["修改金额 100元", REVISED],
      ["修改：金额改为86.5元", REVISED],
      ["修改时间 14:30", REVISED],
      ["修改日期 8月27日", REVISED],
      ["修改发生时间 2026-08-27T09:00:00+08:00", REVISED],
      ["修改费用类别 交通", REVISED],
      ["修改子分类 打车", REVISED],
      ["修改分类 餐饮", REVISED],
      ["修改大类 差旅", MENU_CLARIFY],
      ["修改商户 滴滴出行", REVISED],
      ["修改用途 客户拜访打车", REVISED],
      ["修改备注：加急", REVISED],
      ["修改说明 项目应酬", REVISED],
      ["修改 把金额改成99元", REVISED],
    ];
    for (const [index, [text, expected]] of corpus.entries()) {
      const body = await send(index, text);
      assert.match(body.text, expected, text);
      assert.equal(body.toolName, undefined, text);
    }

    // Bare 确认/取消 while the freshest draft is still undelivered keep the
    // existing wait-for-draft guidance (unchanged behavior).
    for (const [index, text] of [["confirm", "确认"], ["cancel", "取消"]]) {
      const body = await send(`hold-${index}`, text);
      assert.match(body.text, /最新记账草稿尚未确认送达/u, text);
      assert.equal(body.toolName, undefined, text);
    }

    // A quoted bare 修改 still belongs to bookkeeping and re-issues the help.
    const finalDraft = await leaseOutbox();
    assert.match(finalDraft.item.message, /金额：99\.00 元/u);
    await ackOutbox(finalDraft, true, "provider-correction-corpus-final");
    const bareModify = await send("bare-modify", "修改", "provider-correction-corpus-final");
    assert.match(bareModify.text, /请以“修改”开头并明确字段/u);
    assert.equal(bareModify.toolName, undefined);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const entry = db.prepare(
      "SELECT status, amount_cents, merchant, note, category FROM shortcut_bookkeeping_entries",
    ).get();
    assert.deepEqual({ ...entry }, {
      status: "review_required",
      amount_cents: 9900,
      merchant: "滴滴出行",
      note: "项目应酬",
      category: "餐饮",
    });
    const action = db.prepare("SELECT status, version FROM assistant_pending_actions").get();
    assert.equal(action.status, "pending");
    assert.equal(Number(action.version), 14);
    db.close();
  });

  it("denies no-quote financial commands from another allowlisted sender or an allowed group", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-no-quote-scope-draft"),
      body: JSON.stringify({
        conversationId: "conversation-no-quote-scope-draft",
        text: "",
        sourceMessageId: "weixin-no-quote-scope-draft",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "scope-proof.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200, JSON.stringify(received.body));
    const draft = await leaseOutbox();
    await ackOutbox(draft, true, "provider-no-quote-scope-draft");

    const deniedCommands = ["修改备注为越权内容", "确认", "取消"];
    for (const [scopeName, eventScope, expect] of [
      // v0.9.3：未绑定 sender 在入口即固定拒答（更早、更闭合）。
      ["unbound", { senderId: "sender-2", chatType: "direct" }, "entry_denied"],
      // 已绑定 sender 的群聊进编排，由财务闸 403 拒绝（语义不变）。
      ["group", { senderId: sender, chatType: "group", groupId: "allowed-bookkeeping-test-group" }, "financial_denied"],
    ]) {
      for (const [index, text] of deniedCommands.entries()) {
        const sourceMessageId = `weixin-no-quote-${scopeName}-${index}`;
        const denied = await request("/api/integrations/weixin-agent/events", {
          method: "POST",
          headers: eventHeaders(sourceMessageId),
          body: JSON.stringify({
            conversationId: `conversation-no-quote-${scopeName}`,
            text,
            sourceMessageId,
            suppressQuote: true,
            ...eventScope,
          }),
        });
        if (expect === "entry_denied") {
          assert.equal(denied.response.status, 200, JSON.stringify(denied.body));
          assert.equal(denied.body.status, "denied");
          assert.match(denied.body.text, /尚未绑定工作台账号/u);
        } else {
          assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
          assert.equal(denied.body.status, "error");
          assert.match(denied.body.text, /本人私聊/u);
        }
      }
    }

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const entry = db.prepare("SELECT status, note FROM shortcut_bookkeeping_entries").get();
    assert.deepEqual({ ...entry }, { status: "review_required", note: null });
    const action = db.prepare("SELECT status, version FROM assistant_pending_actions").get();
    assert.deepEqual({ ...action }, { status: "pending", version: 1 });
    db.close();
  });

  it("rejects the pending payment-proof inbox item when the only image draft is cancelled", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-cancel-1"),
      body: JSON.stringify({
        conversationId: "conversation-image-cancel",
        text: "",
        sourceMessageId: "weixin-image-cancel-1",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "proof-cancel.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    const draft = await leaseOutbox();
    await ackOutbox(draft, true, "provider-image-cancel-1");

    const cancelled = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-cancel-confirmation"),
      body: JSON.stringify({
        conversationId: "conversation-image-cancel",
        text: "取消",
        sourceMessageId: "weixin-image-cancel-confirmation",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-image-cancel-1",
      }),
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.status, "cancel");
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT status FROM shortcut_bookkeeping_entries").get().status, "rejected");
    assert.equal(db.prepare("SELECT status FROM travel_expense_document_inbox").get().status, "rejected");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments").get().count, 0);
    db.close();
  });

  it("reconciles a missing accepted payment-proof attachment even after the receipt was sent", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-attachment-reconcile"),
      body: JSON.stringify({
        conversationId: "conversation-image-attachment-reconcile",
        text: "",
        sourceMessageId: "weixin-image-attachment-reconcile",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "proof-reconcile.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    const draft = await leaseOutbox();
    await ackOutbox(draft, true, "provider-image-attachment-reconcile");
    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-image-attachment-reconcile-confirm"),
      body: JSON.stringify({
        conversationId: "conversation-image-attachment-reconcile",
        text: "确认",
        sourceMessageId: "weixin-image-attachment-reconcile-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "provider-image-attachment-reconcile",
      }),
    });
    assert.equal(confirmed.response.status, 200);
    const receipt = await leaseOutbox();
    await ackOutbox(receipt, true, "provider-image-attachment-receipt");

    const before = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    before.exec("DELETE FROM travel_expense_attachment_payments; DELETE FROM travel_expense_attachments;");
    assert.equal(before.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments").get().count, 0);
    before.close();

    await reportWorkerReady();
    const after = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const attachment = after.prepare("SELECT kind, notes FROM travel_expense_attachments").get();
    assert.equal(attachment.kind, "payment_proof");
    assert.match(attachment.notes, /^微信图片记账:/u);
    after.close();
  });

  it("splits a multi-row payment screenshot into separately quoted drafts and replays the same image", async () => {
    const sendImage = (sourceMessageId) => request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-multi-image",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "multi.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    const received = await sendImage("weixin-multi-image-1");
    assert.equal(received.response.status, 200);
    assert.match(received.body.text, /共识别 2 笔/u);

    const configured = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-multi-region"),
      body: JSON.stringify({
        conversationId: "conversation-multi-image",
        text: "上周区域是济南",
        sourceMessageId: "weixin-multi-region",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(configured.response.status, 200);
    assert.match(configured.body.text, /已刷新 2 条/u);

    const first = await leaseOutbox();
    assert.match(first.item.message, /金额：12\.34 元/u);
    assert.match(first.item.message, /费用类别：餐饮/u);
    assert.match(first.item.message, /备注：8\.18济南早餐/u);
    assert.match(first.item.message, /周期：20260817-20260823/u);
    await ackOutbox(first, true, "multi-draft-1");
    const second = await leaseOutbox();
    assert.match(second.item.message, /金额：56\.78 元/u);
    assert.match(second.item.message, /费用类别：餐饮/u);
    assert.match(second.item.message, /备注：8\.18济南晚餐/u);
    await ackOutbox(second, true, "multi-draft-2");

    for (const [index, quotedMessageId] of ["multi-draft-1", "multi-draft-2"].entries()) {
      const confirmed = await request("/api/integrations/weixin-agent/events", {
        method: "POST",
        headers: eventHeaders(`weixin-multi-confirm-${index + 1}`),
        body: JSON.stringify({
          conversationId: "conversation-multi-image",
          text: "确认",
          sourceMessageId: `weixin-multi-confirm-${index + 1}`,
          senderId: sender,
          chatType: "direct",
          quotedMessageId,
        }),
      });
      assert.equal(confirmed.response.status, 200);
      assert.match(confirmed.body.text, /已确认并录入/u);
    }

    const replay = await sendImage("weixin-multi-image-replay");
    assert.equal(replay.response.status, 200);
    assert.match(replay.body.text, /已经收到/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments WHERE kind = 'payment_proof'").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_document_inbox").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_blobs").get().count, 1);
    assert.deepEqual(
      db.prepare("SELECT category, notes FROM travel_expenses ORDER BY rowid").all().map((row) => ({ ...row })),
      [
        { category: "breakfast", notes: "8.18济南早餐" },
        { category: "dinner", notes: "8.18济南晚餐" },
      ],
    );
    db.close();
  });

  it("freezes the first content-addressed draft set when repeated vision output would drift", async () => {
    const sendImage = (sourceMessageId) => request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-drift-image",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "drift.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });

    const first = await sendImage("weixin-drift-image-1");
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.match(first.body.text, /共识别 2 笔/u);
    assert.equal(driftingRecognitionCalls, 1);

    const replay = await sendImage("weixin-drift-image-2");
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.match(replay.body.text, /共识别 2 笔/u);
    assert.equal(driftingRecognitionCalls, 1);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      db.prepare(`
        SELECT amount_cents, category, subcategory
        FROM shortcut_bookkeeping_entries
        ORDER BY created_at, id
      `).all().map((row) => ({ ...row })),
      [
        { amount_cents: 1800, category: "餐饮", subcategory: "早餐" },
        { amount_cents: 2800, category: "餐饮", subcategory: "午餐" },
      ],
    );
    db.close();
  });

  it("commits only one complete source batch when concurrent first vision results disagree", async () => {
    const sendImage = (sourceMessageId) => request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(sourceMessageId),
      body: JSON.stringify({
        conversationId: "conversation-concurrent-image",
        text: "",
        sourceMessageId,
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "concurrent.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });

    const [left, right] = await Promise.all([
      sendImage("weixin-concurrent-image-1"),
      sendImage("weixin-concurrent-image-2"),
    ]);
    assert.equal(left.response.status, 200, JSON.stringify(left.body));
    assert.equal(right.response.status, 200, JSON.stringify(right.body));
    assert.equal(concurrentRecognitionCalls, 2);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const rows = db.prepare(`
      SELECT amount_cents FROM shortcut_bookkeeping_entries ORDER BY created_at, id
    `).all().map((row) => row.amount_cents);
    assert.ok(
      JSON.stringify(rows) === JSON.stringify([1100, 2200])
        || JSON.stringify(rows) === JSON.stringify([1100, 2200, 3300]),
      JSON.stringify(rows),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_document_inbox").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT source_id) AS count FROM shortcut_bookkeeping_entries").get().count, 1);
    db.close();
  });

  it("keeps time-adjacent drafts ambiguous when provider quote metadata is missing", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-multi-missing-quote"),
      body: JSON.stringify({
        conversationId: "conversation-multi-missing-quote",
        text: "",
        sourceMessageId: "weixin-multi-missing-quote",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "image",
          fileName: "multi.png",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);

    const ambiguous = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin-multi-missing-quote-correction"),
      body: JSON.stringify({
        conversationId: "conversation-multi-missing-quote",
        text: "修改备注为晚餐",
        sourceMessageId: "weixin-multi-missing-quote-correction",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
      }),
    });
    assert.equal(ambiguous.response.status, 409);
    assert.equal(ambiguous.body.status, "clarify");
    assert.match(ambiguous.body.text, /多笔待确认/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.deepEqual(
      db.prepare("SELECT note FROM shortcut_bookkeeping_entries").all().map((row) => row.note),
      ["8.18早餐", "8.18晚餐"],
    );
    assert.deepEqual(db.prepare("SELECT version FROM assistant_pending_actions").all().map((row) => row.version), [1, 1]);
    db.close();
  });

  it("matches a later WeChat invoice by exact amount and links its compressed copy to the payment", async () => {
    const received = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("invoice-link-payment-proof"),
      body: JSON.stringify({
        conversationId: "invoice-link-conversation",
        text: "",
        sourceMessageId: "invoice-link-payment-proof",
        senderId: sender,
        chatType: "direct",
        media: {
          type: "image",
          fileName: "proof.jpg",
          mimeType: "image/png",
          contentBase64: VALID_PNG.toString("base64"),
        },
      }),
    });
    assert.equal(received.response.status, 200);
    const draft = await leaseOutbox();
    await ackOutbox(draft, true, "invoice-link-draft");
    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("invoice-link-payment-proof-confirm"),
      body: JSON.stringify({
        conversationId: "invoice-link-conversation",
        text: "确认",
        sourceMessageId: "invoice-link-payment-proof-confirm",
        senderId: sender,
        chatType: "direct",
        quotedMessageId: "invoice-link-draft",
      }),
    });
    assert.equal(confirmed.response.status, 200);

    const invoice = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("invoice-link-invoice"),
      body: JSON.stringify({
        conversationId: "invoice-link-conversation",
        text: "发票",
        sourceMessageId: "invoice-link-invoice",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "file",
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          contentBase64: minimalPdf("invoice-link").toString("base64"),
        },
      }),
    });
    assert.equal(invoice.response.status, 200, JSON.stringify(invoice.body));
    assert.equal(invoice.body.status, "ok");
    assert.match(invoice.body.text, /自动绑定费用/u);

    const replayedInvoice = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("invoice-link-invoice-replay"),
      body: JSON.stringify({
        conversationId: "invoice-link-conversation",
        text: "发票",
        sourceMessageId: "invoice-link-invoice-replay",
        senderId: sender,
        chatType: "direct",
        suppressQuote: true,
        media: {
          type: "file",
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          contentBase64: minimalPdf("invoice-link").toString("base64"),
        },
      }),
    });
    assert.equal(replayedInvoice.response.status, 200, JSON.stringify(replayedInvoice.body));
    assert.match(replayedInvoice.body.text, /自动绑定费用/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_matches WHERE state = 'confirmed'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments WHERE kind = 'invoice'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents WHERE status = 'matched'").get().count, 1);
    db.exec("DELETE FROM travel_expense_attachment_payments WHERE attachment_id IN (SELECT id FROM travel_expense_attachments WHERE kind = 'invoice'); DELETE FROM travel_expense_attachments WHERE kind = 'invoice';");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_attachments WHERE kind = 'invoice'").get().count, 0);
    db.close();

    const retry = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.ok([200, 204].includes(retry.response.status));
    const reconciled = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const invoiceAttachment = reconciled.prepare("SELECT kind, notes FROM travel_expense_attachments WHERE kind = 'invoice'").get();
    assert.equal(invoiceAttachment.kind, "invoice");
    assert.match(invoiceAttachment.notes, /^微信发票自动关联:/u);
    reconciled.close();
  });

});
