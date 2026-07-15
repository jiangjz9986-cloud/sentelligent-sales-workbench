function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getCurrentWeekRange(input = new Date()) {
  const current = new Date(input);
  const safeDate = Number.isNaN(current.getTime()) ? new Date() : current;
  const day = safeDate.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(safeDate);
  start.setHours(0, 0, 0, 0);
  start.setDate(safeDate.getDate() + mondayOffset);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return {
    periodStart: toLocalDateString(start),
    periodEnd: toLocalDateString(end),
  };
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3],
  };
}

function formatDatePart(parts, includeYear) {
  if (includeYear) return `${parts.year}.${parts.month}.${parts.day}`;
  return `${parts.month}.${parts.day}`;
}

export function formatWeekRangeLabel(range) {
  const start = parseDateParts(range?.periodStart);
  const end = parseDateParts(range?.periodEnd);
  if (!start || !end) return "本周";

  const includeYear = start.year !== end.year;
  return `${formatDatePart(start, includeYear)}-${formatDatePart(end, includeYear)}`;
}
