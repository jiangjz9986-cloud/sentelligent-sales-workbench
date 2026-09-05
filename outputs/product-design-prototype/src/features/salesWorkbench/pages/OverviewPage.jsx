import {
  AlarmClock,
  BriefcaseBusiness,
  CalendarDays,
  ChevronRight,
  Megaphone,
  Mic,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { statusTone } from "../../../data/salesWorkbenchData.js";
import { useNavigation } from "../../../app/useWorkbenchNavigation.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import {
  CompactList,
  MetricCard,
  Panel,
  StageStrip,
} from "../../../components/primitives.jsx";
import { ProactiveAssistantPanel } from "../components/ProactiveAssistantPanel.jsx";

function formatTodayFocusTime(value) {
  if (!value) return "时间待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待确认";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function TodayFocusSection({ icon: Icon, tone, title, badge, rows, moreLabel, emptyText, onOpen }) {
  return (
    <section className="today-focus-section">
      <button className="today-focus-head interactive-card" type="button" onClick={onOpen}>
        <span className={`mini-icon ${statusTone[tone]}`}>
          <Icon size={15} />
        </span>
        <strong>{title}</strong>
        {badge}
        <ChevronRight className="today-focus-chevron" size={15} />
      </button>
      {rows.length === 0 ? (
        <p className="today-focus-empty">{emptyText}</p>
      ) : (
        <div className="today-focus-rows">
          {rows.map((row) => (
            <button
              className="today-focus-row interactive-card"
              key={row.id}
              type="button"
              onClick={row.onClick ?? onOpen}
            >
              <strong>{row.primary}</strong>
              {row.secondary ? <small>{row.secondary}</small> : null}
            </button>
          ))}
          {moreLabel ? <small className="today-focus-more">{moreLabel}</small> : null}
        </div>
      )}
    </section>
  );
}

export function TodayFocusCard({ focus, setActive, openActionList, openRiskList }) {
  const itineraries = focus?.itineraries ?? { count: 0, items: [] };
  const todos = focus?.todos ?? { overdueCount: 0, todayCount: 0, items: [] };
  const risks = focus?.risks ?? { count: 0, items: [] };
  const tenders = focus?.tenders ?? { highCount: 0, items: [] };
  const todoTotal = todos.overdueCount + todos.todayCount;

  return (
    <Panel title="今日焦点" meta={focus?.date ?? ""} className="overview-today">
      <div className="today-focus-list">
        <TodayFocusSection
          icon={CalendarDays}
          tone="blue"
          title="今天的行程"
          badge={itineraries.count > 0 ? <b className="pill tone-blue">{itineraries.count} 条</b> : null}
          rows={itineraries.items.slice(0, 2).map((item) => ({
            id: item.id,
            primary: item.title,
            secondary: item.firstStop ? `首站 ${item.firstStop}` : "",
            onClick: () => setActive("itinerary", { mode: "detail", entityId: item.id }),
          }))}
          moreLabel={itineraries.count > 2 ? `共 ${itineraries.count} 条行程` : ""}
          emptyText="今日无行程，可到行程页安排拜访"
          onOpen={() => setActive("itinerary")}
        />
        <TodayFocusSection
          icon={AlarmClock}
          tone="amber"
          title="到点待办"
          badge={todoTotal > 0 ? (
            <span className="today-focus-badges">
              {todos.overdueCount > 0 ? <b className="pill tone-red">逾期 {todos.overdueCount}</b> : null}
              {todos.todayCount > 0 ? <b className="pill tone-amber">今日 {todos.todayCount}</b> : null}
            </span>
          ) : null}
          rows={todos.items.slice(0, 2).map((item) => ({
            id: item.id,
            primary: item.title,
            secondary: `${item.overdue ? "已逾期 · " : ""}${formatTodayFocusTime(item.remindAt)}`,
          }))}
          moreLabel={todoTotal > 2 ? `共 ${todoTotal} 条到点待办` : ""}
          emptyText="今日没有到点待办"
          onOpen={openActionList ? () => openActionList() : () => setActive("actions")}
        />
        <TodayFocusSection
          icon={ShieldAlert}
          tone="red"
          title="高风险"
          badge={risks.count > 0 ? <b className="pill tone-red">{risks.count} 项</b> : null}
          rows={risks.items.slice(0, 2).map((item) => ({
            id: item.id,
            primary: item.customerName || item.title,
            secondary: `${item.severity ?? "高"} · ${item.score ?? "--"} 分`,
          }))}
          moreLabel={risks.count > 2 ? `共 ${risks.count} 项高风险` : ""}
          emptyText="暂无高风险项"
          onOpen={openRiskList ? () => openRiskList() : () => setActive("risk")}
        />
        <TodayFocusSection
          icon={Megaphone}
          tone="teal"
          title="新招标"
          badge={tenders.highCount > 0 ? <b className="pill tone-teal">高相关 {tenders.highCount}</b> : null}
          rows={tenders.items.slice(0, 2).map((item) => ({
            id: item.id,
            primary: item.title,
            secondary: item.sourceName ?? "",
          }))}
          moreLabel={tenders.highCount > 2 ? `共 ${tenders.highCount} 条高相关` : ""}
          emptyText="近 24 小时暂无新招标"
          onOpen={() => setActive("hospital-tenders")}
        />
      </div>
    </Panel>
  );
}

function trendDeltaView(current, previous) {
  if (current === previous) return { label: "持平", tone: "" };
  if (previous === 0) return { label: "新增", tone: "is-up" };
  const delta = Math.round(((current - previous) / previous) * 100);
  return { label: `${delta > 0 ? "+" : ""}${delta}%`, tone: delta > 0 ? "is-up" : "is-down" };
}

function formatTrendCny(cents) {
  return Number.isSafeInteger(cents) ? `¥${(cents / 100).toFixed(2)}` : "¥0.00";
}

export function WeeklyTrendCard({ trend }) {
  const metrics = [
    {
      id: "quickRecords",
      label: "快速记录",
      current: trend?.quickRecords?.current ?? 0,
      previous: trend?.quickRecords?.previous ?? 0,
      format: (value) => `${value} 条`,
    },
    {
      id: "expenseCents",
      label: "差旅报销额",
      current: trend?.expenseCents?.current ?? 0,
      previous: trend?.expenseCents?.previous ?? 0,
      format: formatTrendCny,
    },
    {
      id: "completedTodos",
      label: "待办完成",
      current: trend?.completedTodos?.current ?? 0,
      previous: trend?.completedTodos?.previous ?? 0,
      format: (value) => `${value} 条`,
    },
  ];

  return (
    <Panel
      title="周趋势"
      meta={trend?.weekStart ? `本周 ${trend.weekStart} 起 vs 上周` : "本周 vs 上周"}
      className="overview-trend"
    >
      <div className="trend-list">
        {metrics.map((metric) => {
          const max = Math.max(metric.current, metric.previous, 1);
          const delta = trendDeltaView(metric.current, metric.previous);
          return (
            <div className="trend-row" key={metric.id}>
              <div className="trend-row-head">
                <strong>{metric.label}</strong>
                <span className="trend-values">
                  <b>{metric.format(metric.current)}</b>
                  <small>vs {metric.format(metric.previous)}</small>
                  <em className={`trend-delta ${delta.tone}`}>{delta.label}</em>
                </span>
              </div>
              <span className="trend-bar is-current" aria-hidden="true">
                <i style={{ "--value": `${Math.round((metric.current / max) * 100)}%` }} />
              </span>
              <span className="trend-bar is-previous" aria-hidden="true">
                <i style={{ "--value": `${Math.round((metric.previous / max) * 100)}%` }} />
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function Overview() {
  const {
    workbenchActions: actions,
    workbenchCustomers: customersList,
    workbenchOpportunities: opportunitiesList,
    overviewSummary: summary,
  } = useWorkbenchData();
  const {
    handleCreateProactiveConfirmationPreview,
    handleConfirmProactiveWriteback,
    handleProactiveLifecycleChange,
    handleUpdateProactiveSuggestion,
    handleRefreshProactive,
  } = useWorkbenchActions();
  const {
    navigateTo: setActive,
    setSelectedActionId,
    setSelectedCustomerId,
    setSelectedOpportunityId,
    openCustomerDetail,
    openOpportunityDetail,
    openOpportunityList,
    openActionDetail,
    openActionList,
    openRiskList,
  } = useNavigation();
  const metrics = summary?.metrics ?? {
    quickRecords: { value: 0, badge: "0 条待确认", tone: "blue" },
    opportunities: { value: 0, badge: "0 个重点推进", tone: "amber" },
    forecast: { value: "0 万", badge: "本月预测", tone: "green" },
    risks: { value: 0, badge: "暂无高风险", tone: "red" },
  };
  const priorityActions = (summary?.priorityActions ?? actions)
    .filter((item, index, source) => source.findIndex((candidate) => candidate.title === item.title) === index)
    .slice(0, 4);
  const healthItems = summary?.customerHeat ?? [];
  const recentRecords = summary?.recentRecords ?? [];
  const overviewOpportunities = summary?.opportunities ?? opportunitiesList.slice(0, 4);

  return (
    <div className="screen-grid overview-grid">
      {/* DOM 序=视觉序=读屏序：今日焦点与周趋势全端置顶（不用 CSS order）。 */}
      <TodayFocusCard
        focus={summary?.todayFocus}
        setActive={setActive}
        openActionList={openActionList}
        openRiskList={openRiskList}
      />

      <WeeklyTrendCard trend={summary?.weeklyTrend} />

      <ProactiveAssistantPanel
        assistant={summary?.proactiveAssistant}
        onCreatePreview={handleCreateProactiveConfirmationPreview}
        onConfirmWriteback={handleConfirmProactiveWriteback}
        onLifecycleChange={handleProactiveLifecycleChange}
        onUpdateSuggestion={handleUpdateProactiveSuggestion}
        onRefresh={handleRefreshProactive}
        onOpenOpportunity={(opportunityId) => {
          if (opportunityId && openOpportunityDetail) openOpportunityDetail(opportunityId);
          else if (opportunityId) {
            setSelectedOpportunityId(opportunityId);
            setActive("opportunity");
          } else {
            openOpportunityList ? openOpportunityList() : setActive("opportunity");
          }
        }}
      />

      <MetricCard label="本周快速记录" value={metrics.quickRecords.value} badge={metrics.quickRecords.badge} tone={metrics.quickRecords.tone} icon={Mic} className="overview-kpi" onClick={() => setActive("quick")} />
      <MetricCard label="重点商机" value={metrics.opportunities.value} badge={metrics.opportunities.badge} tone={metrics.opportunities.tone} icon={BriefcaseBusiness} className="overview-kpi" onClick={() => openOpportunityList ? openOpportunityList() : setActive("opportunity")} />
      <MetricCard label="预计回款" value={metrics.forecast.value} badge={metrics.forecast.badge} tone={metrics.forecast.tone} icon={TrendingUp} className="overview-kpi" onClick={() => setActive("kanban")} />
      <MetricCard label="高风险项" value={metrics.risks.value} badge={metrics.risks.badge} tone={metrics.risks.tone} icon={ShieldAlert} className="overview-kpi" onClick={() => openRiskList ? openRiskList() : setActive("risk")} />

      <Panel title="今日优先动作" meta="按风险排序" className="overview-priority">
        <CompactList
          items={priorityActions.map((item) => ({
            id: item.id,
            title: item.title,
            meta: `${item.customer} / ${item.due}`,
            tone: item.tone,
          }))}
          onSelect={(item) => {
            if (openActionDetail) {
              openActionDetail(item.id);
            } else {
              if (item.id) setSelectedActionId(item.id);
              setActive("actions");
            }
          }}
        />
      </Panel>

      <Panel title="客户温度" meta="本周变化" className="overview-health">
        <div className="progress-list">
          {healthItems.map(({ customerId, name, label, value, tone }) => (
            <button
              className="progress-row interactive-card"
              key={name}
              type="button"
              onClick={() => {
                const customer = customersList.find((item) => item.id === customerId || item.name === name);
                if (openCustomerDetail) {
                  openCustomerDetail(customer?.id);
                } else {
                  if (customer) setSelectedCustomerId(customer.id);
                  setActive("customer");
                }
              }}
            >
              <div>
                <strong>{name}</strong>
                <span>{label}</span>
              </div>
              <b className={`pill ${statusTone[tone]}`}>{value}%</b>
              <i style={{ "--value": `${value}%` }} />
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="最近快速记录" meta="来自拜访与电话" className="overview-records">
        {recentRecords.length === 0 ? (
          <button className="record-row" type="button" onClick={() => setActive("quick")}>
            <span className="date-chip tone-blue">今日</span>
            <span>
              <strong>暂无快速记录</strong>
              <small>点击新增拜访、电话或会议记录</small>
            </span>
          </button>
        ) : null}
        {recentRecords.map((item) => (
          <button className="record-row" key={item.id} type="button" onClick={() => setActive("quick")}>
            <span className={`date-chip ${statusTone[item.tone]}`}>{item.date}</span>
            <span>
              <strong>{item.customer}</strong>
              <small>{item.title} / {item.status}</small>
            </span>
          </button>
        ))}
      </Panel>

      <Panel title="重点商机列表" meta="点击进入详情" className="overview-opportunities">
        {overviewOpportunities.slice(0, 3).map((item) => (
          <button
            className="list-button compact"
            key={item.id}
            type="button"
            onClick={() => {
              if (openOpportunityDetail) openOpportunityDetail(item.id);
              else {
                setSelectedOpportunityId(item.id);
                setActive("opportunity");
              }
            }}
          >
            <span>
              <strong>{item.name}</strong>
              <small>{item.customer} / {item.stage}</small>
            </span>
            <b className={`pill ${statusTone[item.tone]}`}>{item.probability}%</b>
          </button>
        ))}
      </Panel>

      <Panel title="商机漏斗" meta="七阶段计数与金额" className="overview-stage span-full">
        <StageStrip stageCounts={summary?.stageCounts} onStageClick={() => setActive("kanban")} />
      </Panel>
    </div>
  );
}
