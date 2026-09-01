import {
  assertApiCollection,
  assertApiEntity,
} from "../../../../shared/salesWorkbenchApiContract.mjs";
import {
  MAX_AUDIO_BYTES,
  MIN_RECORDING_DURATION_MS,
  getTranscriptionPurposeLimits,
  normalizeRecorderMimeType,
} from "../audio/recordingCapabilities.js";
import { adaptTranscriptionError } from "../audio/serverTranscription.js";

export function resolveApiBaseUrl(env = {}, runtime = globalThis) {
  return String(env.VITE_API_BASE_URL ?? runtime?.__SENTELLIGENT_API_BASE_URL__ ?? "").trim().replace(/\/+$/, "");
}

const WRITABLE_FIELDS = Object.freeze({
  // v0.9.2：owner=服务端按会话注入的归属键，不再随请求体提交（传入即 422）。
  customer: Object.freeze([
    "name", "region", "type", "level", "contact", "relation", "stakeholders",
    "decisionChain", "historyProjects", "infrastructure", "syncPreview", "budget", "summary",
    "needs", "risks", "opportunities",
  ]),
  opportunity: Object.freeze([
    "customerId", "name", "customer", "stage", "amount", "probability", "days",
    "requirements", "competitors", "solutionDirection", "sourceRecord", "risk", "next", "tone",
  ]),
  knowledge: Object.freeze(["title", "category", "tags", "summary", "content", "source"]),
  actionCreate: Object.freeze(["title", "reason", "due", "remindAt", "priority", "customerId"]),
  itinerary: Object.freeze([
    "title", "visitDate", "status", "departureAddress", "departureCity", "departureLocation", "departureAt", "stops",
  ]),
  travelExpense: Object.freeze([
    "occurredOn", "category", "purpose", "merchant", "itineraryId", "customerId", "notes", "payments",
  ]),
  travelExpensePayment: Object.freeze([
    "id", "paidAt", "merchant", "amountCents", "reimbursementCents", "fundingSource",
    "paymentMethod", "accountLast4", "differenceReason",
  ]),
  travelExpenseAttachment: Object.freeze([
    "paymentIds", "kind", "fileName", "mediaType", "contentBase64", "coveredCents", "notes",
  ]),
  travelExpenseAdvance: Object.freeze([
    "weekStart", "status", "requestedCents", "receivedCents", "requestedOn", "receivedOn", "purpose", "notes",
  ]),
  travelExpenseRegionProfile: Object.freeze(["weekStart", "cities", "defaultCity", "dateOverrides"]),
  invoiceUpload: Object.freeze(["fileName", "mediaType", "contentBase64", "sourceRef"]),
  invoiceReview: Object.freeze([
    "invoiceCode", "invoiceNumber", "issuedOn", "sellerName", "buyerName",
    "amountExTaxCents", "taxCents", "totalCents", "suggestedCategory",
  ]),
  invoiceMatch: Object.freeze([
    "expenseReferenceCode", "paymentId", "allocatedCents", "matchMethod",
  ]),
  noInvoiceConfirmation: Object.freeze(["paymentId", "reason"]),
  documentInboxConfirm: Object.freeze(["expenseReferenceCode", "paymentId"]),
});

function pickOwnFields(source, fields) {
  const picked = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) picked[field] = source[field];
  }
  return picked;
}

function travelExpensePayload(expense) {
  const payload = pickOwnFields(expense, WRITABLE_FIELDS.travelExpense);
  if (Array.isArray(payload.payments)) {
    payload.payments = payload.payments.map((payment) => (
      pickOwnFields(payment, WRITABLE_FIELDS.travelExpensePayment)
    ));
  }
  return payload;
}

function assertTravelExpense(value, path = "travelExpense") {
  const expense = assertApiEntity("travelExpense", value, path);
  assertApiCollection("travelExpensePayment", expense.payments, `${path}.payments`);
  assertApiCollection("travelExpenseAttachment", expense.attachments, `${path}.attachments`);
  return expense;
}

function assertTravelExpenseCollection(values, path = "travelExpenses.items") {
  const expenses = assertApiCollection("travelExpense", values, path);
  expenses.forEach((expense, index) => assertTravelExpense(expense, `${path}[${index}]`));
  return expenses;
}

function assertTravelExpenseDocumentInbox(value, path = "travelExpenseDocumentInbox") {
  const item = assertApiEntity("travelExpenseDocumentInbox", value, path);
  assertApiCollection("travelExpenseDocumentCandidate", item.candidates, `${path}.candidates`);
  if (Object.hasOwn(item, "content") || Object.hasOwn(item, "contentBlob") || Object.hasOwn(item, "contentBase64")) {
    throw new TypeError(`${path}: document inbox JSON must not expose original document bytes`);
  }
  return item;
}

function assertShortcutBookkeepingLedgerReceipt(value, path = "shortcutBookkeepingLedgerReceipt") {
  const receipt = assertApiEntity("shortcutBookkeepingLedgerReceipt", value, path);
  if (!new Set(["matched", "pending", "not_available"]).has(receipt.attachmentStatus)) {
    throw new TypeError(`${path}.attachmentStatus: expected matched, pending, or not_available`);
  }
  return receipt;
}

function assertWeixinBookkeepingReview(value, path = "shortcutBookkeepingReview") {
  const item = assertApiEntity("shortcutBookkeepingReview", value, path);
  if (item.status === "accepted" && item.entryType === "expense") {
    assertShortcutBookkeepingLedgerReceipt(item.ledgerReceipt, `${path}.ledgerReceipt`);
  } else if (item.ledgerReceipt !== null) {
    throw new TypeError(`${path}.ledgerReceipt: only accepted expense records may expose a formal ledger receipt`);
  }
  return item;
}

function assertTravelExpenseWorkbench(value, path = "travelExpenseWorkbench") {
  const workbench = assertApiEntity("travelExpenseWorkbench", value, path);
  assertTravelExpenseCollection(workbench.expenses, `${path}.expenses`);
  assertApiCollection("travelExpenseAdvance", workbench.advances, `${path}.advances`);
  assertApiCollection("shortcutBookkeepingReview", workbench.bookkeepingReviews, `${path}.bookkeepingReviews`);
  workbench.bookkeepingReviews.forEach((item, index) => (
    assertWeixinBookkeepingReview(item, `${path}.bookkeepingReviews[${index}]`)
  ));
  assertTravelExpenseRegionProfile(workbench.regionProfile, `${path}.regionProfile`);
  if (!Array.isArray(workbench.recentLedgerReceipts)) {
    throw new TypeError(`${path}.recentLedgerReceipts: expected array`);
  }
  workbench.recentLedgerReceipts.forEach((item, index) => (
    assertRecentLedgerReceipt(item, `${path}.recentLedgerReceipts[${index}]`)
  ));
  return workbench;
}

function apiObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path}: expected object`);
  }
  return value;
}

function requiredApiString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path}: expected non-empty string`);
  return value;
}

function requiredApiVersion(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${path}: expected positive integer`);
  return value;
}

function nullableApiCents(value, path) {
  if (value === null || value === undefined) return value;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path}: expected non-negative integer cents`);
  return value;
}

function requiredDateOnly(value, path) {
  requiredApiString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new TypeError(`${path}: expected YYYY-MM-DD`);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${path}: expected real calendar date`);
  return value;
}

function assertTravelExpenseRegionProfile(value, path = "travelExpenseRegionProfile") {
  const profile = apiObject(value, path);
  requiredDateOnly(profile.weekStart, `${path}.weekStart`);
  requiredDateOnly(profile.weekEnd, `${path}.weekEnd`);
  if (!Number.isSafeInteger(profile.version) || profile.version < 0) {
    throw new TypeError(`${path}.version: expected non-negative integer`);
  }
  if (!Array.isArray(profile.cities)) throw new TypeError(`${path}.cities: expected array`);
  profile.cities.forEach((city, index) => requiredApiString(city, `${path}.cities[${index}]`));
  if (profile.defaultCity !== null) requiredApiString(profile.defaultCity, `${path}.defaultCity`);
  if (!Array.isArray(profile.dateOverrides)) throw new TypeError(`${path}.dateOverrides: expected array`);
  profile.dateOverrides.forEach((override, index) => {
    const item = apiObject(override, `${path}.dateOverrides[${index}]`);
    requiredDateOnly(item.date, `${path}.dateOverrides[${index}].date`);
    requiredApiString(item.city, `${path}.dateOverrides[${index}].city`);
  });
  return profile;
}

function assertRecentLedgerReceipt(value, path = "recentLedgerReceipt") {
  const receipt = apiObject(value, path);
  for (const field of ["entryId", "expenseId", "paymentId", "referenceCode", "acceptedAt"]) {
    requiredApiString(receipt[field], `${path}.${field}`);
  }
  requiredDateOnly(receipt.occurredOn, `${path}.occurredOn`);
  requiredDateOnly(receipt.weekStart, `${path}.weekStart`);
  nullableApiCents(receipt.amountCents, `${path}.amountCents`);
  nullableApiCents(receipt.reimbursementCents, `${path}.reimbursementCents`);
  if (!new Set(["matched", "pending", "not_available"]).has(receipt.attachmentStatus)) {
    throw new TypeError(`${path}.attachmentStatus: expected matched, pending, or not_available`);
  }
  return receipt;
}

function apiItems(values, path, assertItem) {
  if (!Array.isArray(values)) throw new TypeError(`${path}: expected array`);
  return values.map((value, index) => assertItem(value, `${path}[${index}]`));
}

/**
 * Confirmation preview data is durable server state.  Keep the public API
 * boundary strict so the page never performs a write against a partial or
 * substituted preview.
 */
function assertQuickRecordConfirmationPreview(value, path = "quickRecordConfirmationPreview") {
  const preview = assertApiEntity("quickRecordConfirmationPreview", value, path);
  if (!Array.isArray(preview.items)) throw new TypeError(`${path}.items: expected array`);
  if (!Array.isArray(preview.evidence)) throw new TypeError(`${path}.evidence: expected array`);
  if (!Array.isArray(preview.bulkEligibleItemIds)) {
    throw new TypeError(`${path}.bulkEligibleItemIds: expected array`);
  }
  return preview;
}

function assertQuickRecordConfirmationOutcome(value, path = "quickRecordConfirmationOutcome") {
  const outcome = assertApiEntity("quickRecordConfirmationOutcome", value, path);
  assertQuickRecordConfirmationPreview(outcome.preview, `${path}.preview`);
  if (!Array.isArray(outcome.confirmedItems)) throw new TypeError(`${path}.confirmedItems: expected array`);
  if (!Array.isArray(outcome.excludedItems)) throw new TypeError(`${path}.excludedItems: expected array`);
  return outcome;
}

function confirmationPreviewUrl(previewId, suffix = "") {
  const id = requiredApiString(previewId, "previewId");
  return `/api/quick-record-confirmation-previews/${encodeURIComponent(id)}${suffix}`;
}

function assertInvoice(value, path = "invoice") {
  const invoice = apiObject(value, path);
  requiredApiString(invoice.id, `${path}.id`);
  requiredApiVersion(invoice.version, `${path}.version`);
  requiredApiString(invoice.fileName, `${path}.fileName`);
  requiredApiString(invoice.mediaType, `${path}.mediaType`);
  requiredApiString(invoice.status, `${path}.status`);
  nullableApiCents(invoice.totalCents, `${path}.totalCents`);
  if (!Array.isArray(invoice.conflicts ?? [])) throw new TypeError(`${path}.conflicts: expected array`);
  if (Object.hasOwn(invoice, "content") || Object.hasOwn(invoice, "contentBlob") || Object.hasOwn(invoice, "contentBase64")) {
    throw new TypeError(`${path}: invoice JSON must not expose original document bytes`);
  }
  return invoice;
}

function assertInvoiceMatch(value, path = "invoiceMatch") {
  const match = apiObject(value, path);
  requiredApiString(match.id, `${path}.id`);
  requiredApiVersion(match.version, `${path}.version`);
  requiredApiString(match.invoiceId, `${path}.invoiceId`);
  requiredApiString(match.expenseId, `${path}.expenseId`);
  requiredApiString(match.state, `${path}.state`);
  nullableApiCents(match.allocatedCents, `${path}.allocatedCents`);
  return match;
}

function assertNoInvoiceConfirmation(value, path = "noInvoiceConfirmation") {
  const confirmation = apiObject(value, path);
  requiredApiString(confirmation.id, `${path}.id`);
  requiredApiVersion(confirmation.version, `${path}.version`);
  requiredApiString(confirmation.expenseId, `${path}.expenseId`);
  nullableApiCents(confirmation.amountSnapshotCents, `${path}.amountSnapshotCents`);
  return confirmation;
}

function assertInvoiceCoverage(value, path = "invoiceCoverage") {
  const coverage = apiObject(value, path);
  requiredApiString(coverage.weekStart, `${path}.weekStart`);
  for (const field of ["reimbursementCents", "confirmedCoverageCents", "electronicInvoiceCoverageCents", "substituteInvoiceCoverageCents", "noInvoiceConfirmedCents", "missingInvoiceCents", "invoiceWarehouseAvailableCents"]) {
    nullableApiCents(coverage[field], `${path}.${field}`);
  }
  return coverage;
}

function assertInvoiceCandidate(value, path = "invoiceCandidate") {
  const candidate = apiObject(value, path);
  requiredApiString(candidate.id, `${path}.id`);
  requiredApiVersion(candidate.version, `${path}.version`);
  requiredApiString(candidate.invoiceId, `${path}.invoiceId`);
  requiredApiString(candidate.expenseId, `${path}.expenseId`);
  requiredApiString(candidate.status, `${path}.status`);
  nullableApiCents(candidate.proposedCents, `${path}.proposedCents`);
  if (!Array.isArray(candidate.rationale ?? [])) throw new TypeError(`${path}.rationale: expected array`);
  return candidate;
}

function assertHospitalTenderNotice(value, path = "hospitalTenderNotice") {
  return assertApiEntity("hospitalTenderNotice", value, path);
}

function assertHospitalTenderSource(value, path = "hospitalTenderSource") {
  return assertApiEntity("hospitalTenderSource", value, path);
}

function hospitalTenderLeadConversionUrl(noticeId, action) {
  const id = requiredApiString(noticeId, "noticeId");
  if (!new Set(["preview", "confirm", "cancel"]).has(action)) {
    throw new TypeError("A valid hospital tender lead-conversion action is required");
  }
  return `/api/hospital-tenders/${encodeURIComponent(id)}/lead-conversion/${action}`;
}

function assertHospitalTenderLeadConversionPreview(value, path = "hospitalTenderLeadConversionPreview") {
  const preview = assertApiEntity("hospitalTenderLeadConversionPreview", value, path);
  if (preview.status !== "preview" || preview.requiresHumanConfirmation !== true) {
    throw new TypeError(`${path}: expected a human-confirmation preview`);
  }
  requiredApiString(preview.previewDigest, `${path}.previewDigest`);
  requiredApiString(preview.customer?.id, `${path}.customer.id`);
  requiredApiString(preview.drafts?.opportunity?.name, `${path}.drafts.opportunity.name`);
  requiredApiString(preview.drafts?.actionItem?.title, `${path}.drafts.actionItem.title`);
  return preview;
}

function assertHospitalTenderLeadConversionConfirmation(value, path = "hospitalTenderLeadConversionConfirmation") {
  const confirmation = assertApiEntity("hospitalTenderLeadConversionConfirmation", value, path);
  if (confirmation.status !== "confirmed" || confirmation.requiresHumanConfirmation !== false) {
    throw new TypeError(`${path}: expected a confirmed terminal result`);
  }
  requiredApiString(confirmation.opportunity?.id, `${path}.opportunity.id`);
  requiredApiString(confirmation.actionItem?.id, `${path}.actionItem.id`);
  return confirmation;
}

function assertHospitalTenderLeadConversionCancellation(value, path = "hospitalTenderLeadConversionCancellation") {
  const cancellation = assertApiEntity("hospitalTenderLeadConversionCancellation", value, path);
  if (cancellation.status !== "cancelled" || cancellation.requiresHumanConfirmation !== false) {
    throw new TypeError(`${path}: expected a cancelled terminal result`);
  }
  return cancellation;
}

function idempotencyHeaders(options, label) {
  const key = String(options?.idempotencyKey ?? "");
  if (!key || key.trim() !== key) throw new TypeError(`A valid ${label} Idempotency-Key is required`);
  return { "Idempotency-Key": key };
}

function queryPath(path, values) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function versionHeaders(version) {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError("A positive integer entity version is required");
  }
  return { "If-Match": `"${version}"` };
}

function nonNegativeVersionHeaders(version) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError("A non-negative integer entity version is required");
  }
  return { "If-Match": `"${version}"` };
}

export function createStrongUuid(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  if (typeof cryptoImpl?.getRandomValues !== "function") {
    throw new Error("A cryptographic random source is required for confirmation attempts");
  }

  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function confirmationAttemptFingerprint(input) {
  return JSON.stringify({
    quickRecordId: input.quickRecordId ?? null,
    analysisVersionId: input.analysisVersionId ?? null,
    targets: [...(input.targets ?? [])].map(String).sort(),
  });
}

export function createConfirmationAttemptTracker({ createId = createStrongUuid } = {}) {
  let current = null;
  return {
    keyFor(input) {
      const fingerprint = confirmationAttemptFingerprint(input);
      if (!current || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: createId() };
      }
      return current.key;
    },
    complete(key) {
      if (current?.key === key) current = null;
    },
    reset() {
      current = null;
    },
  };
}

function requestHeaders(options, csrfToken) {
  const method = String(options.method ?? "GET").toUpperCase();
  const suppliedHeaders = { ...(options.headers ?? {}) };
  for (const name of Object.keys(suppliedHeaders)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "authorization" || normalizedName === "x-csrf-token") {
      delete suppliedHeaders[name];
    }
  }

  return {
    "Content-Type": "application/json",
    ...suppliedHeaders,
    ...(method !== "GET" && method !== "HEAD" && csrfToken
      ? { "X-CSRF-Token": csrfToken }
      : {}),
  };
}

async function readResponseBody(response) {
  if (typeof response?.text !== "function") return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(response, body) {
  const details = body && typeof body === "object" ? body.error : null;
  const error = new Error(
    details?.message ?? `Request failed with ${response?.status ?? "unknown status"}`,
  );
  error.status = response?.status;
  error.code = details?.code;
  error.fields = details?.fields;
  error.details = details?.fields;
  error.currentVersion = details?.fields?.currentVersion;
  error.requestId = details?.requestId;
  error.body = body;
  error.retryAfterHeader = typeof response?.headers?.get === "function"
    ? response.headers.get("retry-after")
    : null;
  return error;
}

const VISIT_TEMPERATURE_STATUSES = new Set(["pending", "confirmed", "cancelled", "expired", "conflict"]);
const VISIT_TEMPERATURE_IDENTIFIER = /^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u;

function visitTemperatureText(value, fallback = "", max = 2_000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= max ? normalized : fallback;
}

function visitTemperatureRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = visitTemperatureText(value.type, "", 200);
  const id = visitTemperatureText(value.id, "", 200);
  return type && id && VISIT_TEMPERATURE_IDENTIFIER.test(type) && VISIT_TEMPERATURE_IDENTIFIER.test(id)
    ? { type, id }
    : null;
}

function visitTemperatureList(value, mapper) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new TypeError("visit temperature list is invalid");
  const mapped = value.map(mapper);
  if (mapped.some((item) => !item)) throw new TypeError("visit temperature list contains invalid item");
  return mapped;
}

/**
 * Keep the temperature-suggestion boundary deliberately smaller than the
 * generic API error boundary. The service can return internal details, but
 * none of those details are needed by the confirmation UI.
 */
export function assertVisitTemperatureSuggestion(value, path = "visitTemperatureSuggestion") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path}: expected object`);
  }
  const status = visitTemperatureText(value.status).toLowerCase();
  if (!VISIT_TEMPERATURE_STATUSES.has(status)) throw new TypeError(`${path}.status: invalid`);
  const id = visitTemperatureText(value.id, "", 200);
  const visitId = visitTemperatureText(value.visitId, "", 200);
  const customerId = visitTemperatureText(value.customerId, "", 200);
  if (!id || !visitId || !customerId
    || !VISIT_TEMPERATURE_IDENTIFIER.test(id)
    || !VISIT_TEMPERATURE_IDENTIFIER.test(visitId)
    || !VISIT_TEMPERATURE_IDENTIFIER.test(customerId)) throw new TypeError(`${path}: missing identity`);
  const integer = (field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const next = value[field];
    if (!Number.isSafeInteger(next) || next < min || next > max) throw new TypeError(`${path}.${field}: invalid`);
    return next;
  };
  const identity = visitTemperatureText(value.identity);
  if (!/^[0-9a-f]{64}$/u.test(identity)) throw new TypeError(`${path}.identity: invalid`);
  const facts = visitTemperatureList(value.facts, (fact) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return null;
    const key = visitTemperatureText(fact.key);
    if (!key) return null;
    if (!Number.isSafeInteger(fact.confidence) || fact.confidence < 0 || fact.confidence > 100
      || !(typeof fact.value === "string" || typeof fact.value === "number" || typeof fact.value === "boolean")
      || !Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
      throw new TypeError(`${path}.facts: invalid evidence`);
    }
    return {
      key,
      label: visitTemperatureText(fact.label, key),
      value: fact.value,
      confidence: fact.confidence,
      sourceRefs: visitTemperatureList(fact.sourceRefs, visitTemperatureRef),
    };
  });
  const inferences = visitTemperatureList(value.inferences, (inference) => {
    if (!inference || typeof inference !== "object" || Array.isArray(inference)) return null;
    const claim = visitTemperatureText(inference.claim);
    if (!claim || !Number.isSafeInteger(inference.confidence) || inference.confidence < 0 || inference.confidence > 100) {
      throw new TypeError(`${path}.inferences: invalid evidence`);
    }
    return {
      claim,
      basis: visitTemperatureText(inference.basis),
      confidence: inference.confidence,
      sourceRefs: visitTemperatureList(inference.sourceRefs, visitTemperatureRef),
    };
  });
  const sourceRefs = visitTemperatureList(value.sourceRefs, visitTemperatureRef);
  if (facts.length === 0 || inferences.length === 0 || sourceRefs.length === 0
    || typeof value.requiresHumanConfirmation !== "boolean"
    || typeof value.writebackAllowed !== "boolean") {
    throw new TypeError(`${path}: evidence is required`);
  }
  const previousValue = integer("previousValue", { max: 100 });
  const suggestedValue = integer("suggestedValue", { max: 100 });
  const delta = integer("delta", { min: -100, max: 100 });
  if (delta !== suggestedValue - previousValue) throw new TypeError(`${path}.delta: invalid`);
  return assertApiEntity("visitTemperatureSuggestion", {
    id,
    identity,
    status,
    owner: visitTemperatureText(value.owner, "", 200),
    visitId,
    customerId,
    previousValue,
    suggestedValue,
    delta,
    confidence: integer("confidence", { max: 100 }),
    customerVersion: integer("customerVersion", { min: 1 }),
    facts,
    inferences,
    sourceRefs,
    requiresHumanConfirmation: value.requiresHumanConfirmation === true,
    writebackAllowed: value.writebackAllowed === true,
    createdAt: visitTemperatureText(value.createdAt, ""),
    expiresAt: visitTemperatureText(value.expiresAt, ""),
    confirmedAt: value.confirmedAt == null ? null : visitTemperatureText(value.confirmedAt, ""),
    cancelledAt: value.cancelledAt == null ? null : visitTemperatureText(value.cancelledAt, ""),
    replayed: value.replayed === true,
    writeback: value.writeback === true,
    reason: visitTemperatureText(value.reason, ""),
  }, path);
}

export function normalizeVisitTemperatureError(error) {
  if (error?.code === "VISIT_TEMPERATURE_TIMEOUT" || error?.name === "TimeoutError") {
    const next = new Error("温度建议请求超时，请检查连接后重试");
    next.code = "TIMEOUT";
    next.status = error.status;
    next.requestId = error.requestId;
    return next;
  }
  if (error?.status === 401) {
    const next = new Error("登录状态已失效，请重新登录后重试");
    next.code = "AUTH_REQUIRED";
    next.status = 401;
    next.requestId = error.requestId;
    return next;
  }
  if (error?.status === 409) {
    const next = new Error("数据已变化，请重新获取最新建议后再操作");
    next.code = "CONFLICT";
    next.status = 409;
    next.requestId = error.requestId;
    return next;
  }
  if (error?.status >= 500) {
    const next = new Error("温度建议暂时不可用，请稍后重试");
    next.code = "INTERNAL_ERROR";
    next.status = error.status;
    next.requestId = error.requestId;
    return next;
  }
  if (error?.name === "AbortError") {
    const next = new Error("温度建议请求已中止，请重试");
    next.code = "ABORTED";
    next.name = "AbortError";
    return next;
  }
  return error;
}

function visitTemperatureOutcome(value, path = "visitTemperatureOutcome") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path}: expected object`);
  }
  const status = visitTemperatureText(value.status).toLowerCase();
  if (!VISIT_TEMPERATURE_STATUSES.has(status)) throw new TypeError(`${path}.status: invalid`);
  const snapshot = (candidate, field) => {
    if (candidate === null || candidate === undefined) return null;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || typeof candidate.id !== "string" || !candidate.id.trim()
      || !Number.isSafeInteger(candidate.relation) || candidate.relation < 0 || candidate.relation > 100
      || !Number.isSafeInteger(candidate.version) || candidate.version < 1) {
      throw new TypeError(`${path}.${field}: invalid`);
    }
    return { id: candidate.id.trim(), relation: candidate.relation, version: candidate.version };
  };
  const suggestion = value.suggestion
    ? assertVisitTemperatureSuggestion(value.suggestion, `${path}.suggestion`)
    : null;
  return assertApiEntity("visitTemperatureOutcome", {
    status,
    suggestion,
    customer: snapshot(value.customer, "customer"),
    currentCustomer: snapshot(value.currentCustomer, "currentCustomer"),
    writeback: value.writeback === true,
    replayed: value.replayed === true,
    reason: visitTemperatureText(value.reason, ""),
  }, path);
}

export function parseRetryAfterSeconds(value) {
  if (typeof value !== "string" || !/^\d{1,3}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 300 ? seconds : null;
}

export function assertTranscriptionResponse(response, purpose) {
  const limits = getTranscriptionPurposeLimits(purpose);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("transcription response: expected object");
  }
  if (typeof response.requestId !== "string" || !response.requestId.trim()) {
    throw new TypeError("transcription response.requestId: expected non-empty string");
  }
  const item = response.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("transcription response.item: expected object");
  }
  if (
    typeof item.transcript !== "string"
    || !item.transcript
    || item.transcript.length > limits.maxTranscriptCharacters
    || item.transcript !== item.transcript.normalize("NFC")
    || item.transcript.trim() !== item.transcript
    || /[\u0000-\u0008\u000B-\u001F]/u.test(item.transcript)
  ) {
    throw new TypeError("transcription response.item.transcript: invalid text length");
  }
  if (item.language !== "zh-CN") {
    throw new TypeError("transcription response.item.language: expected zh-CN");
  }
  if (
    !Number.isInteger(item.durationMs)
    || item.durationMs < MIN_RECORDING_DURATION_MS
    || item.durationMs > limits.maxDurationMs
  ) {
    throw new TypeError("transcription response.item.durationMs: outside purpose limit");
  }
  if (item.source !== "server_asr") {
    throw new TypeError("transcription response.item.source: expected server_asr");
  }
  if (typeof item.replayed !== "boolean") {
    throw new TypeError("transcription response.item.replayed: expected boolean");
  }
  // Return a newly constructed capability object. Provider/debug fields from
  // a successful upstream payload never cross the API-client boundary.
  return {
    requestId: response.requestId,
    item: {
      transcript: item.transcript,
      language: item.language,
      durationMs: item.durationMs,
      source: item.source,
      replayed: item.replayed,
    },
  };
}

function assertTranscriptionRequest({ blob, purpose, durationMs, idempotencyKey }) {
  const limits = getTranscriptionPurposeLimits(purpose);
  if (!blob || typeof blob.size !== "number" || typeof blob.slice !== "function") {
    throw new TypeError("transcription blob: expected raw Blob");
  }
  if (blob.size <= 0 || blob.size > MAX_AUDIO_BYTES) {
    throw new TypeError("transcription blob: expected 1..8388608 bytes");
  }
  if (!normalizeRecorderMimeType(blob.type)) {
    throw new TypeError("transcription blob.type: unsupported audio media type");
  }
  if (!Number.isInteger(durationMs) || durationMs < MIN_RECORDING_DURATION_MS || durationMs > limits.maxDurationMs) {
    throw new TypeError("transcription durationMs: outside purpose limit");
  }
  if (
    typeof idempotencyKey !== "string"
    || idempotencyKey.trim() !== idempotencyKey
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(idempotencyKey)
  ) {
    throw new TypeError("transcription Idempotency-Key: invalid");
  }
}

export async function requestJson(fetchImpl, url, options = {}, csrfToken = "") {
  const response = await fetchImpl(url, {
    ...options,
    credentials: "include",
    headers: requestHeaders(options, csrfToken),
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw toApiError(response, body);
  }

  return body;
}

function displaySession(session) {
  if (
    !session?.account ||
    typeof session.expiresAt !== "string" ||
    Number.isNaN(Date.parse(session.expiresAt)) ||
    !session.csrfToken
  ) {
    throw new Error("登录响应缺少必要会话信息");
  }
  return {
    account: String(session.account).trim(),
    displayName: String(session.displayName ?? session.account).trim() || String(session.account).trim(),
    role: session.role === "admin" ? "admin" : "member",
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function contentDispositionFilename(headers) {
  const value = typeof headers?.get === "function"
    ? headers.get("content-disposition")
    : headers?.["content-disposition"] ?? headers?.["Content-Disposition"];
  if (!value) return null;

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename=(?:"([^"]+)"|([^;]+))/i.exec(value);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

export function createSalesWorkbenchApi({ baseUrl, fetchImpl = fetch, onUnauthorized } = {}) {
  const root = resolveApiBaseUrl({ VITE_API_BASE_URL: baseUrl });
  let csrfToken = "";
  let sessionGeneration = 0;
  let restoreRequestId = 0;
  let loginRequestId = 0;

  function url(path) {
    if (!root) throw new Error("API base URL is not configured");
    return `${root}${path}`;
  }

  function replaceSession(session) {
    sessionGeneration += 1;
    restoreRequestId += 1;
    loginRequestId += 1;
    csrfToken = String(session?.csrfToken ?? "");
  }

  function setSession(session) {
    replaceSession(session);
  }

  function staleSessionError() {
    const error = new Error("Stale session response was ignored");
    error.code = "STALE_SESSION_RESPONSE";
    return error;
  }

  function invalidateSession(error, expectedGeneration) {
    if (expectedGeneration !== sessionGeneration) return false;
    replaceSession(null);
    onUnauthorized?.(error);
    return true;
  }

  async function requestApi(path, options = {}) {
    const requestGeneration = sessionGeneration;
    const requestCsrfToken = csrfToken;
    try {
      return await requestJson(fetchImpl, url(path), options, requestCsrfToken);
    } catch (error) {
      if (error?.status === 401 && !options.signal?.aborted) {
        invalidateSession(error, requestGeneration);
      }
      throw error;
    }
  }

  async function requestApiResponse(path, options = {}) {
    const requestGeneration = sessionGeneration;
    try {
      const response = await fetchImpl(url(path), {
        ...options,
        credentials: "include",
      });
      if (!response.ok) {
        throw toApiError(response, await readResponseBody(response));
      }
      return response;
    } catch (error) {
      if (error?.status === 401 && !options.signal?.aborted) {
        invalidateSession(error, requestGeneration);
      }
      throw error;
    }
  }

  function bootstrapItems(responseName, entityName, response) {
    return assertApiCollection(entityName, response?.items, `${responseName}.items`);
  }

  async function createQuickRecord(rawContent, metadata = {}) {
    const created = await requestApi("/api/quick-records", {
      method: "POST",
      body: JSON.stringify({
        rawContent,
        occurredAt: metadata.occurredAt ?? new Date().toISOString(),
        sourceChannel: metadata.sourceChannel ?? "快速记录",
        customerId: metadata.customerId ?? null,
        opportunityId: metadata.opportunityId ?? null,
      }),
    });

    return assertApiEntity("quickRecord", created.item);
  }

  async function requestVisitTemperature(path, options = {}, { signal, timeoutMs = 10_000 } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abortFromParent();
      else signal.addEventListener("abort", abortFromParent, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    try {
      return await requestApi(path, { ...options, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error("温度建议请求超时");
        timeoutError.name = "TimeoutError";
        timeoutError.code = "VISIT_TEMPERATURE_TIMEOUT";
        throw normalizeVisitTemperatureError(timeoutError);
      }
      throw normalizeVisitTemperatureError(error);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  async function createVisitTemperatureSuggestion(visitId, { signal, timeoutMs } = {}) {
    let response;
    try {
      response = await requestVisitTemperature("/api/visit-temperature-suggestions", {
        method: "POST",
        body: JSON.stringify({ visitId: requiredApiString(visitId, "visitId") }),
      }, { signal, timeoutMs });
    } catch (error) {
      throw normalizeVisitTemperatureError(error);
    }
    return assertVisitTemperatureSuggestion(response?.item, "visitTemperatureSuggestion.item");
  }

  async function listVisitTemperatureSuggestions({ customerId, limit, signal, timeoutMs } = {}) {
    let response;
    try {
      response = await requestVisitTemperature(queryPath("/api/visit-temperature-suggestions", { customerId, limit }), {}, { signal, timeoutMs });
    } catch (error) {
      throw normalizeVisitTemperatureError(error);
    }
    const item = response?.item;
    if (!item || typeof item !== "object" || !Array.isArray(item.items)) {
      throw new TypeError("visitTemperatureSuggestions.items: expected array");
    }
    return {
      items: item.items.map((suggestion, index) => assertVisitTemperatureSuggestion(
        suggestion,
        `visitTemperatureSuggestions.items[${index}]`,
      )),
      truncated: item.truncated === true,
    };
  }

  async function getVisitTemperatureSuggestion(suggestionId, { signal, timeoutMs } = {}) {
    let response;
    try {
      response = await requestVisitTemperature(`/api/visit-temperature-suggestions/${encodeURIComponent(requiredApiString(suggestionId, "suggestionId"))}`, {}, { signal, timeoutMs });
    } catch (error) {
      throw normalizeVisitTemperatureError(error);
    }
    return assertVisitTemperatureSuggestion(response?.item, "visitTemperatureSuggestion.item");
  }

  async function confirmVisitTemperatureSuggestion(suggestion, { signal, timeoutMs } = {}) {
    if (!suggestion || typeof suggestion !== "object") throw new TypeError("suggestion is required");
    if (!Number.isSafeInteger(suggestion.previousValue) || suggestion.previousValue < 0 || suggestion.previousValue > 100) {
      throw new TypeError("previousValue must be an integer from 0 to 100");
    }
    let response;
    try {
      response = await requestVisitTemperature(`/api/visit-temperature-suggestions/${encodeURIComponent(requiredApiString(suggestion.id, "suggestionId"))}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          suggestionIdentity: requiredApiString(suggestion.identity, "suggestionIdentity"),
          expectedCustomerVersion: requiredApiVersion(suggestion.customerVersion, "expectedCustomerVersion"),
          previousValue: Number(suggestion.previousValue),
          confirm: true,
        }),
      }, { signal, timeoutMs });
    } catch (error) {
      throw normalizeVisitTemperatureError(error);
    }
    return visitTemperatureOutcome(response?.item, "visitTemperatureConfirmation.item");
  }

  async function cancelVisitTemperatureSuggestion(suggestion, { signal, timeoutMs } = {}) {
    if (!suggestion || typeof suggestion !== "object") throw new TypeError("suggestion is required");
    let response;
    try {
      response = await requestVisitTemperature(`/api/visit-temperature-suggestions/${encodeURIComponent(requiredApiString(suggestion.id, "suggestionId"))}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          suggestionIdentity: requiredApiString(suggestion.identity, "suggestionIdentity"),
          cancel: true,
        }),
      }, { signal, timeoutMs });
    } catch (error) {
      throw normalizeVisitTemperatureError(error);
    }
    const item = response?.item;
    return item?.suggestion
      ? visitTemperatureOutcome(item, "visitTemperatureCancellation.item")
      : { status: item?.status, suggestion: assertVisitTemperatureSuggestion(item, "visitTemperatureCancellation.item"), replayed: item?.replayed === true };
  }

  return {
    isEnabled: Boolean(root),
    setSession,

    async transcribeAudio({
      blob,
      purpose,
      durationMs,
      idempotencyKey,
      signal,
    }) {
      assertTranscriptionRequest({ blob, purpose, durationMs, idempotencyKey });
      let response;
      try {
        response = await requestApi(
          `/api/asr/transcriptions?purpose=${encodeURIComponent(purpose)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": normalizeRecorderMimeType(blob.type),
              "Idempotency-Key": idempotencyKey,
              "X-Audio-Duration-Ms": String(durationMs),
              "X-ASR-Language": "zh-CN",
            },
            body: blob,
            signal,
          },
        );
      } catch (error) {
        const code = signal?.aborted
          ? "ASR_ABORTED"
          : typeof error?.code === "string"
            ? error.code
            : Number.isInteger(error?.status)
              ? "ASR_UNKNOWN_ERROR"
              : "ASR_NETWORK_ERROR";
        throw adaptTranscriptionError({
          code,
          name: signal?.aborted ? "AbortError" : error?.name,
          status: error?.status,
          requestId: error?.requestId,
          retryAfterSeconds: parseRetryAfterSeconds(error?.retryAfterHeader),
        });
      }
      try {
        return assertTranscriptionResponse(response, purpose);
      } catch {
        // A 2xx response with a malformed provider-shaped payload is a
        // transient provider contract failure. Keep the error sanitized and
        // eligible for the one same-Blob retry; never expose response body.
        throw adaptTranscriptionError({
          code: "ASR_PROVIDER_BAD_RESPONSE",
          status: 502,
          requestId: response?.requestId,
        });
      }
    },

    async login({ account, password }) {
      const requestId = ++loginRequestId;
      restoreRequestId += 1;
      const requestGeneration = sessionGeneration;
      const session = await requestJson(fetchImpl, url("/api/auth/login"), {
        method: "POST",
        body: JSON.stringify({ account, password }),
      });
      const result = displaySession(session);
      if (requestId !== loginRequestId || requestGeneration !== sessionGeneration) {
        throw staleSessionError();
      }
      replaceSession(session);
      return result;
    },

    async restoreSession() {
      const requestId = ++restoreRequestId;
      const requestGeneration = sessionGeneration;
      let session;
      try {
        session = await requestJson(fetchImpl, url("/api/auth/session"));
      } catch (error) {
        if (error?.status === 401 && requestId === restoreRequestId) {
          invalidateSession(error, requestGeneration);
        }
        throw error;
      }
      const result = displaySession(session);
      if (requestId !== restoreRequestId || requestGeneration !== sessionGeneration) {
        throw staleSessionError();
      }
      replaceSession(session);
      return result;
    },

    async logout() {
      try {
        await requestApi("/api/auth/logout", {
          method: "POST",
          body: "{}",
        });
      } finally {
        setSession(null);
      }
    },

    async loadBootstrap({ signal } = {}) {
      const requestOptions = { signal };
      const [customers, opportunities, actions, risks, knowledge, quickRecords, solutions, itineraries, summary] = await Promise.all([
        requestApi("/api/customers", requestOptions),
        requestApi("/api/opportunities", requestOptions),
        requestApi("/api/actions", requestOptions),
        requestApi("/api/risks", requestOptions),
        requestApi("/api/knowledge", requestOptions),
        requestApi("/api/quick-records", requestOptions),
        requestApi("/api/solutions", requestOptions),
        requestApi("/api/itineraries", requestOptions),
        requestApi("/api/dashboard/summary", requestOptions),
      ]);

      return {
        customers: bootstrapItems("customers", "customer", customers),
        opportunities: bootstrapItems("opportunities", "opportunity", opportunities),
        actions: bootstrapItems("actions", "actionItem", actions),
        risks: bootstrapItems("risks", "riskItem", risks),
        knowledge: bootstrapItems("knowledge", "knowledgeItem", knowledge),
        quickRecords: bootstrapItems("quickRecords", "quickRecordHistory", quickRecords),
        solutionDocs: bootstrapItems("solutions", "solutionDraft", solutions),
        itineraries: bootstrapItems("itineraries", "visitItinerary", itineraries),
        summary: assertApiEntity("dashboardSummary", summary.item),
      };
    },

    async refreshQuickRecordConfirmationState(quickRecordId) {
      const [quickRecords, customers, opportunities] = await Promise.all([
        requestApi("/api/quick-records"),
        requestApi("/api/customers"),
        requestApi("/api/opportunities"),
      ]);
      const currentQuickRecords = assertApiCollection("quickRecordHistory", quickRecords.items ?? []);
      const quickRecord = currentQuickRecords.find((item) => item.id === quickRecordId);
      if (!quickRecord) {
        const error = new Error("The quick record is no longer available");
        error.code = "QUICK_RECORD_NOT_FOUND";
        throw error;
      }
      return {
        quickRecord,
        customers: assertApiCollection("customer", customers.items ?? []),
        opportunities: assertApiCollection("opportunity", opportunities.items ?? []),
      };
    },

    async getDashboardSummary() {
      const summary = await requestApi("/api/dashboard/summary");
      return assertApiEntity("dashboardSummary", summary.item);
    },

    async listHospitalTenders(filters = {}, { signal } = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters ?? {})) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      }
      const response = await requestApi(`/api/hospital-tenders${query.size ? `?${query}` : ""}`, { signal });
      return assertApiCollection("hospitalTenderNotice", response.items ?? [], "hospitalTenders.items");
    },

    async listHospitalTenderPage(filters = {}, { signal } = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters ?? {})) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      }
      const response = await requestApi(`/api/hospital-tenders${query.size ? `?${query}` : ""}`, { signal });
      const items = assertApiCollection("hospitalTenderNotice", response.items ?? [], "hospitalTenders.items");
      const total = Number.isSafeInteger(response.total) && response.total >= 0
        ? response.total
        : items.length;
      const limit = Number.isSafeInteger(response.limit) && response.limit > 0
        ? response.limit
        : (Number.isSafeInteger(filters.limit) && filters.limit > 0 ? filters.limit : items.length || 1);
      const offset = Number.isSafeInteger(response.offset) && response.offset >= 0
        ? response.offset
        : (Number.isSafeInteger(filters.offset) && filters.offset >= 0 ? filters.offset : 0);
      return {
        items,
        total,
        limit,
        offset,
        hasMore: response.hasMore === undefined ? offset + items.length < total : Boolean(response.hasMore),
      };
    },

    async getHospitalTender(id, { signal } = {}) {
      const response = await requestApi(`/api/hospital-tenders/${encodeURIComponent(id)}`, { signal });
      return assertHospitalTenderNotice(response.item);
    },

    async getHospitalTenderSummary({ signal } = {}) {
      const response = await requestApi("/api/hospital-tenders/summary", { signal });
      return assertApiEntity("hospitalTenderSummary", response.item);
    },

    async listHospitalTenderSources({ signal } = {}) {
      const response = await requestApi("/api/hospital-tenders/sources", { signal });
      return assertApiCollection("hospitalTenderSource", response.items ?? [], "hospitalTenderSources.items");
    },

    async getHospitalTenderHealth({ signal } = {}) {
      const response = await requestApi("/api/hospital-tenders/health", { signal });
      return assertApiEntity("hospitalTenderHealth", response.item);
    },

    async previewHospitalTenderLeadConversion(noticeId, input, { signal } = {}) {
      const response = await requestApi(hospitalTenderLeadConversionUrl(noticeId, "preview"), {
        method: "POST",
        signal,
        body: JSON.stringify({
          customerId: requiredApiString(input?.customerId, "customerId"),
        }),
      });
      return assertHospitalTenderLeadConversionPreview(response?.item);
    },

    async confirmHospitalTenderLeadConversion(noticeId, input, { signal } = {}) {
      const response = await requestApi(hospitalTenderLeadConversionUrl(noticeId, "confirm"), {
        method: "POST",
        signal,
        body: JSON.stringify({
          customerId: requiredApiString(input?.customerId, "customerId"),
          previewDigest: requiredApiString(input?.previewDigest, "previewDigest"),
          confirmed: true,
        }),
      });
      return assertHospitalTenderLeadConversionConfirmation(response?.item);
    },

    async cancelHospitalTenderLeadConversion(noticeId, input, { signal } = {}) {
      const response = await requestApi(hospitalTenderLeadConversionUrl(noticeId, "cancel"), {
        method: "POST",
        signal,
        body: JSON.stringify({
          customerId: requiredApiString(input?.customerId, "customerId"),
          previewDigest: requiredApiString(input?.previewDigest, "previewDigest"),
          cancel: true,
        }),
      });
      return assertHospitalTenderLeadConversionCancellation(response?.item);
    },

    async runHospitalTenderMonitor() {
      const response = await requestApi("/api/hospital-tenders/run", {
        method: "POST",
        body: "{}",
      });
      return response.item;
    },

    async getHospitalTenderScheduler({ signal } = {}) {
      const response = await requestApi("/api/hospital-tenders/scheduler", { signal });
      return response;
    },

    async updateHospitalTenderScheduler(patch) {
      const response = await requestApi("/api/hospital-tenders/scheduler", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return response;
    },

    async runHospitalTenderScheduler() {
      const response = await requestApi("/api/hospital-tenders/scheduler/run-next", {
        method: "POST",
        body: "{}",
      });
      return response.item;
    },

    async listVisitItineraries({ status, signal } = {}) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const response = await requestApi(`/api/itineraries${query}`, { signal });
      return assertApiCollection("visitItinerary", response.items ?? [], "itineraries.items");
    },

    async getVisitItinerary(itineraryId, { signal } = {}) {
      const response = await requestApi(`/api/itineraries/${encodeURIComponent(itineraryId)}`, { signal });
      return assertApiEntity("visitItinerary", response.item);
    },

    async saveVisitItinerary(itinerary) {
      const payload = pickOwnFields(itinerary, WRITABLE_FIELDS.itinerary);
      const isUpdate = Boolean(itinerary.id);
      const response = await requestApi(
        isUpdate ? `/api/itineraries/${encodeURIComponent(itinerary.id)}` : "/api/itineraries",
        {
          method: isUpdate ? "PATCH" : "POST",
          ...(isUpdate ? { headers: versionHeaders(itinerary.version) } : {}),
          body: JSON.stringify(payload),
        },
      );
      return assertApiEntity("visitItinerary", response.item);
    },

    async deleteVisitItinerary(itineraryId, version) {
      const response = await requestApi(`/api/itineraries/${encodeURIComponent(itineraryId)}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("visitItinerary", response.deleted);
    },

    async listTravelExpenses({ weekStart, signal } = {}) {
      const query = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
      const response = await requestApi(`/api/travel-expenses${query}`, { signal });
      return assertTravelExpenseCollection(response?.items, "travelExpenses.items");
    },

    async getTravelExpenseWorkbench({ weekStart, signal } = {}) {
      const response = await requestApi(
        queryPath("/api/travel-expense-workbench", { weekStart }),
        { signal },
      );
      return assertTravelExpenseWorkbench(response?.item, "travelExpenseWorkbench.item");
    },

    async getTravelExpenseRegionProfile({ weekStart, signal } = {}) {
      const response = await requestApi(
        queryPath("/api/travel-expense-region-profile", { weekStart }),
        { signal },
      );
      return assertTravelExpenseRegionProfile(response?.item, "travelExpenseRegionProfile.item");
    },

    async saveTravelExpenseRegionProfile(profile) {
      const response = await requestApi("/api/travel-expense-region-profile", {
        method: "PUT",
        headers: nonNegativeVersionHeaders(profile?.version),
        body: JSON.stringify(pickOwnFields(profile, WRITABLE_FIELDS.travelExpenseRegionProfile)),
      });
      return assertTravelExpenseRegionProfile(response?.item, "travelExpenseRegionProfile.item");
    },

    async getTravelExpense(expenseId, { signal } = {}) {
      const response = await requestApi(`/api/travel-expenses/${encodeURIComponent(expenseId)}`, { signal });
      return assertTravelExpense(response?.item, "travelExpense.item");
    },

    async saveTravelExpense(expense) {
      const isUpdate = Boolean(expense.id);
      const response = await requestApi(
        isUpdate ? `/api/travel-expenses/${encodeURIComponent(expense.id)}` : "/api/travel-expenses",
        {
          method: isUpdate ? "PATCH" : "POST",
          ...(isUpdate ? { headers: versionHeaders(expense.version) } : {}),
          body: JSON.stringify(travelExpensePayload(expense)),
        },
      );
      return assertTravelExpense(response?.item, "travelExpense.item");
    },

    async deleteTravelExpense(expenseId, version) {
      const response = await requestApi(`/api/travel-expenses/${encodeURIComponent(expenseId)}`, {
        method: "DELETE",
        headers: versionHeaders(version),
        body: "{}",
      });
      return assertTravelExpense(response?.deleted, "travelExpense.deleted");
    },

    async addTravelExpenseAttachment(expenseId, attachment, version) {
      const response = await requestApi(
        `/api/travel-expenses/${encodeURIComponent(expenseId)}/attachments`,
        {
          method: "POST",
          headers: versionHeaders(version),
          body: JSON.stringify(pickOwnFields(attachment, WRITABLE_FIELDS.travelExpenseAttachment)),
        },
      );
      return assertTravelExpense(response?.item, "travelExpense.item");
    },

    getTravelExpenseAttachmentContentUrl(attachmentId) {
      return url(`/api/travel-expense-attachments/${encodeURIComponent(attachmentId)}/content`);
    },

    async getTravelExpenseAttachmentContentResponse(attachmentId, { signal } = {}) {
      return requestApiResponse(`/api/travel-expense-attachments/${encodeURIComponent(attachmentId)}/content`, {
        method: "GET",
        credentials: "include",
        redirect: "error",
        headers: { Accept: "application/pdf,image/*" },
        signal,
      });
    },

    async deleteTravelExpenseAttachment(attachmentId, version) {
      const response = await requestApi(
        `/api/travel-expense-attachments/${encodeURIComponent(attachmentId)}`,
        {
          method: "DELETE",
          headers: versionHeaders(version),
          body: "{}",
        },
      );
      return assertTravelExpense(response?.item, "travelExpense.item");
    },

    async listTravelExpenseDocumentInbox({ status, documentKind, signal } = {}) {
      const response = await requestApi(queryPath("/api/travel-expense-document-inbox", { status, documentKind }), { signal });
      const items = assertApiCollection(
        "travelExpenseDocumentInbox",
        response?.items,
        "travelExpenseDocumentInbox.items",
      );
      items.forEach((item, index) => assertTravelExpenseDocumentInbox(item, `travelExpenseDocumentInbox.items[${index}]`));
      return items;
    },

    async getTravelExpenseDocumentInbox(documentId, { signal } = {}) {
      const response = await requestApi(
        `/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}`,
        { signal },
      );
      return assertTravelExpenseDocumentInbox(response?.item, "travelExpenseDocumentInbox.item");
    },

    getTravelExpenseDocumentInboxContentUrl(documentId) {
      return url(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/content`);
    },

    async getTravelExpenseDocumentInboxContentResponse(documentId, { signal } = {}) {
      return requestApiResponse(`/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/content`, {
        method: "GET",
        credentials: "include",
        redirect: "error",
        headers: { Accept: "application/pdf,image/*" },
        signal,
      });
    },

    async confirmTravelExpenseDocumentInbox(documentId, selection, version) {
      const response = await requestApi(
        `/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/confirm`,
        {
          method: "POST",
          headers: versionHeaders(version),
          body: JSON.stringify(pickOwnFields(selection, WRITABLE_FIELDS.documentInboxConfirm)),
        },
      );
      return assertTravelExpenseDocumentInbox(response?.item, "travelExpenseDocumentInbox.item");
    },

    async rejectTravelExpenseDocumentInbox(documentId, version) {
      const response = await requestApi(
        `/api/travel-expense-document-inbox/${encodeURIComponent(documentId)}/reject`,
        {
          method: "POST",
          headers: versionHeaders(version),
          body: "{}",
        },
      );
      return assertTravelExpenseDocumentInbox(response?.item, "travelExpenseDocumentInbox.item");
    },

    async listWeixinBookkeepingReviews({ status = "review_required", signal } = {}) {
      const response = await requestApi(
        queryPath("/api/integrations/weixin/bookkeeping/review", { status }),
        { signal },
      );
      return apiItems(
        response?.items,
        "weixinBookkeepingReviews.items",
        assertWeixinBookkeepingReview,
      );
    },

    async getWeixinBookkeepingReview(reviewId, { signal } = {}) {
      const response = await requestApi(
        `/api/integrations/weixin/bookkeeping/review/${encodeURIComponent(reviewId)}`,
        { signal },
      );
      return assertWeixinBookkeepingReview(response?.item, "weixinBookkeepingReview.item");
    },

    async listBookkeepingAuditLogs({ limit = 100, signal } = {}) {
      const response = await requestApi(
        `/api/audit-logs?scope=bookkeeping&limit=${encodeURIComponent(limit)}`,
        { signal },
      );
      if (!Array.isArray(response?.items)) {
        throw new TypeError("auditLogs.items: expected array");
      }
      return response.items;
    },

    async recordBookkeepingClientEvent(event, detail = {}) {
      await requestApi("/api/bookkeeping/client-events", {
        method: "POST",
        body: JSON.stringify({ event, ...detail }),
      });
    },

    async listTravelExpenseAdvances({ weekStart, signal } = {}) {
      const query = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
      const response = await requestApi(`/api/travel-expense-advances${query}`, { signal });
      return assertApiCollection("travelExpenseAdvance", response?.items, "travelExpenseAdvances.items");
    },

    async saveTravelExpenseAdvance(advance) {
      const isUpdate = Boolean(advance.id);
      const response = await requestApi(
        isUpdate ? `/api/travel-expense-advances/${encodeURIComponent(advance.id)}` : "/api/travel-expense-advances",
        {
          method: isUpdate ? "PATCH" : "POST",
          ...(isUpdate ? { headers: versionHeaders(advance.version) } : {}),
          body: JSON.stringify(pickOwnFields(advance, WRITABLE_FIELDS.travelExpenseAdvance)),
        },
      );
      return assertApiEntity("travelExpenseAdvance", response?.item, "travelExpenseAdvance.item");
    },

    async deleteTravelExpenseAdvance(advanceId, version) {
      const response = await requestApi(`/api/travel-expense-advances/${encodeURIComponent(advanceId)}`, {
        method: "DELETE",
        headers: versionHeaders(version),
        body: "{}",
      });
      return assertApiEntity("travelExpenseAdvance", response?.deleted, "travelExpenseAdvance.deleted");
    },

    async listInvoices({ status, signal } = {}) {
      const response = await requestApi(queryPath("/api/invoices", { status }), { signal });
      return apiItems(response?.items, "invoices.items", assertInvoice);
    },

    async uploadInvoice(invoice, options = {}) {
      const response = await requestApi("/api/invoices", {
        method: "POST",
        headers: idempotencyHeaders(options, "invoice upload"),
        body: JSON.stringify(pickOwnFields(invoice, WRITABLE_FIELDS.invoiceUpload)),
      });
      return assertInvoice(response?.item, "invoice.item");
    },

    async getInvoice(invoiceId, { signal } = {}) {
      const response = await requestApi(`/api/invoices/${encodeURIComponent(invoiceId)}`, { signal });
      return assertInvoice(response?.item, "invoice.item");
    },

    getInvoiceContentUrl(invoiceId) {
      return url(`/api/invoices/${encodeURIComponent(invoiceId)}/content`);
    },

    async getInvoiceContentResponse(invoiceId, { signal, accept = "application/pdf" } = {}) {
      if (typeof accept !== "string" || !accept.trim()) throw new TypeError("invoice content Accept header must be a non-empty string");
      return requestApiResponse(`/api/invoices/${encodeURIComponent(invoiceId)}/content`, {
        method: "GET",
        credentials: "include",
        redirect: "error",
        headers: { Accept: accept },
        signal,
      });
    },

    async reviewInvoice(invoiceId, fields, version) {
      const response = await requestApi(`/api/invoices/${encodeURIComponent(invoiceId)}/review`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify(pickOwnFields(fields, WRITABLE_FIELDS.invoiceReview)),
      });
      return assertInvoice(response?.item, "invoice.item");
    },

    async deleteInvoice(invoiceId, version) {
      const response = await requestApi(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
        method: "DELETE",
        headers: versionHeaders(version),
        body: "{}",
      });
      return assertInvoice(response?.deleted ?? response?.item, "invoice.deleted");
    },

    async listInvoiceMatches({ invoiceId, expenseId, state, signal } = {}) {
      const response = await requestApi(queryPath("/api/invoice-matches", { invoiceId, expenseId, state }), { signal });
      return apiItems(response?.items, "invoiceMatches.items", assertInvoiceMatch);
    },

    async createInvoiceMatch(invoiceId, match, version, options = {}) {
      const response = await requestApi(`/api/invoices/${encodeURIComponent(invoiceId)}/matches`, {
        method: "POST",
        headers: {
          ...versionHeaders(version),
          ...idempotencyHeaders(options, "invoice match"),
        },
        body: JSON.stringify(pickOwnFields(match, WRITABLE_FIELDS.invoiceMatch)),
      });
      return assertInvoiceMatch(response?.item, "invoiceMatch.item");
    },

    async revokeInvoiceMatch(matchId, version) {
      const response = await requestApi(`/api/invoice-matches/${encodeURIComponent(matchId)}`, {
        method: "DELETE",
        headers: versionHeaders(version),
        body: "{}",
      });
      return assertInvoiceMatch(response?.item, "invoiceMatch.item");
    },

    async listNoInvoiceConfirmations({ weekStart, expenseId, signal } = {}) {
      const response = await requestApi(queryPath("/api/travel-expense-no-invoice-confirmations", { weekStart, expenseId }), { signal });
      return apiItems(response?.items, "noInvoiceConfirmations.items", assertNoInvoiceConfirmation);
    },

    async confirmNoInvoice(expenseId, confirmation, version, options = {}) {
      const response = await requestApi(`/api/travel-expenses/${encodeURIComponent(expenseId)}/no-invoice`, {
        method: "POST",
        headers: {
          ...versionHeaders(version),
          ...idempotencyHeaders(options, "no-invoice confirmation"),
        },
        body: JSON.stringify(pickOwnFields(confirmation, WRITABLE_FIELDS.noInvoiceConfirmation)),
      });
      return assertNoInvoiceConfirmation(response?.item, "noInvoiceConfirmation.item");
    },

    async revokeNoInvoice(expenseId, confirmationId, version) {
      const response = await requestApi(`/api/travel-expenses/${encodeURIComponent(expenseId)}/no-invoice`, {
        method: "DELETE",
        headers: versionHeaders(version),
        body: JSON.stringify({ confirmationId }),
      });
      return assertNoInvoiceConfirmation(response?.item, "noInvoiceConfirmation.item");
    },

    async getWeekInvoiceCoverage(weekStart, { signal } = {}) {
      const response = await requestApi(`/api/travel-expense-weeks/${encodeURIComponent(weekStart)}/invoice-coverage`, { signal });
      return assertInvoiceCoverage(response?.item, "invoiceCoverage.item");
    },

    async listInvoiceCandidates({ weekStart, status, signal } = {}) {
      const path = `/api/travel-expense-weeks/${encodeURIComponent(weekStart)}/invoice-suggestions`;
      const response = await requestApi(queryPath(path, { status }), { signal });
      return apiItems(response?.items, "invoiceCandidates.items", assertInvoiceCandidate);
    },

    async generateInvoiceCandidates(weekStart, options = {}) {
      const response = await requestApi(`/api/travel-expense-weeks/${encodeURIComponent(weekStart)}/invoice-suggestions`, {
        method: "POST",
        headers: idempotencyHeaders(options, "invoice candidate generation"),
        body: "{}",
      });
      return apiItems(response?.items, "invoiceCandidates.items", assertInvoiceCandidate);
    },

    async acceptInvoiceCandidate(candidateId, expectedVersion, options = {}) {
      const response = await requestApi(`/api/invoice-match-candidates/${encodeURIComponent(candidateId)}/accept`, {
        method: "POST",
        headers: {
          ...idempotencyHeaders(options, "invoice candidate acceptance"),
          ...versionHeaders(expectedVersion),
        },
        body: "{}",
      });
      return assertInvoiceCandidate(response?.item, "invoiceCandidate.item");
    },

    async rejectInvoiceCandidate(candidateId, expectedVersion, options = {}) {
      const response = await requestApi(`/api/invoice-match-candidates/${encodeURIComponent(candidateId)}/reject`, {
        method: "POST",
        headers: {
          ...idempotencyHeaders(options, "invoice candidate rejection"),
          ...versionHeaders(expectedVersion),
        },
        body: "{}",
      });
      return assertInvoiceCandidate(response?.item, "invoiceCandidate.item");
    },

    createQuickRecord,
    createVisitTemperatureSuggestion,
    listVisitTemperatureSuggestions,
    getVisitTemperatureSuggestion,
    confirmVisitTemperatureSuggestion,
    cancelVisitTemperatureSuggestion,

    async analyzeQuickRecord(rawContent, metadata = {}) {
      const quickRecord = await createQuickRecord(rawContent, metadata);
      const analyzed = await requestApi(`/api/quick-records/${quickRecord.id}/analyze`, { method: "POST" });

      return {
        quickRecord: assertApiEntity("quickRecord", analyzed.quickRecord),
        analysis: assertApiEntity("aiInsight", analyzed.item),
      };
    },

    async saveQuickRecordAnalysis(quickRecordId, summary, version) {
      const summaryText = Object.fromEntries(
        Object.entries(summary ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? value : String(value?.text ?? ""),
        ]),
      );
      const saved = await requestApi(`/api/quick-records/${quickRecordId}/analysis`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify({ summary: summaryText }),
      });
      return {
        quickRecord: assertApiEntity("quickRecord", saved.quickRecord),
        analysis: assertApiEntity("aiInsight", saved.analysis),
      };
    },

    async saveCustomer(customer) {
      const { id } = customer;
      const payload = pickOwnFields(customer, WRITABLE_FIELDS.customer);
      const isUpdate = Boolean(id);
      const saved = await requestApi(isUpdate ? `/api/customers/${id}` : "/api/customers", {
        method: isUpdate ? "PATCH" : "POST",
        ...(isUpdate ? { headers: versionHeaders(customer.version) } : {}),
        body: JSON.stringify(payload),
      });
      return assertApiEntity("customer", saved.item);
    },

    async deleteCustomer(customerId, version) {
      const deleted = await requestApi(`/api/customers/${customerId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("customer", deleted.deleted);
    },

    async saveOpportunity(opportunity) {
      const { id } = opportunity;
      const payload = pickOwnFields(opportunity, WRITABLE_FIELDS.opportunity);
      const isUpdate = Boolean(id);
      const saved = await requestApi(isUpdate ? `/api/opportunities/${id}` : "/api/opportunities", {
        method: isUpdate ? "PATCH" : "POST",
        ...(isUpdate ? { headers: versionHeaders(opportunity.version) } : {}),
        body: JSON.stringify(payload),
      });
      return assertApiEntity("opportunity", saved.item);
    },

    async deleteOpportunity(opportunityId, version) {
      const deleted = await requestApi(`/api/opportunities/${opportunityId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("opportunity", deleted.deleted);
    },

    async saveKnowledgeItem(item) {
      const { id } = item;
      const payload = pickOwnFields(item, WRITABLE_FIELDS.knowledge);
      const isUpdate = Boolean(id);
      const saved = await requestApi(isUpdate ? `/api/knowledge/${id}` : "/api/knowledge", {
        method: isUpdate ? "PATCH" : "POST",
        ...(isUpdate ? { headers: versionHeaders(item.version) } : {}),
        body: JSON.stringify(payload),
      });
      return assertApiEntity("knowledgeItem", saved.item);
    },

    async deleteKnowledgeItem(itemId, version) {
      const deleted = await requestApi(`/api/knowledge/${itemId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("knowledgeItem", deleted.deleted);
    },

    async searchKnowledge({ query = "", tags = [], limit } = {}) {
      const searched = await requestApi("/api/knowledge/search", {
        method: "POST",
        body: JSON.stringify({ query, tags, limit }),
      });
      return assertApiCollection("knowledgeItem", searched.items ?? []);
    },

    async updateRiskStatus(riskId, patch, version) {
      const updated = await requestApi(`/api/risks/${riskId}`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify(patch),
      });
      return assertApiEntity("riskItem", updated.item);
    },

    async deleteRisk(riskId, version) {
      const deleted = await requestApi(`/api/risks/${riskId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("riskItem", deleted.deleted);
    },

    async createAction(draft) {
      const created = await requestApi("/api/actions", {
        method: "POST",
        body: JSON.stringify(pickOwnFields(draft, WRITABLE_FIELDS.actionCreate)),
      });
      return assertApiEntity("actionItem", created.item);
    },

    async updateActionStatus(actionId, patch, version) {
      const updated = await requestApi(`/api/actions/${actionId}`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify(patch),
      });
      return assertApiEntity("actionItem", updated.item);
    },

    async deleteAction(actionId, version) {
      const deleted = await requestApi(`/api/actions/${actionId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("actionItem", deleted.deleted);
    },

    async createQuickRecordConfirmationPreview(quickRecordId) {
      const response = await requestApi(`/api/quick-records/${encodeURIComponent(requiredApiString(quickRecordId, "quickRecordId"))}/confirmation-previews`, {
        method: "POST",
        body: "{}",
      });
      return assertQuickRecordConfirmationPreview(response?.item, "quickRecordConfirmationPreview.item");
    },

    async getQuickRecordConfirmationPreview(previewId) {
      const response = await requestApi(confirmationPreviewUrl(previewId));
      return assertQuickRecordConfirmationPreview(response?.item, "quickRecordConfirmationPreview.item");
    },

    async confirmQuickRecordConfirmationItem(previewId, payload) {
      const response = await requestApi(confirmationPreviewUrl(previewId, "/confirm-item"), {
        method: "POST",
        body: JSON.stringify(pickOwnFields(payload ?? {}, [
          "confirm", "suggestionIdentity", "expectedQuickRecordVersion", "analysisVersionId",
          "summaryHash", "evidenceHash", "itemId", "itemIdentity",
        ])),
      });
      return assertQuickRecordConfirmationOutcome(response?.item, "quickRecordConfirmationOutcome.item");
    },

    async confirmAllQuickRecordConfirmationItems(previewId, payload) {
      const response = await requestApi(confirmationPreviewUrl(previewId, "/confirm-all"), {
        method: "POST",
        body: JSON.stringify(pickOwnFields(payload ?? {}, [
          "confirm", "suggestionIdentity", "expectedQuickRecordVersion", "analysisVersionId",
          "summaryHash", "evidenceHash",
        ])),
      });
      return assertQuickRecordConfirmationOutcome(response?.item, "quickRecordConfirmationOutcome.item");
    },

    async cancelQuickRecordConfirmationPreview(previewId, payload) {
      const response = await requestApi(confirmationPreviewUrl(previewId, "/cancel"), {
        method: "POST",
        body: JSON.stringify(pickOwnFields(payload ?? {}, ["cancel", "suggestionIdentity"])),
      });
      return assertQuickRecordConfirmationPreview(response?.item, "quickRecordConfirmationPreview.item");
    },

    async generateWeeklyDraft({ periodStart, periodEnd, knowledgeIds = [] }) {
      const body = { periodStart, periodEnd };
      if (knowledgeIds.length > 0) body.knowledgeIds = knowledgeIds;
      const draft = await requestApi("/api/reports/weekly/draft", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return assertApiEntity("weeklyReport", draft.item);
    },

    async saveWeeklyReport(reportId, patch, version) {
      const saved = await requestApi(`/api/reports/weekly/${reportId}`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify(patch),
      });
      return assertApiEntity("weeklyReport", saved.item);
    },

    async deleteWeeklyReport(reportId, version) {
      const deleted = await requestApi(`/api/reports/weekly/${reportId}`, {
        method: "DELETE",
        headers: versionHeaders(version),
      });
      return assertApiEntity("weeklyReport", deleted.deleted);
    },

    async downloadWeeklyReport(reportId, format = "word") {
      if (format !== "word") throw new Error("Weekly report export format must be word");
      const requestGeneration = sessionGeneration;
      const response = await fetchImpl(
        url(`/api/reports/weekly/${encodeURIComponent(reportId)}/export?format=word`),
        {
          method: "GET",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const error = toApiError(response, await readResponseBody(response));
        if (error.status === 401) invalidateSession(error, requestGeneration);
        throw error;
      }
      return {
        blob: await response.blob(),
        filename: contentDispositionFilename(response.headers) ?? "weekly-report.doc",
      };
    },

    async generateSolutionDraft({ customerId, opportunityId, artifactType = "solution_framework", knowledgeIds = [] }) {
      const body = { customerId, opportunityId, artifactType };
      if (knowledgeIds.length > 0) body.knowledgeIds = knowledgeIds;
      const draft = await requestApi("/api/solutions/draft", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return assertApiEntity("solutionDraft", draft.item);
    },

    async saveSolutionDraft(draftId, patch, version) {
      const saved = await requestApi(`/api/solutions/${draftId}`, {
        method: "PATCH",
        headers: versionHeaders(version),
        body: JSON.stringify(patch),
      });
      return assertApiEntity("solutionDraft", saved.item);
    },

    async generateAiSuggestion({ type, title, context }, { signal } = {}) {
      const suggestion = await requestApi("/api/ai/suggestions", {
        method: "POST",
        body: JSON.stringify({ type, title, context }),
        signal,
      });
      return assertApiEntity("aiSuggestion", suggestion.item);
    },

    async listAiSuggestions(filters = {}, { signal } = {}) {
      const params = new URLSearchParams();
      for (const field of ["type", "sourceId", "limit"]) {
        const value = filters[field];
        if (value !== undefined && value !== null && String(value).trim()) {
          params.set(field, String(value).trim());
        }
      }
      const query = params.toString();
      const response = await requestApi(`/api/ai/suggestions${query ? `?${query}` : ""}`, { signal });
      return { items: assertApiCollection("aiSuggestion", response.items) };
    },

    async confirmAiSuggestion(id, { draft, version }, { signal } = {}) {
      const response = await requestApi(`/api/ai/suggestions/${encodeURIComponent(id)}/confirm`, {
        method: "POST",
        headers: versionHeaders(version),
        body: JSON.stringify({ confirm: true, draft }),
        signal,
      });
      return assertApiEntity("aiSuggestion", response.item);
    },

    async cancelAiSuggestion(id, { version }, { signal } = {}) {
      const response = await requestApi(`/api/ai/suggestions/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: versionHeaders(version),
        body: JSON.stringify({ cancel: true }),
        signal,
      });
      return assertApiEntity("aiSuggestion", response.item);
    },

    async listSalesDecisionAnalyses(filters = {}) {
      const params = new URLSearchParams();
      for (const field of ["customerId", "opportunityId", "quickRecordId"]) {
        const value = filters[field];
        if (value !== undefined && value !== null && String(value).trim()) {
          params.set(field, String(value).trim());
        }
      }
      const query = params.toString();
      const response = await requestApi(`/api/ai/sales-decisions${query ? `?${query}` : ""}`);
      return {
        items: assertApiCollection("salesDecisionAnalysis", response.items),
      };
    },

    async createSalesDecisionAnalysis(input = {}) {
      const payload = pickOwnFields(input, [
        "analysisType",
        "industry",
        "customerId",
        "opportunityId",
        "quickRecordId",
        "rawContent",
      ]);
      const response = await requestApi("/api/ai/sales-decisions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return assertApiEntity("salesDecisionAnalysis", response.item);
    },

    async getSalesDecisionAnalysis(id) {
      const response = await requestApi(`/api/ai/sales-decisions/${encodeURIComponent(id)}`);
      return assertApiEntity("salesDecisionAnalysis", response.item);
    },

    async startWeixinBinding() {
      const binding = await requestApi("/api/integrations/weixin-agent/login", { method: "POST" });
      return binding.item;
    },

    async getWeixinBindingStatus() {
      const binding = await requestApi("/api/integrations/weixin-agent/login");
      return binding.item;
    },

    async stopWeixinBinding() {
      const binding = await requestApi("/api/integrations/weixin-agent/login", { method: "DELETE" });
      return binding.item;
    },

    async listUsers() {
      const response = await requestApi("/api/admin/users");
      if (!Array.isArray(response?.items)) throw new TypeError("adminUsers.items: expected array");
      return response.items;
    },

    async createUser(payload) {
      const response = await requestApi("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return response.item;
    },

    async updateUser(account, payload) {
      const response = await requestApi(`/api/admin/users/${encodeURIComponent(account)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return response.item;
    },

    async listWeixinBindings() {
      const response = await requestApi("/api/admin/weixin-bindings");
      if (!Array.isArray(response?.items)) throw new TypeError("weixinBindings.items: expected array");
      return response.items;
    },

    async createWeixinBindingCode(account) {
      const response = await requestApi("/api/admin/weixin-bindings/codes", {
        method: "POST",
        body: JSON.stringify({ account }),
      });
      return response.item;
    },

    async updateWeixinBinding(senderId, payload) {
      const response = await requestApi(`/api/admin/weixin-bindings/${encodeURIComponent(senderId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return response.item;
    },

    async unbindWeixinBinding(senderId, expectedVersion) {
      const response = await requestApi(`/api/admin/weixin-bindings/${encodeURIComponent(senderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion, status: "disabled" }),
      });
      return response.item;
    },

    async changePassword(payload) {
      return requestApi("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async getSecuritySettings() {
      const response = await requestApi("/api/settings/security");
      return response.item;
    },

    async saveDeepSeekApiKey(apiKey) {
      if (typeof apiKey !== "string" || !apiKey.trim()) throw new TypeError("DeepSeek API Key is required");
      const response = await requestApi("/api/settings/deepseek-key", {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      return response.item;
    },

    async clearDeepSeekApiKey() {
      const response = await requestApi("/api/settings/deepseek-key", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "CLEAR" }),
      });
      return response.item;
    },

    async savePushplusToken(token) {
      if (typeof token !== "string" || !token.trim()) throw new TypeError("PushPlus Token is required");
      const response = await requestApi("/api/settings/pushplus-token", {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() }),
      });
      return response.item;
    },

    async clearPushplusToken() {
      const response = await requestApi("/api/settings/pushplus-token", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "CLEAR" }),
      });
      return response.item;
    },

    async testPushplusToken() {
      const response = await requestApi("/api/settings/pushplus/test", {
        method: "POST",
        body: "{}",
      });
      return response.item;
    },

    async postAssistantChat(payload) {
      return requestApi("/api/assistant/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async postAssistantConfirm(payload) {
      return requestApi("/api/assistant/confirm", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async getAssistantHistory(conversationId) {
      const query = encodeURIComponent(conversationId);
      return requestApi(`/api/assistant/history?conversationId=${query}`);
    },
  };
}
