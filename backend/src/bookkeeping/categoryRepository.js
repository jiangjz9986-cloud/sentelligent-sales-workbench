import { randomUUID } from "node:crypto";

import {
  DEFAULT_BOOKKEEPING_CATALOG,
  normalizeBookkeepingEntryType,
  resolveBookkeepingCategoryAgainstCatalog,
} from "./categoryCatalog.js";
import { HttpError } from "../http/errors.js";

const DEFAULT_LEDGER_NAME = "出差报销";
const TARGET_SYSTEM = "sentelligent";
const ACTIVE = "active";
const ARCHIVED = "archived";

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function normalizeLedgerName(value = DEFAULT_LEDGER_NAME) {
  const ledgerName = requiredText(value, "ledgerName", 50);
  if (ledgerName !== DEFAULT_LEDGER_NAME) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
      ledger_name: "notAllowed",
    });
  }
  return ledgerName;
}

function normalizeEntryType(value) {
  const entryType = normalizeBookkeepingEntryType(value);
  if (!entryType) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
      entry_type: "enum",
    });
  }
  return entryType;
}

function normalizeCategoryName(value) {
  return requiredText(value, "name", 100);
}

function normalizeSubcategories(value = []) {
  if (value === null || value === undefined || value === "") return [];
  if (!Array.isArray(value)) throw new TypeError("subcategories must be an array");
  if (value.length > 20) throw new TypeError("subcategories cannot contain more than 20 items");
  const result = [];
  for (const item of value) {
    const normalized = requiredText(item, "subcategory", 100);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeAliases(value = []) {
  if (value === null || value === undefined || value === "") return [];
  if (!Array.isArray(value)) throw new TypeError("aliases must be an array");
  if (value.length > 20) throw new TypeError("aliases cannot contain more than 20 items");
  const result = [];
  for (const item of value) {
    const normalized = requiredText(item, "alias", 100);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeStatus(value = ACTIVE) {
  if (value !== ACTIVE && value !== ARCHIVED) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", {
      status: "enum",
    });
  }
  return value;
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function generatedId(idFactory) {
  const value = idFactory();
  if (typeof value !== "string" || !value.trim()) throw new TypeError("idFactory must return a non-empty string");
  return value.trim();
}

function rowToItem(row) {
  return {
    id: row.id,
    owner: row.owner,
    ledgerName: row.ledger_name,
    entryType: row.entry_type,
    name: row.name,
    subcategories: JSON.parse(row.subcategories_json),
    aliases: JSON.parse(row.aliases_json ?? "[]"),
    isSystem: Number(row.is_system) === 1,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function duplicateError() {
  return new HttpError(409, "BOOKKEEPING_CATEGORY_EXISTS", "该记账分类已经存在");
}

function notFoundError() {
  return new HttpError(404, "BOOKKEEPING_CATEGORY_NOT_FOUND", "记账分类不存在");
}

function versionConflict(currentVersion) {
  return new HttpError(409, "VERSION_CONFLICT", "记账分类已被其他操作更新，请刷新后重试", {
    currentVersion,
  });
}

export function createBookkeepingCategoryRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const insertDefault = db.prepare(`
    INSERT OR IGNORE INTO bookkeeping_categories (
      id, owner, ledger_name, entry_type, name, subcategories_json,
      is_system, status, version, created_at, updated_at
    ) VALUES (
      $id, $owner, $ledgerName, $entryType, $name, $subcategoriesJson,
      1, 'active', 1, $now, $now
    )
  `);

  function ensureDefaults({ owner, ledgerName = DEFAULT_LEDGER_NAME } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedLedgerName = normalizeLedgerName(ledgerName);
    const defaults = DEFAULT_BOOKKEEPING_CATALOG[normalizedLedgerName];
    const now = nowIso(clock);
    for (const entryType of ["income", "expense"]) {
      for (const [name, subcategories] of Object.entries(defaults[entryType] ?? {})) {
        insertDefault.run({
          $id: `bookkeeping-category-${entryType}-${randomUUID()}`,
          $owner: normalizedOwner,
          $ledgerName: normalizedLedgerName,
          $entryType: entryType,
          $name: name,
          $subcategoriesJson: JSON.stringify(subcategories),
          $now: now,
        });
      }
    }
  }

  function selectRows({ owner, ledgerName, entryType = null, includeArchived = false } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedLedgerName = normalizeLedgerName(ledgerName);
    const normalizedEntryType = entryType === null || entryType === undefined || entryType === ""
      ? null
      : normalizeEntryType(entryType);
    const rows = db.prepare(`
      SELECT id, owner, ledger_name, entry_type, name, subcategories_json, aliases_json,
             is_system, status, version, created_at, updated_at
      FROM bookkeeping_categories
      WHERE owner = $owner AND ledger_name = $ledgerName
        AND ($entryType IS NULL OR entry_type = $entryType)
        AND ($includeArchived = 1 OR status = 'active')
      ORDER BY entry_type ASC, is_system DESC, name COLLATE NOCASE ASC, id ASC
    `).all({
      $owner: normalizedOwner,
      $ledgerName: normalizedLedgerName,
      $entryType: normalizedEntryType,
      $includeArchived: includeArchived ? 1 : 0,
    });
    return rows.map(rowToItem);
  }

  function list({ owner, ledgerName = DEFAULT_LEDGER_NAME, entryType = null, includeArchived = false } = {}) {
    ensureDefaults({ owner, ledgerName });
    return selectRows({ owner, ledgerName, entryType, includeArchived });
  }

  function catalogFor({ owner, ledgerName = DEFAULT_LEDGER_NAME, includeArchived = false } = {}) {
    const normalizedLedgerName = normalizeLedgerName(ledgerName);
    const items = list({ owner, ledgerName: normalizedLedgerName, includeArchived });
    const catalog = {
      [normalizedLedgerName]: {
        targetSystem: TARGET_SYSTEM,
        income: {},
        expense: {},
      },
    };
    for (const item of items) {
      catalog[normalizedLedgerName][item.entryType][item.name] = [...item.subcategories];
    }
    return catalog;
  }

  function resolve(input = {}) {
    const owner = requiredText(input.owner, "owner", 200);
    const ledgerName = normalizeLedgerName(input.ledgerName);
    return resolveBookkeepingCategoryAgainstCatalog({
      ...input,
      catalog: catalogFor({ owner, ledgerName, includeArchived: input.includeArchived === true }),
      ledgerName,
    });
  }

  function create({ owner, ledgerName = DEFAULT_LEDGER_NAME, entryType, name, subcategories = [], aliases = [] } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const normalizedLedgerName = normalizeLedgerName(ledgerName);
    const normalizedEntryType = normalizeEntryType(entryType);
    const normalizedName = normalizeCategoryName(name);
    const normalizedSubcategories = normalizeSubcategories(subcategories);
    const normalizedAliases = normalizeAliases(aliases);
    ensureDefaults({ owner: normalizedOwner, ledgerName: normalizedLedgerName });
    const now = nowIso(clock);
    const id = generatedId(idFactory);
    try {
      db.prepare(`
        INSERT INTO bookkeeping_categories (
          id, owner, ledger_name, entry_type, name, subcategories_json, aliases_json,
          is_system, status, version, created_at, updated_at
        ) VALUES (
          $id, $owner, $ledgerName, $entryType, $name, $subcategoriesJson, $aliasesJson,
          0, 'active', 1, $now, $now
        )
      `).run({
        $id: id,
        $owner: normalizedOwner,
        $ledgerName: normalizedLedgerName,
        $entryType: normalizedEntryType,
        $name: normalizedName,
        $subcategoriesJson: JSON.stringify(normalizedSubcategories),
        $aliasesJson: JSON.stringify(normalizedAliases),
        $now: now,
      });
    } catch (error) {
      if (String(error?.message ?? "").includes("UNIQUE constraint failed")) throw duplicateError();
      throw error;
    }
    return get(id, { owner: normalizedOwner });
  }

  function get(id, { owner } = {}) {
    const normalizedId = requiredText(id, "id", 200);
    const normalizedOwner = requiredText(owner, "owner", 200);
    const row = db.prepare(`
      SELECT id, owner, ledger_name, entry_type, name, subcategories_json, aliases_json,
             is_system, status, version, created_at, updated_at
      FROM bookkeeping_categories
      WHERE id = $id AND owner = $owner
    `).get({ $id: normalizedId, $owner: normalizedOwner });
    return row ? rowToItem(row) : null;
  }

  function update(id, {
    owner,
    expectedVersion,
    name,
    subcategories,
    aliases,
    status,
  } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new HttpError(428, "PRECONDITION_REQUIRED", "A current quoted entity version is required");
    }
    const current = get(id, { owner: normalizedOwner });
    if (!current) throw notFoundError();
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.isSystem && (name !== undefined || status !== undefined)) {
      throw new HttpError(409, "SYSTEM_CATEGORY_READ_ONLY", "系统默认分类只能调整小类，不能改名或停用");
    }
    const nextName = name === undefined ? current.name : normalizeCategoryName(name);
    const nextSubcategories = subcategories === undefined
      ? current.subcategories
      : normalizeSubcategories(subcategories);
    const nextAliases = aliases === undefined ? current.aliases : normalizeAliases(aliases);
    const nextStatus = status === undefined ? current.status : normalizeStatus(status);
    const now = nowIso(clock);
    try {
      const result = db.prepare(`
        UPDATE bookkeeping_categories
        SET name = $name,
            subcategories_json = $subcategoriesJson,
            aliases_json = $aliasesJson,
            status = $status,
            version = version + 1,
            updated_at = $now
        WHERE id = $id AND owner = $owner AND version = $expectedVersion
      `).run({
        $id: current.id,
        $owner: normalizedOwner,
        $name: nextName,
        $subcategoriesJson: JSON.stringify(nextSubcategories),
        $aliasesJson: JSON.stringify(nextAliases),
        $status: nextStatus,
        $now: now,
        $expectedVersion: expectedVersion,
      });
      if (result.changes !== 1) {
        const latest = get(current.id, { owner: normalizedOwner });
        throw versionConflict(latest?.version ?? expectedVersion);
      }
    } catch (error) {
      if (String(error?.message ?? "").includes("UNIQUE constraint failed")) throw duplicateError();
      throw error;
    }
    return get(current.id, { owner: normalizedOwner });
  }

  function remove(id, { owner, expectedVersion } = {}) {
    const normalizedOwner = requiredText(owner, "owner", 200);
    const current = get(id, { owner: normalizedOwner });
    if (!current) throw notFoundError();
    if (current.isSystem) {
      throw new HttpError(409, "SYSTEM_CATEGORY_READ_ONLY", "系统默认分类不能删除，请新增自定义分类替代");
    }
    return update(current.id, {
      owner: normalizedOwner,
      expectedVersion,
      status: ARCHIVED,
    });
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    resolve,
    ensureDefaults,
    catalogFor,
  };
}
