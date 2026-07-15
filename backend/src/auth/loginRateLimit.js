import { createHmac } from "node:crypto";

import { HttpError } from "../http/errors.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LIMITER_KEY = /^[A-Za-z0-9_-]{43}$/;

function limiterSecret(secret) {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new Error("Rate limit secret is required");
  }
  return secret;
}

function normalizedValue(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim().toLowerCase();
}

function validateKey(key) {
  if (typeof key !== "string" || !LIMITER_KEY.test(key)) {
    throw new Error("Key must be a valid limiter key");
  }
  return key;
}

function validateNow(now) {
  if (!Number.isSafeInteger(now) || Number.isNaN(new Date(now).getTime())) {
    throw new Error("now must be a valid timestamp");
  }
  return now;
}

function iso(now) {
  return new Date(now).toISOString();
}

function rowForKey(db, key) {
  return db.prepare(`
    SELECT failures, window_started_at AS windowStartedAt, blocked_until AS blockedUntil
    FROM login_rate_limits
    WHERE key = ?
  `).get(key);
}

function isWindowExpired(row, now) {
  const startedAt = Date.parse(row.windowStartedAt);
  return !Number.isFinite(startedAt) || now >= startedAt + WINDOW_MS;
}

export function loginRateLimitKey(secret, account, remoteAddress) {
  const keySecret = limiterSecret(secret);
  const normalizedAccount = normalizedValue(account, "Account");
  const normalizedAddress = normalizedValue(remoteAddress, "Remote address");
  return createHmac("sha256", keySecret)
    .update(`${normalizedAccount}|${normalizedAddress}`, "utf8")
    .digest("base64url");
}

export function assertLoginAllowed(db, key, now = Date.now()) {
  const limiterKey = validateKey(key);
  const currentTime = validateNow(now);
  const row = rowForKey(db, limiterKey);
  if (!row || !row.blockedUntil) return;

  const blockedUntil = Date.parse(row.blockedUntil);
  if (Number.isFinite(blockedUntil) && currentTime < blockedUntil) {
    throw new HttpError(429, "LOGIN_RATE_LIMITED", "Too many login attempts");
  }
}

export function recordLoginFailure(db, key, now = Date.now()) {
  const limiterKey = validateKey(key);
  const currentTime = validateNow(now);
  const row = rowForKey(db, limiterKey);
  const windowStartedAt = iso(currentTime);

  if (!row || isWindowExpired(row, currentTime)) {
    return db.prepare(`
      INSERT INTO login_rate_limits (key, failures, window_started_at, blocked_until)
      VALUES (:key, 1, :windowStartedAt, NULL)
      ON CONFLICT(key) DO UPDATE SET
        failures = 1,
        window_started_at = excluded.window_started_at,
        blocked_until = NULL
    `).run({ key: limiterKey, windowStartedAt });
  }

  const failures = row.failures + 1;
  const blockedUntil = failures >= MAX_FAILURES ? iso(currentTime + WINDOW_MS) : null;
  return db.prepare(`
    UPDATE login_rate_limits
    SET failures = :failures,
        blocked_until = :blockedUntil
    WHERE key = :key
  `).run({ key: limiterKey, failures, blockedUntil });
}

export function clearLoginFailures(db, key) {
  return db.prepare("DELETE FROM login_rate_limits WHERE key = ?").run(validateKey(key));
}

export function pruneLoginRateLimits(db, now = Date.now()) {
  const currentTime = validateNow(now);
  return db.prepare(`
    DELETE FROM login_rate_limits
    WHERE (blocked_until IS NOT NULL AND blocked_until <= :now)
       OR (blocked_until IS NULL AND window_started_at <= :windowCutoff)
  `).run({
    now: iso(currentTime),
    windowCutoff: iso(currentTime - WINDOW_MS),
  });
}
