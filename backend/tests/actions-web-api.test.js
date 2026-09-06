import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

// v0.10.0 待办 Web 写路径：POST /api/actions（Web 首个创建入口，owner 服务端
// 注入）+ PATCH /api/actions/:id 支持 remindAt（归一 ISO + reminded_at 重新武装
// 语义）。隔离契约沿用 v0.9.2：跨账号读写一律 404 / 挂接校验 422，owner 不入
// 请求体。

const passwordField = "pass" + "word";
const loginValueA = "actions-web-secret-a";
const loginValueB = "actions-web-secret-b";
const allowedOrigin = "https://sales.example.test";

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

async function createActionAsA(payload) {
  const created = await asA("/api/actions", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(created.response.status, 201, `create action ${JSON.stringify(payload)}`);
  return created.body.item;
}

describe("actions web API (v0.10.0)", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sent-actions-web-"));
    const databaseUrl = join(tempDir, "actions-web.sqlite");
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
      corsAllowedOrigins: [allowedOrigin],
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

    const customer = await asA("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "A客户-待办Web", region: "青岛", summary: "灾备评估" }),
    });
    assert.equal(customer.response.status, 201, "A create customer");
    customerA = customer.body.item;
  });

  after(async () => {
    db?.close();
    await new Promise((resolve) => server?.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates an action with the minimum title-only payload and injects the session owner", async () => {
    const item = await createActionAsA({ title: "整理灾备方案对比表" });
    assert.equal(item.title, "整理灾备方案对比表");
    assert.equal(item.status, "pending");
    assert.equal(item.priority, "中");
    assert.equal(item.assignee, "jiangjz");
    assert.equal(item.owner, "jiangjz");
    assert.equal(item.remindAt, null);
    assert.equal(item.version, 1);

    const list = await asA("/api/actions");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.items.some((row) => row.id === item.id), true, "creator sees the new action");

    const listB = await asB("/api/actions");
    assert.equal(listB.body.items.some((row) => row.id === item.id), false, "peer account must not see it");
  });

  it("rejects a request-body owner and enforces title validation", async () => {
    const withOwner = await asA("/api/actions", {
      method: "POST",
      body: JSON.stringify({ title: "越权注入", owner: "testb" }),
    });
    assert.equal(withOwner.response.status, 422, "owner in body is an unknown field");
    assert.equal(withOwner.body.error.fields.owner, "unknown");

    const missingTitle = await asA("/api/actions", { method: "POST", body: JSON.stringify({ due: "周五" }) });
    assert.equal(missingTitle.response.status, 422);
    assert.equal(missingTitle.body.error.fields.title, "required");

    const longTitle = await asA("/api/actions", {
      method: "POST",
      body: JSON.stringify({ title: "长".repeat(81) }),
    });
    assert.equal(longTitle.response.status, 422);
    assert.equal(longTitle.body.error.fields.title, "max");
  });

  it("normalizes remindAt to ISO on create and rejects invalid instants", async () => {
    const item = await createActionAsA({
      title: "带提醒的待办",
      remindAt: "2026-09-01T10:30",
      priority: "高",
      customerId: customerA.id,
    });
    assert.equal(item.remindAt, new Date("2026-09-01T10:30").toISOString());
    assert.equal(item.customer, "A客户-待办Web", "customer display name resolved from owner-scoped lookup");
    assert.equal(item.customerId, customerA.id);
    assert.equal(item.tone, "red", "high priority maps to the red tone");

    const invalid = await asA("/api/actions", {
      method: "POST",
      body: JSON.stringify({ title: "非法提醒", remindAt: "not-a-time" }),
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.fields.remindAt, "dateTime");
  });

  it("treats a cross-account customerId as a validation failure instead of leaking existence", async () => {
    const crossCustomer = await asB("/api/actions", {
      method: "POST",
      body: JSON.stringify({ title: "跨账号挂接", customerId: customerA.id }),
    });
    assert.equal(crossCustomer.response.status, 422);
    assert.equal(crossCustomer.body.error.fields.customerId, "invalid");

    const ghostCustomer = await asB("/api/actions", {
      method: "POST",
      body: JSON.stringify({ title: "幽灵客户", customerId: "no-such-customer" }),
    });
    assert.equal(ghostCustomer.response.status, 422);
    assert.equal(ghostCustomer.body.error.fields.customerId, "invalid");
  });

  it("writes an action.create audit row with the web source marker", async () => {
    const item = await createActionAsA({ title: "审计追溯待办", remindAt: "2026-09-02T09:00:00.000Z" });
    const audit = db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'action.create' AND entity_id = $id",
    ).get({ $id: item.id });
    assert.ok(audit, "audit row exists");
    assert.equal(audit.actor, "jiangjz");
    const metadata = JSON.parse(audit.metadata_json ?? audit.metadata ?? "{}");
    assert.equal(metadata.source, "web");
    assert.equal(metadata.remindAt, "2026-09-02T09:00:00.000Z");
    assert.equal(metadata.priority, "中");
  });

  it("patches remindAt with ISO normalization and re-arms the reminder marker on change", async () => {
    const item = await createActionAsA({ title: "提醒重武装", remindAt: "2026-09-03T08:00:00.000Z" });
    // 模拟提醒已投递：reminded_at 非空。
    db.prepare("UPDATE action_items SET reminded_at = $at WHERE id = $id")
      .run({ $at: "2026-09-03T08:00:05.000Z", $id: item.id });

    const patched = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version),
      body: JSON.stringify({ remindAt: "2026-09-04T10:00" }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.item.remindAt, new Date("2026-09-04T10:00").toISOString());
    assert.equal(patched.body.item.remindedAt, null, "changing remindAt re-arms the reminder");

    const row = db.prepare("SELECT remind_at, reminded_at FROM action_items WHERE id = $id").get({ $id: item.id });
    assert.equal(row.remind_at, new Date("2026-09-04T10:00").toISOString());
    assert.equal(row.reminded_at, null);
  });

  it("keeps reminded_at untouched when a patch does not carry remindAt or repeats the same value", async () => {
    const item = await createActionAsA({ title: "提醒保持", remindAt: "2026-09-05T08:00:00.000Z" });
    db.prepare("UPDATE action_items SET reminded_at = $at WHERE id = $id")
      .run({ $at: "2026-09-05T08:00:03.000Z", $id: item.id });

    const withoutRemind = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version),
      body: JSON.stringify({ status: "in_progress", tone: "blue" }),
    });
    assert.equal(withoutRemind.response.status, 200);
    assert.equal(withoutRemind.body.item.remindAt, "2026-09-05T08:00:00.000Z");
    assert.equal(withoutRemind.body.item.remindedAt, "2026-09-05T08:00:03.000Z", "untouched without remindAt");

    const sameValue = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(withoutRemind.body.item.version),
      body: JSON.stringify({ remindAt: "2026-09-05T08:00:00.000Z" }),
    });
    assert.equal(sameValue.response.status, 200);
    assert.equal(sameValue.body.item.remindedAt, "2026-09-05T08:00:03.000Z", "same value does not re-arm");
  });

  it("clears remindAt with null or empty string and resets the reminder marker", async () => {
    const item = await createActionAsA({ title: "清除提醒", remindAt: "2026-09-06T08:00:00.000Z" });
    db.prepare("UPDATE action_items SET reminded_at = $at WHERE id = $id")
      .run({ $at: "2026-09-06T08:00:02.000Z", $id: item.id });

    const cleared = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version),
      body: JSON.stringify({ remindAt: null }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.item.remindAt, null);
    assert.equal(cleared.body.item.remindedAt, null);

    const emptyString = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(cleared.body.item.version),
      body: JSON.stringify({ remindAt: "" }),
    });
    assert.equal(emptyString.response.status, 200);
    assert.equal(emptyString.body.item.remindAt, null, "empty string clears like null");
  });

  it("rejects an invalid remindAt on patch without touching the row", async () => {
    const item = await createActionAsA({ title: "非法补丁", remindAt: "2026-09-07T08:00:00.000Z" });
    const invalid = await asA(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version),
      body: JSON.stringify({ remindAt: "下周三上午" }),
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.fields.remindAt, "dateTime");
    const row = db.prepare("SELECT remind_at, version FROM action_items WHERE id = $id").get({ $id: item.id });
    assert.equal(row.remind_at, "2026-09-07T08:00:00.000Z");
    assert.equal(row.version, item.version, "failed validation must not bump the version");
  });

  it("returns cross-account 404 for remindAt patches without leaking the current version", async () => {
    const item = await createActionAsA({ title: "跨账号提醒", remindAt: "2026-09-08T08:00:00.000Z" });
    const cross = await asB(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version),
      body: JSON.stringify({ remindAt: "2026-09-09T08:00:00.000Z" }),
    });
    assert.equal(cross.response.status, 404);
    assert.equal(JSON.stringify(cross.body).includes("currentVersion"), false);

    const wrongVersion = await asB(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: versionHeader(item.version + 5),
      body: JSON.stringify({ remindAt: "2026-09-09T08:00:00.000Z" }),
    });
    assert.equal(wrongVersion.response.status, 404, "right and wrong versions are indistinguishable");
  });

  it("keeps the new action visible to a due-reminder scan once remindAt elapses", async () => {
    const item = await createActionAsA({ title: "到点扫描", remindAt: "2026-09-10T00:00:00.000Z" });
    const due = db.prepare(`
      SELECT id FROM action_items
      WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL
        AND status IN ('pending', 'in_progress') AND remind_at <= $now AND owner = $owner
        AND id = $id
    `).get({ $now: "2026-09-10T00:00:01.000Z", $owner: "jiangjz", $id: item.id });
    assert.ok(due, "web-created action enters the reminder queue predicate");
  });
});
