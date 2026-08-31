import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError } from "./errors.js";

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CORS_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CORS_ALLOWED_REQUEST_HEADERS = Object.freeze([
  "Content-Type",
  "X-CSRF-Token",
  "Idempotency-Key",
  "If-Match",
  "X-Audio-Duration-Ms",
  "X-ASR-Language",
]);
const CORS_EXPOSED_RESPONSE_HEADERS = Object.freeze([
  "Content-Disposition",
  "Retry-After",
]);
const CORS_ALLOWED_REQUEST_HEADER_NAMES = new Set(
  CORS_ALLOWED_REQUEST_HEADERS.map((name) => name.toLowerCase()),
);

function decodeCookiePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  if (typeof header !== "string" || !header) return {};

  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;

    const name = decodeCookiePart(part.slice(0, separator).trim());
    const value = decodeCookiePart(part.slice(separator + 1).trim());
    if (!name || value === null) continue;
    cookies[name] = value;
  }
  return cookies;
}

function rejectHeaderBreaks(value, label) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new TypeError(`${label} must not contain CRLF characters`);
  }
}

export function buildSessionCookie(config, value, { clear = false } = {}) {
  const name = config?.authCookieName;
  rejectHeaderBreaks(name, "Cookie name");
  if (!COOKIE_NAME.test(name)) throw new TypeError("Cookie name is invalid");
  if (!clear) rejectHeaderBreaks(value, "Cookie value");

  const encodedValue = clear ? "" : encodeURIComponent(value);
  const attributes = [
    `${name}=${encodedValue}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${clear ? 0 : COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (config?.authCookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

export function corsHeaders(origin, config = {}) {
  if (origin === undefined || origin === null || origin === "") return {};

  const allowedOrigins = Array.isArray(config.corsAllowedOrigins)
    ? config.corsAllowedOrigins
    : [];
  if (!allowedOrigins.includes(origin)) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed");
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": CORS_EXPOSED_RESPONSE_HEADERS.join(","),
    "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS.join(","),
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

/**
 * Validate `Access-Control-Request-Headers` against the fixed allowlist.  We
 * reject unknown, duplicate, empty or malformed names rather than reflecting
 * arbitrary browser input into an allow header.
 */
export function assertCorsPreflightRequestHeaders(value) {
  if (value === undefined || value === null || value === "") return Object.freeze([]);
  if (typeof value !== "string" || value.length > 1_024) {
    throw new HttpError(403, "CORS_HEADERS_NOT_ALLOWED", "Requested CORS headers are not allowed");
  }
  const names = value.split(",").map((name) => name.trim());
  const seen = new Set();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (
      !name
      || !CORS_HEADER_NAME.test(name)
      || seen.has(normalized)
      || !CORS_ALLOWED_REQUEST_HEADER_NAMES.has(normalized)
    ) {
      throw new HttpError(403, "CORS_HEADERS_NOT_ALLOWED", "Requested CORS headers are not allowed");
    }
    seen.add(normalized);
  }
  return Object.freeze([...seen]);
}

export const CORS_ALLOW_HEADERS = CORS_ALLOWED_REQUEST_HEADERS;
export const CORS_EXPOSE_HEADERS = CORS_EXPOSED_RESPONSE_HEADERS;

export function securityHeaders(config = {}) {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  };
  if (config.secure ?? config.authCookieSecure) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function csrfTokensMatch(token, expectedToken) {
  return Boolean(token && expectedToken && constantTimeEqual(token, expectedToken));
}

export function assertCsrfToken(token, expectedToken) {
  if (!csrfTokensMatch(token, expectedToken)) {
    throw new HttpError(403, "CSRF_INVALID", "CSRF token is invalid");
  }
}
