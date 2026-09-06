// Deterministic WeChat bodies for the queued digest outbox payloads. Both
// renderers are pure (no database access: a digest is a point-in-time
// snapshot, finalized at enqueue time) and fail closed on malformed payloads
// so the delivery worker never sends an empty or unbounded message — the same
// contract as the tender-notice and action-reminder renderers.

const MAX_MESSAGE_CHARS = 3500;
const MAX_SECTIONS = 8;
const MAX_SECTION_LINES = 14;
const MAX_LINE_CHARS = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const WEEKDAY_LABELS = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);

function validDateOnly(value, name) {
  if (typeof value !== "string" || !DATE_ONLY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function monthDayWithWeekday(dateOnly) {
  const weekday = WEEKDAY_LABELS[new Date(`${dateOnly}T00:00:00.000Z`).getUTCDay()];
  return `${dateOnly.slice(5)} ${weekday}`;
}

function normalizedSections(payload) {
  if (!Array.isArray(payload.sections) || payload.sections.length > MAX_SECTIONS) {
    throw new TypeError("digest sections are invalid");
  }
  const sections = [];
  for (const section of payload.sections) {
    if (!section || typeof section !== "object" || Array.isArray(section)) throw new TypeError("digest section is invalid");
    const heading = String(section.heading ?? "").trim();
    if (!heading || heading.length > 100) throw new TypeError("digest section heading is invalid");
    if (!Array.isArray(section.lines) || section.lines.length > MAX_SECTION_LINES) {
      throw new TypeError("digest section lines are invalid");
    }
    const lines = section.lines
      .filter((line) => typeof line === "string" && line.trim())
      .map((line) => line.trim().slice(0, MAX_LINE_CHARS));
    if (lines.length === 0) continue;
    sections.push({ heading, lines });
  }
  return sections;
}

function assembleMessage({ title, headline, sections, footer }) {
  const parts = [title];
  if (headline) parts.push(headline);
  for (const section of sections) {
    parts.push("", `■ ${section.heading}`, ...section.lines);
  }
  const footerText = String(footer ?? "").trim();
  if (!footerText || footerText.length > MAX_LINE_CHARS) throw new TypeError("digest footer is invalid");
  parts.push("——", footerText);
  const message = parts.join("\n");
  if (message.length > MAX_MESSAGE_CHARS) throw new Error("digest content too large");
  return message;
}

export function renderDailyDigestMessage(payload) {
  if (!payload || typeof payload !== "object" || payload.kind !== "daily_digest") {
    throw new TypeError("daily digest payload is invalid");
  }
  const digestDate = validDateOnly(payload.digestDate, "digestDate");
  const headline = payload.headline === null || payload.headline === undefined
    ? null
    : String(payload.headline).trim().slice(0, MAX_LINE_CHARS) || null;
  const sections = normalizedSections(payload);
  if (sections.length === 0) throw new Error("daily digest payload is empty");
  return assembleMessage({
    title: `【小小晨报】${monthDayWithWeekday(digestDate)}`,
    headline,
    sections,
    footer: payload.footer,
  });
}

export function renderFridayCloseoutMessage(payload) {
  if (!payload || typeof payload !== "object" || payload.kind !== "friday_closeout") {
    throw new TypeError("friday closeout payload is invalid");
  }
  validDateOnly(payload.digestDate, "digestDate");
  const weekStart = validDateOnly(payload.weekStart, "weekStart");
  const weekEndDate = new Date(`${weekStart}T00:00:00.000Z`);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);
  const sections = normalizedSections(payload);
  if (sections.length === 0) throw new Error("friday closeout payload is empty");
  return assembleMessage({
    title: `【小小周五收尾】本周 ${weekStart.slice(5)} ~ ${weekEnd.slice(5)}`,
    headline: null,
    sections,
    footer: payload.footer,
  });
}

export { MAX_MESSAGE_CHARS };
