import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  createErrorWorkbenchState,
  createLoadingWorkbenchState,
  isCurrentBootstrapAttempt,
  normalizeBootstrapData,
} from "./workbenchState.js";

const WorkbenchDataContext = createContext(null);

const noopData = {
  backendStatus: "offline",
  bootstrapStatus: "loading",
  workbenchCustomers: [],
  workbenchOpportunities: [],
  workbenchActions: [],
  workbenchRisks: [],
  workbenchKnowledge: [],
  workbenchQuickRecords: [],
  workbenchSolutionDocs: [],
  workbenchItineraries: [],
  overviewSummary: null,
  bootstrapErrorMessage: "",
  setWorkbenchCustomers: () => {},
  setWorkbenchOpportunities: () => {},
  setWorkbenchActions: () => {},
  setWorkbenchRisks: () => {},
  setWorkbenchKnowledge: () => {},
  setWorkbenchQuickRecords: () => {},
  setWorkbenchItineraries: () => {},
  setOverviewSummary: () => {},
  refreshOverviewSummary: async () => {},
  setBootstrapAttempt: () => {},
  onBootstrapSelectionReset: () => {},
};

export function useWorkbenchData() {
  return useContext(WorkbenchDataContext) ?? noopData;
}

export function WorkbenchDataProvider({ value, children }) {
  return <WorkbenchDataContext.Provider value={value}>{children}</WorkbenchDataContext.Provider>;
}

export function useWorkbenchDataState({ apiClient, bootstrapAttempt, onBootstrapSelectionReset, active }) {
  const [workbenchState, setWorkbenchState] = useState(createLoadingWorkbenchState);
  const [backendStatus, setBackendStatus] = useState(apiClient.isEnabled ? "connecting" : "offline");
  const bootstrapGenerationRef = useRef(0);
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
        onBootstrapSelectionReset?.(nextState);
        setBackendStatus("connected");
      })
      .catch((error) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        setWorkbenchState(createErrorWorkbenchState(error));
        onBootstrapSelectionReset?.(null);
        setBackendStatus("offline");
      });

    return () => controller.abort();
  }, [apiClient, bootstrapAttempt]);

  async function refreshOverviewSummary() {
    if (!apiClient.isEnabled || backendStatus !== "connected") return;
    try {
      setOverviewSummary(await apiClient.getDashboardSummary());
    } catch {
      // Keep the last known summary visible when a dashboard-only refresh fails.
    }
  }

  // Itinerary and travel-expense writes happen outside the workbench-entity
  // handlers that call refreshOverviewSummary, so the today-focus and weekly
  // trend cards would otherwise show the bootstrap-time snapshot until a full
  // reload. Refresh silently every time the overview becomes the active page.
  useEffect(() => {
    if (active !== "overview" || !apiClient.isEnabled || backendStatus !== "connected") return undefined;
    let cancelled = false;
    apiClient
      .getDashboardSummary()
      .then((summary) => {
        if (!cancelled) setOverviewSummary(summary);
      })
      .catch(() => {
        // Keep the last known summary visible when the refresh fails.
      });
    return () => {
      cancelled = true;
    };
  }, [active, apiClient, backendStatus]);

  return {
    workbenchState,
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
    setWorkbenchCustomers,
    setWorkbenchOpportunities,
    setWorkbenchActions,
    setWorkbenchRisks,
    setWorkbenchKnowledge,
    setWorkbenchQuickRecords,
    setWorkbenchItineraries,
    setOverviewSummary,
    refreshOverviewSummary,
    apiClient,
  };
}
