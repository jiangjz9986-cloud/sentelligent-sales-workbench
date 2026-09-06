import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import {
  BRIDGE_STATUSES,
  CANONICAL_NOTICE_ID_MAX,
  NOTICE_BRIDGE_STATUS_UNBRIDGED,
  bridgeFromRow,
  bridgeRefsJson,
  bridgeStatusForRefs,
  canonicalNoticeDigest,
  canonicalNoticeIdentity,
  canonicalNoticeIdentityCandidates,
  contentDigest,
  hospitalTenderBridgeId,
  isSha256,
  normalizeBridgeRef,
  normalizeSha256,
  parseBridgeRefs,
  stableDigest,
} from "./canonicalBridge.js";

export {
  BRIDGE_STATUSES,
  CANONICAL_NOTICE_ID_MAX,
  canonicalNoticeDigest,
  canonicalNoticeIdentity,
  canonicalNoticeIdentityCandidates,
  contentDigest,
  hospitalTenderBridgeId,
};

/**
 * Notice and source values are intentionally finite.  Source adapters should
 * map their upstream vocabulary to one of these values before persistence.
 */
export const NOTICE_TYPES = Object.freeze([
  "tender",
  "procurement_notice",
  "purchase_intent",
  "clarification",
  "bid_result",
  "bid_cancelled",
  "contract_award",
  "qualification",
  "other",
]);

export const RELEVANCE_LEVELS = Object.freeze(["high", "medium", "low"]);

export const SOURCE_HEALTH_STATUSES = Object.freeze([
  "healthy",
  "degraded",
  "error",
  "disabled",
  "unknown",
]);

export const RUN_STATUSES = Object.freeze(["running", "success", "partial", "failed"]);

export const NOTICE_FIELD_LIMITS = Object.freeze({
  id: 200,
  identityKey: 500,
  sourceId: 200,
  sourceName: 200,
  city: 100,
  title: 2000,
  url: 2048,
  publishedAt: 64,
  purchaser: 500,
  projectCode: 300,
  budgetText: 500,
  deadlineText: 500,
  contentText: 20000,
  hospitalName: 200,
  hospitalNames: 50,
  sourceItemId: 300,
  contentSha256: 64,
  customerId: 200,
  matchReason: 200,
  matchedNeeds: 100,
  matchReasonsPerCustomer: 20,
  matchedNeedsPerCustomer: 50,
});

const NOTICE_KEYS = new Set([
  "id",
  "identityKey",
  "sourceId",
  "sourceName",
  "city",
  "title",
  "url",
  "publishedAt",
  "noticeType",
  "purchaser",
  "projectCode",
  "budgetText",
  "deadlineText",
  "contentText",
  "hospitalNames",
  "sourceItemId",
  "contentSha256",
  "relevance",
  "canonicalNoticeId",
  "canonicalId",
  "canonicalIdentity",
]);

const MATCH_KEYS = new Set([
  "matchedCustomerIds",
  "matchReasons",
  "matchedNeeds",
  "matchScore",
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
}

function assertKnownKeys(value, keys, name) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
}

function requiredText(value, name, max) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function enumValue(value, values, name) {
  if (!values.includes(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function dateTime(value, name, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const normalized = requiredText(value, name, NOTICE_FIELD_LIMITS.publishedAt);
  if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function url(value) {
  const normalized = requiredText(value, "url", NOTICE_FIELD_LIMITS.url);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError("url is invalid");
  }
  if (!((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname)) {
    throw new TypeError("url must use http or https");
  }
  // Preserve the source spelling while still parsing it for protocol checks.
  return normalized;
}

function boundedArray(value, name, itemMax, maxItems, { nullable = false } = {}) {
  if ((value === undefined || value === null) && nullable) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maxItems) throw new TypeError(`${name} contains too many items`);
  const result = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const normalized = requiredText(item, `${name}[${index}]`, itemMax);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result;
}

function sha256(value) {
  const normalized = optionalText(value, "contentSha256", NOTICE_FIELD_LIMITS.contentSha256);
  if (normalized === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new TypeError("contentSha256 must be a SHA-256 hex digest");
  return normalized.toLowerCase();
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value.toISOString();
}

function generatedId(idFactory, name, max = NOTICE_FIELD_LIMITS.id) {
  return requiredText(idFactory(), name, max);
}

function jsonValue(value, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${name} contains invalid JSON`);
  }
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = $name",
    ).get({ $name: name }));
  } catch {
    return false;
  }
}

function normalizeMatchMap(value, name, itemMax, maxItems) {
  if (value === undefined || value === null) return {};
  assertPlainObject(value, name);
  const result = {};
  for (const [customerId, rawItems] of Object.entries(value)) {
    const id = requiredText(customerId, `${name} customer id`, NOTICE_FIELD_LIMITS.customerId);
    result[id] = boundedArray(rawItems, `${name}.${id}`, itemMax, maxItems);
  }
  return result;
}

/**
 * Validate and copy an upstream notice into the storage/API snapshot shape.
 * This function has no database, network, or credential dependencies.
 */
export function normalizeNoticeSnapshot(input = {}) {
  assertPlainObject(input, "notice");
  assertKnownKeys(input, NOTICE_KEYS, "notice");

  const id = input.id === undefined || input.id === null || input.id === ""
    ? null
    : requiredText(input.id, "id", NOTICE_FIELD_LIMITS.id);
  const normalized = {
    id,
    identityKey: requiredText(input.identityKey, "identityKey", NOTICE_FIELD_LIMITS.identityKey),
    sourceId: requiredText(input.sourceId, "sourceId", NOTICE_FIELD_LIMITS.sourceId),
    sourceName: requiredText(input.sourceName, "sourceName", NOTICE_FIELD_LIMITS.sourceName),
    city: optionalText(input.city, "city", NOTICE_FIELD_LIMITS.city),
    title: requiredText(input.title, "title", NOTICE_FIELD_LIMITS.title),
    url: url(input.url),
    publishedAt: dateTime(input.publishedAt, "publishedAt"),
    noticeType: enumValue(input.noticeType, NOTICE_TYPES, "noticeType"),
    purchaser: optionalText(input.purchaser, "purchaser", NOTICE_FIELD_LIMITS.purchaser),
    projectCode: optionalText(input.projectCode, "projectCode", NOTICE_FIELD_LIMITS.projectCode),
    budgetText: optionalText(input.budgetText, "budgetText", NOTICE_FIELD_LIMITS.budgetText),
    deadlineText: optionalText(input.deadlineText, "deadlineText", NOTICE_FIELD_LIMITS.deadlineText),
    contentText: optionalText(input.contentText, "contentText", NOTICE_FIELD_LIMITS.contentText),
    hospitalNames: boundedArray(
      input.hospitalNames,
      "hospitalNames",
      NOTICE_FIELD_LIMITS.hospitalName,
      NOTICE_FIELD_LIMITS.hospitalNames,
      { nullable: true },
    ),
    sourceItemId: optionalText(input.sourceItemId, "sourceItemId", NOTICE_FIELD_LIMITS.sourceItemId),
    contentSha256: sha256(input.contentSha256),
    relevance: enumValue(input.relevance, RELEVANCE_LEVELS, "relevance"),
    canonicalNoticeId: optionalText(
      input.canonicalNoticeId ?? input.canonicalId ?? input.canonicalIdentity,
      "canonicalNoticeId",
      CANONICAL_NOTICE_ID_MAX,
    ),
  };
  return normalized;
}

/** Normalize the persisted customer-match sidecar, without customer writes. */
export function normalizeNoticeMatch(input = {}) {
  assertPlainObject(input, "match");
  assertKnownKeys(input, MATCH_KEYS, "match");
  const matchedCustomerIds = boundedArray(
    input.matchedCustomerIds,
    "matchedCustomerIds",
    NOTICE_FIELD_LIMITS.customerId,
    100,
    { nullable: true },
  );
  const matchReasons = normalizeMatchMap(
    input.matchReasons,
    "matchReasons",
    NOTICE_FIELD_LIMITS.matchReason,
    NOTICE_FIELD_LIMITS.matchReasonsPerCustomer,
  );
  const matchedNeeds = normalizeMatchMap(
    input.matchedNeeds,
    "matchedNeeds",
    NOTICE_FIELD_LIMITS.matchedNeeds,
    NOTICE_FIELD_LIMITS.matchedNeedsPerCustomer,
  );
  const matchScore = input.matchScore === undefined ? 0 : input.matchScore;
  if (!Number.isSafeInteger(matchScore) || matchScore < 0 || matchScore > 100) {
    throw new TypeError("matchScore must be an integer between 0 and 100");
  }
  return { matchedCustomerIds, matchReasons, matchedNeeds, matchScore };
}

/**
 * Merge one customer batch into a previously persisted notice match.
 * Batch runs share one immutable source snapshot, so customer evidence must
 * accumulate instead of being replaced by the latest ten-customer slice.
 */
export function mergeNoticeMatches(previous = {}, next = {}) {
  const before = normalizeNoticeMatch(previous);
  const after = normalizeNoticeMatch(next);
  const matchedCustomerIds = [...new Set([
    ...before.matchedCustomerIds,
    ...after.matchedCustomerIds,
  ])].slice(0, 100);
  const mergeMap = (left, right, itemLimit) => {
    const output = {};
    for (const customerId of new Set([...Object.keys(left), ...Object.keys(right)])) {
      output[customerId] = [...new Set([
        ...(Array.isArray(left[customerId]) ? left[customerId] : []),
        ...(Array.isArray(right[customerId]) ? right[customerId] : []),
      ])].slice(0, itemLimit);
    }
    return output;
  };
  return normalizeNoticeMatch({
    matchedCustomerIds,
    matchReasons: mergeMap(before.matchReasons, after.matchReasons, NOTICE_FIELD_LIMITS.matchReasonsPerCustomer),
    matchedNeeds: mergeMap(before.matchedNeeds, after.matchedNeeds, NOTICE_FIELD_LIMITS.matchedNeedsPerCustomer),
    matchScore: Math.max(before.matchScore, after.matchScore),
  });
}

function fromNoticeRow(row, { bridgeRefs = null, bridgeStatus = null } = {}) {
  if (!row) return null;
  const persistedBridgeRefs = bridgeRefs === null
    ? parseBridgeRefs(row.bridge_refs_json)
    : parseBridgeRefs(bridgeRefs);
  const resolvedBridgeStatus = bridgeStatus
    ?? (row.bridge_status || bridgeStatusForRefs(persistedBridgeRefs));
  const rawRevision = Number(row.canonical_revision ?? row.revision ?? 1);
  return {
    id: row.id,
    identityKey: row.identity_key,
    sourceId: row.source_id,
    sourceName: row.source_name,
    city: row.city ?? null,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    noticeType: row.notice_type,
    purchaser: row.purchaser ?? null,
    projectCode: row.project_code ?? null,
    budgetText: row.budget_text ?? null,
    deadlineText: row.deadline_text ?? null,
    contentText: row.content_text ?? null,
    hospitalNames: jsonValue(row.hospital_names_json, "hospitalNames", []),
    sourceItemId: row.source_item_id ?? null,
    contentSha256: row.content_sha256 ?? null,
    relevance: row.relevance,
    match: normalizeNoticeMatch({
      matchedCustomerIds: jsonValue(row.match_customer_ids_json, "matchedCustomerIds", []),
      matchReasons: jsonValue(row.match_reasons_json, "matchReasons", {}),
      matchedNeeds: jsonValue(row.matched_needs_json, "matchedNeeds", {}),
      matchScore: Number(row.match_score ?? 0),
    }),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    canonicalNoticeId: row.canonical_notice_id ?? null,
    canonicalRevision: Number.isSafeInteger(rawRevision) && rawRevision >= 1 ? rawRevision : 1,
    canonicalDigest: isSha256(row.canonical_digest) ? row.canonical_digest.toLowerCase() : null,
    bridgeStatus: resolvedBridgeStatus || NOTICE_BRIDGE_STATUS_UNBRIDGED,
    bridgeRefs: persistedBridgeRefs,
    // Existing consumers use `revision` for tender source provenance.  Keep it
    // as an alias while making canonicalRevision the source of truth.
    revision: Number.isSafeInteger(rawRevision) && rawRevision >= 1 ? rawRevision : 1,
  };
}

function fromSourceRow(row) {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    sourceName: row.source_name,
    status: row.status,
    lastRunAt: row.last_run_at ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastItemCount: Number(row.last_item_count ?? 0),
    lastUpsertedCount: Number(row.last_upserted_count ?? 0),
    lastRejectedCount: Number(row.last_rejected_count ?? 0),
    lastError: row.last_error ?? null,
    updatedAt: row.updated_at,
  };
}

function fromRunRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    status: row.status,
    fetchedCount: Number(row.fetched_count ?? 0),
    upsertedCount: Number(row.upserted_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    errorText: row.error_text ?? null,
    createdAt: row.created_at,
  };
}

function nonNegativeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isPublishedToday(value, now) {
  const current = localDateKey(now);
  return Boolean(current && localDateKey(value) === current);
}

function isDeadlineSoon(value, now) {
  const timestamp = parsedTimestamp(value);
  if (timestamp === null) return false;
  const start = new Date(now);
  if (Number.isNaN(start.getTime())) return false;
  start.setHours(0, 0, 0, 0);
  return timestamp >= start.getTime()
    && timestamp <= start.getTime() + (7 * 24 * 60 * 60 * 1000);
}

function normalizeListFilters(filters = {}) {
  assertPlainObject(filters, "filters");
  const allowed = new Set([
    "identityKey",
    "sourceId",
    "noticeType",
    "relevance",
    "city",
    "customerId",
    "query",
    "publishedFrom",
    "publishedTo",
    "firstSeenFrom",
    "limit",
    "offset",
  ]);
  assertKnownKeys(filters, allowed, "filters");
  const normalized = {
    identityKey: optionalText(filters.identityKey, "identityKey", NOTICE_FIELD_LIMITS.identityKey),
    sourceId: optionalText(filters.sourceId, "sourceId", NOTICE_FIELD_LIMITS.sourceId),
    noticeType: filters.noticeType === undefined || filters.noticeType === null || filters.noticeType === ""
      ? null
      : enumValue(filters.noticeType, NOTICE_TYPES, "noticeType"),
    relevance: filters.relevance === undefined || filters.relevance === null || filters.relevance === ""
      ? null
      : enumValue(filters.relevance, RELEVANCE_LEVELS, "relevance"),
    city: optionalText(filters.city, "city", NOTICE_FIELD_LIMITS.city),
    customerId: optionalText(filters.customerId, "customerId", NOTICE_FIELD_LIMITS.customerId),
    query: optionalText(filters.query, "query", 200),
    publishedFrom: filters.publishedFrom === undefined || filters.publishedFrom === null || filters.publishedFrom === ""
      ? null
      : dateTime(filters.publishedFrom, "publishedFrom"),
    publishedTo: filters.publishedTo === undefined || filters.publishedTo === null || filters.publishedTo === ""
      ? null
      : dateTime(filters.publishedTo, "publishedTo"),
    firstSeenFrom: filters.firstSeenFrom === undefined || filters.firstSeenFrom === null || filters.firstSeenFrom === ""
      ? null
      : dateTime(filters.firstSeenFrom, "firstSeenFrom"),
    limit: filters.limit === undefined ? 50 : filters.limit,
    offset: filters.offset === undefined ? 0 : filters.offset,
  };
  if (!Number.isSafeInteger(normalized.limit) || normalized.limit < 1 || normalized.limit > 200) {
    throw new TypeError("limit must be an integer between 1 and 200");
  }
  if (!Number.isSafeInteger(normalized.offset) || normalized.offset < 0 || normalized.offset > 1_000_000) {
    throw new TypeError("offset must be a non-negative safe integer");
  }
  for (const [name, value] of [["customerId", normalized.customerId], ["query", normalized.query]]) {
    if (value !== null && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      throw new TypeError(`${name} contains control characters`);
    }
  }
  if (normalized.publishedFrom && normalized.publishedTo && normalized.publishedFrom > normalized.publishedTo) {
    throw new TypeError("publishedFrom cannot be after publishedTo");
  }
  return normalized;
}

function noticeWhere(filters, { pagination = true } = {}) {
  const clauses = ["1 = 1"];
  const params = {};
  if (filters.identityKey !== null) {
    clauses.push("identity_key = $identityKey");
    params.$identityKey = filters.identityKey;
  }
  if (filters.sourceId !== null) {
    clauses.push("source_id = $sourceId");
    params.$sourceId = filters.sourceId;
  }
  if (filters.noticeType !== null) {
    clauses.push("notice_type = $noticeType");
    params.$noticeType = filters.noticeType;
  }
  if (filters.relevance !== null) {
    clauses.push("relevance = $relevance");
    params.$relevance = filters.relevance;
  }
  if (filters.city !== null) {
    clauses.push("city = $city");
    params.$city = filters.city;
  }
  if (filters.customerId !== null) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(hospital_tender_notices.match_customer_ids_json)
      WHERE json_each.value = $customerId
    )`);
    params.$customerId = filters.customerId;
  }
  if (filters.query !== null) {
    clauses.push(`instr(
      lower(
        coalesce(title, '') || ' ' || coalesce(purchaser, '') || ' '
        || coalesce(project_code, '') || ' ' || coalesce(city, '') || ' '
        || coalesce(content_text, '')
      ),
      lower($query)
    ) > 0`);
    params.$query = filters.query;
  }
  if (filters.publishedFrom !== null) {
    clauses.push("published_at >= $publishedFrom");
    params.$publishedFrom = filters.publishedFrom;
  }
  if (filters.publishedTo !== null) {
    clauses.push("published_at <= $publishedTo");
    params.$publishedTo = filters.publishedTo;
  }
  if (filters.firstSeenFrom !== null) {
    // first_seen_at is written by clock().toISOString(), so a lexicographic
    // compare against a UTC ISO anchor is a correct time-window filter.
    clauses.push("first_seen_at >= $firstSeenFrom");
    params.$firstSeenFrom = filters.firstSeenFrom;
  }
  const paginationSql = pagination ? " LIMIT $limit OFFSET $offset" : "";
  if (pagination) {
    params.$limit = filters.limit;
    params.$offset = filters.offset;
  }
  return { where: clauses.join(" AND "), params, paginationSql };
}

function runFilter(filters = {}) {
  assertPlainObject(filters, "filters");
  const allowed = new Set(["sourceId"]);
  assertKnownKeys(filters, allowed, "filters");
  return filters.sourceId === undefined || filters.sourceId === null || filters.sourceId === ""
    ? null
    : requiredText(filters.sourceId, "sourceId", NOTICE_FIELD_LIMITS.sourceId);
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  } catch {
    return new Set();
  }
}

function rawNoticeInput(row) {
  if (!row) return null;
  return {
    id: row.id,
    identityKey: row.identity_key,
    sourceId: row.source_id,
    sourceName: row.source_name,
    city: row.city,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    noticeType: row.notice_type,
    purchaser: row.purchaser,
    projectCode: row.project_code,
    budgetText: row.budget_text,
    deadlineText: row.deadline_text,
    contentText: row.content_text,
    hospitalNames: jsonValue(row.hospital_names_json, "hospitalNames", []),
    sourceItemId: row.source_item_id,
    contentSha256: row.content_sha256,
    relevance: row.relevance,
    canonicalNoticeId: row.canonical_notice_id,
  };
}

function bridgeLookupError(message = "Hospital tender canonical bridge storage is unavailable") {
  const error = new Error(message);
  error.code = "HOSPITAL_TENDER_BRIDGE_SCHEMA_REQUIRED";
  return error;
}

function bridgeConflictError(code, message, fields) {
  return new HttpError(409, code, message, fields);
}

function requiredBridgeOwner(value) {
  return requiredText(value, "owner", 200);
}

function requiredBridgeId(value, name = "canonicalNoticeId") {
  return requiredText(value, name, name === "canonicalNoticeId" ? CANONICAL_NOTICE_ID_MAX : 200);
}

function positiveRevision(value, name = "noticeRevision") {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

/**
 * SQLite repository boundary for notices, source health, and ingestion runs.
 * Expected tables are documented by the SQL used in the focused repository
 * tests; migrations can add indexes or foreign keys without changing this API.
 */
export function createHospitalTenderRepository(db, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");

  const noticeColumns = tableColumns(db, "hospital_tender_notices");
  const canonicalStorage = [
    "canonical_notice_id",
    "canonical_revision",
    "canonical_digest",
    "bridge_status",
    "bridge_refs_json",
  ].every((column) => noticeColumns.has(column));
  const bridgeStorage = tableExists(db, "hospital_tender_bridges");

  function requireBridgeStorage() {
    if (!canonicalStorage || !bridgeStorage) throw bridgeLookupError();
  }

  function rawNoticeById(id) {
    return db.prepare("SELECT * FROM hospital_tender_notices WHERE id = $id").get({ $id: id }) ?? null;
  }

  function rawNoticeByIdentity(identityKey) {
    return db.prepare(
      "SELECT * FROM hospital_tender_notices WHERE identity_key = $identityKey",
    ).get({ $identityKey: identityKey }) ?? null;
  }

  function rawNoticeRows() {
    return db.prepare(
      "SELECT * FROM hospital_tender_notices ORDER BY first_seen_at ASC, id ASC",
    ).all();
  }

  function bridgeRows(canonicalNoticeId, owner = null) {
    if (!bridgeStorage) return [];
    const clauses = ["bridge.canonical_notice_id = $canonicalNoticeId"];
    const params = { $canonicalNoticeId: canonicalNoticeId };
    if (owner !== null && owner !== undefined) {
      clauses.push("bridge.owner = $owner");
      params.$owner = requiredBridgeOwner(owner);
    }
    return db.prepare(`
      SELECT bridge.*
        FROM hospital_tender_bridges AS bridge
        JOIN customers AS customer
          ON customer.id = bridge.customer_id
         AND customer.owner = bridge.owner
         AND customer.deleted_at IS NULL
       WHERE ${clauses.join(" AND ")}
       ORDER BY bridge.owner ASC, bridge.customer_id ASC, bridge.id ASC
    `).all(params).map(bridgeFromRow).filter(Boolean);
  }

  function noticeBridgeRefs(canonicalNoticeId, owner = null, fallback = []) {
    const persisted = bridgeRows(canonicalNoticeId, owner);
    if (persisted.length > 0 || bridgeStorage) return persisted;
    return parseBridgeRefs(fallback).filter((ref) => owner === null || ref.owner === owner);
  }

  function updateNoticeBridgeProjection(canonicalNoticeId) {
    if (!canonicalStorage) return;
    const refs = bridgeRows(canonicalNoticeId);
    db.prepare(`
      UPDATE hospital_tender_notices
         SET bridge_status = $bridgeStatus,
             bridge_refs_json = $bridgeRefs
       WHERE canonical_notice_id = $canonicalNoticeId
    `).run({
      $canonicalNoticeId: canonicalNoticeId,
      $bridgeStatus: bridgeStatusForRefs(refs),
      $bridgeRefs: bridgeRefsJson(refs),
    });
  }

  function markBridgesStale(canonicalNoticeId, noticeRevision, noticeDigest, now) {
    if (!bridgeStorage) return;
    db.prepare(`
      UPDATE hospital_tender_bridges
         SET status = 'conflict', updated_at = $now
       WHERE canonical_notice_id = $canonicalNoticeId
         AND status IN ('previewed', 'confirmed')
         AND (notice_revision <> $noticeRevision OR notice_digest <> $noticeDigest)
    `).run({
      $canonicalNoticeId: canonicalNoticeId,
      $noticeRevision: noticeRevision,
      $noticeDigest: noticeDigest,
      $now: now,
    });
    updateNoticeBridgeProjection(canonicalNoticeId);
  }

  function hydrateNoticeRow(raw, { owner = null, repair = true } = {}) {
    if (!raw) return null;
    const input = rawNoticeInput(raw);
    const storedCanonicalId = typeof raw.canonical_notice_id === "string" && raw.canonical_notice_id.trim()
      ? raw.canonical_notice_id.trim()
      : null;
    const canonicalNoticeId = storedCanonicalId ?? canonicalNoticeIdentity(input);
    const computedCanonicalDigest = canonicalNoticeDigest(input, { canonicalNoticeId });
    const storedContentDigest = isSha256(raw.content_sha256)
      ? raw.content_sha256.toLowerCase()
      : null;
    const storedCanonicalDigest = isSha256(raw.canonical_digest)
      ? raw.canonical_digest.toLowerCase()
      : null;
    let canonicalRevision = Number(raw.canonical_revision ?? 1);
    if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 1) canonicalRevision = 1;

    // 0043 initially copies content_sha256 into canonical_digest.  That row is
    // still revision 1: canonical bridge code replaces the seed with the
    // digest of the normalized persisted snapshot before any bridge is made.
    const legacySeed = !storedCanonicalDigest
      || storedCanonicalDigest === storedContentDigest
      || !storedCanonicalId;
    const changedOutsideRepository = storedCanonicalDigest !== null
      && storedCanonicalDigest !== computedCanonicalDigest
      && !legacySeed;
    if (changedOutsideRepository) canonicalRevision += 1;

    // `content_sha256` is the legacy content-only digest.  Do not seed it
    // with the canonical notice digest: the latter intentionally includes
    // normalized metadata and is therefore a different value.  Older rows
    // may be null, so repair the missing value from the persisted body before
    // any bridge row is created.
    const repairedContentDigest = storedContentDigest ?? contentDigest(raw.content_text);
    const persistedRefs = noticeBridgeRefs(canonicalNoticeId, null, raw.bridge_refs_json);
    const persistedStatus = bridgeStatusForRefs(persistedRefs);
    // Notice rows are global.  Bridge references are owner-scoped and are
    // therefore returned only when a caller explicitly supplies an owner.
    const refs = owner === null
      ? []
      : persistedRefs.filter((ref) => ref.owner === owner);
    const projectedStatus = owner === null
      ? NOTICE_BRIDGE_STATUS_UNBRIDGED
      : bridgeStatusForRefs(refs);
    if (repair && canonicalStorage) {
      const shouldRepair = raw.canonical_notice_id !== canonicalNoticeId
        || Number(raw.canonical_revision) !== canonicalRevision
        || raw.canonical_digest !== computedCanonicalDigest
        || raw.content_sha256 !== repairedContentDigest
        || raw.bridge_status !== persistedStatus
        || JSON.stringify(parseBridgeRefs(raw.bridge_refs_json)) !== JSON.stringify(persistedRefs);
      if (shouldRepair) {
        const now = nowIso(clock);
        db.prepare(`
          UPDATE hospital_tender_notices
             SET content_sha256 = $contentSha256,
                 canonical_notice_id = $canonicalNoticeId,
                 canonical_revision = $canonicalRevision,
                 canonical_digest = $canonicalDigest,
                 bridge_status = $bridgeStatus,
                 bridge_refs_json = $bridgeRefs
           WHERE id = $id
        `).run({
          $id: raw.id,
          $contentSha256: repairedContentDigest,
          $canonicalNoticeId: canonicalNoticeId,
          $canonicalRevision: canonicalRevision,
          $canonicalDigest: computedCanonicalDigest,
          $bridgeStatus: persistedStatus,
          $bridgeRefs: bridgeRefsJson(persistedRefs),
        });
        if (changedOutsideRepository) {
          markBridgesStale(canonicalNoticeId, canonicalRevision, computedCanonicalDigest, now);
        }
      }
    }
    return fromNoticeRow({
      ...raw,
      content_sha256: repairedContentDigest,
      canonical_notice_id: canonicalNoticeId,
      canonical_revision: canonicalRevision,
      canonical_digest: computedCanonicalDigest,
      bridge_status: projectedStatus,
      bridge_refs_json: bridgeRefsJson(refs),
    }, {
      bridgeRefs: refs,
      bridgeStatus: projectedStatus,
    });
  }

  function getNotice(id, options = {}) {
    const noticeId = requiredText(id, "id", NOTICE_FIELD_LIMITS.id);
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["owner"]), "options");
    const owner = options.owner === undefined || options.owner === null
      ? null
      : requiredBridgeOwner(options.owner);
    return hydrateNoticeRow(rawNoticeById(noticeId), { owner });
  }

  // Hospital tender notices are global intelligence, while bridge references
  // are owner-scoped.  Keep the two concerns explicit so callers cannot
  // accidentally serialize another owner's bridge rows from a global read.
  function getNoticeForOwner(id, owner) {
    return getNotice(id, { owner });
  }

  function upsertLegacyNotice(input, match = {}, options = {}) {
    const snapshot = normalizeNoticeSnapshot(input);
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["mergeExistingMatch"]), "options");
    const existing = db.prepare(
      "SELECT id, first_seen_at FROM hospital_tender_notices WHERE identity_key = $identityKey",
    ).get({ $identityKey: snapshot.identityKey });
    const existingNotice = existing ? getNotice(existing.id) : null;
    const normalizedMatch = options.mergeExistingMatch
      ? mergeNoticeMatches(existingNotice?.match ?? {}, match)
      : normalizeNoticeMatch(match);
    const id = existing?.id ?? snapshot.id ?? generatedId(idFactory, "generated notice id");
    const now = nowIso(clock);
    db.prepare(`
      INSERT INTO hospital_tender_notices (
        id, identity_key, source_id, source_name, city, title, url, published_at,
        notice_type, purchaser, project_code, budget_text, deadline_text, content_text,
        hospital_names_json, source_item_id, content_sha256, relevance,
        match_customer_ids_json, match_reasons_json, matched_needs_json, match_score,
        first_seen_at, last_seen_at
      ) VALUES (
        $id, $identityKey, $sourceId, $sourceName, $city, $title, $url, $publishedAt,
        $noticeType, $purchaser, $projectCode, $budgetText, $deadlineText, $contentText,
        $hospitalNamesJson, $sourceItemId, $contentSha256, $relevance,
        $matchedCustomerIdsJson, $matchReasonsJson, $matchedNeedsJson, $matchScore,
        $firstSeenAt, $lastSeenAt
      )
      ON CONFLICT(identity_key) DO UPDATE SET
        source_id = excluded.source_id,
        source_name = excluded.source_name,
        city = excluded.city,
        title = excluded.title,
        url = excluded.url,
        published_at = excluded.published_at,
        notice_type = excluded.notice_type,
        purchaser = excluded.purchaser,
        project_code = excluded.project_code,
        budget_text = excluded.budget_text,
        deadline_text = excluded.deadline_text,
        content_text = excluded.content_text,
        hospital_names_json = excluded.hospital_names_json,
        source_item_id = excluded.source_item_id,
        content_sha256 = excluded.content_sha256,
        relevance = excluded.relevance,
        match_customer_ids_json = excluded.match_customer_ids_json,
        match_reasons_json = excluded.match_reasons_json,
        matched_needs_json = excluded.matched_needs_json,
        match_score = excluded.match_score,
        last_seen_at = excluded.last_seen_at
    `).run({
      $id: id,
      $identityKey: snapshot.identityKey,
      $sourceId: snapshot.sourceId,
      $sourceName: snapshot.sourceName,
      $city: snapshot.city,
      $title: snapshot.title,
      $url: snapshot.url,
      $publishedAt: snapshot.publishedAt,
      $noticeType: snapshot.noticeType,
      $purchaser: snapshot.purchaser,
      $projectCode: snapshot.projectCode,
      $budgetText: snapshot.budgetText,
      $deadlineText: snapshot.deadlineText,
      $contentText: snapshot.contentText,
      $hospitalNamesJson: JSON.stringify(snapshot.hospitalNames),
      $sourceItemId: snapshot.sourceItemId,
      $contentSha256: snapshot.contentSha256,
      $relevance: snapshot.relevance,
      $matchedCustomerIdsJson: JSON.stringify(normalizedMatch.matchedCustomerIds),
      $matchReasonsJson: JSON.stringify(normalizedMatch.matchReasons),
      $matchedNeedsJson: JSON.stringify(normalizedMatch.matchedNeeds),
      $matchScore: normalizedMatch.matchScore,
      $firstSeenAt: existing?.first_seen_at ?? now,
      $lastSeenAt: now,
    });
    return getNotice(id);
  }

  function matchingCanonicalNoticeRows(snapshot) {
    const candidates = new Set(canonicalNoticeIdentityCandidates(snapshot));
    const rows = rawNoticeRows().filter((row) => {
      if (row.identity_key === snapshot.identityKey) return true;
      if (row.canonical_notice_id && candidates.has(row.canonical_notice_id)) return true;
      return canonicalNoticeIdentityCandidates(rawNoticeInput(row))
        .some((candidate) => candidates.has(candidate));
    });
    return { candidates: [...candidates], rows };
  }

  function findCanonicalNotice(snapshot) {
    const { candidates, rows } = matchingCanonicalNoticeRows(snapshot);
    if (rows.length > 1) {
      throw bridgeConflictError(
        "NOTICE_CANONICAL_AMBIGUITY",
        "Multiple persisted tender notices match the same canonical identity",
        {
          canonicalCandidates: candidates,
          noticeIds: rows.map((row) => row.id),
        },
      );
    }
    return rows[0] ?? null;
  }

  function upsertNotice(input, match = {}, options = {}) {
    if (!canonicalStorage) return upsertLegacyNotice(input, match, options);
    const snapshot = normalizeNoticeSnapshot(input);
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["mergeExistingMatch"]), "options");

    const existingRow = findCanonicalNotice(snapshot);
    const existing = existingRow ? hydrateNoticeRow(existingRow) : null;
    const canonicalNoticeId = existing?.canonicalNoticeId ?? canonicalNoticeIdentity(snapshot);
    const canonicalDigest = canonicalNoticeDigest(snapshot, { canonicalNoticeId });
    const canonicalRevision = existing === null
      ? 1
      : existing.canonicalDigest === canonicalDigest
        ? existing.canonicalRevision
        : existing.canonicalRevision + 1;
    const preserveExistingSnapshot = existing !== null
      && existing.identityKey !== snapshot.identityKey
      && existing.canonicalDigest === canonicalDigest;
    const persistedSnapshot = preserveExistingSnapshot ? existing : snapshot;
    const normalizedMatch = options.mergeExistingMatch
      ? mergeNoticeMatches(existing?.match ?? {}, match)
      : normalizeNoticeMatch(match);
    const id = existing?.id ?? snapshot.id ?? generatedId(idFactory, "generated notice id");
    const conflictingId = rawNoticeById(id);
    if (conflictingId && conflictingId.id !== existing?.id) {
      throw bridgeConflictError("NOTICE_ID_CONFLICT", "A different notice already uses this id");
    }
    const conflictingIdentity = rawNoticeByIdentity(snapshot.identityKey);
    if (conflictingIdentity && conflictingIdentity.id !== existing?.id) {
      throw bridgeConflictError(
        "NOTICE_IDENTITY_CONFLICT",
        "A different notice already uses this identity key",
      );
    }

    const now = nowIso(clock);
    const values = {
      $id: id,
      $identityKey: persistedSnapshot.identityKey,
      $sourceId: persistedSnapshot.sourceId,
      $sourceName: persistedSnapshot.sourceName,
      $city: persistedSnapshot.city,
      $title: persistedSnapshot.title,
      $url: persistedSnapshot.url,
      $publishedAt: persistedSnapshot.publishedAt,
      $noticeType: persistedSnapshot.noticeType,
      $purchaser: persistedSnapshot.purchaser,
      $projectCode: persistedSnapshot.projectCode,
      $budgetText: persistedSnapshot.budgetText,
      $deadlineText: persistedSnapshot.deadlineText,
      $contentText: persistedSnapshot.contentText,
      $hospitalNamesJson: JSON.stringify(persistedSnapshot.hospitalNames),
      $sourceItemId: persistedSnapshot.sourceItemId,
      // Keep the legacy content-only digest separate from the canonical
      // notice digest.  A missing upstream content digest is repaired from
      // content, never from the metadata-bound canonical snapshot.
      $contentSha256: persistedSnapshot.contentSha256 ?? contentDigest(persistedSnapshot.contentText),
      $relevance: persistedSnapshot.relevance,
      $matchedCustomerIdsJson: JSON.stringify(normalizedMatch.matchedCustomerIds),
      $matchReasonsJson: JSON.stringify(normalizedMatch.matchReasons),
      $matchedNeedsJson: JSON.stringify(normalizedMatch.matchedNeeds),
      $matchScore: normalizedMatch.matchScore,
      $firstSeenAt: existingRow?.first_seen_at ?? now,
      $lastSeenAt: now,
      $canonicalNoticeId: canonicalNoticeId,
      $canonicalRevision: canonicalRevision,
      $canonicalDigest: canonicalDigest,
      $bridgeStatus: existing?.bridgeStatus ?? NOTICE_BRIDGE_STATUS_UNBRIDGED,
      $bridgeRefsJson: bridgeRefsJson(existing?.bridgeRefs ?? []),
    };
    if (existingRow) {
      const {
        $firstSeenAt: _firstSeenAt,
        $bridgeStatus: _bridgeStatus,
        $bridgeRefsJson: _bridgeRefsJson,
        ...updateValues
      } = values;
      db.prepare(`
        UPDATE hospital_tender_notices
           SET identity_key = $identityKey,
               source_id = $sourceId,
               source_name = $sourceName,
               city = $city,
               title = $title,
               url = $url,
               published_at = $publishedAt,
               notice_type = $noticeType,
               purchaser = $purchaser,
               project_code = $projectCode,
               budget_text = $budgetText,
               deadline_text = $deadlineText,
               content_text = $contentText,
               hospital_names_json = $hospitalNamesJson,
               source_item_id = $sourceItemId,
               content_sha256 = $contentSha256,
               relevance = $relevance,
               match_customer_ids_json = $matchedCustomerIdsJson,
               match_reasons_json = $matchReasonsJson,
               matched_needs_json = $matchedNeedsJson,
               match_score = $matchScore,
               canonical_notice_id = $canonicalNoticeId,
               canonical_revision = $canonicalRevision,
               canonical_digest = $canonicalDigest,
               last_seen_at = $lastSeenAt
         WHERE id = $id
      `).run(updateValues);
    } else {
      db.prepare(`
        INSERT INTO hospital_tender_notices (
          id, identity_key, source_id, source_name, city, title, url, published_at,
          notice_type, purchaser, project_code, budget_text, deadline_text, content_text,
          hospital_names_json, source_item_id, content_sha256, relevance,
          match_customer_ids_json, match_reasons_json, matched_needs_json, match_score,
          first_seen_at, last_seen_at, canonical_notice_id, canonical_revision,
          canonical_digest, bridge_status, bridge_refs_json
        ) VALUES (
          $id, $identityKey, $sourceId, $sourceName, $city, $title, $url, $publishedAt,
          $noticeType, $purchaser, $projectCode, $budgetText, $deadlineText, $contentText,
          $hospitalNamesJson, $sourceItemId, $contentSha256, $relevance,
          $matchedCustomerIdsJson, $matchReasonsJson, $matchedNeedsJson, $matchScore,
          $firstSeenAt, $lastSeenAt, $canonicalNoticeId, $canonicalRevision,
          $canonicalDigest, $bridgeStatus, $bridgeRefsJson
        )
      `).run(values);
    }
    if (existing && existing.canonicalDigest !== canonicalDigest) {
      markBridgesStale(canonicalNoticeId, canonicalRevision, canonicalDigest, now);
    }
    updateNoticeBridgeProjection(canonicalNoticeId);
    return getNotice(id);
  }

  function ensureCanonicalNotice(noticeId, options = {}) {
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["owner"]), "options");
    const owner = options.owner === undefined || options.owner === null
      ? null
      : requiredBridgeOwner(options.owner);
    const raw = rawNoticeById(requiredText(noticeId, "id", NOTICE_FIELD_LIMITS.id));
    if (!raw) return null;
    findCanonicalNotice(rawNoticeInput(raw));
    const item = hydrateNoticeRow(raw, { owner });
    if (!item) return null;
    if (!item.canonicalNoticeId || !isSha256(item.canonicalDigest)) {
      throw bridgeLookupError("Hospital tender canonical notice repair failed");
    }
    return item;
  }

  function getNoticeByCanonicalId(canonicalNoticeId, options = {}) {
    const normalizedCanonicalId = requiredBridgeId(canonicalNoticeId);
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["owner"]), "options");
    const owner = options.owner === undefined || options.owner === null
      ? null
      : requiredBridgeOwner(options.owner);
    if (canonicalStorage) {
      const row = db.prepare(`
        SELECT * FROM hospital_tender_notices
         WHERE canonical_notice_id = $canonicalNoticeId
         LIMIT 1
      `).get({ $canonicalNoticeId: normalizedCanonicalId });
      if (row) {
        findCanonicalNotice(rawNoticeInput(row));
        return hydrateNoticeRow(row, { owner });
      }
    }
    const rows = rawNoticeRows().filter((candidate) => (
      canonicalNoticeIdentityCandidates(rawNoticeInput(candidate)).includes(normalizedCanonicalId)
    ));
    if (rows.length > 1) {
      throw bridgeConflictError(
        "NOTICE_CANONICAL_AMBIGUITY",
        "Multiple persisted tender notices match the requested canonical identity",
        { canonicalNoticeId: normalizedCanonicalId, noticeIds: rows.map((row) => row.id) },
      );
    }
    return hydrateNoticeRow(rows[0] ?? null, { owner });
  }

  function getCanonicalNoticeForOwner(canonicalNoticeId, owner) {
    return getNoticeByCanonicalId(canonicalNoticeId, { owner });
  }

  function ownerCustomer(owner, customerId) {
    const row = db.prepare(`
      SELECT id, version
        FROM customers
       WHERE id = $customerId
         AND owner = $owner
         AND deleted_at IS NULL
    `).get({ $owner: owner, $customerId: customerId });
    if (!row) {
      throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    }
    return { id: row.id, version: Number(row.version ?? 1) };
  }

  function bridgeInput(input = {}, { requireNotice = false } = {}) {
    assertPlainObject(input, "bridge");
    const owner = requiredBridgeOwner(input.owner);
    const customerId = requiredBridgeId(input.customerId, "customerId");
    ownerCustomer(owner, customerId);
    let notice = null;
    if (input.noticeId !== undefined && input.noticeId !== null && input.noticeId !== "") {
      notice = ensureCanonicalNotice(input.noticeId, { owner });
    } else if (input.canonicalNoticeId !== undefined
      && input.canonicalNoticeId !== null
      && input.canonicalNoticeId !== "") {
      notice = getNoticeByCanonicalId(input.canonicalNoticeId, { owner });
    }
    if (requireNotice && !notice) {
      throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
    }
    const canonicalNoticeId = notice?.canonicalNoticeId
      ?? requiredBridgeId(input.canonicalNoticeId);
    return { owner, customerId, canonicalNoticeId, notice };
  }

  function getBridge(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId } = bridgeInput(input);
    return bridgeFromRow(db.prepare(`
      SELECT * FROM hospital_tender_bridges
       WHERE owner = $owner
         AND canonical_notice_id = $canonicalNoticeId
         AND customer_id = $customerId
    `).get({
      $owner: owner,
      $canonicalNoticeId: canonicalNoticeId,
      $customerId: customerId,
    }));
  }

  function listBridges(filters = {}) {
    requireBridgeStorage();
    assertPlainObject(filters, "filters");
    assertKnownKeys(filters, new Set([
      "owner", "canonicalNoticeId", "customerId", "status", "limit", "offset",
    ]), "filters");
    const owner = requiredBridgeOwner(filters.owner);
    const canonicalNoticeId = optionalText(
      filters.canonicalNoticeId,
      "canonicalNoticeId",
      CANONICAL_NOTICE_ID_MAX,
    );
    const customerId = optionalText(filters.customerId, "customerId", 200);
    const status = filters.status === undefined || filters.status === null || filters.status === ""
      ? null
      : enumValue(filters.status, BRIDGE_STATUSES, "status");
    const limit = filters.limit === undefined ? 50 : filters.limit;
    const offset = filters.offset === undefined ? 0 : filters.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("limit must be an integer between 1 and 200");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new TypeError("offset must be a non-negative safe integer");
    }
    return db.prepare(`
      SELECT bridge.*
        FROM hospital_tender_bridges AS bridge
        JOIN customers AS customer
          ON customer.id = bridge.customer_id
         AND customer.owner = bridge.owner
         AND customer.deleted_at IS NULL
       WHERE bridge.owner = $owner
         AND ($canonicalNoticeId IS NULL OR bridge.canonical_notice_id = $canonicalNoticeId)
         AND ($customerId IS NULL OR bridge.customer_id = $customerId)
         AND ($status IS NULL OR bridge.status = $status)
       ORDER BY bridge.updated_at DESC, bridge.id ASC
       LIMIT $limit OFFSET $offset
    `).all({
      $owner: owner,
      $canonicalNoticeId: canonicalNoticeId,
      $customerId: customerId,
      $status: status,
      $limit: limit,
      $offset: offset,
    }).map(bridgeFromRow).filter(Boolean);
  }

  function staleNoticeBridge({ owner, canonicalNoticeId, customerId, message }) {
    markBridgeConflict({ owner, canonicalNoticeId, customerId });
    throw bridgeConflictError(
      "BRIDGE_NOTICE_STALE",
      message ?? "The canonical tender notice changed after preview",
    );
  }

  function assertCurrentNotice(input, notice) {
    const expectedRevision = positiveRevision(input.noticeRevision);
    const expectedDigest = normalizeSha256(input.noticeDigest, "noticeDigest");
    if (expectedRevision !== notice.canonicalRevision || expectedDigest !== notice.canonicalDigest) {
      staleNoticeBridge({
        owner: input.owner,
        canonicalNoticeId: notice.canonicalNoticeId,
        customerId: input.customerId,
      });
    }
    return { expectedRevision, expectedDigest };
  }

  function ensureBridge(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId, notice } = bridgeInput(input, { requireNotice: true });
    const current = getBridge({ owner, canonicalNoticeId, customerId });
    if (current) return current;
    const now = nowIso(clock);
    db.prepare(`
      INSERT INTO hospital_tender_bridges (
        id, owner, canonical_notice_id, customer_id, status,
        notice_revision, notice_digest, opportunity_id, action_item_id,
        preview_digest, created_at, updated_at
      ) VALUES (
        $id, $owner, $canonicalNoticeId, $customerId, 'unconverted',
        $noticeRevision, $noticeDigest, NULL, NULL, NULL, $now, $now
      )
      ON CONFLICT(owner, canonical_notice_id, customer_id) DO NOTHING
    `).run({
      $id: hospitalTenderBridgeId({ owner, canonicalNoticeId, customerId }),
      $owner: owner,
      $canonicalNoticeId: canonicalNoticeId,
      $customerId: customerId,
      $noticeRevision: notice.canonicalRevision,
      $noticeDigest: notice.canonicalDigest,
      $now: now,
    });
    updateNoticeBridgeProjection(canonicalNoticeId);
    return getBridge({ owner, canonicalNoticeId, customerId });
  }

  function recordBridgePreview(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId, notice } = bridgeInput(input, { requireNotice: true });
    assertCurrentNotice({ ...input, owner, customerId }, notice);
    const previewDigest = normalizeSha256(input.previewDigest, "previewDigest");
    const allowConflictPreview = input.allowConflictPreview === true;
    const current = ensureBridge({ owner, customerId, noticeId: notice.id });
    if (current.status === "confirmed") {
      if (current.noticeRevision === notice.canonicalRevision
        && current.noticeDigest === notice.canonicalDigest
        && current.previewDigest === previewDigest) {
        return current;
      }
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      // A confirmed bridge is immutable for replay purposes.  A caller may
      // still render a fresh read-only proposal after the canonical notice
      // advances, but that proposal cannot overwrite the confirmed receipt;
      // confirmation will fail closed until a new bridge identity is chosen.
      if (allowConflictPreview) return getBridge({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError(
        "BRIDGE_STATE_CONFLICT",
        "The tender notice was already converted from a different preview",
      );
    }
    if ((current.opportunityId || current.actionItemId) && current.status !== "cancelled") {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      if (allowConflictPreview) return getBridge({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_STATE_CONFLICT", "The tender bridge contains an incomplete result");
    }
    if (current.status === "conflict" && allowConflictPreview) {
      // A stale preview conflict without durable conversion result ids is
      // recoverable: the caller has supplied a fresh canonical notice
      // snapshot and may create a new preview for the same owner/customer
      // bridge. Once either result id exists, keep the bridge fail-closed.
      if (current.opportunityId || current.actionItemId) return current;
      // Otherwise continue into the normal preview update below.
    }
    const now = nowIso(clock);
    const update = db.prepare(`
      UPDATE hospital_tender_bridges
         SET status = 'previewed',
             notice_revision = $noticeRevision,
             notice_digest = $noticeDigest,
             opportunity_id = NULL,
             action_item_id = NULL,
             preview_digest = $previewDigest,
             updated_at = $now
       WHERE id = $id AND owner = $owner
    `).run({
      $id: current.id,
      $owner: owner,
      $noticeRevision: notice.canonicalRevision,
      $noticeDigest: notice.canonicalDigest,
      $previewDigest: previewDigest,
      $now: now,
    });
    if (update.changes !== 1) {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_STATE_CONFLICT", "The tender bridge changed during preview");
    }
    updateNoticeBridgeProjection(canonicalNoticeId);
    return getBridge({ owner, canonicalNoticeId, customerId });
  }

  function confirmBridge(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId, notice } = bridgeInput(input, { requireNotice: true });
    assertCurrentNotice({ ...input, owner, customerId }, notice);
    const previewDigest = normalizeSha256(input.previewDigest, "previewDigest");
    const opportunityId = requiredBridgeId(input.opportunityId, "opportunityId");
    const actionItemId = requiredBridgeId(input.actionItemId, "actionItemId");
    const current = getBridge({ owner, canonicalNoticeId, customerId });
    if (current?.status === "confirmed") {
      const replayed = current.noticeRevision === notice.canonicalRevision
        && current.noticeDigest === notice.canonicalDigest
        && current.previewDigest === previewDigest
        && current.opportunityId === opportunityId
        && current.actionItemId === actionItemId;
      if (!replayed) {
        markBridgeConflict({ owner, canonicalNoticeId, customerId });
        throw bridgeConflictError("BRIDGE_STATE_CONFLICT", "The confirmed bridge receipt does not match");
      }
      return { ...current, replayed: true };
    }
    if (!current
      || current.status !== "previewed"
      || current.noticeRevision !== notice.canonicalRevision
      || current.noticeDigest !== notice.canonicalDigest
      || current.previewDigest !== previewDigest) {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_PREVIEW_STALE", "The tender bridge preview no longer matches");
    }
    const now = nowIso(clock);
    const update = db.prepare(`
      UPDATE hospital_tender_bridges
         SET status = 'confirmed',
             opportunity_id = $opportunityId,
             action_item_id = $actionItemId,
             updated_at = $now
       WHERE id = $id
         AND owner = $owner
         AND status = 'previewed'
         AND notice_revision = $noticeRevision
         AND notice_digest = $noticeDigest
         AND preview_digest = $previewDigest
    `).run({
      $id: current.id,
      $owner: owner,
      $noticeRevision: notice.canonicalRevision,
      $noticeDigest: notice.canonicalDigest,
      $previewDigest: previewDigest,
      $opportunityId: opportunityId,
      $actionItemId: actionItemId,
      $now: now,
    });
    if (update.changes !== 1) {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_STATE_CONFLICT", "The tender bridge changed during confirmation");
    }
    updateNoticeBridgeProjection(canonicalNoticeId);
    return {
      ...getBridge({ owner, canonicalNoticeId, customerId }),
      replayed: false,
    };
  }

  function assertBridgePreview(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId, notice } = bridgeInput(input, { requireNotice: true });
    assertCurrentNotice({ ...input, owner, customerId }, notice);
    const previewDigest = normalizeSha256(input.previewDigest, "previewDigest");
    const current = getBridge({ owner, canonicalNoticeId, customerId });
    const valid = current !== null
      && current.status === "previewed"
      && current.noticeRevision === notice.canonicalRevision
      && current.noticeDigest === notice.canonicalDigest
      && current.previewDigest === previewDigest
      && current.opportunityId === null
      && current.actionItemId === null;
    if (!valid) {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_PREVIEW_STALE", "The tender bridge preview no longer matches");
    }
    return current;
  }

  function cancelBridge(input = {}) {
    requireBridgeStorage();
    const { owner, customerId, canonicalNoticeId, notice } = bridgeInput(input, { requireNotice: true });
    assertCurrentNotice({ ...input, owner, customerId }, notice);
    const previewDigest = normalizeSha256(input.previewDigest, "previewDigest");
    const current = getBridge({ owner, canonicalNoticeId, customerId });
    if (current?.status === "cancelled"
      && current.noticeRevision === notice.canonicalRevision
      && current.noticeDigest === notice.canonicalDigest
      && current.previewDigest === previewDigest) {
      return current;
    }
    if (!current
      || current.status !== "previewed"
      || current.noticeRevision !== notice.canonicalRevision
      || current.noticeDigest !== notice.canonicalDigest
      || current.previewDigest !== previewDigest) {
      markBridgeConflict({ owner, canonicalNoticeId, customerId });
      throw bridgeConflictError("BRIDGE_PREVIEW_STALE", "The tender bridge preview no longer matches");
    }
    db.prepare(`
      UPDATE hospital_tender_bridges
         SET status = 'cancelled', updated_at = $now
       WHERE id = $id AND owner = $owner AND status = 'previewed'
    `).run({ $id: current.id, $owner: owner, $now: nowIso(clock) });
    updateNoticeBridgeProjection(canonicalNoticeId);
    return getBridge({ owner, canonicalNoticeId, customerId });
  }

  function markBridgeConflict(input = {}) {
    if (!bridgeStorage) return null;
    const owner = requiredBridgeOwner(input.owner);
    const canonicalNoticeId = requiredBridgeId(input.canonicalNoticeId);
    const customerId = requiredBridgeId(input.customerId, "customerId");
    db.prepare(`
      UPDATE hospital_tender_bridges
         SET status = 'conflict', updated_at = $now
       WHERE owner = $owner
         AND canonical_notice_id = $canonicalNoticeId
         AND customer_id = $customerId
    `).run({
      $owner: owner,
      $canonicalNoticeId: canonicalNoticeId,
      $customerId: customerId,
      $now: nowIso(clock),
    });
    updateNoticeBridgeProjection(canonicalNoticeId);
    return getBridge({ owner, canonicalNoticeId, customerId });
  }

  function listNotices(inputFilters = {}, options = {}) {
    const filters = normalizeListFilters(inputFilters);
    if (!isPlainObject(options)) throw new TypeError("options must be an object");
    assertKnownKeys(options, new Set(["owner"]), "options");
    const owner = options.owner === undefined || options.owner === null
      ? null
      : requiredBridgeOwner(options.owner);
    const { where, params, paginationSql } = noticeWhere(filters);
    return db.prepare(`
      SELECT * FROM hospital_tender_notices
      WHERE ${where}
      ORDER BY published_at DESC, id ASC
      ${paginationSql}
    `).all(params).map((row) => hydrateNoticeRow(row, { owner }));
  }

  function listNoticesForOwner(inputFilters = {}, owner) {
    return listNotices(inputFilters, { owner });
  }

  function countNotices(inputFilters = {}) {
    const filters = normalizeListFilters(inputFilters);
    const { where, params } = noticeWhere(filters, { pagination: false });
    const row = db.prepare(`SELECT COUNT(*) AS count FROM hospital_tender_notices WHERE ${where}`).get(params);
    return Number(row?.count ?? 0);
  }

  function summary(inputFilters = {}) {
    const filters = normalizeListFilters({ ...inputFilters, limit: 200, offset: 0 });
    const { where, params } = noticeWhere(filters, { pagination: false });
    const rows = db.prepare(`SELECT * FROM hospital_tender_notices WHERE ${where}`).all(params);
    const byNoticeType = Object.fromEntries(NOTICE_TYPES.map((type) => [type, 0]));
    const byRelevance = Object.fromEntries(RELEVANCE_LEVELS.map((level) => [level, 0]));
    const bySourceId = {};
    let matchedNotices = 0;
    let latestPublishedAt = null;
    const now = clock();
    let todayNewCount = 0;
    let deadlineSoonCount = 0;
    for (const row of rows) {
      if (Object.hasOwn(byNoticeType, row.notice_type)) byNoticeType[row.notice_type] += 1;
      if (Object.hasOwn(byRelevance, row.relevance)) byRelevance[row.relevance] += 1;
      bySourceId[row.source_id] = (bySourceId[row.source_id] ?? 0) + 1;
      const matched = jsonValue(row.match_customer_ids_json, "matchedCustomerIds", []);
      if (Array.isArray(matched) && matched.length > 0) matchedNotices += 1;
      if (!latestPublishedAt || row.published_at > latestPublishedAt) latestPublishedAt = row.published_at;
      if (isPublishedToday(row.published_at, now)) todayNewCount += 1;
      if (isDeadlineSoon(row.deadline_text, now)) deadlineSoonCount += 1;
    }
    let latestRun = null;
    if (tableExists(db, "hospital_tender_runs")) {
      const runSourceId = runFilter(inputFilters);
      const run = runSourceId
        ? db.prepare("SELECT * FROM hospital_tender_runs WHERE source_id = $sourceId ORDER BY started_at DESC, id DESC LIMIT 1").get({ $sourceId: runSourceId })
        : db.prepare("SELECT * FROM hospital_tender_runs ORDER BY started_at DESC, id DESC LIMIT 1").get();
      latestRun = fromRunRow(run);
    }
    return {
      totalNotices: rows.length,
      matchedNotices,
      unmatchedNotices: rows.length - matchedNotices,
      byNoticeType,
      byRelevance,
      bySourceId,
      latestPublishedAt,
      highRelevanceCount: byRelevance.high,
      deadlineSoonCount,
      todayNewCount,
      asOf: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null,
      latestRun,
    };
  }

  function listSources() {
    if (!tableExists(db, "hospital_tender_sources")) return [];
    return db.prepare("SELECT * FROM hospital_tender_sources ORDER BY source_name ASC, source_id ASC").all().map(fromSourceRow);
  }

  function upsertSourceHealth(input = {}) {
    assertPlainObject(input, "source health");
    const allowed = new Set([
      "sourceId", "sourceName", "status", "lastRunAt", "lastSuccessAt",
      "lastItemCount", "lastUpsertedCount", "lastRejectedCount", "lastError",
    ]);
    assertKnownKeys(input, allowed, "source health");
    const sourceId = requiredText(input.sourceId, "sourceId", NOTICE_FIELD_LIMITS.sourceId);
    const sourceName = requiredText(input.sourceName, "sourceName", NOTICE_FIELD_LIMITS.sourceName);
    const status = enumValue(input.status ?? "unknown", SOURCE_HEALTH_STATUSES, "status");
    const lastRunAt = dateTime(input.lastRunAt, "lastRunAt", { nullable: true });
    const lastSuccessAt = dateTime(input.lastSuccessAt, "lastSuccessAt", { nullable: true });
    const lastItemCount = nonNegativeCount(input.lastItemCount ?? 0, "lastItemCount");
    const lastUpsertedCount = nonNegativeCount(input.lastUpsertedCount ?? 0, "lastUpsertedCount");
    const lastRejectedCount = nonNegativeCount(input.lastRejectedCount ?? 0, "lastRejectedCount");
    const lastError = optionalText(input.lastError, "lastError", NOTICE_FIELD_LIMITS.contentText);
    const updatedAt = nowIso(clock);
    db.prepare(`
      INSERT INTO hospital_tender_sources (
        source_id, source_name, status, last_run_at, last_success_at,
        last_item_count, last_upserted_count, last_rejected_count, last_error, updated_at
      ) VALUES (
        $sourceId, $sourceName, $status, $lastRunAt, $lastSuccessAt,
        $lastItemCount, $lastUpsertedCount, $lastRejectedCount, $lastError, $updatedAt
      )
      ON CONFLICT(source_id) DO UPDATE SET
        source_name = excluded.source_name,
        status = excluded.status,
        last_run_at = excluded.last_run_at,
        last_success_at = excluded.last_success_at,
        last_item_count = excluded.last_item_count,
        last_upserted_count = excluded.last_upserted_count,
        last_rejected_count = excluded.last_rejected_count,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run({
      $sourceId: sourceId,
      $sourceName: sourceName,
      $status: status,
      $lastRunAt: lastRunAt,
      $lastSuccessAt: lastSuccessAt,
      $lastItemCount: lastItemCount,
      $lastUpsertedCount: lastUpsertedCount,
      $lastRejectedCount: lastRejectedCount,
      $lastError: lastError,
      $updatedAt: updatedAt,
    });
    return fromSourceRow(db.prepare("SELECT * FROM hospital_tender_sources WHERE source_id = $sourceId").get({ $sourceId: sourceId }));
  }

  function recordRun(input = {}) {
    assertPlainObject(input, "run");
    const allowed = new Set([
      "id", "sourceId", "startedAt", "finishedAt", "status", "fetchedCount",
      "upsertedCount", "rejectedCount", "errorText",
    ]);
    assertKnownKeys(input, allowed, "run");
    const id = input.id === undefined || input.id === null || input.id === ""
      ? generatedId(idFactory, "generated run id")
      : requiredText(input.id, "id", NOTICE_FIELD_LIMITS.id);
    const sourceId = requiredText(input.sourceId, "sourceId", NOTICE_FIELD_LIMITS.sourceId);
    const startedAt = dateTime(input.startedAt, "startedAt");
    const finishedAt = dateTime(input.finishedAt, "finishedAt", { nullable: true });
    const status = enumValue(input.status, RUN_STATUSES, "status");
    const fetchedCount = nonNegativeCount(input.fetchedCount ?? 0, "fetchedCount");
    const upsertedCount = nonNegativeCount(input.upsertedCount ?? 0, "upsertedCount");
    const rejectedCount = nonNegativeCount(input.rejectedCount ?? 0, "rejectedCount");
    const errorText = optionalText(input.errorText, "errorText", NOTICE_FIELD_LIMITS.contentText);
    const createdAt = nowIso(clock);
    db.prepare(`
      INSERT INTO hospital_tender_runs (
        id, source_id, started_at, finished_at, status, fetched_count,
        upserted_count, rejected_count, error_text, created_at
      ) VALUES (
        $id, $sourceId, $startedAt, $finishedAt, $status, $fetchedCount,
        $upsertedCount, $rejectedCount, $errorText, $createdAt
      )
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        status = excluded.status,
        fetched_count = excluded.fetched_count,
        upserted_count = excluded.upserted_count,
        rejected_count = excluded.rejected_count,
        error_text = excluded.error_text
    `).run({
      $id: id,
      $sourceId: sourceId,
      $startedAt: startedAt,
      $finishedAt: finishedAt,
      $status: status,
      $fetchedCount: fetchedCount,
      $upsertedCount: upsertedCount,
      $rejectedCount: rejectedCount,
      $errorText: errorText,
      $createdAt: createdAt,
    });
    return fromRunRow(db.prepare("SELECT * FROM hospital_tender_runs WHERE id = $id").get({ $id: id }));
  }

  function health() {
    const sources = listSources();
    let status = "unknown";
    if (sources.length > 0) {
      if (sources.some((source) => source.status === "error")) status = "unhealthy";
      else if (sources.some((source) => source.status === "degraded")) status = "degraded";
      else if (sources.every((source) => source.status === "disabled")) status = "disabled";
      else if (sources.every((source) => source.status === "healthy")) status = "healthy";
      else status = "unknown";
    }
    const latestRun = tableExists(db, "hospital_tender_runs")
      ? fromRunRow(db.prepare("SELECT * FROM hospital_tender_runs ORDER BY started_at DESC, id DESC LIMIT 1").get())
      : null;
    return {
      status,
      sourceCount: sources.length,
      healthySourceCount: sources.filter((source) => source.status === "healthy").length,
      degradedSourceCount: sources.filter((source) => source.status === "degraded").length,
      unhealthySourceCount: sources.filter((source) => source.status === "error").length,
      sources,
      lastRunAt: latestRun?.finishedAt ?? latestRun?.startedAt ?? null,
    };
  }

  return {
    getNotice,
    getNoticeForOwner,
    getNoticeByCanonicalId,
    getCanonicalNoticeForOwner,
    ensureCanonicalNotice,
    upsertNotice,
    listNotices,
    listNoticesForOwner,
    countNotices,
    summary,
    listSources,
    health,
    recordRun,
    upsertSourceHealth,
    getBridge,
    listBridges,
    ensureBridge,
    recordBridgePreview,
    assertBridgePreview,
    confirmBridge,
    cancelBridge,
    markBridgeConflict,
  };
}
