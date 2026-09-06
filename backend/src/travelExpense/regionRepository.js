import { withImmediateTransaction } from "../db/transaction.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CITIES = 30;

export class TravelExpenseRegionProfileVersionConflictError extends Error {
  constructor(currentVersion) {
    super("Travel expense region profile version conflict");
    this.name = "TravelExpenseRegionProfileVersionConflictError";
    this.currentVersion = Number(currentVersion);
  }
}

function runTransaction(db, work) {
  return db.isTransaction ? work() : withImmediateTransaction(db, work);
}

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function requiredIdentityText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  // Owner and actor are opaque authorization identities. Compatibility
  // normalization would collapse distinct principals such as "A" and "Ａ",
  // unlike the session and other travel-expense repositories that preserve the
  // authenticated account verbatim after trimming.
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

export function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function naturalWeekStart(value) {
  if (!validDateOnly(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function normalizedWeekStart(value) {
  if (!validDateOnly(value) || naturalWeekStart(value) !== value) {
    throw new TypeError("weekStart must be a Monday using YYYY-MM-DD format");
  }
  return value;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizedCity(value, name = "city") {
  return requiredText(value, name, 100);
}

function normalizedCities(value) {
  if (!Array.isArray(value) || value.length > MAX_CITIES) {
    throw new TypeError(`cities must be an array with at most ${MAX_CITIES} items`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const city = normalizedCity(item, "cities");
    if (!seen.has(city)) {
      seen.add(city);
      result.push(city);
    }
  }
  return result;
}

function normalizedDefaultCity(value, cities) {
  if (value === undefined || value === null || value === "") return null;
  const city = normalizedCity(value, "defaultCity");
  if (!cities.includes(city)) throw new TypeError("defaultCity must be included in cities");
  return city;
}

function normalizedDateOverrides(value, weekStart, cities) {
  if (!Array.isArray(value) || value.length > 7) {
    throw new TypeError("dateOverrides must be an array with at most 7 items");
  }
  const weekEnd = addDays(weekStart, 6);
  const byDate = new Map();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("dateOverrides items must be objects");
    }
    const keys = Object.keys(item);
    if (keys.some((key) => !["date", "city"].includes(key))) {
      throw new TypeError("dateOverrides contains an unknown field");
    }
    if (!validDateOnly(item.date) || item.date < weekStart || item.date > weekEnd) {
      throw new TypeError("dateOverrides date must be inside the selected week");
    }
    const city = normalizedCity(item.city, "dateOverrides.city");
    if (!cities.includes(city)) throw new TypeError("dateOverrides city must be included in cities");
    if (byDate.has(item.date)) throw new TypeError("dateOverrides dates must be unique");
    byDate.set(item.date, city);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, city]) => ({ date, city }));
}

export function normalizeTravelExpenseRegionProfileInput(input = {}) {
  const weekStart = normalizedWeekStart(input.weekStart);
  const cities = normalizedCities(input.cities);
  const defaultCity = normalizedDefaultCity(input.defaultCity, cities);
  const dateOverrides = normalizedDateOverrides(input.dateOverrides, weekStart, cities);
  if (cities.length === 0 && (defaultCity || dateOverrides.length > 0)) {
    throw new TypeError("cities is required when a default or date override is configured");
  }
  return { weekStart, cities, defaultCity, dateOverrides };
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emptyProfile(weekStart, cities = []) {
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    version: 0,
    cities,
    defaultCity: null,
    dateOverrides: [],
    createdAt: null,
    updatedAt: null,
  };
}

function profileFromRow(row, weekStart) {
  if (!row) return emptyProfile(weekStart);
  return {
    weekStart: row.week_start,
    weekEnd: addDays(row.week_start, 6),
    version: Number(row.version),
    cities: parseArray(row.cities_json),
    defaultCity: row.default_city,
    dateOverrides: parseArray(row.date_overrides_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameConfiguration(profile, normalized) {
  return profile.weekStart === normalized.weekStart
    && profile.defaultCity === normalized.defaultCity
    && JSON.stringify(profile.cities) === JSON.stringify(normalized.cities)
    && JSON.stringify(profile.dateOverrides) === JSON.stringify(normalized.dateOverrides);
}

export function createTravelExpenseRegionRepository(db, {
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  const selectProfile = db.prepare(`
    SELECT owner, week_start, version, cities_json, default_city,
           date_overrides_json, created_at, updated_at
    FROM travel_expense_region_profiles
    WHERE owner = $owner AND week_start = $weekStart
  `);
  const selectLatestCities = db.prepare(`
    SELECT cities_json
    FROM travel_expense_region_profiles
    WHERE owner = $owner
    ORDER BY updated_at DESC, week_start DESC
    LIMIT 1
  `);

  function getProfile({ owner, weekStart } = {}) {
    const normalizedOwner = requiredIdentityText(owner, "owner");
    const normalizedWeek = normalizedWeekStart(weekStart);
    const row = selectProfile.get({
      $owner: normalizedOwner,
      $weekStart: normalizedWeek,
    });
    if (row) return profileFromRow(row, normalizedWeek);
    const latest = selectLatestCities.get({ $owner: normalizedOwner });
    return emptyProfile(normalizedWeek, parseArray(latest?.cities_json));
  }

  function putProfile(input = {}) {
    const owner = requiredIdentityText(input.owner, "owner");
    const actor = requiredIdentityText(input.actor, "actor");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative integer");
    }
    const normalized = normalizeTravelExpenseRegionProfileInput(input);
    return runTransaction(db, () => {
      const current = getProfile({ owner, weekStart: normalized.weekStart });
      if (current.version !== input.expectedVersion) {
        throw new TravelExpenseRegionProfileVersionConflictError(current.version);
      }
      if (current.version > 0 && sameConfiguration(current, normalized)) return current;

      const now = nowIso(clock);
      if (current.version === 0) {
        db.prepare(`
          INSERT INTO travel_expense_region_profiles (
            owner, week_start, version, cities_json, default_city,
            date_overrides_json, created_by, updated_by, created_at, updated_at
          ) VALUES (
            $owner, $weekStart, 1, $citiesJson, $defaultCity,
            $dateOverridesJson, $actor, $actor, $now, $now
          )
        `).run({
          $owner: owner,
          $weekStart: normalized.weekStart,
          $citiesJson: JSON.stringify(normalized.cities),
          $defaultCity: normalized.defaultCity,
          $dateOverridesJson: JSON.stringify(normalized.dateOverrides),
          $actor: actor,
          $now: now,
        });
      } else {
        const updated = db.prepare(`
          UPDATE travel_expense_region_profiles
          SET version = version + 1,
              cities_json = $citiesJson,
              default_city = $defaultCity,
              date_overrides_json = $dateOverridesJson,
              updated_by = $actor,
              updated_at = $now
          WHERE owner = $owner AND week_start = $weekStart AND version = $expectedVersion
        `).run({
          $owner: owner,
          $weekStart: normalized.weekStart,
          $citiesJson: JSON.stringify(normalized.cities),
          $defaultCity: normalized.defaultCity,
          $dateOverridesJson: JSON.stringify(normalized.dateOverrides),
          $actor: actor,
          $now: now,
          $expectedVersion: input.expectedVersion,
        });
        if (updated.changes !== 1) {
          const latest = getProfile({ owner, weekStart: normalized.weekStart });
          throw new TravelExpenseRegionProfileVersionConflictError(latest.version);
        }
      }
      return getProfile({ owner, weekStart: normalized.weekStart });
    });
  }

  function resolveRegion({ owner, occurredOn } = {}) {
    const normalizedOwner = requiredIdentityText(owner, "owner");
    if (!validDateOnly(occurredOn)) return null;
    const weekStart = naturalWeekStart(occurredOn);
    const profile = getProfile({ owner: normalizedOwner, weekStart });
    if (profile.version === 0) return null;
    const override = profile.dateOverrides.find((item) => item.date === occurredOn);
    if (override) return { city: override.city, source: "date_override", weekStart, version: profile.version };
    if (profile.defaultCity) return { city: profile.defaultCity, source: "week_default", weekStart, version: profile.version };
    return null;
  }

  return { getProfile, putProfile, resolveRegion };
}

export function resolveTravelExpenseRegionFromDatabase(db, input) {
  return createTravelExpenseRegionRepository(db).resolveRegion(input);
}

export { DAY_MS };
