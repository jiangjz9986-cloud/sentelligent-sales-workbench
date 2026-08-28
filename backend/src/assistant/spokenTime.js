// Future-oriented spoken-time resolution for todo reminders (v0.7.5).
// spokenDate.js (v0.7.3) covers past-oriented capture/search words; this
// module owns the future vocabulary (明天/下周X/时刻/截止) plus time-of-day
// parsing. Calendar math is anchored to Asia/Shanghai with the same Intl
// pattern; the small date utilities are intentionally self-contained so the
// two vocabularies can evolve independently (see design D2).

const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const WEEKDAY_OFFSETS = Object.freeze({
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
});
const WEEKDAY_LABELS = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
const LATE_EVENING_HOUR = 20;
const DEFAULT_MORNING = Object.freeze({ hour: 9, minute: 0 });
const DEFAULT_EVENING = Object.freeze({ hour: 20, minute: 0 });

const businessFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function validNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a valid date");
  return date;
}

function businessParts(now) {
  const parts = businessFormatter.formatToParts(validNow(now));
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const date = `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
  if (!DATE_ONLY.test(date)) throw new TypeError("business date is invalid");
  return { date, hour: Number(valueOf("hour")), minute: Number(valueOf("minute")) };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekdayOf(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function monthEndOf(date) {
  const start = new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`);
  start.setUTCMonth(start.getUTCMonth() + 1);
  start.setUTCDate(start.getUTCDate() - 1);
  return start.toISOString().slice(0, 10);
}

function calendarDate(year, month, day) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const text = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

const CHINESE_DIGITS = Object.freeze({
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
});

function chineseNumber(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (/^\d{1,2}$/u.test(value)) return Number(value);
  const match = value.match(/^([一两二三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (match) return (match[1] ? CHINESE_DIGITS[match[1]] : 1) * 10 + (match[2] ? CHINESE_DIGITS[match[2]] : 0);
  if (Object.hasOwn(CHINESE_DIGITS, value)) return CHINESE_DIGITS[value];
  return null;
}

const DATE_WORD_SOURCE = "(?:大后天|后天|明晚|明早|明天|今晚|今天|(?:下周|下星期|本周|这周|周|星期)[一二三四五六日天]|\\d{1,2}月\\d{1,2}[日号]|\\d{1,3}天[后内]|月底|\\d{1,2}号)";
const CLOCK_WORD_SOURCE = "(?:(上午|早上|中午|下午|晚上)?\\s*((?:[一两二三四五六七八九]?十[一二三四五六七八九]?)|[一两二三四五六七八九]|\\d{1,2})[点时](半|一刻|(?:(?:[一两二三四五六七八九]?十[一二三四五六七八九]?)|[零一两二三四五六七八九]|\\d{1,2})分?)?|(\\d{1,2}):(\\d{2})|中午)";
const INSTANT_RE = new RegExp(
  `(${DATE_WORD_SOURCE})?\\s*(?:的)?\\s*(${CLOCK_WORD_SOURCE})?\\s*(之?前|以前)?`,
  "u",
);

function resolveFutureDate(word, business) {
  const today = business.date;
  if (word === "今天" || word === "今晚") return today;
  if (word === "明天" || word === "明早" || word === "明晚") return addDays(today, 1);
  if (word === "后天") return addDays(today, 2);
  if (word === "大后天") return addDays(today, 3);
  const weekday = word.match(/^(下周|下星期|本周|这周|周|星期)([一二三四五六日天])$/u);
  if (weekday) {
    const targetOffset = WEEKDAY_OFFSETS[weekday[2]];
    const mondayOffset = (weekdayOf(today) + 6) % 7;
    const weekStart = addDays(today, -mondayOffset);
    if (weekday[1] === "下周" || weekday[1] === "下星期") return addDays(weekStart, 7 + targetOffset);
    if (weekday[1] === "本周" || weekday[1] === "这周") return addDays(weekStart, targetOffset);
    // Bare 周X / 星期X means the nearest future weekday; the same weekday
    // stays today unless the evening is nearly over.
    let delta = (targetOffset - mondayOffset + 7) % 7;
    if (delta === 0 && business.hour >= LATE_EVENING_HOUR) delta = 7;
    return addDays(today, delta);
  }
  const monthDay = word.match(/^(\d{1,2})月(\d{1,2})[日号]$/u);
  if (monthDay) return calendarDate(Number(today.slice(0, 4)), Number(monthDay[1]), Number(monthDay[2]));
  const bareDay = word.match(/^(\d{1,2})号$/u);
  if (bareDay) {
    const candidate = calendarDate(Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(bareDay[1]));
    if (!candidate) return null;
    if (candidate >= today) return candidate;
    const nextMonth = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    return calendarDate(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, Number(bareDay[1]));
  }
  const relativeDays = word.match(/^(\d{1,3})天[后内]$/u);
  if (relativeDays) return addDays(today, Number(relativeDays[1]));
  if (word === "月底") return monthEndOf(today);
  return null;
}

function resolveClock(clockMatch, dateWord) {
  if (!clockMatch) {
    if (dateWord === "今晚" || dateWord === "明晚") return { ...DEFAULT_EVENING, explicit: false };
    if (dateWord === "明早") return { ...DEFAULT_MORNING, explicit: false };
    return null;
  }
  const [, period, hourWord, minuteWord, hhText, mmText] = clockMatch;
  if (hhText !== undefined) {
    const hour = Number(hhText);
    const minute = Number(mmText);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicit: true };
  }
  if (hourWord === undefined) {
    // Bare 中午 with no hour digits.
    return clockMatch[0].includes("中午") ? { hour: 12, minute: 0, explicit: true } : null;
  }
  let hour = chineseNumber(hourWord);
  if (hour === null || hour > 24) return null;
  let minute = 0;
  if (minuteWord === "半") minute = 30;
  else if (minuteWord === "一刻") minute = 15;
  else if (minuteWord) {
    minute = chineseNumber(minuteWord.replace(/分$/u, ""));
    if (minute === null || minute > 59) return null;
  }
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour <= 2) hour += 12;
  if (hour === 24) hour = 0;
  if (hour > 23) return null;
  return { hour, minute, explicit: true };
}

function instantIso(date, clock) {
  const hh = String(clock.hour).padStart(2, "0");
  const mm = String(clock.minute).padStart(2, "0");
  const parsed = new Date(`${date}T${hh}:${mm}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function displayOf(date, clock) {
  const weekday = WEEKDAY_LABELS[weekdayOf(date)];
  const hh = String(clock.hour).padStart(2, "0");
  const mm = String(clock.minute).padStart(2, "0");
  return `${date.slice(5)}（${weekday}）${hh}:${mm}`;
}

/**
 * Parse the first spoken future instant in the text. Returns
 * { matched:false } when nothing parseable exists; otherwise
 * { matched, iso, date, displayText, deadline, hasTime, token }.
 */
export function parseSpokenInstant(text, now) {
  const value = String(text ?? "");
  if (!value.trim()) return { matched: false };
  const business = businessParts(now);
  const dateRe = new RegExp(DATE_WORD_SOURCE, "u");
  const clockRe = new RegExp(CLOCK_WORD_SOURCE, "u");
  const dateMatch = value.match(dateRe);
  const clockProbe = value.match(clockRe);
  if (!dateMatch && !clockProbe) return { matched: false };

  let tokenStart;
  let tokenEnd;
  let dateWord = null;
  let clockMatch = null;
  if (dateMatch) {
    dateWord = dateMatch[0];
    tokenStart = dateMatch.index;
    tokenEnd = dateMatch.index + dateWord.length;
    // A clock phrase counts only when it directly follows the date word
    // (optionally joined by 的/whitespace); a distant clock elsewhere in the
    // sentence is unrelated (e.g. title text).
    const tail = value.slice(tokenEnd);
    const joined = tail.match(new RegExp(`^\\s*(?:的)?\\s*(${CLOCK_WORD_SOURCE})`, "u"));
    if (joined) {
      clockMatch = joined[1].match(new RegExp(`^${CLOCK_WORD_SOURCE}$`, "u"));
      tokenEnd += joined[0].length;
    }
  } else {
    clockMatch = clockProbe[0].match(new RegExp(`^${CLOCK_WORD_SOURCE}$`, "u"));
    tokenStart = clockProbe.index;
    tokenEnd = clockProbe.index + clockProbe[0].length;
  }

  let deadline = false;
  const deadlineTail = value.slice(tokenEnd).match(/^\s*(之?前|以前)/u);
  if (deadlineTail) {
    deadline = true;
    tokenEnd += deadlineTail[0].length;
  }
  if (dateWord && /天内$/u.test(dateWord)) deadline = true;

  let date = dateWord ? resolveFutureDate(dateWord, business) : null;
  if (dateWord && !date) return { matched: false };
  const clock = resolveClock(clockMatch, dateWord) ?? { ...DEFAULT_MORNING, explicit: false };
  if (clockMatch && resolveClock(clockMatch, dateWord) === null) return { matched: false };
  if (!date) {
    // Time-only phrase: today when the moment is still ahead, otherwise
    // tomorrow.
    const todayCandidate = business.hour * 60 + business.minute
      < clock.hour * 60 + clock.minute
      ? business.date
      : addDays(business.date, 1);
    date = todayCandidate;
  }
  const iso = instantIso(date, clock);
  if (!iso) return { matched: false };
  return {
    matched: true,
    iso,
    date,
    displayText: displayOf(date, clock),
    deadline,
    hasTime: Boolean(clock.explicit),
    token: value.slice(tokenStart, tokenEnd),
  };
}

/**
 * Resolve a future-oriented list-range word to an inclusive business-date
 * window, or null for unknown words. Used by the todo list intent.
 */
export function resolveFutureRange(word, now) {
  const value = String(word ?? "").trim();
  if (!value) return null;
  const business = businessParts(now);
  const today = business.date;
  const mondayOffset = (weekdayOf(today) + 6) % 7;
  if (value === "今天" || value === "今日") return { start: today, end: today };
  if (value === "明天") return { start: addDays(today, 1), end: addDays(today, 1) };
  if (value === "本周" || value === "这周") {
    const monday = addDays(today, -mondayOffset);
    return { start: monday, end: addDays(monday, 6) };
  }
  if (value === "下周") {
    const monday = addDays(today, -mondayOffset + 7);
    return { start: monday, end: addDays(monday, 6) };
  }
  if (value === "最近") return { start: today, end: addDays(today, 13) };
  return null;
}

/**
 * Scan text for the first future instant, returning the parsed instant plus
 * the remaining text with the matched phrase excised (for title extraction).
 */
export function extractSpokenInstant(text, now) {
  const value = String(text ?? "");
  const instant = parseSpokenInstant(value, now);
  if (!instant.matched) return { instant: null, remainder: value.trim() };
  const remainder = value.replace(instant.token, " ").replaceAll(/\s+/gu, " ").trim();
  return { instant, remainder };
}
