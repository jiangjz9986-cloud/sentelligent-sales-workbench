import { Bell, Check, CheckCheck, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const CATEGORY_LABEL = Object.freeze({
  daily_digest: "工作简报",
  action_reminder: "待办提醒",
  invoice_escalation: "发票提醒",
  ops_alert: "运维告警",
  proactive_assistant: "主动建议",
});

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

export function NotificationsPage({ apiClient, backendStatus }) {
  const [filter, setFilter] = useState("all");
  const [state, setState] = useState({ loading: true, busy: "", error: "", items: [], total: 0, unreadCount: 0 });
  const unreadOnly = filter === "unread";

  const load = useCallback(async () => {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setState((current) => ({ ...current, loading: false, error: "服务连接后可查看通知。" }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const page = await apiClient.getInAppNotifications({ limit: 100, unreadOnly });
      setState((current) => ({ ...current, loading: false, items: page.items, total: page.total, unreadCount: page.unreadCount, error: "" }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error?.message ?? "通知加载失败。" }));
    }
  }, [apiClient, backendStatus, unreadOnly]);

  useEffect(() => { load(); }, [load]);

  async function markRead(item) {
    if (!item.unread) return item;
    const updated = await apiClient.markInAppNotificationRead(item.id);
    setState((current) => ({
      ...current,
      items: current.items.map((candidate) => candidate.id === item.id ? updated : candidate),
      unreadCount: Math.max(0, current.unreadCount - 1),
    }));
    return updated;
  }

  async function openItem(item) {
    setState((current) => ({ ...current, busy: item.id, error: "" }));
    try {
      await markRead(item);
      window.location.assign(item.href);
    } catch (error) {
      setState((current) => ({ ...current, busy: "", error: error?.message ?? "操作失败，请重试。" }));
    }
  }

  async function markAllRead() {
    if (!state.unreadCount || state.busy) return;
    setState((current) => ({ ...current, busy: "all", error: "" }));
    try {
      await apiClient.markAllInAppNotificationsRead();
      setState((current) => ({
        ...current,
        busy: "",
        unreadCount: 0,
        items: current.items.map((item) => ({ ...item, unread: false, readAt: item.readAt ?? new Date().toISOString() })),
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: "", error: error?.message ?? "操作失败，请重试。" }));
    }
  }

  return (
    <section className="notification-center" data-testid="notification-center">
      <div className="notification-toolbar">
        <div className="notification-filters" role="group" aria-label="通知筛选">
          <button className={filter === "all" ? "active" : ""} type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部 <span>{state.total}</span></button>
          <button className={filter === "unread" ? "active" : ""} type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>未读 <span>{state.unreadCount}</span></button>
        </div>
        <div className="notification-actions">
          <button className="ghost-button" type="button" onClick={load} disabled={state.loading || Boolean(state.busy)} aria-label="刷新通知" title="刷新通知">
            <RefreshCw size={16} />
          </button>
          <button className="ghost-button" type="button" onClick={markAllRead} disabled={!state.unreadCount || Boolean(state.busy)}>
            {state.busy === "all" ? <LoaderCircle size={16} className="state-spinner" /> : <CheckCheck size={16} />}
            全部已读
          </button>
        </div>
      </div>

      {state.error ? <p className="notification-state error" role="alert"><CircleAlert size={17} />{state.error}</p> : null}
      {state.loading ? <p className="notification-state" role="status"><LoaderCircle size={18} className="state-spinner" />正在加载通知</p> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <div className="notification-empty" data-testid="notification-empty">
          <Bell size={22} />
          <strong>{unreadOnly ? "没有未读通知" : "暂无通知"}</strong>
        </div>
      ) : null}
      {!state.loading && state.items.length > 0 ? (
        <div className="notification-list" data-testid="notification-list">
          {state.items.map((item) => (
            <article className={`notification-row ${item.unread ? "unread" : ""}`} key={item.id}>
              <span className={`notification-marker ${item.category}`} aria-hidden="true">{item.unread ? <i /> : <Check size={14} />}</span>
              <div className="notification-content">
                <div className="notification-row-heading">
                  <span className={`notification-category ${item.category}`}>{CATEGORY_LABEL[item.category] ?? "通知"}</span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                </div>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </div>
              <button className="notification-open" type="button" onClick={() => openItem(item)} disabled={Boolean(state.busy)}>
                {state.busy === item.id ? <LoaderCircle size={15} className="state-spinner" /> : item.unread ? "查看" : "打开"}
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
