import {
  BellRing,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Filter,
  HeartPulse,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  down: "暂时不可用",
};

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
  if (/healthy|ok|normal|正常/.test(status)) return "healthy";
  if (/down|error|failed|异常|不可用/.test(status)) return "down";
  return "warning";
}

function metricValue(summary, keys, fallback) {
  for (const key of keys) {
    const value = summary?.[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return fallback;
}

function NoticeDetail({ notice, onClose, onSelectCustomer }) {
  const matchReasons = [...new Set(Object.values(notice.matchReasons ?? {}).flat().filter(Boolean))];
  const matchedNeeds = [...new Set(Object.values(notice.matchedNeeds ?? {}).flat().filter(Boolean))];
  return (
    <div
      className="expense-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="expense-drawer" role="dialog" aria-modal="true" aria-labelledby="hospital-tender-detail-title">
        <header className="expense-drawer-head">
          <div>
            <span className="expense-kicker">公告详情</span>
            <h2 id="hospital-tender-detail-title">{notice.title}</h2>
            <p>{notice.sourceName} · {notice.publishedAt}</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭公告详情" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="expense-editor-form" style={{ minWidth: 0 }}>
          <div className="detail-metrics" style={{ minWidth: 0 }}>
            <section className="metric-inline"><span>公告类型</span><strong>{TYPE_LABELS[notice.type] ?? notice.type}</strong></section>
            <section className="metric-inline"><span>相关性</span><strong>{RELEVANCE_LABELS[notice.relevance]}</strong></section>
            <section className="metric-inline"><span>投标截止</span><strong>{notice.deadline}</strong></section>
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
      : health && typeof health === "object" && !("sourceCount" in health)
        ? Object.entries(health).map(([name, value]) => ({
          name,
          ...(value && typeof value === "object" ? value : { status: value }),
        }))
        : [];
  const items = healthItems.length ? healthItems : sourceItems;

  return (
    <Panel title="来源健康" meta={`${items.length} 个数据源`} className="hospital-tender-health">
      <div className="list-stack tiny" style={{ minWidth: 0 }}>
        {items.length === 0 ? <p className="empty-list">暂无数据源健康信息</p> : null}
        {items.map((item, index) => {
          const name = firstText(item?.name, item?.sourceName, item?.label, `数据源 ${index + 1}`);
          const status = statusClass(item?.status ?? item?.state ?? item?.health);
          return (
            <div className="compact-item" key={`${name}-${index}`} style={{ minWidth: 0 }}>
              <span className={`mini-icon ${status === "healthy" ? "success" : status === "down" ? "danger" : "warning"}`}><HeartPulse size={15} /></span>
              <span style={{ minWidth: 0 }}><strong>{name}</strong><small>{HEALTH_LABELS[item?.status] ?? HEALTH_LABELS[status] ?? "状态待确认"}{item?.lastChecked ? ` · ${item.lastChecked}` : ""}</small></span>
            </div>
          );
        })}
      </div>
    </Panel>
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
  const [selectedNotice, setSelectedNotice] = useState(null);

  const [remoteState, setRemoteState] = useState({
    loading: false,
    error: "",
    notices: null,
    summary: null,
    sources: null,
    health: null,
  });
  const refreshRemote = useCallback(async () => {
    if (!apiClient || backendStatus === "offline") return;
    setRemoteState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [nextNotices, nextSummary, nextSources, nextHealth] = await Promise.all([
        apiClient.listHospitalTenders(),
        apiClient.getHospitalTenderSummary(),
        apiClient.listHospitalTenderSources(),
        apiClient.getHospitalTenderHealth(),
      ]);
      setRemoteState({ loading: false, error: "", notices: nextNotices, summary: nextSummary, sources: nextSources, health: nextHealth });
    } catch (error) {
      setRemoteState((current) => ({ ...current, loading: false, error: String(error?.message ?? "招标公告加载失败") }));
    }
  }, [apiClient, backendStatus]);

  useEffect(() => {
    if (apiClient && backendStatus === "connected") void refreshRemote();
  }, [apiClient, backendStatus, refreshRemote]);

  const effectiveNotices = remoteState.notices ?? notices;
  const effectiveSummary = remoteState.summary ?? summary;
  const effectiveSources = remoteState.sources ?? sources;
  const effectiveHealth = remoteState.health ?? health;
  const effectiveLoading = Boolean(loading || remoteState.loading || (apiClient && backendStatus === "connecting"));
  const effectiveError = remoteState.error || error;
  const customerNameById = useMemo(
    () => new Map((Array.isArray(customers) ? customers : []).map((customer) => [customerValue(customer), customerLabel(customer)])),
    [customers],
  );

  const normalizedNotices = useMemo(
    () => (Array.isArray(effectiveNotices) ? effectiveNotices : []).map((notice, index) => normalizeNotice(notice, index, customerNameById)),
    [customerNameById, effectiveNotices],
  );
  const typeOptions = useMemo(() => [...new Set(normalizedNotices.map((notice) => notice.type))], [normalizedNotices]);
  const customerOptions = useMemo(() => {
    const values = new Map();
    for (const customer of customers) {
      const value = customerValue(customer);
      const label = customerLabel(customer);
      if (value && label) values.set(value, label);
    }
    for (const notice of normalizedNotices) {
      if (notice.customerName) values.set(notice.customerId || notice.customerName, notice.customerName);
    }
    return [...values.entries()];
  }, [customers, normalizedNotices]);
  const filteredNotices = useMemo(() => normalizedNotices.filter((notice) => (
    (!typeFilter || notice.type === typeFilter)
    && (!relevanceFilter || notice.relevance === relevanceFilter)
    && (!customerFilter || notice.customerId === customerFilter || notice.customerName === customerFilter)
  )), [customerFilter, normalizedNotices, relevanceFilter, typeFilter]);

  const metrics = [
    ["公告总数", metricValue(effectiveSummary, ["total", "totalNotices", "noticeCount", "count"], normalizedNotices.length)],
    ["高相关", metricValue(effectiveSummary, ["highRelevance", "highCount", "priorityCount"], normalizedNotices.filter((notice) => notice.relevance === "high").length)],
    ["临近截止", metricValue(effectiveSummary, ["deadlineSoon", "dueSoon", "expiringCount"], "—")],
  ];

  return (
    <section className="screen-grid hospital-tender-page" data-testid="hospital-tender-page" style={{ minWidth: 0, display: "grid", gap: 12 }}>
      <div className="page-heading compact-heading" style={{ minWidth: 0 }}>
        <div>
          <span className="eyebrow">商机情报</span>
          <h1>医院招标监测</h1>
          <p className="muted-copy">聚合公开公告，辅助销售识别医院采购机会。</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => { void refreshRemote(); onRefresh?.(); }} disabled={effectiveLoading}>
          {effectiveLoading ? <LoaderCircle className="state-spinner" size={16} /> : <RefreshCw size={16} />}
          {effectiveLoading ? "正在刷新" : "刷新数据"}
        </button>
      </div>

      {effectiveError ? <div className="expense-page-alert" role="alert"><CircleAlert size={17} /><span>{effectiveError}</span><button className="ghost-button" type="button" onClick={() => { void refreshRemote(); onRefresh?.(); }}>重试</button></div> : null}

      <div className="detail-metrics hospital-tender-metrics" style={{ minWidth: 0 }}>
        {metrics.map(([label, value]) => <section className="metric-inline" key={label}><span>{label}</span><strong>{value}</strong></section>)}
      </div>

      <div className="hospital-tender-layout" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12, minWidth: 0 }}>
        <Panel title="招标公告" meta={`${filteredNotices.length} / ${normalizedNotices.length} 条`} className="hospital-tender-list">
          <div className="itinerary-list-toolbar" style={{ flexWrap: "wrap", minWidth: 0 }}>
            <span className="muted-copy"><Filter size={15} />筛选</span>
            <label className="itinerary-filter"><span>公告类型</span><select aria-label="筛选公告类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">全部</option>{typeOptions.map((type) => <option value={type} key={type}>{TYPE_LABELS[type] ?? type}</option>)}</select></label>
            <label className="itinerary-filter"><span>相关性</span><select aria-label="筛选相关性" value={relevanceFilter} onChange={(event) => setRelevanceFilter(event.target.value)}><option value="">全部</option>{Object.entries(RELEVANCE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className="itinerary-filter"><span>客户</span><select aria-label="筛选客户" value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}><option value="">全部客户</option>{customerOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </div>

          {effectiveLoading && normalizedNotices.length === 0 ? <div className="expense-loading" role="status"><LoaderCircle className="state-spinner" size={21} />正在读取招标公告</div> : null}
          {!effectiveLoading && filteredNotices.length === 0 ? <p className="empty-list">没有符合条件的招标公告</p> : null}
          <div className="list-stack" style={{ minWidth: 0 }}>
            {filteredNotices.map((notice) => (
              <article className="compact-item hospital-tender-row" key={notice.id} style={{ alignItems: "flex-start", minWidth: 0 }}>
                <span className="mini-icon warning"><BellRing size={15} /></span>
                <button className="row-main-button" type="button" onClick={() => setSelectedNotice(notice)} style={{ minWidth: 0, flex: "1 1 auto", textAlign: "left" }}>
                  <strong>{notice.title}</strong>
                  <small>{notice.customerName || "未关联客户"} · {notice.sourceName}</small>
                  <small><CalendarClock size={13} /> 发布 {notice.publishedAt} · 截止 {notice.deadline}</small>
                </button>
                <span className={`pill ${notice.relevance === "high" ? "danger" : notice.relevance === "low" ? "muted" : "warning"}`}>{RELEVANCE_LABELS[notice.relevance]}</span>
                <button className="ghost-button compact-icon" type="button" aria-label={`查看${notice.title}详情`} onClick={() => setSelectedNotice(notice)}><ChevronRight size={16} /></button>
              </article>
            ))}
          </div>
        </Panel>
        <HealthSummary sources={effectiveSources} health={effectiveHealth} />
      </div>

      {selectedNotice ? <NoticeDetail notice={selectedNotice} onClose={() => setSelectedNotice(null)} onSelectCustomer={onSelectCustomer} /> : null}
    </section>
  );
}

export default HospitalTenderPage;
