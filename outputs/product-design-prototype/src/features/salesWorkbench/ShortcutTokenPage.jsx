import {
  Check,
  Clipboard,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "../../components/primitives.jsx";

function formatTokenTime(value) {
  if (!value) return "尚未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeTokenItem(item) {
  if (!item || typeof item !== "object") return null;
  const { token: _token, ...metadata } = item;
  return metadata;
}

async function copyText(value) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") throw new Error("当前环境不支持复制，请手动选择 Token");
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand?.("copy");
  input.remove();
  if (!copied) throw new Error("复制失败，请手动选择 Token");
}

export function ShortcutTokenPage({ apiClient, backendStatus, account }) {
  const backendReady = Boolean(apiClient?.isEnabled && backendStatus === "connected");
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState("iPhone 截图记账");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadTokens() {
    if (!backendReady) return;
    setLoading(true);
    setError("");
    try {
      const items = await apiClient.listShortcutTokens();
      setTokens(items.map(safeTokenItem).filter(Boolean));
    } catch (loadError) {
      setError(loadError.message || "读取快捷指令 Token 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOneTimeToken("");
    setNotice("");
    if (backendReady) void loadTokens();
    else setTokens([]);
    // The page is intentionally refreshed only when the authenticated backend
    // connection changes; listShortcutTokens is stable for the current client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, backendReady]);

  async function createToken(event) {
    event.preventDefault();
    if (!backendReady || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await apiClient.createShortcutToken({ label: label.trim() || "iOS 快捷指令" });
      setOneTimeToken(created.token);
      setTokens((current) => [safeTokenItem(created), ...current.filter((item) => item.id !== created.id)]);
      setNotice("Token 已生成。它只会在这里完整显示一次，请立即粘贴到 iPhone 快捷指令。");
    } catch (createError) {
      setError(createError.message || "生成 Token 失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyOneTimeToken() {
    if (!oneTimeToken) return;
    try {
      await copyText(oneTimeToken);
      setNotice("Token 已复制。出于安全原因，刷新页面后不会再次显示完整 Token。");
    } catch (copyError) {
      setError(copyError.message || "复制 Token 失败");
    }
  }

  async function revokeToken(item) {
    if (!backendReady || busy || !item?.id || item.revokedAt) return;
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`撤销「${item.label || "这个快捷指令"}」的 Token？撤销后旧快捷指令会立即停止上传。`);
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const revoked = await apiClient.revokeShortcutToken(item.id);
      setTokens((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...revoked } : entry));
      setOneTimeToken("");
      setNotice("Token 已撤销。若要继续使用，请重新生成并更新快捷指令中的 Token。");
    } catch (revokeError) {
      setError(revokeError.message || "撤销 Token 失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shortcut-token-page" data-testid="shortcut-token-page">
      <Panel title="快捷指令 Token" meta={account ? `当前账号：${account}` : "账号级身份凭据"} className="shortcut-token-panel">
        <div className="shortcut-token-intro">
          <div className="shortcut-token-intro-icon">
            <KeyRound size={22} />
          </div>
          <div>
            <h2>Token 就是唯一身份</h2>
            <p>一个 Token 只绑定一个账号。快捷指令会先验证所属账号，再上传一次截图文字和你选择的账本分类；Token 不会转发给轻氧。</p>
          </div>
        </div>

        <div className="shortcut-token-grid">
          <div className="shortcut-token-main">
            <form className="shortcut-token-create" onSubmit={createToken}>
              <label className="form-field" htmlFor="shortcut-token-label">
                <span>设备 / 用途名称（可选）</span>
                <input
                  id="shortcut-token-label"
                  value={label}
                  maxLength={100}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="例如：iPhone 截图记账"
                  disabled={!backendReady || busy}
                />
              </label>
              <button className="primary-button" type="submit" disabled={!backendReady || busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                生成新 Token
              </button>
            </form>

            {oneTimeToken ? (
              <div className="shortcut-token-secret" role="status" data-testid="shortcut-token-one-time">
                <div className="shortcut-token-secret-head">
                  <strong>请立即复制到快捷指令</strong>
                  <span><ShieldCheck size={15} /> 仅本次显示完整值</span>
                </div>
                <code>{oneTimeToken}</code>
                <button className="ghost-button" type="button" onClick={copyOneTimeToken}>
                  <Clipboard size={16} />
                  复制 Token
                </button>
              </div>
            ) : null}

            {error ? <p className="shortcut-token-error" role="alert">{error}</p> : null}
            {notice ? <p className="shortcut-token-notice" role="status"><Check size={15} />{notice}</p> : null}

            <div className="shortcut-token-list-head">
              <div>
                <h3>已生成的 Token</h3>
                <p>列表只显示前缀和使用时间，不会再次返回完整 Token。</p>
              </div>
              <button className="ghost-button compact-icon" type="button" onClick={() => void loadTokens()} disabled={!backendReady || loading || busy} title="刷新 Token 列表" aria-label="刷新 Token 列表">
                {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              </button>
            </div>

            <div className="shortcut-token-list">
              {loading && tokens.length === 0 ? <p className="shortcut-token-empty">正在读取 Token…</p> : null}
              {!loading && tokens.length === 0 ? <p className="shortcut-token-empty">还没有 Token。先生成一个并粘贴到快捷指令。</p> : null}
              {tokens.map((item) => {
                const revoked = Boolean(item.revokedAt);
                return (
                  <article className={`shortcut-token-row ${revoked ? "revoked" : ""}`} key={item.id}>
                    <div className="shortcut-token-row-main">
                      <div className="shortcut-token-row-title">
                        <KeyRound size={16} />
                        <strong>{item.label || "iOS 快捷指令"}</strong>
                        <span className={`pill ${revoked ? "tone-gray" : "tone-green"}`}>{revoked ? "已撤销" : "可用"}</span>
                      </div>
                      <code>{item.tokenPrefix || "????????"}••••••••</code>
                      <small>创建于 {formatTokenTime(item.createdAt)} · {item.lastUsedAt ? `最后使用 ${formatTokenTime(item.lastUsedAt)}` : "尚未使用"}</small>
                    </div>
                    <button className="ghost-button danger compact-icon" type="button" onClick={() => void revokeToken(item)} disabled={revoked || busy || !backendReady} title="撤销 Token" aria-label={`撤销 ${item.label || "快捷指令 Token"}`}>
                      <Trash2 size={16} />
                    </button>
                  </article>
                );
              })}
            </div>
          </div>

          <aside className="shortcut-token-guide">
            <div className="shortcut-token-guide-head">
              <KeyRound size={18} />
              <strong>使用方法</strong>
            </div>
            <ol>
              <li>在这里生成 Token，并点击复制。</li>
              <li>打开桌面上的「自有截图记账（兼容版V4修复）」快捷指令。</li>
              <li>把 Token 填入“系统配置页生成的快捷指令 Token”参数。</li>
              <li>首次运行会先验证 Token；验证成功后选择分类并提交截图文字。出差报销暂只支持支出，提交后由微信“小小”助手复核，确认后写入森特本地账本。</li>
            </ol>
            <div className="shortcut-token-guide-note">
              <ShieldCheck size={16} />
              <span>Token 泄露或更换手机时，直接撤销旧 Token，再生成一个新的。</span>
            </div>
          </aside>
        </div>
      </Panel>
    </section>
  );
}
