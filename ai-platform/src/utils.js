import { randomUUID, timingSafeEqual } from "node:crypto";

export function iso(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

export function json(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function stringify(value, fallback = "{}") {
  try { return JSON.stringify(value); } catch { return fallback; }
}

export function id(prefix = "id") {
  return `${prefix}-${randomUUID()}`;
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function periodKey(dateValue, period, timeZone = "Asia/Shanghai") {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) throw new TypeError("dateValue must be a valid date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (period === "monthly") return `${fields.year}-${fields.month}`;
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function safeLimit(value, fallback = 50, max = 100) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new TypeError("limit is invalid");
  return parsed;
}

export function safeOffset(value, fallback = 0, max = 100_000) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new TypeError("offset is invalid");
  return parsed;
}

export function withImmediateTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}
