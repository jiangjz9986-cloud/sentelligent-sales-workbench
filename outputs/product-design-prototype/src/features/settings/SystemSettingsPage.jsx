import { CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
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

export function SystemSettingsPage({ apiClient, backendStatus }) {
  const [settings, setSettings] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState("");
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

  const icost = settings?.icost;
  const deepseek = settings?.deepseek;

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
        </div>
      )}
    </div>
  );
}
