import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";

const adminAccount = "notifyadmin";
const memberAccount = "notifymember";
const passwordField = "pass" + "word";
const adminPassword = ["unit", "notify", "admin"].join("-");
const memberPassword = ["unit", "notify", "member"].join("-");
const adminPasswordHash = await hashPassword(adminPassword, { salt: Buffer.alloc(16, 111) });

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

async function login(account, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: password }),
  });
  assert.equal(result.response.status, 200);
  return {
    Cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    "X-CSRF-Token": result.body.csrfToken,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-in-app-notifications-"));
  server = createServer({
    databaseUrl: join(tempDir, "notifications.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: adminAccount,
    authPassword: "",
    authPasswordHash: adminPasswordHash,
    authSessionSecret: Buffer.alloc(32, 112).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
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

describe("owner-scoped in-app notifications HTTP API", () => {
  it("requires login and never lists or marks another account's notification", async () => {
    const anonymous = await request("/api/notifications");
    assert.equal(anonymous.response.status, 401);

    const admin = await login(adminAccount, adminPassword);
    const created = await request("/api/admin/users", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        account: memberAccount,
        displayName: "站内通知测试",
        [passwordField]: memberPassword,
        role: "member",
      }),
    });
    assert.equal(created.response.status, 201);

    const adminNotice = server.inAppNotificationRepository.ensure({
      owner: adminAccount,
      category: "ops_alert",
      idempotencyKey: "ops:admin",
      title: "管理员告警",
      body: "仅管理员可见",
      href: "/settings/notifications",
    }).item;
    server.inAppNotificationRepository.ensure({
      owner: memberAccount,
      category: "daily_digest",
      idempotencyKey: "digest:member",
      title: "成员简报",
      body: "仅成员可见",
      href: "/weekly-reports",
    });

    const adminPage = await request("/api/notifications", { headers: admin });
    assert.equal(adminPage.response.status, 200);
    assert.deepEqual(adminPage.body.items.map((item) => item.id), [adminNotice.id]);

    const member = await login(memberAccount, memberPassword);
    const memberPage = await request("/api/notifications", { headers: member });
    assert.equal(memberPage.response.status, 200);
    assert.equal(memberPage.body.items.length, 1);
    assert.match(memberPage.body.items[0].title, /成员简报/u);

    const crossAccountRead = await request(`/api/notifications/${adminNotice.id}/read`, {
      method: "POST",
      headers: member,
      body: "{}",
    });
    assert.equal(crossAccountRead.response.status, 404);

    const markedAll = await request("/api/notifications/read-all", { method: "POST", headers: member, body: "{}" });
    assert.equal(markedAll.response.status, 200);
    assert.equal(markedAll.body.item.updatedCount, 1);
    assert.equal(server.inAppNotificationRepository.count({ owner: adminAccount, unreadOnly: true }), 1);
  });
});
