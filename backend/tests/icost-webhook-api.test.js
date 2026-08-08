import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";

const account = "travel-owner";
const loginPassword = "fixture-password-for-tests";
const passwordHash = await hashPassword(loginPassword, { salt: Buffer.alloc(16, 47) });
const sessionSecret = Buffer.alloc(32, 53).toString("base64url");

let tempDir;
let server;
let baseUrl;

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function readyAnalysis(overrides = {}) {
  return {
    status: "ready",
    confidence: 0.98,
    expense: {
      occurredOn: "2026-08-04",
      category: "lunch",
      purpose: "客户招待午餐",
      merchant: "示例餐厅",
      amountCents: 12850,
      reimbursementCents: 12850,
      paidAt: "2026-08-04T12:30:00+08:00",
      fundingSource: "personal",
      paymentMethod: "alipay",
    },
    warnings: [],
    source: { provider: "deepseek", model: "deepseek-chat" },
    ...overrides,
  };
}

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startHarness(overrides = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-icost-api-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: sessionSecret,
    authCookieSecure: false,
    corsAllowedOrigins: [],
    aiAnalysisMode: "model",
    modelApiKey: "test-model-key",
    modelProvider: "deepseek",
    modelName: "deepseek-chat",
    icostWebhookToken: "qa-icost-webhook-token",
    icostWebhookOwner: account,
    icostWebhookRateLimit: 30,
    icostWebhookWindowMs: 60_000,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { databaseUrl };
}

async function requestIcost(body, {
  token = "qa-icost-webhook-token",
  idempotencyKey = "expense-20260804-1",
  method = "POST",
  path = "/api/integrations/icost/expenses",
} = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined
    ? undefined
    : {
      ledger_name: "出差报销",
      ...(idempotencyKey === null ? {} : { idempotency_key: idempotencyKey }),
      source: "icost-shortcut",
      ...body,
    };
  return read(await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
}

async function authenticatedGet(path) {
  const login = await read(await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password: loginPassword }),
  }));
  assert.equal(login.response.status, 200);
  return read(await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookiePair(login.response) },
  }));
}

async function authenticatedExpenseList(weekStart = "2026-08-03") {
  return authenticatedGet(`/api/travel-expenses?weekStart=${weekStart}`);
}

beforeEach(async () => {
  tempDir = null;
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("iCost write-only expense webhook API", () => {
  it("accepts only the dedicated token on the single POST route", async () => {
    await startHarness({ travelExpenseAnalyzer: async () => readyAnalysis() });

    assert.equal((await requestIcost({ text: "2026-08-04 午餐 128.50元" }, { token: "wrong" })).response.status, 401);
    assert.equal((await requestIcost({ text: "2026-08-04 午餐 128.50元" }, { token: "wx-machine-token" })).response.status, 401);
    assert.equal((await requestIcost(undefined, { method: "GET" })).response.status, 405);
    assert.equal((await requestIcost({}, { method: "DELETE" })).response.status, 405);
  });

  it("requires one valid JSON idempotency key and a strict text-only payload", async () => {
    await startHarness({ travelExpenseAnalyzer: async () => readyAnalysis() });

    const missingKey = await requestIcost({ text: "2026-08-04 午餐 128.50元" }, { idempotencyKey: null });
    assert.equal(missingKey.response.status, 422);
    assert.equal(missingKey.body.error.fields.idempotency_key, "format");

    const unknownField = await requestIcost({ text: "2026-08-04 午餐 128.50元", owner: "forged" });
    assert.equal(unknownField.response.status, 422);
    assert.equal(unknownField.body.error.fields.owner, "unknown");
  });

  it("rejects every ledger except the exact Sentelligent ledger before analysis or persistence", async () => {
    let analyzerCalls = 0;
    await startHarness({
      travelExpenseAnalyzer: async () => {
        analyzerCalls += 1;
        return readyAnalysis();
      },
    });

    const rejected = await requestIcost({
      text: "2026-08-04 午餐 128.50元",
      ledger_name: "biubiu",
    }, { idempotencyKey: "wrong-ledger" });
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.body.error.fields.ledger_name, "notAllowed");
    assert.equal(analyzerCalls, 0);
    assert.deepEqual((await authenticatedExpenseList()).body.items, []);
  });

  it("persists a ready analysis as one expense and one payment for the configured owner", async () => {
    let analyzerCalls = 0;
    await startHarness({
      travelExpenseAnalyzer: async (text) => {
        analyzerCalls += 1;
        assert.equal(text, "2026-08-04 午餐 客户招待 支付宝 128.50元");
        return readyAnalysis();
      },
    });

    const created = await requestIcost({
      text: "2026-08-04 午餐 客户招待 支付宝 128.50元",
      captured_at: "2026-08-04T12:31:00+08:00",
      source_id: "icost-entry-001",
    });

    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.status, "accepted");
    assert.equal(created.body.item.replayed, false);
    assert.match(created.body.item.expenseReferenceCode, /^EXP-20260804-[A-F0-9]{8}$/);
    assert.equal(analyzerCalls, 1);

    const listed = await authenticatedExpenseList();
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, created.body.item.expenseId);
    assert.equal(listed.body.items[0].owner, account);
    assert.equal(listed.body.items[0].actualPaidCents, 12850);
    assert.equal(listed.body.items[0].payments.length, 1);
    assert.equal(listed.body.items[0].payments[0].id, created.body.item.paymentId);

    const audits = await authenticatedGet("/api/audit-logs?entityType=travel_expense_ingestion");
    assert.deepEqual(
      audits.body.items.map((item) => item.action).sort(),
      ["travel_expense.ingestion.accept", "travel_expense.ingestion.receive"],
      "the configured owner must retain visibility into integration-owned audit events",
    );
  });

  it("replays the same key without analyzing or creating a duplicate and rejects changed content", async () => {
    let analyzerCalls = 0;
    await startHarness({
      travelExpenseAnalyzer: async () => {
        analyzerCalls += 1;
        return readyAnalysis();
      },
    });
    const body = { text: "2026-08-04 午餐 客户招待 支付宝 128.50元" };

    const first = await requestIcost(body, { idempotencyKey: "same-key" });
    const replay = await requestIcost(body, { idempotencyKey: "same-key" });
    const conflict = await requestIcost({ text: "2026-08-04 午餐 99元" }, { idempotencyKey: "same-key" });

    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    assert.equal(replay.body.item.id, first.body.item.id);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(analyzerCalls, 1);
    assert.equal((await authenticatedExpenseList()).body.items.length, 1);
  });

  it("keeps model failures and low-confidence output in review without creating a financial record", async () => {
    await startHarness({
      travelExpenseAnalyzer: async () => ({
        status: "review_required",
        confidence: 0.32,
        expense: null,
        warnings: ["model_timeout"],
        source: { provider: "deepseek", model: "deepseek-chat" },
      }),
    });

    const queued = await requestIcost({ text: "昨天午饭好像四十多" });

    assert.equal(queued.response.status, 202);
    assert.equal(queued.body.item.status, "review_required");
    assert.deepEqual(queued.body.item.warnings, ["model_timeout"]);
    assert.equal(queued.body.item.expenseId, null);
    assert.deepEqual((await authenticatedExpenseList()).body.items, []);
  });

  it("allows only one concurrent analyzer for the same idempotency key", async () => {
    let analyzerCalls = 0;
    let markEntered;
    let releaseFirst;
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    await startHarness({
      travelExpenseAnalyzer: async () => {
        analyzerCalls += 1;
        if (analyzerCalls === 1) {
          markEntered();
          await release;
        }
        return readyAnalysis();
      },
    });
    const body = { text: "2026-08-04 午餐 客户招待 支付宝 128.50元" };

    const firstPromise = requestIcost(body, { idempotencyKey: "concurrent-key" });
    await entered;
    const concurrent = await requestIcost(body, { idempotencyKey: "concurrent-key" });
    releaseFirst();

    assert.equal(concurrent.response.status, 409);
    assert.equal(concurrent.body.error.code, "REQUEST_IN_PROGRESS");

    const first = await firstPromise;
    assert.equal(first.response.status, 201);
    const replay = await requestIcost(body, { idempotencyKey: "concurrent-key" });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.item.replayed, true);
    assert.equal(analyzerCalls, 1);
    assert.equal((await authenticatedExpenseList()).body.items.length, 1);
  });

  it("enforces the dedicated fixed-window write limit", async () => {
    await startHarness({
      icostWebhookRateLimit: 1,
      travelExpenseAnalyzer: async () => readyAnalysis(),
    });

    assert.equal((await requestIcost({ text: "2026-08-04 午餐 10元" }, { idempotencyKey: "rate-1" })).response.status, 201);
    const limited = await requestIcost({ text: "2026-08-04 晚餐 20元" }, { idempotencyKey: "rate-2" });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.match(limited.response.headers.get("retry-after") ?? "", /^\d+$/);
  });
});
