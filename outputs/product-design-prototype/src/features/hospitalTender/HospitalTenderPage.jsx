import {
  BellRing,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileText,
  Filter,
  HeartPulse,
  LoaderCircle,
  RefreshCw,
  Search,
  Target,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel } from "../../components/primitives.jsx";

const TYPE_LABELS = {
  tender: "招标公告",
  procurement_notice: "采购公告",
  purchase_intent: "采购意向",
  clarification: "变更/澄清",
  bid_result: "中标/成交",
  bid_cancelled: "废标/终止",
  contract_award: "合同公示",
  qualification: "资格预审",
  other: "其他公告",
  medical_device: "医疗器械",
  medical_consumable: "医用耗材",
  service: "医院服务",
  construction: "工程建设",
  information: "信息化",
};

const RELEVANCE_LABELS = {
  high: "高相关",
  medium: "中相关",
  low: "低相关",
};

const HEALTH_LABELS = {
  healthy: "运行正常",
  warning: "需要关注",
  degraded: "部分异常",
  error: "不可用",
  unhealthy: "不可用",
  down: "暂时不可用",
  disabled: "已停用",
  unknown: "状态待确认",
};

const NOTICE_PAGE_SIZE = 200;
const INITIAL_VISIBLE_NOTICE_COUNT = 8;

function firstText(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim())
    ? String(values.find((value) => value !== null && value !== undefined && String(value).trim())).trim()
    : "";
}

function normalizeType(value) {
  const type = firstText(value).toLowerCase();
  if (TYPE_LABELS[type]) return type;
  if (/采购意向|项目计划|计划/.test(type)) return "purchase_intent";
  if (/招标|采购公告|公开采购/.test(type)) return "tender";
  if (/变更|澄清|更正/.test(type)) return "clarification";
  if (/中标|成交|结果/.test(type)) return "bid_result";
  if (/合同/.test(type)) return "contract_award";
  if (/单一来源/.test(type)) return "tender";
  if (/废标|终止/.test(type)) return "bid_cancelled";
  if (/器械/.test(type)) return "medical_device";
  if (/耗材/.test(type)) return "medical_consumable";
  if (/服务/.test(type)) return "service";
  if (/工程|建设/.test(type)) return "construction";
  if (/信息|软件|系统/.test(type)) return "information";
  return type || "other";
}

function normalizeRelevance(value) {
  const relevance = firstText(value).toLowerCase();
  if (RELEVANCE_LABELS[relevance]) return relevance;
  if (relevance === "possible" || /可能|中/.test(relevance)) return "medium";
  if (relevance === "irrelevant" || /无关|低/.test(relevance)) return "low";
  if (/高|重点|urgent|important/.test(relevance)) return "high";
  if (/低|一般|weak/.test(relevance)) return "low";
  return "medium";
}

function safeHref(value) {
  const href = firstText(value);
  if (!href) return "";
  try {
    const url = new URL(href, "https://sentelligent.invalid");
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeNotice(notice, index, customerNameById) {
  const item = notice && typeof notice === "object" ? notice : {};
  const matchedCustomerIds = Array.isArray(item.matchedCustomerIds)
    ? item.matchedCustomerIds
    : [];
  const matchedCustomerNames = Array.isArray(item.matchedCustomerNames)
    ? item.matchedCustomerNames
    : [];
  const customerId = firstText(item.customerId, item.customer_id, matchedCustomerIds[0]);
  const summary = firstText(item.summary, item.description, item.abstract, item.contentText, "暂未提供公告摘要");
  return {
    id: firstText(item.id, item.noticeId, `notice-${index}`),
    title: firstText(item.title, item.name, "未命名招标公告"),
    type: normalizeType(item.noticeType ?? item.type ?? item.category),
    relevance: normalizeRelevance(item.relevance ?? item.priority),
    customerId,
    customerName: firstText(
      item.customerName,
      item.customer,
      matchedCustomerNames[0],
      customerId ? customerNameById.get(customerId) : "",
      item.hospitalName,
      item.hospital,
    ),
    purchaser: firstText(item.purchaser, item.buyer, item.organizer),
    projectCode: firstText(item.projectCode, item.project_code, item.code),
    publishedAt: firstText(item.publishedAt, item.publishDate, item.date, "待确认"),
    deadline: firstText(item.deadline, item.deadlineText, item.bidDeadline, item.endAt, "未注明"),
    summary: summary.length > 800 ? `${summary.slice(0, 800)}…` : summary,
    sourceName: firstText(item.sourceName, item.source, "公开招标平台"),
    sourceUrl: safeHref(item.sourceUrl ?? item.url ?? item.link),
    matchReasons: item.matchReasons ?? {},
    matchedNeeds: item.matchedNeeds ?? {},
  };
}

function customerLabel(customer) {
  if (typeof customer === "string") return customer;
  return firstText(customer?.name, customer?.customerName, customer?.label);
}

function customerValue(customer) {
  if (typeof customer === "string") return customer;
  return firstText(customer?.id, customer?.customerId, customer?.name);
}

function statusClass(value) {
  const status = firstText(value).toLowerCase();
  if (["healthy", "ok", "normal", "正常"].includes(status)) return "healthy";
  if (["down", "error", "failed", "unhealthy", "异常", "不可用"].includes(status)) return "down";
  if (["disabled", "停用", "unknown", "待确认"].includes(status)) return "neutral";
  return "warning";
}

function metricValue(summary, keys, fallback) {
  for (const key of keys) {
    const value = summary?.[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return fallback;
}

function formatSchedulerDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatElapsed(value, fallback = "刚刚开始") {
  const seconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${String(remainder).padStart(2, "0")} 秒` : `${remainder} 秒`;
}

function relativeAge(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间待确认";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function runStatusTone(status) {
  if (status === "success") return "success";
  if (status === "partial") return "warning";
  if (status === "failed") return "danger";
  if (status === "disabled" || status === "idle" || status === "waiting") return "neutral";
  return "blue";
}

function runStatusLabel(status) {
  return {
    idle: "等待首轮",
    waiting: "等待下次轮巡",
    running: "正在处理",
    success: "最近一批成功",
    partial: "最近一批部分完成",
    failed: "最近一批失败",
    disabled: "已停用",
  }[status] ?? "状态待确认";
}

function notificationLabel(value) {
  return value === "enabled" ? "已启用" : value === "disabled" ? "未配置" : "状态待确认";
}

function userFacingTenderError(value, fallback = "招标数据暂时不可用，请稍后重试。") {
  const message = firstText(value);
  if (!message) return fallback;
  if (/internal|snapshot|payload|schema|invalid|database|sqlite|stack|exception/i.test(message)) return fallback;
  return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

function deadlineTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function publishedToday(value, now = Date.now()) {
  const today = localDateKey(now);
  const text = firstText(value);
  const parsed = /^\d{4}-\d{2}-\d{2}/u.test(text) ? localDateKey(text) : null;
  if (parsed) return parsed === today;
  return Boolean(today && text && text.includes(today.slice(5)));
}

function deadlineWithinNextSevenDays(value, now = Date.now()) {
  const timestamp = deadlineTimestamp(value);
  if (!Number.isFinite(timestamp)) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return timestamp >= today.getTime() && timestamp <= today.getTime() + (7 * 24 * 60 * 60 * 1000);
}

function relevanceRank(value) {
  return value === "high" ? 0 : value === "medium" ? 1 : 2;
}

function noticeDateLabel(value, { compact = false } = {}) {
  const message = firstText(value);
  if (!message) return "待确认";
  const date = new Date(message);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      ...(compact ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    }).format(date).replace(/\//g, "-");
  }
  return message.replace(/\s+/g, " ");
}

function deadlineTone(value, now = Date.now()) {
  const timestamp = deadlineTimestamp(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const diff = timestamp - now;
  if (diff < 0) return "overdue";
  if (diff <= 48 * 60 * 60 * 1000) return "urgent";
  if (diff <= 7 * 24 * 60 * 60 * 1000) return "soon";
  return "normal";
}

function deadlineLabel(value, now = Date.now()) {
  const tone = deadlineTone(value, now);
  if (tone === "overdue") return "已截止";
  if (tone === "urgent") return "临近截止";
  if (tone === "soon") return "7 天内截止";
  return "截止时间";
}

function NoticeDetail({ notice, onClose, onSelectCustomer }) {
  const matchReasons = [...new Set(Object.values(notice.matchReasons ?? {}).flat().filter(Boolean))];
  const matchedNeeds = [...new Set(Object.values(notice.matchedNeeds ?? {}).flat().filter(Boolean))];
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === "undefined") return undefined;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex=\"-1\"])",
    ].join(",");
    const focusInitialControl = () => closeButtonRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll(focusableSelector)];
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    focusInitialControl();
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="expense-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="expense-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hospital-tender-detail-title"
        tabIndex={-1}
      >
        <header className="expense-drawer-head">
          <div>
            <span className="expense-kicker">公告详情</span>
            <h2 id="hospital-tender-detail-title">{notice.title}</h2>
            <p>{notice.sourceName} · {noticeDateLabel(notice.publishedAt, { compact: true })}</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭公告详情" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="expense-editor-form" style={{ minWidth: 0 }}>
          <div className="detail-metrics" style={{ minWidth: 0 }}>
            <section className="metric-inline"><span>公告类型</span><strong>{TYPE_LABELS[notice.type] ?? notice.type}</strong></section>
            <section className="metric-inline"><span>相关性</span><strong>{RELEVANCE_LABELS[notice.relevance]}</strong></section>
            <section className="metric-inline"><span>投标截止</span><strong>{noticeDateLabel(notice.deadline, { compact: true })}</strong></section>
          </div>
          <section className="detail-surface" style={{ minWidth: 0 }}>
            <h3>公告摘要</h3>
            <p>{notice.summary}</p>
          </section>
          {notice.customerName ? (
            <section className="detail-surface" style={{ minWidth: 0 }}>
              <h3>关联客户</h3>
              <button
                className="ghost-button"
                type="button"
                onClick={() => onSelectCustomer?.(notice.customerId || notice.customerName)}
              >
                {notice.customerName}<ChevronRight size={15} />
              </button>
            </section>
          ) : null}
          {(matchReasons.length > 0 || matchedNeeds.length > 0) ? (
            <section className="detail-surface" style={{ minWidth: 0 }}>
              <h3>匹配依据</h3>
              {matchReasons.length > 0 ? <p>{matchReasons.map((reason) => ({ hospital_name: "客户名称", city: "地区", need: "客户需求", keyword: "关键词" }[reason] ?? reason)).join("、")}</p> : null}
              {matchedNeeds.length > 0 ? <small className="muted-copy">命中需求：{matchedNeeds.join("、")}</small> : null}
            </section>
          ) : null}
          <div className="detail-actions">
            {notice.sourceUrl ? (
              <a className="primary-button" href={notice.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />查看原文
              </a>
            ) : <span className="muted-copy">暂无可用原文链接</span>}
            <button className="ghost-button" type="button" onClick={onClose}>返回列表</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function HealthSummary({ sources, health }) {
  const sourceItems = Array.isArray(sources) ? sources : [];
  const healthItems = Array.isArray(health)
    ? health
    : Array.isArray(health?.sources)
      ? health.sources
      : [];
  const byId = new Map(sourceItems.map((item) => [firstText(item?.sourceId, item?.id, item?.sourceName), item]));
  const items = (healthItems.length ? healthItems : sourceItems).map((item) => ({
    ...(byId.get(firstText(item?.sourceId, item?.id, item?.sourceName)) ?? {}),
    ...item,
  }));
  const healthStatus = firstText(health?.status);
  const degradedCount = Number(health?.staleCount ?? 0);

  return (
    <Panel
      title="来源覆盖与新鲜度"
      meta={`${items.length} 个数据源`}
      className="hospital-tender-health hospital-tender-status-panel"
    >
      {healthStatus && healthStatus !== "healthy" ? (
        <div className={`hospital-tender-health-summary ${statusClass(healthStatus)}`} role="status">
          <HeartPulse size={14} />
          <span>{healthStatus === "degraded" ? `${degradedCount || "部分"} 个来源需要关注` : HEALTH_LABELS[healthStatus] ?? "来源状态待确认"}</span>
        </div>
      ) : null}
      <div className="hospital-tender-health-list">
        {items.length === 0 ? <p className="empty-list">暂无数据源健康信息</p> : null}
        {items.map((item, index) => {
          const name = firstText(item?.name, item?.sourceName, item?.label, `数据源 ${index + 1}`);
          const rawStatus = firstText(item?.status, item?.state, item?.health, "unknown").toLowerCase();
          const status = statusClass(rawStatus);
          const label = HEALTH_LABELS[rawStatus] ?? HEALTH_LABELS[status] ?? "状态待确认";
          const lastSuccess = item?.lastSuccessAt ?? item?.lastChecked ?? item?.lastRunAt;
          return (
            <div className="hospital-tender-health-row" key={`${name}-${index}`}>
              <span className={`mini-icon ${status}`}><HeartPulse size={15} /></span>
              <span className="hospital-tender-health-copy">
                <strong title={name}>{name}</strong>
                <small>{label}{lastSuccess ? ` · 成功于 ${formatSchedulerDate(lastSuccess, "待确认")}` : " · 尚未成功"}</small>
                <small>{Number(item?.itemCount ?? item?.lastItemCount ?? 0)} 条公告{item?.lastError ? ` · ${userFacingTenderError(item.lastError, "最近一次采集失败")}` : ""}</small>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function SchedulerProgress({ scheduler, busy = false, elapsedMs = 0, notification = null }) {
  const state = scheduler?.item ?? scheduler ?? null;
  const runs = Array.isArray(scheduler?.runs) ? scheduler.runs : [];
  if (!state && !busy) return null;
  const processedFromRuns = runs
    .filter((run) => run.snapshotId && run.snapshotId === state?.snapshotId && ["success", "partial"].includes(run.status))
    .reduce((total, run) => total + (Number(run.batchCount) || 0), 0);
  const processed = Number.isSafeInteger(state?.cycleProcessedCount)
    ? state.cycleProcessedCount
    : processedFromRuns;
  const total = Number(state?.cycleCustomerCount) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const status = busy ? "running" : firstText(state?.lastStatus, "unknown");
  const statusLabel = busy ? "正在检测" : runStatusLabel(status);
  const tone = runStatusTone(status);
  const notificationState = firstText(notification?.status, scheduler?.notification?.status);
  return (
    <Panel title="自动轮巡" meta={state?.enabled ? `每 ${state.intervalMinutes} 分钟` : "已停用"} className="hospital-tender-scheduler hospital-tender-status-panel">
      <div className="hospital-tender-scheduler-summary">
        <div className="hospital-tender-scheduler-state"><span className={`mini-icon ${tone}`}><CalendarClock size={15} /></span><span><strong>{statusLabel}</strong><small>第 {state?.cycleNumber || "—"} 轮 · 每批 {state?.batchSize || "—"} 家客户</small></span></div>
        {state?.snapshotId || busy ? <div className="hospital-tender-progress"><strong>{total > 0 ? `本轮进度 ${processed} / ${total}` : "正在等待采集器反馈"}</strong><progress value={total > 0 ? percent : undefined} max="100" aria-label="医院招标轮巡进度">{total > 0 ? `${percent}%` : "进行中"}</progress>{busy ? <small>已运行 {formatElapsed(elapsedMs)}，检测期间不会重复提交</small> : null}</div> : null}
        <div className="hospital-tender-scheduler-facts">
          <span>最近批次 <strong>{state?.lastBatchCount || 0}</strong> 家客户</span>
          <span>入库 <strong>{state?.lastAcceptedCount || 0}</strong> 条</span>
          <span>异常 <strong>{state?.lastRejectedCount || 0}</strong> 条</span>
        </div>
        <small className="muted-copy">最近完成：{formatSchedulerDate(state?.lastFinishedAt, "尚未运行")}</small>
        <small className="muted-copy">下次运行：{formatSchedulerDate(state?.nextRunAt, state?.enabled ? "等待排期" : "已停用")}</small>
        {Number(state?.lastHighRelevanceCount) > 0 ? <small className="muted-copy">本批新增高相关：{Number(state.lastHighRelevanceCount)} 条</small> : null}
        {notificationState ? <small className="muted-copy">PushPlus：{notificationLabel(notificationState)}{notificationState === "disabled" ? "（仅保存，不推送）" : ""}</small> : null}
        {state?.lastError ? <p className="expense-page-alert" role="alert"><CircleAlert size={15} />{userFacingTenderError(state.lastError, "最近一批检测未完成，请稍后重试。")}</p> : null}
      </div>
    </Panel>
  );
}

function PriorityMetric({ label, value, detail, tone, icon: Icon }) {
  return (
    <section className={`hospital-tender-priority-metric ${tone}`}>
      <span className="hospital-tender-priority-icon"><Icon size={18} /></span>
      <span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span>
    </section>
  );
}

function NoticeMeta({ notice, compact = false }) {
  return (
    <>
      <span className="hospital-tender-notice-meta">{notice.customerName || "未关联客户"}</span>
      {!compact ? <span className="hospital-tender-notice-meta">{notice.sourceName}</span> : null}
    </>
  );
}

function PriorityNoticeRow({ notice, onSelect }) {
  const relevanceLabel = RELEVANCE_LABELS[notice.relevance] ?? "待确认";
  const isUrgent = notice.relevance === "high";
  const deadlineClass = deadlineTone(notice.deadline);
  return (
    <article className={`hospital-tender-priority-row ${isUrgent ? "urgent" : ""}`}>
      <span className={`hospital-tender-priority-row-icon ${isUrgent ? "danger" : notice.relevance === "medium" ? "warning" : "success"}`} aria-hidden="true">
        {isUrgent ? <Target size={17} /> : <FileText size={17} />}
      </span>
      <button className="hospital-tender-row-main" type="button" onClick={(event) => onSelect(notice, event)}>
        <strong>{notice.title}</strong>
        <span><NoticeMeta notice={notice} /></span>
      </button>
      <span className={`hospital-tender-deadline ${deadlineClass}`}>
        <small>{deadlineLabel(notice.deadline)}</small>
        <strong>{noticeDateLabel(notice.deadline, { compact: true })}</strong>
      </span>
      <span className={`pill ${isUrgent ? "danger" : notice.relevance === "medium" ? "warning" : "success"}`}>{relevanceLabel}</span>
      <button className="hospital-tender-row-arrow" type="button" aria-label={`查看${notice.title}详情`} onClick={(event) => onSelect(notice, event)}><ChevronRight size={17} /></button>
    </article>
  );
}

function AllNoticeRow({ notice, onSelect }) {
  return (
    <article className="hospital-tender-all-row">
      <span className={`hospital-tender-all-dot ${notice.relevance}`} aria-hidden="true" />
      <button className="hospital-tender-all-main" type="button" onClick={(event) => onSelect(notice, event)}>
        <strong>{notice.title}</strong>
        <span><NoticeMeta notice={notice} compact /></span>
      </button>
      <span className="hospital-tender-all-date">{noticeDateLabel(notice.publishedAt, { compact: true })}</span>
      <button className="hospital-tender-row-arrow" type="button" aria-label={`查看${notice.title}详情`} onClick={(event) => onSelect(notice, event)}><ChevronRight size={16} /></button>
    </article>
  );
}

export function HospitalTenderPage({
  apiClient = null,
  backendStatus = "connected",
  notices = [],
  summary = {},
  sources = [],
  health = [],
  customers = [],
  loading = false,
  error = "",
  onRefresh,
  onSelectCustomer,
}) {
  const [typeFilter, setTypeFilter] = useState("");
  const [relevanceFilter, setRelevanceFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [visibleNoticeCount, setVisibleNoticeCount] = useState(INITIAL_VISIBLE_NOTICE_COUNT);
  const [selectedNotice, setSelectedNotice] = useState(null);
  const lastNoticeTriggerRef = useRef(null);
  const refreshGenerationRef = useRef(0);

  const [remoteState, setRemoteState] = useState({
    loading: false,
    error: "",
    notices: null,
    noticeTotal: null,
    noticeHasMore: false,
    summary: null,
    sources: null,
    health: null,
    scheduler: null,
  });
  const [noticeLoadingMore, setNoticeLoadingMore] = useState(false);
  const [runClock, setRunClock] = useState(Date.now());
  const [runState, setRunState] = useState({
    busy: false,
    error: "",
    notice: "",
    tone: "",
    status: "",
    startedAt: null,
  });
  const activeRemoteFilters = useMemo(() => ({
    ...(typeFilter ? { noticeType: typeFilter } : {}),
    ...(relevanceFilter ? { relevance: relevanceFilter } : {}),
    ...(customerFilter ? { customerId: customerFilter } : {}),
    ...(debouncedQuery ? { q: debouncedQuery } : {}),
  }), [customerFilter, debouncedQuery, relevanceFilter, typeFilter]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => globalThis.clearTimeout(timer);
  }, [query]);

  const openNotice = useCallback((notice, event) => {
    lastNoticeTriggerRef.current = event?.currentTarget ?? null;
    setSelectedNotice(notice);
  }, []);

  const closeNotice = useCallback(() => {
    setSelectedNotice(null);
    const trigger = lastNoticeTriggerRef.current;
    if (trigger && typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => trigger.focus?.());
    } else {
      trigger?.focus?.();
    }
  }, []);

  const refreshScheduler = useCallback(async () => {
    if (!apiClient?.getHospitalTenderScheduler || backendStatus !== "connected") return null;
    try {
      const nextScheduler = await apiClient.getHospitalTenderScheduler();
      setRemoteState((current) => ({ ...current, scheduler: nextScheduler }));
      return nextScheduler;
    } catch {
      return null;
    }
  }, [apiClient, backendStatus]);

  const refreshRemote = useCallback(async () => {
    if (!apiClient || backendStatus === "offline") return;
    const generation = ++refreshGenerationRef.current;
    setRemoteState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [nextNoticePage, nextSummary, nextSources, nextHealth, nextScheduler] = await Promise.all([
        apiClient.listHospitalTenderPage
          ? apiClient.listHospitalTenderPage({ ...activeRemoteFilters, limit: NOTICE_PAGE_SIZE, offset: 0 })
          : apiClient.listHospitalTenders(activeRemoteFilters).then((items) => ({ items, total: items.length, hasMore: false })),
        apiClient.getHospitalTenderSummary(),
        apiClient.listHospitalTenderSources(),
        apiClient.getHospitalTenderHealth(),
        apiClient.getHospitalTenderScheduler
          ? apiClient.getHospitalTenderScheduler().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation !== refreshGenerationRef.current) return;
      setRemoteState({
        loading: false,
        error: "",
        notices: nextNoticePage.items,
        noticeTotal: nextNoticePage.total,
        noticeHasMore: Boolean(nextNoticePage.hasMore),
        summary: nextSummary,
        sources: nextSources,
        health: nextHealth,
        scheduler: nextScheduler,
      });
      setVisibleNoticeCount(INITIAL_VISIBLE_NOTICE_COUNT);
    } catch (error) {
      if (generation !== refreshGenerationRef.current) return;
      setRemoteState((current) => ({ ...current, loading: false, error: String(error?.message ?? "招标公告加载失败") }));
    }
  }, [activeRemoteFilters, apiClient, backendStatus]);

  useEffect(() => {
    if (apiClient && backendStatus === "connected") void refreshRemote();
  }, [apiClient, backendStatus, refreshRemote]);

  useEffect(() => {
    if (!runState.busy) return undefined;
    const timer = globalThis.setInterval(() => setRunClock(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [runState.busy]);

  useEffect(() => {
    if (!runState.busy || !apiClient?.getHospitalTenderScheduler) return undefined;
    let cancelled = false;
    const poll = async () => {
      if (!cancelled) await refreshScheduler();
    };
    void poll();
    const timer = globalThis.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [apiClient, refreshScheduler, runState.busy]);

  const runInternalMonitor = useCallback(async () => {
    if ((!apiClient?.runHospitalTenderScheduler && !apiClient?.runHospitalTenderMonitor) || backendStatus !== "connected") return;
    const startedAt = Date.now();
    setRunClock(startedAt);
    setRunState({ busy: true, error: "", notice: "", tone: "blue", status: "running", startedAt });
    try {
      const result = apiClient.runHospitalTenderScheduler
        ? await apiClient.runHospitalTenderScheduler()
        : await apiClient.runHospitalTenderMonitor();
      const status = firstText(result?.status, result?.state?.lastStatus)
        || (Number(result?.rejectedCount) > 0 ? "partial" : "success");
      const accepted = Number(result?.acceptedCount ?? result?.state?.lastAcceptedCount ?? 0);
      const rejected = Number(result?.rejectedCount ?? result?.state?.lastRejectedCount ?? 0);
      if (status === "partial") {
        setRunState({
          busy: false,
          error: "",
          notice: `本批检测部分完成：已入库 ${accepted} 条，${rejected || "部分"} 条异常；失败来源会在下一轮重试。`,
          tone: "warning",
          status,
          startedAt: null,
        });
      } else if (["failed", "error"].includes(status)) {
        setRunState({ busy: false, error: "检测失败，请查看来源状态后重试。", notice: "", tone: "danger", status: "failed", startedAt: null });
      } else if (["running", "waiting", "disabled", "skipped"].includes(status)) {
        setRunState({
          busy: false,
          error: "",
          notice: status === "disabled" ? "自动轮巡已停用，本次未启动检测。" : "检测任务尚未完成，当前状态已同步到自动轮巡。",
          tone: status === "disabled" ? "" : "warning",
          status,
          startedAt: null,
        });
      } else {
        setRunState({
          busy: false,
          error: "",
          notice: `本批检测完成：已入库 ${accepted} 条公告，客户匹配已更新。`,
          tone: "success",
          status: "success",
          startedAt: null,
        });
      }
      await refreshRemote();
    } catch (error) {
      if (error?.status === 409 || error?.code === "HOSPITAL_TENDER_RUN_IN_PROGRESS") {
        await refreshScheduler();
        setRunState({
          busy: false,
          error: "",
          notice: "已有检测任务正在运行，页面已切换为跟踪状态。",
          tone: "warning",
          status: "running",
          startedAt: null,
        });
      } else {
        setRunState({ busy: false, error: userFacingTenderError(error?.message, "检测未完成，请稍后重试。"), notice: "", tone: "danger", status: "failed", startedAt: null });
      }
    }
  }, [apiClient, backendStatus, refreshRemote]);

  const loadMoreNotices = useCallback(async () => {
    if (noticeLoadingMore || !remoteState.noticeHasMore || !apiClient?.listHospitalTenderPage || backendStatus !== "connected") return;
    const currentNotices = Array.isArray(remoteState.notices) ? remoteState.notices : [];
    const generation = refreshGenerationRef.current;
    setNoticeLoadingMore(true);
    try {
      const nextPage = await apiClient.listHospitalTenderPage({ ...activeRemoteFilters, limit: NOTICE_PAGE_SIZE, offset: currentNotices.length });
      if (generation !== refreshGenerationRef.current) return;
      setRemoteState((current) => {
        const existing = Array.isArray(current.notices) ? current.notices : [];
        const seen = new Set(existing.map((item) => item?.id));
        const merged = [...existing, ...nextPage.items.filter((item) => !seen.has(item?.id))];
        return {
          ...current,
          notices: merged,
          noticeTotal: nextPage.total,
          noticeHasMore: Boolean(nextPage.hasMore),
        };
      });
    } catch (error) {
      setRemoteState((current) => ({ ...current, error: String(error?.message ?? "更多公告加载失败") }));
    } finally {
      setNoticeLoadingMore(false);
    }
  }, [activeRemoteFilters, apiClient, backendStatus, noticeLoadingMore, remoteState.noticeHasMore, remoteState.notices]);

  const effectiveNotices = remoteState.notices ?? notices;
  const effectiveSummary = remoteState.summary ?? summary;
  const effectiveSources = remoteState.sources ?? sources;
  const effectiveHealth = remoteState.health ?? health;
  const effectiveLoading = Boolean(loading || remoteState.loading || (apiClient && backendStatus === "connecting"));
  const effectiveError = remoteState.error || error;
  const notificationState = effectiveHealth?.notification ?? remoteState.scheduler?.notification ?? null;
  const customerNameById = useMemo(
    () => new Map((Array.isArray(customers) ? customers : []).map((customer) => [customerValue(customer), customerLabel(customer)])),
    [customers],
  );

  const normalizedNotices = useMemo(
    () => (Array.isArray(effectiveNotices) ? effectiveNotices : []).map((notice, index) => normalizeNotice(notice, index, customerNameById)),
    [customerNameById, effectiveNotices],
  );
  const typeOptions = useMemo(
    () => [...new Set([...Object.keys(TYPE_LABELS), ...normalizedNotices.map((notice) => notice.type)])],
    [normalizedNotices],
  );
  const customerOptions = useMemo(() => {
    const values = new Map();
    for (const customer of customers) {
      const value = customerValue(customer);
      const label = customerLabel(customer);
      if (value && label) values.set(value, label);
    }
    for (const notice of normalizedNotices) {
      if (notice.customerId && notice.customerName) values.set(notice.customerId, notice.customerName);
    }
    return [...values.entries()];
  }, [customers, normalizedNotices]);
  const filteredNotices = useMemo(() => normalizedNotices.filter((notice) => (
    (!typeFilter || notice.type === typeFilter)
    && (!relevanceFilter || notice.relevance === relevanceFilter)
    && (!customerFilter || notice.customerId === customerFilter || notice.customerName === customerFilter)
    && (!query || [notice.title, notice.customerName, notice.sourceName, notice.purchaser, notice.projectCode]
      .some((value) => firstText(value).toLowerCase().includes(query.trim().toLowerCase())))
  )), [customerFilter, normalizedNotices, query, relevanceFilter, typeFilter]);

  const hasFilters = Boolean(typeFilter || relevanceFilter || customerFilter || query.trim());

  useEffect(() => {
    setVisibleNoticeCount(INITIAL_VISIBLE_NOTICE_COUNT);
  }, [customerFilter, query, relevanceFilter, typeFilter]);

  const highRelevanceCount = metricValue(
    effectiveSummary,
    ["highRelevanceCount", "highRelevance", "highCount", "priorityCount"],
    effectiveSummary?.byRelevance?.high ?? normalizedNotices.filter((notice) => notice.relevance === "high").length,
  );
  const deadlineSoonCount = metricValue(
    effectiveSummary,
    ["deadlineSoonCount", "deadlineSoon", "dueSoon", "expiringCount"],
    normalizedNotices.filter((notice) => deadlineWithinNextSevenDays(notice.deadline)).length,
  );
  const todayNewCount = metricValue(
    effectiveSummary,
    ["todayNewCount", "todayNew", "newToday", "todayCount"],
    normalizedNotices.filter((notice) => publishedToday(notice.publishedAt)).length,
  );
  const priorityNotices = useMemo(
    () => [...filteredNotices].sort((left, right) => relevanceRank(left.relevance) - relevanceRank(right.relevance) || deadlineTimestamp(left.deadline) - deadlineTimestamp(right.deadline)).slice(0, 5),
    [filteredNotices],
  );
  const visibleAllNotices = filteredNotices.slice(0, visibleNoticeCount);
  const loadedNoticeCount = normalizedNotices.length;
  const totalNoticeCount = Number.isSafeInteger(remoteState.noticeTotal)
    ? remoteState.noticeTotal
    : effectiveSummary?.totalNotices ?? loadedNoticeCount;
  const canShowMoreLoaded = filteredNotices.length > visibleNoticeCount;
  const canLoadMoreRemote = Boolean(remoteState.noticeHasMore);
  const latestPublishedAt = effectiveSummary?.latestPublishedAt;
  const runStateItem = remoteState.scheduler?.item ?? remoteState.scheduler ?? null;
  const elapsedMs = runState.startedAt ? runClock - runState.startedAt : 0;
  const monitorBusy = runState.busy || runStateItem?.lastStatus === "running";
  const effectiveErrorMessage = userFacingTenderError(effectiveError);

  return (
    <section className="hospital-tender-page" data-testid="hospital-tender-page">
      <header className="hospital-tender-header">
        <div className="hospital-tender-title">
          <span className="eyebrow">商机情报</span>
          <h1>医院招标监测</h1>
          <p>聚合公开公告，辅助销售识别医院采购机会。</p>
          <div className="hospital-tender-freshness" aria-label="数据新鲜度">
            <span><Clock3 size={14} />上次检测：{formatSchedulerDate(effectiveSummary?.latestRun?.finishedAt ?? effectiveSummary?.updatedAt, "等待同步")}</span>
            <span><FileText size={14} />最新公告：{formatSchedulerDate(latestPublishedAt, "暂无公告")}{latestPublishedAt ? ` · ${relativeAge(latestPublishedAt)}` : ""}</span>
          </div>
        </div>
        <div className="hospital-tender-actions">
          <button className="primary-button" type="button" onClick={() => { void runInternalMonitor(); }} disabled={effectiveLoading || monitorBusy || backendStatus !== "connected"}>
            {monitorBusy ? <LoaderCircle className="state-spinner" size={16} /> : <BellRing size={16} />}
            {monitorBusy ? "检测进行中" : "立即检测下一批"}
          </button>
          <button className="ghost-button" type="button" onClick={() => { void refreshRemote(); onRefresh?.(); }} disabled={effectiveLoading || monitorBusy}>
            {effectiveLoading ? <LoaderCircle className="state-spinner" size={16} /> : <RefreshCw size={16} />}
            {effectiveLoading ? "正在刷新" : "刷新数据"}
          </button>
        </div>
      </header>

      {effectiveError ? <div className="hospital-tender-alert" role="alert"><CircleAlert size={17} /><span>{effectiveErrorMessage}</span><button className="ghost-button" type="button" onClick={() => { void refreshRemote(); onRefresh?.(); }}>重试</button></div> : null}
      {runState.error ? <div className="hospital-tender-alert" role="alert"><CircleAlert size={17} /><span>{runState.error}</span><button className="ghost-button" type="button" onClick={() => { void runInternalMonitor(); }}>重试检测</button></div> : null}
      {runState.busy ? (
        <div className="hospital-tender-run-progress" role="status" aria-live="polite">
          <LoaderCircle className="state-spinner" size={17} />
          <span><strong>检测进行中</strong><small>已运行 {formatElapsed(elapsedMs)}{runStateItem?.cycleProcessedCount ? ` · 已处理 ${runStateItem.cycleProcessedCount} 家客户` : " · 正在等待来源反馈"}</small></span>
          {runStateItem?.cycleCustomerCount ? <b>{runStateItem.cycleProcessedCount || 0} / {runStateItem.cycleCustomerCount}</b> : null}
        </div>
      ) : null}
      {runState.notice ? <p className={`hospital-tender-feedback ${runState.tone}`} role="status"><span>{runState.notice}</span></p> : null}

      <div className="hospital-tender-priority-strip" aria-label="医院招标概览">
        <PriorityMetric label="高相关" value={highRelevanceCount} detail="重点机会" tone="danger" icon={Target} />
        <PriorityMetric label="临近截止" value={deadlineSoonCount} detail="7 天内截止" tone="warning" icon={Clock3} />
        <PriorityMetric label="今日新增" value={todayNewCount} detail="较昨日新增" tone="blue" icon={FileText} />
      </div>

      <div className="hospital-tender-content-grid">
        <Panel title="重点机会" meta={`显示 ${priorityNotices.length} 条`} className="hospital-tender-priority-panel">
          <div className="hospital-tender-table-head hospital-tender-priority-head"><span>公告标题</span><span>客户</span><span>截止时间</span><span>相关性</span><span aria-hidden="true" /></div>
          {effectiveLoading && normalizedNotices.length === 0 ? <div className="hospital-tender-loading" role="status"><LoaderCircle className="state-spinner" size={21} />正在读取招标公告</div> : null}
          {!effectiveLoading && priorityNotices.length === 0 ? <p className="hospital-tender-empty">暂时没有符合条件的重点机会，调整筛选条件或点击“立即检测下一批”。</p> : null}
          <div className="hospital-tender-priority-list">
            {priorityNotices.map((notice) => <PriorityNoticeRow key={notice.id} notice={notice} onSelect={openNotice} />)}
          </div>
          {priorityNotices.length > 0 ? <p className="hospital-tender-note"><Target size={14} />相关性基于客户历史合作、产品匹配度、采购金额及项目阶段综合计算，仅供参考。</p> : null}
        </Panel>

        <aside className="hospital-tender-side-column">
          <Panel title="全部公告" meta={hasFilters ? `匹配 ${totalNoticeCount} 条` : `共 ${totalNoticeCount} 条`} className="hospital-tender-all-panel">
            <div className="hospital-tender-filter-bar">
              <span className="hospital-tender-filter-label"><Filter size={14} />筛选公告</span>
              <label className="hospital-tender-filter"><span>公告类型</span><select aria-label="筛选公告类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">全部公告</option>{typeOptions.map((type) => <option value={type} key={type}>{TYPE_LABELS[type] ?? type}</option>)}</select></label>
              <label className="hospital-tender-filter"><span>相关性</span><select aria-label="筛选相关性" value={relevanceFilter} onChange={(event) => setRelevanceFilter(event.target.value)}><option value="">全部</option>{Object.entries(RELEVANCE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <label className="hospital-tender-filter"><span>客户</span><select aria-label="筛选客户" value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}><option value="">全部客户</option>{customerOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              {hasFilters ? <button className="hospital-tender-clear-filter ghost-button" type="button" onClick={() => { setTypeFilter(""); setRelevanceFilter(""); setCustomerFilter(""); setQuery(""); }}>清除筛选</button> : null}
            </div>
            <div className="hospital-tender-search">
              <Search size={15} />
              <input aria-label="搜索公告" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、医院、采购人或项目编号" />
              {query ? <button type="button" aria-label="清除关键词" onClick={() => setQuery("")}><X size={14} /></button> : null}
            </div>
            {!effectiveLoading && filteredNotices.length === 0 ? (
              <div className="hospital-tender-empty">
                <span>{hasFilters ? "没有符合当前条件的公告" : "暂无公告"}</span>
                {hasFilters ? <button className="hospital-tender-clear-filter ghost-button" type="button" onClick={() => { setTypeFilter(""); setRelevanceFilter(""); setCustomerFilter(""); setQuery(""); }}>清除筛选</button> : null}
              </div>
            ) : null}
            <div className="hospital-tender-all-list">{visibleAllNotices.map((notice) => <AllNoticeRow key={notice.id} notice={notice} onSelect={openNotice} />)}</div>
            {(canShowMoreLoaded || canLoadMoreRemote || loadedNoticeCount > 0) ? (
              <div className="hospital-tender-list-footer">
                <span>{hasFilters ? `当前显示 ${visibleAllNotices.length} / ${totalNoticeCount} 条匹配公告` : `当前显示 ${visibleAllNotices.length} / ${totalNoticeCount} 条公告`}</span>
                {canShowMoreLoaded ? <button className="ghost-button" type="button" onClick={() => setVisibleNoticeCount((count) => count + INITIAL_VISIBLE_NOTICE_COUNT)}>显示更多</button> : null}
                {!canShowMoreLoaded && canLoadMoreRemote ? <button className="ghost-button" type="button" onClick={() => { void loadMoreNotices(); }} disabled={noticeLoadingMore}>{noticeLoadingMore ? "正在加载" : "加载更多公告"}</button> : null}
              </div>
            ) : null}
          </Panel>
          <HealthSummary sources={effectiveSources} health={effectiveHealth} />
          <SchedulerProgress scheduler={remoteState.scheduler} busy={runState.busy} elapsedMs={elapsedMs} notification={notificationState} />
        </aside>
      </div>

      {selectedNotice ? <NoticeDetail notice={selectedNotice} onClose={closeNotice} onSelectCustomer={onSelectCustomer} /> : null}
    </section>
  );
}

export default HospitalTenderPage;
