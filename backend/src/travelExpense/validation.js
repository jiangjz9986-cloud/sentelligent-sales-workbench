import { HttpError } from "../http/errors.js";
import { Base64DecodingError, decodeCanonicalBase64 } from "../http/strictBase64.js";
import { detectDocumentType, validateDocumentFileName } from "./invoiceRecognition.js";

export const MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES = 12 * 1024 * 1024;

const CATEGORIES = new Set(["breakfast", "lunch", "dinner", "lodging", "transport", "hospitality", "other"]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "card", "cash", "other"]);
const ATTACHMENT_KINDS = new Set(["payment_proof", "invoice", "substitute"]);
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ADVANCE_STATUSES = new Set(["draft", "requested", "received", "closed"]);

const EXPENSE_FIELDS = new Set([
  "occurredOn",
  "category",
  "purpose",
  "merchant",
  "itineraryId",
  "customerId",
  "notes",
  "payments",
]);
const PAYMENT_FIELDS = new Set([
  "id",
  "paidAt",
  "merchant",
  "amountCents",
  "reimbursementCents",
  "fundingSource",
  "paymentMethod",
  "accountLast4",
  "differenceReason",
]);
const ATTACHMENT_FIELDS = new Set([
  "paymentIds",
  "kind",
  "fileName",
  "mediaType",
  "contentBase64",
  "coveredCents",
  "notes",
]);
const ADVANCE_FIELDS = new Set([
  "weekStart",
  "status",
  "requestedCents",
  "receivedCents",
  "requestedOn",
  "receivedOn",
  "purpose",
  "notes",
]);

function fail(field, rule) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: rule });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, field = "body") {
  if (!isPlainObject(value)) fail(field, "object");
}

function assertAllowedKeys(value, fields, prefix = "") {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail(`${prefix}${key}`, "unknown");
  }
}

function requiredText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) fail(field, "required");
  const normalized = value.trim();
  if (normalized.length > max) fail(field, "max");
  return normalized;
}

function optionalText(value, field, max) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return value;
  if (typeof value !== "string") fail(field, "string");
  const normalized = value.trim();
  if (normalized.length > max) fail(field, "max");
  return normalized;
}

function enumValue(value, allowed, field, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!allowed.has(value)) fail(field, "enum");
  return value;
}

function cents(value, field, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value)) fail(field, "integer");
  if (value < 0) fail(field, "min");
  return value;
}

function dateOnly(value, field, { nullable = false, monday = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(field, "date");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(field, "date");
  if (monday && parsed.getUTCDay() !== 1) fail(field, "monday");
  return value;
}

function optionalDateOnly(value, field) {
  if (value === undefined) return undefined;
  return dateOnly(value, field, { nullable: true });
}

function dateTime(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(field, "dateTime");
  const normalized = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(normalized);
  if (!match) fail(field, "dateTime");
  dateOnly(match[1], field);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  const offsetHour = Number(match[6] ?? 0);
  const offsetMinute = Number(match[7] ?? 0);
  if (
    hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || Number.isNaN(Date.parse(normalized))
  ) {
    fail(field, "dateTime");
  }
  return normalized;
}

function optionalProperty(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function validatePayment(value, index) {
  const prefix = `payments[${index}].`;
  assertObject(value, `payments[${index}]`);
  assertAllowedKeys(value, PAYMENT_FIELDS, prefix);

  const amountCents = cents(value.amountCents, `${prefix}amountCents`);
  const reimbursementCents = cents(value.reimbursementCents, `${prefix}reimbursementCents`);
  if (reimbursementCents > amountCents) fail(`${prefix}reimbursementCents`, "maxAmount");

  const differenceReason = optionalText(value.differenceReason, `${prefix}differenceReason`, 2000);
  if (amountCents !== reimbursementCents && !differenceReason) fail(`${prefix}differenceReason`, "required");

  const accountLast4 = optionalText(value.accountLast4, `${prefix}accountLast4`, 4);
  if (accountLast4 && !/^\d{1,4}$/.test(accountLast4)) fail(`${prefix}accountLast4`, "digits");

  const result = {
    paidAt: dateTime(value.paidAt, `${prefix}paidAt`),
    amountCents,
    reimbursementCents,
    fundingSource: enumValue(value.fundingSource, FUNDING_SOURCES, `${prefix}fundingSource`),
  };
  optionalProperty(result, "id", value.id === undefined ? undefined : requiredText(value.id, `${prefix}id`, 200));
  optionalProperty(result, "merchant", optionalText(value.merchant, `${prefix}merchant`, 500));
  optionalProperty(result, "paymentMethod", enumValue(value.paymentMethod, PAYMENT_METHODS, `${prefix}paymentMethod`, { optional: true }));
  optionalProperty(result, "accountLast4", accountLast4);
  optionalProperty(result, "differenceReason", differenceReason);
  return result;
}

export function validateTravelExpensePayload(value) {
  assertObject(value);
  assertAllowedKeys(value, EXPENSE_FIELDS);
  if (!Array.isArray(value.payments) || value.payments.length < 1 || value.payments.length > 25) {
    fail("payments", "items");
  }
  const payments = value.payments.map(validatePayment);
  const suppliedIds = payments.flatMap((item) => (item.id ? [item.id] : []));
  if (new Set(suppliedIds).size !== suppliedIds.length) fail("payments", "uniqueIds");

  const result = {
    occurredOn: dateOnly(value.occurredOn, "occurredOn"),
    category: enumValue(value.category, CATEGORIES, "category"),
    purpose: requiredText(value.purpose, "purpose", 1000),
    payments,
  };
  optionalProperty(result, "merchant", optionalText(value.merchant, "merchant", 500));
  optionalProperty(result, "itineraryId", optionalText(value.itineraryId, "itineraryId", 200));
  optionalProperty(result, "customerId", optionalText(value.customerId, "customerId", 200));
  optionalProperty(result, "notes", optionalText(value.notes, "notes", 5000));
  return result;
}

export function validateTravelExpenseWeekStart(value) {
  return dateOnly(value, "weekStart", { monday: true });
}

export function validateTravelExpenseAdvancePayload(value) {
  assertObject(value);
  assertAllowedKeys(value, ADVANCE_FIELDS);
  const result = {
    weekStart: validateTravelExpenseWeekStart(value.weekStart),
    purpose: requiredText(value.purpose, "purpose", 1000),
  };
  optionalProperty(result, "status", enumValue(value.status, ADVANCE_STATUSES, "status", { optional: true }));
  optionalProperty(result, "requestedCents", cents(value.requestedCents, "requestedCents", { optional: true }));
  optionalProperty(result, "receivedCents", cents(value.receivedCents, "receivedCents", { optional: true }));
  optionalProperty(result, "requestedOn", optionalDateOnly(value.requestedOn, "requestedOn"));
  optionalProperty(result, "receivedOn", optionalDateOnly(value.receivedOn, "receivedOn"));
  optionalProperty(result, "notes", optionalText(value.notes, "notes", 5000));
  return result;
}

function decodeBase64(value) {
  try {
    return decodeCanonicalBase64(value, {
      maxDecodedBytes: MAX_TRAVEL_EXPENSE_ATTACHMENT_BYTES,
    });
  } catch (error) {
    if (error instanceof Base64DecodingError) fail("contentBase64", error.reason);
    throw error;
  }
}

export function validateTravelExpenseAttachmentPayload(value) {
  assertObject(value);
  assertAllowedKeys(value, ATTACHMENT_FIELDS);
  const mediaType = enumValue(value.mediaType, MEDIA_TYPES, "mediaType");
  const content = decodeBase64(value.contentBase64);
  if (detectDocumentType(content) !== mediaType) fail("contentBase64", "mediaTypeMagic");

  const kind = enumValue(value.kind, ATTACHMENT_KINDS, "kind");
  const paymentIds = value.paymentIds ?? [];
  if (!Array.isArray(paymentIds) || paymentIds.length > 25) fail("paymentIds", "array");
  const normalizedPaymentIds = paymentIds.map((item, index) => requiredText(item, `paymentIds[${index}]`, 200));
  if (new Set(normalizedPaymentIds).size !== normalizedPaymentIds.length) fail("paymentIds", "unique");
  if (kind === "payment_proof" && normalizedPaymentIds.length === 0) {
    fail("paymentIds", "requiredForPaymentProof");
  }

  let fileName;
  try {
    fileName = validateDocumentFileName(value.fileName);
  } catch {
    fail("fileName", "invalid");
  }

  const result = {
    paymentIds: normalizedPaymentIds,
    kind,
    fileName,
    mediaType,
    content,
  };
  optionalProperty(result, "coveredCents", cents(value.coveredCents, "coveredCents", { optional: true }));
  optionalProperty(result, "notes", optionalText(value.notes, "notes", 2000));
  return result;
}
