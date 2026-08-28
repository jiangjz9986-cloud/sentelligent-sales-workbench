import {
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

const actionStatusMeta = {
  pending: { label: "待处理", tone: "blue", message: "动作已保留在待处理队列。" },
  in_progress: { label: "处理中", tone: "amber", message: "动作已进入处理中，周报会按推进项呈现。" },
  done: { label: "已完成", tone: "green", message: "动作已标记完成，可进入周报结果。" },
  deferred: { label: "已延期", tone: "amber", message: "动作已延期，请确认新的负责人和时间。" },
};

export function ActionsPage({
  items = [],
  selected,
  onSelect,
  setActive,
  viewMode = "list",
  setViewMode,
  onUpdateActionStatus,
  onDeleteAction,
  backendStatus,
}) {
  const current = selected ?? items[0] ?? null;
  const [searchText, setSearchText] = useState("");
  const currentStatus = actionStatusMeta[current?.status] ?? actionStatusMeta.pending;
  const isEditView = viewMode === "edit";
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "");
  const [statusMessage, setStatusMessage] = useState("确认负责人和时间后，可更新动作处理状态。");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.title, item.customer, item.reason, item.due, item.priority, item.status, item.assignee].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  useEffect(() => {
    setAssignee(current?.assignee ?? "继振");
    setDue(current?.due ?? "");
    setStatusMessage("确认负责人和时间后，可更新动作处理状态。");
  }, [current?.id, current?.assignee, current?.due]);

  async function updateAction(status) {
    if (!current?.id || !onUpdateActionStatus) return;
    setStatusMessage("正在更新动作状态");
    try {
      const updated = await onUpdateActionStatus(current.id, {
        status,
        due,
        assignee,
        tone: status === "done" ? "green" : status === "deferred" ? "amber" : "blue",
      });
      const meta = actionStatusMeta[updated.status] ?? actionStatusMeta.pending;
       setStatusMessage(`${meta.message}（已同步）`);
    } catch {
      setStatusMessage("动作更新失败，请稍后重试。");
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  async function deleteCurrentAction() {
    if (!current?.id || !onDeleteAction) return;
    if (!confirmDelete(`确认删除动作「${current.title}」？删除后将从动作列表移除。`)) return;
    try {
      await onDeleteAction(current.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除动作失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="action-list-view" data-testid="action-list-view">
        <Panel title="动作列表" meta={`${visibleItems.length} / ${items.length} 个动作`} className="list-panel action-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索动作"
              data-testid="actions-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索动作、客户、负责人、截止时间"
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
                    <small>{item.customer} / {item.due} / {actionStatusMeta[item.status]?.label ?? item.status}</small>
                  </span>
                  <b className={`pill ${statusTone[item.tone]}`}>{item.priority}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="actions-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无动作记录。" : "没有匹配动作，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="action-detail-view detail-scroll-view" data-testid="action-detail-view">
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
            data-testid="action-edit-detail"
            onClick={() => setViewMode?.("edit")}
          >
            <Pencil size={15} />
            修改
          </button>
          <button
            className="ghost-button danger"
            type="button"
            data-testid="action-delete-detail"
            onClick={deleteCurrentAction}
          >
            <Trash2 size={15} />
            删除
          </button>
        </div>
      </div>
      <section className="detail-surface">
        <div className="detail-metrics">
          <MetricInline label="客户" value={current.customer} />
          <MetricInline label="负责人" value={current.assignee ?? "待分配"} />
          <MetricInline label="截止" value={current.due} />
          <MetricInline label="状态" value={currentStatus.label} />
        </div>
        {isEditView ? (
        <Panel title="动作落地处理" meta="销售人工更新">
          <div className="editor-grid two">
            <label className="form-field">
              <span>负责人</span>
              <input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
            </label>
            <label className="form-field">
              <span>下一次时间</span>
              <input value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <div className="risk-status-toolbar action-status-toolbar" data-testid="action-status-toolbar">
            <span className={`pill tone-${currentStatus.tone}`}>{currentStatus.label}</span>
            <button
              className={current.status === "in_progress" ? "ghost-button disabled" : "ghost-button"}
              disabled={current.status === "in_progress"}
              type="button"
              onClick={() => updateAction("in_progress")}
            >
              开始处理
            </button>
            <button
              className={current.status === "deferred" ? "ghost-button disabled" : "ghost-button"}
              disabled={current.status === "deferred"}
              type="button"
              onClick={() => updateAction("deferred")}
            >
              延期跟进
            </button>
            <button
              className={current.status === "done" ? "ghost-button disabled" : "primary-button"}
              disabled={current.status === "done"}
              type="button"
              onClick={() => updateAction("done")}
            >
              标记完成
            </button>
          </div>
          <p className="risk-status-message">{statusMessage}</p>
          <button className="primary-button" type="button" onClick={() => setActive("weekly")}>
            写入本周计划
          </button>
          <button className="ghost-button" type="button" onClick={() => setViewMode?.("detail")}>
            取消修改
          </button>
        </Panel>
        ) : (
          <>
            <div className="two-col">
              <Panel title="动作说明" meta={current.priority}>
                <ExpandableInsight
                  testId="action-reason-insight"
                  expandedTestId="action-reason-expanded"
                  ariaLabel="展开动作说明"
                  detail="已展开动作说明：如需调整负责人、时间或状态，请点击修改。"
                >
                  {current.reason ?? "暂无动作说明。"}
                </ExpandableInsight>
              </Panel>
              <Panel title="执行安排" meta="只读详情">
                <InfoList
                  items={[
                    `负责人：${current.assignee ?? "待分配"}`,
                    `截止时间：${current.due ?? "待确认"}`,
                    `当前状态：${currentStatus.label}`,
                  ]}
                  tone="blue"
                />
              </Panel>
            </div>
            <button className="primary-button" type="button" onClick={() => setActive("weekly")}>
              写入本周计划
            </button>
          </>
        )}
      </section>
    </section>
  );
}
