import {
  CalendarClock,
  Check,
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
  MetricInline,
  Panel,
} from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import { datetimeLocalFromIso, isoFromDatetimeLocal } from "../datetimeLocal.js";
import { ConfirmDialog, FormField } from "./shared.jsx";

const actionStatusMeta = {
  pending: { label: "待处理", tone: "blue", message: "动作已保留在待处理队列。" },
  in_progress: { label: "处理中", tone: "amber", message: "动作已进入处理中，周报会按推进项呈现。" },
  done: { label: "已完成", tone: "green", message: "动作已标记完成，可进入周报结果。" },
  deferred: { label: "已延期", tone: "amber", message: "动作已延期，请确认新的负责人和时间。" },
};

function formatRemindDisplay(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function RemindAtField({ value, onChange }) {
  return (
    <FormField label="提醒时间">
      <span className="remind-field">
        <input
          type="datetime-local"
          data-testid="action-remind-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {value ? (
          <button
            className="ghost-button"
            type="button"
            data-testid="action-remind-clear"
            onClick={(event) => {
              event.preventDefault();
              onChange("");
            }}
          >
            清除
          </button>
        ) : null}
      </span>
    </FormField>
  );
}

function ActionCreateForm({ customersList = [], onCreateAction, onSaved, onCancel }) {
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [priority, setPriority] = useState("中");
  const [due, setDue] = useState("");
  const [remindLocal, setRemindLocal] = useState("");
  const [saveStatus, setSaveStatus] = useState("就绪");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function submit(event) {
    event.preventDefault();
    if (!title.trim()) {
      setSaveStatus("待办标题不能为空");
      return;
    }
    setSaving(true);
    setSaveStatus("保存中");
    try {
      const saved = await onCreateAction({
        title: title.trim(),
        customerId: customerId || null,
        priority,
        due: due.trim() || null,
        remindAt: isoFromDatetimeLocal(remindLocal),
      });
      toast({ tone: "success", title: "待办已创建", description: saved.title });
      onSaved?.(saved);
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-panel" data-testid="action-create-form" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">待办维护</span>
          <strong>新增待办</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="action-cancel-create" onClick={onCancel}>
            <ChevronLeft size={16} />
            取消新增
          </button>
          <button className="primary-button" type="submit" data-testid="action-submit-create" disabled={saving}>
            <Save size={16} />
            {saving ? "创建中" : "创建待办"}
          </button>
        </div>
      </div>
      <div className="editor-grid two">
        <FormField label="标题">
          <input
            data-testid="action-create-title"
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="要跟进的一件事"
          />
        </FormField>
        <FormField label="客户">
          <select
            data-testid="action-create-customer"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          >
            <option value="">暂不关联客户</option>
            {customersList.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="优先级">
          <select
            data-testid="action-create-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="高">高</option>
            <option value="中">中</option>
            <option value="低">低</option>
          </select>
        </FormField>
        <FormField label="截止说明">
          <input
            value={due}
            onChange={(event) => setDue(event.target.value)}
            placeholder="如：周五 17:00 前"
          />
        </FormField>
      </div>
      <RemindAtField value={remindLocal} onChange={setRemindLocal} />
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

export function ActionsPage({
  items = [],
  selected,
  onSelect,
  setActive,
  viewMode = "list",
  setViewMode,
  onUpdateActionStatus,
  onCreateAction,
  onDeleteAction,
  customersList = [],
  backendStatus,
}) {
  const current = selected ?? items[0] ?? null;
  const toast = useToast();
  const [searchText, setSearchText] = useState("");
  const currentStatus = actionStatusMeta[current?.status] ?? actionStatusMeta.pending;
  const isEditView = viewMode === "edit";
  const isCreateView = viewMode === "create";
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "");
  const [remindLocal, setRemindLocal] = useState(() => datetimeLocalFromIso(current?.remindAt));
  const [statusMessage, setStatusMessage] = useState("确认负责人和时间后，可更新动作处理状态。");
  // 行内快捷操作的乐观覆盖层：成功由 mergeById 落真值，失败即回滚原状态。
  const [optimisticStatus, setOptimisticStatus] = useState({});
  const [pendingQuickIds, setPendingQuickIds] = useState(() => new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
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
    setRemindLocal(datetimeLocalFromIso(current?.remindAt));
    setStatusMessage("确认负责人和时间后，可更新动作处理状态。");
  }, [current?.id, current?.assignee, current?.due, current?.remindAt]);

  function markQuickPending(id, pending) {
    setPendingQuickIds((currentIds) => {
      const next = new Set(currentIds);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function quickPatch(item, status) {
    if (!item?.id || !onUpdateActionStatus || pendingQuickIds.has(item.id)) return;
    setOptimisticStatus((map) => ({ ...map, [item.id]: status }));
    markQuickPending(item.id, true);
    try {
      await onUpdateActionStatus(item.id, {
        status,
        tone: status === "done" ? "green" : "amber",
      });
      toast({ tone: "success", title: status === "done" ? "待办已完成" : "待办已延期", description: item.title });
    } catch (error) {
      toast({ tone: "error", title: "待办更新失败", description: error.message || "请稍后重试" });
    } finally {
      setOptimisticStatus((map) => {
        const next = { ...map };
        delete next[item.id];
        return next;
      });
      markQuickPending(item.id, false);
    }
  }

  async function updateAction(status) {
    if (!current?.id || !onUpdateActionStatus) return;
    setStatusMessage("正在更新动作状态");
    const patch = {
      status,
      due,
      assignee,
      tone: status === "done" ? "green" : status === "deferred" ? "amber" : "blue",
    };
    // 只有提醒时间被真正改动时才随补丁提交，避免无关状态更新重置提醒标记。
    if (remindLocal !== datetimeLocalFromIso(current?.remindAt)) {
      patch.remindAt = isoFromDatetimeLocal(remindLocal);
    }
    try {
      const updated = await onUpdateActionStatus(current.id, patch);
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

  function requestDeleteCurrentAction() {
    if (!current?.id || !onDeleteAction) return;
    setDeleteError("");
    setDeleteDialogOpen(true);
  }

  async function confirmDeleteCurrentAction() {
    if (!current?.id || !onDeleteAction || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const deletedTitle = current.title;
      await onDeleteAction(current.id);
      setDeleteDialogOpen(false);
      setViewMode?.("list");
      toast({ tone: "success", title: "待办已删除", description: deletedTitle });
    } catch (error) {
      setDeleteError(error.message || "删除动作失败，请稍后重试。");
    } finally {
      setDeleteBusy(false);
    }
  }

  if (viewMode === "list") {
    return (
      <section className="action-list-view" data-testid="action-list-view">
        <Panel
          title="动作列表"
          meta={`${visibleItems.length} / ${items.length} 个动作`}
          className="list-panel action-list-panel"
          action={(
            <button
              className="primary-button"
              type="button"
              data-testid="actions-create-detail"
              onClick={() => setViewMode?.("create")}
            >
              <Plus size={16} />
              新增待办
            </button>
          )}
        >
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
            {visibleItems.map((item) => {
              const rowStatus = optimisticStatus[item.id] ?? item.status;
              const rowMeta = actionStatusMeta[rowStatus] ?? actionStatusMeta.pending;
              const rowPending = pendingQuickIds.has(item.id);
              const rowTone = optimisticStatus[item.id]
                ? (rowStatus === "done" ? "green" : "amber")
                : item.tone;
              return (
                <article
                  className={`list-button customer-list-row action-list-row ${current?.id === item.id ? "selected" : ""}`}
                  key={item.id}
                >
                  <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.customer} / {item.due} / {rowMeta.label}</small>
                    </span>
                    <span className="list-row-pills">
                      <b className={`pill ${statusTone[rowTone]}`}>{item.priority}</b>
                      <b className={`pill tone-${rowMeta.tone}`}>{rowMeta.label}</b>
                    </span>
                  </button>
                  <div className="list-row-quick-actions">
                    {rowStatus !== "done" ? (
                      <button
                        className="ghost-button compact-icon"
                        type="button"
                        data-testid="action-quick-complete"
                        disabled={rowPending}
                        onClick={() => quickPatch(item, "done")}
                      >
                        <Check size={15} />
                        完成
                      </button>
                    ) : null}
                    {["pending", "in_progress"].includes(rowStatus) ? (
                      <button
                        className="ghost-button compact-icon"
                        type="button"
                        data-testid="action-quick-defer"
                        disabled={rowPending}
                        onClick={() => quickPatch(item, "deferred")}
                      >
                        <CalendarClock size={15} />
                        延期
                      </button>
                    ) : null}
                    <button
                      className="ghost-button"
                      type="button"
                      data-testid="actions-open-detail"
                      onClick={() => openDetail(item)}
                    >
                      查看详情
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
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

  if (isCreateView) {
    return (
      <section className="action-detail-view detail-scroll-view" data-testid="action-create-view">
        <div className="subview-actions sticky-subview-toolbar">
          <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
            <ChevronLeft size={16} />
            返回列表
          </button>
        </div>
        <section className="detail-surface">
          <ActionCreateForm
            customersList={customersList}
            onCreateAction={onCreateAction}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.("list")}
          />
        </section>
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
            onClick={requestDeleteCurrentAction}
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
          <RemindAtField value={remindLocal} onChange={setRemindLocal} />
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
                <ExpandableInsight testId="action-reason-insight">
                  {current.reason ?? "暂无动作说明。"}
                </ExpandableInsight>
              </Panel>
              <Panel title="执行安排" meta="只读详情">
                <InfoList
                  items={[
                    `负责人：${current.assignee ?? "待分配"}`,
                    `截止时间：${current.due ?? "待确认"}`,
                    `提醒时间：${formatRemindDisplay(current.remindAt) ?? "未设置"}`,
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
      <ConfirmDialog
        open={deleteDialogOpen}
        title="确认删除待办"
        description={`“${current?.title ?? "当前待办"}”将从动作列表中移除，此操作不能撤销。`}
        busy={deleteBusy}
        errorMessage={deleteError}
        onCancel={() => {
          if (deleteBusy) return;
          setDeleteError("");
          setDeleteDialogOpen(false);
        }}
        onConfirm={confirmDeleteCurrentAction}
        testIdPrefix="action-delete"
      />
    </section>
  );
}
