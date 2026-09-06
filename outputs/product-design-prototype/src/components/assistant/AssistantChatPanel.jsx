import { Bell, LoaderCircle, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import VoiceCaptureControl from "../audio/VoiceCaptureControl.jsx";
import { AssistantConfirmCard } from "./AssistantConfirmCard.jsx";
import {
  buildProactiveLifecycleCounts,
  mergeProactiveSuggestionItems,
  normalizeProactiveLifecycleStatus,
  proactiveLifecycleMeta,
  proactiveSourceLabel,
} from "../../features/salesWorkbench/components/proactiveAssistantModel.js";
import {
  latestNotificationForSuggestion,
  proactiveNotificationCounts,
  proactiveNotificationIsUnread,
  proactiveNotificationStatusMeta,
  replaceProactiveNotification,
} from "../../features/salesWorkbench/components/proactiveNotificationModel.js";

function AssistantMessage({ message }) {
  const tone = message.status === "denied" || message.status === "error" ? "error" : message.role;
  return (
    <div className={`assistant-message is-${tone}`} data-testid={`assistant-message-${message.role}`}>
      <div className="assistant-message-bubble">{message.text}</div>
    </div>
  );
}

const PROACTIVE_TRIGGER_LABELS = Object.freeze({
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

function AssistantProactiveQueue({ assistant, apiClient, onOpenOverview, onOpenOpportunity }) {
  const [ledgerAssistant, setLedgerAssistant] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [notificationLoadState, setNotificationLoadState] = useState("idle");
  const [readStates, setReadStates] = useState({});

  useEffect(() => {
    let cancelled = false;
    if (!apiClient?.getProactiveAssistant) {
      setLedgerAssistant(null);
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
          limit: 100,
          offset,
          includeHistory: true,
          signal: controller.signal,
        });
        if (!firstPage) firstPage = page;
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        rows.push(...pageItems);
        if (!page?.truncated || pageItems.length === 0 || rows.length >= 10000) break;
        offset += pageItems.length;
      }
      if (!cancelled && firstPage) {
        setLedgerAssistant({ ...firstPage, items: rows, offset: 0, limit: rows.length, truncated: false });
      }
    })().catch((error) => {
      if (!cancelled && error?.name !== "AbortError") setLedgerAssistant(null);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiClient, assistant?.generatedAt, assistant?.updatedAt]);

  useEffect(() => {
    let cancelled = false;
    if (!apiClient?.getProactiveNotifications) {
      setNotifications([]);
      setNotificationLoadState("idle");
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    setNotificationLoadState("pending");
    (async () => {
      const rows = [];
      let offset = 0;
      let total = 0;
      while (true) {
        const page = await apiClient.getProactiveNotifications({ limit: 100, offset, signal: controller.signal });
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        total = Number.isSafeInteger(page?.total) ? page.total : rows.length + pageItems.length;
        rows.push(...pageItems);
        if (rows.length >= total || pageItems.length === 0 || rows.length >= 10000) break;
        offset += pageItems.length;
      }
      if (!cancelled) {
        setNotifications(rows);
        setNotificationLoadState("success");
      }
    })().catch((error) => {
      if (cancelled || error?.name === "AbortError") return;
      setNotifications([]);
      setNotificationLoadState("error");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiClient, assistant?.generatedAt, assistant?.updatedAt]);

  async function markRead(notification) {
    if (!notification?.id || !apiClient?.markProactiveNotificationRead) return;
    setReadStates((current) => ({ ...current, [notification.id]: "pending" }));
    try {
      const item = await apiClient.markProactiveNotificationRead(notification.id);
      setNotifications((current) => replaceProactiveNotification(current, item));
      setReadStates((current) => ({ ...current, [notification.id]: "success" }));
    } catch {
      setReadStates((current) => ({ ...current, [notification.id]: "error" }));
    }
  }

  const effectiveAssistant = ledgerAssistant ?? assistant;
  const items = useMemo(() => mergeProactiveSuggestionItems(effectiveAssistant ?? {}), [effectiveAssistant]);
  const counts = useMemo(() => buildProactiveLifecycleCounts(effectiveAssistant ?? {}, items), [effectiveAssistant, items]);
  const notificationCounts = useMemo(() => proactiveNotificationCounts(notifications), [notifications]);
  const pendingItems = items
    .filter((item) => normalizeProactiveLifecycleStatus(item) === "pending")
    .slice(0, 3);
  if (!assistant || (items.length === 0 && !counts.total)) return null;
  return (
    <section className="assistant-proactive-queue" data-testid="assistant-proactive-queue" aria-label="主动建议">
      <div className="assistant-proactive-queue-head">
        <strong>主动建议</strong>
        <span>{counts.pending ?? pendingItems.length} 条待处理</span>
        {apiClient?.getProactiveNotifications ? (
          <span data-testid="assistant-proactive-unread-count">
            {notificationLoadState === "pending"
              ? "通知读取中"
              : notificationLoadState === "error"
                ? "未读数未知"
                : `${notificationCounts.unread} 条未读`}
          </span>
        ) : null}
        <button type="button" className="ghost-button" onClick={onOpenOverview}>查看全部</button>
      </div>
      {pendingItems.length === 0 ? (
        <p className="assistant-proactive-queue-empty">当前没有待处理建议，历史建议仍保留在主动助手中。</p>
      ) : (
        <div className="assistant-proactive-queue-list">
          {pendingItems.map((item) => {
            const trigger = item?.trigger?.type;
            const meta = proactiveLifecycleMeta(item);
            const notificationMatch = latestNotificationForSuggestion(notifications, item);
            const notification = notificationMatch?.item;
            const notificationMeta = notification ? proactiveNotificationStatusMeta(notification) : null;
            const unread = notification ? proactiveNotificationIsUnread(notification) : false;
            return (
              <div className="assistant-proactive-queue-row" key={item.id}>
                <button
                  type="button"
                  className="assistant-proactive-queue-item"
                  onClick={() => {
                    if (item.opportunityId) onOpenOpportunity?.(item.opportunityId);
                    else onOpenOverview?.();
                  }}
                >
                  <span className="assistant-proactive-queue-item-title">{item.title ?? "主动建议"}</span>
                  <span className="assistant-proactive-queue-item-meta">
                    {PROACTIVE_TRIGGER_LABELS[trigger] ?? "主动提醒"} · {meta.label} · {proactiveSourceLabel(item)}
                  </span>
                  {notificationMeta ? (
                    <span className="assistant-proactive-queue-item-notification" data-testid={`assistant-proactive-notification-${item.id}`}>
                      {notificationMeta.channelLabel} · {notificationMeta.label}{unread ? " · 未读" : ""}
                      {!notificationMatch.currentRevision ? ` · 建议版本 ${notification.suggestionVersion}` : ""}
                    </span>
                  ) : null}
                </button>
                {unread && apiClient?.markProactiveNotificationRead ? (
                  <button
                    type="button"
                    className="ghost-button assistant-proactive-mark-read"
                    data-testid={`assistant-proactive-mark-read-${notification.id}`}
                    disabled={readStates[notification.id] === "pending"}
                    onClick={() => markRead(notification)}
                  >
                    {readStates[notification.id] === "pending" ? "保存中" : "标记已读"}
                  </button>
                ) : null}
                {readStates[notification?.id] === "error" ? (
                  <small className="assistant-proactive-read-error" role="alert">已读状态保存失败，请重试。</small>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function AssistantChatPanel({
  open,
  messages,
  pending,
  draft,
  busy,
  apiClient,
  online = false,
  sessionEpoch,
  appendTranscriptToDraft,
  voiceFeedback,
  draftFocusToken,
  onDraftChange,
  onSend,
  onClose,
  onConfirm,
  onCancelPending,
  proactiveAssistant = null,
  onOpenProactiveOverview = () => {},
  onOpenProactiveOpportunity = () => {},
}) {
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open, pending]);

  useEffect(() => {
    if (!open || !draftFocusToken) return;
    inputRef.current?.focus();
  }, [draftFocusToken, open]);

  if (!open) return null;

  return (
    <div className="assistant-chat-backdrop" data-testid="assistant-chat-backdrop" onClick={onClose}>
      <section
        id="assistant-chat-panel"
        className="assistant-chat-panel"
        role="dialog"
        aria-modal="true"
        aria-label="小小对话"
        data-testid="assistant-chat-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="assistant-chat-header">
          <strong>小小</strong>
          <button className="icon-button" type="button" aria-label="关闭对话" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <AssistantProactiveQueue
          assistant={proactiveAssistant}
          apiClient={apiClient}
          onOpenOverview={onOpenProactiveOverview}
          onOpenOpportunity={onOpenProactiveOpportunity}
        />

        <div ref={listRef} className="assistant-chat-messages" aria-live="polite" aria-busy={busy}>
          {messages.map((message) => (
            <AssistantMessage key={message.id} message={message} />
          ))}
          {pending ? (
            <AssistantConfirmCard
              card={pending.card}
              text={pending.text}
              risk={pending.risk}
              busy={busy}
              onConfirm={onConfirm}
              onCancel={onCancelPending}
            />
          ) : null}
        </div>

        <form
          className="assistant-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <VoiceCaptureControl
            apiClient={apiClient}
            purpose="assistant_chat"
            onTranscript={appendTranscriptToDraft}
            active={open}
            disabled={busy || Boolean(pending) || !online}
            sessionEpoch={sessionEpoch}
            compact
          />
          {voiceFeedback ? (
            <p className="assistant-chat-voice-feedback" role="status" aria-live="polite">
              {voiceFeedback}
            </p>
          ) : null}
          <textarea
            ref={inputRef}
            value={draft}
            rows={3}
            maxLength={2000}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            disabled={busy || Boolean(pending)}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <button className="primary-button" type="submit" disabled={busy || Boolean(pending) || !draft.trim()}>
            {busy ? <LoaderCircle className="state-spinner" size={16} /> : <Send size={16} />}
            发送
          </button>
        </form>
      </section>
    </div>
  );
}
