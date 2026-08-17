import { HttpError } from "../http/errors.js";
import { constantTimeEqual } from "../http/security.js";

export const SHORTCUT_BOOKKEEPING_ROUTE = "/api/integrations/shortcut/bookkeeping";
export const SHORTCUT_BOOKKEEPING_CATALOG_ROUTE = "/api/integrations/shortcut/catalog";
export const SHORTCUT_BOOKKEEPING_VERIFY_ROUTE = "/api/integrations/shortcut/verify";
export const SHORTCUT_BOOKKEEPING_SOURCE = "shortcut";
export const SHORTCUT_SELECTION_SEPARATOR = " · ";

// The same catalog drives API validation, the catalog response, and the
// Shortcut builder. Keep these visible Chinese labels stable.
const CATALOG = {
  "出差报销": {
    targetSystem: "sentelligent",
    // v0.6.2 deliberately opens only the existing travel-expense model. An
    // empty income catalog makes unsupported income fail validation instead
    // of being mislabeled as an accepted financial write.
    income: {},
    expense: {
      "餐饮": ["早餐", "午餐", "晚餐"],
      "住宿费": [],
      "交通": ["火车", "路桥费", "打车", "代驾", "停车"],
      "汽车维修": ["维修", "保养"],
      "招待/礼品": [],
    },
  },
  biubiu: {
    targetSystem: "qingyang",
    income: {
      "营收": ["美团", "淘宝闪购", "京东", "收钱吧", "其他"],
      "退税": [],
      "其他收入": [],
    },
    expense: {
      "房租": [],
      "设备": [],
      "水电费": [],
      "进货采购": ["水果", "耗材"],
      "员工薪资": [],
      "交税": [],
      "运营": [],
    },
  },
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SHORTCUT_BOOKKEEPING_CATALOG = deepFreeze(CATALOG);
export const SHORTCUT_LEDGER_NAMES = Object.freeze(Object.keys(CATALOG));
export const SHORTCUT_ENTRY_TYPES = Object.freeze(["income", "expense"]);
const ENTRY_TYPE_ALIASES = new Map([
  ["income", "income"],
  ["expense", "expense"],
  ["收入", "income"],
  ["支出", "expense"],
]);

const ALLOWED_KEYS = new Set([
  "text",
  "selection_path",
  "ledger_name",
  "entry_type",
  "category",
  "subcategory",
  "note",
  "idempotency_key",
  "source",
  "captured_at",
  "source_id",
]);

function validationError(fields) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) validationError({ [field]: "required" });
  const normalized = value.trim();
  if (normalized.length > max) validationError({ [field]: "maxLength" });
  return normalized;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") validationError({ [field]: "string" });
  const normalized = value.trim();
  if (normalized.length > max) validationError({ [field]: "maxLength" });
  return normalized || null;
}

function assertDateTime(value, field) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    validationError({ [field]: "dateTime" });
  }
  return value.trim();
}

export function resolveShortcutCategory({ ledgerName, entryType, category, subcategory = null } = {}) {
  const ledger = SHORTCUT_BOOKKEEPING_CATALOG[ledgerName];
  if (!ledger) validationError({ ledger_name: "notAllowed" });
  const normalizedEntryType = ENTRY_TYPE_ALIASES.get(entryType);
  if (!normalizedEntryType) validationError({ entry_type: "enum" });
  const categories = ledger[normalizedEntryType];
  if (!Object.hasOwn(categories, category)) validationError({ category: "notAllowed" });
  const allowedSubcategories = categories[category];
  const normalizedSubcategory = subcategory === undefined || subcategory === null
    || subcategory === "" || subcategory === "无"
    ? null
    : subcategory;
  if (allowedSubcategories.length === 0) {
    if (normalizedSubcategory !== null) validationError({ subcategory: "notAllowed" });
  } else if (!allowedSubcategories.includes(normalizedSubcategory)) {
    validationError({ subcategory: "notAllowed" });
  }
  return {
    ledgerName,
    entryType: normalizedEntryType,
    category,
    subcategory: normalizedSubcategory,
    targetSystem: ledger.targetSystem,
  };
}

export function resolveShortcutSelectionPath(value) {
  const selectionPath = requiredText(value, "selection_path", 400);
  const parts = selectionPath.split(SHORTCUT_SELECTION_SEPARATOR);
  if (parts.length !== 4 || parts.some((part) => !part)) {
    validationError({ selection_path: "format" });
  }
  const [ledgerName, entryType, category, subcategory] = parts;
  return {
    selectionPath,
    ...resolveShortcutCategory({ ledgerName, entryType, category, subcategory }),
  };
}

export function validateShortcutBookkeepingPayload(body) {
  if (!plainObject(body)) validationError({ body: "object" });
  const unknown = Object.keys(body).find((key) => !ALLOWED_KEYS.has(key));
  if (unknown) validationError({ [unknown]: "unknown" });

  const text = requiredText(body.text, "text", 12_000);
  const hasSelectionPath = body.selection_path !== undefined
    && body.selection_path !== null
    && body.selection_path !== "";
  const hasExpandedSelection = ["ledger_name", "entry_type", "category", "subcategory"]
    .some((key) => body[key] !== undefined);
  if (hasSelectionPath && hasExpandedSelection) {
    validationError({ selection_path: "conflict" });
  }
  const resolved = hasSelectionPath
    ? resolveShortcutSelectionPath(body.selection_path)
    : resolveShortcutCategory({
      ledgerName: requiredText(body.ledger_name, "ledger_name", 50),
      entryType: requiredText(body.entry_type, "entry_type", 20),
      category: requiredText(body.category, "category", 100),
      subcategory: optionalText(body.subcategory, "subcategory", 100),
    });
  const note = optionalText(body.note, "note", 1_000);
  const idempotencyKey = requiredText(body.idempotency_key, "idempotency_key", 200);
  if (body.idempotency_key !== idempotencyKey) validationError({ idempotency_key: "format" });
  if (/[\u0000-\u001f\u007f-\u009f,]/u.test(idempotencyKey)) {
    validationError({ idempotency_key: "format" });
  }
  if (body.source !== SHORTCUT_BOOKKEEPING_SOURCE) validationError({ source: "notAllowed" });

  const capturedAt = body.captured_at === undefined || body.captured_at === null || body.captured_at === ""
    ? null
    : assertDateTime(body.captured_at, "captured_at");
  const sourceId = optionalText(body.source_id, "source_id", 200);
  if (sourceId && /[\u0000-\u001f\u007f-\u009f]/u.test(sourceId)) {
    validationError({ source_id: "format" });
  }

  return {
    text,
    ledgerName: resolved.ledgerName,
    entryType: resolved.entryType,
    category: resolved.category,
    subcategory: resolved.subcategory,
    note,
    idempotencyKey,
    source: SHORTCUT_BOOKKEEPING_SOURCE,
    capturedAt,
    sourceId,
    targetSystem: resolved.targetSystem,
  };
}

export function authenticateShortcutWebhook(headers = {}, config = {}, tokenResolver = null) {
  const authorization = typeof headers.authorization === "string" ? headers.authorization : "";
  const custom = typeof headers["x-shortcut-webhook-token"] === "string"
    ? headers["x-shortcut-webhook-token"]
    : "";
  let candidate = null;
  let scheme = null;
  const bearer = /^Bearer ([^\s]+)$/iu.exec(authorization);
  if (bearer) {
    candidate = bearer[1];
    scheme = "bearer";
  } else if (custom) {
    candidate = custom;
    scheme = "shortcut-token";
  }
  if (!candidate) return null;
  if (typeof tokenResolver === "function") {
    try {
      const resolved = tokenResolver(candidate);
      if (resolved?.account) {
        return {
          account: resolved.account,
          integration: "shortcut",
          kind: "integration",
          scheme,
          ...(resolved.tokenId ? { tokenId: resolved.tokenId } : {}),
        };
      }
    } catch (error) {
      // A malformed candidate is indistinguishable from an unknown token.
      if (!(error instanceof TypeError)) throw error;
    }
  }
  // The legacy environment token exists only for local migration/testing.
  // Production authentication must always resolve an account-bound database
  // token so one shared secret cannot silently impersonate every account.
  if (String(config.nodeEnv ?? "").trim().toLowerCase() === "production") return null;
  const expected = String(config.shortcutWebhookToken ?? "").trim();
  if (!expected || !constantTimeEqual(candidate, expected)) return null;
  const account = String(
    config.shortcutWebhookOwner ?? config.authAccount ?? "shortcut",
  ).trim();
  if (!account) return null;
  return { account, integration: "shortcut", kind: "integration", scheme };
}

export function isShortcutBookkeepingRouteAllowed(method, path) {
  return String(method ?? "").toUpperCase() === "POST" && path === SHORTCUT_BOOKKEEPING_ROUTE;
}

export function shortcutCatalogResponse() {
  return {
    source: SHORTCUT_BOOKKEEPING_SOURCE,
    ledgers: SHORTCUT_LEDGER_NAMES.map((ledgerName) => ({
      name: ledgerName,
      targetSystem: SHORTCUT_BOOKKEEPING_CATALOG[ledgerName].targetSystem,
      entryTypes: Object.fromEntries(SHORTCUT_ENTRY_TYPES.map((entryType) => [
        entryType,
        Object.entries(SHORTCUT_BOOKKEEPING_CATALOG[ledgerName][entryType]).map(
          ([category, subcategories]) => ({ category, subcategories: [...subcategories] }),
        ),
      ])),
    })),
  };
}
