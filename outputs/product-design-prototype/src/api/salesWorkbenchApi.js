import {
  assertApiCollection,
  assertApiEntity,
} from "../../../../shared/salesWorkbenchApiContract.mjs";

export function resolveApiBaseUrl(env = {}, runtime = globalThis) {
  return String(env.VITE_API_BASE_URL ?? runtime?.__SENTELLIGENT_API_BASE_URL__ ?? "").trim().replace(/\/+$/, "");
}

async function requestJson(fetchImpl, url, options = {}, authHeaders = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(body?.message ?? body?.error ?? `Request failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export function createSalesWorkbenchApi({ baseUrl, fetchImpl = fetch, authToken = "" } = {}) {
  const root = resolveApiBaseUrl({ VITE_API_BASE_URL: baseUrl });

  function url(path) {
    if (!root) throw new Error("API base URL is not configured");
    return `${root}${path}`;
  }

  function authHeaders() {
    const token = String(authToken ?? "");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function requestApi(path, options = {}) {
    return requestJson(fetchImpl, url(path), options, authHeaders());
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

    async login({ account, password }) {
      const session = await requestJson(fetchImpl, url("/api/auth/login"), {
        method: "POST",
        body: JSON.stringify({ account, password }),
      });
      if (!session?.account || !session?.token || !Number.isFinite(session?.expiresAt)) {
        throw new Error("登录响应缺少必要会话信息");
      }
      return {
        account: session.account,
        displayName: session.displayName ?? session.account,
        token: session.token,
        expiresAt: session.expiresAt,
      };
    },

    async loadBootstrap() {
      const [customers, opportunities, actions, risks, knowledge, summary] = await Promise.all([
        requestApi("/api/customers"),
        requestApi("/api/opportunities"),
        requestApi("/api/actions"),
        requestApi("/api/risks"),
        requestApi("/api/knowledge"),
        requestApi("/api/dashboard/summary"),
      ]);

      return {
        customers: assertApiCollection("customer", customers.items ?? []),
        opportunities: assertApiCollection("opportunity", opportunities.items ?? []),
        actions: assertApiCollection("actionItem", actions.items ?? []),
        risks: assertApiCollection("riskItem", risks.items ?? []),
        knowledge: assertApiCollection("knowledgeItem", knowledge.items ?? []),
        summary: assertApiEntity("dashboardSummary", summary.item),
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
        quickRecord,
        analysis: assertApiEntity("aiInsight", analyzed.item),
      };
    },

    async saveCustomer(customer) {
      const isUpdate = Boolean(customer.id);
      const saved = await requestApi(isUpdate ? `/api/customers/${customer.id}` : "/api/customers", {
        method: isUpdate ? "PATCH" : "POST",
        body: JSON.stringify(customer),
      });
      return assertApiEntity("customer", saved.item);
    },

    async deleteCustomer(customerId) {
      const deleted = await requestApi(`/api/customers/${customerId}`, { method: "DELETE" });
      return assertApiEntity("customer", deleted.deleted);
    },

    async saveOpportunity(opportunity) {
      const isUpdate = Boolean(opportunity.id);
      const saved = await requestApi(isUpdate ? `/api/opportunities/${opportunity.id}` : "/api/opportunities", {
        method: isUpdate ? "PATCH" : "POST",
        body: JSON.stringify(opportunity),
      });
      return assertApiEntity("opportunity", saved.item);
    },

    async deleteOpportunity(opportunityId) {
      const deleted = await requestApi(`/api/opportunities/${opportunityId}`, { method: "DELETE" });
      return assertApiEntity("opportunity", deleted.deleted);
    },

    async saveKnowledgeItem(item) {
      const isUpdate = Boolean(item.id);
      const saved = await requestApi(isUpdate ? `/api/knowledge/${item.id}` : "/api/knowledge", {
        method: isUpdate ? "PATCH" : "POST",
        body: JSON.stringify(item),
      });
      return assertApiEntity("knowledgeItem", saved.item);
    },

    async deleteKnowledgeItem(itemId) {
      const deleted = await requestApi(`/api/knowledge/${itemId}`, { method: "DELETE" });
      return assertApiEntity("knowledgeItem", deleted.deleted);
    },

    async searchKnowledge({ query = "", tags = [], limit } = {}) {
      const searched = await requestApi("/api/knowledge/search", {
        method: "POST",
        body: JSON.stringify({ query, tags, limit }),
      });
      return assertApiCollection("knowledgeItem", searched.items ?? []);
    },

    async updateRiskStatus(riskId, patch) {
      const updated = await requestApi(`/api/risks/${riskId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return assertApiEntity("riskItem", updated.item);
    },

    async deleteRisk(riskId) {
      const deleted = await requestApi(`/api/risks/${riskId}`, { method: "DELETE" });
      return assertApiEntity("riskItem", deleted.deleted);
    },

    async updateActionStatus(actionId, patch) {
      const updated = await requestApi(`/api/actions/${actionId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return assertApiEntity("actionItem", updated.item);
    },

    async deleteAction(actionId) {
      const deleted = await requestApi(`/api/actions/${actionId}`, { method: "DELETE" });
      return assertApiEntity("actionItem", deleted.deleted);
    },

    async confirmQuickRecord(quickRecordId, targets, options = {}) {
      const confirmed = await requestApi(`/api/quick-records/${quickRecordId}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          targets,
          confirmedBy: options.confirmedBy ?? "继振",
          note: options.note ?? "",
        }),
      });

      return {
        ...confirmed,
        confirmations: assertApiCollection("manualConfirmation", confirmed.confirmations ?? []),
        quickRecord: assertApiEntity("quickRecord", confirmed.quickRecord),
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

    async saveWeeklyReport(reportId, patch) {
      const saved = await requestApi(`/api/reports/weekly/${reportId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return assertApiEntity("weeklyReport", saved.item);
    },

    getWeeklyReportExportUrl(reportId, format = "word") {
      const params = new URLSearchParams({ format });
      if (authToken) params.set("token", authToken);
      return url(`/api/reports/weekly/${encodeURIComponent(reportId)}/export?${params.toString()}`);
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

    async saveSolutionDraft(draftId, patch) {
      const saved = await requestApi(`/api/solutions/${draftId}`, {
        method: "PATCH",
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
