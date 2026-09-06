import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createServer } from "../src/server.js";
import { createConnection } from "../src/db/connection.js";
import { seedWeixinBinding } from "./helpers/weixin-binding-fixtures.js";

const opsToken = ["fixture", "ops", "monitor", "token"].join("-");
const weixinToken = ["fixture", "weixin", "agent", "token"].join("-");
const owner = "opsowner";
const sender = "ops-sender";

let tempDir;
let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-ops-status-"));
  server = createServer({
    databaseUrl: join(tempDir, "ops-status.sqlite"),
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
    assistantConfirmationSecret: Buffer.alloc(32, 0x34),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  {
    const db = createConnection({ databaseUrl: join(tempDir, "ops-status.sqlite") });
    try {
      seedWeixinBinding(db, { account: owner, senderId: sender, role: "admin" });
    } finally {
      db.close();
    }
  }
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("ops alerts status endpoint", () => {
  it("enforces the machine auth matrix", async () => {
    const missing = await request("/api/integrations/ops-alerts/status");
    assert.equal(missing.response.status, 401);
    const wrong = await request("/api/integrations/ops-alerts/status", {
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(wrong.response.status, 401);
    const crossIntegration = await request("/api/integrations/ops-alerts/status", {
      headers: { Authorization: `Bearer ${weixinToken}` },
    });
    assert.equal(crossIntegration.response.status, 403);
    assert.equal(crossIntegration.body.error.code, "MACHINE_SCOPE_DENIED");
    // The method is part of the machine-route whitelist tuple, so a POST on
    // the status path is a scope denial rather than a bare 405.
    const wrongMethod = await request("/api/integrations/ops-alerts/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(wrongMethod.response.status, 403);
    assert.equal(wrongMethod.body.error.code, "MACHINE_SCOPE_DENIED");
  });

  it("aggregates outbox counts, delivery readiness, proactive notifications, and scheduler states", async () => {
    const initial = await request("/api/integrations/ops-alerts/status", {
      headers: { Authorization: `Bearer ${opsToken}` },
    });
    assert.equal(initial.response.status, 200);
    const item = initial.body.item;
    assert.ok(Date.parse(item.generatedAt) > 0);
    assert.deepEqual(item.outbox, { queued: 0, processing: 0, sent: 0, failed: 0, oldestQueuedAt: null });
    assert.deepEqual(item.proactiveNotifications, { queued: 0, processing: 0, sent: 0, failed: 0, read: 0, unread: 0, total: 0 });
    // No worker has reported yet: the 30s stale window reads as unavailable.
    assert.equal(item.weixinDelivery.status, "not_ready");
    assert.equal(item.weixinDelivery.reason, "worker_unavailable");
    // v0.9.3 巡检字段：active 绑定计数供 bindings=0 告警。
    assert.deepEqual(item.weixinBindings, { active: 1 });
    for (const name of ["hospitalTender", "actionReminders", "dailyDigest", "proactiveNotifications"]) {
      assert.ok(item.schedulers[name], name);
      assert.ok(Object.hasOwn(item.schedulers[name], "lastError"), name);
    }
    // Migration 0016 seeds the scheduler state row enabled by default; the
    // test stack simply never starts the timer loop.
    assert.equal(item.schedulers.hospitalTender.enabled, true);
    assert.equal(item.schedulers.hospitalTender.lastError, null);
    assert.equal(item.schedulers.actionReminders.running, false);
    assert.equal(item.schedulers.dailyDigest.running, false);
    assert.equal(item.schedulers.proactiveNotifications.running, false);
    assert.equal(item.schedulers.proactiveNotifications.quietStart, "22:00");
    assert.equal(item.schedulers.proactiveNotifications.hourlyLimit, 3);

    const queued = await request("/api/integrations/ops-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify({
        source: "ops-inspect:backup-freshness",
        severity: "warning",
        summary: "每日备份超过 26 小时未更新",
      }),
    });
    assert.equal(queued.response.status, 200);

    const workerReport = await fetch(`${baseUrl}/api/integrations/weixin-agent/confirmation-outbox`, {
      headers: {
        Authorization: `Bearer ${weixinToken}`,
        "X-Weixin-Delivery-Status": "ready",
        "X-Weixin-Delivery-Scope": "weixin:multi:v1",
      },
    });
    assert.equal(workerReport.status, 200);

    const after = await request("/api/integrations/ops-alerts/status", {
      headers: { Authorization: `Bearer ${opsToken}` },
    });
    assert.equal(after.response.status, 200);
    // The lease above moved the queued alert into processing; the worker
    // heartbeat reported through the same GET is now inside the stale window.
    assert.equal(after.body.item.outbox.processing, 1);
    assert.equal(after.body.item.outbox.queued, 0);
    assert.equal(after.body.item.weixinDelivery.status, "ready");
  });
});
