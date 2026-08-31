import {
  CircleAlert,
  Database,
  FileText,
  LoaderCircle,
  Mic,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  compatibilityRouteMeta,
  moduleSubnavItems,
  navItems,
} from "../data/salesWorkbenchData.js";
import { incrementBootstrapAttempt } from "./workbenchState.js";
import { mergeEntityByVersion } from "../quickRecordModel.js";
import { expenseDraftFromFilters } from "../features/visitItinerary/itineraryExpenseLink.js";
import { Overview } from "../features/salesWorkbench/pages/OverviewPage.jsx";
import { PageHeading } from "../features/salesWorkbench/pages/PageHeading.jsx";
import { AvatarMenu } from "../components/AvatarMenu.jsx";
import { MobileShell } from "../components/MobileShell.jsx";
import { PullToRefresh } from "../components/PullToRefresh.jsx";
import { ToastProvider, useToast } from "../components/toast.jsx";
import { AssistantChatPanel } from "../components/assistant/AssistantChatPanel.jsx";
import { useAssistantChat } from "./useAssistantChat.js";
import { ModuleSubnav } from "../components/ModuleSubnav.jsx";
import {
  NavigationProvider,
  useWorkbenchNavigation,
} from "./useWorkbenchNavigation.jsx";
import { WorkbenchDataProvider, useWorkbenchDataState } from "./useWorkbenchData.jsx";
import { WorkbenchActionsProvider, useWorkbenchHandlers } from "./useWorkbenchHandlers.jsx";
import {
  QuickRecordSessionProvider,
  useQuickRecordSessionState,
} from "./useQuickRecordSession.jsx";
import { WeeklySessionProvider, useWeeklySessionState } from "./useWeeklySession.jsx";
import { useMobileShellEnabled } from "./useMobileShellEnabled.js";
import { useNotificationBadges } from "./useNotificationBadges.js";
import { useServiceWorkerUpdate } from "./useServiceWorkerUpdate.js";
import { PARENT_NAV_BY_ACTIVE, SETTINGS_SECTION_BY_ACTIVE } from "./navRoutes.js";
import { parseWorkbenchRoute } from "./routes.js";

const QuickRecord = lazy(() => import("../features/salesWorkbench/pages/QuickRecordPage.jsx").then((m) => ({ default: m.QuickRecord })));
const CustomerPage = lazy(() => import("../features/salesWorkbench/pages/CustomerPage.jsx").then((m) => ({ default: m.CustomerPage })));
const OpportunityPage = lazy(() => import("../features/salesWorkbench/pages/OpportunityPage.jsx").then((m) => ({ default: m.OpportunityPage })));
const ActionsPage = lazy(() => import("../features/salesWorkbench/pages/ActionsPage.jsx").then((m) => ({ default: m.ActionsPage })));
const RiskPage = lazy(() => import("../features/salesWorkbench/pages/RiskPage.jsx").then((m) => ({ default: m.RiskPage })));
const KanbanPage = lazy(() => import("../features/salesWorkbench/pages/KanbanPage.jsx").then((m) => ({ default: m.KanbanPage })));
const KnowledgePage = lazy(() => import("../features/salesWorkbench/pages/KnowledgePage.jsx").then((m) => ({ default: m.KnowledgePage })));
const WeeklyPage = lazy(() => import("../features/salesWorkbench/pages/WeeklyPage.jsx").then((m) => ({ default: m.WeeklyPage })));
const SolutionPage = lazy(() => import("../features/salesWorkbench/pages/SolutionPage.jsx").then((m) => ({ default: m.SolutionPage })));
const WeixinBindingPage = lazy(() => import("../features/salesWorkbench/pages/WeixinBindingPage.jsx").then((m) => ({ default: m.WeixinBindingPage })));
const VisitItineraryPage = lazy(() => import("../features/visitItinerary/VisitItineraryPage.jsx").then((m) => ({ default: m.VisitItineraryPage })));
const TravelExpensePage = lazy(() => import("../features/travelExpense/TravelExpensePage.jsx").then((m) => ({ default: m.TravelExpensePage })));
const HospitalTenderPage = lazy(() => import("../features/hospitalTender/HospitalTenderPage.jsx").then((m) => ({ default: m.HospitalTenderPage })));
const SystemSettingsPage = lazy(() => import("../features/settings/SystemSettingsPage.jsx").then((m) => ({ default: m.SystemSettingsPage })));
const UserManagementPage = lazy(() => import("../features/settings/UserManagementPage.jsx").then((m) => ({ default: m.UserManagementPage })));

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

function RouteChunkFallback() {
  return (
    <section className="workbench-state-panel" data-testid="route-chunk-loading" role="status" aria-live="polite">
      <LoaderCircle className="state-spinner" size={28} />
      <strong>正在打开页面</strong>
    </section>
  );
}

class RouteChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    const message = String(error?.message ?? "");
    if (!/ChunkLoadError|Failed to fetch dynamically imported module/i.test(message)) return;
    if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("chunk_reload_guard")) return;
    const failedUrl = error?.request ?? error?.filename ?? "";
    const attemptReload = async () => {
      if (failedUrl && typeof caches !== "undefined") {
        const cached = await caches.match(failedUrl);
        if (cached) return;
      }
      sessionStorage.setItem("chunk_reload_guard", "1");
      window.location.reload();
    };
    attemptReload().catch(() => {});
  }
  render() {
    if (this.state.hasError) {
      return (
        <section className="workbench-state-panel error" data-testid="route-chunk-error" role="alert">
          <CircleAlert size={28} />
          <strong>页面加载失败</strong>
          <p>网络连接可能已中断，请恢复网络后重新加载。</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            <RefreshCw size={16} />
            重新加载
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

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
    if (actionViewMode === "create") {
      return { title: "新增待办" };
    }
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

function formatRelativeSnapshotTime(savedAt) {
  if (!savedAt) return "";
  const minutes = Math.max(1, Math.round((Date.now() - savedAt) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function WorkbenchShellBody({
  apiClient,
  authSession,
  onLogout,
}) {
  const initialRoute = useMemo(
    () => (typeof window === "undefined" ? null : parseWorkbenchRoute({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    })),
    [],
  );
  const quickSession = useQuickRecordSessionState();
  const weeklySession = useWeeklySessionState();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const nav = useWorkbenchNavigation({
    initialRoute,
    onEnterQuick: () => quickSession.setRecordMode("voice"),
  });
  const handleBootstrapSelectionReset = useCallback((nextState) => {
    if (!nextState) {
      nav.setSelectedKnowledgeId(null);
      nav.setSelectedSolutionId(null);
      nav.setSelectedItineraryId(null);
      return;
    }
    nav.setSelectedCustomerId((current) => (
      nextState.customers.some((item) => item.id === current) ? current : nextState.customers[0]?.id ?? null
    ));
    nav.setSelectedOpportunityId((current) => (
      nextState.opportunities.some((item) => item.id === current) ? current : nextState.opportunities[0]?.id ?? null
    ));
    nav.setSelectedActionId((current) => (
      nextState.actions.some((item) => item.id === current) ? current : nextState.actions[0]?.id ?? null
    ));
    nav.setSelectedRiskId((current) => (
      nextState.risks.some((item) => item.id === current) ? current : nextState.risks[0]?.id ?? null
    ));
    nav.setSelectedKnowledgeId((current) => (
      nextState.knowledge.some((item) => item.id === current) ? current : nextState.knowledge[0]?.id ?? null
    ));
    nav.setSelectedSolutionId((current) => (
      nextState.solutionDocs.some((item) => item.id === current) ? current : nextState.solutionDocs[0]?.id ?? null
    ));
    nav.setSelectedItineraryId((current) => (
      nextState.itineraries.some((item) => item.id === current) ? current : nextState.itineraries[0]?.id ?? null
    ));
  }, [nav]);
  const data = useWorkbenchDataState({
    apiClient,
    bootstrapAttempt,
    active: nav.active,
    account: authSession?.account ?? null,
    onBootstrapSelectionReset: handleBootstrapSelectionReset,
  });
  const toast = useToast();
  const mobileShell = useMobileShellEnabled();
  useServiceWorkerUpdate(toast);
  const {
    active,
    routeFilters,
    routeEntityId,
    workspaceRef,
    selectedCustomerId,
    selectedOpportunityId,
    selectedActionId,
    selectedRiskId,
    selectedKnowledgeId,
    selectedSolutionId,
    selectedItineraryId,
    customerViewMode,
    opportunityViewMode,
    actionViewMode,
    riskViewMode,
    knowledgeViewMode,
    itineraryViewMode,
    setCustomerViewMode,
    setOpportunityViewMode,
    setKnowledgeViewMode,
    setItineraryViewMode,
    navigateTo,
    selectCustomer,
    selectOpportunity,
    selectAction,
    selectRisk,
    selectKnowledge,
    changeCustomerViewMode,
    changeOpportunityViewMode,
    changeActionViewMode,
    changeRiskViewMode,
    changeKnowledgeViewMode,
    openCustomerDetail,
    openOpportunityDetail,
    openOpportunityList,
    openActionDetail,
    openActionList,
    openRiskList,
    openItineraryDetail,
    openItineraryCreate,
    openItineraryList,
    openItineraryEdit,
    openQuickHistoryRoute,
    recordItineraryExpense,
    consumeExpenseDraftRoute,
    setSelectedSolutionId,
  } = nav;
  const {
    backendStatus,
    bootstrapStatus,
    workbenchCustomers,
    workbenchOpportunities,
    workbenchActions,
    workbenchRisks,
    workbenchKnowledge,
    workbenchQuickRecords,
    workbenchSolutionDocs,
    workbenchItineraries,
    overviewSummary,
    bootstrapErrorMessage,
    offlineSnapshotSavedAt,
    setWorkbenchQuickRecords,
    refreshOverviewSummary,
    reloadBootstrap,
  } = data;
  const assistantChat = useAssistantChat({
    api: apiClient,
    account: authSession?.account ?? null,
    onRefreshBootstrap: reloadBootstrap,
    onRefreshOverview: refreshOverviewSummary,
    toast,
  });
  const assistantOnline = Boolean(apiClient?.isEnabled && backendStatus === "connected");
  const badges = useNotificationBadges({
    apiClient,
    backendStatus,
    overviewSummary,
    active,
  });
  function mergeById(items, item) {
    return mergeEntityByVersion(items, item);
  }

  const activeParent = PARENT_NAV_BY_ACTIVE[active] ?? active;
  const activeMeta =
    navItems.find((item) => item.id === activeParent) ??
    compatibilityRouteMeta[active] ??
    navItems[0];
  const apiStatusLabel = {
    connecting: "连接中",
    connected: "在线",
    offline: "离线",
    "offline-stale": `离线快照 · ${formatRelativeSnapshotTime(offlineSnapshotSavedAt)}`,
  }[backendStatus] ?? "离线";

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
  const handlers = useWorkbenchHandlers({
    nav,
    data,
    apiClient,
    weeklySession,
    selectedCustomer,
    selectedOpportunity,
  });

  useEffect(() => {
    if (typeof window === "undefined" || !workspaceRef.current) return;
    const revealActiveNavigation = () => {
      if (!window.matchMedia?.("(max-width: 760px)").matches) return;
      const activeParentNav = PARENT_NAV_BY_ACTIVE[active] ?? active;
      const activeButton = [...workspaceRef.current.querySelectorAll(".sidebar .nav-item")]
        .find((button) => button.dataset.testid === `nav-${activeParentNav}`);
      activeButton?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    };
    revealActiveNavigation();
    window.addEventListener("resize", revealActiveNavigation);
    return () => window.removeEventListener("resize", revealActiveNavigation);
  }, [active, workspaceRef]);

  const subnavItems = (moduleSubnavItems[activeParent] ?? []).filter((item) => (
    activeParent !== "settings"
    || authSession?.role === "admin"
    || item.id === "settings"
  )).map((item) => (
    activeParent === "settings" && item.id === "settings" && authSession?.role !== "admin"
      ? { ...item, label: "安全设置" }
      : item
  ));
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
  const settingsSection = SETTINGS_SECTION_BY_ACTIVE[active] ?? "";

  const blockedByBootstrap = activeParent !== "settings" && (
    bootstrapStatus === "loading" ||
    bootstrapStatus === "error" ||
    (bootstrapStatus === "empty" && active === "overview")
  );
  const visibleBootstrapStatus =
    bootstrapStatus === "loading" || bootstrapStatus === "error" ? bootstrapStatus : "empty";

  async function handlePullRefresh() {
    try {
      if (active === "overview") {
        await refreshOverviewSummary();
        return;
      }
      if (["customer", "opportunity", "actions", "risk", "knowledge", "quick", "weekly", "kanban"].includes(active)) {
        const result = await reloadBootstrap();
        if (result?.offline) {
          toast({ tone: "info", title: "当前为离线快照" });
        }
        return;
      }
      if (active === "itinerary" || active === "expense" || active === "hospital-tenders") {
        setBootstrapAttempt(incrementBootstrapAttempt);
        return;
      }
      await reloadBootstrap();
    } catch (error) {
      toast({ tone: "error", title: "刷新失败", description: error?.message ?? "请稍后重试" });
    }
  }

  const contentBody = (
    <>
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
              className="ghost-button topbar-mobile-hidden"
              type="button"
              onClick={() => navigateTo("weekly")}
            >
              <FileText size={16} />
              周报
            </button>
            <button
              className="ghost-button topbar-mobile-hidden"
              type="button"
              data-testid="topbar-quick-record"
              onClick={() => navigateTo("quick")}
            >
              <Mic size={16} />
              快速记录
            </button>
            {mobileShell ? (
              <button
                className="icon-button"
                type="button"
                data-testid="assistant-topbar-button"
                aria-expanded={assistantChat.open}
                aria-controls="assistant-chat-panel"
                onClick={assistantChat.openChat}
              >
                <Sparkles size={16} />
                小小
              </button>
            ) : null}
            <AvatarMenu
              initial={avatarInitial}
              displayName={authSession?.displayName ?? authSession?.account ?? ""}
              account={authSession?.account ?? ""}
              onLogout={onLogout}
            />
          </div>
        </header>

        <div ref={workspaceRef} className={`workspace ${mobileShell ? "mobile-shell-on" : ""}`}>
          <aside className={`sidebar ${mobileShell ? "hidden" : ""}`}>
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

          <PullToRefresh onRefresh={handlePullRefresh} disabled={!mobileShell}>
          <section
            className={`content ${active === "quick" ? "quick-content" : ""} ${mobileShell ? "mobile-shell-content" : ""}`}
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
              <RouteChunkBoundary>
              <Suspense fallback={<RouteChunkFallback />}>
              <>
            {settingsSection && (
              <div className={`settings-section-view settings-section-${settingsSection}`}>
                <SystemSettingsPage
                  apiClient={apiClient}
                  backendStatus={backendStatus}
                  section={settingsSection}
                  role={authSession?.role ?? "member"}
                />
              </div>
            )}
            {active === "settings-users" && (
              <UserManagementPage
                apiClient={apiClient}
                backendStatus={backendStatus}
                authSession={authSession}
              />
            )}
            {active === "overview" && (
              <Overview />
            )}
            {active === "quick" && (
              <QuickRecord />
            )}
            {active === "customer" && (
              customerEntityUnavailable ? (
                <EntityUnavailablePanel label="客户" onBack={() => navigateTo("customer")} />
              ) : <CustomerPage
                items={workbenchCustomers}
                selected={selectedCustomer}
                onSelect={selectCustomer}
                viewMode={customerViewMode}
                setViewMode={changeCustomerViewMode}
              />
            )}
            {active === "opportunity" && (
              opportunityEntityUnavailable ? (
                <EntityUnavailablePanel label="商机" onBack={() => navigateTo("opportunity")} />
              ) : <OpportunityPage
                items={workbenchOpportunities}
                selected={selectedOpportunity}
                onSelect={selectOpportunity}
                viewMode={opportunityViewMode}
                setViewMode={changeOpportunityViewMode}
              />
            )}
            {active === "actions" && (
              opportunityContextUnavailable || actionEntityUnavailable ? (
                <EntityUnavailablePanel label={opportunityContextUnavailable ? "商机" : "动作"} onBack={() => navigateTo("actions")} />
              ) : <ActionsPage
                items={scopedActions}
                selected={selectedAction}
                onSelect={selectAction}
                viewMode={actionViewMode}
                setViewMode={changeActionViewMode}
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
                onSave={handlers.handleSaveItinerary}
                onDelete={handlers.handleDeleteItinerary}
                onRecordExpense={recordItineraryExpense}
              />
            )}
            {active === "expense" && (
              <TravelExpensePage
                apiClient={apiClient}
                backendStatus={backendStatus}
                customers={workbenchCustomers}
                itineraries={workbenchItineraries}
                owner={authSession.displayName}
                expenseDraft={expenseDraftFromFilters(routeFilters)}
                onExpenseDraftConsumed={consumeExpenseDraftRoute}
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
              <WeeklyPage />
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
              />
            )}
            {active === "kanban" && (
              opportunityContextUnavailable ? (
                <EntityUnavailablePanel label="商机" onBack={() => navigateTo("kanban")} />
              ) : <KanbanPage
                opportunitiesList={scopedOpportunities}
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
              </Suspense>
              </RouteChunkBoundary>
            )}
          </section>
          </PullToRefresh>
          {mobileShell ? (
            <MobileShell
              activeParent={activeParent}
              badges={badges}
              authRole={authSession?.role ?? "member"}
              onNavigate={navigateTo}
              onMoreSubnav={handleModuleSubnavNavigate}
              onOpenAssistant={assistantChat.openChat}
              onQuickRecord={() => {
                quickSession.setRecordMode("voice");
                navigateTo("quick");
              }}
            />
          ) : null}
          {!mobileShell ? (
            <button
              className="assistant-fab"
              type="button"
              data-testid="assistant-fab"
              aria-expanded={assistantChat.open}
              aria-controls="assistant-chat-panel"
              onClick={assistantChat.openChat}
            >
              <Sparkles size={22} />
              <span>小小</span>
            </button>
          ) : null}
          <AssistantChatPanel
            open={assistantChat.open}
            messages={assistantChat.messages}
            pending={assistantChat.pending}
            draft={assistantChat.draft}
            busy={assistantChat.busy}
            apiClient={apiClient}
            online={assistantOnline}
            sessionEpoch={authSession?.account ?? null}
            appendTranscriptToDraft={assistantChat.appendTranscriptToDraft}
            voiceFeedback={assistantChat.voiceFeedback}
            draftFocusToken={assistantChat.draftFocusToken}
            onDraftChange={assistantChat.setDraft}
            onSend={assistantChat.sendMessage}
            onClose={assistantChat.closeChat}
            onConfirm={assistantChat.confirmPending}
            onCancelPending={assistantChat.cancelPending}
          />
        </div>
    </>
  );

  return (
    <NavigationProvider value={nav}>
    <WorkbenchDataProvider value={data}>
    <WorkbenchActionsProvider value={handlers}>
    <QuickRecordSessionProvider value={quickSession}>
    <WeeklySessionProvider value={weeklySession}>
    <main className={`app-shell ${mobileShell ? "mobile-shell-on" : ""}`}>
      <div className="product-window">
        {contentBody}
      </div>
    </main>
    </WeeklySessionProvider>
    </QuickRecordSessionProvider>
    </WorkbenchActionsProvider>
    </WorkbenchDataProvider>
    </NavigationProvider>
  );
}

export function SalesWorkbenchShell(props) {
  return (
    <ToastProvider>
      <WorkbenchShellBody {...props} />
    </ToastProvider>
  );
}
