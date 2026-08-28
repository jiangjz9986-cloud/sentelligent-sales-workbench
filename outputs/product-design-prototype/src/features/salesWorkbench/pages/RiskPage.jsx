import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { statusTone } from "../../../data/salesWorkbenchData.js";
import {
  ExpandableInsight,
  InfoList,
  MetricInline,
  Panel,
} from "../../../components/primitives.jsx";
import { confirmDelete, showOperationError } from "./shared.jsx";

const riskStatusMeta = {
  open: { label: "待确认", tone: "tone-amber", helper: "先确认风险是否真实影响商机推进。" },
  accepted: { label: "已确认", tone: "tone-blue", helper: "风险已纳入跟进，需要明确处理责任。" },
  in_progress: { label: "处理中", tone: "tone-teal", helper: "处理中风险需要持续跟踪证据和下一步动作。" },
  deferred: { label: "已延期", tone: "tone-amber", helper: "风险处理已顺延，需要明确下一次处理时间。" },
  closed: { label: "已关闭", tone: "tone-green", helper: "风险已关闭，后续只保留追溯记录。" },
};

function riskStatusLabel(status) {
  return riskStatusMeta[status]?.label ?? status ?? "待确认";
}

const riskStatusActions = [
  { status: "accepted", label: "确认风险", tone: "blue", note: "风险已由销售确认，进入跟进队列。" },
  { status: "in_progress", label: "开始处理", tone: "teal", note: "风险处理中：已安排销售和售前共同补齐证据与处理动作。" },
  { status: "deferred", label: "延期处理", tone: "amber", note: "客户会议延期，风险处理顺延到下一次确认时间。" },
  { status: "closed", label: "关闭风险", tone: "green", note: "风险已关闭：处理结果已确认，保留来源追溯。" },
];

const riskSourceLabels = {
  quick_record: "快速记录",
  opportunity_diagnosis: "商机诊断",
  manual_audit: "人工评估",
  opportunity: "商机档案",
};

function riskSourceLabel(sourceType) {
  if (!sourceType) return "手动";
  return riskSourceLabels[sourceType] ?? "业务记录";
}

export function RiskPage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
  onUpdateRiskStatus,
  onDeleteRisk,
  backendStatus,
}) {
  const current = selected ?? items[0] ?? null;
  const [searchText, setSearchText] = useState("");
  const isEditView = viewMode === "edit";
  const [statusMessage, setStatusMessage] = useState("选择风险后，可人工确认、开始处理或关闭。");
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "待确认");
  const currentStatus = riskStatusMeta[current?.status] ?? riskStatusMeta.open;
  const sourceLabel = riskSourceLabel(current?.sourceType);
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.title, item.target, item.evidence, item.action, item.severity, item.status, item.assignee].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  useEffect(() => {
    setAssignee(current?.assignee ?? "继振");
    setDue(current?.due ?? "待确认");
  }, [current?.id, current?.assignee, current?.due]);

  async function updateStatus(action) {
    if (!current?.id) return;
    setStatusMessage("保存风险状态中");
    try {
      await onUpdateRiskStatus(current.id, {
        status: action.status,
        action: action.note,
        assignee: assignee.trim() || "待分配",
        due: due.trim() || "待确认",
        tone: action.tone,
      });
      setStatusMessage("风险状态已保存");
    } catch (error) {
      setStatusMessage(error.message || "风险状态保存失败");
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  async function deleteCurrentRisk() {
    if (!current?.id || !onDeleteRisk) return;
    if (!confirmDelete(`确认删除风险「${current.title}」？删除后将从风险列表移除。`)) return;
    try {
      await onDeleteRisk(current.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除风险失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="risk-list-view" data-testid="risk-list-view">
        <Panel title="风险列表" meta={`${visibleItems.length} / ${items.length} 个风险`} className="list-panel risk-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索风险"
              data-testid="risk-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索风险、客户、证据、负责人"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${current?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.target} / {riskStatusLabel(item.status)}</small>
                  </span>
                  <b className={`score-chip ${statusTone[item.tone]}`}>{item.score}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="risk-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无风险记录。" : "没有匹配风险，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="risk-detail-view detail-scroll-view" data-testid="risk-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        <div className="detail-toolbar-actions">
          <button
            className={isEditView ? "ghost-button disabled" : "ghost-button"}
            disabled={isEditView}
            type="button"
            data-testid="risk-edit-detail"
            onClick={() => setViewMode?.("edit")}
          >
            <Pencil size={15} />
            修改
          </button>
          <button
            className="ghost-button danger"
            type="button"
            data-testid="risk-delete-detail"
            onClick={deleteCurrentRisk}
          >
            <Trash2 size={15} />
            删除
          </button>
        </div>
      </div>
      <section className="detail-surface">
        <div className="detail-metrics">
          <MetricInline label="状态" value={currentStatus.label} />
          <MetricInline label="严重度" value={current.severity ?? "中"} />
          <MetricInline label="分值" value={`${current.score}`} />
          <MetricInline label="来源" value={sourceLabel} />
          <MetricInline label="负责人" value={current.assignee ?? "待分配"} />
          <MetricInline label="下次处理" value={current.due ?? "待确认"} />
        </div>
        <div className="risk-meter">
          <span style={{ width: `${current.score}%` }} />
        </div>
        {isEditView ? (
        <Panel title="状态流转" meta={currentStatus.helper}>
          <div className="editor-grid two risk-owner-grid">
            <label className="form-field">
              <span>负责人</span>
              <input data-testid="risk-assignee-input" value={assignee} onChange={(event) => setAssignee(event.target.value)} />
            </label>
            <label className="form-field">
              <span>下次处理时间</span>
              <input data-testid="risk-due-input" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <div className="risk-status-toolbar" data-testid="risk-status-toolbar">
            <span className={`pill ${currentStatus.tone}`}>{currentStatus.label}</span>
            {riskStatusActions.map((action) => (
              <button
                className={current.status === action.status ? "ghost-button disabled" : "ghost-button"}
                disabled={current.status === action.status}
                key={action.status}
                type="button"
                data-testid={`risk-action-${action.status}`}
                onClick={() => updateStatus(action)}
              >
                {action.status === "deferred" ? <CalendarClock size={15} /> : <Check size={15} />}
                {action.label}
              </button>
            ))}
          </div>
          <p className="risk-status-message">{statusMessage}</p>
          <button className="ghost-button" type="button" onClick={() => setViewMode?.("detail")}>
            取消修改
          </button>
        </Panel>
        ) : (
          <Panel title="处理状态" meta={currentStatus.helper}>
            <InfoList
              items={[
                `负责人：${current.assignee ?? "待分配"}`,
                `下次处理：${current.due ?? "待确认"}`,
                `当前状态：${currentStatus.label}`,
              ]}
              tone="blue"
            />
          </Panel>
        )}
        <Panel title="证据" meta={current.sourceType ? `来源：${sourceLabel}` : "来自快速记录与周报字段"}>
          <ExpandableInsight
            tone="amber"
            testId="risk-evidence-insight"
            expandedTestId="risk-evidence-expanded"
            ariaLabel="展开风险证据"
            detail="已展开证据：可用于复核来源记录、周报字段和商机风险判断。"
          >
            {current.evidence ?? "尚未补充证据，可从快速记录、客户反馈或周报字段中确认来源。"}
          </ExpandableInsight>
        </Panel>
        <Panel title="建议处理" meta="人工确认">
          <ExpandableInsight
            testId="risk-action-insight"
            expandedTestId="risk-action-expanded"
            ariaLabel="展开风险处理建议"
            detail="已展开建议处理：确认后可在上方状态流转中分配负责人、延期处理或关闭风险。"
          >
            {current.action ?? "尚未生成处理建议，可先分配负责人并记录下一次处理时间。"}
          </ExpandableInsight>
        </Panel>
      </section>
    </section>
  );
}
