import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CarFront,
  Check,
  Clock3,
  ExternalLink,
  LoaderCircle,
  MapPin,
  Navigation,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AmapRouteMap } from "./AmapRouteMap.jsx";
import { geocodeVisitItineraryPayload } from "./amapGeocoder.js";
import {
  addVisitStop,
  applyCustomerToVisitStop,
  buildAmapNavigationUrl,
  createEmptyVisitItineraryDraft,
  draftFromVisitItinerary,
  orderedVisitStops,
  visitItineraryMatches,
  visitItineraryPayload,
} from "./visitItineraryModel.js";

const statusLabels = {
  planned: "待执行",
  completed: "已完成",
  cancelled: "已取消",
};

const priorityLabels = {
  low: "低",
  normal: "普通",
  medium: "重点",
  high: "优先",
};

function formatDistance(value) {
  const meters = Number(value);
  if (!Number.isFinite(meters)) return "--";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "--";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours} 小时 ${remainder} 分` : `${remainder} 分钟`;
}

function formatTime(value) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function ListView({ items, onOpen, query, setQuery, statusFilter, setStatusFilter }) {
  const filtered = useMemo(() => items.filter((item) => (
    (!statusFilter || item.status === statusFilter) && visitItineraryMatches(item, query)
  )), [items, query, statusFilter]);

  return (
    <section className="itinerary-page itinerary-list-view" data-testid="itinerary-list-view">
      <div className="itinerary-list-toolbar">
        <label className="search-box page-search itinerary-search">
          <Search size={17} />
          <input
            data-testid="itinerary-local-search"
            aria-label="搜索拜访行程"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、日期或客户"
          />
        </label>
        <label className="itinerary-filter">
          <span>状态</span>
          <select aria-label="筛选行程状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">全部</option>
            <option value="planned">待执行</option>
            <option value="completed">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
      </div>

      <div className="panel itinerary-list-panel">
        <div className="itinerary-table-head" aria-hidden="true">
          <span>行程</span><span>拜访客户</span><span>预计路程</span><span>状态</span><span />
        </div>
        <div className="itinerary-table-body">
          {filtered.map((item) => (
            <article className="itinerary-table-row" key={item.id}>
              <button className="itinerary-row-main" type="button" onClick={() => onOpen(item.id)}>
                <span className="itinerary-date-tile">
                  <CalendarDays size={16} />
                  <b>{item.visitDate.slice(5)}</b>
                </span>
                <span className="itinerary-row-title">
                  <strong>{item.title}</strong>
                  <small>{item.request.departureAddress}</small>
                </span>
              </button>
              <span className="itinerary-row-customers">
                <strong>{item.request.stops.length}</strong>
                <small>{item.request.stops.map((stop) => stop.customerName).join("、")}</small>
              </span>
              <span className="itinerary-row-distance">
                <strong>{formatDistance(item.plan?.route?.distanceMeters)}</strong>
                <small>{formatDuration(item.plan?.route?.durationSeconds)}</small>
              </span>
              <span className={`pill itinerary-status ${item.status}`}>{statusLabels[item.status] ?? item.status}</span>
              <button className="ghost-button" type="button" onClick={() => onOpen(item.id)}>查看详情</button>
            </article>
          ))}
          {filtered.length === 0 ? <p className="empty-list">没有符合条件的拜访行程</p> : null}
        </div>
      </div>
    </section>
  );
}

function DetailView({ item, onBack, onEdit, onDelete }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (!item) {
    return (
      <section className="itinerary-page" data-testid="itinerary-detail-view">
        <p className="empty-list">该行程已不存在</p>
        <button className="ghost-button" type="button" onClick={onBack}><ArrowLeft size={16} />返回列表</button>
      </section>
    );
  }
  const orderedStops = orderedVisitStops(item);
  const totals = item.plan?.totals ?? {};

  return (
    <section className="itinerary-page itinerary-detail-view" data-testid="itinerary-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={onBack}><ArrowLeft size={16} />返回列表</button>
        <div className="detail-toolbar-actions">
          <button className="ghost-button" type="button" onClick={onEdit}><Pencil size={16} />修改</button>
          <button className="ghost-button danger" type="button" onClick={() => setConfirmingDelete(true)}><Trash2 size={16} />删除</button>
        </div>
      </div>

      {confirmingDelete ? (
        <div className="itinerary-delete-confirmation" data-testid="itinerary-delete-confirmation" role="alertdialog" aria-label="确认删除拜访行程">
          <AlertCircle size={20} />
          <div><strong>删除这条拜访行程？</strong><span>删除后不会出现在列表中。</span></div>
          <button className="ghost-button" type="button" onClick={() => setConfirmingDelete(false)}>取消</button>
          <button className="ghost-button danger" type="button" onClick={onDelete}>确认删除</button>
        </div>
      ) : null}

      <div className="itinerary-detail-grid">
        <aside className="panel itinerary-summary-panel">
          <div className="itinerary-summary-status">
            <span className={`pill itinerary-status ${item.status}`}>{statusLabels[item.status] ?? item.status}</span>
            <small>v{item.version}</small>
          </div>
          <dl className="itinerary-facts">
            <div><dt>拜访日期</dt><dd>{item.visitDate}</dd></div>
            <div><dt>出发时间</dt><dd>{formatTime(item.request.departureAt)}</dd></div>
            <div><dt>出发地点</dt><dd>{item.plan.departure?.formattedAddress || item.request.departureAddress}</dd></div>
            <div><dt>客户数量</dt><dd>{orderedStops.length} 位</dd></div>
          </dl>
          <div className="itinerary-metric-grid">
            <span><CarFront size={17} /><b>{formatDistance(item.plan.route?.distanceMeters)}</b><small>总里程</small></span>
            <span><Clock3 size={17} /><b>{formatDuration(item.plan.route?.durationSeconds)}</b><small>行车</small></span>
            <span><Navigation size={17} /><b>{item.plan.route?.tollsCny ?? 0} 元</b><small>过路费</small></span>
            <span><Check size={17} /><b>{totals.endAt ? formatTime(totals.endAt) : "--"}</b><small>结束</small></span>
          </div>
          <div className="itinerary-ai-summary">
            <span>路线摘要</span>
            <p>{item.plan.summary}</p>
            {(item.plan.advice ?? []).map((advice) => <small key={advice}>{advice}</small>)}
          </div>
        </aside>

        <div className="itinerary-route-column">
          <AmapRouteMap itinerary={item} />
          <section className="panel itinerary-timeline-panel" aria-label="拜访顺序">
            <div className="panel-title"><strong>拜访顺序</strong><span>{orderedStops.length} 站</span></div>
            <div className="itinerary-route-timeline">
              {orderedStops.map((stop, index) => (
                <article className="itinerary-route-stop" key={stop.id}>
                  <span className="itinerary-stop-number">{index + 1}</span>
                  <div>
                    <div className="itinerary-stop-head">
                      <strong>{stop.customerName}</strong>
                      <span>{formatTime(stop.schedule?.arrivalAt)}</span>
                    </div>
                    <p><MapPin size={14} />{stop.formattedAddress || stop.address}</p>
                    <small>{priorityLabels[stop.priority] ?? stop.priority} · 停留 {stop.visitMinutes} 分钟</small>
                  </div>
                  <a className="ghost-button itinerary-navigation-link" href={buildAmapNavigationUrl(stop)} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} />导航
                  </a>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function ItineraryForm({ mode, selected, customers, onCancel, onSave }) {
  const [draft, setDraft] = useState(() => mode === "edit" && selected
    ? draftFromVisitItinerary(selected)
    : createEmptyVisitItineraryDraft());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(mode === "edit" && selected
      ? draftFromVisitItinerary(selected)
      : createEmptyVisitItineraryDraft());
    setError("");
  }, [mode, selected]);

  function updateField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateStop(stopId, field, value) {
    setDraft((current) => ({
      ...current,
      stops: current.stops.map((stop) => stop.id === stopId ? { ...stop, [field]: value } : stop),
    }));
  }

  function selectCustomer(stopId, customerId) {
    if (!customerId) {
      updateStop(stopId, "customerId", null);
      return;
    }
    const customer = customers.find((item) => item.id === customerId);
    if (customer) setDraft((current) => applyCustomerToVisitStop(current, stopId, customer));
  }

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    try {
      const payload = await geocodeVisitItineraryPayload(visitItineraryPayload(draft));
      await onSave(draft.id ? { ...payload, id: draft.id, version: draft.version } : payload);
      setError("");
    } catch (saveError) {
      setError(saveError?.code === "VERSION_CONFLICT"
        ? "行程已在其他窗口更新，请返回列表后重新打开。"
        : String(saveError?.message ?? "保存失败，请稍后重试。"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="itinerary-page itinerary-form-view" data-testid="itinerary-form-view" onSubmit={submit}>
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={onCancel}><ArrowLeft size={16} />取消</button>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="state-spinner" size={16} /> : <Save size={16} />}
          {mode === "edit" ? "保存并重新规划" : "生成并保存行程"}
        </button>
      </div>

      {error ? <p className="itinerary-form-error" role="alert">{error}</p> : null}

      <section className="panel itinerary-form-basics">
        <div className="editor-grid three">
          <label className="form-field"><span>行程名称</span><input value={draft.title} onChange={(event) => updateField("title", event.target.value)} required /></label>
          <label className="form-field"><span>拜访日期</span><input type="date" value={draft.visitDate} onChange={(event) => updateField("visitDate", event.target.value)} required /></label>
          <label className="form-field"><span>状态</span><select value={draft.status} onChange={(event) => updateField("status", event.target.value)}><option value="planned">待执行</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
          <label className="form-field"><span>出发时间</span><input type="datetime-local" value={draft.departureAt} onChange={(event) => updateField("departureAt", event.target.value)} required /></label>
          <label className="form-field form-field-wide"><span>出发地址</span><input value={draft.departureAddress} onChange={(event) => updateField("departureAddress", event.target.value)} required /></label>
          <label className="form-field"><span>出发城市</span><input value={draft.departureCity} onChange={(event) => updateField("departureCity", event.target.value)} /></label>
        </div>
      </section>

      <section className="itinerary-stops-section">
        <div className="itinerary-section-head">
          <div><strong>拜访客户</strong><span>{draft.stops.length} / 8</span></div>
          <button className="ghost-button" type="button" onClick={() => setDraft((current) => addVisitStop(current))} disabled={draft.stops.length >= 8}><Plus size={16} />添加一站</button>
        </div>
        <div className="itinerary-stop-list">
          {draft.stops.map((stop, index) => (
            <article className="itinerary-stop-editor" key={stop.id}>
              <div className="itinerary-stop-editor-head">
                <span className="itinerary-stop-number">{index + 1}</span>
                <strong>{stop.customerName || `第 ${index + 1} 站`}</strong>
                <button className="icon-button" type="button" aria-label={`移除第 ${index + 1} 站`} disabled={draft.stops.length === 1} onClick={() => setDraft((current) => ({ ...current, stops: current.stops.filter((item) => item.id !== stop.id) }))}><X size={17} /></button>
              </div>
              <div className="editor-grid three">
                <label className="form-field"><span>关联客户</span><select value={stop.customerId ?? ""} onChange={(event) => selectCustomer(stop.id, event.target.value)}><option value="">手工填写</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
                <label className="form-field"><span>客户名称</span><input value={stop.customerName} onChange={(event) => updateStop(stop.id, "customerName", event.target.value)} required /></label>
                <label className="form-field"><span>优先级</span><select value={stop.priority} onChange={(event) => updateStop(stop.id, "priority", event.target.value)}><option value="normal">普通</option><option value="medium">重点</option><option value="high">优先</option><option value="low">低</option></select></label>
                <label className="form-field form-field-wide"><span>客户地址</span><input value={stop.address} onChange={(event) => updateStop(stop.id, "address", event.target.value)} required /></label>
                <label className="form-field"><span>城市</span><input value={stop.city} onChange={(event) => updateStop(stop.id, "city", event.target.value)} /></label>
                <label className="form-field"><span>停留时长</span><input type="number" min="1" max="480" value={stop.visitMinutes} onChange={(event) => updateStop(stop.id, "visitMinutes", Number(event.target.value))} required /></label>
                <label className="form-field"><span>预约时间</span><input type="datetime-local" value={stop.appointmentAt} onChange={(event) => updateStop(stop.id, "appointmentAt", event.target.value)} /></label>
                <label className="form-field form-field-wide"><span>备注</span><textarea value={stop.notes} onChange={(event) => updateStop(stop.id, "notes", event.target.value)} /></label>
              </div>
            </article>
          ))}
        </div>
      </section>
    </form>
  );
}

export function VisitItineraryPage({
  items = [],
  selected = null,
  viewMode = "list",
  customers = [],
  onOpen,
  onBack,
  onEdit,
  onSave,
  onDelete,
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  if (viewMode === "new" || viewMode === "edit") {
    return (
      <ItineraryForm
        mode={viewMode}
        selected={selected}
        customers={customers}
        onCancel={onBack}
        onSave={onSave}
      />
    );
  }
  if (viewMode === "detail") {
    return <DetailView item={selected} onBack={onBack} onEdit={onEdit} onDelete={onDelete} />;
  }
  return (
    <ListView
      items={items}
      onOpen={onOpen}
      query={query}
      setQuery={setQuery}
      statusFilter={statusFilter}
      setStatusFilter={setStatusFilter}
    />
  );
}
