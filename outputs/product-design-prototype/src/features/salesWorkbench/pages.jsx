import {
  BarChart3,
  Bot,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  ClipboardList,
  Download,
  FileText,
  Gauge,
  Lightbulb,
  LineChart,
  Link2,
  MessageSquareText,
  Mic,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  kanbanStages,
  statusTone,
  weeklyDays,
} from "../../data/salesWorkbenchData.js";
import { assertBackendReady } from "../../app/workbenchState.js";
import { triggerBlobDownload } from "../../downloadFile.js";
import { createConfirmationAttemptTracker } from "../../api/salesWorkbenchApi.js";
import {
  CompactList,
  ExpandableInsight,
  ExtractCard,
  InfoList,
  ManualConfirmBox,
  MatchCard,
  MetricCard,
  MetricInline,
  Panel,
  StageStrip,
  Timeline,
} from "../../components/primitives.jsx";
import {
  confirmQuickRecordTarget,
  createExclusiveAsyncGate,
  getQuickRecordFlow,
  getSyncTargets,
} from "../../quickRecordModel.js";
import { formatWeekRangeLabel, getCurrentWeekRange } from "../../weekRange.js";

export function PageHeading({ active, activeMeta, headingContext, action }) {
  const title = headingContext?.title ?? pageTitle(active);

  return (
    <div className={`page-heading ${active === "quick" ? "compact-heading" : ""}`}>
      <div>
        <span className="eyebrow">{activeMeta.label}</span>
        <h1>{title}</h1>
      </div>
      {action ? <div className="page-heading-action">{action}</div> : null}
    </div>
  );
}
function pageTitle(active) {
  const titles = {
    overview: "AI 销售作战台",
    quick: "语音 / 文本快速记录",
    customer: "客户画像",
    opportunity: "商机档案",
    actions: "下一步动作",
    solution: "方案辅助",
    weekly: "周报与管理汇报",
    risk: "风险识别",
    knowledge: "销售知识库",
    kanban: "商机看板",
    weixin: "微信机器人绑定",
  };
  return titles[active];
}

function joinedList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join("；");
  return String(value ?? "");
}

async function generateBusinessSuggestion(apiClient, backendStatus, payload) {
  assertBackendReady(
    { isEnabled: apiClient?.isEnabled, status: backendStatus },
    "生成 AI 建议",
  );
  return apiClient.generateAiSuggestion(payload);
}

export function Overview({
  actions = [],
  customersList = [],
  opportunitiesList = [],
  summary,
  setActive,
  setSelectedActionId,
  setSelectedCustomerId,
  setSelectedOpportunityId,
  openCustomerDetail,
  openOpportunityDetail,
  openOpportunityList,
  openActionDetail,
  openActionList,
  openRiskList,
}) {
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
  const rhythmItems = summary?.rhythm ?? [];

  return (
    <div className="screen-grid overview-grid">
      <MetricCard label="本周快速记录" value={metrics.quickRecords.value} badge={metrics.quickRecords.badge} tone={metrics.quickRecords.tone} className="overview-kpi" onClick={() => setActive("quick")} />
      <MetricCard label="重点商机" value={metrics.opportunities.value} badge={metrics.opportunities.badge} tone={metrics.opportunities.tone} className="overview-kpi" onClick={() => openOpportunityList ? openOpportunityList() : setActive("opportunity")} />
      <MetricCard label="预计回款" value={metrics.forecast.value} badge={metrics.forecast.badge} tone={metrics.forecast.tone} className="overview-kpi" onClick={() => setActive("kanban")} />
      <MetricCard label="高风险项" value={metrics.risks.value} badge={metrics.risks.badge} tone={metrics.risks.tone} className="overview-kpi" onClick={() => openRiskList ? openRiskList() : setActive("risk")} />

      <section className="hero-card overview-hero">
        <span>销售作战总览</span>
        <h2>从记录开始，让客户画像、商机档案和周报自动成形。</h2>
        <p>
          从快速记录沉淀客户画像、商机档案、风险动作和周报材料，销售可以先看今日优先级，再进入对应详情处理。
        </p>
        <div className="hero-stat-grid">
          <span><strong>7</strong> 天记录视图</span>
          <span><strong>3</strong> 路业务同步</span>
          <span><strong>1</strong> 套销售数据</span>
        </div>
        <div className="hero-actions">
          <button className="primary-button" type="button" onClick={() => setActive("quick")}>
            <Mic size={16} />
            新增快速记录
          </button>
          <button className="ghost-button dark" type="button" onClick={() => setActive("weekly")}>
            查看本周七天记录
          </button>
        </div>
      </section>

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

      <Panel title="本日推进节奏" meta="销售工作线" className="overview-rhythm">
        <div className="rhythm-list">
          {rhythmItems.map(({ time, title, type, target }) => (
            <button
              className="rhythm-row interactive-card"
              key={title}
              type="button"
              onClick={() => {
                if (target === "actions" && openActionList) openActionList();
                else if (target === "risk" && openRiskList) openRiskList();
                else if (target) setActive(target);
                else if (type.includes("方案")) setActive("solution");
                else if (type.includes("动作")) {
                  if (openActionList) openActionList();
                  else setActive("actions");
                }
                else setActive("weekly");
              }}
            >
              <span>{time}</span>
              <strong>{title}</strong>
              <small>{type}</small>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="商机阶段分布" meta="本周" className="overview-stage span-full">
        <StageStrip stageCounts={summary?.stageCounts} onStageClick={() => setActive("kanban")} />
      </Panel>
    </div>
  );
}

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

function getMediaRecorderConstructor() {
  if (typeof window === "undefined") return null;
  return window.MediaRecorder ?? null;
}

function canCaptureAudio() {
  if (typeof window !== "undefined" && window.isSecureContext === false) return false;
  return Boolean(
    getMediaRecorderConstructor() &&
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia,
  );
}

function audioExtension(type) {
  if (type?.includes("mp4") || type?.includes("m4a")) return "m4a";
  if (type?.includes("ogg")) return "ogg";
  if (type?.includes("wav")) return "wav";
  return "webm";
}

const voiceStatusText = {
  idle: "待录入",
  listening: "转写中",
  recorded: "已保存",
  upload: "上传录音",
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

export function QuickRecord({
  recordMode,
  setRecordMode,
  recordText,
  setRecordText,
  analysisVisible,
  setAnalysisVisible,
  syncStatus,
  setSyncStatus,
  setActive,
  setSelectedCustomerId,
  setSelectedOpportunityId,
  openOpportunityDetail,
  onBusinessSync,
  onQuickRecordSaved,
  onConfirmationRefresh,
  apiClient,
  backendStatus,
  quickRecords = [],
  customersList,
  opportunitiesList,
}) {
  const [analysis, setAnalysis] = useState(null);
  const [quickRecord, setQuickRecord] = useState(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [confirmedTargets, setConfirmedTargets] = useState([]);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [syncLog, setSyncLog] = useState([]);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceMessage, setVoiceMessage] = useState("点击开始转写即可。");
  const [voiceInterim, setVoiceInterim] = useState("");
  const [voiceAudio, setVoiceAudio] = useState(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const voiceAudioUrlRef = useRef("");
  const voiceBaseTextRef = useRef("");
  const confirmationAttemptRef = useRef(null);
  if (!confirmationAttemptRef.current) {
    confirmationAttemptRef.current = createConfirmationAttemptTracker();
  }
  const confirmationGateRef = useRef(null);
  if (!confirmationGateRef.current) {
    confirmationGateRef.current = createExclusiveAsyncGate();
  }
  const quickRecordId = quickRecord?.id ?? null;
  const hasInput = recordText.trim().length > 0;
  const speechRecognitionAvailable = canUseSpeechRecognition();
  const audioCaptureAvailable = canCaptureAudio();
  const voiceUnavailable = !speechRecognitionAvailable && !audioCaptureAvailable;
  const voiceNeedsSecureOrigin = typeof window !== "undefined" && window.isSecureContext === false;
  const flowState = getQuickRecordFlow({
    hasInput,
    hasAnalysis: Boolean(analysisVisible && analysis),
    confirmedTargets,
  });
  const isAudioCaptureMode = Boolean(mediaRecorderRef.current) || (!speechRecognitionAvailable && audioCaptureAvailable);
  const shouldRecordInsteadOfTranscribe =
    audioCaptureAvailable && (!speechRecognitionAvailable || voiceStatus === "unsupported");
  const voicePrimaryLabel = shouldRecordInsteadOfTranscribe
    ? "录音留存"
    : "开始转写";
  const visibleVoiceStatus = voiceUnavailable && voiceStatus === "idle" ? "upload" : voiceStatus;
  const visibleVoiceMessage = voiceUnavailable && voiceStatus === "idle"
    ? (voiceNeedsSecureOrigin ? "当前不是 HTTPS，请上传录音或改用文本。" : "请上传录音或改用文本。")
    : voiceMessage;

  function resetAnalysis(status) {
    confirmationAttemptRef.current.reset();
    setAnalysis(null);
    setQuickRecord(null);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setAnalysisVisible(false);
    setSyncStatus(status);
  }

  function stopMediaTracks() {
    mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function clearVoiceAudio() {
    if (voiceAudioUrlRef.current) {
      URL.revokeObjectURL(voiceAudioUrlRef.current);
      voiceAudioUrlRef.current = "";
    }
    setVoiceAudio(null);
  }

  function replaceVoiceAudio(blob, name) {
    if (!blob?.size) return;
    if (voiceAudioUrlRef.current) URL.revokeObjectURL(voiceAudioUrlRef.current);
    const url = URL.createObjectURL(blob);
    voiceAudioUrlRef.current = url;
    setVoiceAudio({
      url,
      name: name || `quick-record-${Date.now()}.${audioExtension(blob.type)}`,
      type: blob.type || "audio/webm",
      size: blob.size,
    });
  }

  function startBlankRecord() {
    if (recognitionRef.current) stopVoiceRecognition();
    if (mediaRecorderRef.current) stopVoiceRecognition();
    clearVoiceAudio();
    confirmationAttemptRef.current.reset();
    setRecordMode("text");
    setRecordText("");
    setAnalysis(null);
    setQuickRecord(null);
    setSelectedHistoryId(null);
    setConfirmedTargets([]);
    setSyncLog([]);
    setAnalysisVisible(false);
    setSyncStatus("可录入新的拜访、电话、微信或会议内容");
  }

  function loadHistoricalRecord(item) {
    if (recognitionRef.current) stopVoiceRecognition();
    if (mediaRecorderRef.current) stopVoiceRecognition();
    clearVoiceAudio();
    confirmationAttemptRef.current.reset();
    const nextText = item.rawContent ?? `${item.customer}：${item.title}。${item.feedback}`;
    const nextAnalysis = item.analysis ?? null;
    setRecordMode("text");
    setRecordText(nextText);
    setAnalysis(nextAnalysis);
    setQuickRecord(null);
    setSelectedHistoryId(item.id);
    setConfirmedTargets(item.confirmedTargets ?? []);
    setSyncLog(item.syncLog ?? []);
    setAnalysisVisible(Boolean(nextAnalysis));
    setSyncStatus(nextAnalysis ? "已载入历史分析，可直接修改或确认同步" : "已载入历史记录，暂无已保存分析");
  }

  function updateAnalysisSummary(section, text) {
    confirmationAttemptRef.current.reset();
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
    setSyncStatus("分析内容已手动修改，确认后再写入业务档案");
  }

  function appendVoiceTranscript(transcript, status) {
    const base = voiceBaseTextRef.current.trim();
    const cleanTranscript = transcript.trim();
    const nextText = [base, cleanTranscript].filter(Boolean).join(base ? "\n" : "");
    setRecordText(nextText);
    resetAnalysis(status);
  }

  function stopVoiceRecognition() {
    const mediaRecorder = mediaRecorderRef.current;
    if (mediaRecorder) {
      if (mediaRecorder.state !== "inactive") {
        setVoiceMessage("正在停止录音采集");
        try {
          mediaRecorder.stop();
        } catch {
          mediaRecorderRef.current = null;
          stopMediaTracks();
          setVoiceStatus("idle");
          setVoiceMessage("录音已停止。");
        }
        return;
      }
      mediaRecorderRef.current = null;
      stopMediaTracks();
    }

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

  async function startVoiceAudioCapture() {
    if (!audioCaptureAvailable) {
      setVoiceStatus("unsupported");
      setVoiceInterim("");
      setVoiceMessage("请改用文本录入。");
      setSyncStatus("语音不可用，请改用文本");
      return;
    }

    if (mediaRecorderRef.current?.state === "recording") {
      setVoiceMessage("正在录音。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const MediaRecorder = getMediaRecorderConstructor();
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      voiceBaseTextRef.current = recordText.trim();
      clearVoiceAudio();

      recorder.ondataavailable = (event) => {
        if (event.data?.size) audioChunksRef.current.push(event.data);
      };

      recorder.onstart = () => {
        setVoiceStatus("listening");
        setVoiceInterim("");
        setVoiceMessage("正在录音。");
        setSyncStatus("录音中，结束后补文字");
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || audioChunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type });
        mediaRecorderRef.current = null;
        stopMediaTracks();
        replaceVoiceAudio(blob, `quick-record-audio-${Date.now()}.${audioExtension(type)}`);
        setVoiceStatus("recorded");
        setVoiceInterim("");
        setVoiceMessage("录音已保存，可补录文字。");
        setSyncStatus("录音已保存，请补录文字后分析");
      };

      recorder.onerror = () => {
        mediaRecorderRef.current = null;
        stopMediaTracks();
        setVoiceStatus("error");
        setVoiceInterim("");
        setVoiceMessage("录音失败，请检查权限。");
        setSyncStatus("录音失败");
      };

      recorder.start();
    } catch (error) {
      mediaRecorderRef.current = null;
      stopMediaTracks();
      setVoiceStatus("error");
      setVoiceInterim("");
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        setVoiceMessage("请开启麦克风权限。");
        setSyncStatus("麦克风权限未开启");
        return;
      }
      setVoiceMessage("录音失败，请改用文本。");
      setSyncStatus("录音启动失败");
    }
  }

  async function startVoiceRecognition() {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    setRecordMode("voice");

    if (!SpeechRecognition) {
      recognitionRef.current = null;
      await startVoiceAudioCapture();
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
        setVoiceMessage(audioCaptureAvailable ? "实时转写不可用，可录音留存。" : "请改用文本。");
        setSyncStatus("实时转写不可用");
        return;
      }
      if (event.error === "no-speech") {
        setVoiceMessage("未识别到语音。");
        setSyncStatus("没有识别到语音");
        return;
      }
      if (audioCaptureAvailable) setVoiceStatus("unsupported");
      setVoiceMessage(audioCaptureAvailable ? "实时转写不可用，可录音留存。" : "请改用文本。");
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

  function handleVoiceFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    replaceVoiceAudio(file, file.name || `quick-record-audio.${audioExtension(file.type)}`);
    setVoiceStatus("recorded");
    setVoiceInterim("");
    setVoiceMessage("已上传录音，可补录文字。");
    setSyncStatus("已选择录音文件，请补录文字后分析");
    event.target.value = "";
  }

  useEffect(() => () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
    }
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    stopMediaTracks();
    if (voiceAudioUrlRef.current) URL.revokeObjectURL(voiceAudioUrlRef.current);
    recognitionRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  async function confirmAnalysis() {
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
        sourceChannel: recordMode === "voice" ? "语音转写" : "快速记录",
      });
      setQuickRecord(result.quickRecord);
      onQuickRecordSaved?.(result.quickRecord);
      setAnalysis(result.analysis);
      setConfirmedTargets([]);
      setSyncLog([]);
      setAnalysisVisible(true);
      setSyncStatus("分析完成，等待人工同步");
    } catch (error) {
      setSyncStatus(error?.message || "分析失败，请稍后重试");
    }
  }

  async function confirmTargetUnlocked(target) {
    let nextLogEntry = null;
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
        setQuickRecord(outcome.refreshed.quickRecord);
        onQuickRecordSaved?.(outcome.refreshed.quickRecord);
        onConfirmationRefresh?.(outcome.refreshed);
        setSyncStatus(`数据已刷新，请重试：${target.label}`);
        return;
      }
      const result = outcome.result;
      setQuickRecord(result.quickRecord);
      onQuickRecordSaved?.(result.quickRecord);
      onBusinessSync?.(result);
      nextLogEntry = (result.confirmations ?? []).find((item) => item.target === target.id) ?? null;
    } catch (error) {
      setSyncStatus(error?.message || `同步失败，请稍后重试：${target.label}`);
      return;
    }

    setConfirmedTargets((current) => {
      if (current.includes(target.id)) return current;
      return [...current, target.id];
    });

    if (target.id === "customer") {
      setSelectedCustomerId(analysis?.customer?.id ?? quickRecord?.customerId ?? "rizhao");
    }
    if (target.id === "opportunity") {
      setSelectedOpportunityId(analysis?.opportunity?.id ?? quickRecord?.opportunityId ?? "op-rizhao-plan");
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
    if (mediaRecorderRef.current) stopVoiceRecognition();
    setRecordMode("text");
    setVoiceStatus("idle");
    setVoiceInterim("");
    setVoiceMessage("已切换文本录入。");
    resetAnalysis("请继续在记录框内录入内容");
  }

  const historyItems = quickRecords.map((item) => ({ item, view: quickRecordHistoryView(item) }));
  const pendingHistoryCount = quickRecords.filter((item) => item.status !== "confirmed").length;

  return (
    <div className="record-layout">
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
              onClick={() => loadHistoricalRecord(item)}
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
            {voiceAudio ? (
              <div className="voice-audio-card" data-testid="voice-audio-card">
                <audio controls src={voiceAudio.url} aria-label="语音记录录音回放" />
                <a className="ghost-button" href={voiceAudio.url} download={voiceAudio.name}>
                  <Download size={15} />
                  下载录音
                </a>
              </div>
            ) : null}
            <div className="voice-controls">
              {!voiceUnavailable ? (
                <button
                  className="primary-button"
                  type="button"
                  onClick={shouldRecordInsteadOfTranscribe ? startVoiceAudioCapture : startVoiceRecognition}
                  disabled={voiceStatus === "listening"}
                >
                  <Mic size={15} />
                  {voicePrimaryLabel}
                </button>
              ) : null}
              {voiceStatus === "listening" ? (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={stopVoiceRecognition}
                >
                  <CircleStop size={15} />
                  {isAudioCaptureMode ? "停止录音" : "停止转写"}
                </button>
              ) : null}
              <label
                className={`${voiceUnavailable ? "primary-button" : "ghost-button"} voice-file-button`}
                data-testid="voice-upload-control"
              >
                <FileText size={15} />
                上传录音
                <input
                  accept="audio/*"
                  aria-label="上传录音"
                  capture="microphone"
                  onChange={handleVoiceFileChange}
                  type="file"
                />
              </label>
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
          onChange={(event) => {
            setRecordText(event.target.value);
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
            onClick={confirmAnalysis}
          >
            <Send size={16} />
            确认调用 AI 分析
          </button>
          <button
            className="ghost-button"
            type="button"
            data-testid="new-quick-record"
            onClick={startBlankRecord}
          >
            <Plus size={16} />
            新建记录
          </button>
          <button
            className="ghost-button"
            type="button"
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
          <div className="manual-sync">
            {getSyncTargets().map((target) => {
              const confirmed = confirmedTargets.includes(target.id);
              const Icon = target.id === "customer" ? Save : target.id === "opportunity" ? Link2 : FileText;
              return (
                <button
                  className={confirmed ? "ghost-button confirmed" : target.id === "customer" ? "primary-button" : "ghost-button"}
                  key={target.id}
                  type="button"
                  disabled={confirmationPending}
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
              disabled={confirmationPending}
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

function StakeholderGrid({ people }) {
  const [expandedPerson, setExpandedPerson] = useState(null);

  return (
    <div className="stakeholder-grid">
      {people.map((person) => {
        const id = `${person.name}-${person.role}`;
        return (
        <button
          className={`stakeholder-card interactive-card ${expandedPerson === id ? "expanded" : ""}`}
          key={id}
          type="button"
          onClick={() => setExpandedPerson((current) => (current === id ? null : id))}
        >
          <span className="avatar-dot" />
          <strong>{person.name}</strong>
          <small>{person.role}</small>
          <b className="pill tone-blue">{person.influence}</b>
          {expandedPerson === id ? (
            <small className="item-detail" data-testid="stakeholder-expanded">
              已展开：适合补充最近沟通、影响力变化和下次拜访问题。
            </small>
          ) : null}
        </button>
        );
      })}
    </div>
  );
}

function FieldTags({ items, tone = "blue" }) {
  const [expandedItem, setExpandedItem] = useState(null);

  return (
    <div className="field-tags">
      {items.map((item) => (
        <button
          className={`field-tag interactive-card ${statusTone[tone]} ${expandedItem === item ? "expanded" : ""}`}
          key={item}
          type="button"
          onClick={() => setExpandedItem((current) => (current === item ? null : item))}
        >
          {item}
          {expandedItem === item ? <small data-testid="field-tag-expanded">可用于复盘、方案材料或客户背书。</small> : null}
        </button>
      ))}
    </div>
  );
}

function DecisionChain({ steps }) {
  const [expandedStep, setExpandedStep] = useState(null);

  return (
    <div className="chain-list">
      {steps.map((step, index) => (
        <button
          className={`chain-step interactive-card ${expandedStep === step ? "expanded" : ""}`}
          key={step}
          type="button"
          onClick={() => setExpandedStep((current) => (current === step ? null : step))}
        >
          <time>{index + 1}</time>
          <span>{step}</span>
          {expandedStep === step ? (
            <small data-testid="chain-expanded">已展开：需要记录责任人、确认材料和下一次推进动作。</small>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function DraftPreview({ draft, emptyText }) {
  if (!draft) return <div className="draft-empty">{emptyText}</div>;
  const lines = draft.content.split("\n").filter(Boolean).slice(0, 32);
  const knowledgeRefs = (draft.sourceRefs ?? []).filter((ref) => ref.type === "knowledge");
  return (
    <section className="generated-draft" data-testid="generated-draft">
      <div className="generated-draft-head">
        <span className="pill tone-green">草稿</span>
        <strong>{draft.title ?? `${draft.owner} 销售周报草稿`}</strong>
        <small>{draft.sourceRefs.length} 个来源引用 / {draft.status}</small>
        {knowledgeRefs.length > 0 ? (
          <div className="draft-ref-row">
            <b>知识库引用</b>
            {knowledgeRefs.slice(0, 3).map((ref) => (
              <span className="pill tone-teal" key={`${ref.type}-${ref.id}`}>{ref.title ?? ref.id}</span>
            ))}
          </div>
        ) : null}
      </div>
      <pre>{lines.join("\n")}</pre>
    </section>
  );
}

function textFromArray(items) {
  return (items ?? []).join("\n");
}

function arrayFromText(value) {
  return String(value ?? "")
    .split(/\r?\n|[，,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberFromInput(value, fallback = 0) {
  if (String(value ?? "").trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function customerToForm(customer) {
  return {
    id: customer?.id ?? "",
    name: customer?.name ?? "",
    region: customer?.region ?? "",
    type: customer?.type ?? "",
    level: customer?.level ?? "",
    owner: customer?.owner ?? "",
    contact: customer?.contact ?? "",
    relation: customer?.relation == null ? "" : String(customer.relation),
    budget: customer?.budget ?? "",
    summary: customer?.summary ?? "",
    needs: textFromArray(customer?.needs),
    risks: textFromArray(customer?.risks),
    infrastructure: textFromArray(customer?.infrastructure),
  };
}

function customerFromForm(form, isNew) {
  return {
    ...(isNew ? {} : { id: form.id }),
    name: form.name.trim(),
    region: form.region.trim(),
    type: form.type.trim(),
    level: form.level.trim(),
    owner: form.owner.trim(),
    contact: form.contact.trim(),
    relation: numberFromInput(form.relation),
    budget: form.budget.trim(),
    summary: form.summary.trim(),
    needs: arrayFromText(form.needs),
    risks: arrayFromText(form.risks),
    infrastructure: arrayFromText(form.infrastructure),
    stakeholders: isNew ? [] : undefined,
    decisionChain: isNew ? [] : undefined,
    historyProjects: isNew ? [] : undefined,
    syncPreview: isNew ? [] : undefined,
    opportunities: isNew ? [] : undefined,
  };
}

function opportunityToForm(opportunity, selectedCustomer) {
  const hasOpportunity = Boolean(opportunity?.id);
  return {
    id: opportunity?.id ?? "",
    customerId: hasOpportunity ? (opportunity?.customerId ?? selectedCustomer?.id ?? "") : "",
    name: opportunity?.name ?? "",
    customer: hasOpportunity ? (opportunity?.customer ?? selectedCustomer?.name ?? "") : "",
    stage: opportunity?.stage ?? "",
    amount: opportunity?.amount ?? "",
    owner: opportunity?.owner ?? "",
    probability: opportunity?.probability == null ? "" : String(opportunity.probability),
    days: opportunity?.days == null ? "" : String(opportunity.days),
    requirements: textFromArray(opportunity?.requirements),
    competitors: textFromArray(opportunity?.competitors),
    solutionDirection: textFromArray(opportunity?.solutionDirection),
    risk: opportunity?.risk ?? "",
    next: opportunity?.next ?? "",
  };
}

function opportunityFromForm(form, customersList, isNew) {
  const customer = customersList.find((item) => item.id === form.customerId);
  return {
    ...(isNew ? {} : { id: form.id }),
    customerId: form.customerId,
    name: form.name.trim(),
    customer: customer?.name ?? form.customer.trim(),
    stage: form.stage.trim(),
    amount: form.amount.trim(),
    owner: form.owner.trim(),
    probability: numberFromInput(form.probability, 30),
    days: numberFromInput(form.days),
    requirements: arrayFromText(form.requirements),
    competitors: arrayFromText(form.competitors),
    solutionDirection: arrayFromText(form.solutionDirection),
    risk: form.risk.trim(),
    next: form.next.trim(),
    tone: "blue",
  };
}

function knowledgeToForm(item) {
  return {
    id: item?.id ?? "",
    title: item?.title ?? "",
    category: item?.category ?? "销售材料",
    tags: textFromArray(item?.tags),
    summary: item?.summary ?? "",
    content: item?.content ?? "",
    source: item?.source ?? "销售知识库",
  };
}

function knowledgeFromForm(form, isNew) {
  return {
    ...(isNew ? {} : { id: form.id }),
    title: form.title.trim(),
    category: form.category.trim(),
    tags: arrayFromText(form.tags),
    summary: form.summary.trim(),
    content: form.content.trim(),
    source: form.source.trim(),
  };
}

function FormField({ label, children }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function confirmDelete(message) {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(message);
}

function showOperationError(message) {
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message);
  }
}

function CustomerEditor({ selected, initialMode = "edit", onSaveCustomer, onSaved, onCancel, backendStatus }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() => (initialMode === "new" ? customerToForm(null) : customerToForm(selected)));
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(customerToForm(selected));
  }, [selected, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? customerToForm(null) : customerToForm(selected));
    setSaveStatus("就绪");
  }, [initialMode, selected]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setSaveStatus("客户名称不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveCustomer(customerFromForm(form, isNew));
      setMode("edit");
      setForm(customerToForm(saved));
      onSaved?.(saved);
       setSaveStatus("已保存");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="customer-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">客户维护</span>
          <strong>{isNew ? "新建客户画像" : "编辑当前客户"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="customer-cancel-edit" onClick={() => {
            setForm(isNew ? customerToForm(null) : customerToForm(selected));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {isNew ? "创建客户" : "保存客户"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="客户名称">
          <input value={form.name} onChange={(event) => update("name", event.target.value)} />
        </FormField>
        <FormField label="区域">
          <input value={form.region} onChange={(event) => update("region", event.target.value)} />
        </FormField>
        <FormField label="类型">
          <input value={form.type} onChange={(event) => update("type", event.target.value)} />
        </FormField>
        <FormField label="级别">
          <input value={form.level} onChange={(event) => update("level", event.target.value)} />
        </FormField>
        <FormField label="负责人">
          <input value={form.owner} onChange={(event) => update("owner", event.target.value)} />
        </FormField>
        <FormField label="联系人">
          <input value={form.contact} onChange={(event) => update("contact", event.target.value)} />
        </FormField>
        <FormField label="关系强度">
          <input min="0" max="100" type="number" value={form.relation} onChange={(event) => update("relation", event.target.value)} />
        </FormField>
        <FormField label="预算节奏">
          <input value={form.budget} onChange={(event) => update("budget", event.target.value)} />
        </FormField>
      </div>
      <FormField label="客户摘要">
        <textarea value={form.summary} onChange={(event) => update("summary", event.target.value)} />
      </FormField>
      <div className="editor-grid three">
        <FormField label="核心需求">
          <textarea value={form.needs} onChange={(event) => update("needs", event.target.value)} />
        </FormField>
        <FormField label="风险顾虑">
          <textarea value={form.risks} onChange={(event) => update("risks", event.target.value)} />
        </FormField>
        <FormField label="基础架构">
          <textarea value={form.infrastructure} onChange={(event) => update("infrastructure", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

function OpportunityEditor({ selected, customersList, initialMode = "edit", onSaveOpportunity, onSaved, onCancel, backendStatus }) {
  const selectedCustomer = customersList.find((item) => item.id === selected?.customerId) ?? customersList[0];
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() =>
    initialMode === "new" ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer),
  );
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(opportunityToForm(selected, selectedCustomer));
  }, [selected, selectedCustomer, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer));
    setSaveStatus("就绪");
  }, [initialMode, selected, selectedCustomer]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim() || !form.customerId) {
      setSaveStatus("商机名称和客户不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveOpportunity(opportunityFromForm(form, customersList, isNew));
      setMode("edit");
      setForm(opportunityToForm(saved, selectedCustomer));
      onSaved?.(saved);
      setSaveStatus("已保存");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="opportunity-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">商机维护</span>
          <strong>{isNew ? "新建商机档案" : "编辑当前商机"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="opportunity-cancel-edit" onClick={() => {
            setForm(isNew ? opportunityToForm(null, selectedCustomer) : opportunityToForm(selected, selectedCustomer));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {isNew ? "创建商机" : "保存商机"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="商机名称">
          <input value={form.name} onChange={(event) => update("name", event.target.value)} />
        </FormField>
        <FormField label="关联客户">
          <select value={form.customerId} onChange={(event) => update("customerId", event.target.value)}>
            {isNew ? <option value="">请选择客户</option> : null}
            {customersList.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="阶段">
          <input value={form.stage} onChange={(event) => update("stage", event.target.value)} />
        </FormField>
        <FormField label="金额">
          <input value={form.amount} onChange={(event) => update("amount", event.target.value)} />
        </FormField>
        <FormField label="负责人">
          <input value={form.owner} onChange={(event) => update("owner", event.target.value)} />
        </FormField>
        <FormField label="赢率">
          <input min="0" max="100" type="number" value={form.probability} onChange={(event) => update("probability", event.target.value)} />
        </FormField>
        <FormField label="停留天数">
          <input min="0" type="number" value={form.days} onChange={(event) => update("days", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-grid three">
        <FormField label="需求">
          <textarea value={form.requirements} onChange={(event) => update("requirements", event.target.value)} />
        </FormField>
        <FormField label="竞争对手">
          <textarea value={form.competitors} onChange={(event) => update("competitors", event.target.value)} />
        </FormField>
        <FormField label="方案方向">
          <textarea value={form.solutionDirection} onChange={(event) => update("solutionDirection", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-grid two">
        <FormField label="风险说明">
          <textarea value={form.risk} onChange={(event) => update("risk", event.target.value)} />
        </FormField>
        <FormField label="下一步动作">
          <textarea value={form.next} onChange={(event) => update("next", event.target.value)} />
        </FormField>
      </div>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

function KnowledgeEditor({ selected, initialMode = "edit", onSaveKnowledge, onSaved, onCancel, backendStatus }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState(() => (initialMode === "new" ? knowledgeToForm(null) : knowledgeToForm(selected)));
  const [saveStatus, setSaveStatus] = useState("就绪");
  const isNew = mode === "new";

  useEffect(() => {
    if (mode === "edit") setForm(knowledgeToForm(selected));
  }, [selected, mode]);

  useEffect(() => {
    setMode(initialMode);
    setForm(initialMode === "new" ? knowledgeToForm(null) : knowledgeToForm(selected));
    setSaveStatus("就绪");
  }, [initialMode, selected]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.title.trim()) {
      setSaveStatus("知识标题不能为空");
      return;
    }
    setSaveStatus("保存中");
    try {
      const saved = await onSaveKnowledge(knowledgeFromForm(form, isNew));
      setMode("edit");
      setForm(knowledgeToForm(saved));
      onSaved?.(saved);
      setSaveStatus("已保存到知识库");
    } catch (error) {
      setSaveStatus(error.message || "保存失败");
    }
  }

  return (
    <form className="editor-panel" data-testid="knowledge-editor" onSubmit={submit}>
      <div className="editor-head">
        <div>
          <span className="eyebrow">知识维护</span>
          <strong>{isNew ? "新增销售知识" : "编辑当前知识"}</strong>
        </div>
        <div className="editor-actions">
          <button className="ghost-button" type="button" data-testid="knowledge-cancel-edit" onClick={() => {
            setForm(isNew ? knowledgeToForm(null) : knowledgeToForm(selected));
            setSaveStatus("就绪");
            onCancel?.();
          }}>
            <ChevronLeft size={16} />
            {isNew ? "取消新增" : "取消修改"}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {isNew ? "创建知识" : "保存知识"}
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <FormField label="标题">
          <input value={form.title} onChange={(event) => update("title", event.target.value)} />
        </FormField>
        <FormField label="分类">
          <input value={form.category} onChange={(event) => update("category", event.target.value)} />
        </FormField>
        <FormField label="标签">
          <input value={form.tags} onChange={(event) => update("tags", event.target.value)} placeholder="用逗号或换行分隔" />
        </FormField>
        <FormField label="来源">
          <input value={form.source} onChange={(event) => update("source", event.target.value)} />
        </FormField>
      </div>
      <FormField label="摘要">
        <textarea value={form.summary} onChange={(event) => update("summary", event.target.value)} />
      </FormField>
      <FormField label="正文 / 引用口径">
        <textarea value={form.content} onChange={(event) => update("content", event.target.value)} />
      </FormField>
      <div className="editor-status">{saveStatus}</div>
    </form>
  );
}

export function CustomerPage({
  items,
  selected,
  onSelect,
  setActive,
  setSelectedOpportunityId,
  openOpportunityDetail,
  onSaveCustomer,
  onDeleteCustomer,
  opportunitiesList = [],
  viewMode = "list",
  setViewMode,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.name, item.region, item.type, item.level, item.contact, item.summary, item.owner].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  async function deleteCurrentCustomer() {
    if (!selected?.id || !onDeleteCustomer) return;
    if (!confirmDelete(`确认删除客户「${selected.name}」？删除后将从客户列表移除。`)) return;
    try {
      await onDeleteCustomer(selected.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除客户失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="customer-list-view" data-testid="customer-list-view">
        <Panel title="客户列表" meta={`${visibleItems.length} / ${items.length} 家客户`} className="list-panel customer-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索客户"
              data-testid="customer-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索客户、区域、联系人、预算节奏"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${selected?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.region} / {item.type} / {item.contact}</small>
                  </span>
                  <b className="pill tone-blue">{item.level}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="customer-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无客户，可点击右上角新增客户。" : "没有匹配客户，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="customer-detail-view detail-scroll-view" data-testid="customer-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {!isCreateView ? (
          <div className="detail-toolbar-actions">
            <button
              className={isEditView ? "ghost-button disabled" : "ghost-button"}
              disabled={isEditView}
              type="button"
              data-testid="customer-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="customer-delete-detail"
              onClick={deleteCurrentCustomer}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <CustomerEditor
            selected={isCreateView ? null : selected}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveCustomer={onSaveCustomer}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
            backendStatus={backendStatus}
          />
        ) : null}
        {!isCreateView && !isEditView && (
          <>
        <div className="detail-metrics">
          <MetricInline label="区域" value={selected.region} />
          <MetricInline label="负责人" value={selected.owner} />
          <MetricInline label="关系强度" value={`${selected.relation}`} />
          <MetricInline label="预算节奏" value={selected.budget} />
        </div>
        <div className="three-col">
          <Panel title="核心需求" meta="沉淀自记录">
            <InfoList items={selected.needs} tone="blue" />
          </Panel>
          <Panel title="风险与顾虑" meta="需跟进">
            <InfoList items={selected.risks} tone="amber" />
          </Panel>
          <Panel title="关联商机" meta="点击跳转">
            <div className="list-stack tiny">
              {selected.opportunities.map((name) => {
                const opportunity = opportunitiesList.find((item) => item.name === name);
                return (
                  <button
                    className="plain-link"
                    key={name}
                    type="button"
                    onClick={() => {
                      if (opportunity && openOpportunityDetail) openOpportunityDetail(opportunity.id);
                      else {
                        if (opportunity) setSelectedOpportunityId(opportunity.id);
                        setActive("opportunity");
                      }
                    }}
                  >
                    {name}
                    <ChevronRight size={15} />
                  </button>
                );
              })}
            </div>
          </Panel>
        </div>
        <div className="two-col customer-profile-grid">
          <Panel title="组织架构与决策链" meta="影响力视图">
            <StakeholderGrid people={selected.stakeholders} />
            <DecisionChain steps={selected.decisionChain} />
          </Panel>
          <Panel title="关键联系人" meta="跟进角色">
            <StakeholderGrid people={selected.stakeholders.slice(0, 4)} />
          </Panel>
          <Panel title="历史项目" meta="已沉淀">
            <FieldTags items={selected.historyProjects} tone="green" />
          </Panel>
          <Panel title="现有基础架构" meta="调研字段">
            <InfoList items={selected.infrastructure} tone="teal" />
          </Panel>
          <Panel title="快速记录承接" meta="记录来源">
            <InfoList items={selected.syncPreview} tone="blue" />
          </Panel>
        </div>
        <ManualConfirmBox
          title="生成客户画像补全建议"
          desc="结合快速记录整理组织关系、需求痛点和下一次拜访问题。"
          onGenerate={() =>
            generateBusinessSuggestion(apiClient, backendStatus, {
              type: "customer_profile",
              title: "生成客户画像补全建议",
              context: {
                customerId: selected.id,
                customer: selected.name,
                summary: selected.summary,
                level: selected.level,
                region: selected.region,
                budget: selected.budget,
                needs: joinedList(selected.needs),
                risks: joinedList(selected.risks),
                stakeholders: joinedList((selected.stakeholders ?? []).map((item) => `${item.name}-${item.role}`)),
                decisionChain: joinedList(selected.decisionChain),
                infrastructure: joinedList(selected.infrastructure),
                syncPreview: joinedList(selected.syncPreview),
              },
            })
          }
        />
          </>
        )}
      </section>
    </section>
  );
}

export function OpportunityPage({
  items,
  selected,
  onSelect,
  setActive,
  setSelectedCustomerId,
  viewMode = "list",
  setViewMode,
  customersList,
  onSaveOpportunity,
  onDeleteOpportunity,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.name, item.customer, item.stage, item.risk, item.next, item.owner].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  async function deleteCurrentOpportunity() {
    if (!selected?.id || !onDeleteOpportunity) return;
    if (!confirmDelete(`确认删除商机「${selected.name}」？删除后将从商机列表移除。`)) return;
    try {
      await onDeleteOpportunity(selected.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除商机失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="opportunity-list-view" data-testid="opportunity-list-view">
        <Panel title="商机列表" meta={`${visibleItems.length} / ${items.length} 个商机`} className="list-panel opportunity-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索商机"
              data-testid="opportunity-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索商机、客户、阶段、负责人"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${selected?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.customer} / {item.stage}</small>
                  </span>
                  <b className={`pill ${statusTone[item.tone]}`}>{item.probability}%</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="opportunity-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无商机，可点击右上角新增商机。" : "没有匹配商机，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="opportunity-detail-view detail-scroll-view" data-testid="opportunity-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {!isCreateView ? (
          <div className="detail-toolbar-actions">
            <button
              className={isEditView ? "ghost-button disabled" : "ghost-button"}
              disabled={isEditView}
              type="button"
              data-testid="opportunity-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="opportunity-delete-detail"
              onClick={deleteCurrentOpportunity}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <OpportunityEditor
            selected={isCreateView ? null : selected}
            customersList={customersList}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveOpportunity={onSaveOpportunity}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
            backendStatus={backendStatus}
          />
        ) : null}
        {!isCreateView && !isEditView && (
          <>
        <div className="detail-metrics">
          <MetricInline label="金额" value={selected.amount} />
          <MetricInline label="赢率" value={`${selected.probability}%`} />
          <MetricInline label="负责人" value={selected.owner} />
          <MetricInline label="阶段" value={selected.stage} />
        </div>
        <div className="two-col">
          <Panel title="客户诉求 / 需求" meta="商机字段">
            <InfoList items={selected.requirements} tone="blue" />
          </Panel>
          <Panel title="竞争对手" meta="关系与方案压力">
            <FieldTags items={selected.competitors} tone="amber" />
          </Panel>
          <Panel title="方案方向" meta="售前协同">
            <InfoList items={selected.solutionDirection} tone="green" />
          </Panel>
          <Panel title="来源记录" meta="快速记录承接">
            <ExpandableInsight
              testId="opportunity-source-insight"
              expandedTestId="opportunity-source-expanded"
              ariaLabel="展开商机来源记录"
              detail="已展开来源记录：可回到快速记录核对原始拜访、电话或会议内容，再决定是否写入周报。"
            >
              {selected.sourceRecord ?? "尚未绑定来源记录，可从快速记录确认后写入商机档案。"}
            </ExpandableInsight>
          </Panel>
          <Panel title="风险说明" meta="来自记录与字段">
            <ExpandableInsight
              tone="amber"
              testId="opportunity-risk-insight"
              expandedTestId="opportunity-risk-expanded"
              ariaLabel="展开商机风险说明"
              detail="已展开风险说明：可进入风险识别页分配负责人、设置处理时间并关闭风险。"
            >
              {selected.risk ?? "尚未沉淀风险说明，可在风险识别页补充证据和处理建议。"}
            </ExpandableInsight>
          </Panel>
          <Panel title="下一步动作" meta="推进安排">
            <ExpandableInsight
              testId="opportunity-next-insight"
              expandedTestId="opportunity-next-expanded"
              ariaLabel="展开商机下一步动作"
              detail="已展开下一步动作：可进入下一步动作页调整负责人、截止时间和完成状态。"
            >
              {selected.next ?? "尚未生成下一步动作，可从快速记录或商机推进建议中确认后生成。"}
            </ExpandableInsight>
          </Panel>
        </div>
        <Timeline />
        <div className="detail-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setSelectedCustomerId(selected.customerId);
              setActive("customer");
            }}
          >
            查看客户画像
          </button>
          <ManualConfirmBox
            compact
            title="手动生成商机推进建议"
            desc="结合当前商机整理预算路径、竞品应对和售前支持建议。"
            onGenerate={() =>
              generateBusinessSuggestion(apiClient, backendStatus, {
                type: "opportunity_push",
                title: "手动生成商机推进建议",
                context: {
                  opportunityId: selected.id,
                  opportunity: selected.name,
                  customerId: selected.customerId,
                  customer: selected.customer,
                  stage: selected.stage,
                  amount: selected.amount,
                  probability: selected.probability,
                  owner: selected.owner,
                  requirements: joinedList(selected.requirements),
                  competitors: joinedList(selected.competitors),
                  solutionDirection: joinedList(selected.solutionDirection),
                  risk: selected.risk,
                  next: selected.next,
                  sourceRecord: selected.sourceRecord,
                },
              })
            }
          />
        </div>
          </>
        )}
      </section>
    </section>
  );
}

const actionStatusMeta = {
  pending: { label: "待处理", tone: "blue", message: "动作已保留在待处理队列。" },
  in_progress: { label: "处理中", tone: "amber", message: "动作已进入处理中，周报会按推进项呈现。" },
  done: { label: "已完成", tone: "green", message: "动作已标记完成，可进入周报结果。" },
  deferred: { label: "已延期", tone: "amber", message: "动作已延期，请确认新的负责人和时间。" },
};

export function ActionsPage({
  items = [],
  selected,
  onSelect,
  setActive,
  viewMode = "list",
  setViewMode,
  onUpdateActionStatus,
  onDeleteAction,
  backendStatus,
}) {
  const current = selected ?? items[0] ?? null;
  const [searchText, setSearchText] = useState("");
  const currentStatus = actionStatusMeta[current?.status] ?? actionStatusMeta.pending;
  const isEditView = viewMode === "edit";
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "");
  const [statusMessage, setStatusMessage] = useState("确认负责人和时间后，可更新动作处理状态。");
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.title, item.customer, item.reason, item.due, item.priority, item.status, item.assignee].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  useEffect(() => {
    setAssignee(current?.assignee ?? "继振");
    setDue(current?.due ?? "");
    setStatusMessage("确认负责人和时间后，可更新动作处理状态。");
  }, [current?.id, current?.assignee, current?.due]);

  async function updateAction(status) {
    if (!current?.id || !onUpdateActionStatus) return;
    setStatusMessage("正在更新动作状态");
    try {
      const updated = await onUpdateActionStatus(current.id, {
        status,
        due,
        assignee,
        tone: status === "done" ? "green" : status === "deferred" ? "amber" : "blue",
      });
      const meta = actionStatusMeta[updated.status] ?? actionStatusMeta.pending;
       setStatusMessage(`${meta.message}（已同步）`);
    } catch {
      setStatusMessage("动作更新失败，请稍后重试。");
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  async function deleteCurrentAction() {
    if (!current?.id || !onDeleteAction) return;
    if (!confirmDelete(`确认删除动作「${current.title}」？删除后将从动作列表移除。`)) return;
    try {
      await onDeleteAction(current.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除动作失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="action-list-view" data-testid="action-list-view">
        <Panel title="动作列表" meta={`${visibleItems.length} / ${items.length} 个动作`} className="list-panel action-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索动作"
              data-testid="actions-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索动作、客户、负责人、截止时间"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${current?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.customer} / {item.due} / {actionStatusMeta[item.status]?.label ?? item.status}</small>
                  </span>
                  <b className={`pill ${statusTone[item.tone]}`}>{item.priority}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="actions-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无动作记录。" : "没有匹配动作，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="action-detail-view detail-scroll-view" data-testid="action-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        <div className="detail-toolbar-actions">
          <button
            className={isEditView ? "ghost-button disabled" : "ghost-button"}
            disabled={isEditView}
            type="button"
            data-testid="action-edit-detail"
            onClick={() => setViewMode?.("edit")}
          >
            <Pencil size={15} />
            修改
          </button>
          <button
            className="ghost-button danger"
            type="button"
            data-testid="action-delete-detail"
            onClick={deleteCurrentAction}
          >
            <Trash2 size={15} />
            删除
          </button>
        </div>
      </div>
      <section className="detail-surface">
        <div className="detail-metrics">
          <MetricInline label="客户" value={current.customer} />
          <MetricInline label="负责人" value={current.assignee ?? "待分配"} />
          <MetricInline label="截止" value={current.due} />
          <MetricInline label="状态" value={currentStatus.label} />
        </div>
        {isEditView ? (
        <Panel title="动作落地处理" meta="销售人工更新">
          <div className="editor-grid two">
            <label className="form-field">
              <span>负责人</span>
              <input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
            </label>
            <label className="form-field">
              <span>下一次时间</span>
              <input value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <div className="risk-status-toolbar action-status-toolbar" data-testid="action-status-toolbar">
            <span className={`pill tone-${currentStatus.tone}`}>{currentStatus.label}</span>
            <button
              className={current.status === "in_progress" ? "ghost-button disabled" : "ghost-button"}
              disabled={current.status === "in_progress"}
              type="button"
              onClick={() => updateAction("in_progress")}
            >
              开始处理
            </button>
            <button
              className={current.status === "deferred" ? "ghost-button disabled" : "ghost-button"}
              disabled={current.status === "deferred"}
              type="button"
              onClick={() => updateAction("deferred")}
            >
              延期跟进
            </button>
            <button
              className={current.status === "done" ? "ghost-button disabled" : "primary-button"}
              disabled={current.status === "done"}
              type="button"
              onClick={() => updateAction("done")}
            >
              标记完成
            </button>
          </div>
          <p className="risk-status-message">{statusMessage}</p>
          <button className="primary-button" type="button" onClick={() => setActive("weekly")}>
            写入本周计划
          </button>
          <button className="ghost-button" type="button" onClick={() => setViewMode?.("detail")}>
            取消修改
          </button>
        </Panel>
        ) : (
          <>
            <div className="two-col">
              <Panel title="动作说明" meta={current.priority}>
                <ExpandableInsight
                  testId="action-reason-insight"
                  expandedTestId="action-reason-expanded"
                  ariaLabel="展开动作说明"
                  detail="已展开动作说明：如需调整负责人、时间或状态，请点击修改。"
                >
                  {current.reason ?? "暂无动作说明。"}
                </ExpandableInsight>
              </Panel>
              <Panel title="执行安排" meta="只读详情">
                <InfoList
                  items={[
                    `负责人：${current.assignee ?? "待分配"}`,
                    `截止时间：${current.due ?? "待确认"}`,
                    `当前状态：${currentStatus.label}`,
                  ]}
                  tone="blue"
                />
              </Panel>
            </div>
            <button className="primary-button" type="button" onClick={() => setActive("weekly")}>
              写入本周计划
            </button>
          </>
        )}
      </section>
    </section>
  );
}

const solutionArtifacts = [
  {
    id: "communication_outline",
    label: "沟通提纲",
    desc: "面向下一次客户会议，明确目标、问题和会后动作。",
    tone: "blue",
  },
  {
    id: "presales_questions",
    label: "售前问题清单",
    desc: "整理基础架构、业务系统、预算与迁移边界问题。",
    tone: "amber",
  },
  {
    id: "solution_framework",
    label: "方案框架",
    desc: "形成客户现状、方案方向、实施路径和确认事项。",
    tone: "green",
  },
  {
    id: "report_outline",
    label: "汇报材料大纲",
    desc: "沉淀领导汇报结构、客户价值和决策请求。",
    tone: "teal",
  },
  {
    id: "competitive_talk",
    label: "竞品应对话术",
    desc: "围绕竞品、异议、证据材料和应对口径组织。",
    tone: "red",
  },
];

function sourceRefText(ref) {
  const typeLabel = {
    artifact: "交付物",
    customer: "客户",
    opportunity: "商机",
    action: "动作",
    knowledge: "知识",
  }[ref.type] ?? ref.type;
  return `${typeLabel}：${ref.title ?? ref.id ?? "来源"}`;
}

export function SolutionPage({ selected, onSelect, customer, opportunity, apiClient, backendStatus, draft, setDraft, solutionDocs = [] }) {
  const [localDrafts, setLocalDrafts] = useState({});
  const [selectedArtifactType, setSelectedArtifactType] = useState(draft?.artifactType ?? "solution_framework");
  const [draftStatus, setDraftStatus] = useState("选择交付物后，可生成对应方案材料。");
  const [draftText, setDraftText] = useState("");
  const selectedArtifact = solutionArtifacts.find((item) => item.id === selectedArtifactType) ?? solutionArtifacts[0];
  const externalDraft = draft?.artifactType === selectedArtifactType ? draft : null;
  const currentDraft = localDrafts[selectedArtifactType] ?? externalDraft ?? null;
  const visibleDraft = currentDraft ? { ...currentDraft, content: draftText || currentDraft.content } : null;
  const updateExternalDraft = setDraft ?? (() => {});

  useEffect(() => {
    if (!draft?.artifactType) return;
    setLocalDrafts((current) => ({ ...current, [draft.artifactType]: draft }));
    setSelectedArtifactType(draft.artifactType);
  }, [draft?.id]);

  useEffect(() => {
    setDraftText(currentDraft?.content ?? "");
    if (!currentDraft) {
      setDraftStatus(`${selectedArtifact.label}尚未生成。`);
      return;
    }
    const hasKnowledge = currentDraft.sourceRefs?.some((ref) => ref.type === "knowledge");
    setDraftStatus(hasKnowledge ? `${selectedArtifact.label}已生成，知识库引用已保留。` : `${selectedArtifact.label}已生成，来源引用已保留。`);
  }, [currentDraft?.id, selectedArtifactType]);

  function storeDraft(item) {
    setLocalDrafts((current) => ({ ...current, [item.artifactType]: item }));
    updateExternalDraft(item);
    setDraftText(item.content);
  }

  async function generateSolutionDraft() {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，可先查看交付物结构。");
      return;
    }

    setDraftStatus(`正在生成${selectedArtifact.label}`);
    try {
      const item = await apiClient.generateSolutionDraft({
        owner: "继振",
        customerId: customer.id,
        opportunityId: opportunity.id,
        artifactType: selectedArtifact.id,
      });
      storeDraft(item);
      setDraftStatus(`${selectedArtifact.label}已生成，可直接修改后保存。`);
    } catch {
      setDraftStatus(`${selectedArtifact.label}生成失败，请检查客户与商机数据后重试。`);
    }
  }

  async function saveSolutionDraft() {
    if (!currentDraft) {
      setDraftStatus("请先生成交付物。");
      return;
    }
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，暂不能保存草稿。");
      return;
    }

    setDraftStatus(`正在保存${selectedArtifact.label}`);
    try {
      const saved = await apiClient.saveSolutionDraft(currentDraft.id, {
        content: draftText,
        status: "saved",
      }, currentDraft.version);
      storeDraft(saved);
      setDraftStatus(`${selectedArtifact.label}已保存。`);
    } catch {
      setDraftStatus(`${selectedArtifact.label}保存失败，请稍后重试。`);
    }
  }

  const sourceRefs = currentDraft?.sourceRefs?.length
    ? currentDraft.sourceRefs
    : [
        { type: "artifact", id: selectedArtifact.id, title: selectedArtifact.label },
        { type: "customer", id: customer.id, title: customer.name },
        { type: "opportunity", id: opportunity.id, title: opportunity.name },
      ];

  return (
    <div className="solution-workbench list-detail-grid">
      <Panel title="方案交付物" meta="先选类型" className="list-panel">
        <div className="list-stack solution-artifact-list">
          {solutionArtifacts.map((item) => (
            <button
              className={`list-button ${selectedArtifactType === item.id ? "selected" : ""}`}
              key={item.id}
              type="button"
              data-testid={`solution-artifact-${item.id}`}
              onClick={() => setSelectedArtifactType(item.id)}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.desc}</small>
              </span>
              <b className={`pill tone-${item.tone}`}>{localDrafts[item.id] ? "已生成" : "待生成"}</b>
            </button>
          ))}
        </div>
      </Panel>
      <section className="detail-surface paper-like solution-detail">
        <div className="solution-detail-head">
          <div>
            <span className="eyebrow">方案辅助 / {selectedArtifact.label}</span>
            <h2>{selectedArtifact.label}</h2>
            <p>{selectedArtifact.desc}</p>
          </div>
          <div className="detail-toolbar-actions">
            <button className="primary-button draft-button" type="button" onClick={generateSolutionDraft}>
              <Sparkles size={16} />
              生成交付物
            </button>
            <button className="ghost-button" type="button" onClick={generateSolutionDraft}>
              <RefreshCw size={15} />
              重新生成
            </button>
            <button className="ghost-button" type="button" onClick={saveSolutionDraft}>
              <Save size={15} />
              保存草稿
            </button>
          </div>
        </div>
        <div className="draft-source-strip">
          <span>客户：{customer.name}</span>
          <span>商机：{opportunity.name}</span>
          <span>状态：{draftStatus}</span>
        </div>
        <div className="solution-context-grid">
          <Panel title="来源与引用" meta={`${sourceRefs.length} 个来源`}>
            <div className="source-ref-list">
              {sourceRefs.map((ref, index) => (
                <span key={`${ref.type}-${ref.id ?? index}`}>{sourceRefText(ref)}</span>
              ))}
            </div>
          </Panel>
          <Panel title="关联材料" meta="可切换查看">
            <div className="related-docs">
              {solutionDocs.map((item) => (
                <button
                  className={selected?.id === item.id ? "selected" : ""}
                  key={item.id}
                  type="button"
                  onClick={() => onSelect?.(item.id)}
                >
                  <strong>{item.title}</strong>
                  <small>{item.type} / {item.source}</small>
                  </button>
                ))}
              {solutionDocs.length === 0 ? <p className="empty-list">暂无已保存的方案历史。</p> : null}
            </div>
          </Panel>
        </div>
        <label className="form-field solution-editor-field">
          <span>草稿正文</span>
          <textarea
            aria-label="方案交付物草稿正文"
            className="solution-editor"
            value={draftText}
            onChange={(event) => {
              setDraftText(event.target.value);
              if (currentDraft) setDraftStatus(`${selectedArtifact.label}已手动修改，请保存草稿。`);
            }}
            placeholder={`点击“生成交付物”后，这里会显示${selectedArtifact.label}，可手动修改。`}
          />
        </label>
        <DraftPreview draft={visibleDraft} emptyText={`尚未生成${selectedArtifact.label}。`} />
      </section>
    </div>
  );
}

export function WeeklyPage({
  weeklyView,
  setWeeklyView,
  apiClient,
  backendStatus,
  weeklyDraft: externalWeeklyDraft,
  setWeeklyDraft: setExternalWeeklyDraft,
  weeklyDraftText: externalWeeklyDraftText,
  setWeeklyDraftText: setExternalWeeklyDraftText,
}) {
  const [localWeeklyDraft, setLocalWeeklyDraft] = useState(null);
  const [localWeeklyDraftText, setLocalWeeklyDraftText] = useState("");
  const [draftStatus, setDraftStatus] = useState("周报草稿尚未生成。");
  const [expandedDay, setExpandedDay] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const daily = weeklyView === "daily";
  const weeklyDraft = externalWeeklyDraft ?? localWeeklyDraft;
  const weeklyDraftText = externalWeeklyDraft ? externalWeeklyDraftText ?? "" : localWeeklyDraftText;
  const setWeeklyDraft = setExternalWeeklyDraft ?? setLocalWeeklyDraft;
  const setWeeklyDraftText = setExternalWeeklyDraftText ?? setLocalWeeklyDraftText;

  useEffect(() => {
    if (!weeklyDraft) return;
    const hasKnowledge = weeklyDraft.sourceRefs?.some((ref) => ref.type === "knowledge");
    setDraftStatus(hasKnowledge ? "已载入知识库引用周报，来源引用已保留。" : "周报草稿已生成，来源记录已保留。");
  }, [weeklyDraft?.id]);

  async function generateWeeklyDraft() {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setDraftStatus("当前连接未恢复，可先查看周报结构。");
      return;
    }

    setDraftStatus("正在从已确认进入周报的快速记录生成草稿");
    try {
      const { periodStart, periodEnd } = getCurrentWeekRange();
      const item = await apiClient.generateWeeklyDraft({
        owner: "继振",
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
          {weeklyDays.map((item) => (
            <section
              className={`day-card interactive-card ${expandedDay === item.day ? "expanded" : ""}`}
              key={item.day}
              role="button"
              tabIndex={0}
              aria-label={`${expandedDay === item.day ? "收起" : "展开"}${item.day}记录`}
              aria-expanded={expandedDay === item.day}
              onClick={() => setExpandedDay((current) => (current === item.day ? null : item.day))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setExpandedDay((current) => (current === item.day ? null : item.day));
                }
              }}
            >
              <div>
                <span className="date-chip tone-blue">{item.date}</span>
                <h3>{item.day}</h3>
              </div>
              <ul>
                {item.records.map((record) => (
                  <li key={record}>{record}</li>
                ))}
              </ul>
              <p>{item.feedback}</p>
              {expandedDay === item.day ? (
                <div className="day-card-detail" data-testid="weekly-expanded-day">
                  <strong>当天处理</strong>
                  <span>已展开记录、客户反馈和可同步到周报的行动线索。</span>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <div className="summary-grid" data-testid="weekly-summary-view">
          <section className="paper">
            <span className="eyebrow">本周周报草稿</span>
            <h2>{weekRangeLabel} 销售周报 / 管理汇报</h2>
            <h3>一、本周重点工作</h3>
            <p>
              本周围绕日照中医医院十五五规划、黄岛区中医院双活机房调研机会、胜利油田中心医院服务器采购参考和黄岛区域客户覆盖展开。
            </p>
            <h3>二、客户反馈与机会</h3>
            <p>
              日照中医医院对移动云灾备模式提出明确顾虑，黄岛区中医院释放调研机会，多个客户对 AI 算力基础架构处于观望阶段。
            </p>
            <h3>三、风险与需要支持</h3>
            <ul>
              <li>预算路径仍需确认，尤其是胜利油田中心医院与日照中医医院。</li>
              <li>黄岛区中医院需要售前支持调研并输出双活机房规划。</li>
              <li>移动云灾备问题需要形成可对比的方案材料。</li>
            </ul>
          </section>
          <div className="stack">
            <MetricCard
              label="本周拜访 / 沟通"
              value="12"
              badge="来自快速记录"
              tone="blue"
              detail="点击展开：该指标汇总已确认进入周报的拜访、电话、微信和会议记录。"
            />
            <MetricCard
              label="新增调研机会"
              value="2"
              badge="黄岛区中医 / 黄岛中心"
              tone="green"
              detail="点击展开：用于提醒销售安排售前、客户现场调研和下一次沟通窗口。"
            />
            <MetricCard
              label="需公司支持"
              value="3"
              badge="售前 / 架构图 / 案例"
              tone="amber"
              detail="点击展开：用于向经理同步需要协调的售前、方案材料和案例资源。"
            />
            <section className="manual-box compact">
              <div>
                <strong>确认生成周报分析</strong>
                <p>{draftStatus}</p>
              </div>
              <button className="primary-button" type="button" onClick={generateWeeklyDraft}>
                <Sparkles size={16} />
                手动生成
              </button>
            </section>
            <DraftPreview draft={weeklyDraft} emptyText="尚未生成周报。已确认进入周报的快速记录会作为来源。" />
            {weeklyDraft ? (
              <section className="weekly-editor" data-testid="weekly-draft-editor">
                <div className="generated-draft-head">
                  <span className="pill tone-blue">可编辑</span>
                  <strong>周报正文确认</strong>
                  <small>{weeklyDraft.sourceRefs.length} 个来源引用 / {weeklyStatusLabel}</small>
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
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

const riskStatusMeta = {
  open: { label: "待确认", tone: "tone-amber", helper: "先确认风险是否真实影响商机推进。" },
  accepted: { label: "已确认", tone: "tone-blue", helper: "风险已纳入跟进，需要明确处理责任。" },
  in_progress: { label: "处理中", tone: "tone-teal", helper: "处理中风险需要持续跟踪证据和下一步动作。" },
  deferred: { label: "已延期", tone: "tone-amber", helper: "风险处理已顺延，需要明确下一次处理时间。" },
  closed: { label: "已关闭", tone: "tone-green", helper: "风险已关闭，后续只保留追溯记录。" },
};

function riskStatusLabel(status) {
  return riskStatusMeta[status]?.label ?? status ?? "待确认";
}

const riskStatusActions = [
  { status: "accepted", label: "确认风险", tone: "blue", note: "风险已由销售确认，进入跟进队列。" },
  { status: "in_progress", label: "开始处理", tone: "teal", note: "风险处理中：已安排销售和售前共同补齐证据与处理动作。" },
  { status: "deferred", label: "延期处理", tone: "amber", note: "客户会议延期，风险处理顺延到下一次确认时间。" },
  { status: "closed", label: "关闭风险", tone: "green", note: "风险已关闭：处理结果已确认，保留来源追溯。" },
];

const riskSourceLabels = {
  quick_record: "快速记录",
  opportunity_diagnosis: "商机诊断",
  manual_audit: "人工评估",
  opportunity: "商机档案",
};

function riskSourceLabel(sourceType) {
  if (!sourceType) return "手动";
  return riskSourceLabels[sourceType] ?? "业务记录";
}

export function RiskPage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
  onUpdateRiskStatus,
  onDeleteRisk,
  backendStatus,
}) {
  const current = selected ?? items[0] ?? null;
  const [searchText, setSearchText] = useState("");
  const isEditView = viewMode === "edit";
  const [statusMessage, setStatusMessage] = useState("选择风险后，可人工确认、开始处理或关闭。");
  const [assignee, setAssignee] = useState(current?.assignee ?? "继振");
  const [due, setDue] = useState(current?.due ?? "待确认");
  const currentStatus = riskStatusMeta[current?.status] ?? riskStatusMeta.open;
  const sourceLabel = riskSourceLabel(current?.sourceType);
  const cleanSearch = searchText.trim().toLowerCase();
  const visibleItems = cleanSearch
    ? items.filter((item) =>
      [item.title, item.target, item.evidence, item.action, item.severity, item.status, item.assignee].some((value) =>
        String(value ?? "").toLowerCase().includes(cleanSearch),
      ),
    )
    : items;

  useEffect(() => {
    setAssignee(current?.assignee ?? "继振");
    setDue(current?.due ?? "待确认");
  }, [current?.id, current?.assignee, current?.due]);

  async function updateStatus(action) {
    if (!current?.id) return;
    setStatusMessage("保存风险状态中");
    try {
      await onUpdateRiskStatus(current.id, {
        status: action.status,
        action: action.note,
        assignee: assignee.trim() || "待分配",
        due: due.trim() || "待确认",
        tone: action.tone,
      });
      setStatusMessage("风险状态已保存");
    } catch (error) {
      setStatusMessage(error.message || "风险状态保存失败");
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  async function deleteCurrentRisk() {
    if (!current?.id || !onDeleteRisk) return;
    if (!confirmDelete(`确认删除风险「${current.title}」？删除后将从风险列表移除。`)) return;
    try {
      await onDeleteRisk(current.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除风险失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="risk-list-view" data-testid="risk-list-view">
        <Panel title="风险列表" meta={`${visibleItems.length} / ${items.length} 个风险`} className="list-panel risk-list-panel">
          <label className="search-box page-search">
            <Search size={16} />
            <input
              aria-label="搜索风险"
              data-testid="risk-local-search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索风险、客户、证据、负责人"
            />
          </label>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${current?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.target} / {riskStatusLabel(item.status)}</small>
                  </span>
                  <b className={`score-chip ${statusTone[item.tone]}`}>{item.score}</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="risk-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无风险记录。" : "没有匹配风险，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="risk-detail-view detail-scroll-view" data-testid="risk-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        <div className="detail-toolbar-actions">
          <button
            className={isEditView ? "ghost-button disabled" : "ghost-button"}
            disabled={isEditView}
            type="button"
            data-testid="risk-edit-detail"
            onClick={() => setViewMode?.("edit")}
          >
            <Pencil size={15} />
            修改
          </button>
          <button
            className="ghost-button danger"
            type="button"
            data-testid="risk-delete-detail"
            onClick={deleteCurrentRisk}
          >
            <Trash2 size={15} />
            删除
          </button>
        </div>
      </div>
      <section className="detail-surface">
        <div className="detail-metrics">
          <MetricInline label="状态" value={currentStatus.label} />
          <MetricInline label="严重度" value={current.severity ?? "中"} />
          <MetricInline label="分值" value={`${current.score}`} />
          <MetricInline label="来源" value={sourceLabel} />
          <MetricInline label="负责人" value={current.assignee ?? "待分配"} />
          <MetricInline label="下次处理" value={current.due ?? "待确认"} />
        </div>
        <div className="risk-meter">
          <span style={{ width: `${current.score}%` }} />
        </div>
        {isEditView ? (
        <Panel title="状态流转" meta={currentStatus.helper}>
          <div className="editor-grid two risk-owner-grid">
            <label className="form-field">
              <span>负责人</span>
              <input data-testid="risk-assignee-input" value={assignee} onChange={(event) => setAssignee(event.target.value)} />
            </label>
            <label className="form-field">
              <span>下次处理时间</span>
              <input data-testid="risk-due-input" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <div className="risk-status-toolbar" data-testid="risk-status-toolbar">
            <span className={`pill ${currentStatus.tone}`}>{currentStatus.label}</span>
            {riskStatusActions.map((action) => (
              <button
                className={current.status === action.status ? "ghost-button disabled" : "ghost-button"}
                disabled={current.status === action.status}
                key={action.status}
                type="button"
                data-testid={`risk-action-${action.status}`}
                onClick={() => updateStatus(action)}
              >
                {action.status === "deferred" ? <CalendarClock size={15} /> : <Check size={15} />}
                {action.label}
              </button>
            ))}
          </div>
          <p className="risk-status-message">{statusMessage}</p>
          <button className="ghost-button" type="button" onClick={() => setViewMode?.("detail")}>
            取消修改
          </button>
        </Panel>
        ) : (
          <Panel title="处理状态" meta={currentStatus.helper}>
            <InfoList
              items={[
                `负责人：${current.assignee ?? "待分配"}`,
                `下次处理：${current.due ?? "待确认"}`,
                `当前状态：${currentStatus.label}`,
              ]}
              tone="blue"
            />
          </Panel>
        )}
        <Panel title="证据" meta={current.sourceType ? `来源：${sourceLabel}` : "来自快速记录与周报字段"}>
          <ExpandableInsight
            tone="amber"
            testId="risk-evidence-insight"
            expandedTestId="risk-evidence-expanded"
            ariaLabel="展开风险证据"
            detail="已展开证据：可用于复核来源记录、周报字段和商机风险判断。"
          >
            {current.evidence ?? "尚未补充证据，可从快速记录、客户反馈或周报字段中确认来源。"}
          </ExpandableInsight>
        </Panel>
        <Panel title="建议处理" meta="人工确认">
          <ExpandableInsight
            testId="risk-action-insight"
            expandedTestId="risk-action-expanded"
            ariaLabel="展开风险处理建议"
            detail="已展开建议处理：确认后可在上方状态流转中分配负责人、延期处理或关闭风险。"
          >
            {current.action ?? "尚未生成处理建议，可先分配负责人并记录下一次处理时间。"}
          </ExpandableInsight>
        </Panel>
      </section>
    </section>
  );
}

export function KnowledgePage({
  items = [],
  selected,
  onSelect,
  viewMode = "list",
  setViewMode,
  onSaveKnowledge,
  onDeleteKnowledge,
  onSearchKnowledge,
  onCiteKnowledge,
  customer,
  opportunity,
  apiClient,
  backendStatus,
}) {
  const [searchText, setSearchText] = useState("");
  const [visibleItems, setVisibleItems] = useState(items);
  const [searchStatus, setSearchStatus] = useState("按客户、场景或标签检索销售材料。");
  const [citationStatus, setCitationStatus] = useState("选择知识材料后，可生成带来源引用的方案或周报草稿。");
  const [citingTarget, setCitingTarget] = useState(null);
  const current = selected ?? visibleItems[0] ?? null;

  useEffect(() => {
    setVisibleItems(items);
  }, [items]);

  async function submitSearch(event) {
    event.preventDefault();
    setSearchStatus("检索中");
    try {
      const tags = arrayFromText(searchText).filter((item) => item.length <= 12);
      const results = await onSearchKnowledge({ query: searchText, tags });
      setVisibleItems(results);
      if (results[0]) onSelect(results[0].id);
      setSearchStatus(`已找到 ${results.length} 条可引用材料`);
    } catch {
      setSearchStatus("检索失败，请稍后重试或更换关键词。");
    }
  }

  async function citeKnowledge(target) {
    if (!current?.id || !onCiteKnowledge) {
      setCitationStatus("当前没有可引用的知识材料。");
      return;
    }
    const targetLabel = target === "weekly" ? "周报" : "方案";
    setCitingTarget(target);
    setCitationStatus(`正在引用到${targetLabel}草稿，并保留来源`);
    try {
      await onCiteKnowledge(target, current);
      setCitationStatus(`已引用到${targetLabel}草稿，正在打开目标页面。`);
    } catch (error) {
      setCitationStatus(error.message || `引用到${targetLabel}失败，请稍后重试。`);
    } finally {
      setCitingTarget(null);
    }
  }

  function openDetail(item) {
    onSelect(item.id);
    setViewMode?.("detail");
  }

  const isCreateView = viewMode === "create";
  const isEditView = viewMode === "edit";

  async function deleteCurrentKnowledge() {
    if (!current?.id || !onDeleteKnowledge) return;
    if (!confirmDelete(`确认删除知识「${current.title}」？删除后将从知识列表移除。`)) return;
    try {
      await onDeleteKnowledge(current.id);
      setViewMode?.("list");
    } catch (error) {
      showOperationError(error.message || "删除知识失败，请稍后重试。");
    }
  }

  if (viewMode === "list") {
    return (
      <section className="knowledge-list-view" data-testid="knowledge-list-view">
        <Panel title="知识列表" meta={`${visibleItems.length} 条`} className="list-panel knowledge-list-panel">
          <form className="knowledge-search" data-testid="knowledge-search" onSubmit={submitSearch}>
            <label className="search-box compact">
              <Search size={16} />
              <input
                aria-label="搜索知识库材料"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="搜索移动云、双活、调研模板"
              />
            </label>
            <button className="ghost-button" type="submit">
              <Search size={15} />
              检索
            </button>
          </form>
          <p className="list-hint">{searchStatus}</p>
          <div className="list-stack">
            {visibleItems.map((item) => (
              <article
                className={`list-button customer-list-row ${current?.id === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <button className="list-row-main" type="button" onClick={() => onSelect(item.id)}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.category} / {(item.tags ?? []).slice(0, 2).join("、") || item.source || "知识材料"}</small>
                  </span>
                  <b className="pill tone-teal">已入库</b>
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="knowledge-open-detail"
                  onClick={() => openDetail(item)}
                >
                  查看详情
                  <ChevronRight size={15} />
                </button>
              </article>
            ))}
            {visibleItems.length === 0 ? (
              <p className="empty-list">
                {items.length === 0 ? "暂无知识材料，可点击右上角新增知识。" : "没有匹配材料，请调整关键词。"}
              </p>
            ) : null}
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="knowledge-detail-view detail-scroll-view" data-testid="knowledge-detail-view">
      <div className="subview-actions sticky-subview-toolbar">
        <button className="ghost-button" type="button" onClick={() => setViewMode?.("list")}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        {!isCreateView ? (
          <div className="detail-toolbar-actions">
            <button
              className={isEditView ? "ghost-button disabled" : "ghost-button"}
              disabled={isEditView}
              type="button"
              data-testid="knowledge-edit-detail"
              onClick={() => setViewMode?.("edit")}
            >
              <Pencil size={15} />
              修改
            </button>
            <button
              className="ghost-button danger"
              type="button"
              data-testid="knowledge-delete-detail"
              onClick={deleteCurrentKnowledge}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ) : null}
      </div>
      <section className="detail-surface">
        {(isCreateView || isEditView) ? (
          <KnowledgeEditor
            selected={isCreateView ? null : current}
            initialMode={isCreateView ? "new" : "edit"}
            onSaveKnowledge={onSaveKnowledge}
            onSaved={(saved) => {
              onSelect(saved.id);
              setViewMode?.("detail");
            }}
            onCancel={() => setViewMode?.(isCreateView ? "list" : "detail")}
            backendStatus={backendStatus}
          />
        ) : null}
        {!isCreateView && !isEditView && (
          <>
        <div className="tag-row">
          {(current.tags ?? []).map((tag) => (
            <span className="pill" key={tag}>{tag}</span>
          ))}
        </div>
        <section className="citation-panel" data-testid="knowledge-citation-actions">
          <div>
            <span className="eyebrow">引用到业务交付物</span>
            <strong>{customer?.name ?? "当前客户"} / {opportunity?.name ?? "当前商机"}</strong>
            <p>{citationStatus}</p>
          </div>
          <div className="citation-actions">
            <button
              className="primary-button"
              type="button"
              disabled={citingTarget !== null}
              onClick={() => citeKnowledge("solution")}
            >
              <Link2 size={16} />
              {citingTarget === "solution" ? "生成中" : "引用到方案"}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={citingTarget !== null}
              onClick={() => citeKnowledge("weekly")}
            >
              <FileText size={16} />
              {citingTarget === "weekly" ? "生成中" : "引用到周报"}
            </button>
          </div>
        </section>
        <Panel title="引用口径" meta={current.source ?? "知识库"}>
          <div className="insight">{current.content ?? current.summary}</div>
        </Panel>
        <Panel title="引用场景" meta="销售使用建议">
          <InfoList
            items={["客户现场答疑", "方案大纲引用", "领导汇报材料", "竞品应对话术"]}
            tone="teal"
          />
        </Panel>
        <ManualConfirmBox
          title="确认引用到方案材料"
          desc="引用知识库材料前需要人工确认客户场景，避免把不匹配的案例写进方案。"
          onGenerate={() =>
            generateBusinessSuggestion(apiClient, backendStatus, {
              type: "knowledge_talk",
              title: "确认引用到方案材料",
              context: {
                knowledgeId: current.id,
                knowledge: current.title,
                category: current.category,
                tags: joinedList(current.tags),
                summary: current.summary,
                content: current.content,
                source: current.source,
              },
            })
          }
        />
          </>
        )}
      </section>
    </section>
  );
}

function bindingStatusMeta(status) {
  const map = {
    idle: { label: "未开始", tone: "tone-gray" },
    starting: { label: "生成中", tone: "tone-amber" },
    waiting_scan: { label: "等待扫码", tone: "tone-blue" },
    logged_in: { label: "已绑定", tone: "tone-green" },
    authenticated: { label: "已绑定", tone: "tone-green" },
    stopped: { label: "已停止", tone: "tone-gray" },
    expired: { label: "已过期", tone: "tone-red" },
    error: { label: "异常", tone: "tone-red" },
  };
  return map[status] ?? map.idle;
}

function formatBindingTime(value) {
  if (!value) return "尚无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return "尚无";
  }
}

export function WeixinBindingPage({ apiClient, backendStatus }) {
  const backendReady = Boolean(apiClient?.isEnabled && backendStatus === "connected");
  const [binding, setBinding] = useState({ status: "idle", message: "点击生成二维码" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const statusMeta = bindingStatusMeta(binding?.status);
  const shouldPoll = backendReady && ["starting", "waiting_scan"].includes(binding?.status);

  useEffect(() => {
    if (!backendReady) return undefined;
    let disposed = false;

    async function loadStatus() {
      try {
        const next = await apiClient.getWeixinBindingStatus();
        if (!disposed) {
          setBinding(next ?? { status: "idle", message: "点击生成二维码" });
          setError("");
        }
      } catch (err) {
        if (!disposed) setError(err.message || "读取绑定状态失败");
      }
    }

    void loadStatus();
    if (!shouldPoll) {
      return () => {
        disposed = true;
      };
    }

    const timer = window.setInterval(loadStatus, 1800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [apiClient, backendReady, shouldPoll]);

  async function startBinding() {
    if (!backendReady) {
      setError("服务未连接，暂时不能生成二维码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setBinding(await apiClient.startWeixinBinding());
    } catch (err) {
      setError(err.message || "生成二维码失败");
    } finally {
      setBusy(false);
    }
  }

  async function refreshBinding() {
    if (!backendReady) {
      setError("服务未连接，暂时不能刷新状态");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setBinding(await apiClient.getWeixinBindingStatus());
    } catch (err) {
      setError(err.message || "刷新状态失败");
    } finally {
      setBusy(false);
    }
  }

  async function stopBinding() {
    if (!backendReady) return;
    setBusy(true);
    setError("");
    try {
      setBinding(await apiClient.stopWeixinBinding());
    } catch (err) {
      setError(err.message || "停止绑定失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="weixin-binding-page" data-testid="weixin-binding-page">
      <Panel title="机器人绑定" meta={statusMeta.label} className="weixin-binding-panel">
        <div className="weixin-binding-grid">
          <div className="weixin-binding-main">
            <div className="weixin-status-row">
              <span className={`pill ${statusMeta.tone}`}>{statusMeta.label}</span>
              <span>{binding?.message || "等待操作"}</span>
            </div>

            <div className={`weixin-qr-frame ${binding?.qrSvg ? "has-qr" : ""}`}>
              {binding?.qrSvg ? (
                <div className="weixin-qr-svg" dangerouslySetInnerHTML={{ __html: binding.qrSvg }} />
              ) : (
                <div className="weixin-qr-empty">
                  <QrCode size={42} />
                  <strong>生成后扫码绑定</strong>
                  <span>二维码过期后可重新生成。</span>
                </div>
              )}
            </div>

            {error ? <p className="weixin-error">{error}</p> : null}

            <div className="weixin-actions">
              <button className="primary-button" type="button" onClick={startBinding} disabled={busy || !backendReady}>
                <QrCode size={16} />
                生成二维码
              </button>
              <button className="ghost-button" type="button" onClick={refreshBinding} disabled={busy || !backendReady}>
                <RefreshCw size={16} />
                刷新状态
              </button>
              <button className="ghost-button danger" type="button" onClick={stopBinding} disabled={busy || !backendReady}>
                <CircleStop size={16} />
                停止
              </button>
            </div>
          </div>

          <aside className="weixin-binding-side">
            <div className="weixin-side-head">
              <span className="mini-icon tone-blue">
                <Bot size={16} />
              </span>
              <div>
                <strong>扫码后可用</strong>
                <span>微信消息会进入快速记录流程。</span>
              </div>
            </div>
            <dl className="weixin-binding-facts">
              <div>
                <dt>服务</dt>
                <dd>{backendReady ? "已连接" : "未连接"}</dd>
              </div>
              <div>
                <dt>启动时间</dt>
                <dd>{formatBindingTime(binding?.startedAt)}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{formatBindingTime(binding?.updatedAt)}</dd>
              </div>
            </dl>
            <div className="weixin-check-list">
              <span><Check size={14} /> 登录态保存在服务器</span>
              <span><Link2 size={14} /> 过期后直接重新生成</span>
            </div>
          </aside>
        </div>
      </Panel>
    </section>
  );
}

export function KanbanPage({
  opportunitiesList = [],
  setActive,
  setSelectedOpportunityId,
  openOpportunityDetail,
  onSaveOpportunity,
  backendStatus,
}) {
  const [statusMessage, setStatusMessage] = useState("看板阶段变更会同步到商机档案。");
  const knownStages = kanbanStages.map(([stage]) => stage);
  const extraStages = [...new Set(opportunitiesList.map((item) => item.stage).filter(Boolean))]
    .filter((stage) => !knownStages.includes(stage));
  const stages = [...knownStages, ...extraStages];

  async function moveOpportunity(item, direction) {
    if (!onSaveOpportunity) return;
    const currentIndex = stages.indexOf(item.stage);
    const nextStage = stages[currentIndex + direction];
    if (!nextStage) return;
    setStatusMessage("正在更新看板阶段");
    try {
      await onSaveOpportunity({
        id: item.id,
        stage: nextStage,
      });
            setStatusMessage("看板已更新，并同步到商机档案");
    } catch (error) {
      setStatusMessage(error.message || "看板阶段更新失败");
    }
  }

  return (
    <div className="kanban-page">
      <p className="kanban-status">{statusMessage}</p>
      <div className="kanban-board">
        {stages.map((stage) => {
          const cards = opportunitiesList.filter((item) => item.stage === stage);
          return (
          <section className="kanban-col" key={stage}>
            <h3>
              <span>{stage}</span>
              <b>{cards.length}</b>
            </h3>
            {cards.length === 0 ? <p className="kanban-empty">暂无商机</p> : null}
            {cards.map((item) => {
              const stageIndex = stages.indexOf(item.stage);
              const canMoveBack = stageIndex > 0;
              const canMoveForward = stageIndex >= 0 && stageIndex < stages.length - 1;
              return (
                <article className="deal-card" key={item.id}>
                  <button
                    className="deal-card-main"
                    type="button"
                    data-testid="kanban-open-opportunity"
                    onClick={() => {
                      if (openOpportunityDetail) openOpportunityDetail(item.id);
                      else {
                        setSelectedOpportunityId(item.id);
                        setActive("opportunity");
                      }
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.customer}</small>
                    <span className={`pill ${statusTone[item.tone ?? "blue"]}`}>{stage}</span>
                  </button>
                  <div className="kanban-card-actions">
                    <button
                      className="ghost-button compact-icon"
                      type="button"
                      data-testid="kanban-stage-back"
                      disabled={!canMoveBack}
                      title="回退阶段"
                      onClick={() => moveOpportunity(item, -1)}
                    >
                      <ChevronLeft size={15} />
                      回退
                    </button>
                    <button
                      className="ghost-button compact-icon"
                      type="button"
                      data-testid="kanban-stage-forward"
                      disabled={!canMoveForward}
                      title="推进阶段"
                      onClick={() => moveOpportunity(item, 1)}
                    >
                      推进
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
          );
        })}
      </div>
    </div>
  );
}
