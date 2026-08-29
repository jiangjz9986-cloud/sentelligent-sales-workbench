import { createContext, useContext } from "react";
import { assertBackendReady, removeEntityById } from "./workbenchState.js";
import { mergeEntityByVersion } from "../quickRecordModel.js";
import { getCurrentWeekRange } from "../weekRange.js";

const WorkbenchActionsContext = createContext(null);

const noopActions = {
  handleSaveCustomer: async () => {},
  handleSaveOpportunity: async () => {},
  handleSaveKnowledge: async () => {},
  handleSearchKnowledge: async () => [],
  handleUpdateRiskStatus: async () => {},
  handleUpdateActionStatus: async () => {},
  handleCreateAction: async () => {},
  handleDeleteCustomer: async () => {},
  handleDeleteOpportunity: async () => {},
  handleDeleteKnowledge: async () => {},
  handleDeleteAction: async () => {},
  handleDeleteRisk: async () => {},
  handleSaveItinerary: async () => {},
  handleDeleteItinerary: async () => {},
  handleCiteKnowledge: async () => {},
  handleBusinessSync: () => {},
  handleConfirmationRefresh: () => {},
};

export function useWorkbenchActions() {
  return useContext(WorkbenchActionsContext) ?? noopActions;
}

export function WorkbenchActionsProvider({ value, children }) {
  return <WorkbenchActionsContext.Provider value={value}>{children}</WorkbenchActionsContext.Provider>;
}

export function useWorkbenchHandlers({ nav, data, apiClient, weeklySession, selectedCustomer, selectedOpportunity }) {
  const {
    workbenchCustomers,
    workbenchOpportunities,
    workbenchActions,
    workbenchRisks,
    workbenchKnowledge,
    workbenchItineraries,
    backendStatus,
    setWorkbenchCustomers,
    setWorkbenchOpportunities,
    setWorkbenchActions,
    setWorkbenchRisks,
    setWorkbenchKnowledge,
    setWorkbenchItineraries,
    refreshOverviewSummary,
    routeFilters,
  } = { ...data, routeFilters: nav.routeFilters };

  const {
    selectCustomer,
    selectOpportunity,
    selectAction,
    selectRisk,
    selectKnowledge,
    selectItinerary,
    navigateTo,
    setCustomerViewMode,
    setOpportunityViewMode,
    setActionViewMode,
    setRiskViewMode,
    setKnowledgeViewMode,
    selectedItineraryId,
  } = nav;

  const selectedItinerary = workbenchItineraries.find((item) => item.id === selectedItineraryId) ?? null;

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
    nav.setSelectedRiskId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleUpdateActionStatus(id, patch) {
    ensureBackend("更新动作");
    const currentEntity = workbenchActions.find((item) => item.id === id);
    const updated = await apiClient.updateActionStatus(id, patch, currentEntity?.version);
    setWorkbenchActions((current) => mergeById(current, updated));
    nav.setSelectedActionId(updated.id);
    await refreshOverviewSummary();
    return updated;
  }

  async function handleCreateAction(draft) {
    ensureBackend("新增待办");
    const saved = await apiClient.createAction(draft);
    setWorkbenchActions((current) => mergeById(current, saved));
    selectAction(saved.id);
    await refreshOverviewSummary();
    return saved;
  }

  async function handleDeleteCustomer(id) {
    ensureBackend("删除客户");
    const existing = workbenchCustomers.find((item) => item.id === id);
    const deleted = await apiClient.deleteCustomer(id, existing?.version);
    setWorkbenchCustomers((current) => removeEntityById(current, id));
    setWorkbenchOpportunities((current) => current.filter((item) => item.customerId !== id));
    nav.setSelectedCustomerId((current) => current === id ? null : current);
    nav.setSelectedOpportunityId(null);
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
    nav.setSelectedOpportunityId((current) => current === id ? null : current);
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
    nav.setSelectedKnowledgeId((current) => current === id ? null : current);
    setKnowledgeViewMode("list");
    return deleted ?? { id };
  }

  async function handleDeleteAction(id) {
    ensureBackend("删除动作");
    const existing = workbenchActions.find((item) => item.id === id);
    const deleted = await apiClient.deleteAction(id, existing?.version);
    setWorkbenchActions((current) => removeEntityById(current, id));
    nav.setSelectedActionId((current) => current === id ? null : current);
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
    nav.setSelectedRiskId((current) => current === id ? null : current);
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
        periodStart,
        periodEnd,
        knowledgeIds: [knowledgeItem.id],
      });
      weeklySession.setWeeklyDraft(draft);
      weeklySession.setWeeklyDraftText(draft.content);
      weeklySession.setWeeklyView("summary");
      navigateTo("weekly");
      return draft;
    }

    throw new Error("未知引用目标");
  }

  function handleBusinessSync(result) {
    if (result.customer) {
      setWorkbenchCustomers((current) => mergeById(current, result.customer));
      nav.setSelectedCustomerId(result.customer.id);
    }
    if (result.opportunity) {
      setWorkbenchOpportunities((current) => mergeById(current, result.opportunity));
      nav.setSelectedOpportunityId(result.opportunity.id);
    }
    if (result.action) {
      setWorkbenchActions((current) => mergeById(current, result.action));
      nav.setSelectedActionId(result.action.id);
    }
    if (result.risk) {
      setWorkbenchRisks((current) => mergeById(current, result.risk));
      nav.setSelectedRiskId(result.risk.id);
    }
    void refreshOverviewSummary();
  }

  function handleConfirmationRefresh(refreshed) {
    setWorkbenchCustomers((current) =>
      (refreshed.customers ?? []).reduce((items, item) => mergeById(items, item), current));
    setWorkbenchOpportunities((current) =>
      (refreshed.opportunities ?? []).reduce((items, item) => mergeById(items, item), current));
  }

  return {
    handleSaveCustomer,
    handleSaveOpportunity,
    handleSaveKnowledge,
    handleSearchKnowledge,
    handleUpdateRiskStatus,
    handleUpdateActionStatus,
    handleCreateAction,
    handleDeleteCustomer,
    handleDeleteOpportunity,
    handleDeleteKnowledge,
    handleDeleteAction,
    handleDeleteRisk,
    handleSaveItinerary,
    handleDeleteItinerary,
    handleCiteKnowledge,
    handleBusinessSync,
    handleConfirmationRefresh,
  };
}
