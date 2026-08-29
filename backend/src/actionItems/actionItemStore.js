import { HttpError } from "../http/errors.js";

// Owner-scoped action-item (todo) read/write module (v0.7.5). The WeChat
// assistant handlers consume these helpers; the web PATCH/DELETE routes keep
// their existing generic paths. Auditing stays with the callers (same
// decision as customers/customerStore.js and quickRecords/quickRecordStore.js).

const ID_SUFFIX = /^[A-Za-z0-9-]{6,64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const OPEN_STATUSES = Object.freeze(["pending", "in_progress", "deferred"]);
const PRIORITIES = new Set(["高", "中", "低"]);

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function requiredVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
  return version;
}

function normalizedInstant(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid instant`);
  const iso = parsed.toISOString();
  if (!ISO_INSTANT.test(iso)) throw new TypeError(`${name} must be a valid instant`);
  return iso;
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

function actionItemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    owner: row.owner ?? null,
    customerId: row.customer_id ?? null,
    opportunityId: row.opportunity_id ?? null,
    customerName: row.customer_name ?? row.customer ?? null,
    title: row.title,
    reason: row.reason ?? null,
    due: row.due ?? null,
    assignee: row.assignee ?? null,
    priority: row.priority ?? "中",
    status: row.status,
    remindAt: row.remind_at ?? null,
    remindedAt: row.reminded_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mutationFailure(db, id) {
  const current = db.prepare("SELECT version, deleted_at FROM action_items WHERE id = $id").get({ $id: id });
  if (!current || current.deleted_at) {
    throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
  }
  throw new HttpError(409, "VERSION_CONFLICT", "The action item was updated by another request", {
    currentVersion: Number(current.version),
  });
}

// v0.9.2 收紧：0031 全量回填后 owner 恒非空，读写可见性统一收敛为单一 owner
// 列谓词（与 businessSnapshotAdapter.actionRows 一致，对 jiangjz 结果集恒等）。
// 客户名 join 仅为展示列保留。
const VISIBILITY_CLAUSE = `
  action.owner = $owner
`;

const VISIBILITY_JOINS = `
  LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
`;

export function createActionItemStore(db, { clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const selectVisible = db.prepare(`
    SELECT action.*, action_customer.name AS customer_name
    FROM action_items action
    ${VISIBILITY_JOINS}
    WHERE action.id = $id AND action.deleted_at IS NULL AND ${VISIBILITY_CLAUSE}
  `);

  function getVisible({ owner, id }) {
    const row = selectVisible.get({ $owner: requiredText(owner, "owner", 200), $id: requiredText(id, "id", 200) });
    return actionItemFromRow(row);
  }

  function create({ owner, title, reason, due, remindAt, priority, customerId, customerName, opportunityId, id }) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedTitle = requiredText(title, "title", 80);
    const normalizedPriority = optionalText(priority, "priority", 4) ?? "中";
    if (!PRIORITIES.has(normalizedPriority)) throw new TypeError("priority is invalid");
    const normalizedRemindAt = normalizedInstant(remindAt, "remindAt");
    const normalizedId = requiredText(id, "id", 200);
    db.prepare(`
      INSERT INTO action_items (
        id, customer_id, opportunity_id, title, customer, reason, due, assignee,
        priority, status, source_record_id, tone, owner, remind_at, reminded_at
      ) VALUES (
        $id, $customerId, $opportunityId, $title, $customerName, $reason, $due, $assignee,
        $priority, 'pending', NULL, $tone, $owner, $remindAt, NULL
      )
    `).run({
      $id: normalizedId,
      $customerId: optionalText(customerId, "customerId", 200),
      $opportunityId: optionalText(opportunityId, "opportunityId", 200),
      $title: normalizedTitle,
      $customerName: optionalText(customerName, "customerName", 200),
      $reason: optionalText(reason, "reason", 500),
      $due: optionalText(due, "due", 50),
      $assignee: normalizedOwner,
      $priority: normalizedPriority,
      $tone: normalizedPriority === "高" ? "red" : "blue",
      $owner: normalizedOwner,
      $remindAt: normalizedRemindAt,
    });
    return getVisible({ owner: normalizedOwner, id: normalizedId });
  }

  function list({ owner, dateStart, dateEnd, statuses = OPEN_STATUSES, limit = 9 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const statusList = Array.isArray(statuses) && statuses.length > 0 ? statuses : OPEN_STATUSES;
    for (const status of statusList) requiredText(status, "status", 40);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 9, 50));
    const startIso = dateStart ? normalizedInstant(new Date(`${dateStart}T00:00:00+08:00`), "dateStart") : null;
    const endIso = dateEnd
      ? normalizedInstant(new Date(new Date(`${dateEnd}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000), "dateEnd")
      : null;
    const rows = db.prepare(`
      SELECT action.*, action_customer.name AS customer_name
      FROM action_items action
      ${VISIBILITY_JOINS}
      WHERE action.deleted_at IS NULL
        AND action.status IN (${statusList.map((_, index) => `$status${index}`).join(", ")})
        AND ${VISIBILITY_CLAUSE}
        AND ($startIso IS NULL OR (action.remind_at IS NOT NULL AND action.remind_at >= $startIso))
        AND ($endIso IS NULL OR (action.remind_at IS NOT NULL AND action.remind_at < $endIso))
      ORDER BY action.remind_at IS NULL, action.remind_at ASC,
        CASE action.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, action.updated_at DESC
      LIMIT ${boundedLimit + 1}
    `).all({
      $owner: normalizedOwner,
      $startIso: startIso,
      $endIso: endIso,
      ...Object.fromEntries(statusList.map((status, index) => [`$status${index}`, status])),
    });
    return {
      items: rows.slice(0, boundedLimit).map(actionItemFromRow),
      truncated: rows.length > boundedLimit,
    };
  }

  function findByIdSuffix({ owner, suffix }) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedSuffix = requiredText(suffix, "suffix", 64);
    if (!ID_SUFFIX.test(normalizedSuffix)) return { matches: [] };
    const rows = db.prepare(`
      SELECT action.*, action_customer.name AS customer_name
      FROM action_items action
      ${VISIBILITY_JOINS}
      WHERE action.deleted_at IS NULL AND ${VISIBILITY_CLAUSE}
        AND action.id LIKE $pattern ESCAPE '\\'
      ORDER BY action.updated_at DESC
      LIMIT 6
    `).all({ $owner: normalizedOwner, $pattern: `%${normalizedSuffix.replace(/[\\%_]/gu, "\\$&")}` });
    return { matches: rows.map(actionItemFromRow) };
  }

  function findByTitleQuery({ owner, query }) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedQuery = requiredText(query, "query", 80);
    const rows = db.prepare(`
      SELECT action.*, action_customer.name AS customer_name
      FROM action_items action
      ${VISIBILITY_JOINS}
      WHERE action.deleted_at IS NULL AND ${VISIBILITY_CLAUSE}
        AND action.status IN ('pending', 'in_progress', 'deferred')
        AND action.title LIKE $pattern ESCAPE '\\'
      ORDER BY action.updated_at DESC
      LIMIT 6
    `).all({ $owner: normalizedOwner, $pattern: likePattern(normalizedQuery) });
    return { matches: rows.map(actionItemFromRow) };
  }

  function writableBefore({ owner, id }) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedId = requiredText(id, "id", 200);
    const row = db.prepare(`
      SELECT action.*, action_customer.name AS customer_name
      FROM action_items action
      LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
      WHERE action.id = $id AND action.deleted_at IS NULL AND action.owner = $owner
    `).get({ $id: normalizedId, $owner: normalizedOwner });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    return actionItemFromRow(row);
  }

  function complete({ owner, id, expectedVersion }) {
    const before = writableBefore({ owner, id });
    const version = requiredVersion(expectedVersion);
    const result = db.prepare(`
      UPDATE action_items
      SET status = 'done', version = version + 1, updated_at = $now
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL AND version = $version
    `).run({ $id: before.id, $owner: before.owner, $version: version, $now: clock().toISOString() });
    if (result.changes !== 1) mutationFailure(db, before.id);
    return { before, after: writableBefore({ owner, id: before.id }) };
  }

  function defer({ owner, id, expectedVersion, remindAt, due }) {
    const before = writableBefore({ owner, id });
    const version = requiredVersion(expectedVersion);
    const normalizedRemindAt = normalizedInstant(remindAt, "remindAt");
    if (!normalizedRemindAt) throw new TypeError("remindAt is required");
    const result = db.prepare(`
      UPDATE action_items
      SET remind_at = $remindAt, due = $due, reminded_at = NULL, status = 'pending',
          version = version + 1, updated_at = $now
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL AND version = $version
    `).run({
      $id: before.id,
      $owner: before.owner,
      $version: version,
      $remindAt: normalizedRemindAt,
      $due: optionalText(due, "due", 50) ?? before.due,
      $now: clock().toISOString(),
    });
    if (result.changes !== 1) mutationFailure(db, before.id);
    return { before, after: writableBefore({ owner, id: before.id }) };
  }

  function softDelete({ owner, id, expectedVersion, deletedBy }) {
    const before = writableBefore({ owner, id });
    const version = requiredVersion(expectedVersion);
    const result = db.prepare(`
      UPDATE action_items
      SET deleted_at = $now, deleted_by = $deletedBy, version = version + 1, updated_at = $now
      WHERE id = $id AND owner = $owner AND deleted_at IS NULL AND version = $version
    `).run({
      $id: before.id,
      $owner: before.owner,
      $version: version,
      $deletedBy: requiredText(deletedBy, "deletedBy", 200),
      $now: clock().toISOString(),
    });
    if (result.changes !== 1) mutationFailure(db, before.id);
    const row = db.prepare("SELECT * FROM action_items WHERE id = $id").get({ $id: before.id });
    return { before, after: { ...actionItemFromRow(row), deletedAt: row.deleted_at, deletedBy: row.deleted_by } };
  }

  function dueReminders({ owner, now, limit = 20 } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const nowIso = normalizedInstant(now ?? clock(), "now");
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const rows = db.prepare(`
      SELECT action.*, action_customer.name AS customer_name
      FROM action_items action
      LEFT JOIN customers action_customer ON action_customer.id = action.customer_id AND action_customer.deleted_at IS NULL
      WHERE action.remind_at IS NOT NULL AND action.reminded_at IS NULL
        AND action.deleted_at IS NULL AND action.status IN ('pending', 'in_progress')
        AND action.remind_at <= $now AND action.owner = $owner
      ORDER BY action.remind_at ASC
      LIMIT ${boundedLimit}
    `).all({ $now: nowIso, $owner: normalizedOwner });
    return rows.map(actionItemFromRow);
  }

  function markReminded({ id, now }) {
    const result = db.prepare(`
      UPDATE action_items SET reminded_at = $now, updated_at = $now
      WHERE id = $id AND reminded_at IS NULL
    `).run({ $id: requiredText(id, "id", 200), $now: normalizedInstant(now ?? clock(), "now") });
    return { marked: result.changes === 1 };
  }

  return Object.freeze({
    create,
    list,
    getVisible,
    findByIdSuffix,
    findByTitleQuery,
    complete,
    defer,
    softDelete,
    dueReminders,
    markReminded,
  });
}

export { actionItemFromRow };
