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
});

function pickOwnFields(source, fields) {
  const picked = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) picked[field] = source[field];
  }
  return picked;
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
      const [customers, opportunities, actions, risks, knowledge, quickRecords, solutions, summary] = await Promise.all([
        requestApi("/api/customers", requestOptions),
        requestApi("/api/opportunities", requestOptions),
        requestApi("/api/actions", requestOptions),
        requestApi("/api/risks", requestOptions),
        requestApi("/api/knowledge", requestOptions),
        requestApi("/api/quick-records", requestOptions),
        requestApi("/api/solutions", requestOptions),
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
  };
}
