import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError } from "./errors.js";

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

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
    "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token,Idempotency-Key,If-Match",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

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
