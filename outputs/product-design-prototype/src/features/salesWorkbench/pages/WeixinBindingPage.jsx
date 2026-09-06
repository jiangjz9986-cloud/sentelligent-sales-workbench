import {
  Bot,
  Check,
  CircleStop,
  Link2,
  QrCode,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Panel } from "../../../components/primitives.jsx";

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
