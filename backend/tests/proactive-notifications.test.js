import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createActionItemStore } from "../src/actionItems/actionItemStore.js";
import { createActionReminderScheduler } from "../src/actionReminders/reminderScheduler.js";
import { renderActionReminderMessage } from "../src/actionReminders/reminderMessage.js";
import { createProactiveSuggestionRepository } from "../src/assistant/proactiveSuggestionRepository.js";
import { createProactiveNotificationRepository } from "../src/assistant/proactiveNotificationRepository.js";
import { createProactiveNotificationScheduler } from "../src/assistant/proactiveNotificationScheduler.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import { renderProactiveNotificationMessage } from "../src/assistant/proactiveNotificationMessage.js";
import { createServer } from "../src/server.js";

const OWNER = "owner-a";
function harness(start = "2026-09-05T12:00:00.000Z") {
  let value = new Date(start);
  return { now: () => new Date(value), set: (next) => { value = new Date(next); }, advance: (ms) => { value = new Date(value.getTime() + ms); } };
}
function suggestion(id, title = "补充下一步") {
  return {
    id, schemaVersion: "proactive-assistant-v1", modelVersion: "rules/proactive-v1",
    subjectType: "opportunity", subjectId: "op-a", customerId: "customer-a", opportunityId: "op-a",
    title, conclusion: "仅存在于建议账本的详细结论", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [], sourceRefs: [],
    trigger: { type: "missing_next_step", detectedAt: "2026-09-05T12:00:00.000Z", reason: "详细原因" },
    source: "deterministic", confidence: 80, writebackPreview: {},
  };
}
function actionDueSuggestion(id, actionId, title = "行动已到期") {
  const base = suggestion(id, title);
  const ref = { type: "action_item", id: actionId, label: "到期行动" };
  return {
    ...base,
    trigger: { type: "action_due", detectedAt: "2026-09-05T12:00:00.000Z", reason: "行动已到期" },
    sourceRefs: [ref],
    evidenceRefs: [ref],
  };
}
function fixture(start) {
  const time = harness(start); const db = openDatabase({ databaseUrl: ":memory:" });
  let n = 0; let o = 0;
  const suggestions = createProactiveSuggestionRepository(db, { clock: time.now });
  const notifications = createProactiveNotificationRepository(db, { clock: time.now, idFactory: () => `notice-${++n}` });
  const outbox = createWeixinConfirmationOutboxRepository(db, { clock: time.now, idFactory: () => `outbox-${++o}` });
  return { db, time, suggestions, notifications, outbox };
}
function save(repo, id, title) { return repo.save({ owner: OWNER, suggestion: suggestion(id, title), dedupeKey: `dedupe:${id}` }).item; }

describe("0040 proactive notification ledger", () => {
  it("creates the constrained ledger and deduplicates suggestion id + version", () => {
    const f = fixture();
    const columns = f.db.prepare("PRAGMA table_info(proactive_notifications)").all().map((row) => row.name);
    assert.ok(columns.includes("suggestion_version")); assert.ok(columns.includes("read_at"));
    const item = save(f.suggestions, "suggestion-1");
    assert.equal(f.notifications.ensure({ owner: OWNER, suggestion: item }).replayed, false);
    assert.equal(f.notifications.ensure({ owner: OWNER, suggestion: item }).replayed, true);
    assert.equal(f.notifications.count({ owner: OWNER }), 1);
    f.db.close();
  });

  it("queues one credential-free WeChat message, replays it, syncs sent, and marks read", async () => {
    const f = fixture(); save(f.suggestions, "suggestion-2");
    const scheduler = createProactiveNotificationScheduler({ suggestionRepository: f.suggestions, notificationRepository: f.notifications,
      outboxRepository: f.outbox, resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }], clock: f.time.now });
    assert.deepEqual(await scheduler.tick(), {
      queued: 1, sent: 0, externalSent: 0, inAppDelivered: 0, failed: 0, deferred: 0,
    });
    assert.deepEqual(await scheduler.tick(), {
      queued: 0, sent: 0, externalSent: 0, inAppDelivered: 0, failed: 0, deferred: 0,
    });
    const raw = f.db.prepare("SELECT * FROM weixin_confirmation_outbox").get();
    const payload = JSON.parse(raw.payload_json);
    assert.deepEqual(Object.keys(payload).sort(), ["kind", "priority", "status", "suggestionId", "summary", "title", "trigger"]);
    assert.equal(raw.payload_json.includes("详细结论"), false); assert.equal(raw.payload_json.includes("详细原因"), false);
    const lease = f.outbox.leaseNext({ renderMessage: renderProactiveNotificationMessage });
    assert.match(lease.message, /建议编号：suggestion-2/u);
    f.outbox.ackSuccess(lease.item.id, { leaseToken: lease.leaseToken, providerMessageId: "message-1" });
    const listed = f.notifications.list({ owner: OWNER }); assert.equal(listed[0].status, "sent");
    assert.equal(f.notifications.markRead(listed[0].id, { owner: OWNER }).status, "read");
    assert.equal(f.notifications.markRead(listed[0].id, { owner: OWNER }).readAt, "2026-09-05T12:00:00.000Z");
    f.db.close();
  });

  it("defers during quiet hours and applies per-owner hourly limiting without dropping inbox rows", async () => {
    const f = fixture("2026-09-05T23:15:00.000Z"); save(f.suggestions, "quiet-1");
    const quiet = createProactiveNotificationScheduler({ suggestionRepository: f.suggestions, notificationRepository: f.notifications,
      outboxRepository: f.outbox, resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }], clock: f.time.now });
    assert.equal((await quiet.tick()).deferred, 1);
    let row = f.notifications.list({ owner: OWNER })[0]; assert.equal(row.lastErrorCode, "QUIET_HOURS"); assert.ok(row.availableAt > f.time.now().toISOString());
    f.time.set("2026-09-06T09:00:00.000Z"); save(f.suggestions, "rate-2");
    const limited = createProactiveNotificationScheduler({ suggestionRepository: f.suggestions, notificationRepository: f.notifications,
      outboxRepository: f.outbox, resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }], clock: f.time.now,
      hourlyLimit: 1, dailyLimit: 10 });
    const result = await limited.tick(); assert.equal(result.queued, 1); assert.equal(result.deferred, 1);
    assert.equal(f.notifications.count({ owner: OWNER }), 2);
    f.db.close();
  });

  it("retains in-app when unbound instead of using a global PushPlus token", async () => {
    const f = fixture(); save(f.suggestions, "fallback-1");
    const inApp = createProactiveNotificationScheduler({ suggestionRepository: f.suggestions, notificationRepository: f.notifications,
      outboxRepository: f.outbox, resolveDeliveries: () => [], clock: f.time.now,
      // A legacy global pushplusReady/pushplusNotify pair must not widen this
      // owner-scoped delivery path.
      pushplusReady: () => true, pushplusNotify: async () => { throw new Error("must not be called"); } });
    assert.deepEqual(await inApp.tick(), {
      queued: 0, sent: 1, externalSent: 0, inAppDelivered: 1, failed: 0, deferred: 0,
    });
    assert.equal(f.notifications.list({ owner: OWNER })[0].channel, "in_app");
    assert.equal(f.notifications.list({ owner: OWNER })[0].status, "sent");
    f.db.close();
  });

  it("uses PushPlus only through an explicit owner-scoped resolver", async () => {
    const f = fixture(); save(f.suggestions, "scoped-a");
    const otherOwner = "owner-b";
    const other = suggestion("scoped-b", "另一账号建议");
    f.suggestions.save({ owner: otherOwner, suggestion: other, dedupeKey: "dedupe:scoped-b" });
    const calls = [];
    const scheduler = createProactiveNotificationScheduler({
      suggestionRepository: f.suggestions,
      notificationRepository: f.notifications,
      outboxRepository: f.outbox,
      resolveDeliveries: () => [],
      resolvePushplusDelivery: ({ owner }) => owner === OWNER
        ? { ready: () => true, notify: async (payload) => { calls.push({ owner, payload }); } }
        : null,
      clock: f.time.now,
    });
    const result = await scheduler.tick();
    assert.deepEqual(result, {
      queued: 0, sent: 2, externalSent: 1, inAppDelivered: 1, failed: 0, deferred: 0,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].owner, OWNER);
    const ownerANotification = f.notifications.list({ owner: OWNER })[0];
    const ownerBNotification = f.notifications.list({ owner: otherOwner })[0];
    assert.equal(ownerANotification.channel, "pushplus");
    assert.equal(ownerANotification.status, "sent");
    assert.equal(ownerBNotification.channel, "in_app");
    assert.equal(ownerBNotification.status, "sent");
    f.db.close();
  });

  it("stops an unsent notification after the suggestion leaves pending", async () => {
    const f = fixture(); const item = save(f.suggestions, "stale-1");
    f.notifications.ensure({ owner: OWNER, suggestion: item });
    f.suggestions.ignore(item.id, { owner: OWNER, reason: "not needed" });
    const scheduler = createProactiveNotificationScheduler({ suggestionRepository: f.suggestions, notificationRepository: f.notifications,
      outboxRepository: f.outbox, resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }], clock: f.time.now });
    assert.deepEqual(await scheduler.tick(), {
      queued: 0, sent: 0, externalSent: 0, inAppDelivered: 0, failed: 1, deferred: 0,
    });
    const notification = f.notifications.list({ owner: OWNER })[0];
    assert.equal(notification.status, "failed"); assert.equal(notification.lastErrorCode, "PROACTIVE_NOTIFICATION_STALE");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 0);
    f.db.close();
  });

  it("recovers a PushPlus attempt left processing by a crashed scheduler", () => {
    const f = fixture(); const item = save(f.suggestions, "push-crash-1");
    const notification = f.notifications.ensure({ owner: OWNER, suggestion: item }).item;
    f.notifications.setDelivery(notification.id, { owner: OWNER, channel: "pushplus", status: "processing" });
    f.time.advance(5*60_000+1);
    assert.equal(f.notifications.recoverStalePushplus(), 1);
    const recovered = f.notifications.list({ owner: OWNER })[0];
    assert.equal(recovered.status, "queued"); assert.equal(recovered.lastErrorCode, "PUSHPLUS_PROCESSING_RECOVERED");
    f.db.close();
  });

  it("keeps action_due visible in-app without sending a duplicate when the legacy reminder is queued or sent", async () => {
    for (const legacyState of ["queued", "sent"]) {
      const f = fixture();
      f.db.prepare(`INSERT INTO action_items
        (id, title, owner, remind_at, due, status)
        VALUES ($id, '行动提醒', $owner, $remindAt, '2026-09-05', 'pending')`).run({
        $id: `action-dedupe-${legacyState}`,
        $owner: OWNER,
        $remindAt: "2026-09-05T11:00:00.000Z",
      });
      const actionStore = createActionItemStore(f.db, { clock: f.time.now });
      const legacyScheduler = createActionReminderScheduler({
        db: f.db,
        store: actionStore,
        outboxRepository: f.outbox,
        resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }],
        deliveryReady: () => true,
        clock: f.time.now,
      });
      assert.equal((await legacyScheduler.runOnce()).enqueuedCount, 1);
      if (legacyState === "sent") {
        const lease = f.outbox.leaseNext({ renderMessage: (outboxItem) => renderActionReminderMessage(outboxItem.payload) });
        assert.ok(lease);
        f.outbox.ackSuccess(lease.item.id, { leaseToken: lease.leaseToken, providerMessageId: "legacy-message" });
      }
      const actionId = `action-dedupe-${legacyState}`;
      const item = actionDueSuggestion(`suggestion-dedupe-${legacyState}`, actionId);
      f.suggestions.save({ owner: OWNER, suggestion: item, dedupeKey: `dedupe:${item.id}` });
      const scheduler = createProactiveNotificationScheduler({
        db: f.db,
        suggestionRepository: f.suggestions,
        notificationRepository: f.notifications,
        outboxRepository: f.outbox,
        resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }],
        clock: f.time.now,
      });
      assert.deepEqual(await scheduler.tick(), {
        queued: 0, sent: 1, externalSent: 0, inAppDelivered: 1, failed: 0, deferred: 0,
      });
      const notification = f.notifications.list({ owner: OWNER })[0];
      assert.equal(notification.channel, "in_app");
      assert.equal(notification.status, "sent");
      assert.equal(notification.lastErrorCode, "ACTION_REMINDER_EXTERNAL_DEDUPED");
      assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM weixin_confirmation_outbox").get().count, 1);
      f.db.close();
    }
  });

  it("only deduplicates the exact owner and reminder period", async () => {
    const f = fixture();
    f.db.prepare(`INSERT INTO action_items
      (id, title, owner, remind_at, due, status)
      VALUES ('action-period', '行动提醒', $owner, '2026-09-05T11:00:00.000Z', '2026-09-05', 'pending')`).run({ $owner: OWNER });
    const actionStore = createActionItemStore(f.db, { clock: f.time.now });
    const legacyScheduler = createActionReminderScheduler({
      db: f.db,
      store: actionStore,
      outboxRepository: f.outbox,
      resolveDeliveries: () => [{ account: OWNER, conversationId: "conversation-a" }],
      deliveryReady: () => true,
      clock: f.time.now,
    });
    await legacyScheduler.runOnce();
    const samePeriod = actionDueSuggestion("suggestion-same-period", "action-period");
    f.suggestions.save({ owner: OWNER, suggestion: samePeriod, dedupeKey: "dedupe:same-period" });
    // A changed reminder timestamp is a new reminder cycle, so the proactive
    // external delivery is allowed rather than being suppressed by the old key.
    f.db.prepare("UPDATE action_items SET remind_at = '2026-09-05T12:00:00.000Z' WHERE id = 'action-period'").run();
    const calls = [];
    const scheduler = createProactiveNotificationScheduler({
      db: f.db,
      suggestionRepository: f.suggestions,
      notificationRepository: f.notifications,
      outboxRepository: f.outbox,
      resolveDeliveries: () => [],
      resolvePushplusDelivery: ({ owner }) => ({
        ready: () => true,
        notify: async (payload) => calls.push({ owner, payload }),
      }),
      clock: f.time.now,
    });
    assert.deepEqual(await scheduler.tick(), {
      queued: 0, sent: 1, externalSent: 1, inAppDelivered: 0, failed: 0, deferred: 0,
    });
    assert.equal(calls.length, 1);
    f.db.close();
  });
});

describe("proactive notification HTTP API", () => {
  it("lists only the current owner inbox and records an explicit read transition", async () => {
    const server = createServer({ databaseUrl: ":memory:", seed: true, authRequired: false,
      aiAnalysisMode: "mock", proactiveAssistantAutoRun: false, proactiveNotificationAutoRun: false,
      proactiveNotificationIdFactory: () => "http-notice-1" });
    try {
      server.proactiveSuggestionRepository.save({ owner: "jiangjz", suggestion: suggestion("http-suggestion-1"), dedupeKey: "dedupe:http-suggestion-1" });
      await server.proactiveNotificationScheduler.tick();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      let response = await fetch(`${base}/api/assistant/proactive/notifications`);
      assert.equal(response.status, 200);
      let body = await response.json(); assert.equal(body.total, 1); assert.equal(body.items[0].id, "http-notice-1");
      response = await fetch(`${base}/api/assistant/proactive/notifications/http-notice-1/read`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 200); body = await response.json(); assert.equal(body.item.status, "read"); assert.ok(body.item.readAt);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve)); else server.close();
    }
  });
});
