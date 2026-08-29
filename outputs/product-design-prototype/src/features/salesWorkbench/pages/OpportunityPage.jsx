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
import { statusTone } from "../../../data/salesWorkbenchData.js";
import {
  ExpandableInsight,
  InfoList,
  ManualConfirmBox,
  MetricInline,
  Panel,
  Timeline,
} from "../../../components/primitives.jsx";
import { buildOpportunityTimeline } from "../opportunityTimeline.js";
import { SalesDecisionPanel } from "../SalesDecisionPanel.jsx";
import {
  FieldTags,
  FormField,
  arrayFromText,
  confirmDelete,
  generateBusinessSuggestion,
  joinedList,
  numberFromInput,
  showOperationError,
  textFromArray,
} from "./shared.jsx";

function opportunityToForm(opportunity, selectedCustomer) {
  const hasOpportunity = Boolean(opportunity?.id);
  return {
    id: opportunity?.id ?? "",
    customerId: hasOpportunity ? (opportunity?.customerId ?? selectedCustomer?.id ?? "") : "",
    name: opportunity?.name ?? "",
    customer: hasOpportunity ? (opportunity?.customer ?? selectedCustomer?.name ?? "") : "",
    stage: opportunity?.stage ?? "",
    amount: opportunity?.amount ?? "",
    probability: opportunity?.probability == null ? "" : String(opportunity.probability),
    days: opportunity?.days == null ? "" : String(opportunity.days),
    requirements: textFromArray(opportunity?.requirements),
    competitors: textFromArray(opportunity?.competitors),
    solutionDirection: textFromArray(opportunity?.solutionDirection),
    risk: opportunity?.risk ?? "",
    next: opportunity?.next ?? "",
  };
}

function opportunityFromForm(form, customersList, isNew) {
  const customer = customersList.find((item) => item.id === form.customerId);
  return {
    ...(isNew ? {} : { id: form.id }),
    customerId: form.customerId,
    name: form.name.trim(),
    customer: customer?.name ?? form.customer.trim(),
    stage: form.stage.trim(),
    amount: form.amount.trim(),
    probability: numberFromInput(form.probability, 30),
    days: numberFromInput(form.days),
    requirements: arrayFromText(form.requirements),
    competitors: arrayFromText(form.competitors),
    solutionDirection: arrayFromText(form.solutionDirection),
    risk: form.risk.trim(),
    next: form.next.trim(),
    tone: "blue",
  };
}

function OpportunityEditor({ selected, customersList, initialMode = "edit", onSaveOpportunity, onSaved, onCancel, backendStatus }) {
  const selectedCustomer = customersList.find((item) => item.id === selected?.customerId) ?? customersList[0];
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() =>
    initialMode === "new" ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer),
  );
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(opportunityToForm(selected, selectedCustomer));
  }, [selected, selectedCustomer, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer));
    setSaveStatus("就绪");
  }, [initialMode, selected, selectedCustomer]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim() || !form.customerId) {
      setSaveStatus("商机名称和客户不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveOpportunity(opportunityFromForm(form, customersList, isNew));
      setMode("edit");
      setForm(opportunityToForm(saved, selectedCustomer));
      onSaved?.(saved);
      setSaveStatus("已保存");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="opportunity-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">商机维护</span>
          <strong>{isNew ? "新建商机档案" : "编辑当前商机"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="opportunity-cancel-edit" onClick={() => {
            setForm(isNew ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {isNew ? "创建商机" : "保存商机"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="商机名称">
          <input value={form.name} onChange={(event) => update("name", event.target.value)} />
        </FormField>
        <FormField label="关联客户">
          <select value={form.customerId} onChange={(event) => update("customerId", event.target.value)}>
            {isNew ? <option value="">请选择客户</option> : null}
            {customersList.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="阶段">
          <input value={form.stage} onChange={(event) => update("stage", event.target.value)} />
        </FormField>
        <FormField label="金额">
          <input value={form.amount} onChange={(event) => update("amount", event.target.value)} />
        </FormField>
        <FormField label="赢率">
          <input min="0" max="100" type="number" value={form.probability} onChange={(event) => update("probability", event.target.value)} />
        </FormField>
        <FormField label="停留天数">
          <input min="0" type="number" value={form.days} onChange={(event) => update("days", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-grid three">
        <FormField label="需求">
          <textarea value={form.requirements} onChange={(event) => update("requirements", event.target.value)} />
        </FormField>
        <FormField label="竞争对手">
          <textarea value={form.competitors} onChange={(event) => update("competitors", event.target.value)} />
        </FormField>
        <FormField label="方案方向">
          <textarea value={form.solutionDirection} onChange={(event) => update("solutionDirection", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-grid two">
        <FormField label="风险说明">
          <textarea value={form.risk} onChange={(event) => update("risk", event.target.value)} />
        </FormField>
        <FormField label="下一步动作">
          <textarea value={form.next} onChange={(event) => update("next", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

export function OpportunityPage({
  items,
  selected,
  onSelect,
  setActive,
  setSelectedCustomerId,
  viewMode = "list",
  setViewMode,
  customersList,
  onSaveOpportunity,
  onDeleteOpportunity,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.name, item.customer, item.stage, item.risk, item.next, item.owner].some((value) =>
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
  const timelineItems = buildOpportunityTimeline(selected);

  async function deleteCurrentOpportunity() {
    if (!selected?.id || !onDeleteOpportunity) return;
    if (!confirmDelete(`确认删除商机「${selected.name}」？删除后将从商机列表移除。`)) return;
    try {
      await onDeleteOpportunity(selected.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除商机失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="opportunity-list-view" data-testid="opportunity-list-view">
        <Panel
          title="商机列表"
          meta={`${visibleItems.length} / ${items.length} 个商机`}
          className="list-panel opportunity-list-panel"
          action={(
            <button
              className="primary-button"
              type="button"
              data-testid="opportunity-create-detail"
              onClick={() => setViewMode?.("create")}
            >
              <Plus size={16} />
              新增商机
            </button>
          )}
        >
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索商机"
              data-testid="opportunity-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索商机、客户、阶段、负责人"
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
                    <small>{item.customer} / {item.stage}</small>
                  </span>
                  <b className={`pill ${statusTone[item.tone]}`}>{item.probability}%</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="opportunity-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无商机，可点击“新增商机”开始录入。" : "没有匹配商机，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="opportunity-detail-view detail-scroll-view" data-testid="opportunity-detail-view">
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
              data-testid="opportunity-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="opportunity-delete-detail"
              onClick={deleteCurrentOpportunity}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <OpportunityEditor
            selected={isCreateView ? null : selected}
            customersList={customersList}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveOpportunity={onSaveOpportunity}
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
          <MetricInline label="金额" value={selected.amount} />
          <MetricInline label="赢率" value={`${selected.probability}%`} />
          <MetricInline label="负责人" value={selected.owner} />
          <MetricInline label="阶段" value={selected.stage} />
        </div>
        <div className="two-col">
          <Panel title="客户诉求 / 需求" meta="商机字段">
            <InfoList items={selected.requirements} tone="blue" />
          </Panel>
          <Panel title="竞争对手" meta="关系与方案压力">
            <FieldTags items={selected.competitors} tone="amber" />
          </Panel>
          <Panel title="方案方向" meta="售前协同">
            <InfoList items={selected.solutionDirection} tone="green" />
          </Panel>
          <Panel title="来源记录" meta="快速记录承接">
            <ExpandableInsight
              testId="opportunity-source-insight"
              expandedTestId="opportunity-source-expanded"
              ariaLabel="展开商机来源记录"
              detail="已展开来源记录：可回到快速记录核对原始拜访、电话或会议内容，再决定是否写入周报。"
            >
              {selected.sourceRecord ?? "尚未绑定来源记录，可从快速记录确认后写入商机档案。"}
            </ExpandableInsight>
          </Panel>
          <Panel title="风险说明" meta="来自记录与字段">
            <ExpandableInsight
              tone="amber"
              testId="opportunity-risk-insight"
              expandedTestId="opportunity-risk-expanded"
              ariaLabel="展开商机风险说明"
              detail="已展开风险说明：可进入风险识别页分配负责人、设置处理时间并关闭风险。"
            >
              {selected.risk ?? "尚未沉淀风险说明，可在风险识别页补充证据和处理建议。"}
            </ExpandableInsight>
          </Panel>
          <Panel title="下一步动作" meta="推进安排">
            <ExpandableInsight
              testId="opportunity-next-insight"
              expandedTestId="opportunity-next-expanded"
              ariaLabel="展开商机下一步动作"
              detail="已展开下一步动作：可进入下一步动作页调整负责人、截止时间和完成状态。"
            >
              {selected.next ?? "尚未生成下一步动作，可从快速记录或商机推进建议中确认后生成。"}
            </ExpandableInsight>
          </Panel>
        </div>
        <Timeline items={timelineItems} />
        <SalesDecisionPanel
          selected={selected}
          customer={customersList.find((item) => item.id === selected.customerId) ?? null}
          apiClient={apiClient}
          backendStatus={backendStatus}
        />
        <div className="detail-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setSelectedCustomerId(selected.customerId);
              setActive("customer");
            }}
          >
            查看客户画像
          </button>
          <ManualConfirmBox
            compact
            title="手动生成商机推进建议"
            desc="结合当前商机整理预算路径、竞品应对和售前支持建议。"
            onGenerate={() =>
              generateBusinessSuggestion(apiClient, backendStatus, {
                type: "opportunity_push",
                title: "手动生成商机推进建议",
                context: {
                  opportunityId: selected.id,
                  opportunity: selected.name,
                  customerId: selected.customerId,
                  customer: selected.customer,
                  stage: selected.stage,
                  amount: selected.amount,
                  probability: selected.probability,
                  owner: selected.owner,
                  requirements: joinedList(selected.requirements),
                  competitors: joinedList(selected.competitors),
                  solutionDirection: joinedList(selected.solutionDirection),
                  risk: selected.risk,
                  next: selected.next,
                  sourceRecord: selected.sourceRecord,
                },
              })
            }
          />
        </div>
          </>
        )}
      </section>
    </section>
  );
}
