import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  InfoList,
  ManualConfirmBox,
  MetricInline,
  Panel,
} from "../../../components/primitives.jsx";
import {
  DecisionChain,
  DeleteConfirmationDialog,
  FieldTags,
  FormField,
  StakeholderGrid,
  arrayFromText,
  generateBusinessSuggestion,
  joinedList,
  numberFromInput,
  textFromArray,
} from "./shared.jsx";

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

function CustomerEditor({ selected, initialMode = "edit", onSaveCustomer, onSaved, onCancel, backendStatus }) {
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

export function CustomerPage({
  items,
  selected,
  onSelect,
  setActive,
  setSelectedOpportunityId,
  openOpportunityDetail,
  onSaveCustomer,
  onDeleteCustomer,
  opportunitiesList = [],
  viewMode = "list",
  setViewMode,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.name, item.region, item.type, item.level, item.contact, item.summary, item.owner].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  function requestDeleteCurrentCustomer() {
    if (!selected?.id || !onDeleteCustomer) return;
    setDeleteError("");
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteCurrentCustomer() {
    if (!selected?.id || !onDeleteCustomer || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await onDeleteCustomer(selected.id);
      setDeleteDialogOpen(false);
      setViewMode?.("list");
    } catch (error) {
      setDeleteError(error.message || "删除客户失败，请稍后重试。");
    } finally {
      setDeleteBusy(false);
    }
  }

  if (viewMode === "list") {
    return (
      <section className="customer-list-view" data-testid="customer-list-view">
        <Panel
          title="客户列表"
          meta={`${visibleItems.length} / ${items.length} 家客户`}
          className="list-panel customer-list-panel"
          action={(
            <button
              className="primary-button"
              type="button"
              data-testid="customer-create-detail"
              onClick={() => setViewMode?.("create")}
            >
              <Plus size={16} />
              新增客户
            </button>
          )}
        >
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索客户"
              data-testid="customer-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索客户、区域、联系人、预算节奏"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${selected?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.region} / {item.type} / {item.contact}</small>
                  </span>
                  <b className="pill tone-blue">{item.level}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="customer-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无客户，可点击“新增客户”开始录入。" : "没有匹配客户，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="customer-detail-view detail-scroll-view" data-testid="customer-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {!isCreateView ? (
          <div className="detail-toolbar-actions">
            <button
              className={isEditView ? "ghost-button disabled" : "ghost-button"}
              disabled={isEditView}
              type="button"
              data-testid="customer-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="customer-delete-detail"
              onClick={requestDeleteCurrentCustomer}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <CustomerEditor
            selected={isCreateView ? null : selected}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveCustomer={onSaveCustomer}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
            backendStatus={backendStatus}
          />
        ) : null}
        {!isCreateView && !isEditView && (
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
          <Panel title="关键联系人" meta="跟进角色">
            <StakeholderGrid people={selected.stakeholders.slice(0, 4)} />
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
        <ManualConfirmBox
          title="生成客户画像补全建议"
          desc="结合快速记录整理组织关系、需求痛点和下一次拜访问题。"
          onGenerate={() =>
            generateBusinessSuggestion(apiClient, backendStatus, {
              type: "customer_profile",
              title: "生成客户画像补全建议",
              context: {
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
              },
            })
          }
        />
          </>
        )}
      </section>
      <DeleteConfirmationDialog
        open={deleteDialogOpen}
        entityName={selected?.name ?? "当前客户"}
        busy={deleteBusy}
        errorMessage={deleteError}
        onCancel={() => {
          if (deleteBusy) return;
          setDeleteError("");
          setDeleteDialogOpen(false);
        }}
        onConfirm={confirmDeleteCurrentCustomer}
        testIdPrefix="customer-delete"
      />
    </section>
  );
}
