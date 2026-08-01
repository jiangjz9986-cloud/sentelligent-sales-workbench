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
  const [active, setActive] = useState("overview");
  const [workbenchState, setWorkbenchState] = useState(createLoadingWorkbenchState);
  const [backendStatus, setBackendStatus] = useState(apiClient.isEnabled ? "connecting" : "offline");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const bootstrapGenerationRef = useRef(0);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(null);
  const [selectedActionId, setSelectedActionId] = useState(null);
  const [selectedRiskId, setSelectedRiskId] = useState(null);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState(null);
  const [selectedSolutionId, setSelectedSolutionId] = useState(null);
  const [selectedItineraryId, setSelectedItineraryId] = useState(null);
  const [customerViewMode, setCustomerViewMode] = useState("list");
  const [opportunityViewMode, setOpportunityViewMode] = useState("list");
  const [actionViewMode, setActionViewMode] = useState("list");
  const [riskViewMode, setRiskViewMode] = useState("list");
  const [knowledgeViewMode, setKnowledgeViewMode] = useState("list");
  const [itineraryViewMode, setItineraryViewMode] = useState("list");
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

  function navigateTo(nextActive) {
    if (nextActive === "quick") setRecordMode("voice");
    setActive(nextActive);
  }

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
        setSelectedCustomerId(nextState.customers[0]?.id ?? null);
        setSelectedOpportunityId(nextState.opportunities[0]?.id ?? null);
        setSelectedActionId(nextState.actions[0]?.id ?? null);
        setSelectedRiskId(nextState.risks[0]?.id ?? null);
        setSelectedKnowledgeId(nextState.knowledge[0]?.id ?? null);
        setSelectedSolutionId(nextState.solutionDocs[0]?.id ?? null);
        setSelectedItineraryId(nextState.itineraries[0]?.id ?? null);
        setBackendStatus("connected");
      })
      .catch((error) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        setWorkbenchState(createErrorWorkbenchState(error));
        setSelectedCustomerId(null);
        setSelectedOpportunityId(null);
        setSelectedActionId(null);
        setSelectedRiskId(null);
        setSelectedKnowledgeId(null);
        setSelectedSolutionId(null);
        setSelectedItineraryId(null);
        setBackendStatus("offline");
      });

    return () => controller.abort();
  }, [apiClient, bootstrapAttempt]);

  const activeMeta =
    navItems.find((item) => item.id === active) ??
    compatibilityRouteMeta[active] ??
    navItems[0];
  const apiStatusLabel = {
    connecting: "连接中",
    connected: "在线",
    offline: "离线",
  }[backendStatus];

  const selectedCustomer =
    workbenchCustomers.find((item) => item.id === selectedCustomerId) ?? workbenchCustomers[0];
  const selectedOpportunity =
    workbenchOpportunities.find((item) => item.id === selectedOpportunityId) ?? workbenchOpportunities[0];
  const selectedAction =
    workbenchActions.find((item) => item.id === selectedActionId) ?? workbenchActions[0];
  const selectedDoc = workbenchSolutionDocs.find((item) => item.id === selectedSolutionId) ?? workbenchSolutionDocs[0];
  const selectedRisk =
    workbenchRisks.find((item) => item.id === selectedRiskId) ?? workbenchRisks[0];
  const selectedKnowledge =
    workbenchKnowledge.find((item) => item.id === selectedKnowledgeId) ?? workbenchKnowledge[0];
  const selectedItinerary =
    workbenchItineraries.find((item) => item.id === selectedItineraryId) ?? null;
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
  const headingAction = (() => {
    if (active === "customer" && customerViewMode === "list") {
      return (
        <button
          className="primary-button"
          type="button"
          data-testid="customer-create-detail"
          onClick={() => setCustomerViewMode("create")}
        >
          <Plus size={16} />
          新增客户
        </button>
      );
    }

    if (active === "opportunity" && opportunityViewMode === "list") {
      return (
        <button
          className="primary-button"
          type="button"
          data-testid="opportunity-create-detail"
          onClick={() => setOpportunityViewMode("create")}
        >
          <Plus size={16} />
          新增商机
        </button>
      );
    }

    if (active === "knowledge" && knowledgeViewMode === "list") {
      return (
        <button
          className="primary-button"
          type="button"
          data-testid="knowledge-create-detail"
          onClick={() => setKnowledgeViewMode("create")}
        >
          <Plus size={16} />
          新增知识
        </button>
      );
    }

    if (active === "itinerary" && itineraryViewMode === "list") {
      return (
        <button
          className="primary-button"
          type="button"
          data-testid="itinerary-create-detail"
          onClick={() => {
            setSelectedItineraryId(null);
            setItineraryViewMode("new");
          }}
        >
          <Plus size={16} />
          新建行程
        </button>
      );
    }

    return null;
  })();
  const avatarInitial = String(authSession?.displayName ?? authSession?.account ?? "继").trim().slice(0, 1) || "继";

  function openCustomerDetail(customerId) {
    if (customerId) setSelectedCustomerId(customerId);
    setCustomerViewMode("detail");
    setActive("customer");
  }

  function openOpportunityDetail(opportunityId) {
    if (opportunityId) setSelectedOpportunityId(opportunityId);
    setOpportunityViewMode("detail");
    setActive("opportunity");
  }

  function openOpportunityList() {
    setOpportunityViewMode("list");
    setActive("opportunity");
  }

  function openActionDetail(actionId) {
    if (actionId) setSelectedActionId(actionId);
    setActionViewMode("detail");
    setActive("actions");
  }

  function openActionList() {
    setActionViewMode("list");
    setActive("actions");
  }

  function openRiskDetail(riskId) {
    if (riskId) setSelectedRiskId(riskId);
    setRiskViewMode("detail");
    setActive("risk");
  }

  function openRiskList() {
    setRiskViewMode("list");
    setActive("risk");
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
    setSelectedCustomerId(saved.id);
    await refreshOverviewSummary();
    return saved;
  }

  async function handleSaveOpportunity(draft) {
    ensureBackend("保存商机");
    const currentEntity = draft.id ? workbenchOpportunities.find((item) => item.id === draft.id) : null;
    const saved = await apiClient.saveOpportunity(currentEntity ? { ...draft, version: currentEntity.version } : draft);
    setWorkbenchOpportunities((current) => mergeById(current, saved));
    setSelectedOpportunityId(saved.id);
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
    setSelectedKnowledgeId(saved.id);
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
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleSaveItinerary(draft) {
    ensureBackend("保存拜访行程");
    const saved = await apiClient.saveVisitItinerary(draft);
    setWorkbenchItineraries((current) => mergeById(current, saved));
    setSelectedItineraryId(saved.id);
    setItineraryViewMode("detail");
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
    setSelectedItineraryId(null);
    setItineraryViewMode("list");
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
      setActive("weekly");
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

  const blockedByBootstrap =
    bootstrapStatus === "loading" ||
    bootstrapStatus === "error" ||
    (bootstrapStatus === "empty" && active === "overview");
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

        <div className="workspace">
          <aside className="sidebar">
            <div className="nav-kicker">工作区</div>
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`nav-item ${active === item.id ? "active" : ""}`}
                  data-testid={`nav-${item.id}`}
                  type="button"
                  onClick={() => {
                    if (item.id === "customer") setCustomerViewMode("list");
                    if (item.id === "opportunity") setOpportunityViewMode("list");
                    if (item.id === "actions") setActionViewMode("list");
                    if (item.id === "risk") setRiskViewMode("list");
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
          >
            <PageHeading
              active={active}
              activeMeta={activeMeta}
              headingContext={headingContext}
              action={bootstrapStatus === "loading" || bootstrapStatus === "error" ? null : headingAction}
            />

            {blockedByBootstrap ? (
              <WorkbenchStatePanel
                status={visibleBootstrapStatus}
                errorMessage={bootstrapErrorMessage}
                onRetry={() => setBootstrapAttempt(incrementBootstrapAttempt)}
                onCreateCustomer={() => {
                  setCustomerViewMode("create");
                  navigateTo("customer");
                }}
              />
            ) : (
              <>
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
              />
            )}
            {active === "customer" && (
              <CustomerPage
                items={workbenchCustomers}
                selected={selectedCustomer}
                onSelect={setSelectedCustomerId}
                setActive={navigateTo}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openOpportunityDetail={openOpportunityDetail}
                onSaveCustomer={handleSaveCustomer}
                onDeleteCustomer={handleDeleteCustomer}
                opportunitiesList={workbenchOpportunities}
                viewMode={customerViewMode}
                setViewMode={setCustomerViewMode}
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "opportunity" && (
              <OpportunityPage
                items={workbenchOpportunities}
                selected={selectedOpportunity}
                onSelect={setSelectedOpportunityId}
                setActive={navigateTo}
                setSelectedCustomerId={setSelectedCustomerId}
                viewMode={opportunityViewMode}
                setViewMode={setOpportunityViewMode}
                customersList={workbenchCustomers}
                onSaveOpportunity={handleSaveOpportunity}
                onDeleteOpportunity={handleDeleteOpportunity}
                apiClient={apiClient}
                backendStatus={backendStatus}
              />
            )}
            {active === "actions" && (
              <ActionsPage
                items={workbenchActions}
                selected={selectedAction}
                onSelect={setSelectedActionId}
                setActive={navigateTo}
                viewMode={actionViewMode}
                setViewMode={setActionViewMode}
                onUpdateActionStatus={handleUpdateActionStatus}
                onDeleteAction={handleDeleteAction}
                backendStatus={backendStatus}
              />
            )}
            {active === "itinerary" && (
              <VisitItineraryPage
                items={workbenchItineraries}
                selected={selectedItinerary}
                customers={workbenchCustomers}
                viewMode={itineraryViewMode}
                onOpen={(id) => {
                  setSelectedItineraryId(id);
                  setItineraryViewMode("detail");
                }}
                onBack={() => setItineraryViewMode("list")}
                onEdit={() => setItineraryViewMode("edit")}
                onSave={handleSaveItinerary}
                onDelete={handleDeleteItinerary}
              />
            )}
            {active === "solution" && (
              <SolutionPage
                selected={selectedDoc}
                onSelect={setSelectedSolutionId}
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
              <RiskPage
                items={workbenchRisks}
                selected={selectedRisk}
                onSelect={setSelectedRiskId}
                viewMode={riskViewMode}
                setViewMode={setRiskViewMode}
                onUpdateRiskStatus={handleUpdateRiskStatus}
                onDeleteRisk={handleDeleteRisk}
                backendStatus={backendStatus}
              />
            )}
            {active === "knowledge" && (
              <KnowledgePage
                items={workbenchKnowledge}
                selected={selectedKnowledge}
                onSelect={setSelectedKnowledgeId}
                viewMode={knowledgeViewMode}
                setViewMode={setKnowledgeViewMode}
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
              <KanbanPage
                opportunitiesList={workbenchOpportunities}
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
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
