import { createContext, useContext, useEffect, useRef, useState } from "react";
import { buildWorkbenchUrl, parseWorkbenchRoute } from "./routes.js";
import {
  ACTIVE_BY_ROUTE_PAGE,
  ROUTE_BY_ACTIVE,
} from "./navRoutes.js";
import {
  expenseDraftFiltersFromItinerary,
} from "../features/visitItinerary/itineraryExpenseLink.js";

export function activeFromRoute(route) {
  return ACTIVE_BY_ROUTE_PAGE[route?.page] ?? "overview";
}

export function routeFilterValue(route, key) {
  const value = route?.filters?.[key]?.[0];
  return typeof value === "string" && value ? value : null;
}

export function editorModeFromRoute(route, page) {
  if (route?.page !== page) return "list";
  if (route.mode === "new") return page === "itineraries" ? "new" : "create";
  return ["list", "detail", "edit"].includes(route.mode) ? route.mode : "list";
}

const NavigationContext = createContext(null);

const noopNavigation = {
  active: "overview",
  routeFilters: {},
  routeEntityId: null,
  navigateTo: () => {},
  selectCustomer: () => {},
  selectOpportunity: () => {},
  selectAction: () => {},
  selectRisk: () => {},
  selectKnowledge: () => {},
  selectItinerary: () => {},
  setSelectedSolutionId: () => {},
  changeCustomerViewMode: () => {},
  changeOpportunityViewMode: () => {},
  changeActionViewMode: () => {},
  changeRiskViewMode: () => {},
  changeKnowledgeViewMode: () => {},
  setCustomerViewMode: () => {},
  setOpportunityViewMode: () => {},
  setActionViewMode: () => {},
  setRiskViewMode: () => {},
  setKnowledgeViewMode: () => {},
  setItineraryViewMode: () => {},
  openCustomerDetail: () => {},
  openOpportunityDetail: () => {},
  openOpportunityList: () => {},
  openActionDetail: () => {},
  openActionList: () => {},
  openRiskDetail: () => {},
  openRiskList: () => {},
  openItineraryDetail: () => {},
  openItineraryCreate: () => {},
  openItineraryList: () => {},
  openItineraryEdit: () => {},
  openQuickHistoryRoute: () => {},
  recordItineraryExpense: () => {},
  consumeExpenseDraftRoute: () => {},
  customerViewMode: "list",
  opportunityViewMode: "list",
  actionViewMode: "list",
  riskViewMode: "list",
  knowledgeViewMode: "list",
  itineraryViewMode: "list",
  selectedCustomerId: null,
  selectedOpportunityId: null,
  selectedActionId: null,
  selectedRiskId: null,
  selectedKnowledgeId: null,
  selectedSolutionId: null,
  selectedItineraryId: null,
  setSelectedCustomerId: () => {},
  setSelectedOpportunityId: () => {},
  setSelectedActionId: () => {},
};

export function useNavigation() {
  return useContext(NavigationContext) ?? noopNavigation;
}

export function NavigationProvider({ value, children }) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useWorkbenchNavigation({ initialRoute, onEnterQuick }) {
  const [active, setActive] = useState(() => activeFromRoute(initialRoute));
  const [routeFilters, setRouteFilters] = useState(() => initialRoute?.filters ?? {});
  const [routeEntityId, setRouteEntityId] = useState(() => initialRoute?.entityId ?? null);
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

  function findContentElement(workspaceRef) {
    if (typeof window === "undefined") return null;
    return workspaceRef?.current?.querySelector?.(".content") ?? document.querySelector(".content");
  }

  function rememberContentScrollPosition(workspaceRef) {
    if (typeof window === "undefined") return;
    const scrollTop = findContentElement(workspaceRef)?.scrollTop ?? 0;
    const currentState = window.history.state;
    const nextState = currentState && typeof currentState === "object"
      ? { ...currentState, contentScrollTop: scrollTop }
      : { contentScrollTop: scrollTop };
    window.history.replaceState(nextState, "", `${window.location.pathname}${window.location.search}`);
  }

  function restoreContentScrollPosition(scrollTop, workspaceRef) {
    if (typeof window === "undefined") return;
    const applyScroll = () => {
      const content = findContentElement(workspaceRef);
      if (content) content.scrollTop = scrollTop;
    };
    if (typeof window.requestAnimationFrame !== "function") {
      applyScroll();
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(applyScroll));
  }

  function writeBrowserRoute(route, workspaceRef, { replace = false } = {}) {
    if (typeof window === "undefined") return;
    const url = buildWorkbenchUrl(route);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const shouldReplace = replace || currentUrl === url;
    if (!shouldReplace) rememberContentScrollPosition(workspaceRef);
    window.history[shouldReplace ? "replaceState" : "pushState"](route, "", url);
    if (!shouldReplace) restoreContentScrollPosition(0, workspaceRef);
  }

  const workspaceRef = useRef(null);

  function navigateTo(nextActive, { filters = {}, entityId, mode } = {}) {
    const baseRoute = ROUTE_BY_ACTIVE[nextActive];
    if (!baseRoute) return;
    if (nextActive === "quick" && (mode ?? baseRoute.mode) !== "history") onEnterQuick?.();
    const route = {
      ...baseRoute,
      ...(mode ? { mode } : {}),
      ...(entityId ? { entityId } : {}),
      filters,
    };
    applyWorkbenchRoute(route);
    writeBrowserRoute(route, workspaceRef);
  }

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (initialRoute?.replace) writeBrowserRoute(initialRoute, workspaceRef, { replace: true });
    const onPopState = (event) => {
      const route = parseWorkbenchRoute({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      });
      applyWorkbenchRoute(route);
      if (route.replace) writeBrowserRoute(route, workspaceRef, { replace: true });
      const restoredScrollTop = typeof event?.state?.contentScrollTop === "number"
        ? event.state.contentScrollTop
        : 0;
      restoreContentScrollPosition(restoredScrollTop, workspaceRef);
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
    else if (mode === "create") navigateTo("actions", { mode: "new", filters: routeFilters });
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
    writeBrowserRoute(route, workspaceRef);
  }

  function recordItineraryExpense(item) {
    const filters = expenseDraftFiltersFromItinerary(item);
    if (!filters) return;
    navigateTo("expense", { filters });
  }

  function consumeExpenseDraftRoute() {
    const route = { ...ROUTE_BY_ACTIVE.expense, filters: {} };
    applyWorkbenchRoute(route);
    writeBrowserRoute(route, workspaceRef, { replace: true });
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

  return {
    workspaceRef,
    active,
    routeFilters,
    routeEntityId,
    selectedCustomerId,
    selectedOpportunityId,
    selectedActionId,
    selectedRiskId,
    selectedKnowledgeId,
    selectedSolutionId,
    selectedItineraryId,
    setSelectedCustomerId,
    setSelectedOpportunityId,
    setSelectedActionId,
    setSelectedRiskId,
    setSelectedKnowledgeId,
    setSelectedSolutionId,
    setSelectedItineraryId,
    customerViewMode,
    opportunityViewMode,
    actionViewMode,
    riskViewMode,
    knowledgeViewMode,
    itineraryViewMode,
    setCustomerViewMode,
    setOpportunityViewMode,
    setActionViewMode,
    setRiskViewMode,
    setKnowledgeViewMode,
    setItineraryViewMode,
    navigateTo,
    applyWorkbenchRoute,
    selectCustomer,
    selectOpportunity,
    selectAction,
    selectRisk,
    selectKnowledge,
    selectItinerary,
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
    openRiskDetail,
    openRiskList,
    openItineraryDetail,
    openItineraryCreate,
    openItineraryList,
    openItineraryEdit,
    openQuickHistoryRoute,
    recordItineraryExpense,
    consumeExpenseDraftRoute,
  };
}
