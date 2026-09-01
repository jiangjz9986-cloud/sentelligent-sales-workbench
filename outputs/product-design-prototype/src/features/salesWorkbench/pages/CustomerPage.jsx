import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  InfoList,
  MetricInline,
  Panel,
} from "../../../components/primitives.jsx";
import { ManualAiSuggestionPanel } from "../../../components/ai/ManualAiSuggestionPanel.jsx";
import { useNavigation } from "../../../app/useWorkbenchNavigation.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";
import {
  DecisionChain,
  FieldTags,
  FormField,
  StakeholderGrid,
  arrayFromText,
  joinedList,
  numberFromInput,
  textFromArray,
} from "./shared.jsx";
import { EntityWorkspace } from "./EntityWorkspace.jsx";

function customerToForm(customer) {
  return {
    id: customer?.id ?? "",
    name: customer?.name ?? "",
    region: customer?.region ?? "",
    type: customer?.type ?? "",
    level: customer?.level ?? "",
    contact: customer?.contact ?? "",
    relation: customer?.relation == null ? "" : String(customer.relation),
    budget: customer?.budget ?? "",
    summary: customer?.summary ?? "",
    needs: textFromArray(customer?.needs),
    risks: textFromArray(customer?.risks),
    infrastructure: textFromArray(customer?.infrastructure),
  };
}

function customerFromForm(form, isNew) {
  return {
    ...(isNew ? {} : { id: form.id }),
    name: form.name.trim(),
    region: form.region.trim(),
    type: form.type.trim(),
    level: form.level.trim(),
    contact: form.contact.trim(),
    relation: numberFromInput(form.relation),
    budget: form.budget.trim(),
    summary: form.summary.trim(),
    needs: arrayFromText(form.needs),
    risks: arrayFromText(form.risks),
    infrastructure: arrayFromText(form.infrastructure),
    stakeholders: isNew ? [] : undefined,
    decisionChain: isNew ? [] : undefined,
    historyProjects: isNew ? [] : undefined,
    syncPreview: isNew ? [] : undefined,
    opportunities: isNew ? [] : undefined,
  };
}

function CustomerEditor({ selected, initialMode = "edit", onSaveCustomer, onSaved, onCancel }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() => (initialMode === "new" ? customerToForm(null) : customerToForm(selected)));
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(customerToForm(selected));
  }, [selected, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? customerToForm(null) : customerToForm(selected));
    setSaveStatus("就绪");
  }, [initialMode, selected]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setSaveStatus("客户名称不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveCustomer(customerFromForm(form, isNew));
      setMode("edit");
      setForm(customerToForm(saved));
      onSaved?.(saved);
      setSaveStatus("已保存");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="customer-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">客户维护</span>
          <strong>{isNew ? "新建客户画像" : "编辑当前客户"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="customer-cancel-edit" onClick={() => {
            setForm(isNew ? customerToForm(null) : customerToForm(selected));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit" data-testid="customer-save-edit">
            <Save size={16} />
            {isNew ? "创建客户" : "保存客户"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="客户名称">
          <input value={form.name} onChange={(event) => update("name", event.target.value)} />
        </FormField>
        <FormField label="区域">
          <input value={form.region} onChange={(event) => update("region", event.target.value)} />
        </FormField>
        <FormField label="类型">
          <input value={form.type} onChange={(event) => update("type", event.target.value)} />
        </FormField>
        <FormField label="级别">
          <input value={form.level} onChange={(event) => update("level", event.target.value)} />
        </FormField>
        <FormField label="联系人">
          <input value={form.contact} onChange={(event) => update("contact", event.target.value)} />
        </FormField>
        <FormField label="关系强度">
          <input min="0" max="100" type="number" value={form.relation} onChange={(event) => update("relation", event.target.value)} />
        </FormField>
        <FormField label="预算节奏">
          <input value={form.budget} onChange={(event) => update("budget", event.target.value)} />
        </FormField>
      </div>
      <FormField label="客户摘要">
        <textarea value={form.summary} onChange={(event) => update("summary", event.target.value)} />
      </FormField>
      <div className="editor-grid three">
        <FormField label="核心需求">
          <textarea value={form.needs} onChange={(event) => update("needs", event.target.value)} />
        </FormField>
        <FormField label="风险顾虑">
          <textarea value={form.risks} onChange={(event) => update("risks", event.target.value)} />
        </FormField>
        <FormField label="基础架构">
          <textarea value={form.infrastructure} onChange={(event) => update("infrastructure", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

const customerConfig = {
  listViewTestId: "customer-list-view",
  detailViewTestId: "customer-detail-view",
  listViewClassName: "customer-list-view",
  detailViewClassName: "customer-detail-view detail-scroll-view",
  listPanelClassName: "list-panel customer-list-panel",
  panelTitle: "客户列表",
  listMeta: (visible, total) => `${visible} / ${total} 家客户`,
  searchAriaLabel: "搜索客户",
  searchTestId: "customer-local-search",
  searchPlaceholder: "搜索客户、区域、联系人、预算节奏",
  searchFields: ["name", "region", "type", "level", "contact", "summary", "owner"],
  openDetailTestId: "customer-open-detail",
  editDetailTestId: "customer-edit-detail",
  deleteDetailTestId: "customer-delete-detail",
  createAction: {
    testId: "customer-create-detail",
    label: "新增客户",
    icon: <Plus size={16} />,
  },
  emptyNoItems: "暂无客户，可点击“新增客户”开始录入。",
  emptyNoMatch: "没有匹配客户，请调整关键词。",
  rowPrimary: (item) => item.name,
  rowSecondary: (item) => `${item.region} / ${item.type} / ${item.contact}`,
  renderRowBadge: (item) => <b className="pill tone-blue">{item.level}</b>,
  deleteDialog: {
    title: "确认删除客户",
    description: (selected) => `“${selected?.name ?? "当前客户"}”将从客户列表中移除，此操作不能撤销。`,
    entityName: (selected) => selected.name,
    testIdPrefix: "customer-delete",
    successTitle: "客户已删除",
    errorMessage: "删除客户失败，请稍后重试。",
  },
};

function CustomerDetailBody({ selected, viewMode, setViewMode, onSelect }) {
  const { apiClient, backendStatus, workbenchOpportunities: opportunitiesList } = useWorkbenchData();
  const { handleSaveCustomer } = useWorkbenchActions();
  const { navigateTo: setActive, setSelectedOpportunityId, openOpportunityDetail } = useNavigation();
  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  if (isCreateView || isEditView) {
    return (
      <CustomerEditor
        selected={isCreateView ? null : selected}
        initialMode={isCreateView ? "new" : "edit"}
        onSaveCustomer={handleSaveCustomer}
        onSaved={(saved) => {
          onSelect(saved.id);
          setViewMode?.("detail");
        }}
        onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
      />
    );
  }

  return (
    <>
      <div className="detail-metrics">
        <MetricInline label="区域" value={selected.region} />
        <MetricInline label="负责人" value={selected.owner} />
        <MetricInline label="关系强度" value={`${selected.relation}`} />
        <MetricInline label="预算节奏" value={selected.budget} />
      </div>
      <div className="three-col">
        <Panel title="核心需求" meta="沉淀自记录">
          <InfoList items={selected.needs} tone="blue" />
        </Panel>
        <Panel title="风险与顾虑" meta="需跟进">
          <InfoList items={selected.risks} tone="amber" />
        </Panel>
        <Panel title="关联商机" meta="点击跳转">
          <div className="list-stack tiny">
            {selected.opportunities.map((name) => {
              const opportunity = opportunitiesList.find((item) => item.name === name);
              return (
                <button
                  className="plain-link"
                  key={name}
                  type="button"
                  onClick={() => {
                    if (opportunity && openOpportunityDetail) openOpportunityDetail(opportunity.id);
                    else {
                      if (opportunity) setSelectedOpportunityId(opportunity.id);
                      setActive("opportunity");
                    }
                  }}
                >
                  {name}
                  <ChevronRight size={15} />
                </button>
              );
            })}
          </div>
        </Panel>
      </div>
      <div className="two-col customer-profile-grid">
        <Panel title="组织架构与决策链" meta="影响力视图">
          <StakeholderGrid people={selected.stakeholders} />
          <DecisionChain steps={selected.decisionChain} />
        </Panel>
        <Panel title="历史项目" meta="已沉淀">
          <FieldTags items={selected.historyProjects} tone="green" />
        </Panel>
        <Panel title="现有基础架构" meta="调研字段">
          <InfoList items={selected.infrastructure} tone="teal" />
        </Panel>
        <Panel title="快速记录承接" meta="记录来源">
          <InfoList items={selected.syncPreview} tone="blue" />
        </Panel>
      </div>
      <ManualAiSuggestionPanel
        title="生成客户画像补全建议"
        description="结合快速记录整理组织关系、需求痛点和下一次拜访问题。"
        type="customer_profile"
        sourceId={selected.id}
        apiClient={apiClient}
        backendStatus={backendStatus}
        context={{
          customerId: selected.id,
          customer: selected.name,
          summary: selected.summary,
          level: selected.level,
          region: selected.region,
          budget: selected.budget,
          needs: joinedList(selected.needs),
          risks: joinedList(selected.risks),
          stakeholders: joinedList((selected.stakeholders ?? []).map((item) => `${item.name}-${item.role}`)),
          decisionChain: joinedList(selected.decisionChain),
          infrastructure: joinedList(selected.infrastructure),
          syncPreview: joinedList(selected.syncPreview),
        }}
      />
    </>
  );
}

export function CustomerPage({
  items,
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
}) {
  const current = selected ?? items[0] ?? null;
  const { handleDeleteCustomer } = useWorkbenchActions();

  return (
    <EntityWorkspace
      items={items}
      selected={current}
      activeRowId={current?.id}
      onSelect={onSelect}
      viewMode={viewMode}
      setViewMode={setViewMode}
      config={customerConfig}
      onDelete={handleDeleteCustomer}
      renderDetail={({ viewMode: mode }) => (
        <CustomerDetailBody
          selected={current}
          viewMode={mode}
          setViewMode={setViewMode}
          onSelect={onSelect}
        />
      )}
    />
  );
}
