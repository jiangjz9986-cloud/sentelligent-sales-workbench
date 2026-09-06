// Spoken-date resolution for quick-record capture and search (v0.7.3).
// All calendar math is anchored to the Asia/Shanghai business timezone using
// the same Intl-based pattern as businessSnapshotAdapter. The bookkeeping
// correction parser (integrations/shortcutBookkeepingIntent.js friendlyDates)
// solves a narrower single-day problem coupled to draft weeks and is not
// reusable here; keep both implementations aligned by intent, not by code.

const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const WEEKDAY_OFFSETS = Object.freeze({
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
});
const RECENT_DAYS = 14;

const businessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function validNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a valid date");
  return date;
}

function businessDateOf(now) {
  const parts = businessDateFormatter.formatToParts(validNow(now));
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const normalized = `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
  if (!DATE_ONLY.test(normalized)) throw new TypeError("business date is invalid");
  return normalized;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekStartOf(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const offset = (value.getUTCDay() + 6) % 7;
  return addDays(date, -offset);
}

function monthStartOf(date) {
  return `${date.slice(0, 7)}-01`;
}

function monthEndOf(date) {
  const start = new Date(`${monthStartOf(date)}T00:00:00.000Z`);
  start.setUTCMonth(start.getUTCMonth() + 1);
  start.setUTCDate(start.getUTCDate() - 1);
  return start.toISOString().slice(0, 10);
}

function previousMonthRange(date) {
  const currentStart = new Date(`${monthStartOf(date)}T00:00:00.000Z`);
  currentStart.setUTCDate(currentStart.getUTCDate() - 1);
  const lastDayOfPreviousMonth = currentStart.toISOString().slice(0, 10);
  return { start: monthStartOf(lastDayOfPreviousMonth), end: lastDayOfPreviousMonth };
}

function calendarDate(year, month, day) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const text = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

/**
 * Resolve a spoken single-day word to a YYYY-MM-DD business date, or null
 * when the word is not a recognized date expression.
 */
export function resolveSpokenDate(word, now) {
  const value = String(word ?? "").trim();
  if (!value) return null;
  const today = businessDateOf(now);
  if (value === "今天") return today;
  if (value === "昨天") return addDays(today, -1);
  if (value === "前天") return addDays(today, -2);
  const weekday = value.match(/^(上上周|上周|本周|这周)([一二三四五六日天])$/u);
  if (weekday) {
    const base = weekStartOf(today);
    const weekOffset = weekday[1] === "上上周" ? -14 : weekday[1] === "上周" ? -7 : 0;
    return addDays(base, weekOffset + WEEKDAY_OFFSETS[weekday[2]]);
  }
  const monthDay = value.match(/^(\d{1,2})月(\d{1,2})[日号]$/u);
  if (monthDay) {
    return calendarDate(Number(today.slice(0, 4)), Number(monthDay[1]), Number(monthDay[2]));
  }
  const daysAgo = value.match(/^(\d{1,3})天前$/u);
  if (daysAgo) return addDays(today, -Number(daysAgo[1]));
  return null;
}

/**
 * Resolve a spoken period word to an inclusive { start, end } business-date
 * range, or null when the word is not a recognized period expression.
 */
export function resolveSpokenRange(word, now) {
  const value = String(word ?? "").trim();
  if (!value) return null;
  const today = businessDateOf(now);
  if (value === "今天" || value === "昨天" || value === "前天") {
    const date = resolveSpokenDate(value, now);
    return { start: date, end: date };
  }
  if (value === "上上周") {
    const start = addDays(weekStartOf(today), -14);
    return { start, end: addDays(start, 6) };
  }
  if (value === "上周") {
    const start = addDays(weekStartOf(today), -7);
    return { start, end: addDays(start, 6) };
  }
  if (value === "本周" || value === "这周") {
    const start = weekStartOf(today);
    return { start, end: addDays(start, 6) };
  }
  if (value === "上月" || value === "上个月") return previousMonthRange(today);
  if (value === "本月") return { start: monthStartOf(today), end: monthEndOf(today) };
  if (value === "最近") return { start: addDays(today, -(RECENT_DAYS - 1)), end: today };
  const singleDay = resolveSpokenDate(value, now);
  if (singleDay) return { start: singleDay, end: singleDay };
  return null;
}

/**
 * Convert a YYYY-MM-DD business date to the canonical occurred-at instant
 * (noon Asia/Shanghai) accepted by the quick-record pipeline.
 */
export function spokenDateToIso(date) {
  const value = String(date ?? "").trim();
  if (!DATE_ONLY.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

const OCCURRED_AT_PATTERN = /(前天|昨天|今天|上上周[一二三四五六日天]|上周[一二三四五六日天]|本周[一二三四五六日天]|这周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{1,3}天前)/u;

/**
 * Scan free capture text for the first unambiguous single-day expression and
 * return its ISO occurred-at instant, or null when none is present.
 */
export function extractSpokenOccurredAt(text, now) {
  const value = String(text ?? "");
  const match = value.match(OCCURRED_AT_PATTERN);
  if (!match) return null;
  const date = resolveSpokenDate(match[1], now);
  return date ? spokenDateToIso(date) : null;
}
