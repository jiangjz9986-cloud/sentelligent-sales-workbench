import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createServer } from "../src/server.js";
import { openDatabase } from "../src/db.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";

// v0.9.2：digest/run 归位 admin 门禁——账号须能建 users 行（bootstrap admin 正则
// 不含连字符），改用无连字符账号。
const OWNER = "assistantowner";
const machineToken = "test-machine-token";

let tempDir;
let server;
let baseUrl;
let nowMs;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function login() {
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: OWNER, password: "unit-password" }),
  });
  assert.equal(login.response.status, 200);
  return {
    cookie: login.response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: login.body.csrfToken,
  };
}

function withDb(work) {
  const db = openDatabase({ databaseUrl: join(tempDir, "digest.sqlite") });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${machineToken}`,
    "X-Weixin-Worker-Id": "digest-test-worker",
    "X-Weixin-Delivery-Status": "ready",
    "X-Weixin-Delivery-Scope": shortcutBookkeepingConversationId(OWNER, "sender-1"),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-digest-http-"));
  // Friday 2026-08-28 08:30 Asia/Shanghai — before the 09:00 daily gate.
  nowMs = Date.parse("2026-08-28T00:30:00.000Z");
  server = createServer({
    databaseUrl: join(tempDir, "digest.sqlite"),
    seed: false,
    nodeEnv: "test",
    authRequired: true,
    authAccount: OWNER,
    authPassword: "",
    authPasswordHash: await hashPassword("unit-password", { salt: Buffer.alloc(16, 13) }),
    authSessionSecret: Buffer.alloc(32, 12).toString("base64url"),
    authCookieSecure: false,
    weixinAgentApiToken: machineToken,
    weixinAgentOwner: OWNER,
    weixinAllowedSenderIds: "sender-1",
    weixinAllowGroups: false,
    weixinBookkeepingOwner: OWNER,
    weixinBookkeepingSenderId: "sender-1",
    weixinBookkeepingConfirmationEnabled: true,
    assistantClock: () => new Date(nowMs),
    dailyDigestSchedulerClock: () => new Date(nowMs),
    dailyDigestAutoRun: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  withDb((db) => {
    db.exec(`
      INSERT INTO customers (id, name, owner) VALUES ('customer-digest-http', '日照中医医院', '${OWNER}');
      INSERT INTO visit_itineraries (id, title, visit_date, status, request_json, plan_json, created_by, updated_by, owner)
      VALUES ('itinerary-http-1', '日照两院拜访', '2026-08-28', 'planned', '{}',
        '{"stops":[{"id":"stop-1","customerName":"日照中医医院"}],"orderedStopIds":["stop-1"]}', '${OWNER}', '${OWNER}', '${OWNER}');
    `);
  });
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
});

describe("digest HTTP surface", () => {
  it("keeps status and run behind user auth", async () => {
    assert.equal((await request("/api/digest/status")).response.status, 401);
    assert.equal((await request("/api/digest/run", { method: "POST" })).response.status, 401);
    const machine = await request("/api/digest/status", { headers: { Authorization: `Bearer ${machineToken}` } });
    assert.notEqual(machine.response.status, 200, "machine identities must not read the digest status");
  });

  it("reports scheduler status and markers", async () => {
    const session = await login();
    const status = await request("/api/digest/status", { headers: { Cookie: session.cookie } });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.item.running, false);
    assert.equal(status.body.item.dailyTime, "09:00");
    assert.equal(status.body.item.fridayTime, "16:30");
    assert.deepEqual(status.body.markers.daily, { digestDate: "2026-08-28", enqueued: false });
    assert.deepEqual(status.body.markers.friday, { digestDate: "2026-08-28", weekStart: "2026-08-24", enqueued: false });
  });

  it("previews both digests with dryRun without touching the outbox or audit log", async () => {
    const session = await login();
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken };
    const daily = await request("/api/digest/run?kind=daily&dryRun=1", { method: "POST", headers });
    assert.equal(daily.response.status, 200);
    assert.equal(daily.body.status, "rendered");
    assert.ok(daily.body.message.startsWith("【小小晨报】08-28 周五"));
    assert.ok(daily.body.message.includes("首站 日照中医医院"));
    const friday = await request("/api/digest/run?kind=friday&dryRun=1", { method: "POST", headers });
    assert.equal(friday.response.status, 200);
    assert.ok(friday.body.message.startsWith("【小小周五收尾】本周 08-24 ~ 08-30"));
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'digest.%'").get().count, 0);
    });
    const invalid = await request("/api/digest/run?kind=weekly", { method: "POST", headers });
    assert.equal(invalid.response.status, 400);
  });

  it("runs a manual send once, replays as already_sent, and delivers through the outbox lease", async () => {
    const session = await login();
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken };
    const sent = await request("/api/digest/run?kind=daily", { method: "POST", headers });
    assert.equal(sent.response.status, 200);
    assert.equal(sent.body.status, "sent");
    assert.equal(sent.body.digestDate, "2026-08-28");
    const replay = await request("/api/digest/run?kind=daily", { method: "POST", headers });
    assert.deepEqual({ status: replay.body.status, digestDate: replay.body.digestDate }, { status: "already_sent", digestDate: "2026-08-28" });

    const status = await request("/api/digest/status", { headers: { Cookie: session.cookie } });
    assert.equal(status.body.markers.daily.enqueued, true);
    withDb((db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 1);
      const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'digest.daily.sent'").all();
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor, "system:daily-digest");
      assert.equal(JSON.parse(audit[0].metadata_json).manual, true);
    });

    // The delivery worker leases the row and receives the rendered card.
    const leased = await request("/api/integrations/weixin-agent/confirmation-outbox", { headers: workerHeaders() });
    assert.equal(leased.response.status, 200);
    assert.ok(leased.body.leaseToken);
    assert.ok(leased.body.item.message.startsWith("【小小晨报】08-28 周五"));
    assert.ok(leased.body.item.message.includes("■ 今日行程（1 站）"));
  });

  it("sends the scheduled digest via runOnce once the gate opens", async () => {
    nowMs = Date.parse("2026-08-28T01:00:00.000Z"); // 09:00 Asia/Shanghai
    const first = await server.dailyDigestScheduler.runOnce();
    assert.equal(first.status, "success");
    assert.equal(first.daily.status, "sent");
    const second = await server.dailyDigestScheduler.runOnce();
    assert.equal(second.daily.status, "already_sent");
    withDb((db) => {
      const rows = db.prepare("SELECT payload_json FROM weixin_confirmation_outbox").all();
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0].payload_json).kind, "daily_digest");
    });
  });
});
