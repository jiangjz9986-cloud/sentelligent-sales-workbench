import {
  CalendarClock,
  Check,
} from "lucide-react";
import { useEffect, useState } from "react";
import { statusTone } from "../../../data/salesWorkbenchData.js";
import {
  ExpandableInsight,
  InfoList,
  MetricInline,
  Panel,
} from "../../../components/primitives.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";
import { EntityWorkspace } from "./EntityWorkspace.jsx";

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

const riskConfig = {
  listViewTestId: "risk-list-view",
  detailViewTestId: "risk-detail-view",
  listViewClassName: "risk-list-view",
  detailViewClassName: "risk-detail-view detail-scroll-view",
  listPanelClassName: "list-panel risk-list-panel",
  panelTitle: "风险列表",
  listMeta: (visible, total) => `${visible} / ${total} 个风险`,
  searchAriaLabel: "搜索风险",
  searchTestId: "risk-local-search",
  searchPlaceholder: "搜索风险、客户、证据、负责人",
  searchFields: ["title", "target", "evidence", "action", "severity", "status", "assignee"],
  openDetailTestId: "risk-open-detail",
  editDetailTestId: "risk-edit-detail",
  deleteDetailTestId: "risk-delete-detail",
  emptyNoItems: "暂无风险记录。",
  emptyNoMatch: "没有匹配风险，请调整关键词。",
  rowPrimary: (item) => item.title,
  rowSecondary: (item) => `${item.target} / ${riskStatusLabel(item.status)}`,
  renderRowBadge: (item) => <b className={`score-chip ${statusTone[item.tone]}`}>{item.score}</b>,
  deleteDialog: {
    title: "确认删除风险",
    description: (selected) => `“${selected?.title ?? "当前风险"}”将从风险列表中移除，此操作不能撤销。`,
    entityName: (selected) => selected.title,
    testIdPrefix: "risk-delete",
    successTitle: "风险已删除",
    errorMessage: "删除风险失败，请稍后重试。",
  },
};

function RiskDetailBody({ selected, viewMode, setViewMode, onUpdateRiskStatus, backendStatus }) {
  const current = selected;
  const isEditView = viewMode === "edit";
  const [statusMessage, setStatusMessage] = useState("选择风险后，可人工确认、开始处理或关闭。");
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "待确认");
  const currentStatus = riskStatusMeta[current?.status] ?? riskStatusMeta.open;
  const sourceLabel = riskSourceLabel(current?.sourceType);

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

  return (
    <>
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
        <ExpandableInsight tone="amber" testId="risk-evidence-insight">
          {current.evidence ?? "尚未补充证据，可从快速记录、客户反馈或周报字段中确认来源。"}
        </ExpandableInsight>
      </Panel>
      <Panel title="建议处理" meta="人工确认">
        <ExpandableInsight testId="risk-action-insight">
          {current.action ?? "尚未生成处理建议，可先分配负责人并记录下一次处理时间。"}
        </ExpandableInsight>
      </Panel>
    </>
  );
}

export function RiskPage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
}) {
  const current = selected ?? items[0] ?? null;
  const { backendStatus } = useWorkbenchData();
  const { handleUpdateRiskStatus, handleDeleteRisk } = useWorkbenchActions();

  return (
    <EntityWorkspace
      items={items}
      selected={current}
      activeRowId={current?.id}
      onSelect={onSelect}
      viewMode={viewMode}
      setViewMode={setViewMode}
      config={riskConfig}
      onDelete={handleDeleteRisk}
      renderDetail={({ viewMode: mode }) => (
        <RiskDetailBody
          selected={current}
          viewMode={mode}
          setViewMode={setViewMode}
          onUpdateRiskStatus={handleUpdateRiskStatus}
          backendStatus={backendStatus}
        />
      )}
    />
  );
}
