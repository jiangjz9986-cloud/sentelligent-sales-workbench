import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

let tempDir;
let tempDirs;
let server;
let baseUrl;
const legacyToken = "test-token";

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

async function startHarness({ fetchImpl, analyzer, serverOptions = {} } = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-bookkeeping-api-"));
  tempDirs.push(tempDir);
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    corsAllowedOrigins: [],
    shortcutWebhookToken: legacyToken,
    shortcutWebhookOwner: "shortcut-owner",
    shortcutWebhookRateLimit: 30,
    shortcutWebhookWindowMs: 60_000,
    fetchImpl,
    travelExpenseAnalyzer: analyzer ?? (async () => readyAnalysis()),
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
    assert.doesNotMatch(JSON.stringify(catalog.body), /token|credential|account/iu);
  });

  it("reports bookkeeping ready only after a valid Token and local WeChat confirmation configuration", async () => {
    await startHarness({
      serverOptions: {
        shortcutWeixinConfirmationEnabled: true,
        weixinAgentOwner: "shortcut-owner",
        weixinBookkeepingOwner: "shortcut-owner",
        weixinBookkeepingSenderId: "sender-1",
        weixinAllowedSenderIds: "sender-1",
      },
    });

    const valid = await verify({ explain: true });
    assert.equal(valid.response.status, 200);
    assert.deepEqual(valid.body, {
      status: "ok",
      integration: "shortcut",
      tokenValid: true,
      bookkeepingReady: true,
      weixinConfirmationReady: true,
      protocolVersion: 1,
    });

    const missing = await verify({ tokenValue: null });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.error.code, "SHORTCUT_TOKEN_REQUIRED");

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startHarness();
    const unavailable = await verify({ explain: true });
    assert.equal(unavailable.response.status, 200);
    assert.equal(unavailable.body.status, "error");
    assert.equal(unavailable.body.tokenValid, true);
    assert.equal(unavailable.body.bookkeepingReady, false);
    assert.equal(unavailable.body.error.code, "SHORTCUT_BOOKKEEPING_NOT_READY");
  });

  it("creates a categorized travel expense and replays the same request idempotently", async () => {
    await startHarness();

    const first = await request(expenseBody());
    assert.equal(first.response.status, 201);
    assert.equal(first.body.item.status, "accepted");
    assert.equal(first.body.item.targetSystem, "sentelligent");
    assert.equal(first.body.item.category, "交通");
    assert.equal(first.body.item.subcategory, "打车");
    assert.equal(first.body.item.note, "客户拜访");
    assert.match(first.body.item.expenseReferenceCode, /^EXP-20260817-[A-F0-9]{8}$/u);

    const replay = await request(expenseBody());
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    assert.equal(replay.body.item.expenseId, first.body.item.expenseId);

    const conflict = await request(expenseBody({ text: "2026-08-17 打车 99元" }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("does not duplicate a local write when the client loses the first response and reruns", async () => {
    await startHarness();
    const body = expenseBody({ idempotency_key: "shortcut-local-response-lost" });
    const first = await request(body);
    assert.equal(first.response.status, 201);
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
      selection_path: "轻氧 · 支出 · 交通 · 打车",
    }));
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.fields.ledger_name, "notAllowed");
    const unsupportedIncome = await request(expenseBody({
      selection_path: "出差报销 · 收入 · 出差 · 报销",
      idempotency_key: "shortcut-income-not-supported",
    }));
    assert.equal(unsupportedIncome.response.status, 422);
    assert.equal((await request(expenseBody(), { method: "GET" })).response.status, 405);
    assert.equal((await request(expenseBody(), { tokenValue: "wrong" })).response.status, 401);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startHarness({ serverOptions: { shortcutWebhookRateLimit: 1 } });
    assert.equal((await request(expenseBody())).response.status, 201);
    const limited = await request(expenseBody({ idempotency_key: "shortcut-expense-2" }));
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
  });
});
