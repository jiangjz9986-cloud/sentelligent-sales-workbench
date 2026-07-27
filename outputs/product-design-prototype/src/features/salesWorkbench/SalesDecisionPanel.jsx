import {
  Bot,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  Target,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { assertBackendReady } from "../../app/workbenchState.js";
import {
  Panel,
  MetricInline,
} from "../../components/primitives.jsx";
import {
  salesDecisionHistoryLabel,
  salesDecisionViewModel,
  stageLabel,
} from "./salesDecisionViewModel.js";

function listText(items, empty = "暂无记录") {
  if (!Array.isArray(items) || items.length === 0) return <span className="muted-copy">{empty}</span>;
  return (
    <ul className="sales-decision-list">
      {items.map((item, index) => (
        <li key={`${index}-${typeof item === "string" ? item : item.question ?? item.summary ?? item.action}`}>
          {typeof item === "string" ? item : item.question ?? item.summary ?? item.action}
        </li>
      ))}
    </ul>
  );
}

function DetailBlock({ title, children, tone = "blue" }) {
  return (
    <section className={`sales-decision-block tone-${tone}`}>
      <strong>{title}</strong>
      {children}
    </section>
  );
}

export function SalesDecisionPanel({ selected, customer, apiClient, backendStatus }) {
  const [history, setHistory] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState("选择一次诊断，或查看已有历史结果。");

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setSelectedItem(null);
    setStatus("正在读取历史诊断");
    if (!selected?.id || !apiClient?.listSalesDecisionAnalyses) {
      setStatus("选择商机后可开始决策诊断");
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    apiClient.listSalesDecisionAnalyses({ opportunityId: selected.id })
      .then((result) => {
        if (cancelled) return;
        setHistory(result.items ?? []);
        setSelectedItem(result.items?.[0] ?? null);
        setStatus(result.items?.length ? "已载入最近一次诊断" : "暂无历史诊断，可开始一次新的判断");
      })
      .catch((error) => {
        if (!cancelled) setStatus(error?.message || "历史诊断读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, selected?.id]);

  const view = useMemo(() => salesDecisionViewModel(selectedItem), [selectedItem]);
  const analysis = selectedItem?.analysis ?? null;

  async function runAnalysis() {
    if (!selected?.id || !apiClient?.createSalesDecisionAnalysis) return;
    try {
      assertBackendReady({ isEnabled: apiClient.isEnabled, status: backendStatus }, "销售决策诊断");
    } catch (error) {
      setStatus(error.message);
      return;
    }
    setAnalyzing(true);
    setStatus("正在依据客户证据生成诊断");
    try {
      const result = await apiClient.createSalesDecisionAnalysis({
        analysisType: "opportunity_diagnosis",
        industry: /医院|医疗/.test(`${customer?.name ?? ""}${customer?.type ?? ""}`) ? "medical" : "general",
        customerId: customer?.id ?? selected.customerId ?? null,
        opportunityId: selected.id,
      });
      setHistory((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      setSelectedItem(result);
      setStatus("诊断已保存；写回业务档案前仍需人工确认");
    } catch (error) {
      setStatus(error?.message || "诊断失败，请稍后重试");
    } finally {
      setAnalyzing(false);
    }
  }

  async function openHistory(item) {
    if (!item?.id || !apiClient?.getSalesDecisionAnalysis) return;
    setStatus("正在读取历史诊断");
    try {
      const loaded = await apiClient.getSalesDecisionAnalysis(item.id);
      setSelectedItem(loaded);
      setStatus("历史诊断已载入，不会重新调用模型");
    } catch (error) {
      setStatus(error?.message || "历史诊断读取失败");
    }
  }

  return (
    <section data-testid="sales-decision-panel">
      <Panel
        title="销售决策诊断"
        meta="V1 · 证据优先"
        className="sales-decision-panel"
      >
      <div className="sales-decision-toolbar">
        <div className="sales-decision-intro">
          <Bot size={18} />
          <span>只生成判断和验证动作，不自动修改客户、商机或风险档案。</span>
        </div>
        <button
          className="primary-button"
          type="button"
          data-testid="sales-decision-analyze"
          disabled={loading || analyzing}
          onClick={runAnalysis}
        >
          <RefreshCw size={15} className={analyzing ? "spin" : ""} />
          {analyzing ? "分析中" : "开始诊断"}
        </button>
      </div>

      {history.length > 0 ? (
        <div className="sales-decision-history" data-testid="sales-decision-history">
          {history.slice(0, 5).map((item) => (
            <button
              className={`sales-decision-history-item ${selectedItem?.id === item.id ? "selected" : ""}`}
              key={item.id}
              type="button"
              aria-pressed={selectedItem?.id === item.id}
              onClick={() => openHistory(item)}
            >
              <span>{salesDecisionHistoryLabel(item)}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      ) : null}

      {analysis ? (
        <div className="sales-decision-result" data-testid="sales-decision-result">
          <div className="sales-decision-headline">
            <div>
              <span className={`pill tone-${view.decisionTone}`}>{view.decisionLabel}</span>
              <h3>{analysis.headline}</h3>
              <p>{analysis.decision?.reason}</p>
            </div>
            <div className="sales-decision-confidence">
              <strong>{analysis.decision?.confidence ?? 0}%</strong>
              <span>证据置信度</span>
            </div>
          </div>
          <div className="detail-metrics sales-decision-metrics">
            <MetricInline label="评分" value={view.scoreLabel} />
            <MetricInline label="建议阶段" value={stageLabel(analysis.stage?.recommended)} />
            <MetricInline label="待验证" value={`${view.unknownCount} 项`} />
            <MetricInline label="合规状态" value={view.complianceLabel} />
          </div>
          <div className="sales-decision-grid">
            <DetailBlock title="关键未知" tone="amber">
              {listText(analysis.unknowns, "关键未知已补齐")}
            </DetailBlock>
            <DetailBlock title="首要风险" tone="red">
              {listText(analysis.risks, "暂未识别出新增风险")}
            </DetailBlock>
            <DetailBlock title="下一步动作" tone="green">
              {listText(analysis.nextActions, "暂无可验证动作")}
            </DetailBlock>
            <DetailBlock title="建议提问" tone="blue">
              {listText(analysis.suggestedQuestions, "暂无建议提问")}
            </DetailBlock>
          </div>
          <div className="sales-decision-boundary">
            {analysis.compliance?.requiresEscalation ? <ShieldAlert size={16} /> : <Target size={16} />}
            <span>
              {analysis.compliance?.requiresEscalation
                ? `需要先完成审查：${analysis.compliance.flags?.join("、")}`
                : view.requiresHumanConfirmation
                  ? "分析结果仅供销售判断；写回客户、商机、动作或风险前必须人工确认。"
                  : "当前结果不可写回业务档案。"}
            </span>
          </div>
        </div>
      ) : (
        <div
          className="sales-decision-empty"
          data-testid="sales-decision-empty"
          role="status"
          aria-live="polite"
        >
          <Bot size={22} />
          <strong>{loading ? "正在读取历史诊断" : "暂无决策诊断"}</strong>
          <span>{status}</span>
        </div>
      )}
        {analysis ? (
          <div className="editor-status" role="status" aria-live="polite">
            {status}
          </div>
        ) : null}
      </Panel>
    </section>
  );
}
