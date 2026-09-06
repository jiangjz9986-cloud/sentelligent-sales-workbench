import { proactiveNotificationPayload } from "./proactiveNotificationMessage.js";

const TERMINAL = new Set(["dismissed", "ignored", "resolved", "confirmed", "executed", "expired", "failed"]);

function date(clock) { const value = clock(); const result = value instanceof Date ? value : new Date(value); if (Number.isNaN(result.getTime())) throw new TypeError("clock invalid"); return result; }
function shanghaiParts(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return values;
}
function quietEnd(now, startHour, endHour, startMinute = 0, endMinute = 0) {
  const local = shanghaiParts(now);
  const current = local.hour * 60 + local.minute;
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) return null;
  const quiet = start > end ? current >= start || current < end : current >= start && current < end;
  if (!quiet) return null;
  const nextDay = start > end && current >= start ? 1 : 0;
  return new Date(Date.UTC(local.year, local.month - 1, local.day + nextDay, endHour - 8, endMinute, 0, 0));
}

export function createProactiveNotificationScheduler({
  db = null,
  suggestionRepository, notificationRepository, outboxRepository,
  resolveDeliveries = () => [],
  // A PushPlus sender is only accepted when the caller resolves a sender for
  // this exact owner.  The old global `pushplusNotify`/`pushplusReady` pair is
  // intentionally not supported here: a single global token cannot prove
  // which account should receive a proactive suggestion.
  resolvePushplusDelivery = null,
  clock = () => new Date(), pollMs = 60_000, quietStartHour = 22, quietStartMinute = 0, quietEndHour = 8, quietEndMinute = 0,
  hourlyLimit = 3, dailyLimit = 12, batchLimit = 20,
} = {}) {
  if (!suggestionRepository?.list || !notificationRepository?.ensure || !outboxRepository?.enqueue) throw new TypeError("repositories are required");
  if (resolvePushplusDelivery !== null && typeof resolvePushplusDelivery !== "function") throw new TypeError("resolvePushplusDelivery must be a function");
  if (![quietStartHour, quietEndHour].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 23)
    || ![quietStartMinute, quietEndMinute].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 59)) throw new TypeError("quiet hours are invalid");
  if (![hourlyLimit, dailyLimit, batchLimit, pollMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError("notification limits are invalid");
  let timer = null; let running = null;
  const state = { lastTickAt: null, lastStatus: "idle", lastError: null, lastResult: null };

  // The legacy action-reminder scheduler and this scheduler share the same
  // WeChat outbox, but they use different idempotency namespaces. For an
  // action_due suggestion, resolve the current action reminder timestamp and
  // inspect the legacy key before choosing any external channel. The
  // proactive row remains visible in the in-app ledger; this only prevents a
  // second external message for the same owner/action/reminder period.
  let selectActionReminder = null;
  if (db && typeof db.prepare === "function") {
    try {
      selectActionReminder = db.prepare(`SELECT id, remind_at FROM action_items
          WHERE id = $id AND owner = $owner AND deleted_at IS NULL`);
    } catch {
      // Keep the scheduler compatible with lightweight callers that provide
      // repository doubles or an older database without action reminders.
      // The normal migrated server has this table and takes the dedupe path.
      selectActionReminder = null;
    }
  }
  function actionReminderAlreadyExternal({ owner, suggestion }) {
    const trigger = typeof suggestion?.trigger === "string"
      ? suggestion.trigger
      : suggestion?.trigger?.type;
    if (trigger !== "action_due" || !selectActionReminder || typeof outboxRepository.hasKey !== "function") return false;
    const refs = [
      ...(Array.isArray(suggestion?.sourceRefs) ? suggestion.sourceRefs : []),
      ...(Array.isArray(suggestion?.evidenceRefs) ? suggestion.evidenceRefs : []),
    ];
    const actionIds = [...new Set(refs
      .filter((ref) => ref && (ref.type === "action_item" || ref.type === "action") && typeof ref.id === "string")
      .map((ref) => ref.id.trim())
      .filter(Boolean))];
    for (const actionId of actionIds) {
      const action = selectActionReminder.get({ $id: actionId, $owner: owner });
      const remindAtMs = action?.remind_at ? Date.parse(action.remind_at) : Number.NaN;
      if (!Number.isFinite(remindAtMs)) continue;
      const idempotencyKey = `action-reminder:${owner}:${actionId}:${remindAtMs}`;
      if (outboxRepository.hasKey({ owner, idempotencyKey })) return true;
    }
    return false;
  }
  async function runTick() {
    notificationRepository.syncOutbox();
    notificationRepository.recoverStalePushplus?.();
    // Discover all owners from pending proactive rows without widening content scope.
    const owners = suggestionRepository.listOwners?.() ?? [];
    for (const owner of owners) {
      for (let offset = 0; offset < 10_000; offset += 100) {
        const page = suggestionRepository.list({ owner, status: "pending", limit: 100, offset });
        for (const suggestion of page) notificationRepository.ensure({ owner, suggestion });
        if (page.length < 100) break;
      }
    }
    const now = date(clock);
    let queued = 0; let sent = 0; let externalSent = 0; let inAppDelivered = 0; let failed = 0; let deferred = 0;
    for (const item of notificationRepository.claimDue({ limit: batchLimit })) {
      const suggestion = suggestionRepository.get(item.suggestionId, { owner: item.owner });
      if (!suggestion || suggestion.version !== item.suggestionVersion || TERMINAL.has(suggestion.status) || suggestion.status !== "pending") {
        notificationRepository.setDelivery(item.id, { owner: item.owner, channel: "in_app", status: "failed", errorCode: "PROACTIVE_NOTIFICATION_STALE" });
        failed += 1; continue;
      }
      const delivery = resolveDeliveries().find((target) => target.account === item.owner);
      let pushplus = null;
      if (!delivery && resolvePushplusDelivery) {
        try {
          const resolved = resolvePushplusDelivery({ owner: item.owner });
          if (resolved && typeof resolved.notify === "function"
            && (resolved.ready === undefined || resolved.ready() === true)) {
            pushplus = resolved;
          }
        } catch {
          // A sender resolver is an optional, owner-scoped integration.  A
          // resolver failure must leave the durable in-app notification intact
          // rather than widening delivery to a global token.
          pushplus = null;
        }
      }
      const canPushplus = !delivery && Boolean(pushplus);
      if (!delivery && !canPushplus) {
        // The durable row itself is the in-app delivery. It is immediate and
        // is not throttled by external-channel quiet hours or rate limits.
        notificationRepository.setDelivery(item.id, { owner: item.owner, channel: "in_app", status: "sent" });
        sent += 1; inAppDelivered += 1; continue;
      }
      // action_due is deliberately still delivered to the in-app ledger, but
      // the existing action-reminder outbox entry wins for external delivery
      // when it covers this exact owner/action/reminder period.
      if (actionReminderAlreadyExternal({ owner: item.owner, suggestion })) {
        notificationRepository.setDelivery(item.id, {
          owner: item.owner,
          channel: "in_app",
          status: "sent",
          errorCode: "ACTION_REMINDER_EXTERNAL_DEDUPED",
        });
        sent += 1;
        inAppDelivered += 1;
        continue;
      }
      const nextQuiet = quietEnd(now, quietStartHour, quietEndHour, quietStartMinute, quietEndMinute);
      const nextRate = notificationRepository.rateLimitUntil({ owner: item.owner, at: now, hourlyLimit, dailyLimit });
      if (nextQuiet || nextRate) {
        notificationRepository.defer(item.id, { owner: item.owner, availableAt: (nextQuiet && nextRate ? (nextQuiet > nextRate ? nextQuiet : nextRate) : nextQuiet ?? nextRate), errorCode: nextQuiet ? "QUIET_HOURS" : "RATE_LIMITED" });
        deferred += 1; continue;
      }
      const payload = proactiveNotificationPayload(suggestion);
      if (delivery) {
        try {
          const outbox = outboxRepository.enqueue({ owner: item.owner, conversationId: delivery.conversationId,
            idempotencyKey: `proactive-suggestion:${item.suggestionId}:v${item.suggestionVersion}`, payload });
          notificationRepository.setDelivery(item.id, { owner: item.owner, channel: "weixin", outboxId: outbox.id, status: outbox.status });
          queued += 1;
        } catch {
          const state = notificationRepository.recordFailure(item.id, { owner: item.owner, channel: "weixin", errorCode: "WEIXIN_OUTBOX_FAILED" });
          if (state.status === "failed") failed += 1; else deferred += 1;
        }
      } else if (canPushplus) {
        try {
          notificationRepository.setDelivery(item.id, { owner: item.owner, channel: "pushplus", status: "processing" });
          await pushplus.notify({ title: `主动建议：${payload.title}`, content: `${payload.summary}\n建议编号：${payload.suggestionId}` });
          notificationRepository.setDelivery(item.id, { owner: item.owner, channel: "pushplus", status: "sent" });
          sent += 1;
          externalSent += 1;
        } catch {
          const state = notificationRepository.recordFailure(item.id, { owner: item.owner, channel: "pushplus", errorCode: "PUSHPLUS_SEND_FAILED" });
          if (state.status === "failed") failed += 1; else deferred += 1;
        }
      }
    }
    return { queued, sent, externalSent, inAppDelivered, failed, deferred };
  }
  async function tick() {
    state.lastTickAt = date(clock).toISOString();
    state.lastStatus = "running"; state.lastError = null;
    try {
      const result = await runTick();
      state.lastStatus = result.failed > 0 ? "partial" : "success";
      state.lastResult = result;
      return result;
    } catch (error) {
      state.lastStatus = "failed";
      state.lastError = String(error?.code ?? error?.message ?? "notification_tick_failed").slice(0,100);
      throw error;
    }
  }
  function start() { if (timer) return; timer = setInterval(() => { if (!running) running = tick().catch(() => null).finally(() => { running = null; }); }, pollMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() { return { running: Boolean(timer), ticking: Boolean(running), pollMs,
    quietStart: `${String(quietStartHour).padStart(2,"0")}:${String(quietStartMinute).padStart(2,"0")}`,
    quietEnd: `${String(quietEndHour).padStart(2,"0")}:${String(quietEndMinute).padStart(2,"0")}`,
    hourlyLimit, dailyLimit, batchLimit, ...state }; }
  return Object.freeze({ tick, start, stop, status });
}
