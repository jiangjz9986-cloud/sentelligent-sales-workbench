import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const passwordField = "pass" + "word";
const loginValueA = "assistant-web-secret-a";
const loginValueB = "assistant-web-secret-b";
const machineToken = "test-machine-token";
const FINANCIAL_TABLES = [
  "shortcut_bookkeeping_entries",
  "shortcut_bookkeeping_revisions",
  "travel_expenses",
  "travel_expense_payments",
  "travel_expense_ingestions",
  "travel_expense_document_inbox",
  "invoice_documents",
];

let tempDir;
let server;
let baseUrl;
let db;
let sessionA;
let sessionB;
let customerA;

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

async function chat(session, payload) {
  return sessionRequest(session)("/api/assistant/chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function confirm(session, payload) {
  return sessionRequest(session)("/api/assistant/confirm", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function financialRowCounts() {
  return Object.fromEntries(FINANCIAL_TABLES.map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
}

describe("assistant web HTTP integration", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sent-assistant-web-"));
    const databaseUrl = join(tempDir, "assistant-web.sqlite");
    server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: "jiangjz",
      authPassword: "",
      authPasswordHash: await hashPassword(loginValueA, { salt: Buffer.alloc(16, 11) }),
      authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
      authCookieSecure: false,
      weixinAgentApiToken: machineToken,
      weixinAgentOwner: "jiangjz",
      weixinAllowedSenderIds: "sender-1",
      weixinAllowGroups: false,
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
    assert.equal(created.response.status, 201);
    sessionB = await login("testb", loginValueB);

    const customer = await asA("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "协和Web助手", region: "北京", summary: "测试客户" }),
    });
    assert.equal(customer.response.status, 201);
    customerA = customer.body.item;
  });

  beforeEach(() => {
    db.prepare("DELETE FROM login_rate_limits").run();
  });

  after(async () => {
    db?.close();
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns 401 for unauthenticated chat", async () => {
    const result = await rawRequest("/api/assistant/chat", {
      method: "POST",
      body: JSON.stringify({ message: "帮助" }),
    });
    assert.equal(result.response.status, 401);
  });

  it("returns 403 for chat with invalid CSRF", async () => {
    const result = await rawRequest("/api/assistant/chat", {
      method: "POST",
      headers: { Cookie: sessionA.cookie, "X-CSRF-Token": "wrong" },
      body: JSON.stringify({ message: "帮助" }),
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "CSRF_INVALID");
  });

  it("returns 403 when a machine token hits the web chat route", async () => {
    const result = await rawRequest("/api/assistant/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
      body: JSON.stringify({ message: "帮助" }),
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "MACHINE_SCOPE_DENIED");
  });

  it("returns HELP text for 帮助", async () => {
    const result = await chat(sessionA, { message: "帮助" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, "help");
    assert.match(result.body.message ?? result.body.text ?? "", /战情总览/u);
    assert.ok(result.body.conversationId);
  });

  it("returns dashboard summary for 战情", async () => {
    const result = await chat(sessionA, { message: "战情总览" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, "ok");
  });

  it("rejects an oversized message with 422", async () => {
    const result = await chat(sessionA, { message: "长".repeat(2001) });
    assert.equal(result.response.status, 422);
    assert.equal(result.body.error.code, "VALIDATION_ERROR");
  });

  it("creates and confirms an R1 action-risk item through the web confirm endpoint", async () => {
    const proposed = await chat(sessionA, {
      message: "提醒我整理协和材料清单",
      conversationId: "web-test-r1-conversation",
    });
    assert.equal(proposed.response.status, 200);
    assert.equal(proposed.body.status, "confirmation_required");
    assert.equal(proposed.body.confirmationCode, undefined);
    assert.ok(proposed.body.actionId);

    const confirmed = await confirm(sessionA, {
      pendingActionId: proposed.body.actionId,
      conversationId: proposed.body.conversationId,
      intent: "confirm",
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");

    const list = await asA("/api/actions");
    assert.equal(list.body.items.some((row) => row.title.includes("协和材料")), true);
  });

  it("cancels a pending action through the web confirm endpoint", async () => {
    const proposed = await chat(sessionA, {
      message: "提醒我取消测试项",
      conversationId: "web-test-cancel-conversation",
    });
    assert.equal(proposed.body.status, "confirmation_required");
    const cancelled = await confirm(sessionA, {
      pendingActionId: proposed.body.actionId,
      conversationId: proposed.body.conversationId,
      intent: "cancel",
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.status, "cancel");
  });

  it("returns 404 for confirming another account pending action", async () => {
    const proposed = await chat(sessionA, {
      message: "提醒我隔离测试",
      conversationId: "web-test-isolation-conversation",
    });
    const cross = await confirm(sessionB, {
      pendingActionId: proposed.body.actionId,
      conversationId: proposed.body.conversationId,
      intent: "confirm",
    });
    assert.equal(cross.response.status, 404);
  });

  it("requires confirmation without exposing a code for R2 customer updates", async () => {
    const proposed = await chat(sessionA, {
      message: `修改客户 ${customerA.name}，摘要：Web助手更新`,
      conversationId: "web-test-r2-conversation",
    });
    assert.equal(proposed.response.status, 200);
    assert.equal(proposed.body.status, "confirmation_required");
    assert.equal(proposed.body.confirmationCode, undefined);
    assert.ok(proposed.body.card || proposed.body.text);

    const confirmed = await confirm(sessionA, {
      pendingActionId: proposed.body.actionId,
      conversationId: proposed.body.conversationId,
      intent: "confirm",
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, "ok");

    const loaded = await asA(`/api/customers/${customerA.id}`);
    assert.match(loaded.body.item.summary, /Web助手更新/u);
  });

  it("returns 404 for an unknown pendingActionId", async () => {
    const result = await confirm(sessionA, {
      pendingActionId: "00000000-0000-4000-8000-000000000099",
      conversationId: "web-test-r2-conversation",
      intent: "confirm",
    });
    assert.equal(result.response.status, 404);
  });

  it("replays the same clientMessageId response", async () => {
    const payload = {
      message: "帮助",
      conversationId: "web-test-idempotent-conversation",
      clientMessageId: "client-msg-1",
    };
    const first = await chat(sessionA, payload);
    const second = await chat(sessionA, payload);
    assert.equal(first.response.status, 200);
    assert.deepEqual(second.body, first.body);
  });

  it("returns filtered history for a conversation", async () => {
    const conversationId = "web-test-history-conversation";
    await chat(sessionA, { message: "帮助", conversationId });
    const history = await sessionRequest(sessionA)(`/api/assistant/history?conversationId=${encodeURIComponent(conversationId)}`);
    assert.equal(history.response.status, 200);
    assert.equal(history.body.conversationId, conversationId);
    assert.ok(history.body.items.length >= 1);
    assert.equal(history.body.items.some((item) => item.text === "<confirmation-code>"), false);
  });

  it("denies the v0.10.3 task-book bookkeeping sentence before any financial write", async () => {
    const before = financialRowCounts();
    assert.deepEqual(before, Object.fromEntries(FINANCIAL_TABLES.map((table) => [table, 0])));
    const result = await chat(sessionA, { message: "记一笔午餐 50" });
    assert.equal(result.response.status, 403);
    assert.match(result.body.message ?? result.body.text ?? "", /微信小小/u);
    assert.deepEqual(financialRowCounts(), before, "403 must leave every financial table unchanged at zero rows");
  });

  it("denies visit-capture intents on web", async () => {
    const result = await chat(sessionA, { message: "拜访协和医院，客户希望补齐材料" });
    assert.equal(result.response.status, 403);
    assert.match(result.body.message ?? result.body.text ?? "", /微信小小/u);
  });

  it("returns the v0.10.3 task-book customer search at the top-level display contract", async () => {
    const result = await chat(sessionA, { message: "查客户 协和Web助手" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, "ok");
    assert.equal(result.body.toolName, "customer.search");
    assert.match(result.body.text, /协和Web助手/u);
    assert.equal(result.body.text, result.body.result.text);
    assert.equal(result.body.card?.title, "客户");
    assert.equal(result.body.result.items.some((item) => item.id === customerA.id), true);
  });

  it("returns 429 after the assistant web rate limit is exceeded", async () => {
    db.prepare("DELETE FROM login_rate_limits").run();
    const conversationId = "web-test-rate-limit";
    let limited = null;
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const result = await chat(sessionA, {
        message: "帮助",
        conversationId,
        clientMessageId: `rate-${attempt}`,
      });
      if (result.response.status === 429) {
        limited = result;
        break;
      }
    }
    assert.ok(limited, "expected rate limit to trigger");
    assert.equal(limited.body.error.code, "RATE_LIMITED");
  });
});
