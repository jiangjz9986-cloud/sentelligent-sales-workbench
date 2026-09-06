import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { Panel } from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import {
  PROACTIVE_LIFECYCLE,
  PROACTIVE_LIFECYCLE_META,
  PROACTIVE_LIFECYCLE_ORDER,
  buildProactiveLifecycleCounts,
  buildProactiveReviewPreview,
  formatProactiveConfidence,
  lifecycleActionTargets,
  mergeProactiveSuggestionItems,
  normalizeProactiveEditableFields,
  normalizeProactiveLifecycleStatus,
  proactiveSourceLabel,
  proactiveAssistantRevision,
  proactiveLifecycleFingerprint,
  proactiveSuggestionRevision,
  scopeProactiveAssistant,
} from "./proactiveAssistantModel.js";
import {
  latestNotificationForSuggestion,
  proactiveNotificationCounts,
  proactiveNotificationIsUnread,
  proactiveNotificationStatusMeta,
  replaceProactiveNotification,
} from "./proactiveNotificationModel.js";
import "./ProactiveAssistantPanel.css";

const TRIGGER_LABELS = Object.freeze({
  missing_next_step: "缺少下一步",
  stale_opportunity: "长期无互动",
  stage_evidence_mismatch: "阶段证据不匹配",
  budget_unknown: "预算待补",
  decision_chain_unknown: "决策链待补",
  purchase_timing_unknown: "采购时间待补",
  action_due: "行动到期",
  risk_open: "风险未闭环",
  visit_follow_up: "拜访待跟进",
  tender_change: "招标有变化",
});

const LIFECYCLE_ACTION_LABELS = Object.freeze({
  [PROACTIVE_LIFECYCLE.PENDING]: "重新纳入待处理",
  [PROACTIVE_LIFECYCLE.DEFERRED]: "稍后处理",
  [PROACTIVE_LIFECYCLE.IGNORED]: "忽略建议",
  [PROACTIVE_LIFECYCLE.RESOLVED]: "标记已解决",
  [PROACTIVE_LIFECYCLE.CONFIRMED]: "标记已确认",
  [PROACTIVE_LIFECYCLE.EXECUTED]: "标记已执行",
  [PROACTIVE_LIFECYCLE.CONFLICT]: "标记冲突",
  [PROACTIVE_LIFECYCLE.FAILED]: "标记失败",
});

const LIFECYCLE_SHORT_LABELS = Object.freeze({
  [PROACTIVE_LIFECYCLE.PENDING]: "待处理",
  [PROACTIVE_LIFECYCLE.DEFERRED]: "稍后",
  [PROACTIVE_LIFECYCLE.IGNORED]: "忽略",
  [PROACTIVE_LIFECYCLE.RESOLVED]: "已解决",
  [PROACTIVE_LIFECYCLE.CONFIRMED]: "已确认",
  [PROACTIVE_LIFECYCLE.EXECUTED]: "已执行",
  [PROACTIVE_LIFECYCLE.CONFLICT]: "冲突",
  [PROACTIVE_LIFECYCLE.FAILED]: "失败",
});

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "待确认";
  return String(value);
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function formatDateTime(value) {
  const raw = textValue(value);
  if (!raw) return "更新时间待回读";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return `更新时间 ${raw}`;
  return `更新于 ${date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function itemUpdatedAt(item) {
  return firstPresent(
    item?.statusUpdatedAt,
    item?.lifecycleUpdatedAt,
    item?.updatedAt,
    item?.trigger?.detectedAt,
    item?.createdAt,
  );
}

function itemExpectedVersion(item) {
  return firstPresent(
    item?.lifecycleVersion,
    item?.version,
    item?.lifecycle?.version,
    item?.updatedAt,
    item?.statusUpdatedAt,
    item?.id,
  );
}

function getConfirmationPreviewMap(item) {
  const previews = item?.confirmationPreviews;
  if (!previews || typeof previews !== "object" || Array.isArray(previews)) return {};
  return Object.fromEntries(
    Object.entries(previews).filter(([, preview]) => preview && typeof preview === "object"),
  );
}

function getPreviewTarget(item, target) {
  return item?.writebackPreview?.[target]
    ?? item?.preview?.[target]
    ?? item?.confirmationPreview?.[target]
    ?? null;
}

function writebackErrorMessage(error) {
  if (error?.status === 409 || error?.code === "CONFLICT" || error?.code === "VERSION_CONFLICT") {
    return "商机数据刚刚发生变化，已刷新最新数据，请重新确认。";
  }
  if (error?.status === 401 || error?.code === "AUTH_REQUIRED") {
    return "登录状态已失效，请重新登录后再确认。";
  }
  return error?.message || "创建失败，请稍后重试。";
}

function lifecycleErrorMessage(error) {
  if (error?.status === 409 || error?.code === "CONFLICT" || error?.code === "VERSION_CONFLICT") {
    return "建议版本已变化，请刷新后重新处理。";
  }
  if (error?.status === 401 || error?.code === "AUTH_REQUIRED") {
    return "登录状态已失效，请重新登录后再处理。";
  }
  return error?.message || "状态保存失败，请稍后重试。";
}

function writebackStatusView(state) {
  if (state?.status === "pending") return { label: "正在创建…", tone: "tone-amber" };
  if (state?.status === "success") {
    return state.replayed
      ? { label: "已存在，没有重复创建", tone: "tone-blue" }
      : { label: "已创建并同步", tone: "tone-green" };
  }
  if (state?.status === "error") return { label: state.message, tone: "tone-red" };
  return { label: "待人工确认", tone: "tone-amber" };
}

function ListSection({ title, icon: Icon, items, className = "" }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <section className={`proactive-assistant-section ${className}`}>
      <h5><Icon size={14} />{title}</h5>
      <ul>
        {items.slice(0, 4).map((item, index) => {
          const value = typeof item === "string"
            ? item
            : item?.claim ?? item?.question ?? item?.title ?? item?.detail ?? item?.reason ?? "";
          if (!value) return null;
          return <li key={`${title}-${index}`}>{value}</li>;
        })}
      </ul>
    </section>
  );
}

function WritebackConfirmation({ target, preview, state, onConfirm }) {
  if (!preview) return null;
  const targetLabel = target === "risk" ? "风险" : "行动";
  const status = writebackStatusView(state);
  const pending = state?.status === "pending";
  const completed = state?.status === "success";
  return (
    <div className="proactive-assistant-card-actions proactive-assistant-writeback-control">
      <button
        type="button"
        className={completed ? "ghost-button disabled" : "primary-button"}
        data-testid={`proactive-confirm-${target}`}
        disabled={pending || completed}
        onClick={onConfirm}
      >
        {pending ? `创建${targetLabel}中` : completed ? `已确认${targetLabel}` : `确认创建${targetLabel}`}
      </button>
      <span
        className={`pill ${status.tone}`}
        data-testid={`proactive-${target}-status`}
        aria-live="polite"
      >
        {status.label}
      </span>
    </div>
  );
}

function ProactiveNotificationState({ match, readState, onMarkRead }) {
  const notification = match?.item;
  if (!notification) return null;
  const meta = proactiveNotificationStatusMeta(notification);
  const unread = proactiveNotificationIsUnread(notification);
  const busy = readState?.status === "pending";
  return (
    <section
      className="proactive-notification-state"
      data-testid={`proactive-notification-state-${notification.suggestionId}`}
      aria-label="建议通知状态"
    >
      <Bell size={14} aria-hidden="true" />
      <span className={`pill tone-${meta.tone}`} data-testid="proactive-notification-delivery-status">
        {meta.channelLabel} · {meta.label}
      </span>
      <strong data-testid="proactive-notification-read-status">{unread ? "未读" : "已读"}</strong>
      {!match.currentRevision ? <small>建议版本 {notification.suggestionVersion} 的历史通知</small> : null}
      {unread && onMarkRead ? (
        <button
          type="button"
          className="ghost-button"
          data-testid={`proactive-notification-mark-read-${notification.id}`}
          disabled={busy}
          onClick={() => onMarkRead(notification)}
        >
          {busy ? "保存中" : "标记通知已读"}
        </button>
      ) : null}
      {readState?.status === "error" ? <small className="tone-red">已读状态保存失败，请重试。</small> : null}
    </section>
  );
}

function ProactiveReviewFields({ suggestionId, fields, disabled, onChange }) {
  return (
    <div className="proactive-assistant-edit-grid" data-testid="proactive-assistant-edit-fields">
      <label className="proactive-assistant-edit-field">
        <span>负责人</span>
        <input
          id={`proactive-owner-${suggestionId}`}
          data-testid={`proactive-owner-input-${suggestionId}`}
          aria-label="负责人"
          value={fields.owner}
          onChange={(event) => onChange("owner", event.target.value)}
          disabled={disabled}
          placeholder="待确认"
        />
      </label>
      <label className="proactive-assistant-edit-field">
        <span>跟进日期</span>
        <input
          id={`proactive-due-date-${suggestionId}`}
          data-testid={`proactive-due-date-input-${suggestionId}`}
          aria-label="跟进日期"
          type="date"
          value={fields.dueDate}
          onChange={(event) => onChange("dueDate", event.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="proactive-assistant-edit-field">
        <span>优先级</span>
        <select
          id={`proactive-priority-${suggestionId}`}
          data-testid={`proactive-priority-input-${suggestionId}`}
          aria-label="优先级"
          value={fields.priority}
          onChange={(event) => onChange("priority", event.target.value)}
          disabled={disabled}
        >
          <option value="高">高</option>
          <option value="中">中</option>
          <option value="低">低</option>
        </select>
      </label>
      <label className="proactive-assistant-edit-field proactive-assistant-edit-field-wide">
        <span>预期结果</span>
        <input
          id={`proactive-expected-result-${suggestionId}`}
          data-testid={`proactive-expected-result-input-${suggestionId}`}
          aria-label="预期结果"
          value={fields.expectedResult}
          onChange={(event) => onChange("expectedResult", event.target.value)}
          disabled={disabled}
          placeholder="例如：完成阶段证据确认"
        />
      </label>
    </div>
  );
}

function ProactiveSuggestion({
  item,
  localOverride,
  onOpenOpportunity,
  onCreatePreview,
  onConfirmWriteback,
  onLifecycleChange,
  onUpdateSuggestion,
  onLocalChange,
  hasLifecyclePersistence,
  hasFieldPersistence,
  notificationMatch,
  notificationReadState,
  onMarkNotificationRead,
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [writebackStates, setWritebackStates] = useState({});
  const [confirmationPreviews, setConfirmationPreviews] = useState(() => getConfirmationPreviewMap(item));
  const [previewStates, setPreviewStates] = useState({});
  const [lifecycleState, setLifecycleState] = useState(null);
  const [fieldState, setFieldState] = useState(null);
  const [reviewFieldDraft, setReviewFieldDraft] = useState(null);
  const toast = useToast();
  const fieldsFromItem = normalizeProactiveEditableFields(item);
  const fieldsFingerprint = JSON.stringify(fieldsFromItem);
  const reviewFields = reviewFieldDraft ?? fieldsFromItem;
  const currentStatus = normalizeProactiveLifecycleStatus(item);
  const currentMeta = PROACTIVE_LIFECYCLE_META[currentStatus] ?? PROACTIVE_LIFECYCLE_META.pending;
  const expectedVersion = itemExpectedVersion(item);
  const actionConfirmationPreview = confirmationPreviews.action;
  const riskConfirmationPreview = confirmationPreviews.risk;
  const actionPreview = actionConfirmationPreview?.preview ?? getPreviewTarget(item, "action");
  const riskPreview = riskConfirmationPreview?.preview ?? getPreviewTarget(item, "risk");
  const reviewPreview = buildProactiveReviewPreview(item, reviewFields);
  const facts = Array.isArray(item?.facts) ? item.facts : [];
  const evidence = Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [];
  const triggerLabel = TRIGGER_LABELS[item?.trigger?.type] ?? "主动提醒";
  const actionTargets = lifecycleActionTargets(currentStatus);
  const cardId = textValue(item?.id) || "unknown";
  const statusBusy = lifecycleState?.status === "pending";
  const fieldBusy = fieldState?.status === "pending";
  const localSource = localOverride?.source;
  const readbackLabel = localSource === "local"
    ? "本地预览"
    : localSource === "pending"
      ? "待服务端回读"
      : "服务端回读";

  useEffect(() => {
    setConfirmationPreviews(getConfirmationPreviewMap(item));
  }, [item?.id, item?.updatedAt, item?.lifecycleVersion, item?.statusUpdatedAt]);

  useEffect(() => {
    setFieldState(null);
    setReviewFieldDraft(null);
  }, [item?.id, fieldsFingerprint]);

  async function confirmWriteback(target, preview) {
    if (!onConfirmWriteback || !preview) return;
    const confirmationPreview = confirmationPreviews[target];
    if (!confirmationPreview?.id) {
      const message = "请先生成并保存本次确认预览。";
      setWritebackStates((current) => ({ ...current, [target]: { status: "error", message } }));
      toast({ tone: "error", title: "确认前需要预览", description: message });
      return;
    }
    setWritebackStates((current) => ({
      ...current,
      [target]: { status: "pending" },
    }));
    try {
      const outcome = await onConfirmWriteback({ item, target, preview, confirmationPreview });
      const replayed = outcome?.replayed === true || outcome?.status === "replayed";
      setWritebackStates((current) => ({
        ...current,
        [target]: { status: "success", replayed },
      }));
      onLocalChange?.({
        status: PROACTIVE_LIFECYCLE.EXECUTED,
        fields: reviewFields,
        source: "pending",
      });
      toast({
        tone: "success",
        title: replayed ? `${target === "risk" ? "风险" : "行动"}已存在` : `${target === "risk" ? "风险" : "行动"}已创建`,
        description: replayed ? "本次没有重复创建。" : "已同步到对应业务列表，等待服务端回读。",
      });
    } catch (error) {
      const message = writebackErrorMessage(error);
      setWritebackStates((current) => ({
        ...current,
        [target]: { status: "error", message },
      }));
      toast({ tone: "error", title: `创建${target === "risk" ? "风险" : "行动"}失败`, description: message });
    }
  }

  async function openPreview() {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    if (!onCreatePreview) return;
    const targets = [
      ["action", getPreviewTarget(item, "action")],
      ["risk", getPreviewTarget(item, "risk")],
    ].filter(([, preview]) => preview);
    await Promise.all(targets.map(async ([target]) => {
      setPreviewStates((current) => ({ ...current, [target]: { status: "pending" } }));
      try {
        const durablePreview = await onCreatePreview({
          item,
          target,
          fields: reviewFields,
          preview: reviewPreview,
          expectedVersion,
        });
        setConfirmationPreviews((current) => ({ ...current, [target]: durablePreview }));
        setPreviewStates((current) => ({ ...current, [target]: { status: "success" } }));
      } catch (error) {
        const message = writebackErrorMessage(error);
        setPreviewStates((current) => ({ ...current, [target]: { status: "error", message } }));
        toast({ tone: "error", title: "保存预览失败", description: message });
      }
    }));
  }

  async function changeLifecycle(status) {
    if (status === currentStatus || statusBusy) return;
    const payload = {
      item,
      status,
      previousStatus: currentStatus,
      fields: reviewFields,
      preview: buildProactiveReviewPreview(item, reviewFields),
      expectedVersion,
    };
    setLifecycleState({ status: "pending", target: status });
    try {
      const outcome = await onLifecycleChange?.(payload);
      onLocalChange?.({ status, fields: reviewFields, source: hasLifecyclePersistence ? "pending" : "local" });
      setLifecycleState({ status: "success", target: status });
      toast({
        tone: "success",
        title: `已${LIFECYCLE_SHORT_LABELS[status] ?? "更新状态"}`,
        description: hasLifecyclePersistence
          ? "状态已提交，刷新后以服务端回读为准。"
          : "当前为本地预览，宿主尚未接入生命周期持久化接口。",
      });
      return outcome;
    } catch (error) {
      const message = lifecycleErrorMessage(error);
      setLifecycleState({ status: "error", target: status, message });
      toast({ tone: "error", title: "状态保存失败", description: message });
      return null;
    }
  }

  async function saveReviewFields() {
    const fields = normalizeProactiveEditableFields({ ...item, ...reviewFields });
    const patch = {
      assignee: fields.owner,
      dueDate: fields.dueDate,
      priority: fields.priority,
      expectedResult: fields.expectedResult,
    };
    const payload = {
      item,
      patch,
      fields,
      status: currentStatus,
      preview: buildProactiveReviewPreview(item, fields),
      expectedVersion,
    };
    setFieldState({ status: "pending" });
    try {
      const outcome = await onUpdateSuggestion?.(payload);
      onLocalChange?.({ fields, source: hasFieldPersistence ? "pending" : "local" });
      setFieldState({ status: "success" });
      toast({
        tone: "success",
        title: "确认字段已更新",
        description: hasFieldPersistence
          ? "字段已提交，刷新后以服务端回读为准。"
          : "当前为本地预览，宿主尚未接入建议字段持久化接口。",
      });
      return outcome;
    } catch (error) {
      const message = lifecycleErrorMessage(error);
      setFieldState({ status: "error", message });
      toast({ tone: "error", title: "确认字段保存失败", description: message });
      return null;
    }
  }

  return (
    <article className="proactive-assistant-card" data-testid="proactive-assistant-card" data-suggestion-id={cardId}>
      <header className="proactive-assistant-card-head">
        <div className="proactive-assistant-card-title">
          <span className="proactive-assistant-icon"><Bot size={16} /></span>
          <div>
            <div className="proactive-assistant-badges">
              <b className="pill tone-amber">{triggerLabel}</b>
              <span className="proactive-assistant-confidence">{formatProactiveConfidence(item)}</span>
              <span className="proactive-assistant-source" data-testid="proactive-assistant-source">{proactiveSourceLabel(item)}</span>
            </div>
            <h4>{item?.title ?? "AI 主动提醒"}</h4>
          </div>
        </div>
        <span className="proactive-assistant-model">
          {item?.modelVersion ?? "rules/proactive-v1"}
          {item?.fallbackReason ? <small data-testid="proactive-assistant-fallback"> · {item.fallbackReason}</small> : null}
        </span>
      </header>

      <div className="proactive-assistant-status-row" data-testid="proactive-assistant-lifecycle-status">
        <span className={`pill tone-${currentMeta.tone}`}>{currentMeta.label}</span>
        <span className="proactive-assistant-readback-state">{readbackLabel}</span>
        <span className="proactive-assistant-version">版本 {displayValue(expectedVersion)}</span>
        <time dateTime={textValue(itemUpdatedAt(item)) || undefined}>{formatDateTime(itemUpdatedAt(item))}</time>
      </div>

      <p className="proactive-assistant-conclusion">{item?.conclusion ?? "暂无结论"}</p>

      <ProactiveNotificationState
        match={notificationMatch}
        readState={notificationReadState}
        onMarkRead={onMarkNotificationRead}
      />

      {facts.length > 0 ? (
        <dl className="proactive-assistant-facts">
          {facts.slice(0, 6).map((fact) => (
            <div key={fact.key}>
              <dt>{fact.label ?? fact.key}</dt>
              <dd>{displayValue(fact.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="proactive-assistant-columns">
        <ListSection title="AI 推断" icon={Sparkles} items={item?.inferences} />
        <ListSection title="未知 / 待确认" icon={CircleHelp} items={item?.unknowns} className="is-unknown" />
        <ListSection title="风险" icon={AlertTriangle} items={item?.risks} className="is-risk" />
        <ListSection title="建议动作" icon={CheckCircle2} items={item?.nextActions} className="is-action" />
      </div>

      <section className="proactive-assistant-evidence">
        <h5>证据来源</h5>
        {evidence.length === 0 ? <span>暂无可验证来源</span> : (
          <div className="proactive-assistant-evidence-list">
            {evidence.slice(0, 6).map((ref) => (
              <span key={`${ref.type}-${ref.id}`} title={ref.detail ?? undefined}>
                {ref.label ?? ref.type} · {ref.id}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="proactive-assistant-lifecycle-control" aria-label="建议生命周期操作">
        <div className="proactive-assistant-control-heading">
          <strong>生命周期</strong>
          <small>{currentMeta.description}</small>
        </div>
        <div className="proactive-assistant-lifecycle-actions">
          {actionTargets.map((status) => {
            const meta = PROACTIVE_LIFECYCLE_META[status];
            const active = lifecycleState?.target === status && lifecycleState?.status === "success";
            return (
              <button
                key={status}
                type="button"
                className={active ? "ghost-button disabled" : "ghost-button"}
                data-testid={`proactive-lifecycle-action-${status}`}
                disabled={statusBusy}
                onClick={() => changeLifecycle(status)}
              >
                {LIFECYCLE_ACTION_LABELS[status] ?? meta.label}
              </button>
            );
          })}
        </div>
        {statusBusy ? <small className="proactive-assistant-inline-status" aria-live="polite">正在提交状态变更…</small> : null}
        {lifecycleState?.status === "error" ? (
          <small className="proactive-assistant-inline-status tone-red" aria-live="polite">{lifecycleState.message}</small>
        ) : null}
      </section>

      <footer className="proactive-assistant-card-actions">
        <button
          type="button"
          className="ghost-button"
          onClick={() => onOpenOpportunity?.(item?.opportunityId)}
          disabled={!item?.opportunityId}
        >
          查看商机 <ExternalLink size={14} />
        </button>
        <button
          type="button"
          className="ghost-button proactive-assistant-preview-trigger"
          data-testid="proactive-assistant-preview"
          onClick={openPreview}
          disabled={Object.values(previewStates).some((state) => state?.status === "pending")}
        >
          {previewOpen ? "收起行动预览" : "生成行动预览（保存预览，不写回）"}
          {previewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </footer>

      {previewOpen ? (
        <section className="proactive-assistant-preview" data-testid="proactive-assistant-preview-panel">
          <div className="proactive-assistant-review-copy">
            <span className="proactive-assistant-preview-label">确认后拟创建行动</span>
            <strong>{actionPreview?.title ?? reviewPreview.title ?? "暂无行动预览"}</strong>
            <small>{actionPreview?.reason ?? reviewPreview.reason ?? "需要先补充人工确认信息。"}</small>
          </div>
          {riskPreview ? (
            <div className="proactive-assistant-review-copy">
              <span className="proactive-assistant-preview-label">确认后拟创建风险</span>
              <strong>{riskPreview.title}</strong>
              <small>{riskPreview.action}</small>
            </div>
          ) : null}
          <div className="proactive-assistant-review-fields-wrap">
            <div className="proactive-assistant-review-heading">
              <div>
                <strong>人工确认字段</strong>
                <small>这些字段只进入当前建议预览，保存后才会提交给宿主。</small>
              </div>
              <span className={`pill ${hasFieldPersistence ? "tone-blue" : "tone-gray"}`}>
                {hasFieldPersistence ? "可提交" : "本地预览"}
              </span>
            </div>
            <ProactiveReviewFields
              suggestionId={cardId}
              fields={reviewFields}
              disabled={fieldBusy}
              onChange={(key, value) => setReviewFieldDraft((current) => ({
                ...(current ?? fieldsFromItem),
                [key]: value,
              }))}
            />
            <div className="proactive-assistant-review-actions">
              <button
                type="button"
                className="ghost-button"
                data-testid="proactive-assistant-save-fields"
                onClick={saveReviewFields}
                disabled={fieldBusy}
              >
                <Save size={14} />保存确认字段
              </button>
              {fieldBusy ? <small aria-live="polite">正在保存…</small> : null}
              {fieldState?.status === "success" ? <small className="tone-green" aria-live="polite">已更新本地预览</small> : null}
              {fieldState?.status === "error" ? <small className="tone-red" aria-live="polite">{fieldState.message}</small> : null}
            </div>
          </div>
          <p>
            {writebackStates.action?.status === "success" || writebackStates.risk?.status === "success"
              ? "已按人工确认结果写入对应记录；另一项仍需单独确认。"
              : "当前状态：待人工确认；本预览不会自动修改客户、商机、阶段、金额、负责人、行动或风险。"}
          </p>
          {Object.values(previewStates).some((state) => state?.status === "pending") ? (
            <small className="proactive-assistant-preview-status" aria-live="polite">正在保存本次预览…</small>
          ) : null}
          {Object.entries(previewStates).some(([, state]) => state?.status === "error") ? (
            <small className="proactive-assistant-preview-status tone-red" aria-live="polite">
              预览保存失败，请重新展开后重试。
            </small>
          ) : null}
          <div className="proactive-assistant-writeback-actions">
            <WritebackConfirmation
              target="action"
              preview={actionPreview}
              state={writebackStates.action}
              onConfirm={() => confirmWriteback("action", actionPreview)}
            />
            <WritebackConfirmation
              target="risk"
              preview={riskPreview}
              state={writebackStates.risk}
              onConfirm={() => confirmWriteback("risk", riskPreview)}
            />
          </div>
        </section>
      ) : null}
    </article>
  );
}

function displayItemWithOverride(item, override) {
  if (!override) return item;
  const fields = override.fields ?? {};
  return {
    ...item,
    ...(fields.owner !== undefined ? { assignee: fields.owner, assigneeName: fields.owner } : {}),
    ...(fields.dueDate !== undefined ? { dueDate: fields.dueDate, followUpDate: fields.dueDate } : {}),
    ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
    ...(fields.expectedResult !== undefined ? { expectedResult: fields.expectedResult } : {}),
    ...(override.status ? { lifecycleStatus: override.status } : {}),
  };
}

function ProactiveLifecycleToolbar({ selected, counts, total, onSelect }) {
  return (
    <div className="proactive-assistant-lifecycle-toolbar" role="toolbar" aria-label="主动建议生命周期筛选">
      <button
        type="button"
        className={`proactive-assistant-filter ${selected === "all" ? "is-selected" : ""}`}
        data-testid="proactive-lifecycle-filter-all"
        aria-pressed={selected === "all"}
        onClick={() => onSelect("all")}
      >
        <span>全部</span>
        <b>{total}</b>
      </button>
      {PROACTIVE_LIFECYCLE_ORDER.map((status) => {
        const meta = PROACTIVE_LIFECYCLE_META[status];
        return (
          <button
            key={status}
            type="button"
            className={`proactive-assistant-filter ${selected === status ? "is-selected" : ""}`}
            data-testid={`proactive-lifecycle-filter-${status}`}
            aria-pressed={selected === status}
            onClick={() => onSelect(status)}
          >
            <span className={`proactive-assistant-filter-dot tone-${meta.tone}`} aria-hidden="true" />
            <span>{meta.label}</span>
            <b>{counts[status] ?? 0}</b>
          </button>
        );
      })}
    </div>
  );
}

export function ProactiveAssistantPanel({
  assistant,
  scope = null,
  apiClient = null,
  backendStatus = null,
  title = "主动助手",
  onOpenOpportunity,
  onCreatePreview,
  onConfirmWriteback,
  onLifecycleChange,
  onUpdateSuggestion,
  onRefresh,
}) {
  const [selectedLifecycle, setSelectedLifecycle] = useState("all");
  const [optimisticOverrides, setOptimisticOverrides] = useState({});
  const [refreshState, setRefreshState] = useState("idle");
  const [scopedAssistantState, setScopedAssistantState] = useState(null);
  const [scopedLoadState, setScopedLoadState] = useState("idle");
  const [scopedReloadToken, setScopedReloadToken] = useState(0);
  const [notificationPage, setNotificationPage] = useState(null);
  const [notificationLoadState, setNotificationLoadState] = useState("idle");
  const [notificationReloadToken, setNotificationReloadToken] = useState(0);
  const [notificationReadStates, setNotificationReadStates] = useState({});
  const snapshotRef = useRef(null);
  const toast = useToast();
  const scopeCustomerId = textValue(scope?.customerId);
  const scopeOpportunityId = textValue(scope?.opportunityId);
  const scopeKey = `${scopeCustomerId}:${scopeOpportunityId}`;

  // Detail pages read the same durable ledger as Overview, but ask the
  // server for the current customer/opportunity scope instead of filtering a
  // bounded Overview page in memory. Follow pagination so a busy customer
  // cannot lose a suggestion simply because it is beyond the first 100 rows.
  useEffect(() => {
    let cancelled = false;
    const hasScope = Boolean(scopeCustomerId || scopeOpportunityId);
    setScopedAssistantState(null);
    setScopedLoadState(hasScope ? "pending" : "idle");
    if (!hasScope || !apiClient?.getProactiveAssistant || (backendStatus && backendStatus !== "connected")) {
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    (async () => {
      let offset = 0;
      let firstPage = null;
      const rows = [];
      while (true) {
        const page = await apiClient.getProactiveAssistant({
          customerId: scopeCustomerId || undefined,
          opportunityId: scopeOpportunityId || undefined,
          limit: 100,
          offset,
          includeHistory: true,
          signal: controller.signal,
        });
        if (!firstPage) firstPage = page;
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        rows.push(...pageItems);
        if (!page?.truncated || rows.length >= 10000 || pageItems.length === 0) break;
        offset += pageItems.length;
      }
      if (cancelled) return;
      setScopedAssistantState({
        key: scopeKey,
        assistant: firstPage
          ? { ...firstPage, items: rows, offset: 0, limit: rows.length, truncated: false }
          : null,
      });
      setScopedLoadState("success");
    })().catch((error) => {
      if (cancelled || error?.name === "AbortError") return;
      setScopedLoadState("error");
      // Keep the Overview snapshot as a bounded fallback if a detail fetch
      // is temporarily unavailable; it is still projected by scope below.
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    apiClient,
    backendStatus,
    scopeCustomerId,
    scopeOpportunityId,
    scopeKey,
    scopedReloadToken,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!apiClient?.getProactiveNotifications || (backendStatus && backendStatus !== "connected")) {
      setNotificationPage(null);
      setNotificationLoadState("idle");
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    setNotificationLoadState("pending");
    (async () => {
      let offset = 0;
      let total = 0;
      const rows = [];
      while (true) {
        const page = await apiClient.getProactiveNotifications({ limit: 100, offset, signal: controller.signal });
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        total = Number.isSafeInteger(page?.total) ? page.total : rows.length + pageItems.length;
        rows.push(...pageItems);
        if (rows.length >= total || pageItems.length === 0 || rows.length >= 10000) break;
        offset += pageItems.length;
      }
      if (cancelled) return;
      setNotificationPage({ items: rows, total });
      setNotificationLoadState("success");
    })().catch((error) => {
      if (cancelled || error?.name === "AbortError") return;
      setNotificationPage(null);
      setNotificationLoadState("error");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiClient, backendStatus, notificationReloadToken]);

  const serverScopedAssistant = scopedAssistantState?.key === scopeKey
    ? scopedAssistantState.assistant
    : null;
  const scopedAssistant = useMemo(
    () => scope
      ? scopeProactiveAssistant(serverScopedAssistant ?? assistant ?? {}, scope)
      : (assistant ?? {}),
    [assistant, serverScopedAssistant, scopeCustomerId, scopeOpportunityId, scope],
  );
  const items = useMemo(() => mergeProactiveSuggestionItems(scopedAssistant), [scopedAssistant]);
  const counts = useMemo(() => buildProactiveLifecycleCounts(scopedAssistant, items), [scopedAssistant, items]);
  const snapshotRevision = proactiveAssistantRevision(scopedAssistant);
  const snapshotFingerprint = useMemo(
    () => JSON.stringify(items.map((item) => proactiveLifecycleFingerprint(item))),
    [items],
  );
  const hasLifecyclePersistence = typeof onLifecycleChange === "function";
  const hasFieldPersistence = typeof onUpdateSuggestion === "function";

  useEffect(() => {
    const nextSnapshot = { revision: snapshotRevision, fingerprint: snapshotFingerprint };
    const previousSnapshot = snapshotRef.current;
    if (
      previousSnapshot
      && (previousSnapshot.revision !== nextSnapshot.revision || previousSnapshot.fingerprint !== nextSnapshot.fingerprint)
    ) {
      // A fresh host snapshot is authoritative.  Drop every local optimistic
      // value rather than letting an older card hide a server-side conflict.
      setOptimisticOverrides({});
    }
    snapshotRef.current = nextSnapshot;
  }, [snapshotFingerprint, snapshotRevision]);

  function localChange(item, patch = {}) {
    const id = textValue(item?.id);
    if (!id) return;
    setOptimisticOverrides((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? {}),
        ...patch,
        fields: patch.fields ?? current[id]?.fields,
        baseFingerprint: proactiveLifecycleFingerprint(item),
      },
    }));
  }

  async function handleLifecycleChange(payload) {
    const item = payload?.item;
    const fields = normalizeProactiveEditableFields(payload?.fields ?? item);
    const nextPayload = {
      ...payload,
      item,
      fields,
      preview: payload?.preview ?? buildProactiveReviewPreview(item, fields),
      expectedVersion: payload?.expectedVersion ?? proactiveSuggestionRevision(item),
    };
    if (hasLifecyclePersistence) {
      const result = await onLifecycleChange(nextPayload);
      if (scopeCustomerId || scopeOpportunityId) setScopedReloadToken((value) => value + 1);
      return result;
    }
    return { localOnly: true, status: nextPayload.status };
  }

  async function handleUpdateSuggestion(payload) {
    const item = payload?.item;
    const fields = normalizeProactiveEditableFields(payload?.fields ?? item);
    const nextPayload = {
      ...payload,
      item,
      fields,
      patch: payload?.patch ?? {
        assignee: fields.owner,
        dueDate: fields.dueDate,
        priority: fields.priority,
        expectedResult: fields.expectedResult,
      },
      preview: payload?.preview ?? buildProactiveReviewPreview(item, fields),
      expectedVersion: payload?.expectedVersion ?? proactiveSuggestionRevision(item),
    };
    if (hasFieldPersistence) {
      const result = await onUpdateSuggestion(nextPayload);
      if (scopeCustomerId || scopeOpportunityId) setScopedReloadToken((value) => value + 1);
      return result;
    }
    return { localOnly: true, patch: nextPayload.patch };
  }

  async function handleConfirmWriteback(payload) {
    if (!onConfirmWriteback) return null;
    const result = await onConfirmWriteback(payload);
    if (scopeCustomerId || scopeOpportunityId) setScopedReloadToken((value) => value + 1);
    return result;
  }

  async function handleMarkNotificationRead(notification) {
    if (!notification?.id || !apiClient?.markProactiveNotificationRead) return null;
    setNotificationReadStates((current) => ({ ...current, [notification.id]: { status: "pending" } }));
    try {
      const item = await apiClient.markProactiveNotificationRead(notification.id);
      setNotificationPage((current) => current
        ? { ...current, items: replaceProactiveNotification(current.items, item) }
        : current);
      setNotificationReadStates((current) => ({ ...current, [notification.id]: { status: "success" } }));
      toast({ tone: "success", title: "通知已标记为已读", description: "已读状态已保存到服务端。" });
      return item;
    } catch {
      setNotificationReadStates((current) => ({ ...current, [notification.id]: { status: "error" } }));
      toast({ tone: "error", title: "已读状态保存失败", description: "请稍后重试。" });
      return null;
    }
  }

  async function refresh() {
    if (!onRefresh && !(scopeCustomerId || scopeOpportunityId)) {
      toast({
        tone: "info",
        title: "刷新接口尚未接入",
        description: "当前仅能展示已回读的快照，宿主尚未提供全局主动助手刷新接口。",
      });
      return null;
    }
    setRefreshState("pending");
    try {
      const result = await onRefresh?.({ scope: scope ?? null });
      if (scopeCustomerId || scopeOpportunityId) setScopedReloadToken((value) => value + 1);
      setNotificationReloadToken((value) => value + 1);
      setRefreshState("success");
      toast({ tone: "success", title: "主动建议已刷新", description: "界面将以新的服务端快照覆盖本地预览。" });
      return result;
    } catch (error) {
      const message = writebackErrorMessage(error);
      setRefreshState("error");
      toast({ tone: "error", title: "主动建议刷新失败", description: message });
      return null;
    }
  }

  const displayItems = items
    .map((item) => displayItemWithOverride(item, optimisticOverrides[item.id]))
    .filter((item) => selectedLifecycle === "all" || normalizeProactiveLifecycleStatus(item) === selectedLifecycle);
  const total = Number.isSafeInteger(counts.total) && counts.total >= 0 ? counts.total : items.length;
  const truncated = scopedAssistant?.truncated === true || total > items.length;
  const hasRows = items.length > 0;
  const snapshotLabel = snapshotRevision ? `快照 ${displayValue(snapshotRevision)}` : "等待服务端快照";
  const notifications = notificationPage?.items ?? [];
  const notificationCounts = proactiveNotificationCounts(notifications);

  return (
    <Panel
      title={title}
      meta={total > 0 ? `${total} 条建议 · ${snapshotLabel}` : `当前没有主动提醒 · ${snapshotLabel}`}
      action={(
        <button
          type="button"
          className="ghost-button proactive-assistant-refresh"
          data-testid="proactive-assistant-refresh"
          onClick={refresh}
          disabled={refreshState === "pending"}
          aria-label="刷新主动助手建议"
        >
          <RefreshCw size={14} className={refreshState === "pending" ? "is-spinning" : ""} />
          {refreshState === "pending" ? "刷新中" : "刷新"}
        </button>
      )}
      className="overview-proactive-assistant"
    >
      <ProactiveLifecycleToolbar
        selected={selectedLifecycle}
        counts={counts}
        total={total}
        onSelect={setSelectedLifecycle}
      />

      {apiClient?.getProactiveNotifications ? (
        <div className="proactive-notification-summary" data-testid="proactive-notification-summary" role="status">
          <Bell size={14} aria-hidden="true" />
          <strong>
            {notificationLoadState === "pending"
              ? "未读数读取中"
              : notificationLoadState === "error"
                ? "未读数未知"
                : `${notificationCounts.unread} 条未读通知`}
          </strong>
          <span>
            {notificationLoadState === "pending"
              ? "正在读取通知账本…"
              : notificationLoadState === "error"
                ? "通知账本读取失败，建议状态仍可继续查看。"
                : `共 ${notificationPage?.total ?? notificationCounts.total} 条；待发送、发送中、已送达和发送失败都不会自动变成已读。`}
          </span>
        </div>
      ) : null}

      {(!hasLifecyclePersistence || !hasFieldPersistence) ? (
        <div className="proactive-assistant-persistence-note" role="status">
          <span className="pill tone-gray">宿主接线状态</span>
          <span>
            {!hasLifecyclePersistence && !hasFieldPersistence
              ? "状态与确认字段目前仅在本页预览，宿主尚未接入持久化接口。"
              : !hasLifecyclePersistence
                ? "确认字段可提交；生命周期状态目前仅在本页预览，宿主尚未接入状态持久化接口。"
                : "生命周期状态可提交；确认字段目前仅在本页预览，宿主尚未接入字段持久化接口。"}
          </span>
        </div>
      ) : (
        <div className="proactive-assistant-persistence-note is-connected" role="status">
          <span className="pill tone-blue">服务端接线</span>
          <span>
            {scopedLoadState === "pending"
              ? "正在读取当前范围的服务端账本…"
              : scopedLoadState === "error"
                ? "当前范围读取失败，暂显示已有快照。"
                : "状态和确认字段提交后，刷新将以服务端回读为准。"}
          </span>
        </div>
      )}

      {!hasRows ? (
        <div className="proactive-assistant-empty">
          <Bot size={20} />
          <div>
            <strong>{total > 0 ? "当前快照没有返回建议行" : "当前没有可验证的主动提醒"}</strong>
            <span>
              {total > 0
                ? "服务端仍报告历史建议数量；请刷新或调整筛选，页面不会用当前分页结果覆盖历史计数。"
                : "助手只依据服务端已保存的商机、互动和行动事实，不会猜测缺失信息。"}
            </span>
          </div>
        </div>
      ) : displayItems.length === 0 ? (
        <div className="proactive-assistant-empty" data-testid="proactive-assistant-filter-empty">
          <Bot size={20} />
          <div>
            <strong>当前筛选没有建议</strong>
            <span>该生命周期没有出现在当前快照行中；服务端计数仍会保留在筛选栏。</span>
          </div>
        </div>
      ) : (
        <div className="proactive-assistant-list">
          {displayItems.slice(0, 4).map((item) => {
            const notificationMatch = latestNotificationForSuggestion(notifications, item);
            return (
              <ProactiveSuggestion
                key={item.id}
                item={item}
                localOverride={optimisticOverrides[item.id]}
                onOpenOpportunity={onOpenOpportunity}
                onCreatePreview={onCreatePreview}
                onConfirmWriteback={handleConfirmWriteback}
                onLifecycleChange={handleLifecycleChange}
                onUpdateSuggestion={handleUpdateSuggestion}
                onLocalChange={(patch) => localChange(item, patch)}
                hasLifecyclePersistence={hasLifecyclePersistence}
                hasFieldPersistence={hasFieldPersistence}
                notificationMatch={notificationMatch}
                notificationReadState={notificationMatch?.item?.id ? notificationReadStates[notificationMatch.item.id] : null}
                onMarkNotificationRead={apiClient?.markProactiveNotificationRead ? handleMarkNotificationRead : null}
              />
            );
          })}
          {truncated ? (
            <small className="proactive-assistant-more">
              还有 {Math.max(0, total - displayItems.length)} 条建议未在当前页展示，请缩小范围查看。
            </small>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
