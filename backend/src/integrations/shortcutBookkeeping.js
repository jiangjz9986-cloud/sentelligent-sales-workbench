import { createHash } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { constantTimeEqual } from "../http/security.js";

export const SHORTCUT_BOOKKEEPING_ROUTE = "/api/integrations/shortcut/bookkeeping";
// Device-token capture mode for the screenshot-only Shortcut. It accepts the
// OCR payload without exposing account/password fields on the phone and still
// enters the same owner-scoped WeChat confirmation pipeline.
export const SHORTCUT_BOOKKEEPING_CAPTURE_ROUTE = "/api/integrations/shortcut/bookkeeping-capture";
export const SHORTCUT_BOOKKEEPING_CAPTURE_PREVIEW_ROUTE = "/api/integrations/shortcut/bookkeeping-capture-preview";
// Development/internal fallback: the Shortcut carries two editable constants
// and the server validates them before accepting the business payload. Keep it
// as a separate route so the account-bound device-token contract remains
// unchanged and can be rolled back independently.
export const SHORTCUT_BOOKKEEPING_INLINE_ROUTE = "/api/integrations/shortcut/bookkeeping-inline";
export const SHORTCUT_BOOKKEEPING_CAPTURE_INLINE_ROUTE = "/api/integrations/shortcut/bookkeeping-capture-inline";
export const SHORTCUT_BOOKKEEPING_CATALOG_ROUTE = "/api/integrations/shortcut/catalog";
export const SHORTCUT_BOOKKEEPING_VERIFY_ROUTE = "/api/integrations/shortcut/verify";
export const SHORTCUT_BOOKKEEPING_SOURCE = "shortcut";
export const SHORTCUT_SELECTION_SEPARATOR = " · ";
export const DEFAULT_SHORTCUT_LEDGER = "出差报销";
export const DEFAULT_SHORTCUT_ENTRY_TYPE = "expense";

// The same catalog drives API validation, the catalog response, and the
// Shortcut builder. Keep these visible Chinese labels stable.
const CATALOG = {
  "出差报销": {
    targetSystem: "sentelligent",
    income: {
      "工资": [],
      "奖金": [],
      "出差": ["报销", "借款"],
    },
    expense: {
      "餐饮": ["早餐", "午餐", "晚餐"],
      "住宿费": [],
      "交通": ["火车", "路桥费", "打车", "代驾", "停车"],
      "汽车维保": ["维修", "保养"],
      "招待/礼品": [],
      "其他": [],
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

const CAPTURE_ALLOWED_KEYS = new Set([
  "text",
  "selection_path",
  "ledger_name",
  "entry_type",
  "category",
  "subcategory",
  "amount_cents",
  "note",
  "idempotency_key",
  "source",
  "captured_at",
  "source_id",
]);

const CAPTURE_PREVIEW_ALLOWED_KEYS = new Set(["text", "source"]);

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

function captureIdempotencyKey(value, version = 1) {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return `capture-v${version}-${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function positiveCents(value, field = "amount_cents") {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999_999_999_99) {
    validationError({ [field]: "positiveInteger" });
  }
  return value;
}

function normalizedOcrLines(value) {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\u00a0]+/gu, " ").replace(/\s{2,}/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 300);
}

function moneyCandidates(lines) {
  const candidates = [];
  const patterns = [
    /(?:[¥￥]\s*|人民币\s*)(\d{1,9}(?:[.,]\d{1,2})?)/gu,
    /(\d{1,9}(?:[.,]\d{1,2})?)\s*元(?:整)?/gu,
  ];
  lines.forEach((line, lineIndex) => {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const amount = Number(match[1].replace(",", "."));
        const amountCents = Math.round(amount * 100);
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 999_999_999_99) continue;
        const context = lines.slice(Math.max(0, lineIndex - 1), lineIndex + 2).join(" ");
        const positive = /(支付|付款|交易金额|实付|收款|到账|消费|金额)/u.test(context) ? 8 : 0;
        const payment = /(支付宝|微信支付|储蓄卡|信用卡|银行卡|招商银行|银联|账单)/u.test(context) ? 4 : 0;
        const reminder = /(应还|还款|余额|提醒|额度|分期)/u.test(context) ? -10 : 0;
        candidates.push({ amountCents, lineIndex, index: match.index ?? 0, score: positive + payment + reminder });
      }
    }
  });
  return candidates.sort((left, right) => right.score - left.score
    || left.lineIndex - right.lineIndex
    || left.index - right.index);
}

export function previewShortcutCapturePayload(body, { clock = () => new Date() } = {}) {
  if (!plainObject(body)) validationError({ body: "object" });
  const unknown = Object.keys(body).find((key) => !CAPTURE_PREVIEW_ALLOWED_KEYS.has(key));
  if (unknown) validationError({ [unknown]: "unknown" });
  const text = requiredText(body.text, "text", 12_000);
  if (body.source !== SHORTCUT_BOOKKEEPING_SOURCE) validationError({ source: "notAllowed" });
  const lines = normalizedOcrLines(text);
  const candidate = moneyCandidates(lines)[0];
  if (!candidate) validationError({ amount_cents: "notRecognized" });
  const relevantLines = lines
    .slice(Math.max(0, candidate.lineIndex - 1), Math.min(lines.length, candidate.lineIndex + 2))
    .join("\n")
    .slice(0, 800);
  const captured = clock();
  const capturedAt = captured instanceof Date ? captured : new Date(captured);
  if (Number.isNaN(capturedAt.getTime())) throw new TypeError("clock must return a valid Date");
  return {
    amountCents: candidate.amountCents,
    amountText: (candidate.amountCents / 100).toFixed(2),
    summaryText: relevantLines || `金额 ¥${(candidate.amountCents / 100).toFixed(2)}`,
    capturedAt: capturedAt.toISOString(),
  };
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
  if (![2, 3, 4].includes(parts.length) || parts.some((part) => !part)) {
    validationError({ selection_path: "format" });
  }
  const [ledgerName, entryType, category, subcategory] = parts.length === 4
    ? parts
    : parts.length === 3
      ? [DEFAULT_SHORTCUT_LEDGER, ...parts]
      : [DEFAULT_SHORTCUT_LEDGER, DEFAULT_SHORTCUT_ENTRY_TYPE, ...parts];
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

export function validateShortcutCapturePayload(body) {
  if (!plainObject(body)) validationError({ body: "object" });
  const unknown = Object.keys(body).find((key) => !CAPTURE_ALLOWED_KEYS.has(key));
  if (unknown) validationError({ [unknown]: "unknown" });
  const text = requiredText(body.text, "text", 12_000);
  const note = optionalText(body.note, "note", 1_000);
  const hasSelectionPath = body.selection_path !== undefined
    && body.selection_path !== null
    && body.selection_path !== "";
  const hasExpandedSelection = ["ledger_name", "entry_type", "category", "subcategory"]
    .some((key) => body[key] !== undefined);
  if (hasSelectionPath && hasExpandedSelection) validationError({ selection_path: "conflict" });
  const explicitSelection = hasSelectionPath || hasExpandedSelection;
  const resolved = explicitSelection
    ? hasSelectionPath
      ? resolveShortcutSelectionPath(body.selection_path)
      : resolveShortcutCategory({
          ledgerName: requiredText(body.ledger_name, "ledger_name", 50),
          entryType: requiredText(body.entry_type, "entry_type", 20),
          category: requiredText(body.category, "category", 100),
          subcategory: optionalText(body.subcategory, "subcategory", 100),
        })
    : resolveShortcutCategory({
        ledgerName: DEFAULT_SHORTCUT_LEDGER,
        entryType: DEFAULT_SHORTCUT_ENTRY_TYPE,
        category: "其他",
      });
  const amountCents = explicitSelection ? positiveCents(body.amount_cents) : null;
  const suppliedIdempotencyKey = optionalText(body.idempotency_key, "idempotency_key", 200);
  if (suppliedIdempotencyKey !== null
    && (body.idempotency_key !== suppliedIdempotencyKey
      || /[\u0000-\u001f\u007f-\u009f,]/u.test(suppliedIdempotencyKey))) {
    validationError({ idempotency_key: "format" });
  }
  // The screenshot-only Shortcut intentionally avoids constructing identifiers
  // from iOS rich values. A domain-separated digest makes retries of the same
  // OCR payload idempotent without persisting or exposing the financial text.
  const idempotencyKey = suppliedIdempotencyKey ?? captureIdempotencyKey(
    explicitSelection
      ? {
          text,
          ledgerName: resolved.ledgerName,
          entryType: resolved.entryType,
          category: resolved.category,
          subcategory: resolved.subcategory,
          note,
          amountCents,
        }
      : text,
    explicitSelection ? 2 : 1,
  );
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
    amountCents,
    note,
    idempotencyKey,
    source: SHORTCUT_BOOKKEEPING_SOURCE,
    capturedAt,
    sourceId,
    targetSystem: resolved.targetSystem,
    automaticCategorization: !explicitSelection,
    explicitCapture: explicitSelection,
  };
}

/**
 * Validate the two inline constants without ever returning them as part of the
 * business payload. Callers must remove these fields before hashing or
 * persisting a bookkeeping request.
 */
export function validateShortcutInlineCredentials(body) {
  if (!plainObject(body)) validationError({ body: "object" });
  return {
    account: requiredText(body.account, "account", 100),
    password: requiredText(body.password, "password", 1000),
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
  return String(method ?? "").toUpperCase() === "POST"
    && [
      SHORTCUT_BOOKKEEPING_ROUTE,
      SHORTCUT_BOOKKEEPING_CAPTURE_ROUTE,
      SHORTCUT_BOOKKEEPING_CAPTURE_PREVIEW_ROUTE,
    ].includes(path);
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
