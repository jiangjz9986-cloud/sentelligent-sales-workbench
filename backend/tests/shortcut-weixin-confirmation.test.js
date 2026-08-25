import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";
import { createRemoteClawbotAgent } from "../src/weixin/remoteAgent.js";
import { minimalPdf, VALID_JPEG, VALID_PNG } from "./helpers/image-fixtures.js";

const machineToken = "weixin-machine-test-token";
const owner = "assistant-owner";
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
      purpose: "客户拜访交通",
      merchant: "济南出租车",
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
      "合成商户甲 -12.34",
      "8月18日 09:10",
      "合成商户乙 -56.78",
      "8月18日 18:20",
    ].join("\n"),
    evidence: { amountCents: 1234, occurredOn: null, paidTime: null, merchant: "合成商户甲", paymentMethod: "bank_card" },
    confidence: 0.98,
    warnings: [],
    source: { provider: "test", model: null },
    layout: {
      pageWidth: 1280,
      pageHeight: 520,
      tokens: [
        token("合成商户甲", 240, 45, 220, 1, 1),
        token("-12.34", 1120, 45, 120, 1, 2),
        token("8月18日", 240, 105, 140, 2, 1),
        token("09:10", 400, 105, 100, 2, 2),
        token("合成商户乙", 240, 290, 220, 3, 1),
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
    "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(owner, sender),
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
    weixinAllowGroups: false,
    assistantConfirmationSecret: confirmationSecret,
    assistantClock: () => new Date("2026-08-25T06:24:00.000Z"),
    shortcutBookkeepingIdFactory: () => `entry-${++entrySequence}`,
    shortcutBookkeepingAssistantIdFactory: () => `action-${++actionSequence}`,
    weixinConfirmationOutboxIdFactory: () => `outbox-${++outboxSequence}`,
    travelExpenseAnalyzer: async () => analysis(),
    paymentProofRecognizer: async ({ fileName }, recognitionOptions = {}) => {
      lastRecognitionOptions = recognitionOptions;
      if (fileName === "multi.png") return multiRowRecognition();
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
  await reportWorkerReady();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("小小微信图片记账与自然语言确认闭环", () => {
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
    assert.deepEqual(lastRecognitionOptions, { referenceDate: "2026-08-25" });
    const draft = await leaseOutbox();
    assert.match(draft.item.message, /编号：202608201129/u);
    assert.match(draft.item.message, /金额：37\.10 元/u);
    assert.match(draft.item.message, /备注：合成平台/u);
    assert.match(draft.item.message, /周期：20260817-20260823/u);
    assert.match(draft.item.message, /AI 状态：已识别，待你确认/u);
    const db = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const row = db.prepare("SELECT amount_cents, occurred_on, note FROM shortcut_bookkeeping_entries").get();
    assert.equal(row.amount_cents, 3710);
    assert.equal(row.occurred_on, "2026-08-20");
    assert.equal(row.note, "合成平台");
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
    assert.deepEqual(lastRecognitionOptions, { referenceDate: "2026-08-25" });
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
    assert.equal(denied.response.status, 200);
    assert.match(denied.body.text, /仅限已绑定账号本人/u);
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
    assert.equal(denied.response.status, 200);
    assert.match(denied.body.text, /仅限已绑定账号本人/u);
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
      "备注：华住酒店集团",
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

    const first = await leaseOutbox();
    assert.match(first.item.message, /金额：12\.34 元/u);
    assert.match(first.item.message, /备注：合成商户甲/u);
    assert.match(first.item.message, /周期：20260817-20260823/u);
    await ackOutbox(first, true, "multi-draft-1");
    const second = await leaseOutbox();
    assert.match(second.item.message, /金额：56\.78 元/u);
    assert.match(second.item.message, /备注：合成商户乙/u);
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
