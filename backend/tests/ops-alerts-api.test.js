import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

const opsToken = ["fixture", "ops", "monitor", "token"].join("-");
const weixinToken = ["fixture", "weixin", "agent", "token"].join("-");
const owner = "ops-owner";
const sender = "ops-sender";

let tempDir;
let server;
let baseUrl;
let clockNow;
let pushplusCalls;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function alertBody(overrides = {}) {
  return {
    source: "systemd:sentelligent-frontend.service",
    severity: "critical",
    summary: "systemd 单元失败：sentelligent-frontend.service",
    detail: "journal tail",
    ...overrides,
  };
}

function startServer(overrides = {}) {
  server = createServer({
    databaseUrl: join(tempDir, "ops-alerts.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: false,
    authAccount: owner,
    opsAlertToken: opsToken,
    weixinAgentApiToken: weixinToken,
    weixinAgentOwner: owner,
    weixinBookkeepingConfirmationEnabled: true,
    weixinBookkeepingOwner: owner,
    weixinBookkeepingSenderId: sender,
    weixinAllowedSenderIds: sender,
    assistantConfirmationSecret: Buffer.alloc(32, 0x33),
    opsAlertClock: () => new Date(clockNow),
    fetchImpl: async (url, init) => {
      pushplusCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    },
    ...overrides,
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-ops-alerts-"));
  clockNow = "2026-08-29T01:20:00.000Z";
  pushplusCalls = [];
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("ops alerts machine endpoint", () => {
  it("rejects missing, wrong, and cross-integration tokens", async () => {
    await startServer();
    const missing = await request("/api/integrations/ops-alerts", {
      method: "POST",
      body: JSON.stringify(alertBody()),
    });
    assert.equal(missing.response.status, 401);

    const wrong = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: "Bearer not-the-token" },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(wrong.response.status, 401);

    const crossIntegration = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${weixinToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(crossIntegration.response.status, 403);
    assert.equal(crossIntegration.body.error.code, "MACHINE_SCOPE_DENIED");

    const opsTokenOnForeignRoute = await request("/api/customers", {
      headers: { Authorization: `Bearer ${opsToken}` },
    });
    assert.equal(opsTokenOnForeignRoute.response.status, 403);
    assert.equal(opsTokenOnForeignRoute.body.error.code, "MACHINE_SCOPE_DENIED");
  });

  it("rejects invalid payloads with 422", async () => {
    await startServer();
    const cases = [
      alertBody({ source: "bad source with spaces" }),
      alertBody({ source: "x".repeat(101) }),
      alertBody({ severity: "fatal" }),
      alertBody({ summary: "" }),
      alertBody({ summary: "x".repeat(301) }),
      alertBody({ detail: "x".repeat(2001) }),
      alertBody({ occurredAt: "not-a-date" }),
      alertBody({ unexpected: "field" }),
      { severity: "critical", summary: "缺 source" },
    ];
    for (const body of cases) {
      const rejected = await request("/api/integrations/ops-alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify(body),
      });
      assert.equal(rejected.response.status, 422, JSON.stringify(body));
      assert.equal(rejected.body.error.code, "VALIDATION_ERROR", JSON.stringify(body));
    }
    const db = createConnection({ databaseUrl: join(tempDir, "ops-alerts.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 0);
    db.close();
  });

  it("queues one ops_alert outbox row per source-hour, dedupes storms, and audits", async () => {
    await startServer();
    const first = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.item.status, "queued");
    assert.equal(first.body.item.replayed, false);
    assert.equal(first.body.item.pushplusFallback, false);

    for (let index = 0; index < 9; index += 1) {
      const replay = await request("/api/integrations/ops-alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify(alertBody()),
      });
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.item.replayed, true);
      assert.equal(replay.body.item.id, first.body.item.id);
    }

    const db = createConnection({ databaseUrl: join(tempDir, "ops-alerts.sqlite") });
    const rows = db.prepare("SELECT owner, conversation_id, payload_json FROM weixin_confirmation_outbox").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner, owner);
    assert.equal(rows[0].conversation_id, shortcutBookkeepingConversationId(owner, sender));
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.kind, "ops_alert");
    assert.equal(payload.origin, "systemd:sentelligent-frontend.service");
    assert.equal(payload.severity, "critical");
    assert.equal(Object.hasOwn(payload, "source"), false);
    const audits = db.prepare("SELECT actor, metadata_json FROM audit_logs WHERE action = 'ops_alert.receive'").all();
    assert.equal(audits.length, 10);
    assert.equal(audits[0].actor, owner);
    const metadata = JSON.parse(audits[0].metadata_json);
    assert.equal(metadata.severity, "critical");
    assert.equal(metadata.delivery, "weixin_outbox");
    assert.equal(metadata.replayed, false);
    assert.equal(JSON.parse(audits.at(-1).metadata_json).replayed, true);
    db.close();
    assert.equal(pushplusCalls.length, 0);
  });

  it("opens a second outbox row when the hour rolls over", async () => {
    await startServer();
    const first = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(first.body.item.replayed, false);
    clockNow = "2026-08-29T02:01:00.000Z";
    const nextHour = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(nextHour.response.status, 200);
    assert.equal(nextHour.body.item.replayed, false);
    assert.notEqual(nextHour.body.item.id, first.body.item.id);
    const db = createConnection({ databaseUrl: join(tempDir, "ops-alerts.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 2);
    db.close();
  });

  it("falls back to PushPlus in-request while WeChat delivery is not bound", async () => {
    const pushplusFixtureToken = ["fixture", "pushplus", "fallback", "token"].join("-");
    await startServer({
      weixinBookkeepingConfirmationEnabled: false,
      hospitalTenderPushplusToken: pushplusFixtureToken,
    });
    const accepted = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.item.pushplusFallback, true);
    assert.equal(pushplusCalls.length, 1);
    assert.equal(new URL(pushplusCalls[0].url).hostname, "www.pushplus.plus");
    assert.equal(pushplusCalls[0].body.token, pushplusFixtureToken);
    assert.match(pushplusCalls[0].body.title, /【严重】/u);
    assert.match(pushplusCalls[0].body.content, /systemd:sentelligent-frontend.service/u);
    const db = createConnection({ databaseUrl: join(tempDir, "ops-alerts.sqlite") });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 0);
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'ops_alert.receive'").get();
    assert.equal(JSON.parse(audit.metadata_json).delivery, "pushplus");
    db.close();
  });

  it("returns 503 when both delivery channels are unavailable", async () => {
    await startServer({ weixinBookkeepingConfirmationEnabled: false });
    const unavailable = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody()),
    });
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error.code, "OPS_ALERT_DELIVERY_UNAVAILABLE");
  });

  it("delivers the rendered alert card to a ready worker lease", async () => {
    await startServer();
    const queued = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify(alertBody({ occurredAt: "2026-08-28T17:05:00.000Z" })),
    });
    assert.equal(queued.response.status, 200);

    const lease = await request("/api/integrations/weixin-agent/confirmation-outbox", {
      headers: {
        Authorization: `Bearer ${weixinToken}`,
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(owner, sender),
      },
    });
    assert.equal(lease.response.status, 200);
    assert.equal(lease.body.item.id, queued.body.item.id);
    assert.match(lease.body.item.message, /【小小运维告警】/u);
    assert.match(lease.body.item.message, /级别：严重/u);
    assert.match(lease.body.item.message, /来源：systemd:sentelligent-frontend.service/u);
    assert.match(lease.body.item.message, /时间：2026-08-29 01:05（\+08:00）/u);
    assert.match(lease.body.item.message, /摘要：systemd 单元失败：sentelligent-frontend.service/u);
  });
});
