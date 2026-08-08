import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { createRemoteClawbotAgent } from "../src/weixin/remoteAgent.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

const machineToken = "test-machine-token";
let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
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

function eventBody(overrides = {}) {
  return {
    conversationId: "conversation-http-1",
    text: "拜访日照中医医院，客户希望补齐十五五规划材料。",
    sourceMessageId: "message-http-1",
    senderId: "sender-1",
    chatType: "direct",
    ...overrides,
  };
}

function eventHeaders(key = "weixin:message-http-1") {
  return {
    Authorization: `Bearer ${machineToken}`,
    "Idempotency-Key": key,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-assistant-http-"));
  server = createServer({
    databaseUrl: join(tempDir, "assistant.sqlite"),
    seed: true,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "assistant-owner",
    authPassword: "",
    authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 13) }),
    authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "assistant-owner",
    weixinAllowedSenderIds: "sender-1,sender-2",
    weixinAllowGroups: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("persistent WeChat assistant events HTTP boundary", () => {
  it("accepts an allowlisted direct message and persists its response for replay", async () => {
    const first = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(),
      body: JSON.stringify(eventBody()),
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, "ok");
    assert.match(first.body.text, /已暂存/);

    const replay = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(),
      body: JSON.stringify(eventBody()),
    });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);
  });

  it("rejects a reused source message id with different content", async () => {
    const first = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(),
      body: JSON.stringify(eventBody()),
    });
    assert.equal(first.response.status, 200);

    const conflict = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders(),
      body: JSON.stringify(eventBody({ text: "完全不同的消息" })),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "ASSISTANT_EVENT_CONFLICT");
  });

  it("accepts a lossless Base64 image for invoice ingestion without accepting owner or path fields", async () => {
    const body = eventBody({
      text: "/发票",
      sourceMessageId: "message-invoice-1",
      media: {
        type: "image",
        fileName: "receipt.png",
        mimeType: "image/png",
        contentBase64: VALID_PNG.toString("base64"),
      },
    });
    const result = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:message-invoice-1"),
      body: JSON.stringify(body),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, "ok");
    assert.match(result.body.text, /发票/);
    assert.doesNotMatch(JSON.stringify(result.body), /filePath|assistant-owner/);

    const forbidden = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:message-invoice-2"),
      body: JSON.stringify({ ...body, sourceMessageId: "message-invoice-2", owner: "attacker" }),
    });
    assert.equal(forbidden.response.status, 422);
    assert.equal(forbidden.body.error.code, "VALIDATION_ERROR");
  });

  it("returns a bounded validation error for malformed remote media", async () => {
    const result = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:bad-media"),
      body: JSON.stringify(eventBody({
        sourceMessageId: "bad-media",
        text: "/发票",
        media: { type: "image", fileName: "bad.png", mimeType: "image/png", contentBase64: "not-base64" },
      })),
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.error.code, "VALIDATION_ERROR");
    assert.doesNotMatch(JSON.stringify(result.body), /stack|filePath|not-base64/i);
  });

  it("rejects unallowlisted senders and group messages before creating an event", async () => {
    const sender = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:sender-denied"),
      body: JSON.stringify(eventBody({ senderId: "sender-denied", sourceMessageId: "sender-denied" })),
    });
    assert.equal(sender.response.status, 403);
    assert.equal(sender.body.error.code, "WEIXIN_SENDER_NOT_ALLOWED");

    const group = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:group-denied"),
      body: JSON.stringify(eventBody({ chatType: "group", groupId: "group-1", sourceMessageId: "group-denied" })),
    });
    assert.equal(group.response.status, 403);
    assert.equal(group.body.error.code, "WEIXIN_GROUP_NOT_ALLOWED");
  });

  it("requires the exact machine token and idempotency header", async () => {
    const unauthorized = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Idempotency-Key": "weixin:bad" },
      body: JSON.stringify(eventBody({ sourceMessageId: "unauthorized" })),
    });
    assert.equal(unauthorized.response.status, 401);

    const missingKey = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
      body: JSON.stringify(eventBody({ sourceMessageId: "missing-key" })),
    });
    assert.equal(missingKey.response.status, 428);
    assert.equal(missingKey.body.error.code, "PRECONDITION_REQUIRED");

    const mismatchedKey = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:not-the-source-id"),
      body: JSON.stringify(eventBody({ sourceMessageId: "source-id" })),
    });
    assert.equal(mismatchedKey.response.status, 422);
    assert.equal(mismatchedKey.body.error.fields.idempotencyKey, "mismatch");
  });

  it("keeps the visit draft across events and writes only after the confirmation code", async () => {
    const collect = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:visit-collect"),
      body: JSON.stringify(eventBody({ sourceMessageId: "visit-collect" })),
    });
    assert.equal(collect.response.status, 200);

    const preview = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:visit-preview"),
      body: JSON.stringify(eventBody({ sourceMessageId: "visit-preview", text: "记录" })),
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.status, "ok");
    assert.match(preview.body.text, /待确认记录/);

    const pending = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:visit-confirm-request"),
      body: JSON.stringify(eventBody({ sourceMessageId: "visit-confirm-request", text: "录入" })),
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.status, "confirmation_required");
    assert.match(pending.body.confirmationCode, /^\d{6}$/);

    const pendingReplay = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:visit-confirm-request"),
      body: JSON.stringify(eventBody({ sourceMessageId: "visit-confirm-request", text: "录入" })),
    });
    assert.equal(pendingReplay.response.status, 200);
    assert.equal(Object.hasOwn(pendingReplay.body, "confirmationCode"), false);
    const persisted = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    const eventRows = persisted.prepare("SELECT response_json FROM assistant_inbound_events WHERE response_json LIKE '%confirmation_required%'").all();
    assert.ok(eventRows.length >= 1);
    assert.equal(eventRows.some((row) => String(row.response_json).includes(pending.body.confirmationCode)), false);
    persisted.close();

    const confirmed = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:visit-confirmed"),
      body: JSON.stringify(eventBody({
        sourceMessageId: "visit-confirmed",
        text: "确认",
        pendingActionId: pending.body.actionId,
        confirmationCode: pending.body.confirmationCode,
      })),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");
    assert.match(confirmed.body.text, /已录入系统/);
  });

  it("restores the same assistant conversation after the server process is reopened", async () => {
    const collect = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:restart-collect"),
      body: JSON.stringify(eventBody({ sourceMessageId: "restart-collect" })),
    });
    assert.equal(collect.response.status, 200);
    await new Promise((resolve) => server.close(resolve));

    server = createServer({
      databaseUrl: join(tempDir, "assistant.sqlite"),
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: "assistant-owner",
      authPassword: "",
      authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 13) }),
      authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
      authCookieSecure: false,
      weixinAgentApiToken: machineToken,
      weixinAgentOwner: "assistant-owner",
      weixinAllowedSenderIds: "sender-1,sender-2",
      weixinAllowGroups: false,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const preview = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:restart-preview"),
      body: JSON.stringify(eventBody({ sourceMessageId: "restart-preview", text: "记录" })),
    });
    assert.equal(preview.response.status, 200);
    assert.match(preview.body.text, /待确认记录/);
  });

  it("completes the real remote adapter to HTTP event boundary", async () => {
    const agent = createRemoteClawbotAgent({
      backendUrl: baseUrl,
      apiToken: machineToken,
      senderId: "sender-1",
    });
    const reply = await agent.chat({
      conversationId: "remote-end-to-end",
      messageId: "remote-message-1",
      text: "拜访青岛市立医院，客户需要会议纪要。",
    });
    assert.equal(reply.status, "ok");
    assert.match(reply.text, /已暂存/);
  });

  it("keeps sales reports and reimbursement summaries as separate read-only agents", async () => {
    const sales = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:sales-report"),
      body: JSON.stringify(eventBody({ sourceMessageId: "sales-report", text: "销售周报" })),
    });
    const reimbursement = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:reimbursement-report"),
      body: JSON.stringify(eventBody({ sourceMessageId: "reimbursement-report", text: "报销周汇总" })),
    });
    assert.equal(sales.response.status, 200);
    assert.equal(reimbursement.response.status, 200);
    assert.match(sales.body.text, /销售周报预览/);
    assert.match(reimbursement.body.text, /报销周汇总预览/);
  });

  it("isolates assistant drafts when two senders reuse the same conversation id", async () => {
    const senderOne = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:sender-one-collect"),
      body: JSON.stringify(eventBody({ senderId: "sender-1", sourceMessageId: "sender-one-collect" })),
    });
    assert.equal(senderOne.response.status, 200);

    const senderTwoPreview = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:sender-two-preview"),
      body: JSON.stringify(eventBody({ senderId: "sender-2", sourceMessageId: "sender-two-preview", text: "记录" })),
    });
    assert.equal(senderTwoPreview.response.status, 200);
    assert.match(senderTwoPreview.body.text, /当前没有暂存内容/);

    const senderOnePreview = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:sender-one-preview"),
      body: JSON.stringify(eventBody({ senderId: "sender-1", sourceMessageId: "sender-one-preview", text: "记录" })),
    });
    assert.equal(senderOnePreview.response.status, 200);
    assert.match(senderOnePreview.body.text, /待确认记录/);
  });

  it("rolls back an assistant invoice upload when its audit write fails", async () => {
    const auditDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    auditDb.exec(`
      CREATE TRIGGER fail_assistant_invoice_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'invoice.create'
      BEGIN
        SELECT RAISE(ABORT, 'forced assistant invoice audit failure');
      END;
    `);
    auditDb.close();

    const result = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:invoice-audit-failure"),
      body: JSON.stringify(eventBody({
        sourceMessageId: "invoice-audit-failure",
        text: "/发票",
        media: { type: "image", fileName: "receipt.png", mimeType: "image/png", contentBase64: VALID_PNG.toString("base64") },
      })),
    });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.status, "error");
    assert.match(result.body.text, /处理失败/);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    const verifyDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 0);
    verifyDb.close();
  });

  it("rolls back an assistant payment-proof upload when its audit write fails", async () => {
    const auditDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    auditDb.exec(`
      CREATE TRIGGER fail_assistant_payment_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'travel_expense_document_inbox.create'
      BEGIN
        SELECT RAISE(ABORT, 'forced assistant payment audit failure');
      END;
    `);
    auditDb.close();

    const result = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: eventHeaders("weixin:payment-audit-failure"),
      body: JSON.stringify(eventBody({
        sourceMessageId: "payment-audit-failure",
        text: "/付款凭证",
        media: { type: "image", fileName: "receipt.png", mimeType: "image/png", contentBase64: VALID_PNG.toString("base64") },
      })),
    });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.status, "error");

    await new Promise((resolve) => server.close(resolve));
    server = null;
    const verifyDb = openDatabase({ databaseUrl: join(tempDir, "assistant.sqlite") });
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM travel_expense_document_inbox").get().count, 0);
    verifyDb.close();
  });
});
