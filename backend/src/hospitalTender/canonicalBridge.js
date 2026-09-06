import { createHash } from "node:crypto";

/**
 * The 0043 migration deliberately keeps the bridge table small.  This module
 * owns the value-level rules shared by notice ingestion, repository reads and
 * lead conversion so those paths cannot silently invent different identities
 * or digests.
 */

export const BRIDGE_STATUSES = Object.freeze([
  "unconverted",
  "previewed",
  "confirmed",
  "cancelled",
  "conflict",
]);

export const NOTICE_BRIDGE_STATUS_UNBRIDGED = "unbridged";
export const CANONICAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
export const CANONICAL_NOTICE_ID_MAX = 500;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function textValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).normalize("NFKC").trim();
  return normalized || null;
}

function digestText(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedIdentityPart(value) {
  const normalized = textValue(value);
  if (!normalized) return null;
  return normalized
    .toLocaleLowerCase("zh-Hans-CN")
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, "");
}

function canonicalTimestamp(value) {
  const normalized = textValue(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? normalized : new Date(timestamp).toISOString();
}

function readValue(input, camel, snake) {
  if (Object.hasOwn(input, camel)) return input[camel];
  if (snake && Object.hasOwn(input, snake)) return input[snake];
  return undefined;
}

function normalizedArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(textValue).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function boundedCanonicalId(value) {
  const normalized = textValue(value);
  if (!normalized) return null;
  if (normalized.length > CANONICAL_NOTICE_ID_MAX) {
    throw new TypeError("canonicalNoticeId is too long");
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new TypeError("canonicalNoticeId contains control characters");
  }
  return normalized;
}

/** Return a normalized, lowercase SHA-256 digest or null for legacy values. */
export function normalizeSha256(value, name = "digest") {
  const normalized = textValue(value);
  if (!normalized) return null;
  if (!CANONICAL_DIGEST_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a SHA-256 hex digest`);
  }
  return normalized.toLowerCase();
}

export function isSha256(value) {
  return typeof value === "string" && CANONICAL_DIGEST_PATTERN.test(value);
}

export function contentDigest(value) {
  return digestText(textValue(value) ?? "");
}

/**
 * Produce lookup candidates in priority order.  An explicit upstream
 * canonical id wins.  Project code and the source-independent notice
 * fingerprint let two collectors converge even when their source ids and
 * URLs differ; identityKey remains the lossless fallback for notices that do
 * not carry enough cross-source evidence.
 */
export function canonicalNoticeIdentityCandidates(input = {}) {
  if (!isPlainObject(input)) throw new TypeError("notice must be an object");

  const explicit = boundedCanonicalId(
    readValue(input, "canonicalNoticeId", "canonical_notice_id")
      ?? readValue(input, "canonicalId", "canonical_id")
      ?? readValue(input, "canonicalIdentity", "canonical_identity"),
  );
  const identityKey = boundedCanonicalId(readValue(input, "identityKey", "identity_key"));
  const purchaser = normalizedIdentityPart(readValue(input, "purchaser"));
  const projectCode = normalizedIdentityPart(readValue(input, "projectCode", "project_code"));
  const projectCandidates = [];
  if (projectCode) {
    if (purchaser) {
      projectCandidates.push(`project:${digestText(`${purchaser}|${projectCode}`).slice(0, 48)}`);
    } else {
      projectCandidates.push(`project-code:${digestText(projectCode).slice(0, 48)}`);
    }
  }

  const title = normalizedIdentityPart(readValue(input, "title"));
  const city = normalizedIdentityPart(readValue(input, "city"));
  const hospitals = normalizedArray(readValue(input, "hospitalNames", "hospital_names_json"))
    .map(normalizedIdentityPart)
    .filter(Boolean);
  const publishedAt = canonicalTimestamp(readValue(input, "publishedAt", "published_at"));
  const fingerprintParts = [title, purchaser, city, publishedAt, ...hospitals].filter(Boolean);
  const fingerprint = fingerprintParts.length >= 2
    ? `fingerprint:${digestText(canonicalJson(fingerprintParts)).slice(0, 48)}`
    : null;

  return [...new Set([
    explicit,
    ...projectCandidates,
    fingerprint,
    identityKey,
  ].filter(Boolean))];
}

export function canonicalNoticeIdentity(input = {}) {
  const [first] = canonicalNoticeIdentityCandidates(input);
  if (!first) throw new TypeError("identityKey is required");
  return first;
}

/**
 * Canonical content excludes collector-specific routing fields (source id,
 * source name, source item id and URL), matching evidence, and ingestion
 * timestamps.  Those fields may change while the underlying tender notice is
 * unchanged.  The persisted business content and notice metadata remain
 * bound, so a corrected title, deadline, budget or body advances revision.
 */
export function canonicalNoticeSnapshot(input = {}, { canonicalNoticeId = null } = {}) {
  if (!isPlainObject(input)) throw new TypeError("notice must be an object");
  const resolvedCanonicalId = boundedCanonicalId(canonicalNoticeId)
    ?? canonicalNoticeIdentity(input);
  const contentText = textValue(readValue(input, "contentText", "content_text"));
  return {
    canonicalNoticeId: resolvedCanonicalId,
    city: textValue(readValue(input, "city")),
    title: textValue(readValue(input, "title")),
    publishedAt: canonicalTimestamp(readValue(input, "publishedAt", "published_at")),
    noticeType: textValue(readValue(input, "noticeType", "notice_type")),
    purchaser: textValue(readValue(input, "purchaser")),
    projectCode: textValue(readValue(input, "projectCode", "project_code")),
    budgetText: textValue(readValue(input, "budgetText", "budget_text")),
    deadlineText: textValue(readValue(input, "deadlineText", "deadline_text")),
    contentText,
    contentSha256: contentDigest(contentText),
    hospitalNames: normalizedArray(readValue(input, "hospitalNames", "hospital_names_json")),
  };
}

export function canonicalNoticeDigest(input = {}, options = {}) {
  return digestText(canonicalJson(canonicalNoticeSnapshot(input, options)));
}

function normalizeStatus(value) {
  const normalized = textValue(value) ?? "unconverted";
  if (!BRIDGE_STATUSES.includes(normalized)) throw new TypeError("bridge status is invalid");
  return normalized;
}

export function normalizeBridgeRef(value) {
  if (!isPlainObject(value)) return null;
  const id = textValue(value.id);
  const owner = textValue(value.owner);
  const canonicalNoticeId = textValue(value.canonicalNoticeId ?? value.canonical_notice_id);
  const customerId = textValue(value.customerId ?? value.customer_id);
  if (!id || !owner || !canonicalNoticeId || !customerId) return null;
  const noticeDigest = textValue(value.noticeDigest ?? value.notice_digest);
  const noticeRevision = Number(value.noticeRevision ?? value.notice_revision ?? 1);
  if (!Number.isSafeInteger(noticeRevision) || noticeRevision < 1) return null;
  const previewDigestValue = textValue(value.previewDigest ?? value.preview_digest);
  return {
    id,
    owner,
    canonicalNoticeId,
    customerId,
    status: normalizeStatus(value.status),
    noticeRevision,
    noticeDigest: isSha256(noticeDigest) ? noticeDigest.toLowerCase() : null,
    opportunityId: textValue(value.opportunityId ?? value.opportunity_id),
    actionItemId: textValue(value.actionItemId ?? value.action_item_id),
    previewDigest: isSha256(previewDigestValue)
      ? previewDigestValue.toLowerCase()
      : null,
    createdAt: textValue(value.createdAt ?? value.created_at),
    updatedAt: textValue(value.updatedAt ?? value.updated_at),
  };
}

export function parseBridgeRefs(value) {
  if (Array.isArray(value)) return value.map(normalizeBridgeRef).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(normalizeBridgeRef).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function bridgeFromRow(row) {
  if (!row) return null;
  return normalizeBridgeRef({
    id: row.id,
    owner: row.owner,
    canonicalNoticeId: row.canonical_notice_id,
    customerId: row.customer_id,
    status: row.status,
    noticeRevision: row.notice_revision,
    noticeDigest: row.notice_digest,
    opportunityId: row.opportunity_id,
    actionItemId: row.action_item_id,
    previewDigest: row.preview_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function bridgeStatusForRefs(refs = []) {
  const normalized = parseBridgeRefs(refs);
  if (normalized.length === 0) return NOTICE_BRIDGE_STATUS_UNBRIDGED;
  if (normalized.some((ref) => ref.status === "conflict")) return "conflict";
  if (normalized.some((ref) => ref.status === "confirmed")) return "confirmed";
  if (normalized.some((ref) => ref.status === "previewed")) return "previewed";
  if (normalized.some((ref) => ref.status === "unconverted")) return "unconverted";
  return "cancelled";
}

export function bridgeRefsJson(refs = []) {
  return JSON.stringify(parseBridgeRefs(refs));
}

export function stableDigest(value) {
  return digestText(canonicalJson(value));
}

export function hospitalTenderBridgeId({ owner, canonicalNoticeId, customerId } = {}) {
  const normalizedOwner = textValue(owner);
  const normalizedCanonicalId = boundedCanonicalId(canonicalNoticeId);
  const normalizedCustomerId = textValue(customerId);
  if (!normalizedOwner) throw new TypeError("owner is required");
  if (!normalizedCanonicalId) throw new TypeError("canonicalNoticeId is required");
  if (!normalizedCustomerId) throw new TypeError("customerId is required");
  return `hospital-tender-bridge-${stableDigest([
    normalizedOwner,
    normalizedCanonicalId,
    normalizedCustomerId,
  ]).slice(0, 32)}`;
}
