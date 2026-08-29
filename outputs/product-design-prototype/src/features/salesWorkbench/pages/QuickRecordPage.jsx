import {
  Check,
  CircleStop,
  FileText,
  Gauge,
  Link2,
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
import { mergeEntityByVersion } from "../../../quickRecordModel.js";
import { createConfirmationAttemptTracker } from "../../../api/salesWorkbenchApi.js";
import { MatchCard, Panel } from "../../../components/primitives.jsx";
import {
  confirmQuickRecordTarget,
  createExclusiveAsyncGate,
  getQuickRecordFlow,
  getSyncTargets,
  resolveConfirmedSelectionId,
} from "../../../quickRecordModel.js";

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

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function canUseSpeechRecognition() {
  if (!getSpeechRecognitionConstructor()) return false;
  if (typeof window === "undefined") return false;
  return window.isSecureContext !== false;
}

const voiceStatusText = {
  idle: "待录入",
  listening: "转写中",
  unsupported: "不可用",
  error: "需处理",
};

function quickRecordHistoryView(item) {
  const date = new Date(item.occurredAt ?? item.createdAt ?? "");
  const validDate = !Number.isNaN(date.getTime());
  const status = item.status === "confirmed" ? "已确认" : item.status === "analyzed" ? "待同步" : "已记录";
  return {
    day: validDate ? String(date.getDate()).padStart(2, "0") : "--",
    date: validDate ? `${date.getMonth() + 1}月` : "待记录",
    customer: item.customer ?? item.customerId ?? "未关联客户",
    title: item.title ?? item.rawContent ?? "未填写内容",
    feedback: item.sourceChannel ?? "快速记录",
    status,
    tone: status === "已确认" ? "green" : status === "待同步" ? "amber" : "blue",
  };
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
  const { handleBusinessSync: onBusinessSync, handleConfirmationRefresh: onConfirmationRefresh } = useWorkbenchActions();
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
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceMessage, setVoiceMessage] = useState("点击开始转写即可。");
  const [voiceInterim, setVoiceInterim] = useState("");
  const recognitionRef = useRef(null);
  const voiceBaseTextRef = useRef("");
  // 只有真正发生过语音转写时才标记"语音转写"，避免语音模式下手动输入被误标。
  const voiceCapturedRef = useRef(false);
  // 中文输入法组字守卫：组字过程中的中间态不清空已生成的分析面板。
  const composingRef = useRef(false);
  const confirmationAttemptRef = useRef(null);
  if (!confirmationAttemptRef.current) {
    confirmationAttemptRef.current = createConfirmationAttemptTracker();
  }
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
  const hasInput = recordText.trim().length > 0;
  const speechRecognitionAvailable = canUseSpeechRecognition();
  const voiceUnavailable = !speechRecognitionAvailable;
  const voiceNeedsSecureOrigin = typeof window !== "undefined" && window.isSecureContext === false;
  const flowState = getQuickRecordFlow({
    hasInput,
    hasAnalysis: Boolean(analysisVisible && analysis),
    confirmedTargets,
  });
  const visibleVoiceStatus = voiceUnavailable && voiceStatus === "idle" ? "unsupported" : voiceStatus;
  const visibleVoiceMessage = voiceUnavailable && voiceStatus === "idle"
    ? (voiceNeedsSecureOrigin ? "当前不是 HTTPS，无法使用语音转写，请改用文本录入。" : "当前浏览器不支持语音转写，请改用文本录入。")
    : voiceMessage;

  function resetAnalysis(status) {
    confirmationAttemptRef.current.reset();
    setAnalysis(null);
    setQuickRecord(null);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setAnalysisVisible(false);
    setSyncStatus(status);
  }

  function startBlankRecord() {
    if (recognitionRef.current) stopVoiceRecognition();
    confirmationAttemptRef.current.reset();
    setRecordMode("text");
    voiceCapturedRef.current = false;
    setRecordText("");
    setAnalysis(null);
    setQuickRecord(null);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setAnalysisVisible(false);
    setSyncStatus("可录入新的拜访、电话、微信或会议内容");
  }

  function loadHistoricalRecord(item) {
    if (recognitionRef.current) stopVoiceRecognition();
    confirmationAttemptRef.current.reset();
    const nextText = item.rawContent ?? `${item.customer}：${item.title}。${item.feedback}`;
    const nextAnalysis = item.analysis ?? null;
    const nextSyncLog = item.syncLog ?? item.confirmations ?? [];
    const nextConfirmedTargets = item.confirmedTargets ?? nextSyncLog.map((entry) => entry.target);
    setRecordMode("text");
    voiceCapturedRef.current = false;
    setRecordText(nextText);
    setAnalysis(nextAnalysis);
    setQuickRecord(item);
    setAnalysisDirty(false);
    setAnalysisSavePending(false);
    setSelectedHistoryId(item.id);
    setConfirmedTargets(nextConfirmedTargets);
    setSyncLog(nextSyncLog);
    setAnalysisVisible(Boolean(nextAnalysis));
    setSyncStatus(nextAnalysis ? "已载入历史分析，可直接修改或确认同步" : "已载入历史记录，暂无已保存分析");
  }

  function updateAnalysisSummary(section, text) {
    confirmationAttemptRef.current.reset();
    setAnalysisDirty(true);
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

  function appendVoiceTranscript(transcript, status) {
    const base = voiceBaseTextRef.current.trim();
    const cleanTranscript = transcript.trim();
    const nextText = [base, cleanTranscript].filter(Boolean).join(base ? "\n" : "");
    if (cleanTranscript) voiceCapturedRef.current = true;
    setRecordText(nextText);
    resetAnalysis(status);
  }

  function stopVoiceRecognition() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceStatus("idle");
      setVoiceInterim("");
      setVoiceMessage("点击开始转写即可。");
      return;
    }

    setVoiceMessage("正在停止语音转写");
    try {
      recognition.stop();
    } catch {
      recognitionRef.current = null;
      setVoiceStatus("idle");
      setVoiceInterim("");
      setVoiceMessage("语音转写已停止。");
    }
  }

  function startVoiceRecognition() {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    setRecordMode("voice");

    if (!SpeechRecognition) {
      recognitionRef.current = null;
      setVoiceStatus("unsupported");
      setVoiceInterim("");
      setVoiceMessage("当前浏览器不支持语音转写，请改用文本录入。");
      setSyncStatus("语音转写不可用，请改用文本");
      return;
    }

    if (recognitionRef.current) {
      setVoiceMessage("正在转写，继续说。");
      return;
    }

    const recognition = new SpeechRecognition();
    let finalTranscript = "";
    voiceBaseTextRef.current = recordText.trim();
    recognitionRef.current = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setVoiceStatus("listening");
      setVoiceInterim("");
      setVoiceMessage("正在转写，继续说。");
      setSyncStatus("语音转写中，完成后请人工确认分析");
    };

    recognition.onresult = (event) => {
      let interimTranscript = "";
      let committedTranscript = "";
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) committedTranscript += `${text} `;
        else interimTranscript += `${text} `;
      }

      if (committedTranscript.trim()) {
        finalTranscript = `${finalTranscript} ${committedTranscript}`.trim();
        appendVoiceTranscript(finalTranscript, "语音转写已写入，请确认调用 AI 分析");
        setVoiceMessage("已写入，继续说。");
      } else if (interimTranscript.trim()) {
        setVoiceMessage("正在识别，继续说。");
      }
      setVoiceInterim(interimTranscript.trim());
    };

    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setVoiceStatus("error");
      setVoiceInterim("");
      if (event.error === "not-allowed") {
        setVoiceMessage("请开启麦克风权限。");
        setSyncStatus("麦克风权限未开启");
        return;
      }
      if (event.error === "service-not-allowed") {
        setVoiceStatus("unsupported");
        setVoiceMessage("实时转写不可用，请改用文本。");
        setSyncStatus("实时转写不可用");
        return;
      }
      if (event.error === "no-speech") {
        setVoiceMessage("未识别到语音。");
        setSyncStatus("没有识别到语音");
        return;
      }
      setVoiceMessage("实时转写不可用，请改用文本。");
      setSyncStatus("语音转写暂时不可用");
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setVoiceStatus("idle");
      setVoiceInterim("");
      setVoiceMessage(finalTranscript ? "转写已停止。" : "未识别到有效内容。");
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceStatus("error");
      setVoiceInterim("");
      setVoiceMessage("启动失败，请检查权限。");
      setSyncStatus("语音转写启动失败");
    }
  }

  useEffect(() => () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
    }
    recognitionRef.current = null;
  }, []);

  useEffect(() => {
    if (!routeHistoryId || routeHistoryId === selectedHistoryId) return;
    const routedItem = quickRecords.find((record) => record.id === routeHistoryId);
    if (routedItem) loadHistoricalRecord(routedItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeHistoryId, quickRecords, selectedHistoryId]);

  async function confirmAnalysisUnlocked() {
    if (!recordText.trim()) {
      resetAnalysis("请先录入文本或语音转写内容");
      return;
    }

    confirmationAttemptRef.current.reset();
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
      setAnalysisVisible(true);
      setSyncStatus("分析完成，等待人工同步");
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
      confirmationAttemptRef.current.reset();
      setQuickRecord(historyItem);
      setAnalysis(saved.analysis);
      setAnalysisDirty(false);
      setSyncLog(confirmations);
      setConfirmedTargets(nextConfirmedTargets);
      onQuickRecordSaved?.(historyItem);
      setSyncStatus("分析修改已保存，可继续确认同步");
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

  async function confirmTargetUnlocked(target) {
    let nextLogEntry = null;
    let confirmationResult = null;
    try {
      assertBackendReady(
        { isEnabled: apiClient?.isEnabled, status: backendStatus },
        `同步${target.label}`,
      );
    } catch (error) {
      setSyncStatus(error.message);
      return;
    }
    if (!quickRecordId) {
      setSyncStatus("请先完成 AI 分析，再同步业务档案");
      return;
    }
    if (analysisDirty) {
      setSyncStatus("请先保存分析修改，再同步业务档案");
      return;
    }

    setSyncStatus(`正在同步${target.label}`);
    try {
      const outcome = await confirmQuickRecordTarget({
        apiClient,
        attemptTracker: confirmationAttemptRef.current,
        quickRecord,
        analysis,
        target,
        customers: customersList,
        opportunities: opportunitiesList,
        confirmedBy: "继振",
      });
      if (outcome.status === "missing_version") {
        const entityLabel = outcome.entity === "customer" ? "客户" : "商机";
        setSyncStatus(`同步失败，请刷新${entityLabel}版本后重试：${target.label}`);
        return;
      }
      if (outcome.status === "conflict") {
        const historyItem = outcome.refreshed.quickRecord;
        setQuickRecord(historyItem);
        setAnalysis(historyItem.analysis ?? null);
        setAnalysisDirty(false);
        setConfirmedTargets(historyItem.confirmedTargets ?? []);
        setSyncLog(historyItem.syncLog ?? historyItem.confirmations ?? []);
        setAnalysisVisible(Boolean(historyItem.analysis));
        onQuickRecordSaved?.(historyItem);
        onConfirmationRefresh?.(outcome.refreshed);
        setSyncStatus(`数据已刷新，请重试：${target.label}`);
        return;
      }
      const result = outcome.result;
      confirmationResult = result;
      const confirmations = result.confirmations ?? [];
      const nextConfirmedTargets = confirmations.map((item) => item.target);
      const nextAnalysis = result.analysis ?? analysis;
      const historyItem = {
        ...quickRecord,
        ...result.quickRecord,
        analysis: nextAnalysis,
        confirmations,
        confirmedTargets: nextConfirmedTargets,
        syncLog: confirmations,
      };
      setQuickRecord(historyItem);
      setAnalysis(nextAnalysis);
      setAnalysisDirty(false);
      setConfirmedTargets(nextConfirmedTargets);
      setSyncLog(confirmations);
      onQuickRecordSaved?.(historyItem);
      onBusinessSync?.(result);
      nextLogEntry = (result.confirmations ?? []).find((item) => item.target === target.id) ?? null;
    } catch (error) {
      setSyncStatus(error?.message || `同步失败，请稍后重试：${target.label}`);
      return;
    }

    setConfirmedTargets((current) => current.includes(target.id) ? current : [...current, target.id]);

    if (target.id === "customer") {
      setSelectedCustomerId(resolveConfirmedSelectionId("customer", {
        result: confirmationResult,
        analysis,
        quickRecord,
      }));
    }
    if (target.id === "opportunity") {
      setSelectedOpportunityId(resolveConfirmedSelectionId("opportunity", {
        result: confirmationResult,
        analysis,
        quickRecord,
      }));
    }
    if (nextLogEntry) {
      setSyncLog((current) => [
        ...current.filter((item) => item.target !== nextLogEntry.target),
        nextLogEntry,
      ]);
    }
    setSyncStatus(`${target.status}（已同步）`);
  }

  async function confirmTarget(target) {
    try {
      const outcome = await confirmationGateRef.current.run(async () => {
        setConfirmationPending(true);
        try {
          await confirmTargetUnlocked(target);
          return { status: "settled" };
        } finally {
          setConfirmationPending(false);
        }
      });
      if (outcome.status === "busy") {
        setSyncStatus("正在同步，请稍候");
      }
    } catch {
      setSyncStatus(`同步失败，请稍后重试：${target.label}`);
    }
  }

  function switchToTextRecord() {
    if (recognitionRef.current) stopVoiceRecognition();
    setRecordMode("text");
    setVoiceStatus("idle");
    setVoiceInterim("");
    setVoiceMessage("已切换文本录入。");
    resetAnalysis("请继续在记录框内录入内容");
  }

  function startNewRecordFromUi() {
    startBlankRecord();
    if (onHistoryRoute && routeHistoryId) onHistoryRoute(null);
  }

  const historyItems = quickRecords.map((item) => ({ item, view: quickRecordHistoryView(item) }));
  const pendingHistoryCount = quickRecords.filter((item) => item.status !== "confirmed").length;

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
              onClick={() => {
                if (recognitionRef.current) stopVoiceRecognition();
                setRecordMode("text");
              }}
            >
              <MessageSquareText size={14} />
              文本
            </button>
            <button
              className={recordMode === "voice" ? "active" : ""}
              data-testid="quick-record-mode-voice"
              type="button"
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
          <div className={`voice-box ${voiceStatus === "listening" ? "is-listening" : ""}`}>
            <Mic size={26} />
            <div>
              <strong>语音记录</strong>
            </div>
            <div className="voice-status" data-testid="voice-status">
              <span className={`voice-dot ${visibleVoiceStatus}`} />
              <b>{voiceStatusText[visibleVoiceStatus]}</b>
              <small>{visibleVoiceMessage}</small>
            </div>
            {voiceInterim ? <p className="voice-interim">正在识别：{voiceInterim}</p> : null}
            <div className="voice-controls">
              {!voiceUnavailable ? (
                <button
                  className="primary-button"
                  type="button"
                  onClick={startVoiceRecognition}
                  disabled={voiceStatus === "listening"}
                >
                  <Mic size={15} />
                  开始转写
                </button>
              ) : null}
              {voiceStatus === "listening" ? (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={stopVoiceRecognition}
                >
                  <CircleStop size={15} />
                  停止转写
                </button>
              ) : null}
              <button className="ghost-button" type="button" onClick={switchToTextRecord}>
                <MessageSquareText size={15} />
                改用文本
              </button>
            </div>
          </div>
        ) : null}

        <textarea
          aria-label="快速记录内容"
          value={recordText}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            setRecordText(event.target.value);
            resetAnalysis("内容已变化，请重新确认分析");
          }}
          onChange={(event) => {
            if (!event.target.value.trim()) voiceCapturedRef.current = false;
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
            disabled={analysisPending}
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
            disabled={analysisPending}
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
                onTextChange={(text) => updateAnalysisSummary(key, text)}
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
              disabled={!analysisDirty || analysisSavePending}
              onClick={saveAnalysisChanges}
            >
              <Save size={16} />
              {analysisSavePending ? "保存中" : "保存分析修改"}
            </button>
            <span className="status-text">
              {analysisDirty ? "修改尚未保存" : "分析内容已保存"}
            </span>
          </div>
          <div className="manual-sync">
            {getSyncTargets().map((target) => {
              const confirmed = confirmedTargets.includes(target.id);
              const Icon = target.id === "customer" ? Save : target.id === "opportunity" ? Link2 : FileText;
              return (
                <button
                  className={confirmed ? "ghost-button confirmed" : target.id === "customer" ? "primary-button" : "ghost-button"}
                  key={target.id}
                  type="button"
                  disabled={confirmationPending || analysisSavePending || analysisDirty}
                  onClick={() => confirmTarget(target)}
                >
                  {confirmed ? <Check size={16} /> : <Icon size={16} />}
                  {confirmed ? target.doneLabel : target.label}
                </button>
              );
            })}
            <button
              className="ghost-button"
              type="button"
              disabled={confirmationPending || analysisSavePending}
              onClick={() => resetAnalysis("补充内容后可重新识别")}
            >
              补充内容后再识别
            </button>
          </div>
          <div className="sync-log" data-testid="sync-log">
            <div className="sync-log-head">
              <span>同步日志</span>
              <b>{syncLog.length}/3</b>
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
