import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createWeixinConfirmationOutboxRepository } from "../src/weixin/outboxRepository.js";
import { shanghaiDateParts, weekStartOf } from "../src/dailyDigest/digestContent.js";
import { createDailyDigestScheduler, dailyDigestKey, fridayCloseoutKey } from "../src/dailyDigest/digestScheduler.js";

const OWNER = "digest-owner";

let dir;
let db;
let now; // mutable fixed clock, UTC ISO

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sentelligent-digest-scheduler-"));
  db = openDatabase({ databaseUrl: join(dir, "scheduler.sqlite") });
  now = "2026-08-28T00:00:00.000Z"; // Friday 08:00 Asia/Shanghai
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function stubDailyBuilder(state = {}) {
  return async ({ now: buildNow }) => {
    state.calls = (state.calls ?? 0) + 1;
    if (state.empty) return { empty: true, reason: state.reason ?? "empty" };
    return {
      empty: false,
      payload: {
        kind: "daily_digest",
        digestDate: shanghaiDateParts(buildNow).date,
        headline: null,
        sections: [{ heading: "今日行程（1 站）", lines: ["· 拜访"] }],
        footer: "回复处理。",
      },
      stats: { itineraryCount: 1 },
    };
  };
}

function stubFridayBuilder(state = {}) {
  return async ({ now: buildNow }) => {
    state.calls = (state.calls ?? 0) + 1;
    if (state.empty) return { empty: true, reason: state.reason ?? "no_business_owner" };
    const date = shanghaiDateParts(buildNow).date;
    return {
      empty: false,
      payload: {
        kind: "friday_closeout",
        digestDate: date,
        weekStart: weekStartOf(date),
        sections: [{ heading: "周报", lines: ["本周暂无已确认的周报素材——快速记录确认后会自动进入周报。"] }],
        footer: "补传请在差旅页操作。",
      },
      stats: { reportCount: 0 },
    };
  };
}

function makeScheduler(overrides = {}) {
  const outboxRepository = overrides.outboxRepository
    ?? createWeixinConfirmationOutboxRepository(db, { clock: () => new Date(now) });
  const scheduler = createDailyDigestScheduler({
    db,
    outboxRepository,
    buildDailyDigest: stubDailyBuilder(),
    buildFridayCloseout: stubFridayBuilder(),
    resolveOwner: () => OWNER,
    resolveConversationId: () => "conversation-bound-1",
    deliveryReady: () => true,
    clock: () => new Date(now),
    pollMs: 60_000,
    dailyTime: { hour: 9, minute: 0 },
    fridayTime: { hour: 16, minute: 30 },
    ...overrides,
  });
  return { scheduler, outboxRepository };
}

function outboxRows() {
  return db.prepare("SELECT * FROM weixin_confirmation_outbox ORDER BY created_at, id").all();
}

function auditRows(action) {
  return db.prepare("SELECT * FROM audit_logs WHERE action = $action ORDER BY created_at, id").all({ $action: action });
}

describe("daily digest scheduler", () => {
  it("stays idle before 09:00 and sends exactly once at 09:00", async () => {
    const { scheduler } = makeScheduler();
    now = "2026-08-28T00:59:00.000Z"; // 08:59 +08
    assert.deepEqual(await scheduler.runOnce(), { status: "idle" });
    assert.equal(outboxRows().length, 0);

    now = "2026-08-28T01:00:00.000Z"; // 09:00 +08
    const sent = await scheduler.runOnce();
    assert.equal(sent.status, "success");
    assert.deepEqual(sent.daily, { status: "sent", digestDate: "2026-08-28", outboxId: outboxRows()[0].id });
    const rows = outboxRows();
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.kind, "daily_digest");
    assert.equal(payload.digestDate, "2026-08-28");
    assert.equal(rows[0].conversation_id, "conversation-bound-1");
    const audits = auditRows("digest.daily.sent");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, "system:daily-digest");
    const metadata = JSON.parse(audits[0].metadata_json ?? audits[0].metadata ?? "{}");
    assert.equal(metadata.lateMinutes, 0);
    assert.equal(metadata.itineraryCount, 1);

    // Same-day second tick replays nothing.
    now = "2026-08-28T01:01:00.000Z";
    const idle = await scheduler.runOnce();
    assert.deepEqual(idle.daily, { status: "already_sent", digestDate: "2026-08-28" });
    assert.equal(outboxRows().length, 1);
    assert.equal(auditRows("digest.daily.sent").length, 1);
  });

  it("does not resend after a restart because the outbox row is the durable marker", async () => {
    now = "2026-08-28T01:00:00.000Z";
    const first = makeScheduler();
    await first.scheduler.runOnce();
    assert.equal(outboxRows().length, 1);
    const second = makeScheduler();
    const result = await second.scheduler.runOnce();
    assert.deepEqual(result.daily, { status: "already_sent", digestDate: "2026-08-28" });
    assert.equal(outboxRows().length, 1);
  });

  it("back-fills later the same day with lateMinutes but never across days", async () => {
    const { scheduler } = makeScheduler();
    now = "2026-08-28T06:00:00.000Z"; // 14:00 +08，当日补发
    const late = await scheduler.runOnce();
    assert.equal(late.daily.status, "sent");
    const metadata = JSON.parse(auditRows("digest.daily.sent")[0].metadata_json ?? "{}");
    assert.equal(metadata.lateMinutes, 300);

    // 次日 09:00：新键正常发；昨日不补（键含日期，跨日语义自然成立）。
    now = "2026-08-29T01:00:00.000Z";
    const nextDay = await scheduler.runOnce();
    assert.equal(nextDay.daily.status, "sent");
    assert.equal(nextDay.daily.digestDate, "2026-08-29");
    const payloads = outboxRows().map((row) => JSON.parse(row.payload_json).digestDate);
    assert.deepEqual(payloads, ["2026-08-28", "2026-08-29"]);
  });

  it("skips an all-empty digest once per day with an audit and no marker", async () => {
    const dailyState = { empty: true };
    const { scheduler } = makeScheduler({ buildDailyDigest: stubDailyBuilder(dailyState) });
    now = "2026-08-28T01:00:00.000Z";
    const first = await scheduler.runOnce();
    assert.deepEqual(first.daily, { status: "skipped_empty", digestDate: "2026-08-28" });
    assert.equal(outboxRows().length, 0);
    assert.equal(auditRows("digest.daily.skipped").length, 1);
    assert.equal(dailyState.calls, 1);

    now = "2026-08-28T01:05:00.000Z";
    const second = await scheduler.runOnce();
    assert.deepEqual(second.daily, { status: "skipped_empty" });
    assert.equal(dailyState.calls, 1, "the empty digest must not be recomputed within the day");
    assert.equal(auditRows("digest.daily.skipped").length, 1);
  });

  it("waits for delivery readiness and back-fills once the worker returns", async () => {
    let ready = false;
    const { scheduler } = makeScheduler({ deliveryReady: () => ready });
    now = "2026-08-28T01:00:00.000Z";
    assert.deepEqual(await scheduler.runOnce(), { status: "skipped", reason: "delivery_not_ready" });
    assert.equal(outboxRows().length, 0);
    ready = true;
    now = "2026-08-28T01:03:00.000Z";
    const sent = await scheduler.runOnce();
    assert.equal(sent.daily.status, "sent");
    assert.equal(JSON.parse(auditRows("digest.daily.sent")[0].metadata_json ?? "{}").lateMinutes, 3);
  });

  it("sends the friday closeout at 16:30 but not at 16:29 and never on other weekdays", async () => {
    const { scheduler } = makeScheduler();
    now = "2026-08-28T08:29:00.000Z"; // 周五 16:29
    const before = await scheduler.runOnce();
    assert.equal(before.friday, undefined);
    assert.equal(before.daily.status, "sent"); // 当日晨报补发

    now = "2026-08-28T08:30:00.000Z"; // 周五 16:30
    const at = await scheduler.runOnce();
    assert.deepEqual(at.friday.status, "sent");
    assert.equal(at.friday.digestDate, "2026-08-28");
    const fridayAudit = auditRows("digest.friday.sent");
    assert.equal(fridayAudit.length, 1);
    const metadata = JSON.parse(fridayAudit[0].metadata_json ?? "{}");
    assert.equal(metadata.weekStart, "2026-08-24");

    // 同日再 tick：幂等。
    now = "2026-08-28T08:31:00.000Z";
    const replay = await scheduler.runOnce();
    assert.deepEqual(replay.friday, { status: "already_sent", digestDate: "2026-08-28" });

    // 周六 17:00：不补上周五。
    now = "2026-08-29T09:00:00.000Z";
    const saturday = await scheduler.runOnce();
    assert.equal(saturday.friday, undefined);
    const kinds = outboxRows().map((row) => JSON.parse(row.payload_json).kind);
    assert.deepEqual(kinds.filter((kind) => kind === "friday_closeout").length, 1);
  });

  it("delivers the friday-morning digest and the closeout as two messages with independent keys", async () => {
    const { scheduler, outboxRepository } = makeScheduler();
    now = "2026-08-28T09:00:00.000Z"; // 17:00 +08，两者同 tick 补发
    const result = await scheduler.runOnce();
    assert.equal(result.daily.status, "sent");
    assert.equal(result.friday.status, "sent");
    assert.equal(outboxRows().length, 2);
    assert.equal(outboxRepository.hasKey({ owner: OWNER, idempotencyKey: dailyDigestKey("2026-08-28") }), true);
    assert.equal(outboxRepository.hasKey({ owner: OWNER, idempotencyKey: fridayCloseoutKey("2026-08-28") }), true);
    const markers = scheduler.markers();
    assert.deepEqual(markers.daily, { digestDate: "2026-08-28", enqueued: true });
    assert.deepEqual(markers.friday, { digestDate: "2026-08-28", weekStart: "2026-08-24", enqueued: true });
  });

  it("keeps the marker clear when the enqueue fails so the next tick retries", async () => {
    const real = createWeixinConfirmationOutboxRepository(db, { clock: () => new Date(now) });
    let failNext = true;
    const flaky = {
      hasKey: (input) => real.hasKey(input),
      enqueue: (input) => {
        if (failNext) throw new Error("outbox unavailable");
        return real.enqueue(input);
      },
    };
    const { scheduler } = makeScheduler({ outboxRepository: flaky });
    now = "2026-08-28T01:00:00.000Z";
    const failed = await scheduler.runOnce();
    assert.equal(failed.status, "failed");
    assert.equal(scheduler.status().lastError, "outbox unavailable");
    assert.equal(outboxRows().length, 0);
    assert.equal(auditRows("digest.daily.sent").length, 0);

    failNext = false;
    now = "2026-08-28T01:01:00.000Z";
    const retried = await scheduler.runOnce();
    assert.equal(retried.daily.status, "sent");
    assert.equal(outboxRows().length, 1);
  });

  it("treats an unresolved business owner as transient and reports status/manual runs", async () => {
    const dailyState = { empty: true, reason: "no_business_owner" };
    const { scheduler } = makeScheduler({ buildDailyDigest: stubDailyBuilder(dailyState) });
    now = "2026-08-28T01:00:00.000Z";
    const result = await scheduler.runOnce();
    assert.deepEqual(result.daily, { status: "skipped_no_owner" });
    assert.equal(auditRows("digest.daily.skipped").length, 0, "transient owner gaps must not burn the daily skip marker");

    const status = scheduler.status();
    assert.equal(status.dailyTime, "09:00");
    assert.equal(status.fridayTime, "16:30");
    assert.equal(status.lastStatus, "success");

    // Manual runs bypass the clock gate but never the marker.
    dailyState.empty = false;
    now = "2026-08-28T00:30:00.000Z"; // 08:30，时刻门未到
    const manual = await scheduler.runManual({ kind: "daily" });
    assert.equal(manual.status, "sent");
    const replay = await scheduler.runManual({ kind: "daily" });
    assert.deepEqual(replay, { status: "already_sent", digestDate: "2026-08-28" });
    const fridayManual = await scheduler.runManual({ kind: "friday" });
    assert.equal(fridayManual.status, "sent");
    assert.equal(fridayManual.digestDate, "2026-08-28");
    await assert.rejects(() => scheduler.runManual({ kind: "weekly" }), TypeError);
  });
});
