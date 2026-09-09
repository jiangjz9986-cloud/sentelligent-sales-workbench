import { insertAudit } from "../audit/auditRepository.js";
import { createExecutionDrain } from "../services/executionDrain.js";
import { fridayOfWeek, shanghaiDateParts, weekStartOf } from "./digestContent.js";
import { renderDailyDigestMessage, renderFridayCloseoutMessage } from "./digestMessage.js";

// Independent 60s digest loop (v0.7.7, design §3). It deliberately does not
// share the action-reminder tick: reminders are data-driven scans while the
// digest is time-of-day driven, and the two enable switches stay independent.
// There is no scheduler state table — the enqueued outbox row itself is the
// durable "already sent for this date" marker (hasKey point lookup), so a
// restart never re-sends, a missed morning is re-sent later the same day, and
// a fully missed day is never back-filled.
//
// v0.9.3 多播：resolveDeliveries() 返回全部 active ∧ digest_enabled 绑定目标，
// runOnce/runManual 逐 owner hasKey→build→enqueue；幂等键含 owner 维度。
// 旧单 owner 键格式的升级日过渡逻辑已按计划在 v0.10.0 移除（键含日期，过渡窗
// 只存在于 v0.9.3 上线当天，退役后旧行天然失效）。

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

export function dailyDigestKey(owner, dateOnly) {
  return `daily-digest:${owner}:${dateOnly}`;
}

export function fridayCloseoutKey(owner, dateOnly) {
  return `friday-closeout:${owner}:${fridayOfWeek(dateOnly)}`;
}

export function createDailyDigestScheduler({
  db,
  outboxRepository,
  buildDailyDigest,
  buildFridayCloseout,
  resolveDeliveries,
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
  if (typeof resolveDeliveries !== "function") throw new TypeError("resolveDeliveries must be a function");
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
  // In-memory only, per owner: suppresses re-computing a confirmed-empty daily
  // digest for the rest of the day. Restart repetition of the skip audit is
  // acceptable.
  const dailyEmptySkipDates = new Map();

  function resolveDeliveryTargets() {
    if (!deliveryReady()) return null;
    let targets;
    try {
      targets = resolveDeliveries() ?? [];
    } catch {
      targets = [];
    }
    const normalized = [];
    for (const target of targets) {
      const owner = String(target?.account ?? target?.owner ?? "").trim();
      const conversationId = String(target?.conversationId ?? "").trim();
      if (owner && conversationId) normalized.push({ owner, conversationId });
    }
    return normalized;
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

  function alreadyEnqueued(owner, idempotencyKey) {
    return outboxRepository.hasKey({ owner, idempotencyKey });
  }

  async function deliverDaily({ delivery, parts, now, manual = false }) {
    const idempotencyKey = dailyDigestKey(delivery.owner, parts.date);
    if (!manual && dailyEmptySkipDates.get(delivery.owner) === parts.date) {
      return { owner: delivery.owner, status: "skipped_empty" };
    }
    if (alreadyEnqueued(delivery.owner, idempotencyKey)) {
      return { owner: delivery.owner, status: "already_sent", digestDate: parts.date };
    }
    const built = await buildDailyDigest({ owner: delivery.owner, now });
    if (built.empty) {
      if (built.reason === "no_business_owner") return { owner: delivery.owner, status: "skipped_no_owner" };
      if (dailyEmptySkipDates.get(delivery.owner) !== parts.date) {
        dailyEmptySkipDates.set(delivery.owner, parts.date);
        state.daily.lastSkippedDate = parts.date;
        audit({
          action: "digest.daily.skipped",
          entityId: parts.date,
          metadata: { reason: "empty", manual, owner: delivery.owner },
        });
      }
      return { owner: delivery.owner, status: "skipped_empty", digestDate: parts.date };
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
        owner: delivery.owner,
        outboxId: enqueued.id ?? null,
        replayed: enqueued.replayed === true,
        lateMinutes,
        manual,
        ...built.stats,
      },
    });
    return { owner: delivery.owner, status: "sent", digestDate: parts.date, outboxId: enqueued.id ?? null };
  }

  async function deliverFriday({ delivery, parts, now, manual = false }) {
    const idempotencyKey = fridayCloseoutKey(delivery.owner, parts.date);
    const digestDate = fridayOfWeek(parts.date);
    if (alreadyEnqueued(delivery.owner, idempotencyKey)) {
      return { owner: delivery.owner, status: "already_sent", digestDate };
    }
    const built = await buildFridayCloseout({ owner: delivery.owner, now });
    if (built.empty) return { owner: delivery.owner, status: "skipped_no_owner" };
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
        owner: delivery.owner,
        outboxId: enqueued.id ?? null,
        replayed: enqueued.replayed === true,
        lateMinutes,
        manual,
        ...built.stats,
      },
    });
    return { owner: delivery.owner, status: "sent", digestDate, outboxId: enqueued.id ?? null };
  }

  const execution = createExecutionDrain();
  function runOnce() { return execution.run(executeRunOnce); }
  async function executeRunOnce() {
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
      const deliveries = resolveDeliveryTargets();
      if (deliveries === null) {
        state.lastStatus = "skipped";
        return { status: "skipped", reason: "delivery_not_ready" };
      }
      if (deliveries.length === 0) {
        state.lastStatus = "skipped";
        return { status: "skipped", reason: "no_digest_targets" };
      }
      const results = {};
      if (dailyDue) {
        results.daily = [];
        for (const delivery of deliveries) {
          results.daily.push(await deliverDaily({ delivery, parts, now: nowDate }));
        }
      }
      if (fridayDue) {
        results.friday = [];
        for (const delivery of deliveries) {
          results.friday.push(await deliverFriday({ delivery, parts, now: nowDate }));
        }
      }
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
  function runManual(options) { return execution.run(() => executeRunManual(options)); }
  async function executeRunManual({ kind } = {}) {
    if (kind !== "daily" && kind !== "friday") throw new TypeError("kind must be daily or friday");
    const now = clock();
    const nowDate = now instanceof Date ? now : new Date(now);
    const parts = shanghaiDateParts(nowDate);
    const deliveries = resolveDeliveryTargets();
    if (deliveries === null) return { status: "delivery_not_ready" };
    if (deliveries.length === 0) return { status: "no_digest_targets" };
    const results = [];
    for (const delivery of deliveries) {
      results.push(kind === "daily"
        ? await deliverDaily({ delivery, parts, now: nowDate, manual: true })
        : await deliverFriday({ delivery, parts, now: nowDate, manual: true }));
    }
    const sent = results.filter((item) => item.status === "sent").length;
    const status = sent > 0
      ? "sent"
      : results.every((item) => item.status === "already_sent")
        ? "already_sent"
        : results[0]?.status ?? "no_digest_targets";
    return {
      status,
      digestDate: results[0]?.digestDate,
      deliveries: results,
    };
  }

  function markers() {
    const parts = shanghaiDateParts(clock());
    const fridayDate = fridayOfWeek(parts.date);
    let targets = [];
    try {
      targets = (resolveDeliveries() ?? [])
        .map((target) => String(target?.account ?? target?.owner ?? "").trim())
        .filter(Boolean);
    } catch {
      targets = [];
    }
    const deliveries = targets.map((owner) => ({
      owner,
      daily: alreadyEnqueued(owner, dailyDigestKey(owner, parts.date)),
      friday: alreadyEnqueued(owner, fridayCloseoutKey(owner, parts.date)),
    }));
    return {
      daily: {
        digestDate: parts.date,
        enqueued: deliveries.length > 0 && deliveries.every((item) => item.daily),
      },
      friday: {
        digestDate: fridayDate,
        weekStart: weekStartOf(parts.date),
        enqueued: deliveries.length > 0 && deliveries.every((item) => item.friday),
      },
      deliveries,
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

  return Object.freeze({ start, stop, runOnce, runManual, markers, status, drain(options) { stop(); return execution.drain(options); } });
}
