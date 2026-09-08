(() => {
  "use strict";

  const API_BASE = "/internal/ai/v1/admin";
  const PAGE_SIZE = 20;

  const copy = Object.freeze({
    brand: "\u68EE\u7279\u667A\u884C",
    product: "AI \u7EDF\u4E00\u8C03\u5EA6\u5E73\u53F0",
    navWorkspace: "\u5DE5\u4F5C\u533A",
    navOverview: "\u6982\u89C8",
    navTasks: "\u4EFB\u52A1",
    navAgents: "Agent",
    navStandards: "\u89C4\u8303",
    navModels: "\u6A21\u578B",
    navSchedules: "\u8C03\u5EA6",
    navCosts: "\u6210\u672C\u4E0E\u9884\u7B97",
    runtimeLabel: "\u8FD0\u884C\u6001",
    buildLabel: "AI \u5E73\u53F0",
    eyebrow: "\u8FD0\u8425\u63A7\u5236\u53F0",
    refresh: "\u5237\u65B0",
    overviewKicker: "AI \u63A7\u5236\u9762",
    overviewTitle: "\u5E73\u53F0\u6982\u89C8",
    overviewDescription: "\u7EDF\u4E00\u89C2\u5BDF AI \u6267\u884C\u3001\u5DF2\u53D1\u5E03\u914D\u7F6E\u3001\u8C03\u5EA6\u5065\u5EB7\u548C\u6210\u672C\u3002",
    lastSync: "\u6700\u8FD1\u540C\u6B65",
    kpiTasks: "\u4EFB\u52A1\u603B\u91CF",
    kpiSuccess: "\u6210\u529F\u7387",
    kpiSpend: "\u5468\u671F\u6210\u672C",
    kpiQueue: "\u961F\u5217\u79EF\u538B",
    recentTasks: "\u6700\u8FD1\u4EFB\u52A1",
    recentTasksDescription: "\u63A7\u5236\u9762\u6700\u8FD1\u89C2\u6D4B\u5230\u7684\u8BF7\u6C42\u3002",
    viewAll: "\u67E5\u770B\u5168\u90E8",
    modelHealth: "\u6A21\u578B\u8FDE\u901A\u6027",
    modelHealthDescription: "\u5E73\u53F0\u8FD4\u56DE\u7684\u63D0\u4F9B\u5546\u548C\u80FD\u529B\u72B6\u6001\u3002",
    manage: "\u6253\u5F00",
    agentsHeading: "Agent",
    agentsDescription: "\u5F53\u524D\u53EF\u4F9B\u65B0\u4EFB\u52A1\u4F7F\u7528\u7684\u5DF2\u53D1\u5E03\u7248\u672C\u3002",
    costHeading: "\u6210\u672C\u6458\u8981",
    costDescription: "\u4F9B\u5E94\u5546\u6210\u672C\u548C\u9884\u7B97\u914D\u7F6E\u4FE1\u53F7\u3002",
    details: "\u8BE6\u60C5",
    schedulesHeading: "\u8C03\u5EA6\u72B6\u6001",
    schedulesDescription: "\u540E\u53F0\u4E3B\u52A8\u5206\u6790\u8C03\u5EA6\u548C\u6700\u8FD1\u4E00\u6B21\u8FD0\u884C\u3002",
    tasksKicker: "\u6267\u884C\u8FFD\u8E2A",
    tasksTitle: "\u4EFB\u52A1",
    tasksDescription: "\u67E5\u770B\u72B6\u6001\u3001\u6765\u6E90\u3001\u7248\u672C\u56FA\u5B9A\u548C\u8BF7\u6C42\u65F6\u95F4\u3002",
    agentsKicker: "\u914D\u7F6E\u76EE\u5F55",
    agentsTitle: "Agent",
    agentsPageDescription: "\u5DF2\u53D1\u5E03\u7248\u672C\u3001\u4EFB\u52A1\u8986\u76D6\u548C\u8FD0\u884C\u751F\u547D\u5468\u671F\u3002",
    standardsKicker: "\u7B56\u7565\u76EE\u5F55",
    standardsTitle: "\u89C4\u8303",
    standardsDescription: "Agent \u5F15\u7528\u7684\u4E1A\u52A1\u89C4\u5219\u548C\u8BC1\u636E\u8981\u6C42\u3002",
    modelsKicker: "\u6A21\u578B\u6CE8\u518C\u8868",
    modelsTitle: "\u6A21\u578B",
    modelsDescription: "\u63D0\u4F9B\u5546\u72B6\u6001\u3001\u80FD\u529B\u8FB9\u754C\u548C\u4EF7\u683C\u5143\u6570\u636E\u3002\u4E0D\u5C55\u793A\u5BC6\u94A5\u539F\u503C\u3002",
    schedulesKicker: "\u540E\u53F0\u63A7\u5236",
    schedulesTitle: "\u8C03\u5EA6",
    schedulesPageDescription: "\u89C2\u5BDF\u6682\u505C\u72B6\u6001\u3001\u4E0B\u6B21\u8FD0\u884C\u3001\u79EF\u538B\u548C\u6700\u8FD1\u7ED3\u679C\u3002",
    costsKicker: "\u7528\u91CF\u53F0\u8D26",
    costsTitle: "\u6210\u672C\u4E0E\u9884\u7B97",
    costsDescription: "\u5206\u5F00\u5C55\u793A\u4F9B\u5E94\u5546\u7528\u91CF\u3001\u4F30\u7B97\u3001\u672A\u77E5\u8D39\u7528\u548C\u529F\u80FD\u8D39\u7528\u3002",
    searchTasks: "\u641C\u7D22\u4EFB\u52A1",
    searchTasksPlaceholder: "\u6309 ID\u3001\u529F\u80FD\u6216\u7C7B\u578B\u641C\u7D22",
    searchAgents: "\u641C\u7D22 Agent",
    searchAgentsPlaceholder: "\u6309\u540D\u79F0\u6216 slug \u641C\u7D22",
    allStatuses: "\u5168\u90E8\u72B6\u6001",
    statusQueued: "\u6392\u961F\u4E2D",
    statusRunning: "\u8FD0\u884C\u4E2D",
    statusSucceeded: "\u5DF2\u6210\u529F",
    statusFailed: "\u5931\u8D25",
    statusCancelled: "\u5DF2\u53D6\u6D88",
    statusExpired: "\u5DF2\u8FC7\u671F",
    taskColTask: "\u4EFB\u52A1",
    taskColType: "\u4EFB\u52A1\u7C7B\u578B",
    taskColStatus: "\u72B6\u6001",
    taskColSource: "\u6765\u6E90 / \u7248\u672C",
    taskColRequested: "\u8BF7\u6C42\u65F6\u95F4",
    taskColAttempt: "\u5C1D\u8BD5",
    agentColName: "Agent",
    agentColLifecycle: "\u751F\u547D\u5468\u671F",
    agentColVersion: "\u5DF2\u53D1\u5E03\u7248\u672C",
    agentColTasks: "\u4EFB\u52A1\u7C7B\u578B",
    agentColUpdated: "\u66F4\u65B0\u65F6\u95F4",
    standardColName: "\u89C4\u8303",
    standardColLifecycle: "\u751F\u547D\u5468\u671F",
    standardColVersion: "\u6700\u65B0\u7248\u672C",
    standardColDescription: "\u8BF4\u660E",
    standardColUpdated: "\u66F4\u65B0\u65F6\u95F4",
    modelColProvider: "\u63D0\u4F9B\u5546",
    modelColModel: "\u6A21\u578B",
    modelColCapabilities: "\u80FD\u529B",
    modelColStatus: "\u72B6\u6001",
    modelColPrice: "\u4EF7\u683C\u7248\u672C",
    scheduleColName: "\u8C03\u5EA6",
    scheduleColType: "\u4EFB\u52A1\u7C7B\u578B",
    scheduleColStatus: "\u72B6\u6001",
    scheduleColNext: "\u4E0B\u6B21\u8FD0\u884C",
    scheduleColLast: "\u6700\u8FD1\u7ED3\u679C",
    costColFeature: "\u529F\u80FD",
    costColCalls: "\u8C03\u7528\u6B21\u6570",
    costColSupplier: "\u4F9B\u5E94\u5546\u6210\u672C",
    costColFunction: "\u529F\u80FD\u8D39\u7528",
    costColStatus: "\u8D39\u7528\u72B6\u6001",
    noData: "\u6682\u65E0\u6570\u636E",
    noMatch: "\u6CA1\u6709\u5339\u914D\u7684\u8BB0\u5F55",
    loading: "\u6B63\u5728\u52A0\u8F7D",
    loadingDetail: "\u6B63\u5728\u8BFB\u53D6\u7EDF\u4E00\u8C03\u5EA6\u5E73\u53F0\u3002",
    serviceUnavailable: "\u670D\u52A1\u672A\u8FDE\u63A5",
    serviceUnavailableDetail: "\u65E0\u6CD5\u8FDE\u63A5\u540C\u6E90 AI \u7BA1\u7406\u63A5\u53E3\u3002\u8BF7\u68C0\u67E5\u5E73\u53F0\u670D\u52A1\u6216\u91CD\u8BD5\u3002",
    fileProtocolDetail: "\u5F53\u524D\u9875\u9762\u4EE5\u6587\u4EF6\u65B9\u5F0F\u6253\u5F00\uFF0C\u5FC5\u987B\u901A\u8FC7\u540C\u6E90\u7AD9\u70B9\u8BBF\u95EE\u7BA1\u7406 API\u3002",
    forbidden: "\u65E0\u6743\u9650",
    forbiddenDetail: "\u5F53\u524D\u8D26\u53F7\u6CA1\u6709\u8BFB\u53D6\u6B64\u7BA1\u7406\u8D44\u6E90\u7684\u6743\u9650\u3002",
    serverError: "\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528",
    serverErrorDetail: "\u540C\u6E90 API \u8FD4\u56DE\u4E86\u6682\u65F6\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
    retry: "\u91CD\u8BD5",
    connecting: "\u8FDE\u63A5\u4E2D",
    connected: "\u5DF2\u8FDE\u63A5",
    partial: "\u90E8\u5206\u8FDE\u63A5",
    partialDetail: "\u90E8\u5206\u7BA1\u7406\u8D44\u6E90\u5DF2\u8FDE\u63A5\uFF0C\u5176\u4F59\u8D44\u6E90\u8FD4\u56DE\u9519\u8BEF\u6216\u65E0\u6743\u9650\u3002",
    permissionPartial: "\u90E8\u5206\u8D44\u6E90\u65E0\u6743\u9650",
    notReturned: "\u63A5\u53E3\u672A\u8FD4\u56DE\u8BE5\u6307\u6807",
    notApplicable: "\u4E0D\u9002\u7528",
    unavailable: "\u4E0D\u53EF\u7528",
    enabled: "\u5DF2\u542F\u7528",
    disabled: "\u5DF2\u505C\u7528",
    active: "\u5DF2\u53D1\u5E03",
    draft: "\u8349\u7A3F",
    retired: "\u5DF2\u9000\u5F79",
    paused: "\u5DF2\u6682\u505C",
    unknown: "\u672A\u77E5",
    calculated: "\u5DF2\u8BA1\u7B97",
    estimated: "\u4F30\u7B97",
    notConfigured: "\u672A\u914D\u7F6E",
    monthly: "\u672C\u5468\u671F",
    daily: "\u4ECA\u65E5",
    total: "\u5408\u8BA1",
    budget: "\u9884\u7B97\u4F7F\u7528",
    estimatedCost: "\u4F30\u7B97\u6210\u672C",
    unknownCost: "\u672A\u77E5\u8D39\u7528",
    functionFee: "\u529F\u80FD\u8D39\u7528",
    interval: "\u95F4\u9694",
    nextRun: "\u4E0B\u6B21",
    lastRun: "\u6700\u8FD1",
    noVersion: "\u672A\u53D1\u5E03",
    noDescription: "\u6682\u65E0\u8BF4\u660E",
    noRequestId: "\u65E0 request ID",
    seconds: "\u79D2",
    minutes: "\u5206\u949F",
    hours: "\u5C0F\u65F6",
    days: "\u5929",
    calls: "\u6B21",
    records: "\u6761\u8BB0\u5F55",
    capabilityText: "\u6587\u672C",
    capabilityVision: "\u89C6\u89C9",
    capabilityAudio: "\u8BED\u97F3",
    capabilityExternal: "\u5916\u90E8",
    capabilityNone: "\u672A\u58F0\u660E\u80FD\u529B",
    runtimeReady: "\u5C31\u7EEA",
    runtimeNeedsAttention: "\u9700\u5173\u6CE8",
    runtimeOffline: "\u79BB\u7EBF",
    runtimeUnknown: "\u672A\u77E5",
    refreshStarted: "\u5DF2\u53D1\u8D77\u5237\u65B0",
    refreshFinished: "\u6570\u636E\u5DF2\u5237\u65B0",
  });

  const RESOURCE_DEFINITIONS = Object.freeze({
    overview: { path: "/overview", kind: "object", label: copy.overviewTitle },
    tasks: { path: "/tasks", kind: "list", label: copy.navTasks },
    agents: { path: "/agents", kind: "list", label: copy.navAgents },
    standards: { path: "/standards", kind: "list", label: copy.navStandards },
    models: { path: "/models", kind: "list", label: copy.navModels },
    schedules: { path: "/schedules", kind: "list", label: copy.navSchedules },
    costs: { path: "/costs", kind: "object", label: copy.navCosts },
  });

  const state = {
    activeView: "overview",
    generation: 0,
    controller: null,
    lastSync: null,
    resources: Object.fromEntries(
      Object.keys(RESOURCE_DEFINITIONS).map((key) => [key, {
        status: "idle",
        data: null,
        error: null,
        requestId: null,
        fetchedAt: null,
      }]),
    ),
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function hasOwn(value, key) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function text(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    const normalized = String(value).trim();
    return normalized || fallback;
  }

  function number(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function firstDefined(source, paths) {
    for (const path of paths) {
      const value = valueAt(source, path);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function valueAt(source, path) {
    if (!path) return source;
    return path.split(".").reduce((current, key) => {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object" && typeof current !== "function") return undefined;
      return key in current ? current[key] : undefined;
    }, source);
  }

  function parseJson(value, fallback = null) {
    if (typeof value !== "string") return value ?? fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function unwrapPayload(payload) {
    if (!isRecord(payload)) return payload;
    for (const key of ["data", "item", "resource"]) {
      if (hasOwn(payload, key)) return payload[key];
    }
    if (hasOwn(payload, "result") && (hasOwn(payload, "requestId") || hasOwn(payload, "schemaVersion"))) {
      return payload.result;
    }
    return payload;
  }

  function extractItems(value, extraKeys = []) {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return [];
    const keys = [
      ...extraKeys,
      "items",
      "tasks",
      "agents",
      "standards",
      "models",
      "schedules",
      "rows",
      "entries",
      "records",
      "results",
      "data",
    ];
    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [];
  }

  function resourceIsEmpty(key, data) {
    const definition = RESOURCE_DEFINITIONS[key];
    if (definition.kind === "list") return extractItems(data).length === 0;
    return data === null || data === undefined || (isRecord(data) && Object.keys(data).length === 0);
  }

  function applyCopy() {
    $$('[data-copy]').forEach((element) => {
      const value = copy[element.dataset.copy];
      if (value !== undefined) element.textContent = value;
    });
    $$('[data-placeholder]').forEach((element) => {
      const value = copy[element.dataset.placeholder];
      if (value !== undefined) element.setAttribute("placeholder", value);
    });
  }

  function icon(name) {
    return `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${escapeHtml(name)}"></use></svg>`;
  }

  function createError(kind, status = 0, code = null, requestId = null) {
    return { kind, status, code: text(code, null), requestId: text(requestId, null) };
  }

  function isLocalDevelopmentHost() {
    const hostname = text(location.hostname, "").toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]";
  }

  function requestHeaders() {
    const headers = { Accept: "application/json" };
    if (isLocalDevelopmentHost()) headers["X-AI-Platform-Dev-Auth"] = "1";
    return headers;
  }

  function errorForResponse(response, payload, requestId) {
    const payloadCode = isRecord(payload)
      ? firstDefined(payload, ["errorCode", "code", "error.code"])
      : undefined;
    if (response.status === 401 || response.status === 403) {
      return createError("forbidden", response.status, payloadCode || "admin_forbidden", requestId);
    }
    return createError("server", response.status, payloadCode || `http_${response.status}`, requestId);
  }

  async function fetchResource(key, generation, signal) {
    const definition = RESOURCE_DEFINITIONS[key];
    if (location.protocol === "file:") {
      state.resources[key] = {
        status: "error",
        data: null,
        error: createError("file", 0, "file_protocol", null),
        requestId: null,
        fetchedAt: null,
      };
      return;
    }

    try {
      const response = await fetch(`${API_BASE}${definition.path}`, {
        method: "GET",
        credentials: "same-origin",
        headers: requestHeaders(),
        signal,
      });
      const requestId = response.headers.get("x-request-id") || response.headers.get("x-correlation-id");
      const body = await response.text();
      let payload = null;
      if (body.trim()) {
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        if (generation !== state.generation || signal.aborted) return;
        const error = errorForResponse(response, payload, requestId);
        state.resources[key] = {
          status: error.kind === "forbidden" ? "forbidden" : "error",
          data: null,
          error,
          requestId,
          fetchedAt: new Date(),
        };
        return;
      }
      if (generation !== state.generation || signal.aborted) return;
      const data = unwrapPayload(payload);
      state.resources[key] = {
        status: resourceIsEmpty(key, data) ? "empty" : "success",
        data,
        error: null,
        requestId,
        fetchedAt: new Date(),
      };
    } catch (error) {
      if (signal.aborted || generation !== state.generation) return;
      state.resources[key] = {
        status: "error",
        data: null,
        error: createError("network", 0, error?.name === "AbortError" ? "aborted" : "network_unavailable", null),
        requestId: null,
        fetchedAt: new Date(),
      };
    }
  }

  async function loadAll() {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    const generation = state.generation + 1;
    state.generation = generation;
    state.controller = controller;
    state.lastSync = null;
    Object.keys(RESOURCE_DEFINITIONS).forEach((key) => {
      state.resources[key] = {
        status: "loading",
        data: null,
        error: null,
        requestId: null,
        fetchedAt: null,
      };
    });
    renderAll();
    await Promise.allSettled(
      Object.keys(RESOURCE_DEFINITIONS).map((key) => fetchResource(key, generation, controller.signal)),
    );
    if (generation !== state.generation || controller.signal.aborted) return;
    state.lastSync = new Date();
    renderAll();
  }

  function getConnectionState() {
    const resources = Object.values(state.resources);
    if (resources.some((resource) => resource.status === "loading")) return "loading";
    const reachable = resources.filter((resource) => resource.status === "success" || resource.status === "empty");
    const forbidden = resources.filter((resource) => resource.status === "forbidden");
    const failed = resources.filter((resource) => resource.status === "error");
    if (reachable.length && (forbidden.length || failed.length)) return "partial";
    if (reachable.length) return "connected";
    if (forbidden.length === resources.length) return "forbidden";
    if (failed.length === resources.length) return "error";
    return "loading";
  }

  function connectionLabel(connectionState) {
    return {
      loading: copy.connecting,
      connected: copy.connected,
      partial: copy.partial,
      forbidden: copy.forbidden,
      error: copy.serviceUnavailable,
    }[connectionState] || copy.connecting;
  }

  function renderConnection() {
    const connectionState = getConnectionState();
    const pill = $("#connection-pill");
    const label = $("#connection-label");
    const sidebarDot = $("#sidebar-runtime-dot");
    const sidebarState = $("#sidebar-runtime-state");
    if (!pill || !label || !sidebarDot || !sidebarState) return;
    pill.className = `connection-pill is-${connectionState}`;
    label.textContent = connectionLabel(connectionState);
    sidebarDot.className = "status-dot";
    sidebarState.textContent = {
      loading: copy.connecting,
      connected: copy.runtimeReady,
      partial: copy.runtimeNeedsAttention,
      forbidden: copy.runtimeNeedsAttention,
      error: copy.runtimeOffline,
    }[connectionState] || copy.runtimeUnknown;
    sidebarDot.classList.add({
      loading: "is-loading",
      connected: "is-success",
      partial: "is-warning",
      forbidden: "is-warning",
      error: "is-error",
    }[connectionState] || "is-muted");
  }

  function renderGlobalAlert() {
    const alert = $("#global-alert");
    if (!alert) return;
    const connectionState = getConnectionState();
    if (connectionState === "loading" || connectionState === "connected") {
      alert.hidden = true;
      alert.innerHTML = "";
      return;
    }
    let title = copy.serviceUnavailable;
    let detail = copy.serviceUnavailableDetail;
    let alertClass = "is-error";
    let action = true;
    let symbol = "alert-triangle";
    if (connectionState === "partial") {
      title = copy.partial;
      detail = copy.partialDetail;
      alertClass = "";
      symbol = "activity";
    } else if (connectionState === "forbidden") {
      title = copy.forbidden;
      detail = copy.forbiddenDetail;
      alertClass = "";
      symbol = "lock-keyhole";
      action = false;
    } else if (location.protocol === "file:") {
      title = copy.serviceUnavailable;
      detail = copy.fileProtocolDetail;
      symbol = "database";
    }
    alert.className = `global-alert ${alertClass}`.trim();
    alert.hidden = false;
    alert.innerHTML = `${icon(symbol)}<span class="global-alert-text"><strong>${escapeHtml(title)}</strong><span> ${escapeHtml(detail)}</span></span>${action ? `<button class="global-alert-action" type="button" data-action="refresh">${escapeHtml(copy.retry)}</button>` : ""}`;
  }

  function stateBlock(key, mode = null, detail = null) {
    const resource = RESOURCE_DEFINITIONS[key] || { label: copy.product };
    const resourceState = state.resources[key] || { status: "idle" };
    const actualMode = mode || resourceState.status;
    let title = copy.noData;
    let description = detail || copy.noData;
    let symbol = "database";
    let iconClass = "";
    let action = "";
    if (actualMode === "loading") {
      title = copy.loading;
      description = copy.loadingDetail;
      symbol = "";
      iconClass = "is-loading";
    } else if (actualMode === "forbidden") {
      title = copy.forbidden;
      description = copy.forbiddenDetail;
      symbol = "lock-keyhole";
      iconClass = "is-forbidden";
    } else if (actualMode === "error") {
      title = resourceState.error?.kind === "file" ? copy.serviceUnavailable : copy.serverError;
      description = resourceState.error?.kind === "file" ? copy.fileProtocolDetail : copy.serverErrorDetail;
      symbol = "alert-triangle";
      iconClass = "is-error";
      action = `<button class="state-action" type="button" data-action="refresh">${escapeHtml(copy.retry)}</button>`;
    } else if (actualMode === "filter-empty") {
      title = copy.noMatch;
      description = copy.noData;
      symbol = "search";
    } else {
      title = copy.noData;
      description = detail || `${resource.label} ${copy.noData}`;
    }
    const visual = actualMode === "loading"
      ? `<span class="spinner" aria-hidden="true"></span>`
      : icon(symbol);
    return `<div class="state-block"><div class="state-block-inner"><span class="state-icon ${iconClass}">${visual}</span><strong class="state-title">${escapeHtml(title)}</strong><span class="state-detail">${escapeHtml(description)}</span>${action}</div></div>`;
  }

  function tableStateRow(key, colspan, mode = null, detail = null) {
    return `<tr><td class="table-state-cell" colspan="${colspan}">${stateBlock(key, mode, detail)}</td></tr>`;
  }

  function formatNumber(value) {
    const parsed = number(value);
    if (parsed === null) return "--";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(parsed);
  }

  function formatInteger(value) {
    const parsed = number(value);
    if (parsed === null) return "--";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(parsed);
  }

  function formatPercent(value) {
    const parsed = number(value);
    if (parsed === null) return "--";
    const percent = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(percent)}%`;
  }

  function currencyCode(value, fallback = "USD") {
    const candidate = text(value, fallback).toUpperCase();
    return /^[A-Z]{3}$/.test(candidate) ? candidate : fallback;
  }

  function moneyCandidate(candidate, fallbackCurrency = "USD") {
    if (candidate === undefined || candidate === null || candidate === "") return null;
    if (isRecord(candidate)) {
      const currency = currencyCode(firstDefined(candidate, ["currency", "currencyCode", "unit"]), fallbackCurrency);
      const micro = firstDefined(candidate, ["amountMicro", "costMicro", "functionFeeMicro", "valueMicro"]);
      if (micro !== undefined) {
        const parsed = number(micro);
        return parsed === null ? null : { amount: parsed / 1_000_000, currency, known: true };
      }
      const amount = firstDefined(candidate, ["amount", "value", "total", "cost"]);
      const parsed = number(amount);
      return parsed === null ? null : { amount: parsed, currency, known: true };
    }
    const parsed = number(candidate);
    return parsed === null ? null : { amount: parsed, currency: fallbackCurrency, known: true };
  }

  function readMoney(source, paths, fallbackCurrency = "USD") {
    for (const path of paths) {
      const candidate = valueAt(source, path);
      if (candidate === undefined || candidate === null || candidate === "") continue;
      if (/micro/i.test(path) && !isRecord(candidate)) {
        const parsed = number(candidate);
        if (parsed !== null) return { amount: parsed / 1_000_000, currency: currencyCode(firstDefined(source, ["currency", "cost.currency"]), fallbackCurrency), known: true };
      }
      const result = moneyCandidate(candidate, currencyCode(firstDefined(source, ["currency", "cost.currency"]), fallbackCurrency));
      if (result) return result;
    }
    return null;
  }

  function formatMoney(result) {
    if (!result || result.amount === null || result.amount === undefined) return "--";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode(result.currency),
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(result.amount);
    } catch {
      return `${currencyCode(result.currency)} ${formatNumber(result.amount)}`;
    }
  }

  function formatDate(value, fallback = "--") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value, fallback);
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatInterval(value) {
    const seconds = number(value);
    if (seconds === null) return "--";
    if (seconds < 60) return `${formatInteger(seconds)} ${copy.seconds}`;
    if (seconds < 3600) return `${formatNumber(seconds / 60)} ${copy.minutes}`;
    if (seconds < 86_400) return `${formatNumber(seconds / 3600)} ${copy.hours}`;
    return `${formatNumber(seconds / 86_400)} ${copy.days}`;
  }

  function displayValue(value, fallback = "--") {
    return escapeHtml(text(value, fallback));
  }

  function statusLabel(status) {
    const normalized = text(status, "unknown").toLowerCase();
    return {
      queued: copy.statusQueued,
      running: copy.statusRunning,
      succeeded: copy.statusSucceeded,
      failed: copy.statusFailed,
      cancelled: copy.statusCancelled,
      expired: copy.statusExpired,
      active: copy.active,
      enabled: copy.enabled,
      disabled: copy.disabled,
      draft: copy.draft,
      retired: copy.retired,
      rolled_back: copy.retired,
      paused: copy.paused,
      calculated: copy.calculated,
      estimated: copy.estimated,
      unknown: copy.unknown,
      not_configured: copy.notConfigured,
      not_applicable: copy.notApplicable,
      succeeded_with_warnings: copy.statusSucceeded,
    }[normalized] || text(status, copy.unknown);
  }

  function statusTone(status) {
    const normalized = text(status, "unknown").toLowerCase();
    if (["succeeded", "active", "enabled", "calculated"].includes(normalized)) return "is-success";
    if (["running"].includes(normalized)) return "is-running";
    if (["queued", "draft", "estimated", "paused"].includes(normalized)) return "is-warning";
    if (["failed", "disabled", "expired", "cancelled", "retired", "rolled_back"].includes(normalized)) return "is-error";
    return "is-neutral";
  }

  function statusBadge(status, label = null) {
    const normalized = text(status, "unknown").toLowerCase();
    return `<span class="status-badge ${statusTone(normalized)}"><span class="status-dot ${statusToneToDot(statusTone(normalized))}"></span>${escapeHtml(label || statusLabel(normalized))}</span>`;
  }

  function statusToneToDot(tone) {
    return {
      "is-success": "is-success",
      "is-running": "is-loading",
      "is-warning": "is-warning",
      "is-error": "is-error",
      "is-neutral": "is-muted",
    }[tone] || "is-muted";
  }

  function metricFromKpis(source, aliases) {
    const kpis = extractItems(valueAt(source, "kpis"));
    for (const item of kpis) {
      const key = text(firstDefined(item, ["key", "id", "slug", "name"]), "").toLowerCase();
      if (aliases.some((alias) => key === alias || key.includes(alias))) {
        return firstDefined(item, ["value", "amount", "count", "metric", "data"]);
      }
    }
    return undefined;
  }

  function readMetric(source, paths, aliases = []) {
    const direct = firstDefined(source, paths);
    return direct !== undefined ? direct : metricFromKpis(source, aliases);
  }

  function readCurrency(source) {
    return currencyCode(firstDefined(source, ["currency", "cost.currency", "costs.currency", "summary.currency"]), "USD");
  }

  function resourceData(key) {
    const resource = state.resources[key];
    return resource && (resource.status === "success" || resource.status === "empty") ? resource.data : null;
  }

  function renderKpis() {
    const data = resourceData("overview");
    const resource = state.resources.overview;
    const metrics = {
      tasks: readMetric(data, ["tasks.total", "taskCount", "totalTasks", "metrics.tasks.total", "summary.taskCount"], ["task", "total"]),
      success: readMetric(data, ["successRate", "tasks.successRate", "metrics.successRate", "metrics.tasks.successRate", "summary.successRate"], ["success", "rate"]),
      spend: readMoney(data, ["periodSpendMicro", "periodCostMicro", "cost.totalMicro", "cost.costMicro", "costs.periodCostMicro", "costs.totalCostMicro", "monthlyCostMicro", "monthlySpendMicro", "periodSpend", "periodCost", "costs.periodCost", "costs.totalCost", "monthlyCost", "monthlySpend"], readCurrency(data)),
      queue: readMetric(data, ["queueDepth", "queue.depth", "tasks.queueDepth", "metrics.queueDepth", "metrics.queue.depth", "summary.queueDepth"], ["queue", "backlog"]),
    };
    const values = {
      tasks: metrics.tasks === undefined || metrics.tasks === null ? "--" : formatInteger(metrics.tasks),
      success: metrics.success === undefined || metrics.success === null ? "--" : formatPercent(metrics.success),
      spend: formatMoney(metrics.spend),
      queue: metrics.queue === undefined || metrics.queue === null ? "--" : formatInteger(metrics.queue),
    };
    const notes = {
      tasks: readMetric(data, ["tasks.periodLabel", "periodLabel", "windowLabel"], []) || (resource.status === "empty" ? copy.noData : copy.notReturned),
      success: readMetric(data, ["successRateLabel", "tasks.successRateLabel"], []) || (resource.status === "empty" ? copy.noData : copy.notReturned),
      spend: readMetric(data, ["costs.periodLabel", "periodLabel", "costPeriod"], []) || (resource.status === "empty" ? copy.noData : copy.notReturned),
      queue: readMetric(data, ["queueLabel", "queue.label"], []) || (resource.status === "empty" ? copy.noData : copy.notReturned),
    };
    ["tasks", "success", "spend", "queue"].forEach((key) => {
      const valueElement = $(`[data-kpi-value="${key}"]`);
      const noteElement = $(`[data-kpi-note="${key}"]`);
      if (valueElement) valueElement.textContent = values[key];
      if (noteElement) noteElement.textContent = text(notes[key], copy.notReturned);
    });
  }

  function normalizeTask(row) {
    const subject = isRecord(row?.subject) ? row.subject : {};
    return {
      id: text(firstDefined(row, ["taskId", "id", "requestId"]), copy.noRequestId),
      requestId: text(firstDefined(row, ["requestId", "request_id"]), ""),
      taskType: text(firstDefined(row, ["taskType", "task_type"]), "--"),
      feature: text(firstDefined(row, ["feature"]), "--"),
      channel: text(firstDefined(row, ["channel"]), "--"),
      priority: text(firstDefined(row, ["priority"]), "--"),
      status: text(firstDefined(row, ["status"]), "unknown").toLowerCase(),
      source: text(firstDefined(row, ["source"]), "--"),
      agentVersion: text(firstDefined(row, ["agentVersion", "agent_version_id"]), "--"),
      model: text(firstDefined(row, ["model", "modelId", "model_id"]), "--"),
      owner: text(firstDefined(row, ["owner"]), "--"),
      requestedAt: firstDefined(row, ["requestedAt", "requested_at"]),
      completedAt: firstDefined(row, ["completedAt", "completed_at"]),
      currentAttempt: firstDefined(row, ["currentAttempt", "current_attempt"]),
      subjectType: text(firstDefined(subject, ["type"]), ""),
      subjectId: text(firstDefined(subject, ["id"]), ""),
    };
  }

  function taskItems() {
    return extractItems(resourceData("tasks")).map(normalizeTask);
  }

  function taskSearchMatches(task, query, statusFilter) {
    if (statusFilter && task.status !== statusFilter) return false;
    if (!query) return true;
    const haystack = [task.id, task.requestId, task.taskType, task.feature, task.channel, task.owner, task.model]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  function taskTableMarkup(items, key = "tasks", { limit = null, filters = false } = {}) {
    const resource = state.resources[key];
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      return `<table class="data-table"><tbody>${tableStateRow(key, 6)}</tbody></table>`;
    }
    const visible = limit ? items.slice(0, limit) : items;
    if (!visible.length) {
      const mode = filters ? "filter-empty" : "empty";
      return `<table class="data-table"><tbody>${tableStateRow(key, 6, mode)}</tbody></table>`;
    }
    const header = `<thead><tr><th>${escapeHtml(copy.taskColTask)}</th><th class="hide-on-mobile">${escapeHtml(copy.taskColType)}</th><th>${escapeHtml(copy.taskColStatus)}</th><th class="hide-on-mobile">${escapeHtml(copy.taskColSource)}</th><th class="hide-on-mobile">${escapeHtml(copy.taskColRequested)}</th><th>${escapeHtml(copy.taskColAttempt)}</th></tr></thead>`;
    const rows = visible.map((task) => {
      const secondary = [task.feature, task.channel].filter((value) => value && value !== "--").join(" / ");
      const version = [task.source, task.agentVersion !== "--" ? task.agentVersion : null].filter(Boolean).join(" / ");
      return `<tr>
        <td><span class="primary-cell mono-cell">${displayValue(task.id)}</span><span class="secondary-cell">${displayValue(secondary || task.requestId || "--")}</span></td>
        <td class="hide-on-mobile"><span class="primary-cell">${displayValue(task.taskType)}</span><span class="secondary-cell">${displayValue(task.priority)}</span></td>
        <td>${statusBadge(task.status)}</td>
        <td class="hide-on-mobile"><span class="primary-cell">${displayValue(version || "--")}</span><span class="secondary-cell">${displayValue(task.model)}</span></td>
        <td class="hide-on-mobile"><span class="primary-cell">${displayValue(formatDate(task.requestedAt))}</span><span class="secondary-cell">${displayValue(task.completedAt ? formatDate(task.completedAt) : "--")}</span></td>
        <td><span class="primary-cell">${displayValue(task.currentAttempt ?? "--")}</span><span class="secondary-cell">${displayValue(task.owner)}</span></td>
      </tr>`;
    }).join("");
    return `<table class="data-table">${header}<tbody>${rows}</tbody></table>`;
  }

  function renderOverviewTasks() {
    const container = $("#overview-task-table");
    if (!container) return;
    container.innerHTML = taskTableMarkup(taskItems(), "tasks", { limit: 6 });
    const taskCount = taskItems().filter((task) => task.status === "queued" || task.status === "running").length;
    const queueMetric = readMetric(resourceData("overview"), ["queueDepth", "queue.depth", "tasks.queueDepth"], ["queue", "backlog"]);
    const badge = $("#nav-task-count");
    if (badge) {
      const count = queueMetric !== undefined && queueMetric !== null ? number(queueMetric) : taskCount;
      if (count && count > 0) {
        badge.hidden = false;
        badge.textContent = formatInteger(count);
      } else {
        badge.hidden = true;
      }
    }
  }

  function normalizeAgent(row) {
    const activeRelease = row?.activeRelease || row?.active_release || row?.release || {};
    const versionObject = row?.activeVersion || row?.active_version || activeRelease?.version || {};
    const taskTypes = parseJson(firstDefined(row, ["taskTypes", "task_types", "supportedTaskTypes"]), []);
    const nestedTaskTypes = parseJson(firstDefined(versionObject, ["taskTypes", "task_types"]), []);
    return {
      id: text(firstDefined(row, ["id", "agentId", "agent_id"]), "--"),
      slug: text(firstDefined(row, ["slug"]), "--"),
      name: text(firstDefined(row, ["name", "displayName"]), text(firstDefined(row, ["slug"]), "--")),
      description: text(firstDefined(row, ["description"]), copy.noDescription),
      lifecycle: text(firstDefined(row, ["lifecycle", "status"]), "unknown").toLowerCase(),
      releaseStatus: text(firstDefined(row, ["releaseStatus", "release_status"]), text(firstDefined(activeRelease, ["status"]), "unknown")).toLowerCase(),
      version: text(firstDefined(row, ["activeVersion.version", "latestVersion.version", "activeVersion.versionId", "latestVersion.versionId", "activeVersionId", "active_version_id", "publishedVersion", "published_version", "activeVersion.id", "latestVersion.id"]), copy.noVersion),
      taskTypes: Array.isArray(taskTypes) && taskTypes.length ? taskTypes : (Array.isArray(nestedTaskTypes) ? nestedTaskTypes : []),
      standards: parseJson(firstDefined(row, ["standards", "standardIds", "standard_ids"]), []),
      updatedAt: firstDefined(row, ["updatedAt", "updated_at", "publishedAt", "published_at"]),
    };
  }

  function agentItems() {
    return extractItems(resourceData("agents")).map(normalizeAgent);
  }

  function agentStatus(agent) {
    if (agent.lifecycle === "disabled" || agent.releaseStatus === "retired") return "disabled";
    if (agent.lifecycle === "draft" || agent.releaseStatus === "draft") return "draft";
    if (agent.releaseStatus === "active" || agent.lifecycle === "active") return "active";
    return "unknown";
  }

  function agentMarkup(agent) {
    const lifecycle = agentStatus(agent);
    const taskText = agent.taskTypes.length ? agent.taskTypes.join(" / ") : (agent.description || copy.noData);
    const markTone = lifecycle === "active" ? "is-green" : lifecycle === "draft" ? "is-amber" : "";
    return `<div class="agent-row">
      <span class="entity-mark ${markTone}">AG</span>
      <div class="entity-copy"><strong>${displayValue(agent.name)}</strong><span>${displayValue(agent.slug)} / ${displayValue(taskText)}</span></div>
      <div class="entity-meta">${statusBadge(lifecycle)}<span class="version-tag">${displayValue(agent.version)}</span></div>
    </div>`;
  }

  function renderAgentList(container, { page = false, query = "" } = {}) {
    if (!container) return;
    const resource = state.resources.agents;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      container.innerHTML = stateBlock("agents");
      return;
    }
    const items = agentItems().filter((agent) => {
      if (!query) return true;
      return [agent.id, agent.slug, agent.name, agent.description, agent.taskTypes.join(" ")].join(" ").toLowerCase().includes(query.toLowerCase());
    });
    if (!items.length) {
      container.innerHTML = stateBlock("agents", query ? "filter-empty" : "empty");
      return;
    }
    const visible = page ? items : items.slice(0, 5);
    container.innerHTML = visible.map(agentMarkup).join("");
  }

  function normalizeStandard(row) {
    const activeVersion = row?.activeVersion || row?.active_version || row?.latestVersion || row?.latest_version || {};
    const versions = extractItems(row, ["versions", "standardVersions", "standard_versions"]);
    const latest = versions.length ? versions[versions.length - 1] : activeVersion;
    return {
      id: text(firstDefined(row, ["id", "standardId", "standard_id"]), "--"),
      slug: text(firstDefined(row, ["slug"]), "--"),
      name: text(firstDefined(row, ["name", "displayName"]), text(firstDefined(row, ["slug"]), "--")),
      description: text(firstDefined(row, ["description"]), copy.noDescription),
      lifecycle: text(firstDefined(row, ["lifecycle", "status"]), "unknown").toLowerCase(),
      version: text(firstDefined(row, ["latestVersion.version", "latest_version.version", "latestVersion.versionId", "latest_version.versionId", "latestVersion.id", "latest_version.id", "activeVersionId", "active_version_id"]), copy.noVersion),
      updatedAt: firstDefined(row, ["updatedAt", "updated_at", "createdAt", "created_at"]),
    };
  }

  function standardItems() {
    return extractItems(resourceData("standards")).map(normalizeStandard);
  }

  function renderStandards() {
    const container = $("#standards-view-content");
    if (!container) return;
    const resource = state.resources.standards;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      container.innerHTML = `<table class="data-table"><tbody>${tableStateRow("standards", 5)}</tbody></table>`;
      return;
    }
    const items = standardItems();
    if (!items.length) {
      container.innerHTML = `<table class="data-table"><tbody>${tableStateRow("standards", 5, "empty")}</tbody></table>`;
      return;
    }
    const rows = items.map((standard) => `<tr>
      <td><span class="primary-cell">${displayValue(standard.name)}</span><span class="secondary-cell mono-cell">${displayValue(standard.slug)}</span></td>
      <td>${statusBadge(standard.lifecycle)}</td>
      <td><span class="mono-cell">${displayValue(standard.version)}</span></td>
      <td><span class="primary-cell">${displayValue(standard.description)}</span></td>
      <td>${displayValue(formatDate(standard.updatedAt))}</td>
    </tr>`).join("");
    container.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(copy.standardColName)}</th><th>${escapeHtml(copy.standardColLifecycle)}</th><th>${escapeHtml(copy.standardColVersion)}</th><th class="hide-on-mobile">${escapeHtml(copy.standardColDescription)}</th><th class="hide-on-mobile">${escapeHtml(copy.standardColUpdated)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function normalizeModel(row) {
    const provider = row?.provider || {};
    const capabilities = parseJson(firstDefined(row, ["capabilities", "capabilities_json"]), {});
    const providerCapabilities = parseJson(firstDefined(provider, ["capabilities"]), {});
    const mergedCapabilities = isRecord(capabilities) ? capabilities : isRecord(providerCapabilities) ? providerCapabilities : {};
    const price = row?.price || row?.priceVersion || row?.price_version || {};
    return {
      id: text(firstDefined(row, ["id", "modelId", "model_id"]), "--"),
      name: text(firstDefined(row, ["name", "model", "modelName"]), "--"),
      provider: text(firstDefined(row, ["providerName", "provider_name"]), text(firstDefined(provider, ["name", "id"]), "--")),
      providerKind: text(firstDefined(row, ["providerKind", "provider_kind"]), text(firstDefined(provider, ["kind"]), "")),
      enabled: firstDefined(row, ["enabled", "isEnabled"]) !== undefined ? Boolean(firstDefined(row, ["enabled", "isEnabled"])) : null,
      capabilities: mergedCapabilities,
      priceVersion: text(firstDefined(row, ["priceVersion", "price_version", "priceVersionId"]), text(firstDefined(price, ["version", "id"]), "--")),
      updatedAt: firstDefined(row, ["updatedAt", "updated_at"]),
    };
  }

  function modelItems() {
    return extractItems(resourceData("models")).map(normalizeModel);
  }

  function capabilityLabels(capabilities) {
    if (!isRecord(capabilities)) return [];
    const labels = [];
    if (capabilities.text) labels.push(copy.capabilityText);
    if (capabilities.vision) labels.push(copy.capabilityVision);
    if (capabilities.audio || capabilities.asr) labels.push(copy.capabilityAudio);
    if (capabilities.external) labels.push(copy.capabilityExternal);
    return labels.length ? labels : [copy.capabilityNone];
  }

  function modelMarkup(model) {
    const status = model.enabled === false ? "disabled" : model.enabled === true ? "enabled" : "unknown";
    const labels = capabilityLabels(model.capabilities);
    const tone = status === "enabled" ? "is-green" : status === "disabled" ? "is-amber" : "";
    return `<div class="model-row"><span class="entity-mark ${tone}"><svg class="ui-icon" aria-hidden="true"><use href="#icon-cpu"></use></svg></span><div class="entity-copy"><strong>${displayValue(model.name)}</strong><span>${displayValue(model.provider)}${model.providerKind ? ` / ${displayValue(model.providerKind)}` : ""}</span></div><div class="model-capabilities">${labels.map((label) => `<span class="capability-chip">${displayValue(label)}</span>`).join("")}</div>${statusBadge(status)}</div>`;
  }

  function renderModelList() {
    const container = $("#overview-model-list");
    if (!container) return;
    const resource = state.resources.models;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      container.innerHTML = stateBlock("models");
      return;
    }
    const items = modelItems();
    if (!items.length) {
      container.innerHTML = stateBlock("models", "empty");
      return;
    }
    container.innerHTML = items.slice(0, 4).map(modelMarkup).join("");
  }

  function renderModelsPage() {
    const container = $("#models-view-content");
    if (!container) return;
    const resource = state.resources.models;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      container.innerHTML = `<table class="data-table"><tbody>${tableStateRow("models", 5)}</tbody></table>`;
      return;
    }
    const items = modelItems();
    if (!items.length) {
      container.innerHTML = `<table class="data-table"><tbody>${tableStateRow("models", 5, "empty")}</tbody></table>`;
      return;
    }
    const rows = items.map((model) => {
      const status = model.enabled === false ? "disabled" : model.enabled === true ? "enabled" : "unknown";
      return `<tr>
        <td><span class="primary-cell">${displayValue(model.provider)}</span><span class="secondary-cell">${displayValue(model.providerKind || "--")}</span></td>
        <td><span class="primary-cell">${displayValue(model.name)}</span><span class="secondary-cell mono-cell">${displayValue(model.id)}</span></td>
        <td>${capabilityLabels(model.capabilities).map((label) => `<span class="capability-chip">${displayValue(label)}</span>`).join(" ")}</td>
        <td>${statusBadge(status)}</td>
        <td><span class="mono-cell">${displayValue(model.priceVersion)}</span></td>
      </tr>`;
    }).join("");
    container.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(copy.modelColProvider)}</th><th>${escapeHtml(copy.modelColModel)}</th><th>${escapeHtml(copy.modelColCapabilities)}</th><th>${escapeHtml(copy.modelColStatus)}</th><th class="hide-on-mobile">${escapeHtml(copy.modelColPrice)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function normalizeSchedule(row) {
    const enabledValue = firstDefined(row, ["enabled", "isEnabled"]);
    const lastStatus = text(firstDefined(row, ["lastStatus", "last_status", "status"]), enabledValue === false ? "paused" : "unknown").toLowerCase();
    return {
      id: text(firstDefined(row, ["id", "scheduleId", "schedule_id"]), "--"),
      name: text(firstDefined(row, ["name", "slug"]), "--"),
      slug: text(firstDefined(row, ["slug"]), "--"),
      taskType: text(firstDefined(row, ["taskType", "task_type"]), "--"),
      feature: text(firstDefined(row, ["feature"]), "--"),
      enabled: enabledValue === undefined ? null : Boolean(enabledValue),
      intervalSeconds: firstDefined(row, ["intervalSeconds", "interval_seconds", "interval"]),
      nextRunAt: firstDefined(row, ["nextRunAt", "next_run_at"]),
      lastRunAt: firstDefined(row, ["lastRunAt", "last_run_at"]),
      lastStatus,
      lastError: text(firstDefined(row, ["lastError", "last_error"]), ""),
      backlog: firstDefined(row, ["backlog", "queueDepth", "pendingCount"]),
    };
  }

  function scheduleItems() {
    return extractItems(resourceData("schedules")).map(normalizeSchedule);
  }

  function scheduleStatus(schedule) {
    if (schedule.enabled === false) return "paused";
    if (schedule.enabled === true && schedule.lastStatus === "succeeded") return "succeeded";
    if (schedule.enabled === true && schedule.lastStatus === "failed") return "failed";
    if (schedule.enabled === true) return "enabled";
    return schedule.lastStatus || "unknown";
  }

  function scheduleMarkup(schedule) {
    const status = scheduleStatus(schedule);
    const backlog = number(schedule.backlog);
    return `<div class="schedule-item"><span class="entity-mark ${status === "succeeded" || status === "enabled" ? "is-green" : status === "failed" ? "is-amber" : ""}"><svg class="ui-icon" aria-hidden="true"><use href="#icon-calendar-clock"></use></svg></span><div class="schedule-copy"><strong>${displayValue(schedule.name)}</strong><span>${displayValue(schedule.taskType)} / ${displayValue(schedule.feature)}</span><span>${escapeHtml(copy.interval)} ${displayValue(formatInterval(schedule.intervalSeconds))}${backlog !== null ? ` / ${escapeHtml(copy.budget)} ${displayValue(formatInteger(backlog))}` : ""}</span></div><div class="schedule-meta">${statusBadge(status)}<span class="schedule-time">${escapeHtml(copy.nextRun)} ${displayValue(formatDate(schedule.nextRunAt))}</span></div></div>`;
  }

  function renderScheduleList(container, { page = false } = {}) {
    if (!container) return;
    const resource = state.resources.schedules;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      container.innerHTML = stateBlock("schedules");
      return;
    }
    const items = scheduleItems();
    if (!items.length) {
      container.innerHTML = stateBlock("schedules", "empty");
      return;
    }
    const visible = page ? items : items.slice(0, 3);
    container.innerHTML = visible.map(scheduleMarkup).join("");
  }

  function normalizeCostRow(row) {
    const explicitStatus = firstDefined(row, ["costStatus", "cost_status", "status"]);
    const unknownCosts = number(firstDefined(row, ["unknownCosts", "unknown_costs"]));
    const estimatedCosts = number(firstDefined(row, ["estimatedCosts", "estimated_costs"]));
    const inferredStatus = unknownCosts > 0
      ? "unknown"
      : estimatedCosts > 0
        ? "estimated"
        : explicitStatus === undefined
          ? "calculated"
          : explicitStatus;
    return {
      feature: text(firstDefined(row, ["feature", "featureName", "feature_name", "groupKey", "group_key"]), "--"),
      calls: firstDefined(row, ["calls", "callCount", "call_count", "tasks"]),
      supplier: readMoney(row, ["supplierCostMicro", "costMicro", "supplierCost", "cost", "amountMicro", "amount"], readCurrency(row)),
      functionFee: readMoney(row, ["functionFeeMicro", "functionFee", "feeMicro", "fee"], readCurrency(row)),
      status: text(inferredStatus, "unknown").toLowerCase(),
    };
  }

  function costSource() {
    return resourceData("costs");
  }

  function costRows() {
    const data = costSource();
    const rows = extractItems(data, ["byFeature", "by_feature", "breakdown", "groups", "ledger", "usage"]);
    if (rows.length) return rows.map(normalizeCostRow);
    const overviewCost = valueAt(resourceData("overview"), "cost");
    const overviewRows = extractItems(overviewCost, ["groups"]);
    return overviewRows.map(normalizeCostRow);
  }

  function costSummaryValues() {
    const data = costSource();
    const currency = readCurrency(data);
    const total = readMoney(data, ["totalMicro", "totalCostMicro", "supplierCostMicro", "costMicro", "totalCost", "supplierCost", "total", "summary.totalMicro", "summary.totalCostMicro", "summary.totalCost"], currency);
    const estimated = readMoney(data, ["estimatedCostMicro", "estimatedCost", "summary.estimatedCostMicro", "summary.estimatedCost"], currency);
    const unknown = readMoney(data, ["unknownCostMicro", "unknownCost", "summary.unknownCostMicro", "summary.unknownCost"], currency);
    const functionFees = readMoney(data, ["functionFeeMicro", "functionFeesMicro", "functionFee", "functionFees", "summary.functionFeeMicro", "summary.functionFee"], currency);
    const spent = readMoney(data, ["budget.spentMicro", "budget.spent", "budget.usedMicro", "budget.used"], currency);
    const limit = readMoney(data, ["budget.amountMicro", "budget.amount", "budget.limitMicro", "budget.limit"], currency);
    let percent = number(firstDefined(data, ["budget.usagePercent", "budget.percent", "usagePercent"]));
    if (percent === null && spent && limit && limit.amount > 0) percent = (spent.amount / limit.amount) * 100;
    return { currency, total, estimated, unknown, functionFees, spent, limit, percent };
  }

  function meterClass(percent) {
    if (percent === null) return "";
    if (percent >= 100) return "is-danger";
    if (percent >= 80) return "is-warning";
    return "";
  }

  function costSummaryMarkup() {
    const resource = state.resources.costs;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") return stateBlock("costs");
    if (resource.status === "empty") return stateBlock("costs", "empty");
    const summary = costSummaryValues();
    const percent = summary.percent;
    const percentLabel = percent === null ? "--" : formatPercent(percent);
    const fillWidth = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    return `<div class="cost-summary"><div><span class="cost-total-label">${escapeHtml(copy.total)}</span><strong class="cost-total">${escapeHtml(formatMoney(summary.total))}</strong><span class="cost-footnote">${escapeHtml(copy.monthly)} / ${escapeHtml(summary.currency)}</span></div><div class="budget-meter"><div class="budget-meter-label"><span>${escapeHtml(copy.budget)}</span><strong>${escapeHtml(percentLabel)}</strong></div><div class="meter-track"><div class="meter-fill ${meterClass(percent)}" style="width:${fillWidth}%"></div></div></div></div><div class="cost-mini-grid"><div class="cost-mini-item"><span>${escapeHtml(copy.estimatedCost)}</span><strong>${escapeHtml(formatMoney(summary.estimated))}</strong></div><div class="cost-mini-item"><span>${escapeHtml(copy.unknownCost)}</span><strong>${escapeHtml(formatMoney(summary.unknown))}</strong></div><div class="cost-mini-item"><span>${escapeHtml(copy.functionFee)}</span><strong>${escapeHtml(formatMoney(summary.functionFees))}</strong></div></div>`;
  }

  function renderCostSummary() {
    const container = $("#overview-cost-summary");
    if (container) container.innerHTML = costSummaryMarkup();
  }

  function renderCostsPage() {
    const metricContainer = $("#costs-kpi-grid");
    const tableContainer = $("#costs-view-content");
    const resource = state.resources.costs;
    if (!metricContainer || !tableContainer) return;
    if (!resource || resource.status === "idle" || resource.status === "loading" || resource.status === "error" || resource.status === "forbidden") {
      metricContainer.innerHTML = "";
      tableContainer.innerHTML = `<table class="data-table"><tbody>${tableStateRow("costs", 5)}</tbody></table>`;
      return;
    }
    if (resource.status === "empty") {
      metricContainer.innerHTML = "";
      tableContainer.innerHTML = `<table class="data-table"><tbody>${tableStateRow("costs", 5, "empty")}</tbody></table>`;
      return;
    }
    const summary = costSummaryValues();
    const metrics = [
      [copy.total, formatMoney(summary.total)],
      [copy.estimatedCost, formatMoney(summary.estimated)],
      [copy.unknownCost, formatMoney(summary.unknown)],
    ];
    metricContainer.innerHTML = metrics.map(([label, value]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    const rows = costRows();
    if (!rows.length) {
      tableContainer.innerHTML = `<table class="data-table"><tbody>${tableStateRow("costs", 5, "empty", copy.noData)}</tbody></table>`;
      return;
    }
    tableContainer.innerHTML = `<table class="data-table"><thead><tr><th>${escapeHtml(copy.costColFeature)}</th><th>${escapeHtml(copy.costColCalls)}</th><th>${escapeHtml(copy.costColSupplier)}</th><th>${escapeHtml(copy.costColFunction)}</th><th>${escapeHtml(copy.costColStatus)}</th></tr></thead><tbody>${rows.map((row) => `<tr><td><span class="primary-cell">${displayValue(row.feature)}</span></td><td>${displayValue(row.calls === undefined ? "--" : `${formatInteger(row.calls)} ${copy.calls}`)}</td><td>${displayValue(formatMoney(row.supplier))}</td><td>${displayValue(formatMoney(row.functionFee))}</td><td>${statusBadge(row.status)}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderTasksPage() {
    const container = $("#tasks-view-content");
    if (!container) return;
    const query = text($("#tasks-search")?.value, "");
    const statusFilter = text($("#tasks-status-filter")?.value, "");
    const items = taskItems().filter((task) => taskSearchMatches(task, query, statusFilter));
    container.innerHTML = taskTableMarkup(items, "tasks", { filters: Boolean(query || statusFilter) });
  }

  function renderViews() {
    const active = state.activeView;
    $$('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== active;
    });
    $$('[data-view]').forEach((button) => {
      const isActive = button.dataset.view === active;
      button.classList.toggle("is-active", isActive);
      if (isActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const pageTitles = {
      overview: copy.overviewTitle,
      tasks: copy.tasksTitle,
      agents: copy.agentsTitle,
      standards: copy.standardsTitle,
      models: copy.modelsTitle,
      schedules: copy.schedulesTitle,
      costs: copy.costsTitle,
    };
    const title = $("#page-title");
    if (title) title.textContent = pageTitles[active] || copy.overviewTitle;
    if (active === "tasks") renderTasksPage();
    if (active === "agents") renderAgentList($("#agents-view-content"), { page: true, query: text($("#agents-search")?.value, "") });
    if (active === "standards") renderStandards();
    if (active === "models") renderModelsPage();
    if (active === "schedules") renderScheduleList($("#schedules-view-content"), { page: true });
    if (active === "costs") renderCostsPage();
  }

  function renderAll() {
    renderConnection();
    renderGlobalAlert();
    renderKpis();
    renderOverviewTasks();
    renderModelList();
    renderAgentList($("#overview-agent-list"));
    renderCostSummary();
    renderScheduleList($("#overview-schedule-list"));
    renderViews();
    const lastSync = $("#last-sync");
    if (lastSync) lastSync.textContent = state.lastSync ? formatDate(state.lastSync) : "--";
  }

  function setActiveView(view) {
    if (!RESOURCE_DEFINITIONS[view]) return;
    state.activeView = view;
    const shell = $("#app-shell");
    const menuButton = $("#mobile-menu-button");
    if (shell) shell.classList.remove("is-nav-open");
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
    renderViews();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleNavigation(force = null) {
    const shell = $("#app-shell");
    const menuButton = $("#mobile-menu-button");
    if (!shell || !menuButton) return;
    const open = force === null ? !shell.classList.contains("is-nav-open") : force;
    shell.classList.toggle("is-nav-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
  }

  function showToast(message, tone = "") {
    const region = $("#toast-region");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`.trim();
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2400);
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const navButton = event.target.closest("[data-view]");
      if (navButton) {
        setActiveView(navButton.dataset.view);
        return;
      }
      const viewLink = event.target.closest("[data-view-link]");
      if (viewLink) {
        setActiveView(viewLink.dataset.viewLink);
        return;
      }
      const action = event.target.closest("[data-action]");
      if (action?.dataset.action === "refresh") {
        showToast(copy.refreshStarted);
        loadAll().then(() => {
          if (getConnectionState() === "connected") showToast(copy.refreshFinished, "is-success");
        });
        return;
      }
      if (event.target.closest("#mobile-menu-button")) {
        toggleNavigation();
        return;
      }
      if (event.target.closest("#sidebar-close") || event.target.closest("#mobile-overlay")) {
        toggleNavigation(false);
      }
    });

    $("#refresh-button")?.addEventListener("click", () => {
      showToast(copy.refreshStarted);
      loadAll().then(() => {
        if (getConnectionState() === "connected") showToast(copy.refreshFinished, "is-success");
      });
    });
    $("#tasks-search")?.addEventListener("input", renderTasksPage);
    $("#tasks-status-filter")?.addEventListener("change", renderTasksPage);
    $("#agents-search")?.addEventListener("input", () => renderAgentList($("#agents-view-content"), { page: true, query: text($("#agents-search")?.value, "") }));
  }

  function init() {
    applyCopy();
    bindEvents();
    renderAll();
    loadAll();
  }

  init();
})();
