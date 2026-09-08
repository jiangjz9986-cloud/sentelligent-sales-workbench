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
const adminHash = await hashPassword(adminLoginValue, { salt: Buffer.alloc(16, 51) });

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

async function startServer(overrides = {}) {
  server = createServer({
    databaseUrl,
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: "jiangjz",
    authPassword: "",
    authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 52).toString("base64url"),
    authCookieSecure: false,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function login(account, loginValue) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(result.response.status, 200);
  return {
    body: result.body,
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    headers: {
      Cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
      "X-CSRF-Token": result.body.csrfToken,
    },
  };
}

async function createMember(adminAuth, account, displayName, loginValue, role = "member") {
  const created = await request("/api/admin/users", {
    method: "POST",
    headers: adminAuth.headers,
    body: JSON.stringify({ account, displayName, [passwordField]: loginValue, role }),
  });
  assert.equal(created.response.status, 201);
  return created.body.item;
}

function auditRows(action) {
  const db = createConnection({ databaseUrl });
  try {
    return db.prepare(
      "SELECT action, entity_type, entity_id, actor, after_json FROM audit_logs WHERE action = $action ORDER BY created_at",
    ).all({ $action: action }).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sent-zx-admin-users-"));
  databaseUrl = join(tempDir, "admin-users.sqlite");
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("admin user management API", () => {
  it("lists users for admins with camelCase fields and no hash material", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    await createMember(admin, "colleague", "同事", memberLoginValue);

    const listed = await request("/api/admin/users", { headers: { Cookie: admin.cookie } });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.items.map((item) => item.account), ["colleague", "jiangjz"]);
    const seedRow = listed.body.items.find((item) => item.account === "jiangjz");
    assert.equal(seedRow.displayName, "继振");
    assert.equal(seedRow.role, "admin");
    assert.equal(seedRow.status, "active");
    assert.equal(seedRow.version, 1);
    assert.ok(seedRow.createdAt);
    assert.ok(seedRow.lastLoginAt);
    assert.doesNotMatch(JSON.stringify(listed.body), /scrypt\$/);
    assert.doesNotMatch(JSON.stringify(listed.body), /passwordHash/);
  });

  it("locks all four admin endpoints and the settings write plane away from members", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    await createMember(admin, "colleague", "同事", memberLoginValue);
    const member = await login("colleague", memberLoginValue);

    const attempts = [
      ["GET", "/api/admin/users", undefined],
      ["POST", "/api/admin/users", JSON.stringify({ account: "more", displayName: "更多", [passwordField]: memberLoginValue })],
      ["PATCH", "/api/admin/users/jiangjz", JSON.stringify({ expectedVersion: 1, role: "member" })],
      ["PUT", "/api/settings/deepseek-key", JSON.stringify({ apiKey: "unit-api-key" })],
      ["PATCH", "/api/hospital-tenders/scheduler", JSON.stringify({ enabled: false })],
      ["POST", "/api/hospital-tenders/run", "{}"],
      ["POST", "/api/integrations/weixin-agent/login", "{}"],
    ];
    for (const [method, path, body] of attempts) {
      const denied = await request(path, { method, headers: member.headers, body });
      assert.equal(denied.response.status, 403, `${method} ${path}`);
      assert.equal(denied.body.error.code, "ADMIN_ROLE_REQUIRED", `${method} ${path}`);
    }

    const retiredPushplus = await request("/api/settings/pushplus/test", {
      method: "POST",
      headers: admin.headers,
      body: "{}",
    });
    assert.equal(retiredPushplus.response.status, 404);
    assert.equal(retiredPushplus.body.error.code, "NOT_FOUND");

    // 改密端点对 member 开放（任意登录用户）。
    const changeAllowed = await request("/api/auth/change-password", {
      method: "POST",
      headers: member.headers,
      body: JSON.stringify({ currentPassword: memberLoginValue, newPassword: "unit-rotated-password" }),
    });
    assert.equal(changeAllowed.response.status, 200);
  });

  it("keeps machine tokens fenced out of the admin plane", async () => {
    await startServer({ weixinAgentApiToken: "wx-machine-token", weixinAgentOwner: "jiangjz" });
    for (const [method, path] of [
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
      ["PATCH", "/api/admin/users/jiangjz"],
      ["POST", "/api/auth/change-password"],
    ]) {
      const denied = await request(path, {
        method,
        headers: { Authorization: "Bearer wx-machine-token" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(denied.response.status, 403, `${method} ${path}`);
      assert.equal(denied.body.error.code, "MACHINE_SCOPE_DENIED", `${method} ${path}`);
    }
  });

  it("creates users with validation, auditing, and duplicate protection", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);

    const created = await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "colleague", displayName: "同事", [passwordField]: memberLoginValue }),
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(
      {
        account: created.body.item.account,
        displayName: created.body.item.displayName,
        role: created.body.item.role,
        status: created.body.item.status,
        version: created.body.item.version,
        lastLoginAt: created.body.item.lastLoginAt,
      },
      {
        account: "colleague",
        displayName: "同事",
        role: "member",
        status: "active",
        version: 1,
        lastLoginAt: null,
      },
    );
    assert.doesNotMatch(JSON.stringify(created.body), /scrypt\$/);
    // user.create 有两行：启动兜底种子（system:bootstrap/jiangjz）+ 本次建号。
    const createAudits = auditRows("user.create").filter((row) => row.actor !== "system:bootstrap");
    assert.equal(createAudits.length, 1);
    assert.equal(createAudits[0].actor, "jiangjz");
    assert.equal(createAudits[0].entity_id, "colleague");
    assert.doesNotMatch(createAudits[0].after_json, /scrypt\$/);

    const duplicated = await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "colleague", displayName: "重复", [passwordField]: memberLoginValue }),
    });
    assert.equal(duplicated.response.status, 409);
    assert.equal(duplicated.body.error.code, "USER_EXISTS");

    const badAccount = await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "Bad-Account", displayName: "非法账号", [passwordField]: memberLoginValue }),
    });
    assert.equal(badAccount.response.status, 422);
    assert.equal(badAccount.body.error.fields.account, "format");

    const shortValue = await request("/api/admin/users", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ account: "shortpass", displayName: "短密码", [passwordField]: "test-tiny" }),
    });
    assert.equal(shortValue.response.status, 422);
    assert.equal(shortValue.body.error.fields[passwordField], "policy");

    // 新账号可以直接登录（DB 轨）。
    const memberLogin = await login("colleague", memberLoginValue);
    assert.equal(memberLogin.body.displayName, "同事");
    assert.equal(memberLogin.body.role, "member");
  });

  it("patches display name and role with optimistic locking and 404 mapping", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    const created = await createMember(admin, "colleague", "同事", memberLoginValue);

    const renamed = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: created.version, displayName: "同事甲", role: "admin" }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.item.displayName, "同事甲");
    assert.equal(renamed.body.item.role, "admin");
    assert.equal(renamed.body.item.version, 2);
    const updateAudits = auditRows("user.update");
    assert.equal(updateAudits.length, 1);
    assert.match(updateAudits[0].after_json, /同事甲/);
    assert.match(updateAudits[0].after_json, /admin/);

    const stale = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: created.version, displayName: "同事乙" }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");
    assert.equal(stale.body.error.fields.currentVersion, 2);

    const missing = await request("/api/admin/users/nobody", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 1, displayName: "无人" }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error.code, "USER_NOT_FOUND");

    const emptyPatch = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    assert.equal(emptyPatch.response.status, 422);
  });

  it("disables a user (killing sessions immediately), re-enables, and resets passwords", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    const created = await createMember(admin, "colleague", "同事", memberLoginValue);
    const member = await login("colleague", memberLoginValue);
    assert.equal(
      (await request("/api/auth/session", { headers: { Cookie: member.cookie } })).response.status,
      200,
    );

    // 停用 → 目标全部会话即死，登录也被拒（且不回退 env 轨）。
    const disabled = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: created.version, status: "disabled" }),
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.item.status, "disabled");
    assert.equal(
      (await request("/api/auth/session", { headers: { Cookie: member.cookie } })).response.status,
      401,
    );
    const deniedLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "colleague", [passwordField]: memberLoginValue }),
    });
    assert.equal(deniedLogin.response.status, 401);
    assert.equal(deniedLogin.body.error.code, "INVALID_CREDENTIALS");
    const disableAudits = auditRows("user.disable");
    assert.equal(disableAudits.length, 1);
    assert.match(disableAudits[0].after_json, /"revokedCount":1/);

    // 启用 → 可重新登录。
    const enabled = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: disabled.body.item.version, status: "active" }),
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.item.status, "active");
    assert.equal(auditRows("user.enable").length, 1);
    const back = await login("colleague", memberLoginValue);

    // 管理员重置目标密码 → 目标全部会话吊销、旧密码失效、新密码可登录。
    const reset = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({
        expectedVersion: enabled.body.item.version,
        [passwordField]: "unit-rotated-password",
      }),
    });
    assert.equal(reset.response.status, 200);
    assert.equal(
      (await request("/api/auth/session", { headers: { Cookie: back.cookie } })).response.status,
      401,
    );
    const oldValue = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account: "colleague", [passwordField]: memberLoginValue }),
    });
    assert.equal(oldValue.response.status, 401);
    const rotated = await login("colleague", "unit-rotated-password");
    assert.equal(rotated.body.account, "colleague");
    const resetAudits = auditRows("password.reset");
    assert.equal(resetAudits.length, 1);
    assert.equal(resetAudits[0].actor, "jiangjz");
    assert.doesNotMatch(resetAudits[0].after_json, /scrypt\$/);
  });

  it("keeps the admin's own session when resetting their own password via the admin API", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    const otherSession = await login("jiangjz", adminLoginValue);

    const reset = await request("/api/admin/users/jiangjz", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 1, [passwordField]: "unit-rotated-password" }),
    });
    assert.equal(reset.response.status, 200);
    assert.equal(
      (await request("/api/auth/session", { headers: { Cookie: admin.cookie } })).response.status,
      200,
    );
    assert.equal(
      (await request("/api/auth/session", { headers: { Cookie: otherSession.cookie } })).response.status,
      401,
    );
  });

  it("enforces the self-disable and last-active-admin guards", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);

    const selfDisable = await request("/api/admin/users/jiangjz", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 1, status: "disabled" }),
    });
    assert.equal(selfDisable.response.status, 409);
    assert.equal(selfDisable.body.error.code, "SELF_DISABLE_FORBIDDEN");

    const selfDemote = await request("/api/admin/users/jiangjz", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: 1, role: "member" }),
    });
    assert.equal(selfDemote.response.status, 409);
    assert.equal(selfDemote.body.error.code, "LAST_ADMIN_PROTECTED");

    // 有另一位 active admin 时允许降级他人。
    const second = await createMember(admin, "cocaptain", "副管理", memberLoginValue, "admin");
    const demoteOther = await request("/api/admin/users/cocaptain", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: second.version, role: "member" }),
    });
    assert.equal(demoteOther.response.status, 200);
    assert.equal(demoteOther.body.item.role, "member");

    // 现在 jiangjz 又是唯一 active admin：他人视角停用它也要被拦。
    const promoteBack = await request("/api/admin/users/cocaptain", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({ expectedVersion: demoteOther.body.item.version, role: "admin" }),
    });
    assert.equal(promoteBack.response.status, 200);
    const coAdmin = await login("cocaptain", memberLoginValue);
    const disableLast = await request("/api/admin/users/jiangjz", {
      method: "PATCH",
      headers: coAdmin.headers,
      body: JSON.stringify({ expectedVersion: 1, role: "member", status: "disabled" }),
    });
    // jiangjz 与 cocaptain 均为 active admin（2 人），允许操作——降回验证守卫需先降 cocaptain。
    assert.equal(disableLast.response.status, 200);
    const nowLastAdmin = await request("/api/admin/users/cocaptain", {
      method: "PATCH",
      headers: coAdmin.headers,
      body: JSON.stringify({ expectedVersion: promoteBack.body.item.version, role: "member" }),
    });
    assert.equal(nowLastAdmin.response.status, 409);
    assert.equal(nowLastAdmin.body.error.code, "LAST_ADMIN_PROTECTED");
  });

  it("emits one audit row per semantic change for combined patches", async () => {
    await startServer();
    const admin = await login("jiangjz", adminLoginValue);
    const created = await createMember(admin, "colleague", "同事", memberLoginValue);

    const combined = await request("/api/admin/users/colleague", {
      method: "PATCH",
      headers: admin.headers,
      body: JSON.stringify({
        expectedVersion: created.version,
        status: "disabled",
        [passwordField]: "unit-rotated-password",
        displayName: "同事改名",
      }),
    });
    assert.equal(combined.response.status, 200);
    assert.equal(auditRows("user.disable").length, 1);
    assert.equal(auditRows("password.reset").length, 1);
    assert.equal(auditRows("user.update").length, 1);
    assert.equal(auditRows("user.enable").length, 0);
  });
});
