import {
  assertApiCollection,
  assertApiEntity,
} from "../../../../shared/salesWorkbenchApiContract.mjs";

export function resolveApiBaseUrl(env = {}, runtime = globalThis) {
  return String(env.VITE_API_BASE_URL ?? runtime?.__SENTELLIGENT_API_BASE_URL__ ?? "").trim().replace(/\/+$/, "");
}

const WRITABLE_FIELDS = Object.freeze({
  customer: Object.freeze([
    "name", "region", "type", "level", "owner", "contact", "relation", "stakeholders",
    "decisionChain", "historyProjects", "infrastructure", "syncPreview", "budget", "summary",
    "needs", "risks", "opportunities",
  ]),
  opportunity: Object.freeze([
    "customerId", "name", "customer", "stage", "amount", "owner", "probability", "days",
    "requirements", "competitors", "solutionDirection", "sourceRecord", "risk", "next", "tone",
  ]),
  knowledge: Object.freeze(["title", "category", "tags", "summary", "content", "source"]),
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

function apiItems(values, path, assertItem) {
  if (!Array.isArray(values)) throw new TypeError(`${path}: expected array`);
  return values.map((value, index) => assertItem(value, `${path}[${index}]`));
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
  for (const field of ["reimbursementCents", "confirmedCoverageCents", "noInvoiceConfirmedCents", "missingInvoiceCents"]) {
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
  return error;
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

  return {
    isEnabled: Boolean(root),
    setSession,

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

    async runHospitalTenderMonitor() {
      const response = await requestApi("/api/hospital-tenders/run", {
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
        headers: { Accept: "application/pdf" },
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

    async getInvoiceContentResponse(invoiceId, { signal } = {}) {
      return requestApiResponse(`/api/invoices/${encodeURIComponent(invoiceId)}/content`, {
        method: "GET",
        credentials: "include",
        redirect: "error",
        headers: { Accept: "application/pdf" },
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

    async confirmQuickRecord(quickRecordId, targets, options = {}) {
      const idempotencyKey = String(options.idempotencyKey ?? "");
      if (!idempotencyKey || idempotencyKey.trim() !== idempotencyKey) {
        throw new TypeError("A valid confirmation Idempotency-Key is required");
      }
      const payload = {
        targets,
        confirmedBy: options.confirmedBy ?? "继振",
        note: options.note ?? "",
        targetVersions: options.targetVersions ?? {},
      };
      if (options.analysisVersionId) payload.analysisVersionId = options.analysisVersionId;
      const confirmed = await requestApi(`/api/quick-records/${quickRecordId}/confirm`, {
        method: "POST",
        headers: {
          ...versionHeaders(options.quickRecordVersion),
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      return {
        ...confirmed,
        confirmations: assertApiCollection("manualConfirmation", confirmed.confirmations ?? []),
        quickRecord: assertApiEntity("quickRecord", confirmed.quickRecord),
        analysis: confirmed.analysis ? assertApiEntity("aiInsight", confirmed.analysis) : null,
        customer: confirmed.customer ? assertApiEntity("customer", confirmed.customer) : null,
        opportunity: confirmed.opportunity ? assertApiEntity("opportunity", confirmed.opportunity) : null,
        action: confirmed.action ? assertApiEntity("actionItem", confirmed.action) : null,
        risk: confirmed.risk ? assertApiEntity("riskItem", confirmed.risk) : null,
      };
    },

    async generateWeeklyDraft({ owner, periodStart, periodEnd, knowledgeIds = [] }) {
      const body = { owner, periodStart, periodEnd };
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

    async generateSolutionDraft({ owner, customerId, opportunityId, artifactType = "solution_framework", knowledgeIds = [] }) {
      const body = { owner, customerId, opportunityId, artifactType };
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

    async generateAiSuggestion({ type, title, context }) {
      const suggestion = await requestApi("/api/ai/suggestions", {
        method: "POST",
        body: JSON.stringify({ type, title, context }),
      });
      return assertApiEntity("aiSuggestion", suggestion.item);
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

    async getSecuritySettings() {
      const response = await requestApi("/api/settings/security");
      return response.item;
    },

    async rotateIcostToken() {
      const response = await requestApi("/api/settings/icost-token/rotate", {
        method: "POST",
        body: "{}",
      });
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
  };
}
