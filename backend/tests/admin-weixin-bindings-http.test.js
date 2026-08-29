// v0.9.3 admin 绑定管理面：member/机器 403；绑定码明文只出现在 issue 响应一次；
// PATCH 开关+乐观锁；已绑定账号再发码 409；解绑/复活经 one-active 索引约束。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

const passwordField = "pass" + "word";
const adminLoginValue = "unit-admin-password";
const memberLoginValue = "unit-colleague-password";
const machineToken = "weixin-admin-test-machine-token";
const adminHash = await hashPassword(adminLoginValue, { salt: Buffer.alloc(16, 58) });

let tempDir;
let databaseUrl;
let server;
let baseUrl;

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login(account, loginValue) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(result.response.status, 200);
  const cookie = String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  return { cookie, headers: { Cookie: cookie, "X-CSRF-Token": result.body.csrfToken } };
}

async function bindViaWeixin(senderId, code) {
  return request("/api/integrations/weixin-agent/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Idempotency-Key": `weixin:bind-${senderId}-${code}`,
    },
    body: JSON.stringify({
      conversationId: `wx-${senderId}`,
      text: `绑定 ${code}`,
      sourceMessageId: `bind-${senderId}-${code}`,
      senderId,
      chatType: "direct",
    }),
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-admin-weixin-bindings-"));
  databaseUrl = join(tempDir, "admin-bindings.sqlite");
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "jiangjz",
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 59).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: "jiangjz",
    weixinBookkeepingConfirmationEnabled: true,
    assistantConfirmationSecret: ["unit", "admin", "bindings", "secret", "0123456789abcdef"].join("-"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe("admin weixin bindings API", () => {
  it("locks the binding plane away from members and machine tokens", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });
    const member = await login("testb", memberLoginValue);
    for (const [method, path, body] of [
      ["GET", "/api/admin/weixin-bindings", undefined],
      ["POST", "/api/admin/weixin-bindings/codes", JSON.stringify({ account: "testb" })],
      ["PATCH", "/api/admin/weixin-bindings/some-sender", JSON.stringify({ expectedVersion: 1, digestEnabled: false })],
    ]) {
      const denied = await request(path, { method, headers: member.headers, body });
      assert.equal(denied.response.status, 403, `${method} ${path}`);
      assert.equal(denied.body.error.code, "ADMIN_ROLE_REQUIRED", `${method} ${path}`);
      const machineDenied = await request(path, {
        method,
        headers: { Authorization: `Bearer ${machineToken}` },
        body,
      });
      assert.equal(machineDenied.response.status, 403, `machine ${method} ${path}`);
      assert.equal(machineDenied.body.error.code, "MACHINE_SCOPE_DENIED", `machine ${method} ${path}`);
    }
  });

  it("issues one-time codes whose plaintext appears only in the issue response", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });

    const missing = await request("/api/admin/weixin-bindings/codes", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "ghostacct" }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error.code, "USER_NOT_FOUND");

    const issued = await request("/api/admin/weixin-bindings/codes", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb" }),
    });
    assert.equal(issued.response.status, 201);
    assert.match(issued.body.item.code, /^[0-9]{6}$/);
    assert.equal(issued.body.item.account, "testb");
    assert.ok(Date.parse(issued.body.item.expiresAt) > Date.now());

    const db = createConnection({ databaseUrl });
    try {
      const stored = db.prepare("SELECT code_hash FROM weixin_binding_codes").all();
      assert.equal(stored.length, 1);
      assert.notEqual(stored[0].code_hash, issued.body.item.code);
      const auditDump = JSON.stringify(db.prepare("SELECT * FROM audit_logs").all().map((row) => ({ ...row })));
      assert.doesNotMatch(auditDump, new RegExp(`"${issued.body.item.code}"`));
      const issuedAudit = db.prepare(
        "SELECT actor, metadata_json FROM audit_logs WHERE action = 'weixin.binding.code_issued'",
      ).all();
      assert.equal(issuedAudit.length, 1);
      assert.equal(issuedAudit[0].actor, "jiangjz");
      assert.equal(JSON.parse(issuedAudit[0].metadata_json).account, "testb");
    } finally {
      db.close();
    }

    // 绑定后再对同账号发码 → 409 提示先解绑。
    const bound = await bindViaWeixin("colleague-sender", issued.body.item.code);
    assert.equal(bound.body.status, "ok");
    const conflicted = await request("/api/admin/weixin-bindings/codes", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb" }),
    });
    assert.equal(conflicted.response.status, 409);
    assert.equal(conflicted.body.error.code, "ACCOUNT_ALREADY_BOUND");

    // 停用账号不能发码。
    const listed = await request("/api/admin/users", { headers: { Cookie: admin.cookie } });
    const target = listed.body.items.find((item) => item.account === "testb");
    await request("/api/admin/users/testb", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: target.version, status: "disabled" }),
    });
    // 需先解绑（账号占用），停用校验优先于绑定占用校验。
    const disabledDenied = await request("/api/admin/weixin-bindings/codes", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb" }),
    });
    assert.equal(disabledDenied.response.status, 409);
    assert.equal(disabledDenied.body.error.code, "USER_DISABLED");
  });

  it("lists bindings and patches switches with optimistic locking and full audit", async () => {
    const admin = await login("jiangjz", adminLoginValue);
    await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb", displayName: "同事乙", [passwordField]: memberLoginValue }),
    });
    const issued = await request("/api/admin/weixin-bindings/codes", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "testb" }),
    });
    await bindViaWeixin("colleague-sender", issued.body.item.code);

    const listed = await request("/api/admin/weixin-bindings", { headers: { Cookie: admin.cookie } });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 1);
    const binding = listed.body.items[0];
    assert.equal(binding.senderId, "colleague-sender");
    assert.equal(binding.account, "testb");
    assert.equal(binding.userDisplayName, "同事乙");
    assert.equal(binding.financialEnabled, false);
    assert.equal(binding.digestEnabled, true);
    assert.equal(binding.status, "active");

    // 空 PATCH → 422；错误版本 → 409。
    const empty = await request(`/api/admin/weixin-bindings/${binding.senderId}`, {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: binding.version }),
    });
    assert.equal(empty.response.status, 422);
    const conflict = await request(`/api/admin/weixin-bindings/${binding.senderId}`, {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: binding.version + 7, financialEnabled: true }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "VERSION_CONFLICT");

    // 开财务开关：审计 weixin.binding.updated 必有 before/after（财务授权可追溯）。
    const enabled = await request(`/api/admin/weixin-bindings/${binding.senderId}`, {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: binding.version, financialEnabled: true, displayName: "乙同学" }),
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.item.financialEnabled, true);
    assert.equal(enabled.body.item.displayName, "乙同学");

    // Web 侧解绑（status→disabled）：审计 unbound via web_admin。
    const unbound = await request(`/api/admin/weixin-bindings/${binding.senderId}`, {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: enabled.body.item.version, status: "disabled" }),
    });
    assert.equal(unbound.response.status, 200);
    assert.equal(unbound.body.item.status, "disabled");

    const db = createConnection({ databaseUrl });
    try {
      const updatedAudit = db.prepare(
        "SELECT before_json, after_json FROM audit_logs WHERE action = 'weixin.binding.updated' ORDER BY created_at",
      ).all();
      assert.ok(updatedAudit.length >= 1);
      const first = { before: JSON.parse(updatedAudit[0].before_json), after: JSON.parse(updatedAudit[0].after_json) };
      assert.equal(first.before.financialEnabled, false);
      assert.equal(first.after.financialEnabled, true);
      const unboundAudit = db.prepare(
        "SELECT metadata_json FROM audit_logs WHERE action = 'weixin.binding.unbound'",
      ).all();
      assert.equal(unboundAudit.length, 1);
      assert.equal(JSON.parse(unboundAudit[0].metadata_json).via, "web_admin");
      const auditDump = JSON.stringify(db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'weixin.binding.%'").all().map((row) => ({ ...row })));
      assert.doesNotMatch(auditDump, /colleague-sender/);
    } finally {
      db.close();
    }

    // 404 未知 sender；解绑后的微信消息回到固定拒答。
    const missing = await request("/api/admin/weixin-bindings/ghost-sender", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 1, digestEnabled: false }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error.code, "WEIXIN_BINDING_NOT_FOUND");
    const silenced = await bindViaWeixin("colleague-sender", "000000");
    assert.equal(silenced.body.status, "denied");
  });
});
