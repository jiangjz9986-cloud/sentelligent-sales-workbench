import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;
const legacyToken = "test-token";

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startHarness(serverOptions = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-verification-api-"));
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

beforeEach(() => {
  tempDir = null;
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("快捷指令 Token 验证 API", () => {
  it("returns the exact public catalog without exposing credentials", async () => {
    await startHarness();

    const catalog = await read(await fetch(`${baseUrl}/api/integrations/shortcut/catalog`));
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(catalog.body.ledgers.map((item) => item.name), ["出差报销", "biubiu"]);
    assert.deepEqual(
      catalog.body.ledgers[0].entryTypes.expense.find((item) => item.category === "交通").subcategories,
      ["火车", "路桥费", "打车", "代驾", "停车"],
    );
    assert.doesNotMatch(JSON.stringify(catalog.body), /token|credential|account/iu);
  });

  it("distinguishes Token validity from bookkeeping readiness and blocks the V4 write step", async () => {
    await startHarness();

    const valid = await verify({ explain: true });
    assert.equal(valid.response.status, 200);
    assert.equal(valid.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(valid.body, {
      status: "error",
      integration: "shortcut",
      tokenValid: true,
      bookkeepingReady: false,
      protocolVersion: 1,
      error: {
        code: "SHORTCUT_BOOKKEEPING_NOT_READY",
        message: "Token 验证成功，但记账写入功能尚未开放",
      },
    });

    const missing = await verify({ tokenValue: null });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.response.headers.get("cache-control"), "no-store");
    assert.equal(missing.body.error.code, "SHORTCUT_TOKEN_REQUIRED");
    const invalid = await verify({ tokenValue: "wrong" });
    assert.equal(invalid.response.status, 401);
    assert.equal(invalid.response.headers.get("cache-control"), "no-store");
    assert.equal(invalid.body.error.code, "SHORTCUT_TOKEN_INVALID");
    const explained = await verify({ tokenValue: "wrong", explain: true });
    assert.equal(explained.response.status, 200);
    assert.equal(explained.body.status, "error");
    assert.equal(explained.body.tokenValid, false);
    assert.equal(explained.body.error.code, "SHORTCUT_TOKEN_INVALID");
    assert.equal(explained.body.error.message, "Token 无效或已撤销");

    const wrongMethod = await verify({ method: "POST" });
    assert.equal(wrongMethod.response.status, 405);
    assert.equal(wrongMethod.response.headers.get("allow"), "GET");
  });

  it("does not register the bookkeeping write route or create financial records", async () => {
    await startHarness();

    const write = await read(await fetch(`${baseUrl}/api/integrations/shortcut/bookkeeping`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${legacyToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "12.80元", source: "shortcut" }),
    }));
    assert.equal(write.response.status, 404);
    assert.equal(write.body.error.code, "NOT_FOUND");

    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_webhook_tokens").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_payments").get().count, 0);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'shortcut_bookkeeping_entries'").get().count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it("rate-limits repeated verification attempts by remote address", async () => {
    await startHarness({ shortcutWebhookRateLimit: 1, shortcutWebhookWindowMs: 60_000 });

    assert.equal((await verify({ explain: true })).response.status, 200);
    const limited = await verify({ explain: true });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.equal(limited.response.headers.get("retry-after"), "60");
    assert.equal(limited.response.headers.get("cache-control"), "no-store");
  });
});
