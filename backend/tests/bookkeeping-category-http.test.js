import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";

const account = "categoryowner";
const passwordField = "pass" + "word";
const loginValue = "unit-category-password";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 101) });

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

async function startServer() {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-bookkeeping-category-http-"));
  server = createServer({
    databaseUrl: join(tempDir, "category.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 102).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function login() {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, [passwordField]: loginValue }),
  });
  assert.equal(result.response.status, 200);
  return {
    Cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    "X-CSRF-Token": result.body.csrfToken,
  };
}

beforeEach(async () => {
  tempDir = null;
  server = null;
  baseUrl = null;
  await startServer();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("bookkeeping category HTTP API", () => {
  it("lists defaults, creates, patches, archives, and restores a custom category", async () => {
    const auth = await login();
    const listed = await request("/api/bookkeeping/categories?entryType=expense", { headers: auth });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items.length, 6);
    assert.equal(listed.body.items.every((item) => item.entryType === "expense"), true);

    const created = await request("/api/bookkeeping/categories", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ entryType: "expense", name: "通讯费", subcategories: ["电话"], aliases: ["手机费"] }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.item.name, "通讯费");
    assert.equal(created.body.item.version, 1);
    assert.deepEqual(created.body.item.aliases, ["手机费"]);

    const fetched = await request(`/api/bookkeeping/categories/${created.body.item.id}`, { headers: auth });
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.body.item.id, created.body.item.id);
    assert.equal(fetched.response.headers.get("etag"), '"1"');

    const patched = await request(`/api/bookkeeping/categories/${created.body.item.id}`, {
      method: "PATCH",
      headers: { ...auth, "If-Match": `"${created.body.item.version}"` },
      body: JSON.stringify({ name: "通信费", subcategories: ["电话", "流量"], aliases: ["通信服务"] }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.item.name, "通信费");
    assert.equal(patched.body.item.version, 2);
    assert.deepEqual(patched.body.item.aliases, ["通信服务"]);

    const archived = await request(`/api/bookkeeping/categories/${patched.body.item.id}`, {
      method: "DELETE",
      headers: { ...auth, "If-Match": `"${patched.body.item.version}"` },
      body: "{}",
    });
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.item.status, "archived");

    const active = await request("/api/bookkeeping/categories?entryType=expense", { headers: auth });
    assert.equal(active.body.items.some((item) => item.name === "通信费"), false);
    const all = await request("/api/bookkeeping/categories?entryType=expense&includeArchived=true", { headers: auth });
    assert.equal(all.body.items.find((item) => item.name === "通信费").status, "archived");

    const restored = await request(`/api/bookkeeping/categories/${patched.body.item.id}`, {
      method: "PATCH",
      headers: { ...auth, "If-Match": `"${archived.body.item.version}"` },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.item.status, "active");
  });

  it("protects system defaults and requires optimistic locking", async () => {
    const auth = await login();
    const listed = await request("/api/bookkeeping/categories?entryType=expense", { headers: auth });
    const defaultItem = listed.body.items[0];

    const missingVersion = await request(`/api/bookkeeping/categories/${defaultItem.id}`, {
      method: "DELETE",
      headers: auth,
      body: "{}",
    });
    assert.equal(missingVersion.response.status, 428);
    assert.equal(missingVersion.body.error.code, "PRECONDITION_REQUIRED");

    const denied = await request(`/api/bookkeeping/categories/${defaultItem.id}`, {
      method: "DELETE",
      headers: { ...auth, "If-Match": `"${defaultItem.version}"` },
      body: "{}",
    });
    assert.equal(denied.response.status, 409);
    assert.equal(denied.body.error.code, "SYSTEM_CATEGORY_READ_ONLY");
  });
});
