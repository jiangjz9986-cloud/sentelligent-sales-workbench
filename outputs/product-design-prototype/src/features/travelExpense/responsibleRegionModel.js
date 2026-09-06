const DAY_MS = 86_400_000;

function dateParts(value, name = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a real calendar date`);
  }
  return date;
}

function addDays(value, amount) {
  return new Date(dateParts(value).getTime() + (amount * DAY_MS)).toISOString().slice(0, 10);
}

function requiredWeekStart(value) {
  const date = dateParts(value, "weekStart");
  if (date.getUTCDay() !== 1) throw new TypeError("weekStart must be a Monday");
  return value;
}

export function normalizeResponsibleCity(value) {
  if (typeof value !== "string") throw new TypeError("city must be a string");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new TypeError("city is required");
  if (normalized.length > 100) throw new TypeError("city is too long");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError("city contains control characters");
  return normalized;
}

function cityKey(value) {
  return normalizeResponsibleCity(value).toLocaleLowerCase("zh-CN").replace(/市$/u, "");
}

export function normalizeResponsibleCities(value) {
  if (!Array.isArray(value)) throw new TypeError("cities must be an array");
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const city = normalizeResponsibleCity(item);
    const key = cityKey(city);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(city);
  }
  return result;
}

function cityLookup(cities) {
  return new Map(cities.map((city) => [cityKey(city), city]));
}

function resolveCity(cities, value, name) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = normalizeResponsibleCity(value);
  const resolved = cityLookup(cities).get(cityKey(normalized));
  if (!resolved) throw new TypeError(`${name} must reference a responsible city`);
  return resolved;
}

export function responsibleRegionWeekDates(weekStart) {
  const start = requiredWeekStart(weekStart);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function normalizeOverrides(value, { weekStart, cities }) {
  if (!Array.isArray(value)) throw new TypeError("dateOverrides must be an array");
  const validDates = new Set(responsibleRegionWeekDates(weekStart));
  const byDate = new Map();
  for (const [index, override] of value.entries()) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new TypeError(`dateOverrides[${index}] must be an object`);
    }
    const date = String(override.date ?? "").trim();
    dateParts(date, `dateOverrides[${index}].date`);
    if (!validDates.has(date)) throw new TypeError(`dateOverrides[${index}].date must be inside the selected week`);
    if (byDate.has(date)) throw new TypeError(`dateOverrides contains more than one value for ${date}`);
    byDate.set(date, { date, city: resolveCity(cities, override.city, `dateOverrides[${index}].city`) });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function resolveResponsibleRegionDates({ weekStart, defaultCity = null, dateOverrides = [] } = {}) {
  const overrides = new Map(dateOverrides.map((item) => [item.date, item.city]));
  return responsibleRegionWeekDates(weekStart).map((date) => {
    if (overrides.has(date)) return { date, city: overrides.get(date), source: "date_override" };
    if (defaultCity) return { date, city: defaultCity, source: "week_default" };
    return { date, city: null, source: "unresolved" };
  });
}

export function createResponsibleRegionDraft(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("region profile is required");
  if (!Number.isSafeInteger(item.version) || item.version < 0) {
    throw new TypeError("region profile version must be a non-negative integer");
  }
  const weekStart = requiredWeekStart(item.weekStart);
  const weekEnd = addDays(weekStart, 6);
  if (item.weekEnd !== weekEnd) throw new TypeError("weekEnd must be the Sunday for weekStart");
  const cities = normalizeResponsibleCities(item.cities ?? []);
  if (cities.length !== (item.cities ?? []).length) throw new TypeError("cities must not contain duplicates");
  const defaultCity = resolveCity(cities, item.defaultCity ?? item.weeklyDefaultCity, "defaultCity");
  const dateOverrides = normalizeOverrides(item.dateOverrides ?? [], { weekStart, cities });
  return {
    version: item.version,
    cities,
    weekStart,
    weekEnd,
    defaultCity,
    dateOverrides,
    effectiveDates: resolveResponsibleRegionDates({ weekStart, defaultCity, dateOverrides }),
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

// Loose membership probe for prefill warnings: suffix-normalized comparison
// (济宁 ≡ 济宁市) that never throws, because the candidate city may come from
// an arbitrary URL filter value.
export function hasResponsibleCity(cities, value) {
  if (!Array.isArray(cities)) return false;
  let target;
  try {
    target = cityKey(value);
  } catch {
    return false;
  }
  return cities.some((city) => {
    try {
      return cityKey(city) === target;
    } catch {
      return false;
    }
  });
}

export function addResponsibleCity(cities, value) {
  const normalizedCities = normalizeResponsibleCities(cities);
  const city = normalizeResponsibleCity(value);
  const existing = cityLookup(normalizedCities).get(cityKey(city));
  if (existing) return { cities: normalizedCities, city: existing, added: false };
  return { cities: [...normalizedCities, city], city, added: true };
}

export function setResponsibleRegionWeekDefault(draft, city) {
  const cities = normalizeResponsibleCities(draft?.cities ?? []);
  return { ...draft, cities, defaultCity: resolveCity(cities, city, "defaultCity") };
}

export function upsertResponsibleRegionDateOverride(draft, { date, city } = {}) {
  const weekStart = requiredWeekStart(draft?.weekStart);
  const cities = normalizeResponsibleCities(draft?.cities ?? []);
  const normalizedDate = String(date ?? "").trim();
  dateParts(normalizedDate, "date override date");
  if (!responsibleRegionWeekDates(weekStart).includes(normalizedDate)) {
    throw new TypeError("date override must be inside the selected week");
  }
  const next = { date: normalizedDate, city: resolveCity(cities, city, "date override city") };
  const dateOverrides = (Array.isArray(draft?.dateOverrides) ? draft.dateOverrides : [])
    .filter((item) => item.date !== normalizedDate);
  dateOverrides.push(next);
  return { ...draft, cities, dateOverrides: dateOverrides.sort((left, right) => left.date.localeCompare(right.date)) };
}

export function removeResponsibleRegionDateOverride(draft, date) {
  return { ...draft, dateOverrides: (draft?.dateOverrides ?? []).filter((item) => item.date !== date) };
}

export function removeResponsibleCity(draft, value) {
  const cities = normalizeResponsibleCities(draft?.cities ?? []);
  const target = cityKey(value);
  const existing = cityLookup(cities).get(target);
  if (!existing) return { ...draft, cities };
  if (draft?.defaultCity && cityKey(draft.defaultCity) === target) {
    throw new TypeError(`${existing}仍是本周默认城市，请先取消本周默认`);
  }
  const usedOn = (draft?.dateOverrides ?? [])
    .filter((item) => cityKey(item.city) === target)
    .map((item) => item.date);
  if (usedOn.length) throw new TypeError(`${existing}仍用于日期覆盖：${usedOn.join("、")}`);
  return { ...draft, cities: cities.filter((city) => cityKey(city) !== target) };
}

export function buildResponsibleRegionPayload(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new TypeError("region profile draft is required");
  }
  const weekStart = requiredWeekStart(draft.weekStart);
  const cities = normalizeResponsibleCities(draft.cities);
  const defaultCity = resolveCity(cities, draft.defaultCity, "defaultCity");
  const dateOverrides = normalizeOverrides(draft.dateOverrides ?? [], { weekStart, cities });
  return { weekStart, cities, defaultCity, dateOverrides };
}
