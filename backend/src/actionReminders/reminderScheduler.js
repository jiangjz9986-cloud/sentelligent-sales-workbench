import { insertAudit } from "../audit/auditRepository.js";
import { renderActionReminderMessage } from "./reminderMessage.js";

// Lightweight due-reminder loop (v0.7.5). The action_items table itself is
// the queue (remind_at <= now AND reminded_at IS NULL); the outbox unique key
// plus the reminded_at marker give double idempotency, so restarts and
// concurrent scans stay harmless. This deliberately does not copy the tender
// scheduler's cursor/snapshot state machine (design §2.1).

const LATE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY = 2 ** 31 - 1;
const WEEKDAY_LABELS = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function reminderDisplayOf(remindAtIso) {
  const parsed = new Date(remindAtIso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = shanghaiFormatter.formatToParts(parsed);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const date = `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
  const weekday = WEEKDAY_LABELS[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
  return `${date.slice(5)}（${weekday}）${valueOf("hour")}:${valueOf("minute")}`;
}

export function createActionReminderScheduler({
  db,
  store,
  outboxRepository,
  resolveDeliveries,
  deliveryReady,
  clock = () => new Date(),
  pollMs = 60_000,
  batchLimit = 20,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (!store || typeof store.dueReminders !== "function") throw new TypeError("an action item store is required");
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository with enqueue is required");
  }
  if (typeof resolveDeliveries !== "function") throw new TypeError("resolveDeliveries must be a function");
  if (typeof deliveryReady !== "function") throw new TypeError("deliveryReady must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) throw new TypeError("pollMs is invalid");
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new TypeError("batchLimit is invalid");

  let timer = null;
  let running = false;
  let stopped = true;
  const state = { lastTickAt: null, lastStatus: null, lastEnqueuedCount: 0, lastError: null };

  // v0.9.3 多播：逐 digest 目标扫描各自到期项（批上限 per-owner 不变）。owner 无
  // 绑定 → 其到期项不扫描、不置 reminded_at，后补绑定即补发（>24h 自动带过期标记）。
  async function runOnce() {
    const now = clock();
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    state.lastTickAt = nowIso;
    try {
      if (!deliveryReady()) {
        state.lastStatus = "skipped";
        state.lastEnqueuedCount = 0;
        return { status: "skipped", reason: "delivery_not_ready" };
      }
      let deliveries = [];
      try {
        deliveries = (resolveDeliveries() ?? [])
          .map((target) => ({
            owner: String(target?.account ?? target?.owner ?? "").trim(),
            conversationId: String(target?.conversationId ?? "").trim(),
          }))
          .filter((target) => target.owner && target.conversationId);
      } catch {
        deliveries = [];
      }
      if (deliveries.length === 0) {
        state.lastStatus = "skipped";
        state.lastEnqueuedCount = 0;
        return { status: "skipped", reason: "delivery_not_ready" };
      }
      let enqueuedCount = 0;
      let lateCount = 0;
      for (const { owner, conversationId } of deliveries) {
        const dueItems = store.dueReminders({ owner, now: nowIso, limit: batchLimit });
        for (const item of dueItems) {
          const remindAtMs = Date.parse(item.remindAt);
          const late = Number.isFinite(remindAtMs) && Date.parse(nowIso) - remindAtMs > LATE_THRESHOLD_MS;
          const payload = {
            kind: "action_reminder",
            actionItemId: item.id,
            title: String(item.title ?? "").slice(0, 200),
            remindAtDisplay: reminderDisplayOf(item.remindAt) ?? item.remindAt,
            priority: item.priority ?? "中",
            customerName: item.customerName ?? null,
            reasonExcerpt: item.reason ? String(item.reason).slice(0, 60) : null,
            idSuffix: item.id.length > 6 ? item.id.slice(-6) : item.id,
            late,
          };
          renderActionReminderMessage(payload);
          // 幂等键加 owner 维度；reminded_at 双保险使键换代零双发。
          const enqueued = outboxRepository.enqueue({
            owner,
            conversationId,
            idempotencyKey: `action-reminder:${owner}:${item.id}:${remindAtMs}`,
            payload,
          });
          const marked = store.markReminded({ id: item.id, now: nowIso });
          enqueuedCount += 1;
          if (late) lateCount += 1;
          if (marked.marked) {
            insertAudit(db, {
              action: "action.reminder.sent",
              entityType: "action",
              entityId: item.id,
              actor: "system:action-reminder",
              metadata: {
                remindAt: item.remindAt,
                owner,
                outboxId: enqueued.id ?? null,
                replayed: enqueued.replayed === true,
                late,
              },
            });
          }
        }
      }
      state.lastStatus = "success";
      state.lastEnqueuedCount = enqueuedCount;
      state.lastError = null;
      return { status: "success", enqueuedCount, lateCount };
    } catch (error) {
      state.lastStatus = "failed";
      state.lastError = error?.message ?? "reminder tick failed";
      return { status: "failed", error: state.lastError };
    }
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
      lastTickAt: state.lastTickAt,
      lastStatus: state.lastStatus,
      lastEnqueuedCount: state.lastEnqueuedCount,
      lastError: state.lastError,
    };
  }

  return Object.freeze({ start, stop, runOnce, status });
}
