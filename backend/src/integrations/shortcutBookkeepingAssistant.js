/**
 * Pure boundary between Shortcut bookkeeping results and a future
 * WeChat/Clawbot assistant adapter. It has no database, network, or identity
 * side effects.
 */

export const BOOKKEEPING_ASSISTANT_SCHEMA_VERSION = "shortcut-bookkeeping-assistant/v1";

export const BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS = Object.freeze([
  "occurredOn", "amountCents", "merchant", "purpose", "note", "category", "subcategory",
]);

export const BOOKKEEPING_ASSISTANT_PROTECTED_FIELDS = Object.freeze([
  "owner", "targetSystem", "idempotencyKey", "idempotency_key",
  "expenseId", "expense_id", "paymentId", "payment_id",
  "confirmationCode", "confirmation_code", "account", "source",
]);

const ALLOWED = new Set(BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS);
const PROTECTED = new Set(BOOKKEEPING_ASSISTANT_PROTECTED_FIELDS);
const FIELD_LIMITS = Object.freeze({
  occurredOn: 64, amountCents: 16, merchant: 500, purpose: 1_000,
  note: 1_000, category: 100, subcategory: 100,
});

const CORRECTION_LABELS = Object.freeze([
  ["发生时间", "occurredOn"], ["记账时间", "occurredOn"], ["日期", "occurredOn"], ["时间", "occurredOn"],
  ["金额", "amountCents"], ["花费", "amountCents"], ["费用", "amountCents"],
  ["商户", "merchant"], ["商家", "merchant"], ["店铺", "merchant"],
  ["用途", "purpose"], ["事由", "purpose"], ["备注", "note"], ["说明", "note"],
  ["子分类", "subcategory"], ["小类", "subcategory"], ["分类", "category"], ["大类", "category"],
]);

const PROTECTED_LABELS = Object.freeze([
  "owner", "账号", "账户", "账本", "targetSystem", "目标系统", "idempotency", "幂等",
  "expense", "payment", "付款", "确认码", "confirmation", "source", "来源",
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeText(value, field, warnings) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    warnings.push("invalid_" + field);
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > FIELD_LIMITS[field]
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    warnings.push(normalized.length > FIELD_LIMITS[field] ? "overlong_" + field : "invalid_" + field);
    return null;
  }
  return normalized;
}

function normalizeOccurredOn(value, warnings) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > FIELD_LIMITS.occurredOn) {
    warnings.push(value && typeof value === "string" && value.trim().length > FIELD_LIMITS.occurredOn
      ? "overlong_occurredOn" : "invalid_occurredOn");
    return null;
  }
  const normalized = value.trim();
  // A date-only or local date-time is rejected so the assistant never guesses
  // a timezone on behalf of the user.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)
      || !Number.isFinite(Date.parse(normalized))) {
    warnings.push("invalid_occurredOn");
    return null;
  }
  return normalized;
}

function normalizeAmount(value, warnings) {
  if (!Number.isSafeInteger(value) || value < 0 || String(value).length > FIELD_LIMITS.amountCents) {
    warnings.push("invalid_amountCents");
    return null;
  }
  return value;
}

function sourceFields(input) {
  if (!isPlainObject(input)) return { source: {}, envelopeInvalid: true };
  if (isPlainObject(input.item)) return sourceFields(input.item);
  if (isPlainObject(input.fields)) return { source: input.fields, envelopeInvalid: false };
  if (isPlainObject(input.analysis?.expense)) {
    const source = { ...input.analysis.expense };
    for (const key of ["category", "subcategory"]) {
      if (input[key] !== undefined) source[key] = input[key];
    }
    return { source, envelopeInvalid: false };
  }
  return { source: input, envelopeInvalid: false };
}

function projectSource(source, envelopeInvalid) {
  const warnings = [];
  const fields = {};
  if (envelopeInvalid) warnings.push("invalid_source");

  for (const key of Object.keys(source)) {
    if (!ALLOWED.has(key)) {
      warnings.push(PROTECTED.has(key) ? "protected_field:" + key : "unknown_field:" + key);
      continue;
    }
    if (Object.hasOwn(fields, key)) {
      warnings.push("duplicate_field:" + key);
      continue;
    }
    const value = key === "occurredOn"
      ? normalizeOccurredOn(source[key], warnings)
      : key === "amountCents"
        ? normalizeAmount(source[key], warnings)
        : normalizeText(source[key], key, warnings);
    if (value !== null) fields[key] = value;
  }

  const missingFields = BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS
    .filter((field) => ["occurredOn", "amountCents"].includes(field) && !Object.hasOwn(fields, field));
  for (const field of missingFields) warnings.push("missing_" + field);
  const normalizedWarnings = unique(warnings);
  return {
    schemaVersion: BOOKKEEPING_ASSISTANT_SCHEMA_VERSION,
    status: normalizedWarnings.length === 0 ? "ready" : "review_required",
    fields,
    missingFields,
    warnings: normalizedWarnings,
  };
}

/** Project a Shortcut/analysis envelope into a safe assistant-facing draft. */
export function projectShortcutBookkeepingDraft(input) {
  const { source, envelopeInvalid } = sourceFields(input);
  return projectSource(source, envelopeInvalid);
}

export const buildBookkeepingAssistantDraft = projectShortcutBookkeepingDraft;

function correctionFailure(warnings) {
  return { status: "review_required", changes: {}, warnings: unique(warnings) };
}

function splitCorrections(text) {
  return text.split(/[;；,，\n]+/u).map((part) => part.trim()).filter(Boolean);
}

function parseAmountText(value) {
  const match = /^(?:¥|￥)?\s*(\d{1,12})(?:\.(\d{1,2}))?\s*(?:元|块|人民币)?$/u.exec(value);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

function findCorrectionField(label) {
  return CORRECTION_LABELS.find(([name]) => name === label)?.[1] ?? null;
}

function parseCorrectionValue(field, value, warnings) {
  if (field === "amountCents") {
    const amount = parseAmountText(value);
    if (amount === null) warnings.push("invalid_amountCents");
    return amount;
  }
  if (field === "occurredOn") return normalizeOccurredOn(value, warnings);
  return normalizeText(value, field, warnings);
}

/**
 * Parse only explicit field corrections. Any ambiguity or protected-field
 * request returns review_required with no changes.
 */
export function parseShortcutBookkeepingCorrection(input) {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 1_000) {
    return correctionFailure(["invalid_correction"]);
  }
  const clauses = splitCorrections(input.trim());
  const changes = {};
  const warnings = [];
  for (const clause of clauses) {
    if (PROTECTED_LABELS.some((label) => clause.startsWith(label))) {
      warnings.push("protected_correction");
      continue;
    }
    const match = /^(.+?)\s*(?:改为|改成|修改为|调整为|设置为|设为|换成)\s*(.+)$/u.exec(clause);
    if (!match) {
      warnings.push("unrecognized_correction");
      continue;
    }
    const field = findCorrectionField(match[1].trim());
    if (!field) {
      warnings.push("unknown_correction_field");
      continue;
    }
    if (Object.hasOwn(changes, field)) {
      warnings.push("duplicate_correction:" + field);
      continue;
    }
    const valueWarnings = [];
    const value = parseCorrectionValue(field, match[2].trim(), valueWarnings);
    warnings.push(...valueWarnings);
    if (value !== null) changes[field] = value;
  }
  if (warnings.length > 0 || Object.keys(changes).length === 0) {
    return correctionFailure(warnings.length > 0 ? warnings : ["empty_correction"]);
  }
  return { status: "accepted", changes, warnings: [] };
}

export const parseBookkeepingCorrection = parseShortcutBookkeepingCorrection;

/** Apply only an accepted correction, then run the same projection gates. */
export function applyShortcutBookkeepingCorrection(draft, correction) {
  const base = projectShortcutBookkeepingDraft(isPlainObject(draft?.fields) ? draft.fields : draft);
  if (!isPlainObject(correction) || correction.status !== "accepted" || !isPlainObject(correction.changes)) {
    const warnings = unique([
      ...base.warnings,
      ...(Array.isArray(correction?.warnings) ? correction.warnings : ["invalid_correction"]),
    ]);
    return { ...base, status: "review_required", warnings };
  }
  const changes = {};
  for (const field of BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS) {
    if (Object.hasOwn(correction.changes, field)) changes[field] = correction.changes[field];
  }
  return projectShortcutBookkeepingDraft({ fields: { ...base.fields, ...changes } });
}

export const applyBookkeepingCorrection = applyShortcutBookkeepingCorrection;
