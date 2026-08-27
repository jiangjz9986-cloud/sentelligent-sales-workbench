import {
  CircleAlert,
  Database,
  Eye,
  EyeOff,
  FileText,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  Mic,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createSalesWorkbenchApi,
  resolveApiBaseUrl,
} from "./api/salesWorkbenchApi.js";
import {
  clearLegacyAuthSession,
  createDisplaySession,
} from "./sessionAuth.js";
import {
  compatibilityRouteMeta,
  moduleSubnavItems,
  navItems,
} from "./data/salesWorkbenchData.js";
import {
  createErrorWorkbenchState,
  createLoadingWorkbenchState,
  assertBackendReady,
  incrementBootstrapAttempt,
  isCurrentBootstrapAttempt,
  normalizeBootstrapData,
  removeEntityById,
} from "./app/workbenchState.js";
import {
  ActionsPage,
  CustomerPage,
  KanbanPage,
  KnowledgePage,
  OpportunityPage,
  Overview,
  PageHeading,
  QuickRecord,
  RiskPage,
  SolutionPage,
  WeixinBindingPage,
  WeeklyPage,
} from "./features/salesWorkbench/pages.jsx";
import { VisitItineraryPage } from "./features/visitItinerary/VisitItineraryPage.jsx";
import { TravelExpensePage } from "./features/travelExpense/TravelExpensePage.jsx";
import { HospitalTenderPage } from "./features/hospitalTender/HospitalTenderPage.jsx";
import { SystemSettingsPage } from "./features/settings/SystemSettingsPage.jsx";
import { ModuleSubnav } from "./components/ModuleSubnav.jsx";
import { buildWorkbenchUrl, parseWorkbenchRoute } from "./app/routes.js";
import { mergeEntityByVersion } from "./quickRecordModel.js";
import { getCurrentWeekRange } from "./weekRange.js";

function resolveHeadingContext({
  active,
  customerViewMode,
  opportunityViewMode,
  actionViewMode,
  riskViewMode,
  knowledgeViewMode,
  selectedCustomer,
  selectedOpportunity,
  selectedAction,
  selectedRisk,
  selectedKnowledge,
  selectedSolution,
  itineraryViewMode,
  selectedItinerary,
}) {
  if (active === "customer") {
    if (customerViewMode === "create") {
      return { title: "新增客户" };
    }
    if (customerViewMode === "edit") {
      return { title: selectedCustomer ? `修改${selectedCustomer.name}` : "客户列表" };
    }
    if (customerViewMode === "detail") {
      return { title: selectedCustomer?.name ?? "客户列表" };
    }
    return { title: "客户列表" };
  }

  if (active === "opportunity") {
    if (opportunityViewMode === "create") {
      return { title: "新增商机" };
    }
    if (opportunityViewMode === "edit") {
      return { title: selectedOpportunity ? `修改${selectedOpportunity.name}` : "商机列表" };
    }
    if (opportunityViewMode === "detail") {
      return { title: selectedOpportunity?.name ?? "商机列表" };
    }
    return { title: "商机列表" };
  }

  if (active === "actions") {
    if (actionViewMode === "edit") {
      return { title: selectedAction ? `修改${selectedAction.title}` : "下一步动作列表" };
    }
    if (actionViewMode === "detail") {
      return { title: selectedAction?.title ?? "下一步动作列表" };
    }
    return { title: "下一步动作列表" };
  }

  if (active === "risk") {
    if (riskViewMode === "edit") {
      return { title: selectedRisk ? `修改${selectedRisk.title}` : "风险识别列表" };
    }
    if (riskViewMode === "detail") {
      return { title: selectedRisk?.title ?? "风险识别列表" };
    }
    return { title: "风险识别列表" };
  }

  if (active === "knowledge") {
    if (knowledgeViewMode === "create") {
      return { title: "新增知识材料" };
    }
    if (knowledgeViewMode === "edit") {
      return { title: selectedKnowledge ? `修改${selectedKnowledge.title || "知识材料"}` : "知识库材料列表" };
    }
    if (knowledgeViewMode === "detail") {
      return { title: selectedKnowledge?.title || "知识库材料列表" };
    }
    return { title: "知识库材料列表" };
  }

  if (active === "solution") {
    return { title: selectedSolution?.title ?? "历史方案" };
  }

  if (active === "itinerary") {
    if (itineraryViewMode === "new") return { title: "新建拜访行程" };
    if (itineraryViewMode === "edit") {
      return { title: selectedItinerary ? `修改${selectedItinerary.title}` : "智能拜访行程" };
    }
    if (itineraryViewMode === "detail") {
      return { title: selectedItinerary?.title ?? "智能拜访行程" };
    }
    return { title: "智能拜访行程" };
  }

  if (active === "hospital-tenders") {
    return { title: "医院招标监测" };
  }

  if (active === "settings") {
    return { title: "系统配置" };
  }

  return null;
}

function getBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function LoginScreen({ apiClient, onLogin }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const normalizedAccount = account.trim();
    if (!normalizedAccount || !password) {
      setError("请填写账号和密码");
      return;
    }
    if (!apiClient?.isEnabled) {
      setError("服务未连接，暂不能登录");
      return;
    }

    setIsSubmitting(true);
    try {
      const authenticated = await apiClient.login({
        account: normalizedAccount,
        password,
      });
      setError("");
      onLogin(createDisplaySession(authenticated));
    } catch (loginError) {
      setError(loginError?.status === 401 ? "账号或密码错误" : "登录失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="app-shell login-shell">
      <div className="login-window">
        <section className="login-brand-panel" aria-label="森特智行">
          <img className="login-logo" src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
          <div className="login-brand-copy">
            <span className="eyebrow">AI 销售作战台</span>
            <h1>登录工作台</h1>
          </div>
          <div className="login-signal-grid" aria-hidden="true">
            <span className="login-signal active">客户</span>
            <span className="login-signal">商机</span>
            <span className="login-signal">周报</span>
          </div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card-head">
            <span className="login-lock">
              <ShieldCheck size={24} />
            </span>
            <div>
              <span className="eyebrow">安全登录</span>
              <h2 id="login-title">进入系统</h2>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <label className="login-field">
              <span>账号</span>
              <div className="login-input">
                <UserRound size={18} />
                <input
                  aria-label="账号"
                  autoComplete="username"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="请输入账号"
                />
              </div>
            </label>

            <label className="login-field">
              <span>密码</span>
              <div className="login-input password-input">
                <LockKeyhole size={18} />
                <input
                  aria-label="密码"
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入密码"
                />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>

            {error ? <p className="login-error" role="alert">{error}</p> : null}

            <button className="primary-button login-submit" type="submit" data-testid="login-submit" disabled={isSubmitting}>
              <LogIn size={18} />
              {isSubmitting ? "登录中" : "登录"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function AuthCheckingScreen() {
  return (
    <main className="app-shell login-shell" data-testid="auth-checking">
      <div className="login-window">
        <section className="login-brand-panel" aria-label="森特智行">
          <img className="login-logo" src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
          <div className="login-brand-copy">
            <span className="eyebrow">AI 销售作战台</span>
            <h1>销售工作台</h1>
          </div>
        </section>
        <section className="login-card" aria-live="polite" role="status">
          <div className="login-card-head">
            <span className="login-lock">
              <ShieldCheck size={24} />
            </span>
            <div>
              <span className="eyebrow">安全登录</span>
              <h2>正在验证登录状态</h2>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function WorkbenchStatePanel({ status, errorMessage, onRetry, onCreateCustomer }) {
  if (status === "loading") {
    return (
      <section className="workbench-state-panel" data-testid="workbench-loading" role="status" aria-live="polite">
        <LoaderCircle className="state-spinner" size={28} />
        <strong>正在加载业务数据</strong>
        <p>客户、商机、动作、风险和知识记录正在从业务服务同步。</p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="workbench-state-panel error" data-testid="workbench-error" role="alert">
        <CircleAlert size={28} />
        <strong>业务数据加载失败</strong>
        <p>{errorMessage}</p>
        <button className="primary-button" type="button" data-testid="bootstrap-retry" onClick={onRetry}>
          <RefreshCw size={16} />
          重试
        </button>
      </section>
    );
  }

  if (status === "empty") {
    return (
      <section className="workbench-state-panel" data-testid="workbench-empty" role="status">
        <Database size={28} />
        <strong>暂无业务数据</strong>
        <p>当前数据库没有客户、商机、动作、风险或知识记录。</p>
        <button className="primary-button" type="button" onClick={onCreateCustomer}>
          <Plus size={16} />
          新增客户
        </button>
      </section>
    );
  }

  return null;
}

function EntityUnavailablePanel({ label, onBack }) {
  return (
    <section className="workbench-state-panel error" data-testid="route-entity-unavailable" role="alert">
      <CircleAlert size={28} />
      <strong>{label}不存在或已不可用</strong>
      <p>当前链接没有对应的有效业务记录，系统没有替换成其他记录。</p>
      <button className="ghost-button" type="button" onClick={onBack}>返回全部{label}</button>
    </section>
  );
}

const ROUTE_BY_ACTIVE = Object.freeze({
  overview: Object.freeze({ page: "overview", mode: "index" }),
  quick: Object.freeze({ page: "quick-records", mode: "new" }),
  customer: Object.freeze({ page: "customers", mode: "list" }),
  "hospital-tenders": Object.freeze({ page: "hospital-tenders", mode: "index" }),
  opportunity: Object.freeze({ page: "opportunities", mode: "list" }),
  actions: Object.freeze({ page: "actions", mode: "list" }),
  risk: Object.freeze({ page: "risks", mode: "list" }),
  kanban: Object.freeze({ page: "kanban", mode: "index" }),
  itinerary: Object.freeze({ page: "itineraries", mode: "list" }),
  expense: Object.freeze({ page: "travel-expenses", mode: "index" }),
  weekly: Object.freeze({ page: "weekly-reports", mode: "index" }),
  knowledge: Object.freeze({ page: "knowledge", mode: "list" }),
  settings: Object.freeze({ page: "settings/config", mode: "index" }),
  weixin: Object.freeze({ page: "settings/weixin", mode: "index" }),
  "settings-notifications": Object.freeze({ page: "settings/notifications", mode: "index" }),
  "settings-tender-schedule": Object.freeze({ page: "settings/tender-schedule", mode: "index" }),
  solution: Object.freeze({ page: "solutions", mode: "list" }),
});

const ACTIVE_BY_ROUTE_PAGE = Object.freeze({
  overview: "overview",
  "quick-records": "quick",
  customers: "customer",
  "hospital-tenders": "hospital-tenders",
  opportunities: "opportunity",
  actions: "actions",
  risks: "risk",
  kanban: "kanban",
  itineraries: "itinerary",
  "travel-expenses": "expense",
  "weekly-reports": "weekly",
  knowledge: "knowledge",
  "settings/config": "settings",
  "settings/weixin": "weixin",
  "settings/notifications": "settings-notifications",
  "settings/tender-schedule": "settings-tender-schedule",
  solutions: "solution",
});

const PARENT_NAV_BY_ACTIVE = Object.freeze({
  "hospital-tenders": "customer",
  actions: "opportunity",
  risk: "opportunity",
  kanban: "opportunity",
  weixin: "settings",
  "settings-notifications": "settings",
  "settings-tender-schedule": "settings",
});

function activeFromRoute(route) {
  return ACTIVE_BY_ROUTE_PAGE[route?.page] ?? "overview";
}

function routeFilterValue(route, key) {
  const value = route?.filters?.[key]?.[0];
  return typeof value === "string" && value ? value : null;
}

function editorModeFromRoute(route, page) {
  if (route?.page !== page) return "list";
  if (route.mode === "new") return page === "itineraries" ? "new" : "create";
  return ["list", "detail", "edit"].includes(route.mode) ? route.mode : "list";
}

export function App() {
  const [authPhase, setAuthPhase] = useState("checking");
  const [authSession, setAuthSession] = useState(null);
  const apiBaseUrl = resolveApiBaseUrl(import.meta.env);
  const apiClient = useMemo(
    () => createSalesWorkbenchApi({
      baseUrl: apiBaseUrl,
      onUnauthorized: () => {
        setAuthSession(null);
        setAuthPhase("anonymous");
      },
    }),
    [apiBaseUrl],
  );

  useEffect(() => {
    clearLegacyAuthSession(getBrowserStorage());
    if (!apiClient.isEnabled) {
      setAuthPhase("anonymous");
      return undefined;
    }

    let cancelled = false;
    apiClient
      .restoreSession()
      .then((session) => {
        if (cancelled) return;
        setAuthSession(createDisplaySession(session));
        setAuthPhase("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        apiClient.setSession(null);
        setAuthSession(null);
        setAuthPhase("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  function handleLogin(session) {
    setAuthSession(createDisplaySession(session));
    setAuthPhase("authenticated");
  }

  async function handleLogout() {
    try {
      await apiClient.logout();
    } catch {
      // Local session state must still be cleared when the network is unavailable.
    } finally {
      apiClient.setSession(null);
      setAuthSession(null);
      setAuthPhase("anonymous");
    }
  }

  if (authPhase === "checking") {
    return <AuthCheckingScreen />;
  }

  if (authPhase !== "authenticated" || !authSession) {
    return <LoginScreen apiClient={apiClient} onLogin={handleLogin} />;
  }

  return <SalesWorkbenchApp apiClient={apiClient} authSession={authSession} onLogout={handleLogout} />;
}

function SalesWorkbenchApp({ apiClient, authSession, onLogout }) {
  const initialRoute = useMemo(
    () => (typeof window === "undefined" ? null : parseWorkbenchRoute({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    })),
    [],
  );
  const [active, setActive] = useState(() => activeFromRoute(initialRoute));
  const [routeFilters, setRouteFilters] = useState(() => initialRoute?.filters ?? {});
  const [routeEntityId, setRouteEntityId] = useState(() => initialRoute?.entityId ?? null);
  const [workbenchState, setWorkbenchState] = useState(createLoadingWorkbenchState);
  const [backendStatus, setBackendStatus] = useState(apiClient.isEnabled ? "connecting" : "offline");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const bootstrapGenerationRef = useRef(0);
  const workspaceRef = useRef(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState(() => (
    ["customers", "hospital-tenders"].includes(initialRoute?.page) ? initialRoute?.entityId : null
  ));
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(() => (
    initialRoute?.page === "opportunities"
      ? initialRoute?.entityId
      : routeFilterValue(initialRoute, "opportunityId")
  ));
  const [selectedActionId, setSelectedActionId] = useState(() => (
    initialRoute?.page === "actions" ? initialRoute?.entityId : null
  ));
  const [selectedRiskId, setSelectedRiskId] = useState(() => (
    initialRoute?.page === "risks" ? initialRoute?.entityId : null
  ));
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState(() => (
    initialRoute?.page === "knowledge" ? initialRoute?.entityId ?? null : null
  ));
  const [selectedSolutionId, setSelectedSolutionId] = useState(() => (
    initialRoute?.page === "solutions" ? initialRoute?.entityId ?? null : null
  ));
  const [selectedItineraryId, setSelectedItineraryId] = useState(() => (
    initialRoute?.page === "itineraries" ? initialRoute?.entityId ?? null : null
  ));
  const [customerViewMode, setCustomerViewMode] = useState(() => editorModeFromRoute(initialRoute, "customers"));
  const [opportunityViewMode, setOpportunityViewMode] = useState(() => editorModeFromRoute(initialRoute, "opportunities"));
  const [actionViewMode, setActionViewMode] = useState(() => editorModeFromRoute(initialRoute, "actions"));
  const [riskViewMode, setRiskViewMode] = useState(() => editorModeFromRoute(initialRoute, "risks"));
  const [knowledgeViewMode, setKnowledgeViewMode] = useState(() => editorModeFromRoute(initialRoute, "knowledge"));
  const [itineraryViewMode, setItineraryViewMode] = useState(() => editorModeFromRoute(initialRoute, "itineraries"));
  const selectedCustomerIdRef = useRef(selectedCustomerId);
  const selectedOpportunityIdRef = useRef(selectedOpportunityId);
  const selectedActionIdRef = useRef(selectedActionId);
  const selectedRiskIdRef = useRef(selectedRiskId);
  const selectedKnowledgeIdRef = useRef(selectedKnowledgeId);
  const selectedItineraryIdRef = useRef(selectedItineraryId);
  const [recordMode, setRecordMode] = useState("voice");
  const [recordText, setRecordText] = useState("");
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [syncStatus, setSyncStatus] = useState("尚未写入任何业务档案");
  const [weeklyView, setWeeklyView] = useState("daily");
  const [weeklyDraft, setWeeklyDraft] = useState(null);
  const [weeklyDraftText, setWeeklyDraftText] = useState("");
  const {
    status: bootstrapStatus,
    customers: workbenchCustomers,
    opportunities: workbenchOpportunities,
    actions: workbenchActions,
    risks: workbenchRisks,
    knowledge: workbenchKnowledge,
    quickRecords: workbenchQuickRecords,
    solutionDocs: workbenchSolutionDocs,
    itineraries: workbenchItineraries,
    summary: overviewSummary,
    errorMessage: bootstrapErrorMessage,
  } = workbenchState;

  function updateWorkbenchCollection(key, nextValue) {
    setWorkbenchState((current) => normalizeBootstrapData({
      ...current,
      [key]: typeof nextValue === "function" ? nextValue(current[key]) : nextValue,
    }));
  }

  function setWorkbenchCustomers(nextValue) {
    updateWorkbenchCollection("customers", nextValue);
  }

  function applyWorkbenchRoute(route) {
    const nextActive = activeFromRoute(route);
    setActive(nextActive);
    setRouteFilters(route?.filters ?? {});
    setRouteEntityId(route?.entityId ?? null);

    if (route?.page === "customers") {
      setCustomerViewMode(editorModeFromRoute(route, "customers"));
      if (route.entityId) {
        selectedCustomerIdRef.current = route.entityId;
        setSelectedCustomerId(route.entityId);
      }
    } else if (route?.page === "hospital-tenders" && route.entityId) {
      selectedCustomerIdRef.current = route.entityId;
      setSelectedCustomerId(route.entityId);
    }

    if (route?.page === "opportunities") {
      setOpportunityViewMode(editorModeFromRoute(route, "opportunities"));
      if (route.entityId) {
        selectedOpportunityIdRef.current = route.entityId;
        setSelectedOpportunityId(route.entityId);
      }
    } else {
      const opportunityId = route.filters?.opportunityId?.[0] ?? null;
      if (opportunityId) {
        selectedOpportunityIdRef.current = opportunityId;
        setSelectedOpportunityId(opportunityId);
      }
    }

    if (route?.page === "actions") {
      setActionViewMode(editorModeFromRoute(route, "actions"));
      if (route.entityId) {
        selectedActionIdRef.current = route.entityId;
        setSelectedActionId(route.entityId);
      }
    }
    if (route?.page === "risks") {
      setRiskViewMode(editorModeFromRoute(route, "risks"));
      if (route.entityId) {
        selectedRiskIdRef.current = route.entityId;
        setSelectedRiskId(route.entityId);
      }
    }
    if (route?.page === "knowledge") {
      setKnowledgeViewMode(editorModeFromRoute(route, "knowledge"));
      if (route.entityId) {
        selectedKnowledgeIdRef.current = route.entityId;
        setSelectedKnowledgeId(route.entityId);
      }
    }
    if (route?.page === "itineraries") {
      setItineraryViewMode(editorModeFromRoute(route, "itineraries"));
      if (route.entityId) {
        selectedItineraryIdRef.current = route.entityId;
        setSelectedItineraryId(route.entityId);
      }
    }
    if (route?.page === "solutions" && route.entityId) {
      setSelectedSolutionId(route.entityId);
    }
  }

  function findContentElement() {
    if (typeof document === "undefined") return null;
    return workspaceRef.current?.querySelector?.(".content") ?? document.querySelector(".content");
  }

  function rememberContentScrollPosition() {
    if (typeof window === "undefined") return;
    const scrollTop = findContentElement()?.scrollTop ?? 0;
    const currentState = window.history.state;
    const nextState = currentState && typeof currentState === "object"
      ? { ...currentState, contentScrollTop: scrollTop }
      : { contentScrollTop: scrollTop };
    window.history.replaceState(nextState, "", `${window.location.pathname}${window.location.search}`);
  }

  function restoreContentScrollPosition(scrollTop) {
    if (typeof window === "undefined") return;
    const applyScroll = () => {
      const content = findContentElement();
      if (content) content.scrollTop = scrollTop;
    };
    if (typeof window.requestAnimationFrame !== "function") {
      applyScroll();
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(applyScroll));
  }

  function writeBrowserRoute(route, { replace = false } = {}) {
    if (typeof window === "undefined") return;
    const url = buildWorkbenchUrl(route);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const shouldReplace = replace || currentUrl === url;
    if (!shouldReplace) rememberContentScrollPosition();
    window.history[shouldReplace ? "replaceState" : "pushState"](route, "", url);
    if (!shouldReplace) restoreContentScrollPosition(0);
  }

  function navigateTo(nextActive, { filters = {}, entityId, mode } = {}) {
    const baseRoute = ROUTE_BY_ACTIVE[nextActive];
    if (!baseRoute) return;
    if (nextActive === "quick" && (mode ?? baseRoute.mode) !== "history") setRecordMode("voice");
    const route = {
      ...baseRoute,
      ...(mode ? { mode } : {}),
      ...(entityId ? { entityId } : {}),
      filters,
    };
    applyWorkbenchRoute(route);
    writeBrowserRoute(route);
  }

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (initialRoute?.replace) writeBrowserRoute(initialRoute, { replace: true });
    const onPopState = (event) => {
      const route = parseWorkbenchRoute({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      });
      applyWorkbenchRoute(route);
      if (route.replace) writeBrowserRoute(route, { replace: true });
      const restoredScrollTop = typeof event?.state?.contentScrollTop === "number"
        ? event.state.contentScrollTop
        : 0;
      restoreContentScrollPosition(restoredScrollTop);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    selectedCustomerIdRef.current = selectedCustomerId;
    selectedOpportunityIdRef.current = selectedOpportunityId;
    selectedActionIdRef.current = selectedActionId;
    selectedRiskIdRef.current = selectedRiskId;
    selectedKnowledgeIdRef.current = selectedKnowledgeId;
    selectedItineraryIdRef.current = selectedItineraryId;
  }, [selectedActionId, selectedCustomerId, selectedItineraryId, selectedKnowledgeId, selectedOpportunityId, selectedRiskId]);

  useEffect(() => {
    if (typeof window === "undefined" || !workspaceRef.current) return;
    const revealActiveNavigation = () => {
      if (!window.matchMedia?.("(max-width: 760px)").matches) return;
      const activeParent = PARENT_NAV_BY_ACTIVE[active] ?? active;
      const activeButton = [...workspaceRef.current.querySelectorAll(".sidebar .nav-item")]
        .find((button) => button.dataset.testid === `nav-${activeParent}`);
      activeButton?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    };
    revealActiveNavigation();
    window.addEventListener("resize", revealActiveNavigation);
    return () => window.removeEventListener("resize", revealActiveNavigation);
  }, [active]);

  function setWorkbenchOpportunities(nextValue) {
    updateWorkbenchCollection("opportunities", nextValue);
  }

  function setWorkbenchActions(nextValue) {
    updateWorkbenchCollection("actions", nextValue);
  }

  function setWorkbenchRisks(nextValue) {
    updateWorkbenchCollection("risks", nextValue);
  }

  function setWorkbenchKnowledge(nextValue) {
    updateWorkbenchCollection("knowledge", nextValue);
  }

  function setWorkbenchQuickRecords(nextValue) {
    updateWorkbenchCollection("quickRecords", nextValue);
  }

  function setWorkbenchItineraries(nextValue) {
    updateWorkbenchCollection("itineraries", nextValue);
  }

  function setOverviewSummary(nextValue) {
    setWorkbenchState((current) => ({
      ...current,
      summary: typeof nextValue === "function" ? nextValue(current.summary) : nextValue,
    }));
  }

  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++bootstrapGenerationRef.current;
    setWorkbenchState(createLoadingWorkbenchState());
    setBackendStatus("connecting");
    if (!apiClient.isEnabled) {
      setWorkbenchState(createErrorWorkbenchState(new Error("业务服务未配置，请联系管理员。")));
      setBackendStatus("offline");
      return () => controller.abort();
    }

    apiClient
      .loadBootstrap({ signal: controller.signal })
      .then((data) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        const nextState = normalizeBootstrapData(data);
        setWorkbenchState(nextState);
        setSelectedCustomerId((current) => (
          nextState.customers.some((item) => item.id === current) ? current : nextState.customers[0]?.id ?? null
        ));
        setSelectedOpportunityId((current) => (
          nextState.opportunities.some((item) => item.id === current) ? current : nextState.opportunities[0]?.id ?? null
        ));
        setSelectedActionId((current) => (
          nextState.actions.some((item) => item.id === current) ? current : nextState.actions[0]?.id ?? null
        ));
        setSelectedRiskId((current) => (
          nextState.risks.some((item) => item.id === current) ? current : nextState.risks[0]?.id ?? null
        ));
        setSelectedKnowledgeId((current) => (
          nextState.knowledge.some((item) => item.id === current) ? current : nextState.knowledge[0]?.id ?? null
        ));
        setSelectedSolutionId((current) => (
          nextState.solutionDocs.some((item) => item.id === current) ? current : nextState.solutionDocs[0]?.id ?? null
        ));
        setSelectedItineraryId((current) => (
          nextState.itineraries.some((item) => item.id === current) ? current : nextState.itineraries[0]?.id ?? null
        ));
        setBackendStatus("connected");
      })
      .catch((error) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        setWorkbenchState(createErrorWorkbenchState(error));
        setSelectedKnowledgeId(null);
        setSelectedSolutionId(null);
        setSelectedItineraryId(null);
        setBackendStatus("offline");
      });

    return () => controller.abort();
  }, [apiClient, bootstrapAttempt]);

  const activeParent = PARENT_NAV_BY_ACTIVE[active] ?? active;
  const activeMeta =
    navItems.find((item) => item.id === activeParent) ??
    compatibilityRouteMeta[active] ??
    navItems[0];
  const apiStatusLabel = {
    connecting: "连接中",
    connected: "在线",
    offline: "离线",
  }[backendStatus];

  const scopedOpportunityId = routeFilters?.opportunityId?.[0] ?? null;
  const scopedActions = scopedOpportunityId
    ? workbenchActions.filter((item) => item.opportunityId === scopedOpportunityId)
    : workbenchActions;
  const scopedRisks = scopedOpportunityId
    ? workbenchRisks.filter((item) => item.opportunityId === scopedOpportunityId)
    : workbenchRisks;
  const scopedOpportunities = scopedOpportunityId
    ? workbenchOpportunities.filter((item) => item.id === scopedOpportunityId)
    : workbenchOpportunities;
  const tenderCustomerId = active === "hospital-tenders" ? routeEntityId : null;
  const customerLookupId = active === "customer" && routeEntityId ? routeEntityId : selectedCustomerId;
  const opportunityLookupId = active === "opportunity" && routeEntityId
    ? routeEntityId
    : scopedOpportunityId ?? selectedOpportunityId;
  const actionLookupId = active === "actions" && routeEntityId ? routeEntityId : selectedActionId;
  const riskLookupId = active === "risk" && routeEntityId ? routeEntityId : selectedRiskId;
  const selectedCustomerRecord = workbenchCustomers.find((item) => item.id === customerLookupId) ?? null;
  const selectedOpportunityRecord = workbenchOpportunities.find((item) => item.id === opportunityLookupId) ?? null;
  const selectedActionRecord = scopedActions.find((item) => item.id === actionLookupId) ?? null;
  const selectedRiskRecord = scopedRisks.find((item) => item.id === riskLookupId) ?? null;
  const selectedCustomer = selectedCustomerRecord ?? (
    active !== "customer" || customerViewMode === "list" || customerViewMode === "create"
      ? workbenchCustomers[0]
      : null
  );
  const selectedOpportunity = selectedOpportunityRecord ?? (
    active !== "opportunity" || opportunityViewMode === "list" || opportunityViewMode === "create"
      ? workbenchOpportunities[0]
      : null
  );
  const selectedAction = selectedActionRecord ?? (
    active !== "actions" || actionViewMode === "list" ? scopedActions[0] : null
  );
  const selectedDoc = workbenchSolutionDocs.find((item) => item.id === selectedSolutionId) ?? workbenchSolutionDocs[0];
  const selectedRisk = selectedRiskRecord ?? (
    active !== "risk" || riskViewMode === "list" ? scopedRisks[0] : null
  );
  const knowledgeLookupId = active === "knowledge" && routeEntityId ? routeEntityId : selectedKnowledgeId;
  const selectedKnowledgeRecord = workbenchKnowledge.find((item) => item.id === knowledgeLookupId) ?? null;
  const selectedKnowledge = selectedKnowledgeRecord ?? (
    active !== "knowledge" || knowledgeViewMode === "list" || knowledgeViewMode === "create"
      ? workbenchKnowledge[0]
      : null
  );
  const itineraryLookupId = active === "itinerary" && routeEntityId ? routeEntityId : selectedItineraryId;
  const selectedItinerary =
    workbenchItineraries.find((item) => item.id === itineraryLookupId) ?? null;
  const headingContext = resolveHeadingContext({
    active,
    customerViewMode,
    opportunityViewMode,
    actionViewMode,
    riskViewMode,
    knowledgeViewMode,
    selectedCustomer,
    selectedOpportunity,
    selectedAction,
    selectedRisk,
    selectedKnowledge,
    selectedSolution: selectedDoc,
    itineraryViewMode,
    selectedItinerary,
  });
  const headingSubView = (() => {
    if (active === "customer") return customerViewMode !== "list";
    if (active === "opportunity") return opportunityViewMode !== "list";
    if (active === "actions") return actionViewMode !== "list";
    if (active === "risk") return riskViewMode !== "list";
    if (active === "knowledge") return knowledgeViewMode !== "list";
    if (active === "itinerary") return itineraryViewMode !== "list";
    return false;
  })();
  const avatarInitial = String(authSession?.displayName ?? authSession?.account ?? "继").trim().slice(0, 1) || "继";

  function selectCustomer(customerId) {
    selectedCustomerIdRef.current = customerId;
    setSelectedCustomerId(customerId);
  }

  function selectOpportunity(opportunityId) {
    selectedOpportunityIdRef.current = opportunityId;
    setSelectedOpportunityId(opportunityId);
  }

  function selectAction(actionId) {
    selectedActionIdRef.current = actionId;
    setSelectedActionId(actionId);
  }

  function selectRisk(riskId) {
    selectedRiskIdRef.current = riskId;
    setSelectedRiskId(riskId);
  }

  function selectKnowledge(knowledgeId) {
    selectedKnowledgeIdRef.current = knowledgeId;
    setSelectedKnowledgeId(knowledgeId);
  }

  function selectItinerary(itineraryId) {
    selectedItineraryIdRef.current = itineraryId;
    setSelectedItineraryId(itineraryId);
  }

  function changeCustomerViewMode(mode) {
    setCustomerViewMode(mode);
    const entityId = selectedCustomerIdRef.current;
    if (mode === "list") navigateTo("customer");
    else if (mode === "create") navigateTo("customer", { mode: "new" });
    else if (entityId) navigateTo("customer", { mode, entityId });
  }

  function changeOpportunityViewMode(mode) {
    setOpportunityViewMode(mode);
    const entityId = selectedOpportunityIdRef.current;
    if (mode === "list") navigateTo("opportunity");
    else if (mode === "create") navigateTo("opportunity", { mode: "new" });
    else if (entityId) navigateTo("opportunity", { mode, entityId });
  }

  function changeActionViewMode(mode) {
    setActionViewMode(mode);
    const entityId = selectedActionIdRef.current;
    if (mode === "list") navigateTo("actions", { filters: routeFilters });
    else if (entityId) navigateTo("actions", { mode, entityId, filters: routeFilters });
  }

  function changeRiskViewMode(mode) {
    setRiskViewMode(mode);
    const entityId = selectedRiskIdRef.current;
    if (mode === "list") navigateTo("risk", { filters: routeFilters });
    else if (entityId) navigateTo("risk", { mode, entityId, filters: routeFilters });
  }

  function changeKnowledgeViewMode(mode) {
    setKnowledgeViewMode(mode);
    const entityId = selectedKnowledgeIdRef.current;
    if (mode === "list") navigateTo("knowledge");
    else if (mode === "create") navigateTo("knowledge", { mode: "new" });
    else if (entityId) navigateTo("knowledge", { mode, entityId });
  }

  function openItineraryDetail(itineraryId) {
    if (!itineraryId) return;
    selectItinerary(itineraryId);
    navigateTo("itinerary", { mode: "detail", entityId: itineraryId });
  }

  function openItineraryCreate() {
    selectItinerary(null);
    navigateTo("itinerary", { mode: "new" });
  }

  function openItineraryList() {
    navigateTo("itinerary");
  }

  function openItineraryEdit() {
    const entityId = selectedItineraryIdRef.current;
    if (entityId) navigateTo("itinerary", { mode: "edit", entityId });
  }

  function openQuickHistoryRoute(recordId) {
    if (recordId) {
      navigateTo("quick", { mode: "history", entityId: recordId });
      return;
    }
    const route = { ...ROUTE_BY_ACTIVE.quick, filters: {} };
    applyWorkbenchRoute(route);
    writeBrowserRoute(route);
  }

  function openCustomerDetail(customerId) {
    if (!customerId) return;
    selectCustomer(customerId);
    navigateTo("customer", { mode: "detail", entityId: customerId });
  }

  function openOpportunityDetail(opportunityId) {
    if (!opportunityId) return;
    selectOpportunity(opportunityId);
    navigateTo("opportunity", { mode: "detail", entityId: opportunityId });
  }

  function openOpportunityList() {
    navigateTo("opportunity");
  }

  function openActionDetail(actionId) {
    if (!actionId) return;
    selectAction(actionId);
    navigateTo("actions", { mode: "detail", entityId: actionId, filters: routeFilters });
  }

  function openActionList() {
    navigateTo("actions");
  }

  function openRiskDetail(riskId) {
    if (!riskId) return;
    selectRisk(riskId);
    navigateTo("risk", { mode: "detail", entityId: riskId, filters: routeFilters });
  }

  function openRiskList() {
    navigateTo("risk");
  }

  async function refreshOverviewSummary() {
    if (!apiClient.isEnabled || backendStatus !== "connected") return;
    try {
      setOverviewSummary(await apiClient.getDashboardSummary());
    } catch {
      // Keep the last known summary visible when a dashboard-only refresh fails.
    }
  }

  function mergeById(items, item) {
    return mergeEntityByVersion(items, item);
  }

  function ensureBackend(operation) {
    assertBackendReady(
      { isEnabled: apiClient.isEnabled, status: backendStatus },
      operation,
    );
  }

  async function handleSaveCustomer(draft) {
    ensureBackend("保存客户");
    const currentEntity = draft.id ? workbenchCustomers.find((item) => item.id === draft.id) : null;
    const saved = await apiClient.saveCustomer(currentEntity ? { ...draft, version: currentEntity.version } : draft);
    setWorkbenchCustomers((current) => mergeById(current, saved));
    selectCustomer(saved.id);
    await refreshOverviewSummary();
    return saved;
  }

  async function handleSaveOpportunity(draft) {
    ensureBackend("保存商机");
    const currentEntity = draft.id ? workbenchOpportunities.find((item) => item.id === draft.id) : null;
    const saved = await apiClient.saveOpportunity(currentEntity ? { ...draft, version: currentEntity.version } : draft);
    setWorkbenchOpportunities((current) => mergeById(current, saved));
    selectOpportunity(saved.id);
    setWorkbenchCustomers((current) =>
      current.map((customer) => {
        if (customer.id !== saved.customerId) return customer;
        const opportunities = customer.opportunities?.includes(saved.name)
          ? customer.opportunities
          : [...(customer.opportunities ?? []), saved.name];
        return { ...customer, opportunities };
      }),
    );
    await refreshOverviewSummary();
    return saved;
  }

  async function handleSaveKnowledge(draft) {
    ensureBackend("保存知识材料");
    const currentEntity = draft.id ? workbenchKnowledge.find((item) => item.id === draft.id) : null;
    const saved = await apiClient.saveKnowledgeItem(currentEntity ? { ...draft, version: currentEntity.version } : draft);
    setWorkbenchKnowledge((current) => mergeById(current, saved));
    selectKnowledge(saved.id);
    return saved;
  }

  async function handleSearchKnowledge({ query: searchText, tags }) {
    ensureBackend("检索知识库");
    return apiClient.searchKnowledge({ query: searchText, tags, limit: 12 });
  }

  async function handleUpdateRiskStatus(id, patch) {
    ensureBackend("更新风险");
    const currentEntity = workbenchRisks.find((item) => item.id === id);
    const updated = await apiClient.updateRiskStatus(id, patch, currentEntity?.version);
    setWorkbenchRisks((current) => mergeById(current, updated));
    setSelectedRiskId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleUpdateActionStatus(id, patch) {
    ensureBackend("更新动作");
    const currentEntity = workbenchActions.find((item) => item.id === id);
    const updated = await apiClient.updateActionStatus(id, patch, currentEntity?.version);
    setWorkbenchActions((current) => mergeById(current, updated));
    setSelectedActionId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleDeleteCustomer(id) {
    ensureBackend("删除客户");
    const existing = workbenchCustomers.find((item) => item.id === id);
    const deleted = await apiClient.deleteCustomer(id, existing?.version);
    setWorkbenchCustomers((current) => removeEntityById(current, id));
    setWorkbenchOpportunities((current) => current.filter((item) => item.customerId !== id));
    setSelectedCustomerId((current) => current === id ? null : current);
    setSelectedOpportunityId(null);
    setCustomerViewMode("list");
    navigateTo("customer");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteOpportunity(id) {
    ensureBackend("删除商机");
    const existing = workbenchOpportunities.find((item) => item.id === id);
    const deleted = await apiClient.deleteOpportunity(id, existing?.version);
    const deletedName = deleted?.name ?? existing?.name;
    setWorkbenchOpportunities((current) => removeEntityById(current, id));
    setWorkbenchCustomers((current) =>
      current.map((customer) => ({
        ...customer,
        opportunities: deletedName
          ? (customer.opportunities ?? []).filter((name) => name !== deletedName)
          : customer.opportunities,
      })),
    );
    setSelectedOpportunityId((current) => current === id ? null : current);
    setOpportunityViewMode("list");
    navigateTo("opportunity");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteKnowledge(id) {
    ensureBackend("删除知识材料");
    const existing = workbenchKnowledge.find((item) => item.id === id);
    const deleted = await apiClient.deleteKnowledgeItem(id, existing?.version);
    setWorkbenchKnowledge((current) => removeEntityById(current, id));
    setSelectedKnowledgeId((current) => current === id ? null : current);
    setKnowledgeViewMode("list");
    return deleted ?? { id };
  }

  async function handleDeleteAction(id) {
    ensureBackend("删除动作");
    const existing = workbenchActions.find((item) => item.id === id);
    const deleted = await apiClient.deleteAction(id, existing?.version);
    setWorkbenchActions((current) => removeEntityById(current, id));
    setSelectedActionId((current) => current === id ? null : current);
    setActionViewMode("list");
    navigateTo("actions", { filters: routeFilters });
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteRisk(id) {
    ensureBackend("删除风险");
    const existing = workbenchRisks.find((item) => item.id === id);
    const deleted = await apiClient.deleteRisk(id, existing?.version);
    setWorkbenchRisks((current) => removeEntityById(current, id));
    setSelectedRiskId((current) => current === id ? null : current);
    setRiskViewMode("list");
    navigateTo("risk", { filters: routeFilters });
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleSaveItinerary(draft) {
    ensureBackend("保存拜访行程");
    const saved = await apiClient.saveVisitItinerary(draft);
    setWorkbenchItineraries((current) => mergeById(current, saved));
    selectItinerary(saved.id);
    navigateTo("itinerary", { mode: "detail", entityId: saved.id });
    return saved;
  }

  async function handleDeleteItinerary() {
    ensureBackend("删除拜访行程");
    if (!selectedItinerary) throw new Error("拜访行程不存在");
    const deleted = await apiClient.deleteVisitItinerary(
      selectedItinerary.id,
      selectedItinerary.version,
    );
    setWorkbenchItineraries((current) => removeEntityById(current, selectedItinerary.id));
    selectItinerary(null);
    navigateTo("itinerary");
    return deleted;
  }

  async function handleCiteKnowledge(target, knowledgeItem) {
    if (!knowledgeItem?.id) throw new Error("请选择要引用的知识材料");
    if (!apiClient.isEnabled || backendStatus !== "connected") {
      throw new Error("业务服务未连接，暂不能生成可追溯草稿");
    }
    if (!selectedCustomer?.id || !selectedOpportunity?.id) {
      throw new Error("请先选择客户和商机");
    }

    if (target === "weekly") {
      const { periodStart, periodEnd } = getCurrentWeekRange();
      const draft = await apiClient.generateWeeklyDraft({
        owner: "继振",
        periodStart,
        periodEnd,
        knowledgeIds: [knowledgeItem.id],
      });
      setWeeklyDraft(draft);
      setWeeklyDraftText(draft.content);
      setWeeklyView("summary");
      navigateTo("weekly");
      return draft;
    }

    throw new Error("未知引用目标");
  }

  function handleBusinessSync(result) {
    if (result.customer) {
      setWorkbenchCustomers((current) => mergeById(current, result.customer));
      setSelectedCustomerId(result.customer.id);
    }
    if (result.opportunity) {
      setWorkbenchOpportunities((current) => mergeById(current, result.opportunity));
      setSelectedOpportunityId(result.opportunity.id);
    }
    if (result.action) {
      setWorkbenchActions((current) => mergeById(current, result.action));
      setSelectedActionId(result.action.id);
    }
    if (result.risk) {
      setWorkbenchRisks((current) => mergeById(current, result.risk));
      setSelectedRiskId(result.risk.id);
    }
    void refreshOverviewSummary();
  }

  function handleConfirmationRefresh(refreshed) {
    setWorkbenchCustomers((current) =>
      (refreshed.customers ?? []).reduce((items, item) => mergeById(items, item), current));
    setWorkbenchOpportunities((current) =>
      (refreshed.opportunities ?? []).reduce((items, item) => mergeById(items, item), current));
  }

  const subnavItems = moduleSubnavItems[activeParent] ?? [];
  const customerContextId = tenderCustomerId ?? (
    active === "customer" && ["detail", "edit"].includes(customerViewMode)
      ? routeEntityId ?? selectedCustomerId
      : null
  );
  const opportunityContextId = scopedOpportunityId ?? (
    active === "opportunity" && ["detail", "edit"].includes(opportunityViewMode)
      ? routeEntityId ?? selectedOpportunityId
      : null
  );
  const subnavContextLabel = activeParent === "customer" && customerContextId
    ? `当前客户：${workbenchCustomers.find((item) => item.id === customerContextId)?.name ?? "记录不可用"}`
    : activeParent === "opportunity" && opportunityContextId
      ? `当前商机：${workbenchOpportunities.find((item) => item.id === opportunityContextId)?.name ?? "记录不可用"}`
      : "";

  function handleModuleSubnavNavigate(nextActive) {
    if (activeParent === "customer") {
      if (nextActive === "customer") {
        if (customerContextId) openCustomerDetail(customerContextId);
        else navigateTo("customer");
        return;
      }
      navigateTo("hospital-tenders", customerContextId ? { entityId: customerContextId } : {});
      return;
    }

    if (activeParent === "opportunity") {
      if (nextActive === "opportunity") {
        if (opportunityContextId) openOpportunityDetail(opportunityContextId);
        else navigateTo("opportunity");
        return;
      }
      const filters = opportunityContextId ? { opportunityId: [opportunityContextId] } : {};
      navigateTo(nextActive, { filters });
      return;
    }

    navigateTo(nextActive);
  }

  function clearModuleContext() {
    if (activeParent === "customer") {
      navigateTo(active === "hospital-tenders" ? "hospital-tenders" : "customer");
      return;
    }
    if (activeParent === "opportunity") {
      navigateTo(active === "opportunity" ? "opportunity" : active);
    }
  }

  const customerEntityUnavailable = active === "customer"
    && ["detail", "edit"].includes(customerViewMode)
    && !selectedCustomer;
  const opportunityEntityUnavailable = active === "opportunity"
    && ["detail", "edit"].includes(opportunityViewMode)
    && !selectedOpportunity;
  const actionEntityUnavailable = active === "actions"
    && ["detail", "edit"].includes(actionViewMode)
    && !selectedAction;
  const riskEntityUnavailable = active === "risk"
    && ["detail", "edit"].includes(riskViewMode)
    && !selectedRisk;
  const knowledgeEntityUnavailable = active === "knowledge"
    && ["detail", "edit"].includes(knowledgeViewMode)
    && !selectedKnowledge;
  const itineraryEntityUnavailable = active === "itinerary"
    && ["detail", "edit"].includes(itineraryViewMode)
    && !selectedItinerary;
  const customerContextUnavailable = Boolean(
    active === "hospital-tenders"
    && tenderCustomerId
    && !workbenchCustomers.some((item) => item.id === tenderCustomerId),
  );
  const opportunityContextUnavailable = Boolean(
    ["actions", "risk", "kanban"].includes(active)
    && scopedOpportunityId
    && scopedOpportunities.length === 0,
  );
  const settingsSection = {
    settings: "security",
    "settings-notifications": "notifications",
    "settings-tender-schedule": "tender-schedule",
  }[active] ?? "";

  const blockedByBootstrap = activeParent !== "settings" && (
    bootstrapStatus === "loading" ||
    bootstrapStatus === "error" ||
    (bootstrapStatus === "empty" && active === "overview")
  );
  const visibleBootstrapStatus =
    bootstrapStatus === "loading" || bootstrapStatus === "error" ? bootstrapStatus : "empty";

  return (
    <main className="app-shell">
      <div className="product-window">
        <header className="topbar">
          <div className="brand-area">
            <span className="brand-mark brand-logo-mark">
              <picture>
                <source media="(max-width: 430px)" srcSet="/sent-zhixing-icon.png" />
                <img src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
              </picture>
            </span>
          </div>
          <div className="top-actions">
            <span className={`api-status ${backendStatus}`} data-testid="api-status">
              {apiStatusLabel}
            </span>
            <button
              className="ghost-button"
              type="button"
              onClick={() => navigateTo("weekly")}
            >
              <FileText size={16} />
              周报
            </button>
            <button
              className="primary-button"
              type="button"
              data-testid="topbar-quick-record"
              onClick={() => navigateTo("quick")}
            >
              <Mic size={16} />
              快速记录
            </button>
            <button className="avatar avatar-button" type="button" onClick={onLogout} title="退出登录">
              {avatarInitial}
            </button>
          </div>
        </header>

        <div ref={workspaceRef} className="workspace">
          <aside className="sidebar">
            <div className="nav-kicker">工作区</div>
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`nav-item ${activeParent === item.id ? "active" : ""}`}
                  data-testid={`nav-${item.id}`}
                  aria-label={item.label}
                  title={item.label}
                  type="button"
                  onClick={() => {
                    if (item.id === "customer") setCustomerViewMode("list");
                    if (item.id === "opportunity") setOpportunityViewMode("list");
                    if (item.id === "knowledge") setKnowledgeViewMode("list");
                    if (item.id === "itinerary") setItineraryViewMode("list");
                    navigateTo(item.id);
                  }}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
            <div className="sidebar-foot">
              <div className="sidebar-foot-title">
                <Sparkles size={14} />
                AI 同步引擎
              </div>
              <div className="sidebar-foot-desc">服务状态 · {apiStatusLabel}</div>
            </div>
          </aside>

          <section
            className={`content ${active === "quick" ? "quick-content" : ""}`}
            data-testid={`page-${active}`}
            data-workbench-state={bootstrapStatus}
            data-settings-section={settingsSection || undefined}
          >
            <ModuleSubnav
              label={activeMeta.label}
              items={subnavItems}
              activeId={active}
              onNavigate={handleModuleSubnavNavigate}
              contextLabel={subnavContextLabel}
              onClearContext={subnavContextLabel ? clearModuleContext : undefined}
            />
            <PageHeading
              active={active}
              activeMeta={activeMeta}
              headingContext={headingContext}
              subView={headingSubView}
              action={null}
            />

            {blockedByBootstrap ? (
              <WorkbenchStatePanel
                status={visibleBootstrapStatus}
                errorMessage={bootstrapErrorMessage}
                onRetry={() => setBootstrapAttempt(incrementBootstrapAttempt)}
                onCreateCustomer={() => navigateTo("customer", { mode: "new" })}
              />
            ) : (
              <>
            {settingsSection && (
              <div className={`settings-section-view settings-section-${settingsSection}`}>
                <SystemSettingsPage
                  apiClient={apiClient}
                  backendStatus={backendStatus}
                  section={settingsSection}
                />
              </div>
            )}
            {active === "overview" && (
              <Overview
                actions={workbenchActions}
                customersList={workbenchCustomers}
                opportunitiesList={workbenchOpportunities}
                summary={overviewSummary}
                setActive={navigateTo}
                setSelectedActionId={setSelectedActionId}
                setSelectedCustomerId={setSelectedCustomerId}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openCustomerDetail={openCustomerDetail}
                openOpportunityDetail={openOpportunityDetail}
                openOpportunityList={openOpportunityList}
                openActionDetail={openActionDetail}
                openActionList={openActionList}
                openRiskList={openRiskList}
              />
            )}
            {active === "quick" && (
              <QuickRecord
                recordMode={recordMode}
                setRecordMode={setRecordMode}
                recordText={recordText}
                setRecordText={setRecordText}
                analysisVisible={analysisVisible}
                setAnalysisVisible={setAnalysisVisible}
                syncStatus={syncStatus}
                setSyncStatus={setSyncStatus}
                setActive={navigateTo}
                setSelectedCustomerId={setSelectedCustomerId}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openOpportunityDetail={openOpportunityDetail}
                onBusinessSync={handleBusinessSync}
                onQuickRecordSaved={(item) => setWorkbenchQuickRecords((current) => mergeById(current, item))}
                onConfirmationRefresh={handleConfirmationRefresh}
                apiClient={apiClient}
                backendStatus={backendStatus}
                customersList={workbenchCustomers}
                opportunitiesList={workbenchOpportunities}
                quickRecords={workbenchQuickRecords}
                routeHistoryId={routeEntityId}
                onHistoryRoute={openQuickHistoryRoute}
              />
            )}
            {active === "customer" && (
              customerEntityUnavailable ? (
                <EntityUnavailablePanel label="客户" onBack={() => navigateTo("customer")} />
              ) : <CustomerPage
                items={workbenchCustomers}
                selected={selectedCustomer}
                onSelect={selectCustomer}
                setActive={navigateTo}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openOpportunityDetail={openOpportunityDetail}
                onSaveCustomer={handleSaveCustomer}
                onDeleteCustomer={handleDeleteCustomer}
                opportunitiesList={workbenchOpportunities}
                viewMode={customerViewMode}
                setViewMode={changeCustomerViewMode}
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "opportunity" && (
              opportunityEntityUnavailable ? (
                <EntityUnavailablePanel label="商机" onBack={() => navigateTo("opportunity")} />
              ) : <OpportunityPage
                items={workbenchOpportunities}
                selected={selectedOpportunity}
                onSelect={selectOpportunity}
                setActive={navigateTo}
                setSelectedCustomerId={setSelectedCustomerId}
                viewMode={opportunityViewMode}
                setViewMode={changeOpportunityViewMode}
                customersList={workbenchCustomers}
                onSaveOpportunity={handleSaveOpportunity}
                onDeleteOpportunity={handleDeleteOpportunity}
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "actions" && (
              opportunityContextUnavailable || actionEntityUnavailable ? (
                <EntityUnavailablePanel label={opportunityContextUnavailable ? "商机" : "动作"} onBack={() => navigateTo("actions")} />
              ) : <ActionsPage
                items={scopedActions}
                selected={selectedAction}
                onSelect={selectAction}
                setActive={navigateTo}
                viewMode={actionViewMode}
                setViewMode={changeActionViewMode}
                onUpdateActionStatus={handleUpdateActionStatus}
                onDeleteAction={handleDeleteAction}
                backendStatus={backendStatus}
              />
            )}
            {active === "itinerary" && (
              itineraryEntityUnavailable ? (
                <EntityUnavailablePanel label="行程" onBack={() => navigateTo("itinerary")} />
              ) : <VisitItineraryPage
                items={workbenchItineraries}
                selected={selectedItinerary}
                customers={workbenchCustomers}
                viewMode={itineraryViewMode}
                onOpen={openItineraryDetail}
                onCreate={openItineraryCreate}
                onBack={openItineraryList}
                onEdit={openItineraryEdit}
                onSave={handleSaveItinerary}
                onDelete={handleDeleteItinerary}
              />
            )}
            {active === "expense" && (
              <TravelExpensePage
                apiClient={apiClient}
                backendStatus={backendStatus}
                customers={workbenchCustomers}
                itineraries={workbenchItineraries}
                owner={authSession.displayName}
              />
            )}
            {active === "solution" && (
              <SolutionPage
                selected={selectedDoc}
                onSelect={(id) => {
                  setSelectedSolutionId(id);
                  navigateTo("solution", { mode: "detail", entityId: id });
                }}
                solutionDocs={workbenchSolutionDocs}
              />
            )}
            {active === "weekly" && (
              <WeeklyPage
                weeklyView={weeklyView}
                setWeeklyView={setWeeklyView}
                apiClient={apiClient}
                backendStatus={backendStatus}
                weeklyDraft={weeklyDraft}
                setWeeklyDraft={setWeeklyDraft}
                weeklyDraftText={weeklyDraftText}
                setWeeklyDraftText={setWeeklyDraftText}
              />
            )}
            {active === "risk" && (
              opportunityContextUnavailable || riskEntityUnavailable ? (
                <EntityUnavailablePanel label={opportunityContextUnavailable ? "商机" : "风险"} onBack={() => navigateTo("risk")} />
              ) : <RiskPage
                items={scopedRisks}
                selected={selectedRisk}
                onSelect={selectRisk}
                viewMode={riskViewMode}
                setViewMode={changeRiskViewMode}
                onUpdateRiskStatus={handleUpdateRiskStatus}
                onDeleteRisk={handleDeleteRisk}
                backendStatus={backendStatus}
              />
            )}
            {active === "knowledge" && (
              knowledgeEntityUnavailable ? (
                <EntityUnavailablePanel label="知识" onBack={() => navigateTo("knowledge")} />
              ) : <KnowledgePage
                items={workbenchKnowledge}
                selected={selectedKnowledge}
                onSelect={selectKnowledge}
                viewMode={knowledgeViewMode}
                setViewMode={changeKnowledgeViewMode}
                onSaveKnowledge={handleSaveKnowledge}
                onDeleteKnowledge={handleDeleteKnowledge}
                onSearchKnowledge={handleSearchKnowledge}
                onCiteKnowledge={handleCiteKnowledge}
                customer={selectedCustomer}
                opportunity={selectedOpportunity}
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "kanban" && (
              opportunityContextUnavailable ? (
                <EntityUnavailablePanel label="商机" onBack={() => navigateTo("kanban")} />
              ) : <KanbanPage
                opportunitiesList={scopedOpportunities}
                setActive={navigateTo}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openOpportunityDetail={openOpportunityDetail}
                onSaveOpportunity={handleSaveOpportunity}
                backendStatus={backendStatus}
              />
            )}
            {active === "weixin" && (
              <WeixinBindingPage
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "hospital-tenders" && (
              customerContextUnavailable ? (
                <EntityUnavailablePanel label="客户" onBack={() => navigateTo("hospital-tenders")} />
              ) : <HospitalTenderPage
                apiClient={apiClient}
                backendStatus={backendStatus}
                customers={workbenchCustomers}
                customerId={tenderCustomerId}
                onSelectCustomer={(customerId) => openCustomerDetail(customerId)}
                onOpenSchedule={() => navigateTo("settings-tender-schedule")}
              />
            )}
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
