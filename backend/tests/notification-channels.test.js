import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { createHospitalTenderPushplusDeliveryRepository } from "../src/hospitalTender/pushplusDeliveryRepository.js";
import { createHospitalTenderPushplusNotifier } from "../src/hospitalTender/pushplusNotifier.js";
import { apply as applyNotificationChannels } from "../src/db/migrations/0051_notification_channels.mjs";
import { createInAppDeliveryAdapter } from "../src/notifications/inAppDelivery.js";
import { createInAppNotificationRepository } from "../src/notifications/inAppNotificationRepository.js";
import { shortcutBookkeepingConversationId } from "../src/weixin/bookkeepingDeliveryScope.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";

function fixedClock(start = "2026-09-25T10:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance: (ms) => { time += ms; },
  };
}

function sampleNotice(overrides = {}) {
  return {
    title: "医院信息化项目招标公告",
    sourceName: "公开采购平台",
    publishedAt: "2026-09-25T09:00:00.000Z",
    url: "https://example.test/tender/1",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("in-app notifications are idempotent, owner-scoped, and reject external hrefs", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const time = fixedClock();
  let id = 0;
  const repository = createInAppNotificationRepository(db, { clock: time.now, idFactory: () => `notice-${++id}` });
  const input = {
    category: "ops_alert",
    idempotencyKey: "source:event:1",
    title: "运维告警",
    body: "服务异常",
    href: "/settings/notifications",
  };

  const first = repository.ensure({ owner: "admin-a", ...input });
  assert.equal(first.replayed, false);
  assert.equal(repository.ensure({ owner: "admin-a", ...input }).replayed, true);
  assert.equal(repository.ensure({ owner: "admin-b", ...input }).item.owner, "admin-b");
  assert.equal(repository.count({ owner: "admin-a", unreadOnly: true }), 1);
  assert.equal(repository.list({ owner: "admin-b" })[0].id, "notice-2");
  assert.throws(() => repository.ensure({ owner: "admin-a", ...input, idempotencyKey: "external", href: "https://evil.test" }), /internal path/u);

  time.advance(1_000);
  const read = repository.markRead(first.item.id, { owner: "admin-a" });
  assert.equal(read.unread, false);
  assert.equal(repository.count({ owner: "admin-a", unreadOnly: true }), 0);
  assert.throws(() => repository.markRead(first.item.id, { owner: "admin-b" }), { code: "NOTIFICATION_NOT_FOUND" });
  db.close();
});

test("same-millisecond notices are listed in insertion order", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const time = fixedClock();
  let id = 0;
  const repository = createInAppNotificationRepository(db, {
    clock: time.now,
    idFactory: () => `ordered-${++id}`,
  });
  const makeNotice = (index) => repository.ensure({
    owner: "member-a",
    category: "invoice_escalation",
    idempotencyKey: `invoice-level-${index}`,
    title: `提醒 ${index}`,
    body: `提醒 ${index}`,
    href: "/travel-expenses",
  });
  makeNotice(1);
  makeNotice(2);
  makeNotice(3);

  assert.deepEqual(repository.list({ owner: "member-a" }).map((item) => item.title), ["提醒 3", "提醒 2", "提醒 1"]);
  db.close();
});

test("legacy scheduler notifications are adapted to durable in-app records", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const repository = createInAppNotificationRepository(db, { idFactory: () => "daily-1" });
  const adapter = createInAppDeliveryAdapter({ repository, renderMessage: (payload) => `内容：${payload.digestDate}` });
  const input = {
    owner: "member-a",
    idempotencyKey: "daily_digest:2026-09-25:member-a",
    payload: { kind: "daily_digest", digestDate: "2026-09-25" },
  };
  assert.equal(adapter.enqueue(input).status, "sent");
  assert.equal(adapter.enqueue(input).replayed, true);
  assert.equal(repository.list({ owner: "member-a" })[0].body, "内容：2026-09-25");
  db.close();
});

test("migration retires already-queued non-bookkeeping WeChat notices", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const outbox = createWeixinConfirmationOutboxRepository(db);
  const conversationId = shortcutBookkeepingConversationId("owner-a", "sender-a");
  const oldDaily = outbox.enqueue({ owner: "owner-a", conversationId, idempotencyKey: "legacy-digest", payload: { kind: "daily_digest", digestDate: "2026-09-24" } });
  const bookkeeping = outbox.enqueue({ owner: "owner-a", conversationId, idempotencyKey: "bookkeeping", payload: { kind: "accepted", expenseId: "expense-1" } });

  applyNotificationChannels(db);

  const statuses = db.prepare("SELECT id,status,last_error_code FROM weixin_confirmation_outbox ORDER BY id").all();
  assert.deepEqual(statuses.map((row) => ({ ...row })), [
    { id: oldDaily.id, status: "failed", last_error_code: "CHANNEL_RETIRED" },
    { id: bookkeeping.id, status: "queued", last_error_code: null },
  ].sort((left, right) => left.id.localeCompare(right.id)));
  db.close();
});

test("proactive suggestions are mirrored into the unified inbox without changing their ledger", async () => {
  const { createProactiveSuggestionRepository } = await import("../src/assistant/proactiveSuggestionRepository.js");
  const { createProactiveNotificationRepository } = await import("../src/assistant/proactiveNotificationRepository.js");
  const { createProactiveNotificationScheduler } = await import("../src/assistant/proactiveNotificationScheduler.js");
  const db = openDatabase({ databaseUrl: ":memory:" });
  const time = fixedClock();
  const suggestions = createProactiveSuggestionRepository(db, { clock: time.now });
  const ledger = createProactiveNotificationRepository(db, { clock: time.now });
  const inbox = createInAppNotificationRepository(db, { clock: time.now });
  const suggestion = suggestions.save({
    owner: "member-a",
    dedupeKey: "suggestion:1",
    suggestion: {
      id: "suggestion-1", schemaVersion: "proactive-assistant-v1", modelVersion: "rules/v1",
      subjectType: "opportunity", subjectId: "opportunity-1", customerId: "customer-1", opportunityId: "opportunity-1",
      title: "补充下一步跟进", conclusion: "建议联系客户", facts: [], inferences: [], unknowns: [], risks: [], nextActions: [], sourceRefs: [],
      trigger: { type: "missing_next_step", detectedAt: time.now().toISOString(), reason: "缺少待办" },
      source: "deterministic", confidence: 80, writebackPreview: {},
    },
  }).item;
  assert.equal(suggestion.status, "pending");
  const scheduler = createProactiveNotificationScheduler({
    db,
    suggestionRepository: suggestions,
    notificationRepository: ledger,
    inAppNotificationRepository: inbox,
    outboxRepository: createWeixinConfirmationOutboxRepository(db),
    resolveDeliveries: () => [],
    clock: time.now,
  });

  assert.equal((await scheduler.tick()).inAppDelivered, 1);
  assert.equal(inbox.list({ owner: "member-a" })[0].category, "proactive_assistant");
  assert.equal(inbox.list({ owner: "member-a" })[0].href, "/");
  assert.equal(ledger.list({ owner: "member-a" })[0].status, "sent");
  db.close();
});

test("PushPlus Token records platform acceptance without claiming final delivery", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const time = fixedClock();
  const repository = createHospitalTenderPushplusDeliveryRepository(db, { clock: time.now, idFactory: () => "pushplus-1" });
  const calls = [];
  const notifier = createHospitalTenderPushplusNotifier({
    token: "mock-token",
    deliveryRepository: repository,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ code: 200, data: "short-code-1" });
    },
  });

  assert.equal(await notifier.notify({ cycleNumber: 4, notices: [sampleNotice()] }), 1);
  assert.deepEqual(repository.statusCounts(), { queued: 0, submitting: 0, accepted: 1, sent: 0, failed: 0, uncertain: 0, total: 1 });
  const submission = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://www.pushplus.plus/send");
  assert.equal(submission.template, "markdown");
  assert.equal(submission.channel, "wechat");
  assert.equal(submission.token, "mock-token");
  assert.equal(Object.hasOwn(notifier, "pollPending"), false);
  assert.equal(calls.length, 1);
  assert.equal(repository.statusCounts().sent, 0);
  db.close();
});

test("an ambiguous PushPlus timeout is marked uncertain and is never blindly resubmitted", async () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  const repository = createHospitalTenderPushplusDeliveryRepository(db, { idFactory: () => "pushplus-timeout" });
  let attempts = 0;
  const notifier = createHospitalTenderPushplusNotifier({
    token: "mock-token",
    deliveryRepository: repository,
    fetchImpl: async () => { attempts += 1; throw new Error("simulated timeout"); },
  });
  const batch = { cycleNumber: 2, notices: [sampleNotice()] };

  assert.equal(await notifier.notify(batch), 1);
  assert.equal(await notifier.notify(batch), 1);
  assert.equal(attempts, 1);
  assert.equal(repository.statusCounts().uncertain, 1);
  db.close();
});
