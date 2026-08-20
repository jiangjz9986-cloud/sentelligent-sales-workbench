import {
  BellRing,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
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

export function SystemSettingsPage({ apiClient, backendStatus }) {
  const [settings, setSettings] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [pushplusToken, setPushplusToken] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState("");
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
  }, [apiClient, backendStatus]);

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
          },
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
  }, [apiClient, backendStatus]);

  async function rotateIcost() {
    setBusy("icost");
    setNotice("");
    try {
      const result = await apiClient.rotateIcostToken();
      setOneTimeToken(result.token ?? "");
      const { token: _oneTimeToken, ...metadata } = result;
      setSettings((current) => ({ ...(current ?? {}), icost: metadata }));
      setNotice("新令牌只会在本次成功响应中显示；关闭提示后仅保留掩码。");
    } catch {
      setError("记账令牌生成失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

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

  const icost = settings?.icost;
  const deepseek = settings?.deepseek;
  const pushplus = settings?.pushplus;
  const pushplusSourceLabel = pushplus?.source === "environment"
    ? "部署环境"
    : pushplus?.source === "settings" ? "加密配置" : "—";
  const schedulerState = integrationStatus.scheduler?.item ?? integrationStatus.scheduler ?? null;
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

  return (
    <div className="system-settings-page" data-testid="system-settings-page">
      <div className="settings-intro">
        <div>
          <span className="eyebrow">安全与连接</span>
          <h2>系统配置</h2>
          <p>密钥由服务端加密保存。浏览器、审计记录和普通业务接口都不会读取明文。</p>
        </div>
        <ShieldCheck size={30} aria-hidden="true" />
      </div>

      {error ? <p className="settings-feedback error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-feedback" role="status">{notice}</p> : null}

      {loading ? (
        <section className="settings-loading" role="status">正在加载安全配置…</section>
      ) : (
        <div className="settings-grid">
          <Panel title="iCost 记账令牌" meta={statusLabel(icost?.status)} className="settings-card">
            <div className="settings-card-icon icost"><RefreshCw size={20} /></div>
            <p className="settings-description">供记账快捷指令写入差旅报销。生成或轮换后只显示一次完整令牌。</p>
            <dl className="settings-facts">
              <div><dt>状态</dt><dd><CheckCircle2 size={15} /> {statusLabel(icost?.status)}</dd></div>
              <div><dt>来源</dt><dd>{sourceLabel(icost?.source)}</dd></div>
              <div><dt>当前掩码</dt><dd>{icost?.masked ?? "未配置"}</dd></div>
              <div><dt>创建时间</dt><dd>{formatDate(icost?.createdAt)}</dd></div>
              <div><dt>轮换时间</dt><dd>{formatDate(icost?.rotatedAt)}</dd></div>
            </dl>
            <button className="primary-button" type="button" onClick={rotateIcost} disabled={busy !== ""}>
              <RefreshCw size={16} /> {busy === "icost" ? "生成中…" : icost?.configured ? "轮换令牌" : "生成令牌"}
            </button>
            {oneTimeToken ? (
              <div className="one-time-secret" role="alert">
                <strong>请立即复制并保存</strong>
                <code>{oneTimeToken}</code>
                <button className="ghost-button" type="button" onClick={() => setOneTimeToken("")}>我已保存，隐藏令牌</button>
              </div>
            ) : null}
          </Panel>

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

          <Panel title="服务运行状态" meta={integrationMeta} className="settings-card settings-status-card">
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
                  <strong>微信机器人</strong>
                  <span>绑定状态，不显示机器令牌</span>
                </div>
                <StatusMark status={weixin?.status}>
                  {weixin ? bindingStatusLabel(weixin.status) : "未读取"}
                </StatusMark>
              </div>
              <div className="settings-status-item">
                <div>
                  <strong>医院招标监测</strong>
                  <span>
                    {hospitalHealth
                      ? `${hospitalHealth.sourceCount ?? 0} 个来源 · ${hospitalHealth.staleCount ?? 0} 个需关注`
                      : "来源健康状态未读取"}
                  </span>
                </div>
                <StatusMark status={hospitalHealth?.status}>
                  {hospitalHealth ? hospitalHealthLabel(hospitalHealth.status) : "未读取"}
                </StatusMark>
              </div>
              <div className="settings-status-item">
                <div>
                  <strong>自动轮巡</strong>
                  <span>
                    {schedulerState
                      ? schedulerState.enabled
                        ? `每 ${schedulerState.intervalMinutes ?? "—"} 分钟 · 每批 ${schedulerState.batchSize ?? "—"} 家`
                        : "已停用"
                      : "轮巡状态未读取"}
                  </span>
                </div>
                <StatusMark status={schedulerStatus}>
                  {schedulerState
                    ? schedulerState.lastStatus === "failed"
                      ? "最近失败"
                      : schedulerState.enabled ? "已启用" : "已停用"
                    : "未读取"}
                </StatusMark>
              </div>
            </div>
            {integrationStatus.error ? <p className="settings-inline-note" role="status">{integrationStatus.error}</p> : null}
            <p className="settings-inline-note">这里只读展示运行状态；微信机器令牌、地图 Key、OCR/PDF 工具和记账桥接令牌仍由部署环境或服务端密钥管理。</p>
          </Panel>
        </div>
      )}
    </div>
  );
}
