import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

let tempDir;
let tempDirs;
let server;
let baseUrl;
const legacyToken = "test-token";
const machineToken = "test-machine-token";
const shortcutOwner = "shortcut-owner";
const bookkeepingSender = "shortcut-sender";

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function readyAnalysis(overrides = {}) {
  return {
    status: "ready",
    confidence: 0.99,
    expense: {
      occurredOn: "2026-08-17",
      amountCents: 1280,
      reimbursementCents: 1280,
      purpose: "打车",
      merchant: "示例商户",
      paidAt: "2026-08-17T12:00:00+08:00",
      fundingSource: "personal",
      paymentMethod: "alipay",
    },
    warnings: [],
    source: { provider: "test", model: null },
    ...overrides,
  };
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "test-worker",
    "X-Weixin-Delivery-Status": "ready",
    "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(shortcutOwner, bookkeepingSender),
  };
}

async function reportWorkerReady() {
  const response = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    headers: workerHeaders(),
  });
  assert.equal(response.status, 204);
}

async function confirmLatest(suffix) {
  const leased = await read(await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    headers: workerHeaders(),
  }));
  assert.equal(leased.response.status, 200);
  assert.match(leased.body.item.message, /回复“确认”/u);
  assert.doesNotMatch(leased.body.item.message, /六位|确认码|(?:^|\n)\d{6}(?:\n|$)/u);
  const ack = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
    method: "POST",
    headers: { Authorization: `Bearer ${machineToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: leased.body.item.id, leaseToken: leased.body.leaseToken, ok: true }),
  });
  assert.equal(ack.status, 200);
  const event = await read(await fetch(`${baseUrl}/api/integrations/weixin-agent/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `weixin:${suffix}`,
    },
    body: JSON.stringify({
      conversationId: `provider-${suffix}`,
      text: "确认",
      sourceMessageId: suffix,
      senderId: bookkeepingSender,
      chatType: "direct",
    }),
  }));
  assert.equal(event.response.status, 200);
  return event;
}

async function startHarness({ analyzer, serverOptions = {}, reportReady = true } = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-api-"));
  tempDirs.push(tempDir);
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    corsAllowedOrigins: [],
    shortcutWebhookToken: legacyToken,
    shortcutWebhookOwner: shortcutOwner,
    shortcutWebhookRateLimit: 30,
    shortcutWebhookWindowMs: 60_000,
    shortcutWeixinConfirmationEnabled: true,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: shortcutOwner,
    weixinBookkeepingOwner: shortcutOwner,
    weixinBookkeepingSenderId: bookkeepingSender,
    weixinAllowedSenderIds: [bookkeepingSender],
    travelExpenseAnalyzer: analyzer ?? (async () => readyAnalysis()),
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (reportReady) await reportWorkerReady();
}

async function verify({ method = "GET", tokenValue = legacyToken, explain = false } = {}) {
  const headers = {};
  if (tokenValue !== null) headers.Authorization = `Bearer ${tokenValue}`;
  if (explain) headers["X-Shortcut-Verification-Mode"] = "explain";
  return read(await fetch(`${baseUrl}/api/integrations/shortcut/verify`, { method, headers }));
}

async function request(body, { method = "POST", tokenValue = legacyToken } = {}) {
  const headers = {};
  if (tokenValue !== null) headers.Authorization = `Bearer ${tokenValue}`;
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  return read(await fetch(`${baseUrl}/api/integrations/shortcut/bookkeeping`, {
    method,
    headers,
    ...(body === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(body) }),
  }));
}

function expenseBody(overrides = {}) {
  return {
    text: "2026-08-17 打车 12.80元",
    selection_path: "出差报销 · 支出 · 交通 · 打车",
    note: "客户拜访",
    idempotency_key: "shortcut-expense-1",
    source: "shortcut",
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = null;
  tempDirs = [];
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("自有快捷指令记账 API", () => {
  it("returns the exact public catalog without exposing credentials", async () => {
    await startHarness();

    const catalog = await read(await fetch(`${baseUrl}/api/integrations/shortcut/catalog`));
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(catalog.body.ledgers.map((item) => item.name), ["出差报销"]);
    assert.deepEqual(
      catalog.body.ledgers[0].entryTypes.expense.find((item) => item.category === "交通").subcategories,
      ["火车", "路桥费", "打车", "代驾", "停车"],
    );
    assert.deepEqual(
      catalog.body.ledgers[0].entryTypes.income.find((item) => item.category === "出差").subcategories,
      ["报销", "借款"],
    );
    assert.doesNotMatch(JSON.stringify(catalog.body), /token|credential|account/iu);
  });

  it("reports bookkeeping ready only after a valid Token, owner binding, and live WeChat delivery", async () => {
    await startHarness({
      reportReady: false,
      serverOptions: {
        shortcutWeixinConfirmationEnabled: true,
        weixinAgentApiToken: machineToken,
        weixinAgentOwner: shortcutOwner,
        weixinBookkeepingOwner: shortcutOwner,
        weixinBookkeepingSenderId: bookkeepingSender,
        weixinAllowedSenderIds: [bookkeepingSender],
      },
    });

    const valid = await verify({ explain: true });
    assert.equal(valid.response.status, 200);
    assert.deepEqual(valid.body, {
      status: "error",
      integration: "shortcut",
      tokenValid: true,
      bookkeepingReady: false,
      confirmationDelivery: {
        status: "not_ready",
        reason: "worker_unavailable",
      },
      protocolVersion: 1,
      error: {
        code: "SHORTCUT_BOOKKEEPING_NOT_READY",
        message: "Token 验证成功，但记账服务尚未完成配置",
      },
    });

    const missingScopeHeartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "X-Weixin-Worker-Id": "legacy-worker",
        "X-Weixin-Delivery-Status": "ready",
      },
    });
    assert.equal(missingScopeHeartbeat.status, 204);
    const missingScope = await verify({ explain: true });
    assert.equal(missingScope.body.bookkeepingReady, false);
    assert.equal(missingScope.body.confirmationDelivery.reason, "worker_scope_missing");

    const mismatchedScopeHeartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "X-Weixin-Worker-Id": "misbound-worker",
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId("other-owner", bookkeepingSender),
      },
    });
    assert.equal(mismatchedScopeHeartbeat.status, 204);
    const mismatchedScope = await verify({ explain: true });
    assert.equal(mismatchedScope.body.bookkeepingReady, false);
    assert.equal(mismatchedScope.body.confirmationDelivery.reason, "delivery_scope_mismatch");

    const heartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "X-Weixin-Worker-Id": "test-worker",
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(shortcutOwner, bookkeepingSender),
      },
    });
    assert.equal(heartbeat.status, 204);
    const ready = await verify({ explain: true });
    assert.deepEqual(ready.body, {
      status: "ok",
      integration: "shortcut",
      tokenValid: true,
      bookkeepingReady: true,
      weixinConfirmationReady: true,
      confirmationDelivery: { status: "ready" },
      protocolVersion: 1,
    });

    const missing = await verify({ tokenValue: null });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.error.code, "SHORTCUT_TOKEN_REQUIRED");

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startHarness({
      reportReady: false,
      serverOptions: { shortcutWeixinConfirmationEnabled: false },
    });
    const unavailable = await verify({ explain: true });
    assert.equal(unavailable.response.status, 200);
    assert.equal(unavailable.body.status, "error");
    assert.equal(unavailable.body.tokenValid, true);
    assert.equal(unavailable.body.bookkeepingReady, false);
    assert.equal(unavailable.body.error.code, "SHORTCUT_BOOKKEEPING_NOT_READY");
  });

  it("fails closed before persistence when WeChat confirmation is disabled or the worker is unavailable", async () => {
    const assertNoWrites = () => {
      const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
      try {
        for (const table of [
          "shortcut_bookkeeping_entries",
          "travel_expenses",
          "travel_expense_payments",
          "assistant_pending_actions",
          "weixin_confirmation_outbox",
        ]) {
          assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
        }
      } finally {
        db.close();
      }
    };

    await startHarness({ reportReady: false });
    const unavailable = await request(expenseBody());
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error.code, "SHORTCUT_WEIXIN_CONFIRMATION_NOT_READY");
    assertNoWrites();

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startHarness({
      reportReady: false,
      serverOptions: { shortcutWeixinConfirmationEnabled: false },
    });
    const disabled = await request(expenseBody());
    assert.equal(disabled.response.status, 503);
    assert.equal(disabled.body.error.code, "SHORTCUT_WEIXIN_CONFIRMATION_DISABLED");
    assertNoWrites();
  });

  it("creates a categorized travel expense and replays the same request idempotently", async () => {
    await startHarness();

    const first = await request(expenseBody());
    assert.equal(first.response.status, 202);
    assert.equal(first.body.item.status, "review_required");
    await confirmLatest("api-create-confirm");

    const replay = await request(expenseBody());
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.status, "accepted");
    assert.equal(replay.body.item.replayed, true);
    assert.equal(replay.body.item.targetSystem, "sentelligent");
    assert.equal(replay.body.item.category, "交通");
    assert.equal(replay.body.item.subcategory, "打车");
    assert.equal(replay.body.item.note, "客户拜访");
    assert.match(replay.body.item.expenseReferenceCode, /^EXP-20260817-[A-F0-9]{8}$/u);

    const conflict = await request(expenseBody({ text: "2026-08-17 打车 99元" }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("does not duplicate a local write when the client loses the first response and reruns", async () => {
    await startHarness();
    const body = expenseBody({ idempotency_key: "shortcut-local-response-lost" });
    const first = await request(body);
    assert.equal(first.response.status, 202);
    await confirmLatest("api-response-lost-confirm");
    const replay = await request(body);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 1);
    } finally {
      db.close();
    }
  });

  it("rejects invalid categories, methods, credentials, and excessive writes", async () => {
    await startHarness();

    const invalid = await request(expenseBody({
      selection_path: "biubiu · 支出 · 交通 · 打车",
    }));
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.fields.ledger_name, "notAllowed");
    const income = await request(expenseBody({
      selection_path: "出差报销 · 收入 · 出差 · 报销",
      idempotency_key: "shortcut-income-supported",
    }));
    assert.equal(income.response.status, 202);
    await confirmLatest("api-income-confirm");
    const acceptedIncome = await request(expenseBody({
      selection_path: "出差报销 · 收入 · 出差 · 报销",
      idempotency_key: "shortcut-income-supported",
    }));
    assert.equal(acceptedIncome.response.status, 200);
    assert.equal(acceptedIncome.body.item.status, "accepted");
    assert.equal(acceptedIncome.body.item.entryType, "income");
    assert.equal(acceptedIncome.body.item.expenseId, null);
    assert.equal(acceptedIncome.body.item.paymentId, null);
    assert.equal((await request(expenseBody(), { method: "GET" })).response.status, 405);
    assert.equal((await request(expenseBody(), { tokenValue: "wrong" })).response.status, 401);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startHarness({ serverOptions: { shortcutWebhookRateLimit: 1 } });
    assert.equal((await request(expenseBody())).response.status, 202);
    const limited = await request(expenseBody({ idempotency_key: "shortcut-expense-2" }));
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
  });
});
