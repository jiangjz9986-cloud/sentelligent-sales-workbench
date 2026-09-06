import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { createConnection } from "../src/db/connection.js";
import { openDatabase } from "../src/db.js";
import { createProactiveBackgroundWorker } from "../src/assistant/proactiveBackgroundWorker.js";
import { createProactiveNotificationRepository } from "../src/assistant/proactiveNotificationRepository.js";
import { createProactiveNotificationScheduler } from "../src/assistant/proactiveNotificationScheduler.js";
import { createProactiveSuggestionRepository } from "../src/assistant/proactiveSuggestionRepository.js";
import { createServer } from "../src/server.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";

const NOW = "2026-09-05T04:00:00.000Z";
const OWNER_A = "acceptancea";
const OWNER_B = "acceptanceb";
const LOGIN_INPUT_A = "acceptance-password-a";
const LOGIN_INPUT_B = "acceptance-password-b";

async function request(baseUrl, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const bodyText = await response.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
  return { response, body };
}

async function login(baseUrl, account, password) {
  const result = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";", 1)[0],
    csrf: result.body.csrfToken,
  };
}

function asUser(baseUrl, session) {
  return (path, options = {}) => request(baseUrl, path, {
    ...options,
    headers: {
      Cookie: session.cookie,
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": session.csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function insertAcceptanceData(db, passwordHashB) {
  db.prepare(`
    INSERT INTO users (account, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($account, $displayName, $passwordHash, 'member', 'active', $now, $now)
  `).run({
    $account: OWNER_B,
    $displayName: "验收账号 B",
    $passwordHash: passwordHashB,
    $now: NOW,
  });
  db.prepare(`
    INSERT INTO customers (id, name, owner, version, decision_chain, created_at, updated_at)
    VALUES
      ('acceptance-customer-a', '验收客户 A', $ownerA, 1, '[]', $now, $now),
      ('acceptance-customer-b', '验收客户 B', $ownerB, 1, '[]', $now, $now)
  `).run({ $ownerA: OWNER_A, $ownerB: OWNER_B, $now: NOW });
  db.prepare(`
    INSERT INTO opportunities (
      id, customer_id, name, stage, owner, version, days, next, created_at, updated_at
    ) VALUES
      ('acceptance-opportunity-a', 'acceptance-customer-a', '验收商机 A', '方案输出', $ownerA, 1, 40, NULL, $now, $now),
      ('acceptance-opportunity-b', 'acceptance-customer-b', '验收商机 B', '调研机会', $ownerB, 1, 5, NULL, $now, $now)
  `).run({ $ownerA: OWNER_A, $ownerB: OWNER_B, $now: NOW });
  db.prepare(`
    INSERT INTO action_items (
      id, customer_id, opportunity_id, title, status, due, owner, version, created_at, updated_at
    ) VALUES (
      'acceptance-action-a', 'acceptance-customer-a', 'acceptance-opportunity-a',
      '验收行动', 'pending', '2026-09-04', $owner, 1, $now, $now
    )
  `).run({ $owner: OWNER_A, $now: NOW });
  db.prepare(`
    INSERT INTO risk_items (
      id, customer_id, opportunity_id, title, target, score, severity, status,
      evidence, action, owner, version, created_at, updated_at
    ) VALUES (
      'acceptance-risk-a', 'acceptance-customer-a', 'acceptance-opportunity-a',
      '验收风险', '商机', 80, '高', 'open', '风险证据', '风险动作', $owner, 1, $now, $now
    )
  `).run({ $owner: OWNER_A, $now: NOW });
  db.prepare(`
    INSERT INTO quick_records (
      id, owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id,
      status, version, created_at, updated_at
    ) VALUES (
      'acceptance-record-a', $owner, '不可泄露的客户沟通正文',
      '2026-08-01T10:00:00.000Z', 'phone', 'acceptance-customer-a',
      'acceptance-opportunity-a', 'confirmed', 1, $now, $now
    )
  `).run({ $owner: OWNER_A, $now: NOW });
}

function confirmationBody(preview) {
  return {
    confirmationPreviewId: preview.id,
    target: preview.target,
    customerId: preview.customerId,
    opportunityId: preview.opportunityId,
    expectedOpportunityVersion: preview.opportunityVersion,
    expectedCustomerVersion: preview.customerVersion,
    previewDigest: preview.previewDigest,
    preview: preview.preview,
  };
}

const ACCEPTANCE_DURABLE_TABLES = [
  "customers",
  "opportunities",
  "action_items",
  "risk_items",
  "quick_records",
  "ai_suggestions",
  "proactive_confirmation_previews",
  "proactive_scan_state",
  "proactive_scan_lease",
  "proactive_scan_runs",
  "proactive_notifications",
  "weixin_confirmation_outbox",
  "audit_logs",
  "idempotency_keys",
];

function durableAcceptanceSnapshot(databaseUrl) {
  const db = createConnection({ databaseUrl });
  try {
    return Object.fromEntries(ACCEPTANCE_DURABLE_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
  } finally {
    db.close();
  }
}

async function settleAutomaticSchedulers(server) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await waitForImmediate();
    if (!server.proactiveAssistantWorker.status().ticking
      && !server.proactiveNotificationScheduler.status().ticking) return;
  }
  throw new Error("automatic proactive schedulers did not settle");
}

async function advanceAutomaticClock(testContext, clock, server, milliseconds) {
  clock.advance(milliseconds);
  testContext.mock.timers.tick(milliseconds);
  await settleAutomaticSchedulers(server);
}

async function listenOnLoopback(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe("主动助手真实对象验收", () => {
  it("从真实 SQLite 客户/商机/行动/风险扫描，隔离 owner，模型不可用时降级并完成确认闭环", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-acceptance-"));
    const databaseUrl = join(tempDir, "acceptance.sqlite");
    const authHash = await hashPassword(LOGIN_INPUT_A, { salt: Buffer.alloc(16, 81) });
    const server = createServer({
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: OWNER_A,
      authPassword: "",
      authPasswordHash: authHash,
      authSessionSecret: Buffer.alloc(32, 82).toString("base64url"),
      authCookieSecure: false,
      aiAnalysisMode: "model",
      modelApiKey: "",
      proactiveAssistantAutoRun: false,
      proactiveNotificationAutoRun: false,
      hospitalTenderAutoRun: false,
      actionReminderAutoRun: false,
      invoiceEscalationAutoRun: false,
      dailyDigestAutoRun: false,
      weixinAgentApiToken: "",
      weixinAgentOwner: "",
      assistantClock: () => new Date(NOW),
      proactiveAssistantClock: () => new Date(NOW),
      proactiveNotificationClock: () => new Date(NOW),
    });
    const db = createConnection({ databaseUrl });
    try {
      insertAcceptanceData(db, await hashPassword(LOGIN_INPUT_B, { salt: Buffer.alloc(16, 83) }));
    } finally {
      db.close();
    }

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const sessionA = await login(baseUrl, OWNER_A, LOGIN_INPUT_A);
      const sessionB = await login(baseUrl, OWNER_B, LOGIN_INPUT_B);
      const asA = asUser(baseUrl, sessionA);
      const asB = asUser(baseUrl, sessionB);
      const worker = server.proactiveAssistantWorker;
      worker.scanRepository.updateState({ batchSize: 10, intervalSeconds: 30 });

      const firstRun = await worker.runOnce({ force: true });
      assert.equal(firstRun.status, "success");
      assert.equal(firstRun.objectCount, 2);

      const ownerAItems = worker.suggestionRepository.list({ owner: OWNER_A, limit: 100 });
      const ownerBItems = worker.suggestionRepository.list({ owner: OWNER_B, limit: 100 });
      assert.ok(ownerAItems.length >= 5);
      assert.ok(ownerBItems.length >= 3);
      assert.ok(ownerAItems.every((item) => item.source === "deterministic"));
      assert.ok(ownerAItems.every((item) => item.fallbackReason === "model_not_configured"));
      assert.ok(ownerAItems.every((item) => item.modelAttempted === true));
      assert.doesNotMatch(JSON.stringify(ownerAItems), /不可泄露的客户沟通正文/u);
      assert.ok(ownerBItems.every((item) => item.customerId === "acceptance-customer-b"));
      assert.ok(ownerBItems.every((item) => item.sourceRefs.every((ref) => !ref.id.endsWith("-a"))));

      const stageItem = ownerAItems.find((item) => item.trigger === "stage_evidence_mismatch");
      const riskItem = ownerAItems.find((item) => item.trigger === "risk_open");
      const actionItem = ownerAItems.find((item) => item.trigger === "action_due");
      assert.ok(stageItem);
      assert.ok(riskItem);
      assert.ok(actionItem);
      assert.ok(stageItem.sourceRefs.some((ref) => ref.type === "customer" && ref.id === "acceptance-customer-a"));
      assert.ok(stageItem.sourceRefs.some((ref) => ref.type === "opportunity" && ref.id === "acceptance-opportunity-a"));
      assert.ok(stageItem.sourceRefs.some((ref) => ref.type === "quick_record" && ref.id === "acceptance-record-a"));
      assert.ok(actionItem.sourceRefs.some((ref) => ref.type === "action_item" && ref.id === "acceptance-action-a"));
      assert.ok(riskItem.sourceRefs.some((ref) => ref.type === "risk_item" && ref.id === "acceptance-risk-a"));

      const snapshotA = await asA("/api/assistant/proactive");
      const snapshotB = await asB("/api/assistant/proactive");
      assert.equal(snapshotA.response.status, 200);
      assert.equal(snapshotB.response.status, 200);
      assert.ok(snapshotA.body.item.items.some((item) => item.customerId === "acceptance-customer-a"));
      assert.ok(snapshotA.body.item.items.every((item) => item.customerId !== "acceptance-customer-b"));
      assert.ok(snapshotB.body.item.items.some((item) => item.customerId === "acceptance-customer-b"));
      assert.ok(snapshotB.body.item.items.every((item) => item.customerId !== "acceptance-customer-a"));

      const noticeTick = await server.proactiveNotificationScheduler.tick();
      assert.equal(noticeTick.failed, 0);
      assert.equal(noticeTick.inAppDelivered, ownerAItems.length + ownerBItems.length);
      const notices = server.proactiveNotificationRepository.list({ owner: OWNER_A, limit: 100 });
      assert.equal(notices.length, ownerAItems.length);
      assert.ok(notices.every((item) => item.channel === "in_app" && item.status === "sent"));

      const previewResult = await asA(`/api/assistant/proactive/${stageItem.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-stage-preview-1" },
        body: JSON.stringify({ target: "action" }),
      });
      assert.equal(previewResult.response.status, 201);
      const stalePreview = previewResult.body.item;

      const updateDb = createConnection({ databaseUrl });
      try {
        updateDb.prepare(`
          UPDATE opportunities
             SET version = 2, updated_at = '2026-09-05T04:00:01.000Z'
           WHERE id = 'acceptance-opportunity-a'
        `).run();
      } finally {
        updateDb.close();
      }
      const staleConfirmation = await asA(`/api/assistant/proactive/${stageItem.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-stage-confirm-stale" },
        body: JSON.stringify(confirmationBody(stalePreview)),
      });
      assert.equal(staleConfirmation.response.status, 409);
      assert.equal(staleConfirmation.body.error.code, "PROACTIVE_PREVIEW_STALE");

      await worker.runOnce({ force: true });
      const refreshedItems = worker.suggestionRepository.list({ owner: OWNER_A, limit: 100 });
      const refreshed = refreshedItems.find((item) => (
        item.opportunityId === "acceptance-opportunity-a"
        && item.opportunityVersion === 2
        && item.trigger === "stage_evidence_mismatch"
        && item.writebackPreview.action
      ));
      assert.ok(refreshed);
      const freshPreviewResult = await asA(`/api/assistant/proactive/${refreshed.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-stage-preview-2" },
        body: JSON.stringify({ target: "action" }),
      });
      assert.equal(freshPreviewResult.response.status, 201);
      const freshPreview = freshPreviewResult.body.item;
      const confirmed = await asA(`/api/assistant/proactive/${refreshed.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-stage-confirm-2" },
        body: JSON.stringify(confirmationBody(freshPreview)),
      });
      assert.equal(confirmed.response.status, 201);
      assert.equal(confirmed.body.item.replayed, false);
      assert.equal(confirmed.body.item.action.owner, OWNER_A);
      assert.equal(confirmed.body.item.action.customerId, "acceptance-customer-a");
      const replay = await asA(`/api/assistant/proactive/${refreshed.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-stage-confirm-2" },
        body: JSON.stringify(confirmationBody(freshPreview)),
      });
      assert.equal(replay.response.status, 201);
      assert.equal(replay.body.item.action.id, confirmed.body.item.action.id);

      const auditDb = createConnection({ databaseUrl });
      try {
        assert.equal(auditDb.prepare("SELECT COUNT(*) AS count FROM action_items WHERE id = $id").get({ $id: confirmed.body.item.action.id }).count, 1);
        assert.ok(auditDb.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'action.create' AND entity_id = $id").get({ $id: confirmed.body.item.action.id }).count >= 1);
        assert.ok(auditDb.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'proactive_assistant.confirm' AND entity_id = $id").get({ $id: refreshed.id }).count >= 1);
      } finally {
        auditDb.close();
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("缓存命中不增加建议版本、额度或 fake 外送通知", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    let current = new Date(NOW);
    let modelCalls = 0;
    const clock = () => new Date(current);
    db.prepare(`
      INSERT INTO customers (id, name, owner, version, created_at, updated_at)
      VALUES ('cache-customer', '缓存客户', 'cache-owner', 1, $now, $now)
    `).run({ $now: NOW });
    db.prepare(`
      INSERT INTO opportunities (id, customer_id, name, stage, owner, version, next, created_at, updated_at)
      VALUES ('cache-opportunity', 'cache-customer', '缓存商机', '调研机会', 'cache-owner', 1, NULL, $now, $now)
    `).run({ $now: NOW });
    const worker = createProactiveBackgroundWorker({
      db,
      clock,
      workerId: "acceptance-cache-worker",
      batchSize: 10,
      leaseMs: 1_000,
      retryBaseMs: 10,
      modelProvider: "deepseek",
      modelName: "deepseek-v4-flash",
      modelRetryLimit: 0,
      modelCacheTtlMs: 86_400_000,
      modelOwnerDailyLimit: 5,
      modelGlobalDailyLimit: 5,
      modelAnalyzer: async () => {
        modelCalls += 1;
        return { source: "deepseek", headline: "缓存模型结果", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [] };
      },
    });
    const first = await worker.runOnce({ force: true });
    assert.equal(first.status, "success");
    const firstItem = worker.suggestionRepository.list({ owner: "cache-owner", limit: 10 })[0];
    assert.equal(firstItem.version, 1);
    assert.equal(firstItem.modelCacheHit, false);
    assert.equal(modelCalls, 1);

    const notificationRepository = createProactiveNotificationRepository(db, { clock });
    const outboxRepository = createWeixinConfirmationOutboxRepository(db, { clock });
    const delivered = [];
    const scheduler = createProactiveNotificationScheduler({
      suggestionRepository: worker.suggestionRepository,
      notificationRepository,
      outboxRepository,
      resolveDeliveries: () => [],
      resolvePushplusDelivery: () => ({ ready: () => true, notify: async (payload) => { delivered.push(payload); } }),
      clock,
    });
    assert.deepEqual(await scheduler.tick(), { queued: 0, sent: 1, externalSent: 1, inAppDelivered: 0, failed: 0, deferred: 0 });

    current = new Date(current.getTime() + 60_000);
    const second = await worker.runOnce({ force: true });
    const secondItem = worker.suggestionRepository.get(firstItem.id, { owner: "cache-owner" });
    assert.equal(second.status, "success");
    assert.equal(second.dedupedCount, 1);
    assert.equal(secondItem.version, 1);
    assert.equal(secondItem.modelCacheHit, true);
    assert.equal(modelCalls, 1);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'owner' AND owner = 'cache-owner'").get().call_count, 1);
    assert.equal(db.prepare("SELECT call_count FROM proactive_model_usage WHERE scope = 'global'").get().call_count, 1);
    assert.deepEqual(await scheduler.tick(), { queued: 0, sent: 0, externalSent: 0, inAppDelivered: 0, failed: 0, deferred: 0 });
    assert.equal(delivered.length, 1);
    assert.equal(notificationRepository.count({ owner: "cache-owner" }), 1);
    assert.equal(notificationRepository.list({ owner: "cache-owner" })[0].status, "sent");
    db.close();
  });

  it("自动启动并在真实 server 重启后续扫两个周期，保留人工编辑且不重复确认写回", async (testContext) => {
    const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-proactive-background-acceptance-"));
    const databaseUrl = join(tempDir, "background.sqlite");
    const passwordHashA = await hashPassword(LOGIN_INPUT_A, { salt: Buffer.alloc(16, 91) });
    const passwordHashB = await hashPassword(LOGIN_INPUT_B, { salt: Buffer.alloc(16, 92) });
    let current = new Date(NOW);
    const clock = () => new Date(current);
    const advanceClock = (milliseconds) => { current = new Date(current.getTime() + milliseconds); };
    const serverOptions = {
      databaseUrl,
      seed: false,
      nodeEnv: "test",
      authRequired: true,
      authAccount: OWNER_A,
      authPassword: "",
      authPasswordHash: passwordHashA,
      authSessionSecret: Buffer.alloc(32, 93).toString("base64url"),
      authCookieSecure: false,
      aiAnalysisMode: "model",
      modelApiKey: "",
      proactiveAssistantAutoRun: true,
      proactiveNotificationAutoRun: true,
      proactiveAssistantBatchSize: 1,
      proactiveAssistantIntervalMinutes: 1,
      proactiveAssistantPollMs: 1_000,
      proactiveAssistantLeaseMs: 1_000,
      proactiveNotificationPollMs: 1_000,
      hospitalTenderAutoRun: false,
      actionReminderAutoRun: false,
      invoiceEscalationAutoRun: false,
      dailyDigestAutoRun: false,
      weixinAgentApiToken: "",
      weixinAgentOwner: "",
      assistantClock: clock,
      proactiveAssistantClock: clock,
      proactiveNotificationClock: clock,
    };
    let server;
    let baseUrl;
    try {
      testContext.mock.timers.enable({ apis: ["setTimeout", "setInterval"], now: Date.parse(NOW) });
      server = createServer(serverOptions);
      const seedDb = createConnection({ databaseUrl });
      try {
        insertAcceptanceData(seedDb, passwordHashB);
      } finally {
        seedDb.close();
      }
      baseUrl = await listenOnLoopback(server);
      server.proactiveScanRepository.updateState({ batchSize: 1 });

      // The first callback is the worker's automatic initial schedule. No
      // direct runOnce call is used anywhere in this lifecycle test.
      testContext.mock.timers.tick(0);
      await settleAutomaticSchedulers(server);

      const firstState = server.proactiveScanRepository.getState();
      assert.equal(firstState.lastStatus, "success");
      assert.equal(firstState.lastBatchCount, 1);
      assert.equal(firstState.cursorOwner, OWNER_A);
      assert.equal(firstState.cursorOpportunityId, "acceptance-opportunity-a");
      assert.equal(server.proactiveScanRepository.listRuns({ limit: 10 }).length, 1);

      const sessionA = await login(baseUrl, OWNER_A, LOGIN_INPUT_A);
      const asA = asUser(baseUrl, sessionA);
      const firstItems = server.proactiveSuggestionRepository.list({ owner: OWNER_A, limit: 100 });
      const stageItem = firstItems.find((item) => item.trigger === "stage_evidence_mismatch");
      const riskItem = firstItems.find((item) => item.trigger === "risk_open");
      const actionDueItem = firstItems.find((item) => item.trigger === "action_due");
      assert.ok(stageItem?.writebackPreview?.action);
      assert.ok(riskItem?.writebackPreview?.risk);
      assert.ok(actionDueItem);
      assert.doesNotMatch(JSON.stringify(firstItems), /不可泄露的客户沟通正文/u);

      const oldPreviewResult = await asA(`/api/assistant/proactive/${stageItem.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-old-preview" },
        body: JSON.stringify({ target: "action" }),
      });
      assert.equal(oldPreviewResult.response.status, 201);
      const oldPreview = oldPreviewResult.body.item;
      const edited = await asA(`/api/assistant/proactive/${stageItem.id}/fields`, {
        method: "PATCH",
        headers: { "Idempotency-Key": "background-fields-edit" },
        body: JSON.stringify({
          assignee: OWNER_A,
          dueDate: "2099-09-01",
          priority: "高",
          expectedResult: "人工编辑后的确认结果",
          expectedVersion: stageItem.version,
        }),
      });
      assert.equal(edited.response.status, 200);
      assert.equal(edited.body.item.version, stageItem.version + 1);
      assert.equal(edited.body.item.reviewFields.expectedResult, "人工编辑后的确认结果");
      const cancelledOldPreview = await asA(`/api/assistant/proactive/${stageItem.id}/previews/${oldPreview.id}`);
      assert.equal(cancelledOldPreview.body.item.status, "cancelled");
      const editedPreviewResult = await asA(`/api/assistant/proactive/${stageItem.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-edited-preview" },
        body: JSON.stringify({ target: "action" }),
      });
      assert.equal(editedPreviewResult.response.status, 201);
      const editedPreview = editedPreviewResult.body.item;

      // Shorten only the persisted interval after the initial server-configured
      // minute. The worker still runs from its durable nextRunAt timestamps.
      server.proactiveScanRepository.updateState({
        intervalSeconds: 30,
        nextRunAt: new Date(current.getTime() + 30_000),
      });
      const beforeRestart = durableAcceptanceSnapshot(databaseUrl);
      await new Promise((resolve) => server.close(resolve));
      assert.deepEqual(durableAcceptanceSnapshot(databaseUrl), beforeRestart);

      server = createServer(serverOptions);
      baseUrl = await listenOnLoopback(server);
      assert.deepEqual(durableAcceptanceSnapshot(databaseUrl), beforeRestart);
      const restartedSessionA = await login(baseUrl, OWNER_A, LOGIN_INPUT_A);
      const restartedAsA = asUser(baseUrl, restartedSessionA);
      const persisted = server.proactiveSuggestionRepository.get(stageItem.id, { owner: OWNER_A });
      assert.equal(persisted.reviewFields.expectedResult, "人工编辑后的确认结果");
      const persistedPreview = await restartedAsA(`/api/assistant/proactive/${stageItem.id}/previews/${editedPreview.id}`);
      assert.equal(persistedPreview.response.status, 200);
      assert.equal(persistedPreview.body.item.status, "open");

      // Complete the remainder of cycle 1, then cycle 2, through timer ticks.
      await advanceAutomaticClock(testContext, { advance: advanceClock }, server, 60_000);
      await advanceAutomaticClock(testContext, { advance: advanceClock }, server, 30_000);
      await advanceAutomaticClock(testContext, { advance: advanceClock }, server, 30_000);
      const completedState = server.proactiveScanRepository.getState();
      assert.equal(completedState.lastStatus, "success");
      assert.equal(completedState.cursorOwner, null);
      assert.equal(completedState.cursorOpportunityId, null);
      assert.equal(completedState.cycleNumber, 2);
      const runs = server.proactiveScanRepository.listRuns({ limit: 10 }).reverse();
      assert.equal(runs.length, 4);
      assert.ok(runs.every((run) => run.status === "success" && run.trigger === "scheduled"));
      assert.deepEqual(runs.map((run) => run.objectCount), [1, 1, 1, 1]);
      assert.deepEqual(runs.map((run) => run.nextCursorOpportunityId), [
        "acceptance-opportunity-a", null, "acceptance-opportunity-a", null,
      ]);
      const afterCycleItems = server.proactiveSuggestionRepository.list({ owner: OWNER_A, limit: 100 });
      assert.equal(afterCycleItems.length, firstItems.length);
      const afterTwoCycles = server.proactiveSuggestionRepository.get(stageItem.id, { owner: OWNER_A });
      assert.equal(afterTwoCycles.reviewFields.expectedResult, "人工编辑后的确认结果");
      assert.equal(afterTwoCycles.reviewFields.priority, "高");
      // The edited revision is the only pending notification identity because
      // delivery had not run before the shutdown.
      assert.equal(server.proactiveNotificationRepository.count({ owner: OWNER_A }), firstItems.length);
      const notificationRows = server.proactiveNotificationRepository.list({ owner: OWNER_A, limit: 100 });
      assert.equal(
        notificationRows.filter((item) => item.status === "sent").length,
        firstItems.length,
      );
      assert.equal(server.proactiveNotificationRepository.list({ owner: OWNER_A, limit: 100 }).some((item) => item.channel !== "in_app"), false);

      // action_due was verified in the first cycle. Use the edited stage
      // suggestion for the cross-restart confirmation because it remains a
      // stable evidence-backed item across later due-date state changes.
      const confirmationSuggestion = stageItem;
      const confirmationPreviewResult = await restartedAsA(`/api/assistant/proactive/${confirmationSuggestion.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-action-preview" },
        body: JSON.stringify({ target: "action" }),
      });
      assert.ok([200, 201].includes(confirmationPreviewResult.response.status));
      const confirmationPreview = confirmationPreviewResult.body.item;

      const riskPreviewResult = await restartedAsA(`/api/assistant/proactive/${riskItem.id}/previews`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-risk-failure-preview" },
        body: JSON.stringify({ target: "risk" }),
      });
      assert.equal(riskPreviewResult.response.status, 201);
      const riskPreview = riskPreviewResult.body.item;
      const triggerDb = createConnection({ databaseUrl });
      try {
        triggerDb.exec(`
          CREATE TRIGGER background_risk_audit_failure
          BEFORE INSERT ON audit_logs
          WHEN NEW.action = 'risk.create'
          BEGIN
            SELECT RAISE(ABORT, 'background risk audit failure');
          END;
        `);
      } finally {
        triggerDb.close();
      }
      const riskFailed = await restartedAsA(`/api/assistant/proactive/${riskItem.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-risk-audit-failure" },
        body: JSON.stringify(confirmationBody(riskPreview)),
      });
      assert.equal(riskFailed.response.status, 500);
      const verifyRisk = createConnection({ databaseUrl });
      try {
        assert.equal(verifyRisk.prepare("SELECT COUNT(*) AS count FROM risk_items WHERE id = $id").get({ $id: `proactive-risk-${riskItem.id}` }).count, 0);
        assert.equal(verifyRisk.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'risk.create' AND entity_id = $id").get({ $id: `proactive-risk-${riskItem.id}` }).count, 0);
        assert.equal(verifyRisk.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = $key").get({ $key: "background-risk-audit-failure" }).count, 0);
        verifyRisk.exec("DROP TRIGGER background_risk_audit_failure");
      } finally {
        verifyRisk.close();
      }

      const confirmed = await restartedAsA(`/api/assistant/proactive/${confirmationSuggestion.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-action-confirm" },
        body: JSON.stringify(confirmationBody(confirmationPreview)),
      });
      assert.equal(confirmed.response.status, 201);
      const beforeReplayRestart = durableAcceptanceSnapshot(databaseUrl);
      await new Promise((resolve) => server.close(resolve));
      server = createServer(serverOptions);
      baseUrl = await listenOnLoopback(server);
      assert.deepEqual(durableAcceptanceSnapshot(databaseUrl), beforeReplayRestart);
      const finalSessionA = await login(baseUrl, OWNER_A, LOGIN_INPUT_A);
      const finalAsA = asUser(baseUrl, finalSessionA);
      const replay = await finalAsA(`/api/assistant/proactive/${confirmationSuggestion.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": "background-action-confirm" },
        body: JSON.stringify(confirmationBody(confirmationPreview)),
      });
      assert.equal(replay.response.status, 201);
      assert.equal(replay.body.item.replayed, false);
      assert.deepEqual(durableAcceptanceSnapshot(databaseUrl), beforeReplayRestart);
    } finally {
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      testContext.mock.timers.reset();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
