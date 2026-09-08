import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { withImmediateTransaction } from "../db/transaction.js";

function required(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}
function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}
function map(row) {
  if (!row) return null;
  return {
    id: row.id, owner: row.owner, suggestionId: row.suggestion_id, suggestionVersion: Number(row.suggestion_version),
    channel: row.channel, status: row.status, title: row.title, trigger: row.trigger,
    priority: Number(row.priority), summary: row.summary, outboxId: row.outbox_id,
    attemptCount: Number(row.attempt_count), availableAt: row.available_at,
    lastErrorCode: row.last_error_code, deliveryStartedAt: row.delivery_started_at, sentAt: row.sent_at, readAt: row.read_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createProactiveNotificationRepository(db, { clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!db?.prepare) throw new TypeError("A synchronous SQLite connection is required");
  const byId = db.prepare("SELECT * FROM proactive_notifications WHERE id = $id AND owner = $owner");

  function ensure({ owner, suggestion, availableAt = null } = {}) {
    const normalizedOwner = required(owner, "owner", 200);
    if (!suggestion || typeof suggestion !== "object") throw new TypeError("suggestion is required");
    const suggestionId = required(suggestion.id, "suggestionId", 500);
    const version = Number(suggestion.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("suggestionVersion is invalid");
    const timestamp = nowIso(clock);
    const due = availableAt ? new Date(availableAt).toISOString() : timestamp;
    const title = required(suggestion.title, "title", 200);
    const trigger = required(suggestion.trigger, "trigger", 100);
    const priority = Number.isSafeInteger(suggestion.priority) ? Math.min(100, Math.max(0, suggestion.priority)) : 0;
    return withImmediateTransaction(db, () => {
      const existing = db.prepare(`SELECT * FROM proactive_notifications
        WHERE owner=$owner AND suggestion_id=$suggestionId AND suggestion_version=$version`).get({
        $owner: normalizedOwner, $suggestionId: suggestionId, $version: version,
      });
      if (existing) return { item: map(existing), replayed: true };
      const id = required(idFactory(), "notification id", 200);
      db.prepare(`INSERT INTO proactive_notifications
        (id, owner, suggestion_id, suggestion_version, channel, status, title, trigger, priority,
         summary, available_at, created_at, updated_at)
        VALUES ($id,$owner,$suggestionId,$version,'in_app','queued',$title,$trigger,$priority,
                $summary,$due,$now,$now)`).run({
        $id: id, $owner: normalizedOwner, $suggestionId: suggestionId, $version: version,
        $title: title, $trigger: trigger, $priority: priority, $summary: title, $due: due, $now: timestamp,
      });
      return { item: map(byId.get({ $id: id, $owner: normalizedOwner })), replayed: false };
    });
  }

  function claimDue({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit is invalid");
    const now = nowIso(clock);
    return db.prepare(`SELECT * FROM proactive_notifications
      WHERE status='queued' AND outbox_id IS NULL AND available_at <= $now
      ORDER BY priority DESC, created_at ASC LIMIT $limit`).all({ $now: now, $limit: limit }).map(map);
  }

  function setDelivery(idValue, { owner, channel, outboxId = null, status = "queued", errorCode = null } = {}) {
    const id = required(idValue, "id", 200); const normalizedOwner = required(owner, "owner", 200);
    if (!["in_app", "weixin"].includes(channel)) throw new TypeError("channel is invalid");
    if (!["queued", "processing", "sent", "failed"].includes(status)) throw new TypeError("status is invalid");
    const now = nowIso(clock);
    db.prepare(`UPDATE proactive_notifications SET channel=$channel,status=$status,outbox_id=$outboxId,
      delivery_started_at=CASE WHEN $channel='weixin' THEN COALESCE(delivery_started_at,$now) ELSE delivery_started_at END,
      attempt_count=attempt_count+CASE WHEN $status IN ('processing','failed') THEN 1 ELSE 0 END,
      last_error_code=$errorCode,sent_at=CASE WHEN $status='sent' THEN $now ELSE sent_at END,updated_at=$now
      WHERE id=$id AND owner=$owner AND status <> 'read'`).run({
      $id: id, $owner: normalizedOwner, $channel: channel,
      $outboxId: outboxId ? required(outboxId, "outboxId", 200) : null,
      $status: status, $errorCode: errorCode ? required(errorCode, "errorCode", 100) : null, $now: now,
    });
    return map(byId.get({ $id: id, $owner: normalizedOwner }));
  }

  function defer(idValue, { owner, availableAt, errorCode } = {}) {
    const id = required(idValue, "id", 200); const normalizedOwner = required(owner, "owner", 200);
    const due = new Date(availableAt); if (Number.isNaN(due.getTime())) throw new TypeError("availableAt is invalid");
    const now = nowIso(clock);
    db.prepare(`UPDATE proactive_notifications SET available_at=$due,last_error_code=$error,updated_at=$now
      WHERE id=$id AND owner=$owner AND status='queued'`).run({
      $id: id, $owner: normalizedOwner, $due: due.toISOString(),
      $error: errorCode ? required(errorCode, "errorCode", 100) : null, $now: now,
    });
    return map(byId.get({ $id: id, $owner: normalizedOwner }));
  }

  function recordFailure(idValue, { owner, channel, errorCode, retryBaseMs = 60_000, maxAttempts = 5 } = {}) {
    const id = required(idValue, "id", 200); const normalizedOwner = required(owner, "owner", 200);
    if (channel !== "weixin") throw new TypeError("channel is invalid");
    const current = byId.get({ $id: id, $owner: normalizedOwner });
    if (!current) throw new HttpError(404, "PROACTIVE_NOTIFICATION_NOT_FOUND", "The proactive notification was not found");
    const attempt = current.status === "processing"
      ? Math.max(1, Number(current.attempt_count))
      : Number(current.attempt_count) + 1;
    const terminal = attempt >= maxAttempts;
    const now = nowIso(clock);
    const available = new Date(Date.parse(now) + retryBaseMs * (2 ** Math.min(attempt - 1, 8))).toISOString();
    db.prepare(`UPDATE proactive_notifications SET channel=$channel,status=$status,attempt_count=$attempt,
      available_at=$available,last_error_code=$error,updated_at=$now WHERE id=$id AND owner=$owner AND status<>'read'`).run({
      $id: id, $owner: normalizedOwner, $channel: channel, $status: terminal ? "failed" : "queued",
      $attempt: attempt, $available: available, $error: required(errorCode,"errorCode",100), $now: now,
    });
    return map(byId.get({ $id: id, $owner: normalizedOwner }));
  }

  function syncOutbox() {
    const now = nowIso(clock);
    const changed = db.prepare(`UPDATE proactive_notifications AS notification SET
      status=(SELECT status FROM weixin_confirmation_outbox WHERE id=notification.outbox_id),
      attempt_count=(SELECT attempt_count FROM weixin_confirmation_outbox WHERE id=notification.outbox_id),
      last_error_code=(SELECT last_error_code FROM weixin_confirmation_outbox WHERE id=notification.outbox_id),
      sent_at=(SELECT sent_at FROM weixin_confirmation_outbox WHERE id=notification.outbox_id),updated_at=$now
      WHERE channel='weixin' AND outbox_id IS NOT NULL AND status <> 'read'
        AND EXISTS (SELECT 1 FROM weixin_confirmation_outbox outbox WHERE outbox.id=notification.outbox_id
          AND (outbox.status<>notification.status OR outbox.attempt_count<>notification.attempt_count
            OR COALESCE(outbox.last_error_code,'')<>COALESCE(notification.last_error_code,'')))`).run({ $now: now });
    return Number(changed.changes);
  }

  function list({ owner, limit = 50, offset = 0 } = {}) {
    const normalizedOwner = required(owner, "owner", 200);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError("pagination is invalid");
    syncOutbox();
    return db.prepare(`SELECT * FROM proactive_notifications WHERE owner=$owner
      ORDER BY created_at DESC,id DESC LIMIT $limit OFFSET $offset`).all({ $owner: normalizedOwner, $limit: limit, $offset: offset }).map(map);
  }
  function count({ owner } = {}) {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM proactive_notifications WHERE owner=$owner").get({ $owner: required(owner,"owner",200) }).count);
  }
  function statusCounts({ owner = null } = {}) {
    syncOutbox();
    const normalizedOwner = owner === null ? null : required(owner,"owner",200);
    const counts = { queued: 0, processing: 0, sent: 0, failed: 0, read: 0 };
    const rows = db.prepare(`SELECT status,COUNT(*) AS count FROM proactive_notifications
      WHERE ($owner IS NULL OR owner=$owner) GROUP BY status`).all({ $owner: normalizedOwner });
    for (const row of rows) if (Object.hasOwn(counts,row.status)) counts[row.status]=Number(row.count);
    const unread = Number(db.prepare(`SELECT COUNT(*) AS count FROM proactive_notifications
      WHERE ($owner IS NULL OR owner=$owner) AND read_at IS NULL`).get({ $owner: normalizedOwner }).count);
    return { ...counts, unread, total: Object.values(counts).reduce((sum,value)=>sum+value,0) };
  }
  function rateLimitUntil({ owner, at = null, hourlyLimit = 3, dailyLimit = 12 } = {}) {
    const normalizedOwner = required(owner,"owner",200);
    const now = at ? new Date(at) : new Date(nowIso(clock));
    if (Number.isNaN(now.getTime())) throw new TypeError("at is invalid");
    const rows = db.prepare(`SELECT delivery_started_at FROM proactive_notifications
      WHERE owner=$owner AND delivery_started_at IS NOT NULL AND delivery_started_at > $dayAgo
      ORDER BY delivery_started_at ASC`).all({ $owner: normalizedOwner, $dayAgo: new Date(now.getTime()-24*60*60*1000).toISOString() });
    if (rows.length >= dailyLimit) return new Date(Date.parse(rows[0].delivery_started_at)+24*60*60*1000);
    const hourly = rows.filter((row) => Date.parse(row.delivery_started_at) > now.getTime()-60*60*1000);
    if (hourly.length >= hourlyLimit) return new Date(Date.parse(hourly[0].delivery_started_at)+60*60*1000);
    return null;
  }
  function markRead(idValue, { owner } = {}) {
    const id = required(idValue, "id", 200); const normalizedOwner = required(owner, "owner", 200); const now = nowIso(clock);
    const result = db.prepare(`UPDATE proactive_notifications SET status='read',read_at=COALESCE(read_at,$now),updated_at=$now
      WHERE id=$id AND owner=$owner`).run({ $id: id, $owner: normalizedOwner, $now: now });
    if (!result.changes) throw new HttpError(404, "PROACTIVE_NOTIFICATION_NOT_FOUND", "The proactive notification was not found");
    return map(byId.get({ $id: id, $owner: normalizedOwner }));
  }
  function getBySuggestion({ owner, suggestionId, suggestionVersion } = {}) {
    return map(db.prepare(`SELECT * FROM proactive_notifications WHERE owner=$owner AND suggestion_id=$id AND suggestion_version=$version`).get({
      $owner: required(owner,"owner",200), $id: required(suggestionId,"suggestionId",500), $version: suggestionVersion,
    }));
  }
  function getByOutboxId(outboxId) {
    return map(db.prepare("SELECT * FROM proactive_notifications WHERE outbox_id=$id").get({ $id: required(outboxId,"outboxId",200) }));
  }
  return Object.freeze({ ensure, claimDue, setDelivery, defer, recordFailure, syncOutbox, list, count, statusCounts, rateLimitUntil, markRead, getBySuggestion, getByOutboxId });
}
