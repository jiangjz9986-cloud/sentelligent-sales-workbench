import { randomUUID } from "node:crypto";

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

function fromNoticeRow(row) {
  if (!row) return null;
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

  function getNotice(id) {
    const noticeId = requiredText(id, "id", NOTICE_FIELD_LIMITS.id);
    return fromNoticeRow(db.prepare("SELECT * FROM hospital_tender_notices WHERE id = $id").get({ $id: noticeId }));
  }

  function upsertNotice(input, match = {}) {
    const snapshot = normalizeNoticeSnapshot(input);
    const normalizedMatch = normalizeNoticeMatch(match);
    const existing = db.prepare(
      "SELECT id, first_seen_at FROM hospital_tender_notices WHERE identity_key = $identityKey",
    ).get({ $identityKey: snapshot.identityKey });
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

  function listNotices(inputFilters = {}) {
    const filters = normalizeListFilters(inputFilters);
    const { where, params, paginationSql } = noticeWhere(filters);
    return db.prepare(`
      SELECT * FROM hospital_tender_notices
      WHERE ${where}
      ORDER BY published_at DESC, id ASC
      ${paginationSql}
    `).all(params).map(fromNoticeRow);
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
    for (const row of rows) {
      if (Object.hasOwn(byNoticeType, row.notice_type)) byNoticeType[row.notice_type] += 1;
      if (Object.hasOwn(byRelevance, row.relevance)) byRelevance[row.relevance] += 1;
      bySourceId[row.source_id] = (bySourceId[row.source_id] ?? 0) + 1;
      const matched = jsonValue(row.match_customer_ids_json, "matchedCustomerIds", []);
      if (Array.isArray(matched) && matched.length > 0) matchedNotices += 1;
      if (!latestPublishedAt || row.published_at > latestPublishedAt) latestPublishedAt = row.published_at;
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
    upsertNotice,
    listNotices,
    summary,
    listSources,
    health,
    recordRun,
    upsertSourceHealth,
  };
}
