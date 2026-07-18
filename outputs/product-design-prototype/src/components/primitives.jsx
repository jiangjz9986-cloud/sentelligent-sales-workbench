import { useState } from "react";
import { Check, ChevronRight, ClipboardList, Sparkles, Target } from "lucide-react";
import { statusTone } from "../data/salesWorkbenchData.js";

export function Panel({ title, meta, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-title">
        <strong>{title}</strong>
        <span>{meta}</span>
      </div>
      {children}
    </section>
  );
}

export function MetricCard({ label, value, badge, tone, className = "", onClick, detail }) {
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
      <span>{label}</span>
      <strong>{value}</strong>
      <b className={`pill ${statusTone[tone]}`}>{badge}</b>
      {expanded && detail ? <small data-testid="metric-expanded">{detail}</small> : null}
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
  const dataByStage = new Map(stageCounts.map((item) => [item.stage, item]));
  return (
    <div className="stage-strip">
      {[
        "线索",
        "初步沟通",
        "调研机会",
        "方案输出",
        "方案交流",
        "预算确认",
        "暂停观察",
      ].map((stage) => {
        const stageData = dataByStage.get(stage);
        const amount = stageData?.amount;
        const hasAmount = amount !== null && amount !== undefined && String(amount).trim() !== "";

        return (
          <button
            className={`stage-card ${onStageClick ? "interactive-card" : ""}`}
            key={stage}
            type="button"
            onClick={() => onStageClick?.(stage)}
          >
            <span>{stage}</span>
            <strong>{stageData?.count ?? 0}</strong>
            {hasAmount ? <small>{amount}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MatchCard({ title, value, meta, tone }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      className={`match-card interactive-card ${expanded ? "expanded" : ""}`}
      type="button"
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={`mini-icon ${statusTone[tone]}`}>
        <Target size={15} />
      </span>
      <div>
        <small>{title}</small>
        <strong>{value}</strong>
        <em>{meta}</em>
        {expanded ? <small className="item-detail">匹配依据已展开，可结合当前记录调整同步目标。</small> : null}
      </div>
    </button>
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

export function ExpandableInsight({
  children,
  tone = "blue",
  detail = "已展开：可结合客户、商机、动作和周报继续处理。",
  testId,
  expandedTestId,
  ariaLabel,
}) {
  const [expanded, setExpanded] = useState(false);
  const fallbackLabel = typeof children === "string" && children.trim() ? children : detail;

  return (
    <button
      className={`insight insight-card interactive-card ${tone} ${expanded ? "expanded" : ""}`}
      type="button"
      data-testid={testId}
      aria-label={ariaLabel ?? fallbackLabel}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className="insight-main">{children}</span>
      <ChevronRight className="insight-chevron" size={16} />
      {expanded ? (
        <small className="item-detail" data-testid={expandedTestId}>
          {detail}
        </small>
      ) : null}
    </button>
  );
}

export function InfoList({ items, tone = "blue" }) {
  const [expandedItem, setExpandedItem] = useState(null);
  return (
    <div className="info-list">
      {items.map((item) => (
        <button
          className={`info-item interactive-card ${expandedItem === item ? "expanded" : ""}`}
          key={item}
          type="button"
          onClick={() => setExpandedItem((current) => (current === item ? null : item))}
        >
          <span className={`mini-icon ${statusTone[tone]}`}>
            <ClipboardList size={15} />
          </span>
          <span>
            <strong>{item}</strong>
            {expandedItem === item ? <small className="item-detail">可关联客户、商机、周报或方案继续处理。</small> : null}
          </span>
        </button>
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

export function Timeline({ items = [] }) {
  const [expandedRow, setExpandedRow] = useState(null);
  const timelineItems = Array.isArray(items) ? items : [];

  return (
    <Panel title="阶段时间线" meta="记录来源">
      <div className="timeline">
        {timelineItems.length > 0 ? timelineItems.map((item, index) => {
          const id = item.id ?? `${item.date}-${item.title}-${index}`;
          return (
          <button
            className={`time-row interactive-card ${expandedRow === id ? "expanded" : ""}`}
            key={id}
            type="button"
            onClick={() => setExpandedRow((current) => (current === id ? null : id))}
          >
            <time>{item.date}</time>
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
              {expandedRow === id ? (
                <small className="item-detail" data-testid="timeline-expanded">
                  已展开：可回看来源记录、确认责任人，并同步下一步动作。
                </small>
              ) : null}
            </span>
          </button>
          );
        }) : (
          <p className="empty-list" data-testid="opportunity-timeline-empty">
            暂无时间线记录
          </p>
        )}
      </div>
    </Panel>
  );
}
