import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const password = "test-token-api-password";
const account = "jiangjz";
const legacyToken = "test-token";
const machineToken = "test-machine-token";
const sender = "shortcut-sender";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "review-test-worker",
    "X-Weixin-Delivery-Status": "ready",
    "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(account, sender),
  };
}

async function login() {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(response.response.status, 200);
  return { cookie: cookiePair(response.response), csrf: response.body.csrfToken };
}

async function startServer(serverOptions = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-webhook-token-api-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPasswordHash: await hashPassword(password, { salt: Buffer.alloc(16, 7) }),
    authSessionSecret: Buffer.alloc(32, 5).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    shortcutWebhookToken: legacyToken,
    shortcutWebhookOwner: account,
    shortcutWeixinConfirmationEnabled: true,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: account,
    weixinBookkeepingOwner: account,
    weixinBookkeepingSenderId: sender,
    weixinAllowedSenderIds: [sender],
    travelExpenseAnalyzer: async () => ({
      status: "ready",
      confidence: 1,
      expense: {
        occurredOn: "2026-08-16",
        amountCents: 1280,
        reimbursementCents: 1280,
        purpose: "打车",
        merchant: "示例商户",
        paidAt: "2026-08-16T12:00:00+08:00",
        fundingSource: "personal",
        paymentMethod: "alipay",
      },
      warnings: [],
      source: { provider: "test", model: null },
    }),
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    headers: workerHeaders(),
  });
  assert.equal(heartbeat.status, 204);
}

beforeEach(startServer);
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  baseUrl = null;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Shortcut webhook token management API", () => {
  it("exposes owner-scoped Shortcut review list/detail and manual confirmation", async () => {
    const staleTempDir = tempDir;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startServer({
      travelExpenseAnalyzer: async () => ({
        status: "review_required",
        confidence: 0,
        expense: null,
        warnings: ["missing_amount"],
        source: { provider: "test", model: null },
      }),
    });
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}` },
      body: JSON.stringify({
        text: "缺少金额的差旅记录",
        selection_path: "出差报销 · 支出 · 交通 · 打车",
        note: "待复核",
        idempotency_key: "shortcut-review-api-1",
        source: "shortcut",
      }),
    });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.item.status, "review_required");
    const staleDraft = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(staleDraft.response.status, 200);
    assert.match(staleDraft.body.item.message, /回复“确认”/u);
    assert.doesNotMatch(staleDraft.body.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);

    const session = await login();
    const list = await request("/api/integrations/shortcut/bookkeeping/review?status=review_required", {
      headers: { Cookie: session.cookie },
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].rawText, "缺少金额的差旅记录");

    const detail = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}`, {
      headers: { Cookie: session.cookie },
    });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.id, created.body.item.id);

    const confirmed = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({
        analysis: {
          status: "ready",
          confidence: 1,
          expense: {
            occurredOn: "2026-08-18",
            amountCents: 1280,
            reimbursementCents: 1280,
            purpose: "人工确认打车",
            merchant: "示例商户",
          },
          warnings: [],
          source: { provider: "manual", model: null },
        },
      }),
    });
    assert.equal(confirmed.response.status, 201);
    assert.equal(confirmed.body.item.status, "accepted");
    assert.ok(confirmed.body.item.expenseId);
    assert.ok(confirmed.body.item.paymentId);

    const staleLease = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
      body: JSON.stringify({
        id: staleDraft.body.item.id,
        leaseToken: staleDraft.body.leaseToken,
        check: true,
      }),
    });
    assert.equal(staleLease.response.status, 200);
    assert.equal(staleLease.body.current, false);

    const receipt = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(receipt.response.status, 200);
    assert.match(receipt.body.item.message, /已确认并录入森特智行/u);
    assert.doesNotMatch(receipt.body.item.message, /(?:^|\n)\d{6}(?:\n|$)/u);
    const receiptAck = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
      body: JSON.stringify({
        id: receipt.body.item.id,
        leaseToken: receipt.body.leaseToken,
        ok: true,
      }),
    });
    assert.equal(receiptAck.response.status, 200);

    const replay = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ analysis: confirmed.body.item.analysis ?? {} }),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.expenseId, confirmed.body.item.expenseId);

    const next = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}` },
      body: JSON.stringify({
        text: "下一笔待复核差旅记录",
        selection_path: "出差报销 · 支出 · 餐饮 · 午餐",
        note: "下一笔",
        idempotency_key: "shortcut-review-api-next",
        source: "shortcut",
      }),
    });
    assert.equal(next.response.status, 202);
    assert.notEqual(next.body.error?.code, "ASSISTANT_ACTION_PENDING");

    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_pending_actions WHERE status = 'executed'").get().count, 1);
    assert.equal(db.prepare("SELECT status FROM weixin_confirmation_outbox WHERE id = ?").get(staleDraft.body.item.id).status, "failed");
    db.close();
    await rm(staleTempDir, { recursive: true, force: true });
  });

  it("cancels a sent WeChat draft after Web rejection and frees the next bookkeeping draft", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}` },
      body: JSON.stringify({
        text: "2026-08-16 打车 12.80 元",
        selection_path: "出差报销 · 支出 · 交通 · 打车",
        note: "网页拒绝测试",
        idempotency_key: "shortcut-web-reject",
        source: "shortcut",
      }),
    });
    assert.equal(created.response.status, 202);
    const draft = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(draft.response.status, 200);
    assert.match(draft.body.item.message, /回复“确认”/u);
    assert.doesNotMatch(draft.body.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
    const draftAck = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
      body: JSON.stringify({ id: draft.body.item.id, leaseToken: draft.body.leaseToken, ok: true }),
    });
    assert.equal(draftAck.response.status, 200);

    const session = await login();
    const rejected = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}/reject`, {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ reason: "网页人工拒绝" }),
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.item.status, "rejected");

    const staleConfirmation = await request("/api/integrations/weixin-agent/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "Idempotency-Key": "weixin:web-reject-old-code",
      },
      body: JSON.stringify({
        conversationId: "web-reject-old-code",
        text: "确认",
        sourceMessageId: "web-reject-old-code",
        senderId: sender,
        chatType: "direct",
      }),
    });
    assert.notEqual(staleConfirmation.body?.status, "ok");

    const cancellation = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(cancellation.response.status, 200);
    assert.match(cancellation.body.item.message, /已取消快捷记账/u);
    assert.doesNotMatch(cancellation.body.item.message, /(?:^|\n)\d{6}(?:\n|$)/u);

    const replay = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}/reject`, {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ reason: "网页人工拒绝" }),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.status, "rejected");

    const next = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}` },
      body: JSON.stringify({
        text: "2026-08-17 早餐 18 元",
        selection_path: "出差报销 · 支出 · 餐饮 · 早餐",
        note: "拒绝后的下一笔",
        idempotency_key: "shortcut-after-web-reject",
        source: "shortcut",
      }),
    });
    assert.equal(next.response.status, 202);
    assert.notEqual(next.body.error?.code, "ASSISTANT_ACTION_PENDING");

    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);
    assert.equal(db.prepare("SELECT status FROM assistant_pending_actions ORDER BY created_at, id LIMIT 1").get().status, "cancelled");
    db.close();
  });

  it("reconciles an accepted receipt after Web settlement is interrupted post-write", async () => {
    const created = await request("/api/integrations/shortcut/bookkeeping", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}` },
      body: JSON.stringify({
        text: "2026-08-16 午餐 28 元",
        selection_path: "出差报销 · 支出 · 餐饮 · 午餐",
        note: "网页结算恢复测试",
        idempotency_key: "shortcut-web-settlement-recovery",
        source: "shortcut",
      }),
    });
    assert.equal(created.response.status, 202);
    const session = await login();
    const faultDb = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    faultDb.exec(`
      CREATE TRIGGER fail_web_review_settlement
      BEFORE UPDATE ON assistant_pending_actions
      WHEN NEW.status = 'executed' AND OLD.status <> 'executed'
      BEGIN
        SELECT RAISE(ABORT, 'forced web review settlement failure');
      END;
    `);
    faultDb.close();

    const interrupted = await request(`/api/integrations/shortcut/bookkeeping/review/${created.body.item.id}/confirm`, {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({
        analysis: {
          status: "ready",
          confidence: 1,
          expense: {
            occurredOn: "2026-08-16",
            amountCents: 2800,
            reimbursementCents: 2800,
            purpose: "客户拜访午餐",
            merchant: "示例餐厅",
          },
          warnings: [],
          source: { provider: "manual", model: null },
        },
      }),
    });
    assert.ok(interrupted.response.status >= 400);

    const beforeRecovery = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    assert.equal(beforeRecovery.prepare("SELECT status FROM shortcut_bookkeeping_entries WHERE id = ?").get(created.body.item.id).status, "accepted");
    assert.equal(beforeRecovery.prepare("SELECT status FROM assistant_pending_actions").get().status, "pending");
    assert.equal(beforeRecovery.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(beforeRecovery.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
    assert.equal(beforeRecovery.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox WHERE json_extract(payload_json, '$.kind') = 'accepted'").get().count, 0);
    beforeRecovery.exec("DROP TRIGGER fail_web_review_settlement");
    beforeRecovery.close();

    const receipt = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: workerHeaders(),
    });
    assert.equal(receipt.response.status, 200);
    assert.match(receipt.body.item.message, /已确认并录入森特智行/u);
    assert.doesNotMatch(receipt.body.item.message, /(?:^|\n)\d{6}(?:\n|$)/u);

    const recovered = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    assert.equal(recovered.prepare("SELECT status FROM assistant_pending_actions").get().status, "executed");
    assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
    assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
    assert.equal(recovered.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox WHERE json_extract(payload_json, '$.kind') = 'accepted'").get().count, 1);
    recovered.close();
  });

  it("requires a cookie session and CSRF for management writes", async () => {
    assert.equal((await request("/api/integrations/shortcut/tokens")).response.status, 401);
    const session = await login();
    const missingCsrf = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie },
      body: JSON.stringify({ label: "iPhone" }),
    });
    assert.equal(missingCsrf.response.status, 403);
    assert.equal(missingCsrf.body.error.code, "CSRF_INVALID");

    const invalidLabel = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ label: 123 }),
    });
    assert.equal(invalidLabel.response.status, 422);
    assert.equal(invalidLabel.body.error.fields.label, "string");
  });

  it("creates, lists, revokes, and uses a database token mapped to the logged-in account", async () => {
    const session = await login();
    const created = await request("/api/integrations/shortcut/tokens", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ label: "iPhone 截图记账" }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.account, account);
    assert.match(created.body.item.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(created.body.item.label, "iPhone 截图记账");

    const verified = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${created.body.item.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "ok");
    assert.equal(verified.body.tokenValid, true);
    assert.equal(verified.body.bookkeepingReady, true);
    assert.equal(verified.body.weixinConfirmationReady, true);
    assert.deepEqual(verified.body.confirmationDelivery, { status: "ready" });

    const listed = await request("/api/integrations/shortcut/tokens", {
      headers: { Cookie: session.cookie },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal("token" in listed.body.items[0], false);
    assert.equal(listed.body.items[0].lastUsedAt !== null, true);

    const revoked = await request(`/api/integrations/shortcut/tokens/${created.body.item.id}`, {
      method: "DELETE",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
    });
    assert.equal(revoked.response.status, 200);
    assert.ok(revoked.body.item.revokedAt);

    const rejected = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${created.body.item.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.tokenValid, false);
    assert.equal(rejected.body.error.code, "SHORTCUT_TOKEN_INVALID");
  });

  it("keeps the legacy env token fallback working", async () => {
    const response = await request("/api/integrations/shortcut/verify", {
      headers: {
        Authorization: `Bearer ${legacyToken}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.body.tokenValid, true);
    assert.equal(response.body.bookkeepingReady, true);
    assert.equal(response.body.weixinConfirmationReady, true);
    assert.deepEqual(response.body.confirmationDelivery, { status: "ready" });
  });
});
