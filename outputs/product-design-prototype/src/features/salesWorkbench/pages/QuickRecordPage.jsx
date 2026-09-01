import {
  Check,
  FileText,
  Gauge,
  LoaderCircle,
  MessageSquareText,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { statusTone } from "../../../data/salesWorkbenchData.js";
import { assertBackendReady } from "../../../app/workbenchState.js";
import { useNavigation } from "../../../app/useWorkbenchNavigation.jsx";
import { useQuickRecordSession } from "../../../app/useQuickRecordSession.jsx";
import { useWorkbenchActions } from "../../../app/useWorkbenchHandlers.jsx";
import { useWorkbenchData } from "../../../app/useWorkbenchData.jsx";
import { MatchCard, Panel } from "../../../components/primitives.jsx";
import VoiceCaptureControl from "../../../components/audio/VoiceCaptureControl.jsx";
import {
  createExclusiveAsyncGate,
  getQuickRecordFlow,
  mergeEntityByVersion,
} from "../../../quickRecordModel.js";
import {
  QUICK_RECORD_DIFF_STATUS,
  createQuickRecordDiffCancellationPayload,
  createQuickRecordDiffConfirmationPayload,
  normalizeQuickRecordDiffPreview,
} from "../quickRecordDiffModel.js";
import { VisitTemperatureSuggestionsPanel } from "../VisitTemperatureSuggestionsPanel.jsx";

function syncTargetLabel(target) {
  return {
    customer: "客户画像",
    opportunity: "商机 / 项目",
    weekly: "周报草稿",
  }[target] ?? target;
}

function formatSyncTime(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export const QUICK_RECORD_TRANSCRIPT_LIMIT = 10_000;
export const QUICK_RECORD_CONTENT_LIMIT = 50_000;

/**
 * Add one server transcript to the current quick-record draft without ever
 * truncating either side.  Keeping this as a pure action makes the exact
 * separator and both local limits independently testable from the page.
 */
export function appendQuickRecordTranscript(existing, transcript) {
  const current = typeof existing === "string" ? existing : "";
  if (typeof transcript !== "string" || transcript.length > QUICK_RECORD_TRANSCRIPT_LIMIT) {
    return Object.freeze({
      accepted: false,
      candidate: current,
      reason: "transcript_too_long",
    });
  }
  const candidate = `${current}${current && transcript ? "\n" : ""}${transcript}`;
  if (candidate.length > QUICK_RECORD_CONTENT_LIMIT) {
    return Object.freeze({
      accepted: false,
      candidate: current,
      reason: "content_too_long",
    });
  }
  return Object.freeze({ accepted: true, candidate, reason: null });
}

export function quickRecordHistoryView(item) {
  const date = new Date(item.occurredAt ?? item.createdAt ?? "");
  const validDate = !Number.isNaN(date.getTime());
  const previewStatus = item.confirmationPreviewStatus;
  const status = previewStatus === "completed" || item.status === "confirmed"
    ? "已确认"
    : previewStatus === "cancelled"
      ? "已取消"
      : previewStatus === "open"
        ? "待确认"
        : item.status === "analyzed"
          ? "待生成预览"
          : "已记录";
  return {
    day: validDate ? String(date.getDate()).padStart(2, "0") : "--",
    date: validDate ? `${date.getMonth() + 1}月` : "待记录",
    customer: item.customer ?? item.customerId ?? "未关联客户",
    title: item.title ?? item.rawContent ?? "未填写内容",
    feedback: item.sourceChannel ?? "快速记录",
    status,
    tone: status === "已确认" ? "green" : status === "已取消" ? "gray" : status.startsWith("待") ? "amber" : "blue",
  };
}

export function quickRecordNeedsConfirmation(item) {
  if (["completed", "cancelled"].includes(item.confirmationPreviewStatus)) return false;
  if (item.status === "confirmed") return false;
  return item.confirmationPreviewStatus === "open" || item.status === "analyzed";
}

export function QuickRecord() {
  const {
    recordMode,
    setRecordMode,
    recordText,
    setRecordText,
    analysisVisible,
    setAnalysisVisible,
    syncStatus,
    setSyncStatus,
  } = useQuickRecordSession();
  const {
    apiClient,
    backendStatus,
    workbenchCustomers: customersList,
    workbenchOpportunities: opportunitiesList,
    workbenchQuickRecords: quickRecords,
    setWorkbenchCustomers,
    setWorkbenchQuickRecords,
  } = useWorkbenchData();
  const {
    navigateTo: setActive,
    setSelectedCustomerId,
    setSelectedOpportunityId,
    openOpportunityDetail,
    routeEntityId: routeHistoryId,
    openQuickHistoryRoute: onHistoryRoute,
  } = useNavigation();
  const { handleConfirmationRefresh: onConfirmationRefresh } = useWorkbenchActions();
  const onQuickRecordSaved = (item) => {
    setWorkbenchQuickRecords((current) => mergeEntityByVersion(current, item));
  };
  const [analysis, setAnalysis] = useState(null);
  const [quickRecord, setQuickRecord] = useState(null);
  const [analysisDirty, setAnalysisDirty] = useState(false);
  const [analysisSavePending, setAnalysisSavePending] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [confirmedTargets, setConfirmedTargets] = useState([]);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [syncLog, setSyncLog] = useState([]);
  const [confirmationPreview, setConfirmationPreview] = useState(null);
  const [historyReadOnly, setHistoryReadOnly] = useState(false);
  // This epoch belongs to the page, not to the shared recorder controller.
  // Bumping it synchronously fences a late transcript before React commits the
  // mode/history/new-record render; the keyed control then tears down the old
  // controller and releases its Blob, stream, and request.
  const [voiceSessionEpoch, setVoiceSessionEpoch] = useState(0);
  const voiceApplyEpochRef = useRef(0);
  const recordTextRef = useRef(recordText);
  recordTextRef.current = recordText;
  // 只有真正发生过语音转写时才标记"语音转写"，避免语音模式下手动输入被误标。
  const voiceCapturedRef = useRef(false);
  // 中文输入法组字守卫：组字过程中的中间态不清空已生成的分析面板。
  const composingRef = useRef(false);
  const confirmationGateRef = useRef(null);
  if (!confirmationGateRef.current) {
    confirmationGateRef.current = createExclusiveAsyncGate();
  }
  // 分析请求互斥门：慢网下连点只发一个分析请求。
  const analysisGateRef = useRef(null);
  if (!analysisGateRef.current) {
    analysisGateRef.current = createExclusiveAsyncGate();
  }
  const quickRecordId = quickRecord?.id ?? null;
  const confirmationModel = confirmationPreview
    ? normalizeQuickRecordDiffPreview(confirmationPreview, {
      hasUnsavedDraftChanges: analysisDirty,
      historyReadOnly,
    })
    : null;
  const pageReadOnly = historyReadOnly || confirmationModel?.readOnly === true;
  const hasInput = recordText.trim().length > 0;
  const flowState = getQuickRecordFlow({
    hasInput,
    hasAnalysis: Boolean(analysisVisible && analysis),
    confirmedTargets,
  });

  function invalidateVoiceCapture() {
    const nextEpoch = voiceApplyEpochRef.current + 1;
    voiceApplyEpochRef.current = nextEpoch;
    setVoiceSessionEpoch(nextEpoch);
  }

  function resetAnalysis(status) {
    setAnalysis(null);
    setQuickRecord(null);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setConfirmationPreview(null);
    setHistoryReadOnly(false);
    setAnalysisVisible(false);
    setSyncStatus(status);
  }

  function startBlankRecord() {
    invalidateVoiceCapture();
    setRecordMode("text");
    voiceCapturedRef.current = false;
    recordTextRef.current = "";
    setRecordText("");
    setAnalysis(null);
    setQuickRecord(null);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setConfirmationPreview(null);
    setHistoryReadOnly(false);
    setAnalysisVisible(false);
    setSyncStatus("可录入新的拜访、电话、微信或会议内容");
  }

  function loadHistoricalRecord(item) {
    invalidateVoiceCapture();
    const nextText = item.rawContent ?? `${item.customer}：${item.title}。${item.feedback}`;
    const nextAnalysis = item.analysis ?? null;
    const nextSyncLog = item.syncLog ?? item.confirmations ?? [];
    const nextConfirmedTargets = item.confirmedTargets ?? nextSyncLog.map((entry) => entry.target);
    setRecordMode("text");
    voiceCapturedRef.current = false;
    recordTextRef.current = nextText;
    setRecordText(nextText);
    setAnalysis(nextAnalysis);
    setQuickRecord(item);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(item.id);
    setConfirmedTargets(nextConfirmedTargets);
    setSyncLog(nextSyncLog);
    setConfirmationPreview(null);
    setHistoryReadOnly(true);
    setAnalysisVisible(Boolean(nextAnalysis));
    setSyncStatus(nextAnalysis ? "已载入历史分析与确认记录（历史只读）" : "已载入历史记录，暂无已保存分析");
  }

  function updateAnalysisSummary(section, text) {
    if (pageReadOnly) {
      setSyncStatus("历史或已结束的确认记录只读，请新建记录后再修改");
      return;
    }
    setAnalysisDirty(true);
    setConfirmationPreview(null);
    setAnalysis((current) => {
      if (!current?.summary?.[section]) return current;
      return {
        ...current,
        summary: {
          ...current.summary,
          [section]: {
            ...current.summary[section],
            text,
          },
        },
      };
    });
    setSyncStatus("分析内容已修改，请先保存再同步");
  }

  function handleServerTranscript(transcript) {
    // A mode/history/new-record transition invalidates the callback before
    // React's state update is committed.  The shared hook also has its own
    // generation fence; this second fence protects the page's business draft.
    if (voiceApplyEpochRef.current !== voiceSessionEpoch || pageReadOnly) return;
    const result = appendQuickRecordTranscript(recordTextRef.current, transcript);
    if (!result.accepted) {
      setSyncStatus(
        result.reason === "transcript_too_long"
          ? "录音内容过长（单次最多 10000 字），请缩短重录"
          : "录音内容过长（合并后最多 50000 字），请缩短重录",
      );
      return;
    }
    if (result.candidate === recordTextRef.current) return;
    voiceCapturedRef.current = true;
    recordTextRef.current = result.candidate;
    setRecordText(result.candidate);
    resetAnalysis("语音转写已写入，请确认调用 AI 分析");
  }

  useEffect(() => {
    if (!routeHistoryId || routeHistoryId === selectedHistoryId) return;
    const routedItem = quickRecords.find((record) => record.id === routeHistoryId);
    if (routedItem) loadHistoricalRecord(routedItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeHistoryId, quickRecords, selectedHistoryId]);

  useEffect(() => {
    const previewId = quickRecord?.confirmationPreviewId;
    if (!historyReadOnly || !previewId) return undefined;
    let active = true;
    setSyncStatus("正在读取历史确认预览");
    apiClient.getQuickRecordConfirmationPreview(previewId)
      .then((preview) => {
        if (active) applyConfirmationPreview(preview, "已载入历史确认预览（只读）");
      })
      .catch((error) => {
        if (active) setSyncStatus(error?.message || "历史确认预览读取失败，可重试");
      });
    return () => { active = false; };
  // applyConfirmationPreview is intentionally recreated with page state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, historyReadOnly, quickRecord?.confirmationPreviewId]);

  async function confirmAnalysisUnlocked() {
    if (pageReadOnly) {
      setSyncStatus("历史或已结束的确认记录只读，请先新建记录");
      return;
    }
    if (!recordText.trim()) {
      resetAnalysis("请先录入文本或语音转写内容");
      return;
    }

    try {
      assertBackendReady(
        { isEnabled: apiClient?.isEnabled, status: backendStatus },
        "分析快速记录",
      );
    } catch (error) {
      setSyncStatus(error.message);
      return;
    }

    setSyncStatus("正在分析记录内容");
    try {
      const result = await apiClient.analyzeQuickRecord(recordText, {
        sourceChannel: voiceCapturedRef.current ? "语音转写" : "快速记录",
      });
      const historyItem = {
        ...result.quickRecord,
        analysis: result.analysis,
        confirmations: [],
        confirmedTargets: [],
        syncLog: [],
      };
      setQuickRecord(historyItem);
      onQuickRecordSaved?.(historyItem);
      setAnalysis(result.analysis);
      setAnalysisDirty(false);
      setAnalysisSavePending(false);
      setSelectedHistoryId(result.quickRecord.id);
      setConfirmedTargets([]);
      setSyncLog([]);
      setConfirmationPreview(null);
      setHistoryReadOnly(false);
      setAnalysisVisible(true);
      setSyncStatus("分析完成，请先生成确认预览");
    } catch (error) {
      setSyncStatus(error?.message || "分析失败，请稍后重试");
    }
  }

  async function confirmAnalysis() {
    const outcome = await analysisGateRef.current.run(async () => {
      setAnalysisPending(true);
      try {
        await confirmAnalysisUnlocked();
        return { status: "settled" };
      } finally {
        setAnalysisPending(false);
      }
    });
    if (outcome.status === "busy") {
      setSyncStatus("正在分析，请稍候");
    }
  }

  async function saveAnalysisChanges() {
    if (pageReadOnly) {
      setSyncStatus("历史或已结束的确认记录只读，不能保存分析修改");
      return;
    }
    if (!quickRecordId || !analysis) {
      setSyncStatus("请先完成分析，再保存修改");
      return;
    }
    try {
      assertBackendReady(
        { isEnabled: apiClient?.isEnabled, status: backendStatus },
        "保存分析修改",
      );
    } catch (error) {
      setSyncStatus(error.message);
      return;
    }

    setAnalysisSavePending(true);
    setSyncStatus("正在保存分析修改");
    try {
      const saved = await apiClient.saveQuickRecordAnalysis(
        quickRecordId,
        analysis.summary,
        quickRecord.version,
      );
      const confirmations = quickRecord.confirmations ?? syncLog;
      const nextConfirmedTargets = quickRecord.confirmedTargets ?? confirmedTargets;
      const historyItem = {
        ...quickRecord,
        ...saved.quickRecord,
        analysis: saved.analysis,
        confirmations,
        confirmedTargets: nextConfirmedTargets,
        syncLog: confirmations,
      };
        setQuickRecord(historyItem);
      setAnalysis(saved.analysis);
      setAnalysisDirty(false);
      setSyncLog(confirmations);
      setConfirmedTargets(nextConfirmedTargets);
      setConfirmationPreview(null);
      setHistoryReadOnly(false);
      onQuickRecordSaved?.(historyItem);
      setSyncStatus("分析修改已保存，请重新生成确认预览");
    } catch (error) {
      if (error?.code === "VERSION_CONFLICT") {
        try {
          const refreshed = await apiClient.refreshQuickRecordConfirmationState(quickRecordId);
          const historyItem = refreshed.quickRecord;
          setQuickRecord(historyItem);
          setAnalysis(historyItem.analysis ?? null);
          setAnalysisDirty(false);
          setConfirmedTargets(historyItem.confirmedTargets ?? []);
          setSyncLog(historyItem.syncLog ?? historyItem.confirmations ?? []);
          setAnalysisVisible(Boolean(historyItem.analysis));
          onQuickRecordSaved?.(historyItem);
          onConfirmationRefresh?.(refreshed);
          setSyncStatus("记录已被其他操作更新，已载入最新分析");
          return;
        } catch (refreshError) {
          setSyncStatus(refreshError?.message || "分析版本已变化，请刷新后重试");
          return;
        }
      }
      setSyncStatus(error?.message || "分析修改保存失败，请稍后重试");
    } finally {
      setAnalysisSavePending(false);
    }
  }

  function applyConfirmationPreview(preview, message) {
    setConfirmationPreview(preview);
    if (quickRecord?.id === preview?.quickRecordId) {
      const historyItem = {
        ...quickRecord,
        confirmationPreviewId: preview.id,
        confirmationPreviewStatus: preview.status,
      };
      setQuickRecord(historyItem);
      onQuickRecordSaved?.(historyItem);
    }
    const confirmedItems = Array.isArray(preview?.items)
      ? preview.items.filter((item) => item.status === "confirmed")
      : [];
    setConfirmedTargets(confirmedItems.map((item) => item.target));
    setSyncLog(confirmedItems.map((item) => ({
      target: item.target,
      note: item.receipt?.summary ?? "已由已登录用户确认写入",
      createdAt: item.confirmedAt,
      confirmedBy: item.confirmedBy,
    })));
    setSyncStatus(message);
  }

  async function refreshConfirmationPreview(previewId, message = "已刷新确认预览，请重试") {
    const preview = await apiClient.getQuickRecordConfirmationPreview(previewId);
    applyConfirmationPreview(preview, message);
    return preview;
  }

  async function createConfirmationPreview() {
    if (!quickRecordId || !analysis || analysisDirty) {
      setSyncStatus(analysisDirty ? "请先保存分析修改，再生成确认预览" : "请先完成 AI 分析");
      return;
    }
    setConfirmationPending(true);
    setSyncStatus("正在生成确认预览");
    try {
      const preview = await apiClient.createQuickRecordConfirmationPreview(quickRecordId);
      setHistoryReadOnly(false);
      applyConfirmationPreview(preview, preview.replayed ? "已载入现有确认预览" : "确认预览已生成，请逐项核对后写入");
    } catch (error) {
      setSyncStatus(error?.message || "生成确认预览失败，请重试");
    } finally {
      setConfirmationPending(false);
    }
  }

  async function confirmPreviewItem(itemId) {
    const payload = createQuickRecordDiffConfirmationPayload(confirmationModel, { itemId });
    if (!payload) {
      setSyncStatus("该项当前不可确认，请刷新预览后重试");
      return;
    }
    await runConfirmationAction(async () => (
      apiClient.confirmQuickRecordConfirmationItem(payload.previewId, payload)
    ), "正在确认该项写入");
  }

  async function confirmAllPreviewItems() {
    const payload = createQuickRecordDiffConfirmationPayload(confirmationModel, { confirmAll: true });
    if (!payload) {
      setSyncStatus("当前没有可全部确认的项目");
      return;
    }
    await runConfirmationAction(async () => (
      apiClient.confirmAllQuickRecordConfirmationItems(payload.previewId, payload)
    ), "正在确认全部可写入项目");
  }

  async function cancelConfirmationPreview() {
    const payload = createQuickRecordDiffCancellationPayload(confirmationModel);
    if (!payload) {
      setSyncStatus("该确认预览已经是只读状态");
      return;
    }
    setConfirmationPending(true);
    setSyncStatus("正在取消确认预览");
    try {
      const preview = await apiClient.cancelQuickRecordConfirmationPreview(payload.previewId, payload);
      applyConfirmationPreview(preview, "确认预览已取消，历史保持只读");
    } catch (error) {
      if (error?.status === 409) {
        try {
          await refreshConfirmationPreview(payload.previewId);
        } catch (refreshError) {
          setSyncStatus(refreshError?.message || "确认预览冲突，请刷新后重试");
        }
      } else {
        setSyncStatus(error?.message || "取消确认预览失败，请重试");
      }
    } finally {
      setConfirmationPending(false);
    }
  }

  async function runConfirmationAction(action, pendingMessage) {
    const previewId = confirmationModel?.previewId;
    const outcome = await confirmationGateRef.current.run(async () => {
      setConfirmationPending(true);
      setSyncStatus(pendingMessage);
      try {
        const result = await action();
        applyConfirmationPreview(result.preview, result.status === "conflict"
          ? "预览已变化，已载入最新状态，请重试"
          : "确认结果已保存");
      } catch (error) {
        if (error?.status === 409 && previewId) {
          try {
            await refreshConfirmationPreview(previewId);
          } catch (refreshError) {
            setSyncStatus(refreshError?.message || "确认冲突，请刷新后重试");
          }
        } else {
          setSyncStatus(error?.message || "确认失败，请重试");
        }
      } finally {
        setConfirmationPending(false);
      }
      return { status: "settled" };
    });
    if (outcome.status === "busy") setSyncStatus("正在处理确认，请稍候");
  }

  function switchToTextRecord() {
    if (pageReadOnly) {
      setSyncStatus("历史或已结束的确认记录只读，请先新建记录");
      return;
    }
    invalidateVoiceCapture();
    setRecordMode("text");
    resetAnalysis("请继续在记录框内录入内容");
  }

  function startNewRecordFromUi() {
    startBlankRecord();
    if (onHistoryRoute && routeHistoryId) onHistoryRoute(null);
  }

  const historyItems = quickRecords.map((item) => ({ item, view: quickRecordHistoryView(item) }));
  const pendingHistoryCount = quickRecords.filter(quickRecordNeedsConfirmation).length;

  return (
    <div className="record-layout">
      <section className="record-composer">
        <div className="composer-head">
          <div>
            <span className="eyebrow">记录确认</span>
            <h2>先记录，再确认识别</h2>
            <p>支持文本录入、语音转写和历史记录复核。</p>
          </div>
          <div className="segmented">
            <button
              className={recordMode === "text" ? "active" : ""}
              data-testid="quick-record-mode-text"
              type="button"
              disabled={pageReadOnly}
              onClick={switchToTextRecord}
            >
              <MessageSquareText size={14} />
              文本
            </button>
            <button
              className={recordMode === "voice" ? "active" : ""}
              data-testid="quick-record-mode-voice"
              type="button"
              disabled={pageReadOnly}
              onClick={() => setRecordMode("voice")}
            >
              <Mic size={14} />
              语音
            </button>
          </div>
        </div>

        <div className="record-flow" aria-label="快速记录流程">
          {["录入", "识别", "确认", "同步"].map((step, index) => (
            <span className={flowState[index]} key={step}>{step}</span>
          ))}
        </div>

        {recordMode === "voice" ? (
          <div className="voice-box">
            <Mic size={26} />
            <div>
              <strong>语音记录</strong>
            </div>
            <div className="voice-control-status-shell" data-testid="voice-status">
              <VoiceCaptureControl
                key={`quick-record-voice-${voiceSessionEpoch}`}
                apiClient={apiClient}
                purpose="quick_record"
                onTranscript={handleServerTranscript}
                active={recordMode === "voice"}
                disabled={analysisPending}
                className="quick-record-voice-control"
              />
              <button className="ghost-button" type="button" onClick={switchToTextRecord}>
                <MessageSquareText size={15} />
                改用文本
              </button>
            </div>
          </div>
        ) : null}

        <textarea
          aria-label="快速记录内容"
          readOnly={pageReadOnly}
          value={recordText}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            recordTextRef.current = event.target.value;
            setRecordText(event.target.value);
            resetAnalysis("内容已变化，请重新确认分析");
          }}
          onChange={(event) => {
            if (!event.target.value.trim()) voiceCapturedRef.current = false;
            recordTextRef.current = event.target.value;
            setRecordText(event.target.value);
            if (composingRef.current) return;
            resetAnalysis("内容已变化，请重新确认分析");
          }}
          rows={4}
          placeholder="粘贴拜访记录、电话纪要、微信沟通或会议摘要"
        />

        <div className="composer-footer">
          <span>待识别内容</span>
          <span>确认后同步</span>
        </div>

        <div className="composer-actions">
          <button
            className="primary-button"
            type="button"
            data-testid="confirm-ai-analysis"
            disabled={analysisPending || pageReadOnly}
            onClick={confirmAnalysis}
          >
            {analysisPending ? <LoaderCircle className="state-spinner" size={16} /> : <Send size={16} />}
            {analysisPending ? "分析中" : "确认调用 AI 分析"}
          </button>
          <button
            className="ghost-button"
            type="button"
            data-testid="new-quick-record"
            disabled={analysisPending}
            onClick={startNewRecordFromUi}
          >
            <Plus size={16} />
            新建记录
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={analysisPending || pageReadOnly}
            onClick={() => resetAnalysis("已准备重新分析")}
          >
            <RefreshCw size={16} />
            重新分析
          </button>
          <span className="status-text">{syncStatus}</span>
        </div>
      </section>

      {analysisVisible && analysis ? (
        <section className="analysis-panel" data-testid="quick-analysis-result">
          <div className="analysis-hero">
            <span className="ai-ring">
              <Sparkles size={18} />
            </span>
            <div>
              <strong>结构化识别结果</strong>
              <p>根据记录内容生成客户、商机和周报建议，可按目标同步到业务档案。</p>
            </div>
            <b>智能分析</b>
          </div>
          <div className="match-grid compact">
            <MatchCard
              title="匹配客户"
              value={analysis.customer.value}
              meta={analysis.customer.meta}
              tone={analysis.customer.tone}
            />
            <MatchCard
              title="建议商机"
              value={analysis.opportunity.value}
              meta={analysis.opportunity.meta}
              tone={analysis.opportunity.tone}
            />
            <MatchCard
              title="周报日期"
              value={analysis.weekly.value}
              meta={analysis.weekly.meta}
              tone={analysis.weekly.tone}
            />
          </div>
          <div className="analysis-summary">
            {Object.entries(analysis.summary).map(([key, item]) => (
              <SummaryLine
                key={key}
                fieldKey={key}
                title={item.title}
                text={item.text}
                onTextChange={pageReadOnly ? undefined : (text) => updateAnalysisSummary(key, text)}
              />
            ))}
          </div>
          {Array.isArray(analysis.knowledgeRefs) && analysis.knowledgeRefs.length > 0 ? (
            <div className="analysis-knowledge-refs" data-testid="analysis-knowledge-refs">
              <span className="knowledge-refs-title">参考知识（来自知识库）</span>
              <div className="knowledge-refs-list">
                {analysis.knowledgeRefs.map((ref) => (
                  <button
                    key={ref.id}
                    className="ghost-button"
                    type="button"
                    data-testid="analysis-knowledge-ref"
                    onClick={() => setActive("knowledge", { mode: "detail", entityId: ref.id })}
                  >
                    <FileText size={14} />
                    {ref.title || ref.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="composer-actions analysis-save-actions">
            <button
              className={analysisDirty ? "primary-button" : "ghost-button"}
              type="button"
              data-testid="save-analysis-modifications"
              disabled={pageReadOnly || !analysisDirty || analysisSavePending}
              onClick={saveAnalysisChanges}
            >
              <Save size={16} />
              {analysisSavePending ? "保存中" : "保存分析修改"}
            </button>
            <span className="status-text">
              {analysisDirty ? "修改尚未保存" : "分析内容已保存"}
            </span>
          </div>
          <section className="manual-sync confirmation-preview" data-testid="quick-record-confirmation-preview">
            {!confirmationModel ? (
              <>
                <p>先生成一份可追溯的变更预览；预览不会写入客户、商机或周报。</p>
                <button
                  className="primary-button"
                  type="button"
                  data-testid="create-quick-record-confirmation-preview"
                  disabled={confirmationPending || analysisSavePending || analysisDirty || historyReadOnly}
                  onClick={createConfirmationPreview}
                >
                  <Sparkles size={16} />
                  生成确认预览
                </button>
              </>
            ) : (
              <>
                <div className="confirmation-preview-head">
                  <div>
                    <strong>确认预览</strong>
                    <small>{confirmationModel.readOnly ? "此预览已进入只读终态" : "逐项核对变更后，才会写入业务数据"}</small>
                  </div>
                  <b className={`pill ${confirmationModel.status === QUICK_RECORD_DIFF_STATUS.CONFIRMED ? "green" : confirmationModel.status === QUICK_RECORD_DIFF_STATUS.CANCELLED ? "gray" : "amber"}`}>
                    {confirmationModel.status === QUICK_RECORD_DIFF_STATUS.CONFIRMED ? "已完成" : confirmationModel.status === QUICK_RECORD_DIFF_STATUS.CANCELLED ? "已取消" : "待确认"}
                  </b>
                </div>
                {confirmationModel.blocker ? <p className="status-text">{confirmationModel.blocker.message}</p> : null}
                <div className="confirmation-preview-items">
                  {confirmationModel.items.map((item) => (
                    <article className="confirmation-preview-item" key={item.id}>
                      <div>
                        <strong>{item.label}</strong>
                        <small>{syncTargetLabel(item.target)} · {item.field}</small>
                      </div>
                      <div className="confirmation-preview-values">
                        <span>原值：{JSON.stringify(item.before)}</span>
                        <span>建议：{JSON.stringify(item.after)}</span>
                      </div>
                      <div className="confirmation-preview-item-action">
                        {item.status === QUICK_RECORD_DIFF_STATUS.CONFIRMED ? <span className="confirmed"><Check size={15} /> 已确认</span> : null}
                        {item.status === QUICK_RECORD_DIFF_STATUS.CANCELLED ? <span>已取消</span> : null}
                        {item.confirmable ? (
                          <button
                            className="ghost-button"
                            type="button"
                            disabled={confirmationPending}
                            onClick={() => confirmPreviewItem(item.id)}
                          >
                            确认此项
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                <div className="confirmation-preview-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={confirmationPending || !confirmationModel.canConfirmAll}
                    onClick={confirmAllPreviewItems}
                  >
                    <Check size={16} /> 全部确认可写入项
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={confirmationPending || confirmationModel.readOnly}
                    onClick={cancelConfirmationPreview}
                  >
                    取消此预览
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={confirmationPending || !confirmationModel.previewId}
                    onClick={() => refreshConfirmationPreview(confirmationModel.previewId, "确认预览已刷新")}
                  >
                    <RefreshCw size={16} /> 刷新预览
                  </button>
                </div>
              </>
            )}
            <button
              className="ghost-button"
              type="button"
              disabled={confirmationPending || analysisSavePending || pageReadOnly}
              onClick={() => resetAnalysis("补充内容后可重新识别")}
            >
              补充内容后再识别
            </button>
          </section>
          <div className="sync-log" data-testid="sync-log">
            <div className="sync-log-head">
              <span>人工确认同步日志</span>
              <b>{syncLog.length} 条</b>
            </div>
            {syncLog.length > 0 ? (
              <div className="sync-log-list">
                {syncLog.map((item) => (
                  <div className="sync-log-item" key={`${item.target}-${item.createdAt}`}>
                    <span className="sync-dot" />
                    <div>
                      <strong>{syncTargetLabel(item.target)}</strong>
                      <small>{item.note || "人工确认同步"}</small>
                    </div>
                    <em>{formatSyncTime(item.createdAt)} · {item.confirmedBy || "未署名"}</em>
                  </div>
                ))}
              </div>
            ) : (
              <p>尚未产生同步记录。完成目标同步后，这里会保留可追溯的写入日志。</p>
            )}
          </div>
          {quickRecord?.id ? (
            <VisitTemperatureSuggestionsPanel
              apiClient={apiClient}
              backendStatus={backendStatus}
              quickRecord={quickRecord}
              customers={customersList}
              onCustomerUpdated={(updated) => setWorkbenchCustomers((current) => current.map((customer) => (
                customer.id === updated.id
                  ? { ...customer, relation: updated.relation, version: updated.version }
                  : customer
              )))}
            />
          ) : null}
          <div className="analysis-routes">
            <button type="button" onClick={() => setActive("customer")}>查看客户画像</button>
            <button type="button" onClick={() => openOpportunityDetail ? openOpportunityDetail() : setActive("opportunity")}>查看商机档案</button>
            <button type="button" onClick={() => setActive("weekly")}>查看周报草稿</button>
          </div>
        </section>
      ) : (
        <section className="analysis-empty">
          <span className="ai-ring idle">
            <Gauge size={22} />
          </span>
          <strong>等待记录分析</strong>
          <p>录入内容后可生成客户、商机和周报建议。</p>
          <div className="empty-route">
            <span>客户画像</span>
            <span>商机档案</span>
            <span>周报草稿</span>
          </div>
        </section>
      )}

      <Panel title="已有快速记录" meta="今日记录" className="record-list-panel">
        <div className="record-list-summary">
          <span>{quickRecords.length} 条记录</span>
          <b>{pendingHistoryCount} 条待确认</b>
        </div>
        <div className="list-stack">
          {historyItems.map(({ item, view }) => (
            <button
              className={`list-button record-note tone-rail-${view.tone} ${selectedHistoryId === item.id ? "selected" : ""}`}
              key={item.id}
              type="button"
              onClick={() => {
                if (onHistoryRoute) onHistoryRoute(item.id);
                else loadHistoricalRecord(item);
              }}
            >
              <span className={`date-chip ${statusTone[view.tone]}`}>
                <b>{view.day}</b>
                <small>{view.date}</small>
              </span>
              <span>
                <strong>{view.customer}</strong>
                <small>{view.title}</small>
                <em>{view.feedback}</em>
              </span>
              <b className={`pill ${statusTone[view.tone]}`}>{view.status}</b>
            </button>
          ))}
          {quickRecords.length === 0 ? <p className="empty-list">暂无历史记录，可直接创建新记录。</p> : null}
        </div>
      </Panel>
    </div>
  );
}

export function SummaryLine({ fieldKey, title, text, onTextChange }) {
  return (
    <section className="summary-line">
      <span className="mini-icon tone-blue">
        <Check size={15} />
      </span>
      <div>
        <strong>{title}</strong>
        {onTextChange ? (
          <textarea
            aria-label={`${title}分析内容`}
            data-testid={fieldKey ? `analysis-summary-${fieldKey}` : undefined}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            rows={2}
          />
        ) : (
          <p>{text}</p>
        )}
      </div>
    </section>
  );
}
