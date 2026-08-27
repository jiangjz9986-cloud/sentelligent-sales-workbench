import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  KeyRound,
  LoaderCircle,
  Play,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "../../components/primitives.jsx";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(value) {
  return value === "active" ? "已启用" : value === "cleared" ? "已清除" : "未配置";
}

function sourceLabel(value) {
  return value === "settings"
    ? "加密配置"
    : value === "environment"
      ? "部署环境"
      : value === "none" && value !== undefined
        ? "未启用"
        : "—";
}

function bindingStatusLabel(value) {
  return {
    idle: "未启动",
    starting: "启动中",
    waiting_scan: "等待扫码",
    logged_in: "已绑定",
    authenticated: "已绑定",
    stopped: "已停止",
    expired: "已过期",
    error: "异常",
  }[value] ?? "未知";
}

function hospitalHealthLabel(value) {
  return {
    healthy: "健康",
    degraded: "降级",
    unhealthy: "异常",
    disabled: "已停用",
    unknown: "未知",
  }[value] ?? "未知";
}

function schedulerRunLabel(value) {
  return {
    success: "成功",
    partial: "部分完成",
    running: "运行中",
    failed: "失败",
    skipped: "已跳过",
    waiting: "等待运行",
    idle: "尚未运行",
  }[value] ?? "未知";
}

function toneForStatus(value) {
  if (["healthy", "logged_in", "authenticated", "connected"].includes(value)) return "success";
  if (["degraded", "starting", "waiting_scan", "connecting"].includes(value)) return "warning";
  if (["unhealthy", "error", "expired", "offline"].includes(value)) return "danger";
  return "neutral";
}

function StatusMark({ status, children }) {
  const tone = toneForStatus(status);
  return (
    <span className={`settings-status-value ${tone}`}>
      {tone === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
      {tone === "danger" ? <CircleAlert size={15} aria-hidden="true" /> : null}
      {tone === "warning" ? <LoaderCircle size={15} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function SystemSettingsPage({ apiClient, backendStatus, section = "security" }) {
  const [settings, setSettings] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [pushplusToken, setPushplusToken] = useState("");
  const [integrationStatus, setIntegrationStatus] = useState({
    loading: true,
    error: "",
    weixin: null,
    hospitalHealth: null,
    scheduler: null,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadSettings() {
    if (section === "tender-schedule") {
      setLoading(false);
      return;
    }
    if (!apiClient?.isEnabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSettings(await apiClient.getSecuritySettings());
      setError("");
    } catch {
      setError("系统配置暂时无法加载，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [apiClient, backendStatus, section]);

  useEffect(() => {
    let disposed = false;
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setIntegrationStatus({ loading: false, error: "", weixin: null, hospitalHealth: null, scheduler: null });
      return () => {
        disposed = true;
      };
    }

    setIntegrationStatus((current) => ({ ...current, loading: true, error: "" }));
    const read = async (method, normalize = (value) => value) => {
      if (typeof apiClient[method] !== "function") return null;
      try {
        return normalize(await apiClient[method]());
      } catch {
        return null;
      }
    };
    void Promise.all([
      read("getWeixinBindingStatus", (value) => value ? {
        status: value.status,
        message: value.message,
        updatedAt: value.updatedAt,
      } : null),
      read("getHospitalTenderHealth", (value) => value ? {
        status: value.status,
        sourceCount: value.sourceCount,
        staleCount: value.staleCount,
        latestRun: value.latestRun,
      } : null),
      read("getHospitalTenderScheduler", (value) => {
        const item = value?.item ?? value;
        return item ? {
          item: {
            enabled: item.enabled,
            intervalMinutes: item.intervalMinutes,
            batchSize: item.batchSize,
            lastStatus: item.lastStatus,
            cycleNumber: item.cycleNumber,
            cycleProcessedCount: item.cycleProcessedCount,
            cycleCustomerCount: item.cycleCustomerCount,
            lastBatchCount: item.lastBatchCount,
            lastAcceptedCount: item.lastAcceptedCount,
            lastRejectedCount: item.lastRejectedCount,
            lastStartedAt: item.lastStartedAt,
            lastFinishedAt: item.lastFinishedAt,
            nextRunAt: item.nextRunAt,
            lastError: item.lastError,
          },
          runs: Array.isArray(value?.runs) ? value.runs.slice(0, 6).map((run) => ({
            id: run.id,
            status: run.status,
            cycleNumber: run.cycleNumber,
            batchCount: run.batchCount,
            acceptedCount: run.acceptedCount,
            rejectedCount: run.rejectedCount,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          })) : [],
          notification: value?.notification ? {
            status: value.notification.status,
            lastSuccessAt: value.notification.lastSuccessAt,
            lastFailureAt: value.notification.lastFailureAt,
          } : null,
        } : null;
      }),
    ]).then(([weixin, hospitalHealth, scheduler]) => {
      if (disposed) return;
      const failed = weixin === null && hospitalHealth === null && scheduler === null;
      setIntegrationStatus({
        loading: false,
        error: failed ? "运行状态暂时无法读取。" : "",
        weixin,
        hospitalHealth,
        scheduler,
      });
    });
    return () => {
      disposed = true;
    };
  }, [apiClient, backendStatus, section]);

  async function saveApiKey(event) {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError("请输入 DeepSeek API Key。");
      return;
    }
    setBusy("deepseek");
    setNotice("");
    try {
      const result = await apiClient.saveDeepSeekApiKey(apiKey);
      setApiKey("");
      setSettings((current) => ({ ...(current ?? {}), deepseek: result }));
      setNotice("DeepSeek API Key 已安全保存，页面不会再次显示明文。");
      setError("");
    } catch {
      setError("DeepSeek API Key 保存失败，请检查输入后重试。");
    } finally {
      setBusy("");
    }
  }

  async function clearApiKey() {
    const confirmed = typeof window !== "undefined"
      && window.confirm("确定清除 DeepSeek API Key 吗？清除后运行时将不再调用已保存的密钥。");
    if (!confirmed) return;
    setBusy("clear-deepseek");
    setNotice("");
    try {
      const result = await apiClient.clearDeepSeekApiKey();
      setSettings((current) => ({ ...(current ?? {}), deepseek: result }));
      setNotice("DeepSeek API Key 已清除。");
      setError("");
    } catch {
      setError("DeepSeek API Key 清除失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function savePushplusToken(event) {
    event.preventDefault();
    if (!pushplusToken.trim()) {
      setError("请输入 PushPlus Token。");
      return;
    }
    setBusy("pushplus");
    setNotice("");
    try {
      const result = await apiClient.savePushplusToken(pushplusToken);
      setPushplusToken("");
      setSettings((current) => ({ ...(current ?? {}), pushplus: result }));
      setNotice("PushPlus Token 已加密保存，页面不会再次显示明文。");
      setError("");
    } catch {
      setError("PushPlus Token 保存失败，请检查输入后重试。");
    } finally {
      setBusy("");
    }
  }

  async function clearPushplusToken() {
    const confirmed = typeof window !== "undefined"
      && window.confirm("确定清除 PushPlus Token 吗？清除后医院招标监测将停止发送通知。");
    if (!confirmed) return;
    setBusy("clear-pushplus");
    setNotice("");
    try {
      const result = await apiClient.clearPushplusToken();
      setSettings((current) => ({ ...(current ?? {}), pushplus: result }));
      setNotice("PushPlus Token 已清除，医院招标通知已停用。");
      setError("");
    } catch {
      setError("PushPlus Token 清除失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function testPushplusToken() {
    setBusy("test-pushplus");
    setNotice("");
    try {
      const result = await apiClient.testPushplusToken();
      setSettings((current) => ({
        ...(current ?? {}),
        pushplus: {
          ...(current?.pushplus ?? {}),
          lastSuccessAt: result.testedAt,
          lastFailureAt: null,
          lastErrorCode: null,
          lastDeliveryCount: result.notificationCount,
          lastChunkCount: 1,
        },
      }));
      setNotice("测试通知已发送，请在 PushPlus 中确认收到。");
      setError("");
    } catch {
      setError("PushPlus 测试通知失败，请检查 Token 或稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function refreshScheduler() {
    if (typeof apiClient?.getHospitalTenderScheduler !== "function") return null;
    const result = await apiClient.getHospitalTenderScheduler();
    setIntegrationStatus((current) => ({ ...current, scheduler: result, error: "" }));
    return result;
  }

  async function toggleSchedulerEnabled() {
    const schedulerState = integrationStatus.scheduler?.item ?? integrationStatus.scheduler ?? null;
    if (!schedulerState || typeof apiClient?.updateHospitalTenderScheduler !== "function") return;
    setBusy("scheduler-toggle");
    setNotice("");
    try {
      const result = await apiClient.updateHospitalTenderScheduler({ enabled: !schedulerState.enabled });
      setIntegrationStatus((current) => ({ ...current, scheduler: result, error: "" }));
      setNotice(result?.item?.enabled ? "医院招标自动轮巡已启用。" : "医院招标自动轮巡已停用。");
      setError("");
    } catch {
      setError("招标轮巡状态更新失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function runSchedulerNow() {
    if (typeof apiClient?.runHospitalTenderScheduler !== "function") return;
    setBusy("scheduler-run");
    setNotice("");
    try {
      const result = await apiClient.runHospitalTenderScheduler();
      await refreshScheduler();
      const accepted = Number(result?.acceptedCount ?? result?.state?.lastAcceptedCount ?? 0);
      const rejected = Number(result?.rejectedCount ?? result?.state?.lastRejectedCount ?? 0);
      setNotice(`本批检测已完成：入库 ${accepted} 条，异常 ${rejected} 条。`);
      setError("");
    } catch {
      setError("当前批次未能完成，请查看最近运行记录后重试。");
    } finally {
      setBusy("");
    }
  }

  const deepseek = settings?.deepseek;
  const pushplus = settings?.pushplus;
  const pushplusSourceLabel = pushplus?.source === "environment"
    ? "部署环境"
    : pushplus?.source === "settings" ? "加密配置" : "—";
  const schedulerState = integrationStatus.scheduler?.item ?? integrationStatus.scheduler ?? null;
  const schedulerRuns = Array.isArray(integrationStatus.scheduler?.runs)
    ? integrationStatus.scheduler.runs
    : [];
  const hospitalHealth = integrationStatus.hospitalHealth;
  const weixin = integrationStatus.weixin;
  const schedulerStatus = !schedulerState
    ? undefined
    : schedulerState.lastStatus === "failed"
      ? "error"
      : schedulerState.enabled ? "connected" : "offline";
  const integrationMeta = integrationStatus.loading
    ? "读取中"
    : integrationStatus.error ? "暂不可用" : "只读状态";
  const sectionMeta = {
    security: {
      eyebrow: "安全与 AI",
      title: "安全与 AI 配置",
      description: "配置服务端 AI 能力。密钥仅加密保存，浏览器不会再次读取明文。",
      icon: ShieldCheck,
    },
    notifications: {
      eyebrow: "通知服务",
      title: "PushPlus 通知",
      description: "管理医院招标高相关公告通知，并发送不含客户数据的测试消息。",
      icon: BellRing,
    },
    "tender-schedule": {
      eyebrow: "招标调度",
      title: "医院招标自动轮巡",
      description: "查看固定的每小时、每批 10 家客户轮巡状态，并控制启停或立即运行下一批。",
      icon: CalendarClock,
    },
  }[section] ?? null;
  const SectionIcon = sectionMeta?.icon ?? ShieldCheck;

  const processedCount = Number(schedulerState?.cycleProcessedCount) || 0;
  const customerCount = Number(schedulerState?.cycleCustomerCount) || 0;
  const progressPercent = customerCount > 0
    ? Math.min(100, Math.round((processedCount / customerCount) * 100))
    : 0;

  return (
    <div className="system-settings-page" data-testid="system-settings-page" data-section={section}>
      <div className="settings-intro">
        <div>
          <span className="eyebrow">{sectionMeta?.eyebrow ?? "系统配置"}</span>
          <h2>{sectionMeta?.title ?? "系统配置"}</h2>
          <p>{sectionMeta?.description ?? "管理系统安全配置与服务连接。"}</p>
        </div>
        <SectionIcon size={30} aria-hidden="true" />
      </div>

      {error ? <p className="settings-feedback error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-feedback" role="status">{notice}</p> : null}

      {loading ? (
        <section className="settings-loading" role="status">正在加载系统配置…</section>
      ) : null}

      {!loading && section === "security" ? (
        <section className="settings-focused-section" data-testid="settings-security-section">
          <div className="settings-grid settings-grid-focused">
            <Panel title="DeepSeek API Key" meta={statusLabel(deepseek?.status)} className="settings-card">
              <div className="settings-card-icon deepseek"><KeyRound size={20} /></div>
              <p className="settings-description">用于服务端 AI 分析。保存后只显示掩码和更新时间，不能从页面取回明文。</p>
              <dl className="settings-facts">
                <div><dt>状态</dt><dd><CheckCircle2 size={15} /> {statusLabel(deepseek?.status)}</dd></div>
                <div><dt>来源</dt><dd>{sourceLabel(deepseek?.source)}</dd></div>
                <div><dt>当前掩码</dt><dd>{deepseek?.masked ?? "未配置"}</dd></div>
                <div><dt>更新时间</dt><dd>{formatDate(deepseek?.updatedAt)}</dd></div>
              </dl>
              <form className="settings-key-form" onSubmit={saveApiKey}>
                <label>
                  <span>{deepseek?.configured ? "替换 API Key" : "设置 API Key"}</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="new-password"
                    placeholder="仅在此处输入，不会写入浏览器存储"
                    aria-label="DeepSeek API Key"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <KeyRound size={16} /> {busy === "deepseek" ? "保存中…" : "安全保存"}
                  </button>
                  {deepseek?.configured ? (
                    <button className="danger-button" type="button" onClick={clearApiKey} disabled={busy !== ""}>
                      <Trash2 size={16} /> {busy === "clear-deepseek" ? "清除中…" : "清除"}
                    </button>
                  ) : null}
                </div>
              </form>
            </Panel>

            <Panel title="安全连接状态" meta={backendStatus === "connected" ? "已连接" : "需检查"} className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>服务连接</strong>
                    <span>认证、业务接口与加密设置</span>
                  </div>
                  <StatusMark status={backendStatus}>
                    {backendStatus === "connected" ? "已连接" : backendStatus === "connecting" ? "连接中" : "未连接"}
                  </StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>配置保护</strong>
                    <span>只保存掩码、来源与更新时间</span>
                  </div>
                  <StatusMark status="connected">服务端加密</StatusMark>
                </div>
              </div>
              <p className="settings-inline-note">浏览器、普通业务接口和审计记录都不会返回密钥明文。</p>
            </Panel>
          </div>
        </section>
      ) : null}

      {!loading && section === "notifications" ? (
        <section className="settings-focused-section" data-testid="settings-notifications-section">
          <div className="settings-grid settings-grid-focused">
            <Panel title="PushPlus 通知 Token" meta={statusLabel(pushplus?.status)} className="settings-card">
              <div className="settings-card-icon pushplus"><BellRing size={20} /></div>
              <p className="settings-description">用于医院招标监测的高相关公告通知。Token 只在服务端使用，测试通知不会带客户数据。</p>
              <dl className="settings-facts">
                <div><dt>状态</dt><dd><CheckCircle2 size={15} /> {statusLabel(pushplus?.status)}</dd></div>
                <div><dt>来源</dt><dd>{pushplusSourceLabel}</dd></div>
                <div><dt>当前掩码</dt><dd>{pushplus?.masked ?? "未配置"}</dd></div>
                <div><dt>最近成功</dt><dd>{formatDate(pushplus?.lastSuccessAt)}</dd></div>
                <div><dt>最近失败</dt><dd>{formatDate(pushplus?.lastFailureAt)}</dd></div>
                {pushplus?.lastErrorCode ? <div><dt>失败原因</dt><dd>{pushplus.lastErrorCode}</dd></div> : null}
                {pushplus?.lastDeliveryCount !== null && pushplus?.lastDeliveryCount !== undefined ? (
                  <div><dt>最近发送</dt><dd>{pushplus.lastDeliveryCount} 条 / {pushplus.lastChunkCount ?? 0} 片</dd></div>
                ) : null}
              </dl>
              {pushplus?.source === "environment" ? (
                <p className="settings-inline-note">当前 Token 来自部署环境；在此保存后会切换为加密配置。</p>
              ) : pushplus?.fallbackSuppressed ? (
                <p className="settings-inline-note">已显式清除当前 Token，部署环境中的同名回退也已停用。</p>
              ) : null}
              <form className="settings-key-form" onSubmit={savePushplusToken}>
                <label>
                  <span>{pushplus?.configured ? "替换 PushPlus Token" : "设置 PushPlus Token"}</span>
                  <input
                    type="password"
                    value={pushplusToken}
                    onChange={(event) => setPushplusToken(event.target.value)}
                    autoComplete="new-password"
                    placeholder="仅在此处输入，不会写入浏览器存储"
                    aria-label="PushPlus Token"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <KeyRound size={16} /> {busy === "pushplus" ? "保存中…" : "安全保存"}
                  </button>
                  {pushplus?.configured ? (
                    <>
                      <button className="ghost-button" type="button" onClick={testPushplusToken} disabled={busy !== ""}>
                        <Send size={16} /> {busy === "test-pushplus" ? "发送中…" : "发送测试通知"}
                      </button>
                      <button className="danger-button" type="button" onClick={clearPushplusToken} disabled={busy !== ""}>
                        <Trash2 size={16} /> {busy === "clear-pushplus" ? "清除中…" : "清除"}
                      </button>
                    </>
                  ) : null}
                </div>
              </form>
            </Panel>

            <Panel title="通知运行状态" meta={integrationMeta} className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>PushPlus 通道</strong>
                    <span>高相关新增公告按批次聚合发送</span>
                  </div>
                  <StatusMark status={pushplus?.configured ? "connected" : "offline"}>
                    {pushplus?.configured ? "已配置" : "未配置"}
                  </StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>最近投递</strong>
                    <span>失败后保留批次，由下一次运行重试</span>
                  </div>
                  <StatusMark status={pushplus?.lastFailureAt ? "error" : pushplus?.lastSuccessAt ? "connected" : undefined}>
                    {pushplus?.lastFailureAt ? "需检查" : pushplus?.lastSuccessAt ? "已送达" : "暂无记录"}
                  </StatusMark>
                </div>
              </div>
              <p className="settings-inline-note">测试通知只验证通道，不包含客户名称、公告正文或业务原始数据。</p>
            </Panel>
          </div>
        </section>
      ) : null}

      {!loading && section === "tender-schedule" ? (
        <section className="settings-focused-section" data-testid="settings-tender-schedule-section">
          <div className="settings-grid settings-grid-focused settings-scheduler-grid">
            <Panel title="轮巡状态" meta={schedulerState?.enabled ? "已启用" : "已停用"} className="settings-card settings-status-card">
              <div className="settings-status-list">
                <div className="settings-status-item">
                  <div>
                    <strong>公开来源健康</strong>
                    <span>{hospitalHealth ? `${hospitalHealth.sourceCount ?? 0} 个来源 · ${hospitalHealth.staleCount ?? 0} 个需关注` : "尚未读取来源状态"}</span>
                  </div>
                  <StatusMark status={hospitalHealth?.status}>
                    {hospitalHealth ? hospitalHealthLabel(hospitalHealth.status) : "未读取"}
                  </StatusMark>
                </div>
                <div className="settings-status-item">
                  <div>
                    <strong>自动轮巡</strong>
                    <span>固定每 {schedulerState?.intervalMinutes ?? 60} 分钟 · 每批 {schedulerState?.batchSize ?? 10} 家客户</span>
                  </div>
                  <StatusMark status={schedulerStatus}>
                    {schedulerState ? schedulerRunLabel(schedulerState.lastStatus) : "未读取"}
                  </StatusMark>
                </div>
              </div>

              <div className="settings-scheduler-progress">
                <div>
                  <span>第 {schedulerState?.cycleNumber ?? "—"} 轮</span>
                  <strong>{customerCount > 0 ? `${processedCount} / ${customerCount} 家` : "等待新一轮客户快照"}</strong>
                </div>
                <progress value={customerCount > 0 ? progressPercent : undefined} max="100" aria-label="医院招标轮巡进度">
                  {customerCount > 0 ? `${progressPercent}%` : "等待运行"}
                </progress>
              </div>

              <dl className="settings-facts settings-scheduler-facts">
                <div><dt>最近开始</dt><dd>{formatDate(schedulerState?.lastStartedAt)}</dd></div>
                <div><dt>最近完成</dt><dd>{formatDate(schedulerState?.lastFinishedAt)}</dd></div>
                <div><dt>下次运行</dt><dd>{schedulerState?.enabled ? formatDate(schedulerState?.nextRunAt) : "已停用"}</dd></div>
                <div><dt>最近批次</dt><dd>{schedulerState?.lastBatchCount ?? 0} 家客户</dd></div>
                <div><dt>公告入库</dt><dd>{schedulerState?.lastAcceptedCount ?? 0} 条</dd></div>
                <div><dt>异常记录</dt><dd>{schedulerState?.lastRejectedCount ?? 0} 条</dd></div>
              </dl>
              {schedulerState?.lastError ? <p className="settings-feedback error" role="alert">{schedulerState.lastError}</p> : null}
            </Panel>

            <Panel title="运行控制" meta="固定策略" className="settings-card settings-scheduler-form">
              <div className="settings-schedule-policy">
                <CalendarClock size={22} aria-hidden="true" />
                <div>
                  <strong>每小时处理下一批 10 家客户</strong>
                  <p>系统按稳定客户序号循环，成功后才推进游标；本页面不开放任意间隔或批量修改。</p>
                </div>
              </div>
              <div className="settings-button-row settings-scheduler-actions">
                <button
                  className={schedulerState?.enabled ? "ghost-button" : "primary-button"}
                  type="button"
                  onClick={() => { void toggleSchedulerEnabled(); }}
                  disabled={!schedulerState || busy !== "" || backendStatus !== "connected"}
                >
                  <Power size={16} />
                  {busy === "scheduler-toggle" ? "更新中…" : schedulerState?.enabled ? "停用自动轮巡" : "启用自动轮巡"}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => { void runSchedulerNow(); }}
                  disabled={busy !== "" || backendStatus !== "connected" || schedulerState?.lastStatus === "running"}
                >
                  {busy === "scheduler-run" ? <LoaderCircle className="state-spinner" size={16} /> : <Play size={16} />}
                  {busy === "scheduler-run" ? "检测进行中" : "立即检测下一批"}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => { void refreshScheduler(); }}
                  disabled={busy !== "" || backendStatus !== "connected"}
                >
                  <RefreshCw size={16} /> 刷新状态
                </button>
              </div>
              <p className="settings-inline-note"><Clock3 size={14} aria-hidden="true" />服务重启后会从已保存的轮次、快照和客户游标继续，不会自动跳过失败批次。</p>
            </Panel>

            <Panel title="最近运行记录" meta={`${schedulerRuns.length} 条`} className="settings-card settings-scheduler-runs">
              {schedulerRuns.length ? (
                <div className="settings-run-list">
                  {schedulerRuns.map((run, index) => (
                    <div className="settings-run-item" key={run.id ?? `${run.startedAt ?? "run"}-${index}`}>
                      <span className={`settings-run-dot ${run.status ?? "unknown"}`} aria-hidden="true" />
                      <div>
                        <strong>第 {run.cycleNumber ?? "—"} 轮 · {schedulerRunLabel(run.status)}</strong>
                        <small>{formatDate(run.finishedAt ?? run.startedAt)}</small>
                      </div>
                      <span>{run.batchCount ?? 0} 家 · 入库 {run.acceptedCount ?? 0} · 异常 {run.rejectedCount ?? 0}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="settings-empty-state">暂无运行记录，启用自动轮巡或立即检测下一批后会在此显示。</p>
              )}
            </Panel>
          </div>
          {integrationStatus.error ? <p className="settings-inline-note" role="status">{integrationStatus.error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
