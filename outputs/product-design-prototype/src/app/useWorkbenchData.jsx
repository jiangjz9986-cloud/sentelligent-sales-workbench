import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  clearSnapshot,
  getSnapshot,
  putSnapshot,
} from "./bootstrapCache.js";
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
  reloadBootstrap: async () => {},
  offlineSnapshotSavedAt: null,
  setBootstrapAttempt: () => {},
  onBootstrapSelectionReset: () => {},
};

export function useWorkbenchData() {
  return useContext(WorkbenchDataContext) ?? noopData;
}

export function WorkbenchDataProvider({ value, children }) {
  return <WorkbenchDataContext.Provider value={value}>{children}</WorkbenchDataContext.Provider>;
}

export function useWorkbenchDataState({ apiClient, bootstrapAttempt, onBootstrapSelectionReset, active, account }) {
  const [workbenchState, setWorkbenchState] = useState(createLoadingWorkbenchState);
  const [backendStatus, setBackendStatus] = useState(apiClient.isEnabled ? "connecting" : "offline");
  const [offlineSnapshotSavedAt, setOfflineSnapshotSavedAt] = useState(null);
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

  async function hydrateFromSnapshot(snapshot) {
    if (!snapshot?.data) return false;
    if (snapshot.expired) {
      setWorkbenchState(createErrorWorkbenchState(new Error("快照已过期，请联网刷新。")));
      onBootstrapSelectionReset?.(null);
      setBackendStatus("offline-stale");
      setOfflineSnapshotSavedAt(snapshot.savedAt ?? null);
      return true;
    }
    const nextState = normalizeBootstrapData({
      ...snapshot.data,
      summary: snapshot.summary ?? snapshot.data?.summary ?? null,
    });
    setWorkbenchState(nextState);
    onBootstrapSelectionReset?.(nextState);
    setBackendStatus("offline-stale");
    setOfflineSnapshotSavedAt(snapshot.savedAt ?? null);
    return true;
  }

  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++bootstrapGenerationRef.current;
    setWorkbenchState(createLoadingWorkbenchState());
    setBackendStatus("connecting");
    setOfflineSnapshotSavedAt(null);
    if (!apiClient.isEnabled) {
      setWorkbenchState(createErrorWorkbenchState(new Error("业务服务未配置，请联系管理员。")));
      setBackendStatus("offline");
      return () => controller.abort();
    }

    apiClient
      .loadBootstrap({ signal: controller.signal })
      .then(async (data) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        const nextState = normalizeBootstrapData(data);
        setWorkbenchState(nextState);
        onBootstrapSelectionReset?.(nextState);
        setBackendStatus("connected");
        setOfflineSnapshotSavedAt(null);
        if (account) {
          try {
            const summary = nextState.summary ?? await apiClient.getDashboardSummary();
            await putSnapshot(account, {
              data,
              summary,
              savedAt: Date.now(),
            });
          } catch {
            await putSnapshot(account, { data, summary: nextState.summary, savedAt: Date.now() });
          }
        }
      })
      .catch(async (error) => {
        if (!isCurrentBootstrapAttempt(
          bootstrapGenerationRef.current,
          requestGeneration,
          controller.signal,
        )) return;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        const fetchFailed = String(error?.message ?? "").includes("Failed to fetch");
        if (account && (offline || fetchFailed)) {
          try {
            const snapshot = await getSnapshot(account);
            if (snapshot && await hydrateFromSnapshot(snapshot)) return;
          } catch {
            // Fall through to the regular error state.
          }
        }
        setWorkbenchState(createErrorWorkbenchState(error));
        onBootstrapSelectionReset?.(null);
        setBackendStatus("offline");
      });

    return () => controller.abort();
  }, [apiClient, bootstrapAttempt, account]);

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

  async function reloadBootstrap() {
    if (!apiClient.isEnabled) return false;
    if (backendStatus === "offline-stale" && typeof navigator !== "undefined" && !navigator.onLine) {
      if (!account) return false;
      const snapshot = await getSnapshot(account);
      if (snapshot) {
        await hydrateFromSnapshot(snapshot);
        return { offline: true };
      }
      return false;
    }
    const data = await apiClient.loadBootstrap();
    const nextState = normalizeBootstrapData(data);
    setWorkbenchState(nextState);
    onBootstrapSelectionReset?.(nextState);
    setBackendStatus("connected");
    setOfflineSnapshotSavedAt(null);
    if (account) {
      const summary = nextState.summary ?? await apiClient.getDashboardSummary().catch(() => null);
      await putSnapshot(account, { data, summary, savedAt: Date.now() });
    }
    return { offline: false };
  }

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
    offlineSnapshotSavedAt,
    setWorkbenchCustomers,
    setWorkbenchOpportunities,
    setWorkbenchActions,
    setWorkbenchRisks,
    setWorkbenchKnowledge,
    setWorkbenchQuickRecords,
    setWorkbenchItineraries,
    setOverviewSummary,
    refreshOverviewSummary,
    reloadBootstrap,
    apiClient,
  };
}
