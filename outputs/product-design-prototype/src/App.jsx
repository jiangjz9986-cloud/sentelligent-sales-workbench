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
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createSalesWorkbenchApi,
  resolveApiBaseUrl,
} from "./api/salesWorkbenchApi.js";
import {
  clearLegacyAuthSession,
  createDisplaySession,
} from "./sessionAuth.js";
import {
  navItems,
  solutionDocs,
} from "./data/salesWorkbenchData.js";
import {
  createErrorWorkbenchState,
  createLoadingWorkbenchState,
  normalizeBootstrapData,
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
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(null);
  const [selectedActionId, setSelectedActionId] = useState(null);
  const [selectedDocId, setSelectedDocId] = useState(solutionDocs[0].id);
  const [selectedRiskId, setSelectedRiskId] = useState(null);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState(null);
  const [customerViewMode, setCustomerViewMode] = useState("list");
  const [opportunityViewMode, setOpportunityViewMode] = useState("list");
  const [actionViewMode, setActionViewMode] = useState("list");
  const [riskViewMode, setRiskViewMode] = useState("list");
  const [knowledgeViewMode, setKnowledgeViewMode] = useState("list");
  const [recordMode, setRecordMode] = useState("voice");
  const [recordText, setRecordText] = useState("");
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [syncStatus, setSyncStatus] = useState("尚未写入任何业务档案");
  const [weeklyView, setWeeklyView] = useState("daily");
  const [solutionDraft, setSolutionDraft] = useState(null);
  const [weeklyDraft, setWeeklyDraft] = useState(null);
  const [weeklyDraftText, setWeeklyDraftText] = useState("");
  const {
    status: bootstrapStatus,
    customers: workbenchCustomers,
    opportunities: workbenchOpportunities,
    actions: workbenchActions,
    risks: workbenchRisks,
    knowledge: workbenchKnowledge,
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

  function setOverviewSummary(nextValue) {
    setWorkbenchState((current) => ({
      ...current,
      summary: typeof nextValue === "function" ? nextValue(current.summary) : nextValue,
    }));
  }

  useEffect(() => {
    let cancelled = false;
    setWorkbenchState(createLoadingWorkbenchState());
    setBackendStatus("connecting");
    if (!apiClient.isEnabled) {
      setWorkbenchState(createErrorWorkbenchState(new Error("业务服务未配置，请联系管理员。")));
      setBackendStatus("offline");
      return () => {
        cancelled = true;
      };
    }

    apiClient
      .loadBootstrap()
      .then((data) => {
        if (cancelled) return;
        const nextState = normalizeBootstrapData(data);
        setWorkbenchState(nextState);
        setSelectedCustomerId(nextState.customers[0]?.id ?? null);
        setSelectedOpportunityId(nextState.opportunities[0]?.id ?? null);
        setSelectedActionId(nextState.actions[0]?.id ?? null);
        setSelectedRiskId(nextState.risks[0]?.id ?? null);
        setSelectedKnowledgeId(nextState.knowledge[0]?.id ?? null);
        setBackendStatus("connected");
      })
      .catch((error) => {
        if (cancelled) return;
        setWorkbenchState(createErrorWorkbenchState(error));
        setSelectedCustomerId(null);
        setSelectedOpportunityId(null);
        setSelectedActionId(null);
        setSelectedRiskId(null);
        setSelectedKnowledgeId(null);
        setBackendStatus("offline");
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, bootstrapAttempt]);

  const activeMeta = navItems.find((item) => item.id === active) ?? navItems[0];
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
  const selectedDoc = solutionDocs.find((item) => item.id === selectedDocId) ?? solutionDocs[0];
  const selectedRisk =
    workbenchRisks.find((item) => item.id === selectedRiskId) ?? workbenchRisks[0];
  const selectedKnowledge =
    workbenchKnowledge.find((item) => item.id === selectedKnowledgeId) ?? workbenchKnowledge[0];
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

  function makeLocalId(prefix) {
    return `${prefix}-${Date.now().toString(36)}`;
  }

  function normalizeLocalCustomer(draft) {
    const current = workbenchCustomers.find((item) => item.id === draft.id);
    return {
      id: draft.id ?? makeLocalId("customer"),
      name: "",
      region: "",
      type: "",
      level: "",
      owner: "继振",
      contact: "",
      relation: 40,
      stakeholders: [],
      decisionChain: [],
      historyProjects: [],
      infrastructure: [],
      syncPreview: [],
      budget: "",
      summary: "",
      needs: [],
      risks: [],
      opportunities: [],
      ...(current ?? {}),
      ...draft,
    };
  }

  function normalizeLocalOpportunity(draft) {
    const current = workbenchOpportunities.find((item) => item.id === draft.id);
    const customer = workbenchCustomers.find((item) => item.id === draft.customerId);
    return {
      id: draft.id ?? makeLocalId("opportunity"),
      customerId: draft.customerId ?? customer?.id ?? "",
      name: "",
      stage: "线索",
      amount: "待定",
      owner: "继振",
      probability: 30,
      days: 0,
      requirements: [],
      competitors: [],
      solutionDirection: [],
      sourceRecord: "手动维护",
      risk: "",
      next: "",
      tone: "blue",
      ...(current ?? {}),
      ...draft,
      customer: customer?.name ?? draft.customer ?? current?.customer ?? "",
    };
  }

  function normalizeLocalKnowledge(draft) {
    const current = workbenchKnowledge.find((item) => item.id === draft.id);
    const now = new Date().toISOString();
    return {
      id: draft.id ?? makeLocalId("knowledge"),
      title: "",
      category: "销售材料",
      tags: [],
      summary: "",
      content: "",
      source: "本地资料",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current ?? {}),
      ...draft,
    };
  }

  function normalizeLocalRisk(id, patch) {
    const current = workbenchRisks.find((item) => item.id === id);
    return {
      ...(current ?? {}),
      id,
      status: patch.status ?? current?.status ?? "open",
      action: patch.action ?? current?.action ?? "",
      assignee: patch.assignee ?? current?.assignee ?? "继振",
      due: patch.due ?? current?.due ?? "待确认",
      severity: patch.severity ?? current?.severity ?? "中",
      score: patch.score ?? current?.score ?? 60,
      tone: patch.tone ?? current?.tone ?? "amber",
      updatedAt: new Date().toISOString(),
    };
  }

  function normalizeLocalAction(id, patch) {
    const current = workbenchActions.find((item) => item.id === id);
    return {
      ...(current ?? {}),
      id,
      status: patch.status ?? current?.status ?? "pending",
      due: patch.due ?? current?.due ?? "待确认",
      assignee: patch.assignee ?? current?.assignee ?? "继振",
      priority: patch.priority ?? current?.priority ?? "中",
      tone: patch.tone ?? current?.tone ?? "blue",
      updatedAt: new Date().toISOString(),
    };
  }

  async function handleSaveCustomer(draft) {
    const currentEntity = draft.id ? workbenchCustomers.find((item) => item.id === draft.id) : null;
    const saved = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.saveCustomer(currentEntity ? { ...draft, version: currentEntity.version } : draft)
      : normalizeLocalCustomer(draft);
    setWorkbenchCustomers((current) => mergeById(current, saved));
    setSelectedCustomerId(saved.id);
    await refreshOverviewSummary();
    return saved;
  }

  async function handleSaveOpportunity(draft) {
    const currentEntity = draft.id ? workbenchOpportunities.find((item) => item.id === draft.id) : null;
    const saved = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.saveOpportunity(currentEntity ? { ...draft, version: currentEntity.version } : draft)
      : normalizeLocalOpportunity(draft);
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
    const currentEntity = draft.id ? workbenchKnowledge.find((item) => item.id === draft.id) : null;
    const saved = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.saveKnowledgeItem(currentEntity ? { ...draft, version: currentEntity.version } : draft)
      : normalizeLocalKnowledge(draft);
    setWorkbenchKnowledge((current) => mergeById(current, saved));
    setSelectedKnowledgeId(saved.id);
    return saved;
  }

  async function handleSearchKnowledge({ query: searchText, tags }) {
    if (apiClient.isEnabled && backendStatus === "connected") {
      return apiClient.searchKnowledge({ query: searchText, tags, limit: 12 });
    }
    const terms = String(searchText ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return workbenchKnowledge.filter((item) => {
      const haystack = [item.title, item.category, item.summary, item.content, ...(item.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term)) || (tags ?? []).some((tag) => item.tags?.includes(tag));
    });
  }

  async function handleUpdateRiskStatus(id, patch) {
    const currentEntity = workbenchRisks.find((item) => item.id === id);
    const updated = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.updateRiskStatus(id, patch, currentEntity?.version)
      : normalizeLocalRisk(id, patch);
    setWorkbenchRisks((current) => mergeById(current, updated));
    setSelectedRiskId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleUpdateActionStatus(id, patch) {
    const currentEntity = workbenchActions.find((item) => item.id === id);
    const updated = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.updateActionStatus(id, patch, currentEntity?.version)
      : normalizeLocalAction(id, patch);
    setWorkbenchActions((current) => mergeById(current, updated));
    setSelectedActionId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleDeleteCustomer(id) {
    const existing = workbenchCustomers.find((item) => item.id === id);
    const deleted = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.deleteCustomer(id, existing?.version)
      : existing;
    const remainingCustomers = workbenchCustomers.filter((item) => item.id !== id);
    setWorkbenchCustomers(remainingCustomers);
    setWorkbenchOpportunities((current) => current.filter((item) => item.customerId !== id));
    if (selectedCustomerId === id) {
      setSelectedCustomerId(remainingCustomers[0]?.id ?? null);
    }
    setCustomerViewMode("list");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteOpportunity(id) {
    const existing = workbenchOpportunities.find((item) => item.id === id);
    const deleted = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.deleteOpportunity(id, existing?.version)
      : existing;
    const deletedName = deleted?.name ?? existing?.name;
    const remainingOpportunities = workbenchOpportunities.filter((item) => item.id !== id);
    setWorkbenchOpportunities(remainingOpportunities);
    setWorkbenchCustomers((current) =>
      current.map((customer) => ({
        ...customer,
        opportunities: deletedName
          ? (customer.opportunities ?? []).filter((name) => name !== deletedName)
          : customer.opportunities,
      })),
    );
    if (selectedOpportunityId === id) {
      setSelectedOpportunityId(remainingOpportunities[0]?.id ?? null);
    }
    setOpportunityViewMode("list");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteKnowledge(id) {
    const existing = workbenchKnowledge.find((item) => item.id === id);
    const deleted = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.deleteKnowledgeItem(id, existing?.version)
      : existing;
    const remainingKnowledge = workbenchKnowledge.filter((item) => item.id !== id);
    setWorkbenchKnowledge(remainingKnowledge);
    if (selectedKnowledgeId === id) {
      setSelectedKnowledgeId(remainingKnowledge[0]?.id ?? null);
    }
    setKnowledgeViewMode("list");
    return deleted ?? { id };
  }

  async function handleDeleteAction(id) {
    const existing = workbenchActions.find((item) => item.id === id);
    const deleted = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.deleteAction(id, existing?.version)
      : existing;
    const remainingActions = workbenchActions.filter((item) => item.id !== id);
    setWorkbenchActions(remainingActions);
    if (selectedActionId === id) {
      setSelectedActionId(remainingActions[0]?.id ?? null);
    }
    setActionViewMode("list");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleDeleteRisk(id) {
    const existing = workbenchRisks.find((item) => item.id === id);
    const deleted = apiClient.isEnabled && backendStatus === "connected"
      ? await apiClient.deleteRisk(id, existing?.version)
      : existing;
    const remainingRisks = workbenchRisks.filter((item) => item.id !== id);
    setWorkbenchRisks(remainingRisks);
    if (selectedRiskId === id) {
      setSelectedRiskId(remainingRisks[0]?.id ?? null);
    }
    setRiskViewMode("list");
    await refreshOverviewSummary();
    return deleted ?? { id };
  }

  async function handleCiteKnowledge(target, knowledgeItem) {
    if (!knowledgeItem?.id) throw new Error("请选择要引用的知识材料");
    if (!apiClient.isEnabled || backendStatus !== "connected") {
      throw new Error("业务服务未连接，暂不能生成可追溯草稿");
    }
    if (!selectedCustomer?.id || !selectedOpportunity?.id) {
      throw new Error("请先选择客户和商机");
    }

    if (target === "solution") {
      const draft = await apiClient.generateSolutionDraft({
        owner: "继振",
        customerId: selectedCustomer.id,
        opportunityId: selectedOpportunity.id,
        knowledgeIds: [knowledgeItem.id],
      });
      setSolutionDraft(draft);
      setSelectedDocId(solutionDocs[0].id);
      setActive("solution");
      return draft;
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
    (bootstrapStatus === "empty" && (active === "overview" || active === "solution")) ||
    (active === "solution" && (!selectedCustomer || !selectedOpportunity));
  const visibleBootstrapStatus =
    bootstrapStatus === "loading" || bootstrapStatus === "error" ? bootstrapStatus : "empty";

  return (
    <main className="app-shell">
      <div className="product-window">
        <header className="topbar">
          <div className="brand-area">
            <span className="brand-mark brand-logo-mark">
              <img src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
            </span>
          </div>
          <div className="top-actions">
            <span className={`api-status ${backendStatus}`} data-testid="api-status">
              {apiStatusLabel}
            </span>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setActive("weekly")}
            >
              <FileText size={16} />
              周报
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => setActive("quick")}
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
                  type="button"
                  onClick={() => {
                    if (item.id === "customer") setCustomerViewMode("list");
                    if (item.id === "opportunity") setOpportunityViewMode("list");
                    if (item.id === "actions") setActionViewMode("list");
                    if (item.id === "risk") setRiskViewMode("list");
                    if (item.id === "knowledge") setKnowledgeViewMode("list");
                    setActive(item.id);
                  }}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
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
                onRetry={() => setBootstrapAttempt((current) => current + 1)}
                onCreateCustomer={() => {
                  setCustomerViewMode("create");
                  setActive("customer");
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
                setActive={setActive}
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
                setActive={setActive}
                setSelectedCustomerId={setSelectedCustomerId}
                setSelectedOpportunityId={setSelectedOpportunityId}
                openOpportunityDetail={openOpportunityDetail}
                onBusinessSync={handleBusinessSync}
                onConfirmationRefresh={handleConfirmationRefresh}
                apiClient={apiClient}
                backendStatus={backendStatus}
                customersList={workbenchCustomers}
                opportunitiesList={workbenchOpportunities}
              />
            )}
            {active === "customer" && (
              <CustomerPage
                items={workbenchCustomers}
                selected={selectedCustomer}
                onSelect={setSelectedCustomerId}
                setActive={setActive}
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
                setActive={setActive}
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
                setActive={setActive}
                viewMode={actionViewMode}
                setViewMode={setActionViewMode}
                onUpdateActionStatus={handleUpdateActionStatus}
                onDeleteAction={handleDeleteAction}
                backendStatus={backendStatus}
              />
            )}
            {active === "solution" && (
              <SolutionPage
                selected={selectedDoc}
                onSelect={setSelectedDocId}
                customer={selectedCustomer}
                opportunity={selectedOpportunity}
                apiClient={apiClient}
                backendStatus={backendStatus}
                draft={solutionDraft}
                setDraft={setSolutionDraft}
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
                setActive={setActive}
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
