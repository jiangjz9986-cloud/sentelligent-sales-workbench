import {
  Check,
  ChevronRight,
  Download,
  FileText,
  Save,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { triggerBlobDownload } from "../../../downloadFile.js";
import { MetricCard } from "../../../components/primitives.jsx";
import { useToast } from "../../../components/toast.jsx";
import { formatWeekRangeLabel, getCurrentWeekRange } from "../../../weekRange.js";
import {
  formatRecordTime,
  groupRecordsByWeekday,
  weeklyRecordStatusView,
} from "../weeklyDaily.js";
import { DraftPreview, sourceRefText } from "./shared.jsx";

export function WeeklyPage({
  weeklyView,
  setWeeklyView,
  apiClient,
  backendStatus,
  weeklyDraft: externalWeeklyDraft,
  setWeeklyDraft: setExternalWeeklyDraft,
  weeklyDraftText: externalWeeklyDraftText,
  setWeeklyDraftText: setExternalWeeklyDraftText,
  quickRecords = [],
  onOpenQuickRecord,
}) {
  const [localWeeklyDraft, setLocalWeeklyDraft] = useState(null);
  const [localWeeklyDraftText, setLocalWeeklyDraftText] = useState("");
  const [draftStatus, setDraftStatus] = useState("周报草稿尚未生成。");
  const [isExporting, setIsExporting] = useState(false);
  const [expandedDayKey, setExpandedDayKey] = useState(null);
  const toast = useToast();
  const daily = weeklyView === "daily";
  const weeklyDraft = externalWeeklyDraft ?? localWeeklyDraft;
  const weeklyDraftText = externalWeeklyDraft ? externalWeeklyDraftText ?? "" : localWeeklyDraftText;
  const setWeeklyDraft = setExternalWeeklyDraft ?? setLocalWeeklyDraft;
  const setWeeklyDraftText = setExternalWeeklyDraftText ?? setLocalWeeklyDraftText;

  useEffect(() => {
    if (!weeklyDraft) return;
    setExpandedDayKey(null);
    const hasKnowledge = weeklyDraft.sourceRefs?.some((ref) => ref.type === "knowledge");
    setDraftStatus(hasKnowledge ? "已载入知识库引用周报，来源引用已保留。" : "周报草稿已生成，来源记录已保留。");
  }, [weeklyDraft?.id]);

  async function generateWeeklyDraft() {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，暂不能生成周报。");
      return;
    }

    setDraftStatus("正在从已确认进入周报的快速记录生成草稿");
    try {
      const { periodStart, periodEnd } = getCurrentWeekRange();
      const item = await apiClient.generateWeeklyDraft({
        periodStart,
        periodEnd,
      });
      setWeeklyDraft(item);
      setWeeklyDraftText(item.content);
      setDraftStatus("周报草稿已生成，来源记录已保留。");
      setWeeklyView("summary");
    } catch {
      setDraftStatus("周报草稿生成失败，请先确认快速记录已写入周报。");
    }
  }

  async function saveWeeklyDraft(status = "saved") {
    if (!weeklyDraft) {
      setDraftStatus("请先生成周报草稿。");
      return;
    }
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，暂不能保存周报。");
      return;
    }

    setDraftStatus(status === "ready" ? "正在确认周报定稿" : "正在保存周报编辑内容");
    try {
      const saved = await apiClient.saveWeeklyReport(weeklyDraft.id, {
        content: weeklyDraftText,
        status,
      }, weeklyDraft.version);
      setWeeklyDraft(saved);
      setWeeklyDraftText(saved.content);
      setDraftStatus(status === "ready" ? "周报已确认定稿，可导出 Word。" : "周报已保存，可继续编辑或导出。");
    } catch {
      setDraftStatus("周报保存失败，请稍后重试。");
    }
  }

  async function exportWeeklyDraft() {
    if (!weeklyDraft) {
      setDraftStatus("请先生成周报草稿。");
      return;
    }
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，暂不能导出周报。");
      return;
    }

    setIsExporting(true);
    setDraftStatus("正在准备周报文件");
    try {
      const download = await apiClient.downloadWeeklyReport(weeklyDraft.id, "word");
      await triggerBlobDownload(download);
      setDraftStatus("周报 Word 已导出。");
      toast({ tone: "success", title: "周报 Word 已导出", description: download.filename });
    } catch {
      setDraftStatus("周报导出失败，请稍后重试。");
    } finally {
      setIsExporting(false);
    }
  }

  const weeklyStatusLabel = {
    draft: "草稿",
    saved: "已保存",
    ready: "已定稿",
  }[weeklyDraft?.status] ?? weeklyDraft?.status ?? "未生成";
  const weekRangeLabel = formatWeekRangeLabel(getCurrentWeekRange());
  const sourceRefs = weeklyDraft?.sourceRefs ?? [];
  const sourceMetricDetail = sourceRefs.length > 0
    ? `${weekRangeLabel}：${sourceRefs.map(sourceRefText).join("；")}`
    : `${weekRangeLabel}：周报正文 ${weeklyDraftText.trim().length} 字`;

  if (!weeklyDraft) {
    return (
      <section className="workbench-state-panel" data-testid="weekly-empty" role="status">
        <FileText size={28} />
        <strong>尚未生成周报</strong>
        <p>{draftStatus}</p>
        <button className="primary-button" type="button" onClick={generateWeeklyDraft}>
          <Sparkles size={16} />
          生成本周周报
        </button>
      </section>
    );
  }

  return (
    <div className="weekly-layout">
      <section className="weekly-control">
        <div className="segmented large">
          <button
            className={daily ? "active" : ""}
            type="button"
            data-testid="weekly-daily-tab"
            onClick={() => setWeeklyView("daily")}
          >
            本周每日记录
          </button>
          <button
            className={!daily ? "active" : ""}
            type="button"
            data-testid="weekly-summary-tab"
            onClick={() => setWeeklyView("summary")}
          >
            周报分析汇总
          </button>
        </div>
        <p>
          参考销售周报结构：拜访时间、客户名称、目的目标、关键人员、工作策略、客户反馈、总结分析、竞争对手、下步计划。
        </p>
      </section>

      {daily ? (
        <div className="daily-grid" data-testid="weekly-daily-view">
          {groupRecordsByWeekday(quickRecords, getCurrentWeekRange()).map((day) => {
            const expanded = expandedDayKey === day.key;
            return (
              <article className={`day-card ${expanded ? "expanded" : ""}`} key={day.key}>
                <button
                  className="day-card-toggle interactive-card"
                  type="button"
                  aria-expanded={expanded}
                  data-testid="weekly-day-toggle"
                  onClick={() => setExpandedDayKey((current) => current === day.key ? null : day.key)}
                >
                  <div className="day-card-head">
                    <span className="date-chip tone-blue">{day.weekday}</span>
                    <h3>{day.dateLabel}</h3>
                    {day.records.length > 0 ? <b className="pill tone-blue">{day.records.length} 条</b> : null}
                  </div>
                  {day.records.length === 0 ? (
                    <p>当日无记录</p>
                  ) : (
                    <ul className="day-card-records">
                      {day.records.slice(0, 3).map((record) => {
                        const view = weeklyRecordStatusView(record);
                        return (
                          <li key={record.id}>
                            <em>{formatRecordTime(record)}</em>
                            <strong>{record.customer ?? record.customerId ?? "未关联客户"}</strong>
                            <span>{record.title ?? record.rawContent ?? "未填写内容"}</span>
                            <b className={`pill tone-${view.tone}`}>{view.status}</b>
                          </li>
                        );
                      })}
                      {day.records.length > 3 ? <li className="day-card-more">共 {day.records.length} 条记录</li> : null}
                    </ul>
                  )}
                </button>
                {expanded ? (
                  <div className="day-card-detail" data-testid="weekly-expanded-day">
                    {day.records.length === 0 ? (
                      <span className="day-card-empty">{day.weekday}（{day.dateLabel}）当日无记录。</span>
                    ) : (
                      day.records.map((record) => {
                        const view = weeklyRecordStatusView(record);
                        return (
                          <div className="day-card-record-row" key={record.id}>
                            <div>
                              <strong>{record.title ?? record.rawContent ?? "未填写内容"}</strong>
                              <small>
                                {formatRecordTime(record)} · {record.customer ?? record.customerId ?? "未关联客户"} · {view.status}
                              </small>
                            </div>
                            {onOpenQuickRecord ? (
                              <button
                                className="ghost-button"
                                type="button"
                                data-testid="weekly-day-open-record"
                                onClick={() => onOpenQuickRecord(record.id)}
                              >
                                在快速记录中打开
                                <ChevronRight size={14} />
                              </button>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="summary-grid" data-testid="weekly-summary-view">
          <DraftPreview draft={weeklyDraft} emptyText="周报草稿暂无正文。" />
          <div className="stack">
            <MetricCard
              label="真实来源"
              value={String(sourceRefs.length)}
              badge={weeklyStatusLabel}
              tone="blue"
              detail={sourceMetricDetail}
            />
            <section className="manual-box compact">
              <div>
                <strong>{weekRangeLabel} / {weeklyStatusLabel}</strong>
                <p>{draftStatus}</p>
              </div>
              <button className="primary-button" type="button" onClick={generateWeeklyDraft}>
                <Sparkles size={16} />
                重新生成
              </button>
            </section>
            <section className="weekly-editor" data-testid="weekly-draft-editor">
              <div className="generated-draft-head">
                <span className="pill tone-blue">可编辑</span>
                <strong>周报正文确认</strong>
                <small>{sourceRefs.length} 个来源引用 / {weeklyStatusLabel}</small>
              </div>
              <textarea
                value={weeklyDraftText}
                onChange={(event) => setWeeklyDraftText(event.target.value)}
                rows={8}
                aria-label="周报正文"
              />
              <div className="composer-actions weekly-editor-actions">
                <button className="ghost-button" type="button" onClick={() => saveWeeklyDraft("saved")}>
                  <Save size={16} />
                  保存周报
                </button>
                <button className="primary-button" type="button" onClick={() => saveWeeklyDraft("ready")}>
                  <Check size={16} />
                  确认定稿
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="weekly-export-button"
                  disabled={isExporting || !apiClient?.isEnabled || backendStatus !== "connected"}
                  onClick={exportWeeklyDraft}
                >
                  <Download size={16} />
                  {isExporting ? "导出中" : "导出 Word"}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
