import { useState } from "react";
import { Check, ChevronRight, ClipboardList, Sparkles, Target } from "lucide-react";
import { statusTone } from "../data/salesWorkbenchData.js";

export function Panel({ title, meta, action, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-title">
        <strong>{title}</strong>
        <div className="panel-title-end">
          {meta ? <span>{meta}</span> : null}
          {action ? <div className="panel-title-action">{action}</div> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function MetricCard({ label, value, badge, tone, className = "", onClick, detail, icon: Icon }) {
  const [expanded, setExpanded] = useState(false);
  const isInteractive = Boolean(onClick || detail);
  const Component = isInteractive ? "button" : "section";
  const handleClick = onClick ?? (() => setExpanded((current) => !current));

  return (
    <Component
      className={`metric-card ${isInteractive ? "interactive-card" : ""} ${expanded ? "expanded" : ""} ${className}`}
      type={isInteractive ? "button" : undefined}
      onClick={isInteractive ? handleClick : undefined}
    >
      {Icon ? (
        <span className={`metric-icon ${statusTone[tone]}`}>
          <Icon size={19} />
        </span>
      ) : null}
      <span className="metric-body">
        <span>{label}</span>
        <strong>{value}</strong>
        <b className={`pill ${statusTone[tone]}`}>{badge}</b>
        {expanded && detail ? <small data-testid="metric-expanded">{detail}</small> : null}
      </span>
      {onClick ? <ChevronRight className="metric-chevron" size={15} /> : null}
    </Component>
  );
}

export function MetricInline({ label, value }) {
  return (
    <section className="metric-inline">
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

export function CompactList({ items, onSelect }) {
  return (
    <div className="list-stack tiny">
      {items.map((item) => (
        <button
          className={`compact-item ${onSelect ? "interactive-card" : ""}`}
          key={item.title}
          type="button"
          onClick={() => onSelect?.(item)}
        >
          <span className={`mini-icon ${statusTone[item.tone]}`}>
            <ChevronRight size={15} />
          </span>
          <span>
            <strong>{item.title}</strong>
            <small>{item.meta}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function StageStrip({ stageCounts = [], onStageClick }) {
  const fixedStages = [
    "线索",
    "初步沟通",
    "调研机会",
    "方案输出",
    "方案交流",
    "预算确认",
    "暂停观察",
  ];
  const stageOrder = [...fixedStages];
  const dataByStage = new Map(fixedStages.map((stage) => [stage, { count: 0, amounts: [] }]));

  for (const item of Array.isArray(stageCounts) ? stageCounts : []) {
    const stage = String(item?.stage ?? "").trim() || "未设置";
    if (!dataByStage.has(stage)) {
      dataByStage.set(stage, { count: 0, amounts: [] });
      stageOrder.push(stage);
    }

    const stageData = dataByStage.get(stage);
    const count = Number(item?.count);
    stageData.count += Number.isFinite(count) ? count : 0;

    const amount = item?.amount;
    const amountText = amount === null || amount === undefined ? "" : String(amount).trim();
    if (amountText && !stageData.amounts.includes(amountText)) {
      stageData.amounts.push(amountText);
    }
  }

  const maxCount = Math.max(1, ...stageOrder.map((stage) => dataByStage.get(stage).count));

  return (
    <div className="stage-strip">
      {stageOrder.map((stage) => {
        const stageData = dataByStage.get(stage);
        const amount = stageData.amounts.join(" / ");

        return (
          <button
            className={`stage-card ${onStageClick ? "interactive-card" : ""}`}
            key={stage}
            type="button"
            onClick={() => onStageClick?.(stage)}
          >
            <span>{stage}</span>
            <strong>{stageData.count}</strong>
            {amount ? <small>{amount}</small> : null}
            <i
              className="stage-strip__bar"
              style={{ "--value": `${Math.round((stageData.count / maxCount) * 100)}%` }}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

// 匹配卡为纯展示：value/meta/置信度已全部呈现，没有可展开的增量信息（v0.10.0
// 去除无信息量交互；结构化升级归 v0.11.1 AI 卡片契约）。
export function MatchCard({ title, value, meta, tone }) {
  return (
    <section className="match-card">
      <span className={`mini-icon ${statusTone[tone]}`}>
        <Target size={15} />
      </span>
      <div>
        <small>{title}</small>
        <strong>{value}</strong>
        <em>{meta}</em>
      </div>
    </section>
  );
}

export function ExtractCard({ title, items }) {
  return (
    <section className="extract-card">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

// 洞察块与信息清单为纯展示：正文即全文，点击不会带来新信息（v0.10.0 去除
// 无信息量交互，正文与空值兜底文案保留）。
export function ExpandableInsight({ children, tone = "blue", testId }) {
  return (
    <div className={`insight insight-card ${tone}`} data-testid={testId}>
      <span className="insight-main">{children}</span>
    </div>
  );
}

export function InfoList({ items, tone = "blue" }) {
  return (
    <div className="info-list">
      {items.map((item) => (
        <span className="info-item" key={item}>
          <span className={`mini-icon ${statusTone[tone]}`}>
            <ClipboardList size={15} />
          </span>
          <span>
            <strong>{item}</strong>
          </span>
        </span>
      ))}
    </div>
  );
}

export function ManualConfirmBox({ title, desc, compact = false, onGenerate }) {
  const [status, setStatus] = useState("idle");
  const [suggestion, setSuggestion] = useState(null);
  const loading = status === "loading";
  const generated = status === "generated";
  const failed = status === "failed";

  async function handleGenerate() {
    if (loading) return;
    if (!onGenerate) {
      if (generated) {
        setStatus("idle");
        setSuggestion(null);
      } else {
        setStatus("generated");
        setSuggestion({ content: "已记录确认结果，可继续在相关业务档案中查看和调整。" });
      }
      return;
    }

    setStatus("loading");
    try {
      const result = await onGenerate();
      setSuggestion(result);
      setStatus("generated");
    } catch (error) {
      setSuggestion({ content: error?.message || "生成失败，请稍后重试。" });
      setStatus("failed");
    }
  }

  return (
    <section className={`manual-box ${compact ? "compact" : ""} ${generated ? "generated" : ""} ${failed ? "failed" : ""}`}>
      <div>
        <strong>{loading ? "正在生成建议" : generated ? "已生成建议" : failed ? "生成失败" : title}</strong>
        <p>
          {loading
            ? "正在整理当前业务信息。"
            : generated
              ? "建议已生成，可按当前业务情况决定是否采纳。"
              : failed
                ? "请检查服务状态后重试。"
                : desc}
        </p>
        {suggestion?.content ? (
          <div
            className={`generated-suggestion ${failed ? "failed" : ""}`}
            data-testid={failed ? "suggestion-error" : "generated-suggestion"}
          >
            {suggestion.content}
          </div>
        ) : null}
      </div>
      <button
        className={generated || failed ? "ghost-button" : "primary-button"}
        disabled={loading}
        type="button"
        onClick={handleGenerate}
      >
        {generated ? <Check size={16} /> : <Sparkles size={16} />}
        {loading ? "生成中" : generated ? "重新生成" : failed ? "重试" : "生成建议"}
      </button>
    </section>
  );
}

// 时间线行为纯展示：date/title/description 已全部呈现（来源跳转联动归 v0.11.0）。
export function Timeline({ items = [] }) {
  const timelineItems = Array.isArray(items) ? items : [];

  return (
    <Panel title="阶段时间线" meta="记录来源">
      <div className="timeline">
        {timelineItems.length > 0 ? timelineItems.map((item, index) => (
          <div className="time-row" key={item.id ?? `${item.date}-${item.title}-${index}`}>
            <time>{item.date}</time>
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
          </div>
        )) : (
          <p className="empty-list" data-testid="opportunity-timeline-empty">
            暂无时间线记录
          </p>
        )}
      </div>
    </Panel>
  );
}
