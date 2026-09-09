import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { createServer as createPlatformServer } from "../../ai-platform/src/server.js";

const AUTH = Buffer.alloc(32, 83).toString("base64url");
const adminPassword = "unit-admin-password";
const adminHash = await hashPassword(adminPassword, { salt: Buffer.alloc(16, 84) });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test("business session enforces admin and CSRF before signed platform proxy and console access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-admin-proxy-"));
  const platform = createPlatformServer({
    config: { nodeEnv: "production", databasePath: ":memory:", authSecret: AUTH, taskAdmissionEnabled: true },
    autoStart: false, logger: { error() {} },
  });
  await listen(platform);
  const backend = createServer({
    databaseUrl: join(dir, "business.sqlite"), seed: false, nodeEnv: "test",
    authRequired: true, authAccount: "admin", authPassword: "", authPasswordHash: adminHash,
    authSessionSecret: Buffer.alloc(32, 85).toString("base64url"), authCookieSecure: false,
    aiPlatformMode: "required", aiPlatformAuthSecret: AUTH,
    aiPlatformBaseUrl: `http://127.0.0.1:${platform.address().port}`,
  });
  await listen(backend);
  const url = `http://127.0.0.1:${backend.address().port}`;
  async function request(path, { headers = {}, body, ...options } = {}) {
    const response = await fetch(url + path, {
      ...options, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { response, payload, text };
  }
  const adminPath = "/api/ai-platform/admin";
  try {
    assert.equal((await request(adminPath + "/overview")).response.status, 401);
    const login = await request("/api/auth/login", { method: "POST", body: { account: "admin", password: adminPassword } });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie: cookie, "X-CSRF-Token": login.payload.csrfToken };
    const console = await request("/api/ai-platform/console/", { headers });
    assert.equal(console.response.status, 200);
    assert.match(console.response.headers.get("content-type"), /text\/html/);
    assert.match(console.text, /admin.js/);
    for (const asset of ["admin.css", "admin.js"]) {
      assert.equal((await request("/api/ai-platform/console/" + asset, { headers })).response.status, 200);
    }
    assert.equal((await request("/api/ai-platform/console/config.env", { headers })).response.status, 404);
    const overview = await request(adminPath + "/overview", { headers });
    assert.equal(overview.response.status, 200);
    assert.equal(overview.text.includes(AUTH), false);
    assert.equal(overview.text.includes("aip1."), false);
    const policies = await request(adminPath + "/budgets", { headers });
    const policy = policies.payload.items[0];
    const body = { amountMicro: 5000000, expectedUpdatedAt: policy.updatedAt };
    const noCsrf = await request(adminPath + "/budgets/" + policy.id, { method: "PATCH", headers: { Cookie: cookie }, body });
    assert.equal(noCsrf.response.status, 403);
    const updated = await request(adminPath + "/budgets/" + policy.id, { method: "PATCH", headers, body });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.item.amountMicro, 5000000);
    assert.equal(platform.aiPlatform.db.prepare("SELECT count(*) n FROM platform_auth_replays").get().n > 0, true);
    const member = await request("/api/admin/users", {
      method: "POST", headers, body: { account: "member", displayName: "Member", password: "unit-member-password", role: "member" },
    });
    assert.equal(member.response.status, 201);
    const memberLogin = await request("/api/auth/login", { method: "POST", body: { account: "member", password: "unit-member-password" } });
    const memberCookie = memberLogin.response.headers.get("set-cookie").split(";")[0];
    assert.equal((await request(adminPath + "/overview", { headers: { Cookie: memberCookie } })).response.status, 403);
    assert.equal((await request("/api/ai-platform/console/", { headers: { Cookie: memberCookie } })).response.status, 403);
    const loggedOut = await request("/api/auth/logout", { method: "POST", headers, body: {} });
    assert.equal(loggedOut.response.status, 204);
    assert.equal((await request(adminPath + "/overview", { headers })).response.status, 401);
  } finally {
    await close(backend);
    await platform.closeAiPlatform();
    await rm(dir, { recursive: true, force: true });
  }
});
