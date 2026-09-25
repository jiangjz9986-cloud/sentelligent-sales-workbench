import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { withImmediateTransaction } from "../db/transaction.js";

const CATEGORIES = new Set(["daily_digest", "action_reminder", "invoice_escalation", "ops_alert", "proactive_assistant"]);

function required(value, name, max, { allowNewlines = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  const controls = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (normalized.length > max || controls.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function normalizeHref(value) {
  const href = required(value, "href", 500);
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) throw new TypeError("href must be an internal path");
  return href;
}

function map(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    category: row.category,
    title: row.title,
    body: row.body,
    href: row.href,
    priority: Number(row.priority),
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
    unread: row.read_at === null,
  };
}

export function createInAppNotificationRepository(db, { clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!db?.prepare) throw new TypeError("A synchronous SQLite connection is required");
  const nowIso = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
    return date.toISOString();
  };

  function ensure(input = {}) {
    const owner = required(input.owner, "owner", 200);
    const category = required(input.category, "category", 40);
    if (!CATEGORIES.has(category)) throw new TypeError("category is invalid");
    const idempotencyKey = required(input.idempotencyKey, "idempotencyKey", 300);
    const title = required(input.title, "title", 200);
    const body = required(input.body, "body", 10_000, { allowNewlines: true });
    const href = normalizeHref(input.href);
    const priority = Number.isSafeInteger(input.priority) ? Math.max(0, Math.min(100, input.priority)) : 0;
    const createdAt = nowIso();
    return withImmediateTransaction(db, () => {
      const existing = db.prepare(`SELECT * FROM in_app_notifications
        WHERE owner = $owner AND idempotency_key = $key`).get({ $owner: owner, $key: idempotencyKey });
      if (existing) return { item: map(existing), replayed: true };
      const id = required(idFactory(), "id", 200);
      db.prepare(`INSERT INTO in_app_notifications
        (id, owner, category, idempotency_key, title, body, href, priority, created_at)
        VALUES ($id, $owner, $category, $key, $title, $body, $href, $priority, $createdAt)`).run({
        $id: id, $owner: owner, $category: category, $key: idempotencyKey,
        $title: title, $body: body, $href: href, $priority: priority, $createdAt: createdAt,
      });
      const item = db.prepare("SELECT * FROM in_app_notifications WHERE id = $id AND owner = $owner")
        .get({ $id: id, $owner: owner });
      return { item: map(item), replayed: false };
    });
  }

  function getByKey({ owner, idempotencyKey } = {}) {
    return db.prepare(`SELECT * FROM in_app_notifications WHERE owner = $owner AND idempotency_key = $key`)
      .get({ $owner: required(owner, "owner", 200), $key: required(idempotencyKey, "idempotencyKey", 300) }) ?? null;
  }

  function list({ owner, limit = 50, offset = 0, unreadOnly = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("pagination is invalid");
    }
    return db.prepare(`SELECT * FROM in_app_notifications
      WHERE owner = $owner AND ($unreadOnly = 0 OR read_at IS NULL)
      ORDER BY created_at DESC, rowid DESC LIMIT $limit OFFSET $offset`).all({
      $owner: required(owner, "owner", 200), $unreadOnly: unreadOnly ? 1 : 0, $limit: limit, $offset: offset,
    }).map(map);
  }

  function count({ owner, unreadOnly = false } = {}) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM in_app_notifications
      WHERE owner = $owner AND ($unreadOnly = 0 OR read_at IS NULL)`).get({
      $owner: required(owner, "owner", 200), $unreadOnly: unreadOnly ? 1 : 0,
    });
    return Number(row.count);
  }

  function markRead(idValue, { owner } = {}) {
    const id = required(idValue, "id", 200);
    const normalizedOwner = required(owner, "owner", 200);
    db.prepare(`UPDATE in_app_notifications SET read_at = COALESCE(read_at, $now)
      WHERE id = $id AND owner = $owner`).run({ $now: nowIso(), $id: id, $owner: normalizedOwner });
    const row = db.prepare("SELECT * FROM in_app_notifications WHERE id = $id AND owner = $owner")
      .get({ $id: id, $owner: normalizedOwner });
    if (!row) throw new HttpError(404, "NOTIFICATION_NOT_FOUND", "The notification was not found");
    return map(row);
  }

  function markAllRead({ owner } = {}) {
    const normalizedOwner = required(owner, "owner", 200);
    const result = db.prepare(`UPDATE in_app_notifications SET read_at = $now
      WHERE owner = $owner AND read_at IS NULL`).run({ $now: nowIso(), $owner: normalizedOwner });
    return Number(result.changes);
  }

  return Object.freeze({ ensure, getByKey, list, count, markRead, markAllRead });
}
