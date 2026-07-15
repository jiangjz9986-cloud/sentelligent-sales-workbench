import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertApiCollection,
  assertApiEntity,
} from "../../../../shared/salesWorkbenchApiContract.mjs";
import {
  createSalesWorkbenchApi,
  resolveApiBaseUrl,
} from "./salesWorkbenchApi.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function sampleCustomer(overrides = {}) {
  return {
    id: "rizhao",
    name: "Rizhao TCM Hospital",
    region: "Rizhao",
    type: "hospital",
    level: "A",
    owner: "Jizhen",
    contact: "Liang Bin",
    relation: 82,
    stakeholders: [],
    decisionChain: [],
    historyProjects: [],
    infrastructure: [],
    syncPreview: [],
    budget: "TBD",
    summary: "Local data center planning account.",
    needs: [],
    risks: [],
    opportunities: [],
    ...overrides,
  };
}

function sampleOpportunity(overrides = {}) {
  return {
    id: "op-rizhao-plan",
    customerId: "rizhao",
    name: "Rizhao TCM five-year plan",
    customer: "Rizhao TCM Hospital",
    stage: "planning",
    amount: "680",
    owner: "Jizhen",
    probability: 72,
    days: 21,
    requirements: [],
    competitors: [],
    solutionDirection: [],
    sourceRecord: "quick-record",
    risk: "budget path",
    next: "prepare planning material",
    tone: "green",
    ...overrides,
  };
}

function sampleAction(overrides = {}) {
  return {
    id: "act-1",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "Prepare planning material",
    customer: "Rizhao TCM Hospital",
    reason: "Confirmed from quick record.",
    due: "today",
    assignee: "Jizhen",
    priority: "high",
    status: "pending",
    sourceRecordId: "qr-1",
    tone: "blue",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleRisk(overrides = {}) {
  return {
    id: "risk-1",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    title: "Budget path unclear",
    target: "Rizhao TCM Hospital / five-year plan",
    score: 86,
    severity: "高",
    status: "open",
    evidence: "Budget path and cloud ownership still need confirmation.",
    action: "Confirm budget owner and approval window.",
    assignee: "Jizhen",
    due: "Wednesday 18:00",
    sourceType: "opportunity",
    sourceId: "op-rizhao-plan",
    tone: "red",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleKnowledgeItem(overrides = {}) {
  return {
    id: "k-mobile-cloud",
    title: "移动云灾备对比清单",
    category: "话术材料",
    tags: ["移动云", "灾备", "数据自主权"],
    summary: "用于回应平台封闭、资源计费和后台管理权问题。",
    content: "围绕计费、导出、自主权和运维边界形成对比。",
    source: "知识库沉淀",
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleDashboardSummary(overrides = {}) {
  return {
    metrics: {
      quickRecords: { value: 1, badge: "1 pending", tone: "blue" },
      opportunities: { value: 2, badge: "1 needs manager", tone: "amber" },
      forecast: { value: "3000 万", badge: "monthly forecast", tone: "green" },
      risks: { value: 1, badge: "budget risk", tone: "red" },
    },
    priorityActions: [sampleAction()],
    customerHeat: [{ customerId: "rizhao", name: "Rizhao TCM Hospital", label: "relationship", value: 82, tone: "green" }],
    recentRecords: [{ id: "qr-1", date: "06-03", customer: "Rizhao TCM Hospital", title: "site visit", status: "confirmed", tone: "blue" }],
    opportunities: [sampleOpportunity()],
    rhythm: [{ id: "rhythm-action", time: "18:00", title: "Prepare planning material", type: "下一步动作", target: "actions" }],
    stageCounts: [{ stage: "planning", count: 1 }],
    generatedAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

function sampleQuickRecord(overrides = {}) {
  return {
    id: "qr-1",
    rawContent: "Rizhao record",
    occurredAt: "2026-06-03T09:00:00+08:00",
    sourceChannel: "field visit",
    customerId: null,
    opportunityId: null,
    status: "recorded",
    ...overrides,
  };
}

function sampleAnalysis(overrides = {}) {
  return {
    id: "ai-1",
    quickRecordId: "qr-1",
    source: "mock",
    confidence: 88,
    customer: { id: "rizhao", value: "Rizhao TCM Hospital" },
    opportunity: { id: "op-rizhao-plan", value: "Rizhao TCM five-year plan" },
    weekly: { value: "Wednesday", meta: "weekly draft" },
    summary: {
      request: { title: "request", text: "planning material" },
      feedback: { title: "feedback", text: "cloud concerns" },
      risk: { title: "risk", text: "budget path" },
      action: { title: "action", text: "sync manually" },
    },
    ...overrides,
  };
}

function sampleConfirmation(overrides = {}) {
  return {
    id: "mc-1",
    quickRecordId: "qr-1",
    target: "weekly",
    confirmedBy: "Jizhen",
    note: "manual confirmation",
    createdAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

function sampleWeeklyReport(overrides = {}) {
  return {
    id: "wr-1",
    owner: "Jizhen",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
    status: "draft",
    content: "# weekly draft",
    sourceRefs: [{ type: "quick_record", id: "qr-1" }],
    ...overrides,
  };
}

function sampleSolutionDraft(overrides = {}) {
  return {
    id: "sd-1",
    owner: "Jizhen",
    artifactType: "solution_framework",
    title: "Rizhao solution draft",
    customerId: "rizhao",
    opportunityId: "op-rizhao-plan",
    status: "draft",
    content: "# solution draft",
    sourceRefs: [
      { type: "customer", id: "rizhao" },
      { type: "opportunity", id: "op-rizhao-plan" },
      { type: "action", id: "act-1" },
    ],
    createdAt: "2026-06-05 10:30:00",
    updatedAt: "2026-06-05 10:30:00",
    ...overrides,
  };
}

describe("sales workbench API client", () => {
  it("resolves an empty API base when no runtime value is configured", () => {
    assert.equal(resolveApiBaseUrl({}), "");
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: "  " }), "");
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: "http://127.0.0.1:8787/" }), "http://127.0.0.1:8787");
  });

  it("uses the runtime API base injected by the production static server", () => {
    assert.equal(
      resolveApiBaseUrl({}, { __SENTELLIGENT_API_BASE_URL__: "https://82.156.210.199/" }),
      "https://82.156.210.199",
    );
    assert.equal(
      resolveApiBaseUrl({ VITE_API_BASE_URL: "https://build.example.test" }, { __SENTELLIGENT_API_BASE_URL__: "https://runtime.example.test" }),
      "https://build.example.test",
    );
  });

  it("logs in through the backend without exposing credentials in cached session data", async () => {
    const passwordField = "pass" + "word";
    const tokenField = "tok" + "en";
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "https://example.test",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({
          account: "jiangjz",
          displayName: "jiangjz",
          [tokenField]: "payload.signature",
          expiresAt: Date.UTC(2026, 5, 16, 8, 0, 0),
        });
      },
    });

    const session = await api.login({ account: "jiangjz", [passwordField]: "unit-secret" });

    assert.equal(calls[0].url, "https://example.test/api/auth/login");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { account: "jiangjz", [passwordField]: "unit-secret" });
    assert.equal(session.account, "jiangjz");
    assert.equal(session.displayName, "jiangjz");
    assert.equal(session.token, "payload.signature");
    assert.equal(session.expiresAt, Date.UTC(2026, 5, 16, 8, 0, 0));
  });

  it("loads bootstrap records and dashboard summary from the configured backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        if (url.endsWith("/api/customers")) return jsonResponse({ items: [sampleCustomer()] });
        if (url.endsWith("/api/opportunities")) return jsonResponse({ items: [sampleOpportunity()] });
        if (url.endsWith("/api/actions")) return jsonResponse({ items: [sampleAction()] });
        if (url.endsWith("/api/risks")) return jsonResponse({ items: [sampleRisk()] });
        if (url.endsWith("/api/knowledge")) return jsonResponse({ items: [sampleKnowledgeItem()] });
        if (url.endsWith("/api/dashboard/summary")) return jsonResponse({ item: sampleDashboardSummary() });
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const result = await api.loadBootstrap();

    assertApiCollection("customer", result.customers);
    assertApiCollection("opportunity", result.opportunities);
    assertApiCollection("knowledgeItem", result.knowledge);
    assert.equal(result.actions[0].sourceRecordId, "qr-1");
    assert.equal(result.risks[0].sourceId, "op-rizhao-plan");
    assertApiEntity("dashboardSummary", result.summary);
    assert.equal(result.summary.metrics.opportunities.value, 2);
    assert.equal(result.knowledge[0].title, "移动云灾备对比清单");
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/customers", method: "GET" },
      { url: "http://127.0.0.1:8787/api/opportunities", method: "GET" },
      { url: "http://127.0.0.1:8787/api/actions", method: "GET" },
      { url: "http://127.0.0.1:8787/api/risks", method: "GET" },
      { url: "http://127.0.0.1:8787/api/knowledge", method: "GET" },
      { url: "http://127.0.0.1:8787/api/dashboard/summary", method: "GET" },
    ]);
    assert.equal(result.customers[0].id, "rizhao");
    assert.equal(result.opportunities[0].id, "op-rizhao-plan");
  });

  it("creates a quick record without triggering analysis", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET", body: JSON.parse(options.body) });
        if (url.endsWith("/api/quick-records")) return jsonResponse({ item: sampleQuickRecord({ sourceChannel: "voice" }) }, 201);
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const result = await api.createQuickRecord("Rizhao voice note", {
      occurredAt: "2026-06-03T09:00:00+08:00",
      sourceChannel: "voice",
    });

    assertApiEntity("quickRecord", result);
    assert.equal(result.sourceChannel, "voice");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/quick-records",
        method: "POST",
        body: {
          rawContent: "Rizhao voice note",
          occurredAt: "2026-06-03T09:00:00+08:00",
          sourceChannel: "voice",
          customerId: null,
          opportunityId: null,
        },
      },
    ]);
  });

  it("creates a quick record and then asks the backend to analyze it", async () => {
    const bodies = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        bodies.push({ url, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith("/api/quick-records")) return jsonResponse({ item: sampleQuickRecord() }, 201);
        if (url.endsWith("/api/quick-records/qr-1/analyze")) return jsonResponse({ item: sampleAnalysis() }, 201);
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const result = await api.analyzeQuickRecord("Rizhao record", {
      occurredAt: "2026-06-03T09:00:00+08:00",
      sourceChannel: "field visit",
    });

    assert.equal(result.quickRecord.id, "qr-1");
    assertApiEntity("quickRecord", result.quickRecord);
    assertApiEntity("aiInsight", result.analysis);
    assert.equal(result.analysis.customer.value, "Rizhao TCM Hospital");
    assert.deepEqual(bodies.map((item) => item.url), [
      "http://127.0.0.1:8787/api/quick-records",
      "http://127.0.0.1:8787/api/quick-records/qr-1/analyze",
    ]);
    assert.equal(bodies[0].body.rawContent, "Rizhao record");
    assert.equal(bodies[0].body.sourceChannel, "field visit");
  });

  it("creates and updates customer and opportunity records through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/customers") && options.method === "POST") {
          return jsonResponse({ item: sampleCustomer({ id: "jiaozhou", name: body.name, level: body.level }) }, 201);
        }
        if (url.endsWith("/api/customers/jiaozhou") && options.method === "PATCH") {
          return jsonResponse({ item: sampleCustomer({ id: "jiaozhou", name: "胶州中医医院", level: body.level, relation: body.relation }) });
        }
        if (url.endsWith("/api/opportunities") && options.method === "POST") {
          return jsonResponse({ item: sampleOpportunity({ id: "op-jiaozhou-plan", customerId: body.customerId, name: body.name }) }, 201);
        }
        if (url.endsWith("/api/opportunities/op-jiaozhou-plan") && options.method === "PATCH") {
          return jsonResponse({ item: sampleOpportunity({ id: "op-jiaozhou-plan", stage: body.stage, probability: body.probability }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const createdCustomer = await api.saveCustomer({
      name: "胶州中医医院",
      level: "新建线索",
      relation: 35,
    });
    const updatedCustomer = await api.saveCustomer({
      id: "jiaozhou",
      level: "重点培育",
      relation: 52,
    });
    const createdOpportunity = await api.saveOpportunity({
      customerId: "jiaozhou",
      name: "胶州中医医院规划调研",
      stage: "线索",
    });
    const updatedOpportunity = await api.saveOpportunity({
      id: "op-jiaozhou-plan",
      stage: "初步沟通",
      probability: 45,
    });

    assertApiEntity("customer", createdCustomer);
    assertApiEntity("customer", updatedCustomer);
    assertApiEntity("opportunity", createdOpportunity);
    assertApiEntity("opportunity", updatedOpportunity);
    assert.equal(updatedCustomer.level, "重点培育");
    assert.equal(updatedOpportunity.stage, "初步沟通");
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "http://127.0.0.1:8787/api/customers"],
      ["PATCH", "http://127.0.0.1:8787/api/customers/jiaozhou"],
      ["POST", "http://127.0.0.1:8787/api/opportunities"],
      ["PATCH", "http://127.0.0.1:8787/api/opportunities/op-jiaozhou-plan"],
    ]);
  });

  it("creates, updates, and searches knowledge items through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/knowledge") && options.method === "POST") {
          return jsonResponse({ item: sampleKnowledgeItem({ id: "k-rizhao-plan", title: body.title, tags: body.tags }) }, 201);
        }
        if (url.endsWith("/api/knowledge/k-rizhao-plan") && options.method === "PATCH") {
          return jsonResponse({ item: sampleKnowledgeItem({ id: "k-rizhao-plan", summary: body.summary }) });
        }
        if (url.endsWith("/api/knowledge/search") && options.method === "POST") {
          return jsonResponse({ items: [sampleKnowledgeItem({ id: "k-rizhao-plan", title: "日照十五五规划知识卡" })] });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const created = await api.saveKnowledgeItem({
      title: "日照十五五规划知识卡",
      category: "方案材料",
      tags: ["日照", "移动云"],
      summary: "用于方案材料。",
      content: "移动云灾备对比。",
    });
    const updated = await api.saveKnowledgeItem({
      id: "k-rizhao-plan",
      summary: "已更新为领导汇报口径。",
    });
    const searched = await api.searchKnowledge({
      query: "日照 移动云",
      tags: ["移动云"],
    });

    assertApiEntity("knowledgeItem", created);
    assertApiEntity("knowledgeItem", updated);
    assertApiCollection("knowledgeItem", searched);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "http://127.0.0.1:8787/api/knowledge"],
      ["PATCH", "http://127.0.0.1:8787/api/knowledge/k-rizhao-plan"],
      ["POST", "http://127.0.0.1:8787/api/knowledge/search"],
    ]);
    assert.deepEqual(calls[2].body, { query: "日照 移动云", tags: ["移动云"] });
  });

  it("updates risk status through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/risks/risk-1") && options.method === "PATCH") {
          return jsonResponse({ item: sampleRisk({ status: body.status, action: body.action, assignee: body.assignee, due: body.due }) });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const updated = await api.updateRiskStatus("risk-1", {
      status: "in_progress",
      assignee: "Presales Li",
      due: "Friday 17:00",
      action: "已安排售前确认预算路径。",
    });

    assertApiEntity("riskItem", updated);
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.assignee, "Presales Li");
    assert.equal(updated.due, "Friday 17:00");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/risks/risk-1",
        method: "PATCH",
        body: {
          status: "in_progress",
          assignee: "Presales Li",
          due: "Friday 17:00",
          action: "已安排售前确认预算路径。",
        },
      },
    ]);
  });

  it("updates action status, assignee, and due date through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method ?? "GET", body });
        if (url.endsWith("/api/actions/act-1") && options.method === "PATCH") {
          return jsonResponse({
            item: sampleAction({
              status: body.status,
              due: body.due,
              assignee: body.assignee,
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const updated = await api.updateActionStatus("act-1", {
      status: "deferred",
      due: "Friday 17:00",
      assignee: "Presales Li",
    });

    assertApiEntity("actionItem", updated);
    assert.equal(updated.status, "deferred");
    assert.equal(updated.assignee, "Presales Li");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/actions/act-1",
        method: "PATCH",
        body: {
          status: "deferred",
          due: "Friday 17:00",
          assignee: "Presales Li",
        },
      },
    ]);
  });

  it("deletes business records through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        if (url.endsWith("/api/customers/customer-1")) return jsonResponse({ deleted: sampleCustomer({ id: "customer-1" }) });
        if (url.endsWith("/api/opportunities/opportunity-1")) {
          return jsonResponse({ deleted: sampleOpportunity({ id: "opportunity-1" }) });
        }
        if (url.endsWith("/api/knowledge/knowledge-1")) return jsonResponse({ deleted: sampleKnowledgeItem({ id: "knowledge-1" }) });
        if (url.endsWith("/api/actions/action-1")) return jsonResponse({ deleted: sampleAction({ id: "action-1" }) });
        if (url.endsWith("/api/risks/risk-1")) return jsonResponse({ deleted: sampleRisk({ id: "risk-1" }) });
        return jsonResponse({ deleted: { id: url.split("/").at(-1) } });
      },
    });

    await api.deleteCustomer("customer-1");
    await api.deleteOpportunity("opportunity-1");
    await api.deleteKnowledgeItem("knowledge-1");
    await api.deleteAction("action-1");
    await api.deleteRisk("risk-1");

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8787/api/customers/customer-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/opportunities/opportunity-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/knowledge/knowledge-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/actions/action-1", method: "DELETE" },
      { url: "http://127.0.0.1:8787/api/risks/risk-1", method: "DELETE" },
    ]);
  });

  it("confirms quick record targets through the backend", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        assert.equal(url, "http://127.0.0.1:8787/api/quick-records/qr-1/confirm");
        assert.deepEqual(JSON.parse(options.body), {
          targets: ["customer", "opportunity", "weekly"],
          confirmedBy: "Jizhen",
          note: "manual confirmation",
        });
        return jsonResponse({
          confirmations: [sampleConfirmation()],
          quickRecord: sampleQuickRecord({
            status: "confirmed",
            customerId: "rizhao",
            opportunityId: "op-rizhao-plan",
          }),
          customer: sampleCustomer({ syncPreview: ["快速记录已确认：Rizhao record"] }),
          opportunity: sampleOpportunity({ sourceRecord: "quick-record qr-1" }),
          action: sampleAction(),
        }, 201);
      },
    });

    const result = await api.confirmQuickRecord("qr-1", ["customer", "opportunity", "weekly"], {
      confirmedBy: "Jizhen",
      note: "manual confirmation",
    });

    assert.equal(result.quickRecord.status, "confirmed");
    assertApiCollection("manualConfirmation", result.confirmations);
    assertApiEntity("quickRecord", result.quickRecord);
    assertApiEntity("customer", result.customer);
    assertApiEntity("opportunity", result.opportunity);
    assert.equal(result.action.sourceRecordId, "qr-1");
    assert.equal(result.confirmations[0].target, "weekly");
  });

  it("rejects malformed quick-record risk writeback responses", async () => {
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () =>
        jsonResponse({
          confirmations: [sampleConfirmation()],
          quickRecord: sampleQuickRecord({
            status: "confirmed",
            customerId: "rizhao",
            opportunityId: "op-rizhao-plan",
          }),
          risk: sampleRisk({ score: "high" }),
        }, 201),
    });

    await assert.rejects(
      () => api.confirmQuickRecord("qr-1", ["customer"], { confirmedBy: "Jizhen" }),
      /riskItem\.score: expected number/,
    );
  });


  it("generates weekly and solution drafts through explicit backend calls", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith("/api/reports/weekly/draft")) return jsonResponse({ item: sampleWeeklyReport() }, 201);
        if (url.endsWith("/api/solutions/draft")) return jsonResponse({ item: sampleSolutionDraft() }, 201);
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const weekly = await api.generateWeeklyDraft({
      owner: "Jizhen",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
      knowledgeIds: ["k-mobile-cloud"],
    });
    const solution = await api.generateSolutionDraft({
      owner: "Jizhen",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
      artifactType: "communication_outline",
      knowledgeIds: ["k-mobile-cloud"],
    });

    assertApiEntity("weeklyReport", weekly);
    assertApiEntity("solutionDraft", solution);
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/reports/weekly/draft",
        body: { owner: "Jizhen", periodStart: "2026-06-01", periodEnd: "2026-06-07", knowledgeIds: ["k-mobile-cloud"] },
      },
      {
        url: "http://127.0.0.1:8787/api/solutions/draft",
        body: {
          owner: "Jizhen",
          customerId: "rizhao",
          opportunityId: "op-rizhao-plan",
          artifactType: "communication_outline",
          knowledgeIds: ["k-mobile-cloud"],
        },
      },
    ]);
    assert.equal(solution.artifactType, "solution_framework");
    assert.equal(solution.sourceRefs.length, 3);
  });

  it("saves weekly report edits and exposes a Word export URL", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET", body: JSON.parse(options.body ?? "{}") });
        if (url.endsWith("/api/reports/weekly/wr-1")) {
          return jsonResponse({
            item: sampleWeeklyReport({
              content: "# edited weekly report",
              status: "ready",
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const saved = await api.saveWeeklyReport("wr-1", {
      content: "# edited weekly report",
      status: "ready",
    });

    assertApiEntity("weeklyReport", saved);
    assert.equal(saved.status, "ready");
    assert.equal(saved.content, "# edited weekly report");
    assert.equal(api.getWeeklyReportExportUrl("wr-1"), "http://127.0.0.1:8787/api/reports/weekly/wr-1/export?format=word");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/reports/weekly/wr-1",
        method: "PATCH",
        body: { content: "# edited weekly report", status: "ready" },
      },
    ]);
  });

  it("saves solution draft edits through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET", body: JSON.parse(options.body ?? "{}") });
        if (url.endsWith("/api/solutions/sd-1") && options.method === "PATCH") {
          return jsonResponse({
            item: sampleSolutionDraft({
              content: "# edited solution artifact",
              status: "saved",
            }),
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const saved = await api.saveSolutionDraft("sd-1", {
      content: "# edited solution artifact",
      status: "saved",
    });

    assertApiEntity("solutionDraft", saved);
    assert.equal(saved.status, "saved");
    assert.equal(saved.content, "# edited solution artifact");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/solutions/sd-1",
        method: "PATCH",
        body: { content: "# edited solution artifact", status: "saved" },
      },
    ]);
  });

  it("generates manual AI suggestions through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith("/api/ai/suggestions")) {
          return jsonResponse({
            item: {
              id: "suggestion-1",
              type: "customer_profile",
              title: "生成客户画像补全建议",
              status: "generated",
              content: "## 建议\n补齐关键人、预算窗口和下一步问题。",
              sourceRefs: [{ type: "customer_profile", id: "manual" }],
              createdAt: "2026-06-05T10:00:00.000Z",
            },
          }, 201);
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const suggestion = await api.generateAiSuggestion({
      type: "customer_profile",
      title: "生成客户画像补全建议",
      context: { customer: "日照中医医院" },
    });

    assertApiEntity("aiSuggestion", suggestion);
    assert.equal(suggestion.status, "generated");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/ai/suggestions",
        body: {
          type: "customer_profile",
          title: "生成客户画像补全建议",
          context: { customer: "日照中医医院" },
        },
      },
    ]);
  });

  it("starts, reads, and stops WeChat robot binding through the backend", async () => {
    const calls = [];
    const api = createSalesWorkbenchApi({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "session-token",
      fetchImpl: async (url, options = {}) => {
        calls.push({
          url,
          method: options.method ?? "GET",
          authorization: options.headers?.Authorization,
        });
        return jsonResponse({
          item: {
            status: "waiting_scan",
            qrSvg: "<svg role=\"img\"></svg>",
            message: "二维码已生成",
          },
        });
      },
    });

    const started = await api.startWeixinBinding();
    const status = await api.getWeixinBindingStatus();
    const stopped = await api.stopWeixinBinding();

    assert.equal(started.status, "waiting_scan");
    assert.equal(status.qrSvg, "<svg role=\"img\"></svg>");
    assert.equal(stopped.message, "二维码已生成");
    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "POST",
        authorization: "Bearer session-token",
      },
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "GET",
        authorization: "Bearer session-token",
      },
      {
        url: "http://127.0.0.1:8787/api/integrations/weixin-agent/login",
        method: "DELETE",
        authorization: "Bearer session-token",
      },
    ]);
  });
});
