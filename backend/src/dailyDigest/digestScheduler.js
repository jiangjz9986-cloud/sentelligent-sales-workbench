import { insertAudit } from "../audit/auditRepository.js";
import { fridayOfWeek, shanghaiDateParts, weekStartOf } from "./digestContent.js";
import { renderDailyDigestMessage, renderFridayCloseoutMessage } from "./digestMessage.js";

// Independent 60s digest loop (v0.7.7, design §3). It deliberately does not
// share the action-reminder tick: reminders are data-driven scans while the
// digest is time-of-day driven, and the two enable switches stay independent.
// There is no scheduler state table — the enqueued outbox row itself is the
// durable "already sent for this date" marker (hasKey point lookup), so a
// restart never re-sends, a missed morning is re-sent later the same day, and
// a fully missed day is never back-filled.

const MAX_TIMER_DELAY = 2 ** 31 - 1;

function validTimeOfDay(value, name) {
  if (!value || typeof value !== "object"
    || !Number.isSafeInteger(value.hour) || value.hour < 0 || value.hour > 23
    || !Number.isSafeInteger(value.minute) || value.minute < 0 || value.minute > 59) {
    throw new TypeError(`${name} is invalid`);
  }
  return { hour: value.hour, minute: value.minute };
}

function timeLabel({ hour, minute }) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function dailyDigestKey(dateOnly) {
  return `daily-digest:${dateOnly}`;
}

export function fridayCloseoutKey(dateOnly) {
  return `friday-closeout:${fridayOfWeek(dateOnly)}`;
}

export function createDailyDigestScheduler({
  db,
  outboxRepository,
  buildDailyDigest,
  buildFridayCloseout,
  resolveOwner,
  resolveConversationId,
  deliveryReady,
  clock = () => new Date(),
  pollMs = 60_000,
  dailyTime = { hour: 9, minute: 0 },
  fridayTime = { hour: 16, minute: 30 },
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function" || typeof outboxRepository.hasKey !== "function") {
    throw new TypeError("outboxRepository with enqueue and hasKey is required");
  }
  if (typeof buildDailyDigest !== "function") throw new TypeError("buildDailyDigest must be a function");
  if (typeof buildFridayCloseout !== "function") throw new TypeError("buildFridayCloseout must be a function");
  if (typeof resolveOwner !== "function") throw new TypeError("resolveOwner must be a function");
  if (typeof resolveConversationId !== "function") throw new TypeError("resolveConversationId must be a function");
  if (typeof deliveryReady !== "function") throw new TypeError("deliveryReady must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) throw new TypeError("pollMs is invalid");
  const daily = validTimeOfDay(dailyTime, "dailyTime");
  const friday = validTimeOfDay(fridayTime, "fridayTime");
  const dailyMinutes = daily.hour * 60 + daily.minute;
  const fridayMinutes = friday.hour * 60 + friday.minute;

  let timer = null;
  let running = false;
  let stopped = true;
  const state = {
    lastTickAt: null,
    lastStatus: null,
    lastError: null,
    daily: { lastSentDate: null, lastSkippedDate: null, lastOutboxId: null },
    friday: { lastSentDate: null, lastOutboxId: null },
  };
  // In-memory only: suppresses re-computing a confirmed-empty daily digest for
  // the rest of the day. Restart repetition of the skip audit is acceptable.
  let dailyEmptySkipDate = null;

  function resolveDelivery() {
    if (!deliveryReady()) return null;
    let owner = "";
    let conversationId = "";
    try {
      owner = String(resolveOwner() ?? "").trim();
      conversationId = String(resolveConversationId() ?? "").trim();
    } catch {
      owner = "";
      conversationId = "";
    }
    if (!owner || !conversationId) return null;
    return { owner, conversationId };
  }

  function audit({ action, entityId, metadata }) {
    insertAudit(db, {
      action,
      entityType: "assistant_digest",
      entityId,
      actor: "system:daily-digest",
      metadata,
    });
  }

  async function deliverDaily({ delivery, parts, now, manual = false }) {
    const idempotencyKey = dailyDigestKey(parts.date);
    if (!manual && dailyEmptySkipDate === parts.date) return { status: "skipped_empty" };
    if (outboxRepository.hasKey({ owner: delivery.owner, idempotencyKey })) {
      return { status: "already_sent", digestDate: parts.date };
    }
    const built = await buildDailyDigest({ owner: delivery.owner, now });
    if (built.empty) {
      if (built.reason === "no_business_owner") return { status: "skipped_no_owner" };
      if (dailyEmptySkipDate !== parts.date) {
        dailyEmptySkipDate = parts.date;
        state.daily.lastSkippedDate = parts.date;
        audit({ action: "digest.daily.skipped", entityId: parts.date, metadata: { reason: "empty", manual } });
      }
      return { status: "skipped_empty", digestDate: parts.date };
    }
    renderDailyDigestMessage(built.payload);
    const enqueued = outboxRepository.enqueue({
      owner: delivery.owner,
      conversationId: delivery.conversationId,
      idempotencyKey,
      payload: built.payload,
    });
    const lateMinutes = Math.max(0, parts.hour * 60 + parts.minute - dailyMinutes);
    state.daily.lastSentDate = parts.date;
    state.daily.lastOutboxId = enqueued.id ?? null;
    audit({
      action: "digest.daily.sent",
      entityId: parts.date,
      metadata: {
        digestDate: parts.date,
        outboxId: enqueued.id ?? null,
        replayed: enqueued.replayed === true,
        lateMinutes,
        manual,
        ...built.stats,
      },
    });
    return { status: "sent", digestDate: parts.date, outboxId: enqueued.id ?? null };
  }

  async function deliverFriday({ delivery, parts, now, manual = false }) {
    const idempotencyKey = fridayCloseoutKey(parts.date);
    const digestDate = fridayOfWeek(parts.date);
    if (outboxRepository.hasKey({ owner: delivery.owner, idempotencyKey })) {
      return { status: "already_sent", digestDate };
    }
    const built = await buildFridayCloseout({ owner: delivery.owner, now });
    if (built.empty) return { status: "skipped_no_owner" };
    renderFridayCloseoutMessage(built.payload);
    const enqueued = outboxRepository.enqueue({
      owner: delivery.owner,
      conversationId: delivery.conversationId,
      idempotencyKey,
      payload: built.payload,
    });
    const lateMinutes = Math.max(0, parts.hour * 60 + parts.minute - fridayMinutes);
    state.friday.lastSentDate = digestDate;
    state.friday.lastOutboxId = enqueued.id ?? null;
    audit({
      action: "digest.friday.sent",
      entityId: digestDate,
      metadata: {
        digestDate,
        weekStart: weekStartOf(parts.date),
        outboxId: enqueued.id ?? null,
        replayed: enqueued.replayed === true,
        lateMinutes,
        manual,
        ...built.stats,
      },
    });
    return { status: "sent", digestDate, outboxId: enqueued.id ?? null };
  }

  async function runOnce() {
    const now = clock();
    const nowDate = now instanceof Date ? now : new Date(now);
    state.lastTickAt = nowDate.toISOString();
    try {
      const parts = shanghaiDateParts(nowDate);
      const minuteOfDay = parts.hour * 60 + parts.minute;
      const dailyDue = minuteOfDay >= dailyMinutes;
      const fridayDue = parts.weekday === 5 && minuteOfDay >= fridayMinutes;
      if (!dailyDue && !fridayDue) {
        state.lastStatus = "idle";
        return { status: "idle" };
      }
      const delivery = resolveDelivery();
      if (!delivery) {
        state.lastStatus = "skipped";
        return { status: "skipped", reason: "delivery_not_ready" };
      }
      const results = {};
      if (dailyDue) results.daily = await deliverDaily({ delivery, parts, now: nowDate });
      if (fridayDue) results.friday = await deliverFriday({ delivery, parts, now: nowDate });
      state.lastStatus = "success";
      state.lastError = null;
      return { status: "success", ...results };
    } catch (error) {
      state.lastStatus = "failed";
      state.lastError = error?.message ?? "digest tick failed";
      return { status: "failed", error: state.lastError };
    }
  }

  // Manual delivery for POST /api/digest/run: bypasses the time-of-day gate
  // (a deliberate same-day re-issue after an outage) but never the idempotency
  // marker, so a repeated manual run cannot duplicate a real push.
  async function runManual({ kind } = {}) {
    if (kind !== "daily" && kind !== "friday") throw new TypeError("kind must be daily or friday");
    const now = clock();
    const nowDate = now instanceof Date ? now : new Date(now);
    const parts = shanghaiDateParts(nowDate);
    const delivery = resolveDelivery();
    if (!delivery) return { status: "delivery_not_ready" };
    return kind === "daily"
      ? deliverDaily({ delivery, parts, now: nowDate, manual: true })
      : deliverFriday({ delivery, parts, now: nowDate, manual: true });
  }

  function markers() {
    const parts = shanghaiDateParts(clock());
    const fridayDate = fridayOfWeek(parts.date);
    let owner = "";
    try {
      owner = String(resolveOwner() ?? "").trim();
    } catch {
      owner = "";
    }
    const lookup = (idempotencyKey) => (
      owner ? outboxRepository.hasKey({ owner, idempotencyKey }) : false
    );
    return {
      daily: { digestDate: parts.date, enqueued: lookup(dailyDigestKey(parts.date)) },
      friday: {
        digestDate: fridayDate,
        weekStart: weekStartOf(parts.date),
        enqueued: lookup(fridayCloseoutKey(parts.date)),
      },
    };
  }

  function scheduleNext() {
    if (stopped) return;
    const delay = Math.min(pollMs, MAX_TIMER_DELAY);
    timer = setTimeout(async () => {
      if (stopped) return;
      running = true;
      try {
        await runOnce();
      } finally {
        running = false;
        scheduleNext();
      }
    }, delay);
    timer.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    scheduleNext();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function status() {
    return {
      running: !stopped,
      ticking: running,
      pollMs,
      dailyTime: timeLabel(daily),
      fridayTime: timeLabel(friday),
      lastTickAt: state.lastTickAt,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      daily: { ...state.daily },
      friday: { ...state.friday },
    };
  }

  return Object.freeze({ start, stop, runOnce, runManual, markers, status });
}
