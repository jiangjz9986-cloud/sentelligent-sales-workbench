import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const account = "inline-test-account";
const password = "test-inline-password";
const machineToken = "test-machine-token";

let tempDir;
let server;
let baseUrl;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function body(overrides = {}) {
  return {
    account,
    password,
    text: "2026-08-20 打车 12.80元",
    selection_path: "支出 · 交通 · 打车",
    note: "内网测试，不产生正式费用",
    idempotency_key: "inline-shortcut-test-1",
    source: "shortcut",
    ...overrides,
  };
}

async function request(payload) {
  return read(await fetch(`${baseUrl}/api/integrations/shortcut/bookkeeping-inline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-inline-credentials-"));
  const passwordHash = await hashPassword(password, { salt: Buffer.alloc(16, 3) });
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 4).toString("base64url"),
    corsAllowedOrigins: [],
    shortcutWeixinConfirmationEnabled: true,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: account,
    weixinBookkeepingOwner: account,
    weixinBookkeepingSenderId: "synthetic-sender",
    weixinAllowedSenderIds: ["synthetic-sender"],
    travelExpenseAnalyzer: async () => ({
      status: "ready",
      confidence: 0.99,
      expense: {
        occurredOn: "2026-08-20",
        amountCents: 1280,
        reimbursementCents: 1280,
        purpose: "打车",
        merchant: "测试商户",
        paidAt: "2026-08-20T12:00:00+08:00",
        fundingSource: "personal",
        paymentMethod: "alipay",
      },
      warnings: [],
      source: { provider: "test", model: null },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
  baseUrl = null;
});

describe("手动账号密码常量版快捷记账 API", () => {
  it("rejects wrong inline credentials before creating a bookkeeping row", async () => {
    const result = await request(body({ password: "test-wrong-password" }));
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error.code, "INVALID_CREDENTIALS");
    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
    } finally {
      db.close();
    }
  });

  it("validates constants, strips them before persistence, and enters the normal review flow", async () => {
    const heartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${machineToken}`,
        "X-Weixin-Worker-Id": "inline-test-worker",
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(account, "synthetic-sender"),
      },
    });
    assert.equal(heartbeat.status, 204);
    const result = await request(body());
    assert.equal(result.response.status, 202);
    assert.equal(result.body.item.status, "review_required");
    assert.equal(result.body.item.owner, undefined);
    const db = openDatabase({ databaseUrl: join(tempDir, "test.sqlite") });
    try {
      const row = db.prepare("SELECT raw_text, note, request_hash FROM shortcut_bookkeeping_entries").get();
      assert.equal(row.raw_text.includes(password), false);
      assert.equal(row.note.includes(password), false);
      assert.equal(row.request_hash.includes(password), false);
    } finally {
      db.close();
    }
  });

  it("does not accept the inline constants on the token route", async () => {
    const response = await fetch(`${baseUrl}/api/integrations/shortcut/bookkeeping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    const result = await read(response);
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error.code, "SHORTCUT_TOKEN_REQUIRED");
  });
});
