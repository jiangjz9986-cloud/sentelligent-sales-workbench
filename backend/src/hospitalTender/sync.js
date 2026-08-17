import { createHash } from "node:crypto";

import {
  NOTICE_FIELD_LIMITS,
  NOTICE_TYPES,
  RELEVANCE_LEVELS,
  normalizeNoticeSnapshot,
  normalizeNoticeMatch,
} from "./repository.js";
import { matchNoticeToCustomers } from "./matching.js";

const SNAPSHOT_SCHEMA_VERSION = "hospital-tender-snapshot-v1";
const MAX_NOTICES_PER_SYNC = 500;
const MAX_SOURCES_PER_SYNC = 200;
const MAX_RUNS_PER_SYNC = 200;

const NOTICE_TYPE_MAP = Object.freeze({
  plan: "purchase_intent",
  procurement: "tender",
  single_source: "tender",
  change: "clarification",
  result: "bid_result",
  terminated: "bid_cancelled",
  cancelled: "bid_cancelled",
  voided: "bid_cancelled",
  bid_cancelled: "bid_cancelled",
  contract: "contract_award",
  unknown: "other",
});

const RELEVANCE_MAP = Object.freeze({
  high: "high",
  possible: "medium",
  irrelevant: "low",
});

const NOTICE_INPUT_KEYS = new Set([
  "id", "identityKey", "sourceId", "sourceName", "city", "title", "url", "publishedAt",
  "noticeType", "purchaser", "projectCode", "budgetText", "deadlineText", "contentText",
  "hospitalNames", "sourceItemId", "contentSha256", "relevance",
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

function text(value, name, max, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

function integer(value, name, { optional = false, max = 1_000_000_000 } = {}) {
  if ((value === undefined || value === null) && optional) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function iso(value, name, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  const normalized = text(value, name, 64);
  if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function arrayOfStrings(value, name, maxItems, maxLength, { optional = true } = {}) {
  if ((value === undefined || value === null) && optional) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${name} is invalid`);
  const seen = new Set();
  const output = [];
  for (const [index, item] of value.entries()) {
    const normalized = text(item, `${name}[${index}]`, maxLength);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

function digestContent(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function mapNoticeType(value) {
  const normalized = text(value, "noticeType", 64).toLowerCase();
  if (NOTICE_TYPES.includes(normalized)) return normalized;
  if (NOTICE_TYPE_MAP[normalized]) return NOTICE_TYPE_MAP[normalized];
  throw new TypeError("noticeType is invalid");
}

function mapRelevance(value) {
  const normalized = text(value, "relevance", 32).toLowerCase();
  if (RELEVANCE_LEVELS.includes(normalized)) return normalized;
  if (RELEVANCE_MAP[normalized]) return RELEVANCE_MAP[normalized];
  throw new TypeError("relevance is invalid");
}

function assertAllowedKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
}

function normalizeIncomingNotice(input) {
  assertPlainObject(input, "notice");
  assertAllowedKeys(input, NOTICE_INPUT_KEYS, "notice");
  const contentText = input.contentText === undefined || input.contentText === null || input.contentText === ""
    ? ""
    : text(input.contentText, "contentText", NOTICE_FIELD_LIMITS.contentText);
  const normalized = normalizeNoticeSnapshot({
    ...input,
    noticeType: mapNoticeType(input.noticeType),
    relevance: mapRelevance(input.relevance),
    contentText,
    contentSha256: input.contentSha256 ?? digestContent(contentText),
    hospitalNames: input.hospitalNames ?? [],
    sourceItemId: input.sourceItemId ?? "",
    city: input.city ?? "",
    purchaser: input.purchaser ?? "",
    projectCode: input.projectCode ?? "",
    budgetText: input.budgetText ?? "",
    deadlineText: input.deadlineText ?? "",
  });
  return normalized;
}

function normalizeSource(input) {
  assertPlainObject(input, "source");
  const allowed = new Set([
    "sourceId", "sourceName", "status", "lastRunAt", "lastSuccessAt",
    "lastItemCount", "lastUpsertedCount", "lastRejectedCount", "lastError",
  ]);
  assertAllowedKeys(input, allowed, "source");
  const status = text(input.status ?? "unknown", "source.status", 32).toLowerCase();
  if (!["healthy", "degraded", "error", "disabled", "unknown"].includes(status)) {
    throw new TypeError("source.status is invalid");
  }
  return {
    sourceId: text(input.sourceId, "source.sourceId", NOTICE_FIELD_LIMITS.sourceId),
    sourceName: text(input.sourceName ?? "", "source.sourceName", NOTICE_FIELD_LIMITS.sourceName),
    status,
    lastRunAt: iso(input.lastRunAt, "source.lastRunAt", { optional: true }),
    lastSuccessAt: iso(input.lastSuccessAt, "source.lastSuccessAt", { optional: true }),
    lastItemCount: integer(input.lastItemCount, "source.lastItemCount", { optional: true }),
    lastUpsertedCount: integer(input.lastUpsertedCount, "source.lastUpsertedCount", { optional: true }),
    lastRejectedCount: integer(input.lastRejectedCount, "source.lastRejectedCount", { optional: true }),
    lastError: input.lastError === undefined || input.lastError === null
      ? null
      : text(input.lastError, "source.lastError", NOTICE_FIELD_LIMITS.contentText),
  };
}

function normalizeRun(input) {
  assertPlainObject(input, "run");
  const allowed = new Set([
    "id", "sourceId", "startedAt", "finishedAt", "status", "fetchedCount",
    "upsertedCount", "rejectedCount", "errorText",
  ]);
  assertAllowedKeys(input, allowed, "run");
  const startedAt = iso(input.startedAt, "run.startedAt");
  const finishedAt = iso(input.finishedAt, "run.finishedAt", { optional: true });
  if (finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) throw new TypeError("run.finishedAt is before run.startedAt");
  const status = text(input.status ?? "unknown", "run.status", 32).toLowerCase();
  if (!["running", "success", "partial", "failed"].includes(status)) {
    throw new TypeError("run.status is invalid");
  }
  return {
    id: text(input.id ?? `run-${Date.parse(startedAt)}`, "run.id", NOTICE_FIELD_LIMITS.id),
    sourceId: text(input.sourceId ?? "aggregate", "run.sourceId", NOTICE_FIELD_LIMITS.sourceId),
    startedAt,
    finishedAt,
    status,
    fetchedCount: integer(input.fetchedCount, "run.fetchedCount", { optional: true }),
    upsertedCount: integer(input.upsertedCount, "run.upsertedCount", { optional: true }),
    rejectedCount: integer(input.rejectedCount, "run.rejectedCount", { optional: true }),
    errorText: input.errorText === undefined || input.errorText === null
      ? null
      : text(input.errorText, "run.errorText", NOTICE_FIELD_LIMITS.contentText),
  };
}

export function normalizeHospitalTenderSyncPayload(input) {
  assertPlainObject(input, "snapshot");
  const allowed = new Set(["schemaVersion", "generatedAt", "notices", "sources", "runs"]);
  assertAllowedKeys(input, allowed, "snapshot");
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION && input.schemaVersion !== 1) {
    throw new TypeError("snapshot.schemaVersion is invalid");
  }
  const generatedAt = iso(input.generatedAt, "snapshot.generatedAt");
  if (!Array.isArray(input.notices) || input.notices.length > MAX_NOTICES_PER_SYNC) {
    throw new TypeError("snapshot.notices is invalid");
  }
  if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES_PER_SYNC) {
    throw new TypeError("snapshot.sources is invalid");
  }
  if (!Array.isArray(input.runs ?? []) || (input.runs ?? []).length > MAX_RUNS_PER_SYNC) {
    throw new TypeError("snapshot.runs is invalid");
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    notices: input.notices.map(normalizeIncomingNotice),
    sources: input.sources.map(normalizeSource),
    runs: (input.runs ?? []).map(normalizeRun),
  };
}

export function customerSnapshotFromRow(customer) {
  assertPlainObject(customer, "customer");
  const summaryTerms = typeof customer.summary === "string"
    ? customer.summary.split(/[，。；,.;\s]+/u).map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 20)
    : [];
  return {
    id: text(customer.id, "customer.id", 200),
    name: customer.name ?? "",
    city: customer.region ?? customer.city ?? "",
    aliases: arrayOfStrings(customer.aliases, "customer.aliases", 30, 200),
    hospitalNames: arrayOfStrings(customer.hospitalNames, "customer.hospitalNames", 30, 200),
    needs: arrayOfStrings(customer.needs, "customer.needs", 50, NOTICE_FIELD_LIMITS.matchedNeeds),
    requirements: arrayOfStrings(customer.requirements, "customer.requirements", 50, NOTICE_FIELD_LIMITS.matchedNeeds),
    painPoints: arrayOfStrings(customer.painPoints, "customer.painPoints", 50, NOTICE_FIELD_LIMITS.matchedNeeds),
    keywords: [
      ...arrayOfStrings(customer.keywords, "customer.keywords", 30, NOTICE_FIELD_LIMITS.matchReason),
      ...summaryTerms,
    ].slice(0, 30),
    tags: arrayOfStrings(customer.tags, "customer.tags", 30, NOTICE_FIELD_LIMITS.matchReason),
  };
}

export function serializeHospitalTenderNotice(item, customerNameById = new Map()) {
  if (!item || typeof item !== "object") return null;
  const match = normalizeNoticeMatch(item.match ?? {});
  return {
    id: item.id,
    identityKey: item.identityKey,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    city: item.city ?? "",
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    noticeType: item.noticeType,
    purchaser: item.purchaser ?? "",
    projectCode: item.projectCode ?? "",
    budgetText: item.budgetText ?? "",
    deadlineText: item.deadlineText ?? "",
    contentText: item.contentText ?? "",
    hospitalNames: Array.isArray(item.hospitalNames) ? item.hospitalNames : [],
    sourceItemId: item.sourceItemId ?? "",
    contentSha256: item.contentSha256 ?? digestContent(item.contentText),
    relevance: item.relevance,
    matchedCustomerIds: match.matchedCustomerIds,
    matchReasons: match.matchReasons,
    matchedNeeds: match.matchedNeeds,
    matchScore: match.matchScore,
    matchedCustomerNames: match.matchedCustomerIds
      .map((id) => customerNameById.get(id))
      .filter(Boolean),
    revision: Number(item.revision ?? 1),
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
  };
}

export function serializeHospitalTenderSource(item) {
  return {
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    city: item.city ?? "",
    status: item.status,
    lastRunAt: item.lastRunAt ?? null,
    lastSuccessAt: item.lastSuccessAt ?? null,
    itemCount: Number(item.lastItemCount ?? item.itemCount ?? 0),
    lastUpsertedCount: Number(item.lastUpsertedCount ?? 0),
    lastRejectedCount: Number(item.lastRejectedCount ?? 0),
    lastError: item.lastError ?? null,
    updatedAt: item.updatedAt,
  };
}

export function ingestHospitalTenderSnapshot({
  repository,
  payload,
  customers = [],
  mergeMatches = false,
  persistSources = true,
  persistRuns = true,
  persistAggregateRun = true,
} = {}) {
  if (!repository || typeof repository.upsertNotice !== "function") {
    throw new TypeError("repository is required");
  }
  const snapshot = normalizeHospitalTenderSyncPayload(payload);
  if (!Array.isArray(customers)) throw new TypeError("customers must be an array");
  const customerSnapshots = customers.map(customerSnapshotFromRow);
  const accepted = [];
  const rejected = [];
  for (const notice of snapshot.notices) {
    try {
      const match = matchNoticeToCustomers(notice, customerSnapshots);
      accepted.push(repository.upsertNotice(notice, match, { mergeExistingMatch: mergeMatches }));
    } catch (error) {
      rejected.push({ identityKey: notice.identityKey, code: "invalid_notice", message: error.message });
    }
  }
  if (persistSources) {
    for (const source of snapshot.sources) {
      repository.upsertSourceHealth(source);
    }
  }
  if (persistRuns) {
    for (const run of snapshot.runs) {
      repository.recordRun(run);
    }
  }
  if (persistAggregateRun && persistRuns && snapshot.runs.length === 0) {
    repository.recordRun({
      id: `sync-${Date.parse(snapshot.generatedAt)}`,
      sourceId: "aggregate",
      startedAt: snapshot.generatedAt,
      finishedAt: snapshot.generatedAt,
      status: rejected.length > 0 ? "partial" : "success",
      fetchedCount: snapshot.notices.length,
      upsertedCount: accepted.length,
      rejectedCount: rejected.length,
      errorText: rejected.length > 0 ? "invalid notice" : null,
    });
  }
  return {
    generatedAt: snapshot.generatedAt,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    notices: accepted,
    rejected,
  };
}

export { NOTICE_TYPES, RELEVANCE_LEVELS, SNAPSHOT_SCHEMA_VERSION };
