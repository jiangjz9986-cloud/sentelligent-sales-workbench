import { randomUUID } from "node:crypto";

const STATUSES = new Set(["planned", "completed", "cancelled"]);

export class ItineraryNotFoundError extends Error {
  constructor() {
    super("Visit itinerary was not found");
    this.name = "ItineraryNotFoundError";
    this.code = "NOT_FOUND";
  }
}

export class ItineraryVersionConflictError extends Error {
  constructor(currentVersion) {
    super("Visit itinerary was updated by another request");
    this.name = "ItineraryVersionConflictError";
    this.code = "VERSION_CONFLICT";
    this.currentVersion = currentVersion;
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function normalizeStatus(value) {
  const status = value ?? "planned";
  if (!STATUSES.has(status)) throw new TypeError("status is invalid");
  return status;
}

function normalizeVisitDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("visitDate must use YYYY-MM-DD format");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError("visitDate must be a real calendar date");
  }
  return value;
}

function snapshotJson(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
  return value;
}

function timestamp(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value.toISOString();
}

function fromRow(row) {
  if (!row) return null;
  const item = {
    id: row.id,
    version: Number(row.version),
    title: row.title,
    visitDate: row.visit_date,
    status: row.status,
    request: JSON.parse(row.request_json),
    plan: JSON.parse(row.plan_json),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.deleted_at) {
    item.deletedAt = row.deleted_at;
    item.deletedBy = row.deleted_by;
  }
  return item;
}

function mutationFailure(db, id) {
  const current = db.prepare(
    "SELECT version, deleted_at FROM visit_itineraries WHERE id = $id",
  ).get({ $id: id });
  if (!current || current.deleted_at) throw new ItineraryNotFoundError();
  throw new ItineraryVersionConflictError(Number(current.version));
}

export function createVisitItineraryRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const getActive = db.prepare(
    "SELECT * FROM visit_itineraries WHERE id = $id AND deleted_at IS NULL",
  );
  const getAny = db.prepare("SELECT * FROM visit_itineraries WHERE id = $id");

  function get(id) {
    return fromRow(getActive.get({ $id: requiredText(id, "id") }));
  }

  function list({ status } = {}) {
    const normalizedStatus = status === undefined || status === null || status === ""
      ? null
      : normalizeStatus(status);
    const rows = normalizedStatus
      ? db.prepare(`
          SELECT * FROM visit_itineraries
          WHERE deleted_at IS NULL AND status = $status
          ORDER BY visit_date DESC, updated_at DESC, id ASC
        `).all({ $status: normalizedStatus })
      : db.prepare(`
          SELECT * FROM visit_itineraries
          WHERE deleted_at IS NULL
          ORDER BY visit_date DESC, updated_at DESC, id ASC
        `).all();
    return rows.map(fromRow);
  }

  function create(input = {}) {
    const id = requiredText(idFactory(), "generated itinerary id");
    const actor = requiredText(input.actor, "actor");
    const now = timestamp(clock);
    const params = {
      $id: id,
      $title: requiredText(input.title, "title"),
      $visitDate: normalizeVisitDate(input.visitDate),
      $status: normalizeStatus(input.status),
      $requestJson: snapshotJson(input.request, "request"),
      $planJson: snapshotJson(input.plan, "plan"),
      $actor: actor,
      $now: now,
    };
    db.prepare(`
      INSERT INTO visit_itineraries (
        id, title, visit_date, status, request_json, plan_json,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        $id, $title, $visitDate, $status, $requestJson, $planJson,
        $actor, $actor, $now, $now
      )
    `).run(params);
    return fromRow(getAny.get({ $id: id }));
  }

  function update(id, input = {}) {
    const itineraryId = requiredText(id, "id");
    const actor = requiredText(input.actor, "actor");
    const version = expectedVersion(input.expectedVersion);
    const now = timestamp(clock);
    const result = db.prepare(`
      UPDATE visit_itineraries
      SET title = $title,
          visit_date = $visitDate,
          status = $status,
          request_json = $requestJson,
          plan_json = $planJson,
          updated_by = $actor,
          updated_at = $now,
          version = version + 1
      WHERE id = $id
        AND version = $expectedVersion
        AND deleted_at IS NULL
    `).run({
      $id: itineraryId,
      $expectedVersion: version,
      $title: requiredText(input.title, "title"),
      $visitDate: normalizeVisitDate(input.visitDate),
      $status: normalizeStatus(input.status),
      $requestJson: snapshotJson(input.request, "request"),
      $planJson: snapshotJson(input.plan, "plan"),
      $actor: actor,
      $now: now,
    });
    if (result.changes !== 1) mutationFailure(db, itineraryId);
    return fromRow(getAny.get({ $id: itineraryId }));
  }

  function softDelete(id, { expectedVersion: versionValue, actor: actorValue } = {}) {
    const itineraryId = requiredText(id, "id");
    const actor = requiredText(actorValue, "actor");
    const version = expectedVersion(versionValue);
    const now = timestamp(clock);
    const result = db.prepare(`
      UPDATE visit_itineraries
      SET deleted_at = $now,
          deleted_by = $actor,
          updated_by = $actor,
          updated_at = $now,
          version = version + 1
      WHERE id = $id
        AND version = $expectedVersion
        AND deleted_at IS NULL
    `).run({
      $id: itineraryId,
      $expectedVersion: version,
      $actor: actor,
      $now: now,
    });
    if (result.changes !== 1) mutationFailure(db, itineraryId);
    return fromRow(getAny.get({ $id: itineraryId }));
  }

  return { create, get, list, update, softDelete };
}
