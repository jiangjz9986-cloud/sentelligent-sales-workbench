import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const account = "jiangjz";
const pairingSecret = "fixture-passphrase";
const machineCredential = "test-machine-token";

let tempDir;
let server;
let baseUrl;

async function read(response) {
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startServer(overrides = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "shortcut-pairing-api-"));
  server = createServer({
    databaseUrl: join(tempDir, "pairing.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPasswordHash: await hashPassword(pairingSecret, { salt: Buffer.alloc(16, 8) }),
    authSessionSecret: Buffer.alloc(32, 9).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    shortcutWebhookRateLimit: 30,
    shortcutWebhookWindowMs: 60_000,
    shortcutWeixinConfirmationEnabled: true,
    weixinAgentApiToken: machineCredential,
    weixinAgentOwner: account,
    weixinBookkeepingOwner: account,
    weixinBookkeepingSenderId: "sender-1",
    weixinAllowedSenderIds: "sender-1",
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function pair(body, options = {}) {
  const method = options.method ?? "POST";
  return read(await fetch(`${baseUrl}/api/integrations/shortcut/pair`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
  }));
}

beforeEach(() => {
  tempDir = null;
  server = null;
  baseUrl = null;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("快捷指令账号密码配对", () => {
  it("authenticates once, returns a device credential only in the pairing response, and maps it to the account", async () => {
    await startServer();
    const paired = await pair({ account, ["password"]: pairingSecret, label: "iPhone 记账" });
    assert.equal(paired.response.status, 201);
    assert.equal(paired.response.headers.get("cache-control"), "no-store");
    assert.equal(paired.response.headers.get("set-cookie"), null);
    assert.deepEqual(
      Object.keys(paired.body).sort(),
      ["account", "credentialType", "device", "status"].sort(),
    );
    assert.equal(paired.body.status, "paired");
    assert.equal(paired.body.credentialType, "shortcut-device");
    assert.equal(paired.body.account, account);
    assert.equal(paired.body.device.account, account);
    assert.equal(paired.body.device.label, "iPhone 记账");
    assert.match(paired.body.device.token, /^[A-Za-z0-9_-]{43}$/u);

    const db = openDatabase({ databaseUrl: join(tempDir, "pairing.sqlite") });
    try {
      const row = db.prepare("SELECT token_hash, token_prefix FROM shortcut_webhook_tokens").get();
      assert.equal(row.token_hash.length, 64);
      assert.notEqual(row.token_hash, paired.body.device.token);
      assert.equal(row.token_prefix, paired.body.device.token.slice(0, 8));
      assert.doesNotMatch(JSON.stringify(row), new RegExp(paired.body.device.token, "u"));
    } finally {
      db.close();
    }

    const verified = await read(await fetch(`${baseUrl}/api/integrations/shortcut/verify`, {
      headers: {
        Authorization: `Bearer ${paired.body.device.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    }));
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.tokenValid, true);
    assert.equal(verified.body.bookkeepingReady, false);
    assert.equal(verified.body.confirmationDelivery.reason, "worker_unavailable");

    const heartbeat = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${machineCredential}`,
        "X-Weixin-Worker-Id": "pairing-test-worker",
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(account, "sender-1"),
      },
    });
    assert.equal(heartbeat.status, 204);
    const activated = await read(await fetch(`${baseUrl}/api/integrations/shortcut/verify`, {
      headers: {
        Authorization: `Bearer ${paired.body.device.token}`,
        "X-Shortcut-Verification-Mode": "explain",
      },
    }));
    assert.equal(activated.body.bookkeepingReady, true);
    assert.deepEqual(activated.body.confirmationDelivery, { status: "ready" });
  });

  it("rejects wrong credentials, malformed methods, and incomplete authentication configuration", async () => {
    await startServer();
    const badCredential = await pair({ account, ["password"]: "wrong-passphrase" });
    assert.equal(badCredential.response.status, 401);
    assert.equal(badCredential.body.error.code, "INVALID_CREDENTIALS");
    assert.equal((await pair({ account, ["password"]: pairingSecret }, { method: "GET" })).response.status, 405);
    const invalid = await pair({ account, ["password"]: pairingSecret, extra: "nope" });
    assert.equal(invalid.response.status, 422);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await startServer({ authSessionSecret: "" });
    const unavailable = await pair({ account, ["password"]: pairingSecret });
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error.code, "AUTH_NOT_CONFIGURED");
  });
});
