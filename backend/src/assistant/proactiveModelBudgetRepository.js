import { createHash } from "node:crypto";

import { withImmediateTransaction } from "../db/transaction.js";

const MAX_HASH_LENGTH = 64;
const MAX_RESULT_BYTES = 512 * 1024;
const GLOBAL_OWNER = "__global__";

function text(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function identifier(value, name, max = 500) {
  const normalized = text(value, name, max);
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function boundedInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} is invalid`);
  return value;
}

function validDate(value, name = "date") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function usageDate(value, timeZone) {
  const date = validDate(value, "at");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function stableValue(value, path = "value", depth = 0, seen = new Set()) {
  if (depth > 20) throw new TypeError(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => stableValue(item, `${path}[${index}]`, depth + 1, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      stableValue(value[key], `${path}.${key}`, depth + 1, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function stableHash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function hashValue(value, name) {
  const normalized = text(value, name, MAX_HASH_LENGTH);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function key(input = {}) {
  return {
    owner: identifier(input.owner, "owner", 200),
    evidenceHash: hashValue(input.evidenceHash, "evidenceHash"),
    payloadHash: hashValue(input.payloadHash, "payloadHash"),
    modelProvider: optionalText(input.modelProvider, "modelProvider", 200),
    modelName: optionalText(input.modelName, "modelName", 200),
    ruleVersion: optionalText(input.ruleVersion, "ruleVersion", 200),
  };
}

function parseResult(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_RESULT_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cacheRowKey(input) {
  const value = key(input);
  return {
    $owner: value.owner,
    $evidenceHash: value.evidenceHash,
    $payloadHash: value.payloadHash,
    $modelProvider: value.modelProvider,
    $modelName: value.modelName,
    $ruleVersion: value.ruleVersion,
  };
}

/**
 * Durable cache and per-owner/global daily reservation ledger for proactive
 * model calls.  All counters are incremented before the provider request so
 * retries and restarts cannot bypass the configured daily budget.
 */
export function createProactiveModelBudgetRepository(db, {
  clock = () => new Date(),
  timeZone = "Asia/Shanghai",
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A synchronous SQLite connection is required");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new TypeError("timeZone is invalid");
  }
  const now = () => validDate(clock(), "clock");

  function getCache(input = {}, { at = now() } = {}) {
    const value = key(input);
    const current = validDate(at, "at");
    const row = db.prepare(`
      SELECT * FROM proactive_model_cache
       WHERE owner = $owner
         AND evidence_hash = $evidenceHash
         AND payload_hash = $payloadHash
         AND model_provider = $modelProvider
         AND model_name = $modelName
         AND rule_version = $ruleVersion
       LIMIT 1
    `).get(cacheRowKey(value));
    if (!row || !row.expires_at || Date.parse(row.expires_at) <= current.getTime()) return null;
    const result = parseResult(row.result_json);
    if (!result) return null;
    const usedAt = current.toISOString();
    db.prepare(`
      UPDATE proactive_model_cache
         SET hit_count = hit_count + 1, last_used_at = $usedAt, updated_at = $usedAt
       WHERE id = $id
    `).run({ $id: row.id, $usedAt: usedAt });
    return {
      result,
      owner: row.owner,
      evidenceHash: row.evidence_hash,
      payloadHash: row.payload_hash,
      modelProvider: row.model_provider || null,
      modelName: row.model_name || null,
      ruleVersion: row.rule_version || null,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
      hitCount: Number(row.hit_count ?? 0) + 1,
    };
  }

  function saveCache(input = {}, { result, generatedAt = now(), expiresAt } = {}) {
    const value = key(input);
    const encoded = stableJson(result);
    if (Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw new TypeError("result is too large");
    const generated = validDate(generatedAt, "generatedAt");
    const expires = validDate(expiresAt, "expiresAt");
    if (expires.getTime() <= generated.getTime()) throw new TypeError("expiresAt must be after generatedAt");
    const generatedIso = generated.toISOString();
    const expiresIso = expires.toISOString();
    const updatedIso = now().toISOString();
    return db.prepare(`
      INSERT INTO proactive_model_cache (
        owner, evidence_hash, payload_hash, model_provider, model_name, rule_version,
        result_json, generated_at, expires_at, last_used_at, hit_count, created_at, updated_at
      ) VALUES (
        $owner, $evidenceHash, $payloadHash, $modelProvider, $modelName, $ruleVersion,
        $resultJson, $generatedAt, $expiresAt, $lastUsedAt, 0, $createdAt, $updatedAt
      )
      ON CONFLICT(owner, evidence_hash, payload_hash, model_provider, model_name, rule_version)
      DO UPDATE SET
        result_json = excluded.result_json,
        generated_at = excluded.generated_at,
        expires_at = excluded.expires_at,
        last_used_at = excluded.last_used_at,
        hit_count = 0,
        updated_at = excluded.updated_at
    `).run({
      ...cacheRowKey(value),
      $resultJson: encoded,
      $generatedAt: generatedIso,
      $expiresAt: expiresIso,
      $lastUsedAt: updatedIso,
      $createdAt: updatedIso,
      $updatedAt: updatedIso,
    });
  }

  function usageCount({ usageDate: dateValue, scope, owner = null } = {}) {
    const dateKey = dateValue ?? usageDate(now(), timeZone);
    if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) throw new TypeError("usageDate is invalid");
    if (!new Set(["owner", "global"]).has(scope)) throw new TypeError("scope is invalid");
    const ownerKey = scope === "global" ? GLOBAL_OWNER : identifier(owner, "owner", 200);
    return Number(db.prepare(`
      SELECT call_count FROM proactive_model_usage
       WHERE usage_date = $usageDate AND scope = $scope AND owner = $owner
    `).get({ $usageDate: dateKey, $scope: scope, $owner: ownerKey })?.call_count ?? 0);
  }

  function reserve({ owner, at = now(), ownerDailyLimit, globalDailyLimit } = {}) {
    const normalizedOwner = identifier(owner, "owner", 200);
    const ownerLimit = boundedInteger(ownerDailyLimit, "ownerDailyLimit", { min: 1, max: 1_000_000 });
    const globalLimit = boundedInteger(globalDailyLimit, "globalDailyLimit", { min: 1, max: 10_000_000 });
    const dateKey = usageDate(at, timeZone);
    const result = withImmediateTransaction(db, () => {
      const currentOwner = usageCount({ usageDate: dateKey, scope: "owner", owner: normalizedOwner });
      const currentGlobal = usageCount({ usageDate: dateKey, scope: "global" });
      if (currentOwner >= ownerLimit || currentGlobal >= globalLimit) {
        return {
          allowed: false,
          reason: "model_daily_limit",
          usageDate: dateKey,
          owner: normalizedOwner,
          ownerCount: currentOwner,
          globalCount: currentGlobal,
          ownerDailyLimit: ownerLimit,
          globalDailyLimit: globalLimit,
        };
      }
      const updatedAt = validDate(at, "at").toISOString();
      const upsert = db.prepare(`
        INSERT INTO proactive_model_usage (usage_date, scope, owner, call_count, updated_at)
        VALUES ($usageDate, $scope, $owner, 1, $updatedAt)
        ON CONFLICT(usage_date, scope, owner)
        DO UPDATE SET call_count = call_count + 1, updated_at = excluded.updated_at
      `);
      upsert.run({ $usageDate: dateKey, $scope: "owner", $owner: normalizedOwner, $updatedAt: updatedAt });
      upsert.run({ $usageDate: dateKey, $scope: "global", $owner: GLOBAL_OWNER, $updatedAt: updatedAt });
      return {
        allowed: true,
        reason: null,
        usageDate: dateKey,
        owner: normalizedOwner,
        ownerCount: currentOwner + 1,
        globalCount: currentGlobal + 1,
        ownerDailyLimit: ownerLimit,
        globalDailyLimit: globalLimit,
      };
    });
    return result;
  }

  function usage({ owner = null, at = now() } = {}) {
    const dateKey = usageDate(at, timeZone);
    const normalizedOwner = owner === null || owner === undefined ? null : identifier(owner, "owner", 200);
    return {
      usageDate: dateKey,
      owner: normalizedOwner,
      ownerCount: normalizedOwner === null ? null : usageCount({ usageDate: dateKey, scope: "owner", owner: normalizedOwner }),
      globalCount: usageCount({ usageDate: dateKey, scope: "global" }),
    };
  }

  return Object.freeze({ getCache, saveCache, reserve, usage, usageDate: (value = now()) => usageDate(value, timeZone) });
}

export { GLOBAL_OWNER };
