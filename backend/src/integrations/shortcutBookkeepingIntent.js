import { parseShortcutBookkeepingCorrection } from "./shortcutBookkeepingAssistant.js";

export const SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION = "shortcut-bookkeeping-intent/v1";

const QUESTION = /[?？]|(?:吗|么|呢|是否|是不是|能否|可以不可以|可不可以)\s*$/u;
const CONFIRM = /^(?:(?:好的?|行|可以)[，,\s]+)?(?:确认|确定|同意|批准|记账|记下|入账|就这样|没问题|无误|正确|确认入账)(?:(?:这笔|该笔|本笔)?(?:记账|入账)?|一下|吧|了|并入账|并记账)?[。！!，,\s]*$/u;
const CANCEL = /^(?:(?:好的?|行|可以)[，,\s]+)?(?:取消|撤销|作废|不要了|不记了|不入账|拒绝|放弃)(?:(?:这笔|该笔|本笔)?(?:记账|入账)?|一下|吧|了)?[。！!，,\s]*$/u;
const WEAK = /^(?:嗯+|哦+|啊+|好+|行+|可以|好的|收到|知道了|谢谢|ok|OK|yes|是的)[。！!！\s]*$/u;
const LOAN = /借款|预借|借支/u;
const ASSIGN = /(?:归属|算作|算我|记我|分配|归我|由|给|记在|属于)/u;
const SCOPE = /(?:用于|对应|覆盖|绑定|分配到|归到)/u;
const REGION_LABEL = /(?:出差区域|差旅区域|负责区域|区域)/u;
const CORRECTION_PREFIX = /^(?:修改|更改|调整|设置|把|将|备注|说明|金额|日期|时间|商户|商家|用途|分类|子分类|费用类别)/u;
const CORRECTION_FIELD_PREFIX = /^(?:(?:修改|更改|调整|设置|把|将)\s*)?(?:备注|说明|金额|日期|时间|商户|商家|用途|分类|子分类|费用类别)/u;
const REGION_NON_CITY_LANGUAGE = /(?:帮我|帮忙|请|记账|入账|报销|确认|修改|更改|调整|设置|金额|备注|费用|早餐|午餐|晚餐|支出|收入|借款|拜访|走访|客户|开会|工作|谢谢)/u;
const REGION_DISCOURSE_SUFFIX = /(?:一下|啊|呀|呢|吧|哦|哈)$/u;
const WEEKDAY_INDEX = new Map([
  ["一", 0], ["二", 1], ["三", 2], ["四", 3], ["五", 4], ["六", 5], ["日", 6], ["天", 6],
]);

function result(intent, extra = {}) {
  return { schemaVersion: SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION, status: "accepted", intent, ...extra, warnings: [] };
}

function review(warnings = ["unrecognized_intent"], extra = {}) {
  return { schemaVersion: SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION, status: "review_required", intent: "unknown", ...extra, warnings: [...new Set(warnings)] };
}

function parseAssignment(text) {
  if (!LOAN.test(text) || !ASSIGN.test(text)) return null;
  // Keep the assignee as user-provided text; this module must not resolve identities.
  const match = text.match(/(?:归属|分配给|给|由|算作|记在|属于)\s*([^，。；;！？?]+?)(?:的)?(?:借款|预借|借支)?(?:[，。；;！？?]|$)/u);
  const assignee = match?.[1]?.trim();
  if (!assignee || /^(?:我|本人)$/u.test(assignee)) return { owner: "self" };
  if (assignee.length > 100 || QUESTION.test(text)) return null;
  return { owner: assignee };
}

function currentWeekStart(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const business = new Date(`${valueOf("year")}-${valueOf("month")}-${valueOf("day")}T00:00:00Z`);
  if (Number.isNaN(business.getTime())) return null;
  business.setUTCDate(business.getUTCDate() - ((business.getUTCDay() + 6) % 7));
  return business.toISOString().slice(0, 10);
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateAtOffset(weekStart, offset) {
  const date = new Date(`${weekStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function relativeRegionWeekStart(text, options = {}) {
  const explicit = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})\s*(?:至|到|-|~|～)\s*(\d{4})[-/]?(\d{2})[-/]?(\d{2})/u);
  if (explicit) {
    const start = `${explicit[1]}-${explicit[2]}-${explicit[3]}`;
    const end = `${explicit[4]}-${explicit[5]}-${explicit[6]}`;
    if (!validDateOnly(start) || !validDateOnly(end)) return null;
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);
    return startDate.getUTCDay() === 1 && endDate.getTime() - startDate.getTime() === 6 * 24 * 60 * 60 * 1000
      ? start
      : null;
  }
  const current = currentWeekStart(options.now);
  if (!current) return null;
  if (/(?:上周|上星期|上礼拜)/u.test(text)) return dateAtOffset(current, -7);
  if (/(?:本周|这周|本星期|这星期|本礼拜|这礼拜|当前周)/u.test(text)) return current;
  return null;
}

function normalizeRegionCity(value) {
  const city = String(value ?? "")
    .normalize("NFKC")
    .replace(/^(?:是|为|在|到|去)/u, "")
    .replace(/(?:出差|差旅|负责)$/u, "")
    .replace(/[，,。；;：:\s]+$/u, "")
    .trim();
  if (!city
    || city.length > 100
    || REGION_NON_CITY_LANGUAGE.test(city)
    || REGION_DISCOURSE_SUFFIX.test(city)
    || !/^\p{Script=Han}[\p{Script=Han}\d·新区县市区自治州盟旗]{0,99}$/u.test(city)) return null;
  return city;
}

function monthDayInWeek(monthText, dayText, weekStart) {
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const weekEnd = dateAtOffset(weekStart, 6);
  const startYear = Number(weekStart.slice(0, 4));
  for (const year of [startYear - 1, startYear, startYear + 1]) {
    const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (validDateOnly(value) && value >= weekStart && value <= weekEnd) return value;
  }
  return null;
}

function expandOverrideRange(startDate, endDate, city) {
  if (!startDate || !endDate || startDate > endDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const count = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (count < 1 || count > 7) return null;
  return Array.from({ length: count }, (_, index) => ({
    date: dateAtOffset(startDate, index),
    city,
  }));
}

function parseRegionDateOverrides(text, weekStart) {
  const overrides = [];
  const occupied = new Set();
  const monthDayRange = /(\d{1,2})月(\d{1,2})日?\s*(?:至|到|-|~|～)\s*(?:(\d{1,2})月)?(\d{1,2})日?\s*([\p{Script=Han}]{2,20})/gu;
  for (const match of text.matchAll(monthDayRange)) {
    const city = normalizeRegionCity(match[5]);
    const startDate = monthDayInWeek(match[1], match[2], weekStart);
    const endDate = monthDayInWeek(match[3] ?? match[1], match[4], weekStart);
    const expanded = city ? expandOverrideRange(startDate, endDate, city) : null;
    if (!expanded) return null;
    for (const item of expanded) {
      if (occupied.has(item.date)) return null;
      occupied.add(item.date);
      overrides.push(item);
    }
  }
  const weekdayRange = /(?:周|星期)([一二三四五六日天])\s*(?:至|到|-|~|～)\s*(?:周|星期)?([一二三四五六日天])\s*([\p{Script=Han}]{2,20})/gu;
  for (const match of text.matchAll(weekdayRange)) {
    const city = normalizeRegionCity(match[3]);
    const startOffset = WEEKDAY_INDEX.get(match[1]);
    const endOffset = WEEKDAY_INDEX.get(match[2]);
    const expanded = city && startOffset <= endOffset
      ? expandOverrideRange(dateAtOffset(weekStart, startOffset), dateAtOffset(weekStart, endOffset), city)
      : null;
    if (!expanded) return null;
    for (const item of expanded) {
      if (occupied.has(item.date)) return null;
      occupied.add(item.date);
      overrides.push(item);
    }
  }
  return overrides.sort((left, right) => left.date.localeCompare(right.date));
}

function parseRegionAssignment(text, options = {}) {
  if (!REGION_LABEL.test(text)) return null;
  const weekStart = relativeRegionWeekStart(text, options);
  if (!weekStart) return null;
  const label = /(?:出差区域|差旅区域|负责区域|区域)\s*(?:设置为|设为|修改为|更改为|调整为|改为|是|为|在|：|:)?\s*/u.exec(text);
  if (!label) return null;
  const suffix = text.slice(label.index + label[0].length);
  // The header is the short city list immediately following the region label.
  // Stop at the first clause separator regardless of what follows it: free-form
  // tails such as “金额20元”“备注是早餐” or “请帮我确认” must never become
  // persisted city names. Date/weekday ranges are parsed independently below.
  const header = suffix.split(/[，,；;。！？!?]/u, 1)[0]
    .replace(/\d{1,2}月\d{1,2}日?[\s\S]*$/u, "")
    .replace(/(?:周|星期)[一二三四五六日天][\s\S]*$/u, "")
    .trim();
  const headerCities = header
    .split(/(?:、|和|及|\/|，|,)/u)
    .map(normalizeRegionCity)
    .filter(Boolean);
  const dateOverrides = parseRegionDateOverrides(text, weekStart);
  if (dateOverrides === null) return null;
  const cities = [];
  for (const city of [...headerCities, ...dateOverrides.map((item) => item.city)]) {
    if (!cities.includes(city)) cities.push(city);
  }
  if (cities.length === 0 || cities.length > 30) return null;
  // Multiple cities without a date/weekday mapping are ambiguous. Returning
  // null makes the outer intent parser produce review_required, so no profile
  // is written until the user supplies an explicit mapping or a single default.
  if (cities.length > 1 && dateOverrides.length === 0) return null;
  return {
    weekStart,
    cities,
    defaultCity: dateOverrides.length === 0 && cities.length === 1 ? cities[0] : null,
    dateOverrides,
  };
}

function parseScope(text, options = {}) {
  if (!SCOPE.test(text) && !/^(?:本周|这周|本星期|当前周)/u.test(text)) return null;
  if (/(?:本周|这周|本星期|当前周)/u.test(text)) {
    return { scope: "week", weekStart: currentWeekStart(options.now) };
  }
  const range = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})\s*(?:至|到|-|~|～)\s*(\d{4})[-/]?(\d{2})[-/]?(\d{2})/u);
  if (range) {
    const weekStart = `${range[1]}-${range[2]}-${range[3]}`;
    const weekEnd = `${range[4]}-${range[5]}-${range[6]}`;
    if (!validDateOnly(weekStart) || !validDateOnly(weekEnd)) return null;
    const start = new Date(`${weekStart}T00:00:00Z`);
    const end = new Date(`${weekEnd}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
      && start.getUTCDay() === 1 && end.getTime() - start.getTime() === 6 * 24 * 60 * 60 * 1000) {
      return { scope: "week", weekStart };
    }
    return null;
  }
  const reference = text.match(/(?:BK-[0-9A-F]{12}|编号\s*[：:]?\s*[0-9]{12})/iu)?.[0] ?? null;
  if (reference) return { scope: "expense", reference };
  if (/(?:这笔|该笔|本笔)(?:费用|支出|记账)?/u.test(text)) return { scope: "expense", reference: null };
  return null;
}

/** Parse explicit human intent at the Shortcut bookkeeping confirmation boundary. */
export function parseShortcutBookkeepingIntent(input, options = {}) {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 1_000) return review(["invalid_intent"]);
  const text = input.trim().replace(/[\u0000-\u001f\u007f]/gu, "");
  if (QUESTION.test(text) || WEAK.test(text)) return review(["ambiguous_intent"]);
  if (CANCEL.test(text)) return result("cancel");
  if (CONFIRM.test(text)) return result("confirm");
  // A named bookkeeping field owns the whole utterance even when its new
  // value happens to contain the words “本周区域”. Bare control verbs such as
  // “设置” or “修改” do not own the utterance: people commonly say
  // “设置本周区域为济南”, which is an unambiguous region command.
  if (CORRECTION_FIELD_PREFIX.test(text)) {
    const correction = parseShortcutBookkeepingCorrection(text, { friendlyDates: options.friendlyDates ?? true, now: options.now });
    if (correction.status !== "accepted") return review(correction.warnings, { intent: "correction", correction });
    return result("correction", { correction, changes: correction.changes });
  }
  const regionAssignment = parseRegionAssignment(text, options);
  if (regionAssignment) return result("region_assignment", { regionAssignment });
  // Do not let an unresolved region phrase fall through to the generic
  // “本周” loan-scope parser. Ambiguous multi-city commands must remain in
  // human review and must never write a profile or allocate a loan.
  if (REGION_LABEL.test(text) && relativeRegionWeekStart(text, options)) {
    return review(["ambiguous_region_assignment"]);
  }
  if (CORRECTION_PREFIX.test(text)) {
    const correction = parseShortcutBookkeepingCorrection(text, { friendlyDates: options.friendlyDates ?? true, now: options.now });
    if (correction.status !== "accepted") return review(correction.warnings, { intent: "correction", correction });
    return result("correction", { correction, changes: correction.changes });
  }
  const scope = parseScope(text, options);
  if (scope && (LOAN.test(text) || scope.scope === "week" || scope.scope === "expense")) {
    return result("loan_assignment", { assignment: { ...scope, owner: "self" } });
  }
  const assignment = parseAssignment(text);
  if (assignment) return result("loan_assignment", { assignment });
  return review();
}

export const parseBookkeepingIntent = parseShortcutBookkeepingIntent;
export const classifyShortcutBookkeepingIntent = parseShortcutBookkeepingIntent;
