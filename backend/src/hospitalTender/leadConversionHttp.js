import { HttpError } from "../http/errors.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const NOTICE_ID_MAX = 200;
const CUSTOMER_ID_MAX = 200;
const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });
const ROUTE_PATTERN = /^\/api\/hospital-tenders\/([^/]+)\/lead-conversion\/(preview|confirm|cancel)$/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: "required" });
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: "max" });
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: "format" });
  }
  return normalized;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { noticeId: "format" });
  }
}

function parseRoute(pathname) {
  if (typeof pathname !== "string") return null;
  const match = ROUTE_PATTERN.exec(pathname);
  if (!match) return null;
  return Object.freeze({
    noticeId: requiredText(decodePathSegment(match[1]), "noticeId", NOTICE_ID_MAX),
    action: match[2],
  });
}

function assertUser(requestIdentity) {
  if (!requestIdentity || requestIdentity.kind !== "user") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication is required");
  }
  return requiredText(requestIdentity.account, "owner", 200);
}

function assertBody(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { body: "object" });
  }
  return body;
}

function assertAllowedKeys(body, allowed) {
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) fields[key] = "unknown";
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
  }
}

function validateInput(action, body) {
  const value = assertBody(body);
  if (action === "preview") {
    assertAllowedKeys(value, new Set(["customerId"]));
    return {
      customerId: requiredText(value.customerId, "customerId", CUSTOMER_ID_MAX),
    };
  }

  if (action === "confirm") {
    assertAllowedKeys(value, new Set(["customerId", "previewDigest", "confirmed"]));
    const customerId = requiredText(value.customerId, "customerId", CUSTOMER_ID_MAX);
    const previewDigest = requiredText(value.previewDigest, "previewDigest", 64);
    if (!DIGEST_PATTERN.test(previewDigest)) {
      throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { previewDigest: "format" });
    }
    if (value.confirmed !== true) {
      throw new HttpError(422, "CONFIRMATION_REQUIRED", "Explicit human confirmation is required before creating records");
    }
    return { customerId, previewDigest, confirmed: true };
  }

  assertAllowedKeys(value, new Set(["customerId", "previewDigest", "cancel"]));
  const customerId = requiredText(value.customerId, "customerId", CUSTOMER_ID_MAX);
  const previewDigest = requiredText(value.previewDigest, "previewDigest", 64);
  if (!DIGEST_PATTERN.test(previewDigest)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { previewDigest: "format" });
  }
  if (value.cancel !== true) {
    throw new HttpError(422, "CANCELLATION_REQUIRED", "Explicit cancellation is required");
  }
  return { customerId, previewDigest };
}

/**
 * HTTP-facing adapter for the hospital-tender lead conversion service.
 *
 * The adapter deliberately does not know the database or authentication
 * implementation.  A caller supplies a user identity and the adapter injects
 * that account as `owner`; request bodies can never choose or override it.
 * The same service instance can therefore be mounted by the web API and by
 * another channel (for example the assistant) without duplicating write
 * semantics.
 */
export function createHospitalTenderLeadConversionHttpHandlers({ service } = {}) {
  if (!service
    || typeof service.preview !== "function"
    || typeof service.confirm !== "function"
    || typeof service.cancel !== "function") {
    throw new TypeError("lead conversion service is required");
  }

  function matches(pathname) {
    return parseRoute(pathname) !== null;
  }

  function handle({
    method = "POST",
    pathname,
    requestIdentity,
    requestId = null,
    body = {},
  } = {}) {
    const route = parseRoute(pathname);
    if (!route) return null;
    if (method !== "POST") {
      const error = new HttpError(
        405,
        "METHOD_NOT_ALLOWED",
        "Only POST is allowed for hospital tender lead conversion",
      );
      error.headers = Object.freeze({ Allow: "POST" });
      throw error;
    }
    const owner = assertUser(requestIdentity);
    const input = validateInput(route.action, body);
    const serviceInput = {
      owner,
      noticeId: route.noticeId,
      ...(typeof requestId === "string" && requestId.trim()
        ? { requestId: requiredText(requestId, "requestId", 200) }
        : {}),
      ...input,
    };
    const item = route.action === "preview"
      ? service.preview(serviceInput)
      : route.action === "confirm"
        ? service.confirm(serviceInput)
        : service.cancel(serviceInput);
    return Object.freeze({
      status: 200,
      headers: NO_STORE_HEADERS,
      body: Object.freeze({
        requestId: requestId ?? null,
        item,
      }),
    });
  }

  return Object.freeze({ matches, handle });
}

export const hospitalTenderLeadConversionRoutePattern = ROUTE_PATTERN;
