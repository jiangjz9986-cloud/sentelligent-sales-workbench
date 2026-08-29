import {
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createSalesWorkbenchApi,
  resolveApiBaseUrl,
} from "./api/salesWorkbenchApi.js";
import {
  clearLegacyAuthSession,
  createDisplaySession,
} from "./sessionAuth.js";
import { SalesWorkbenchShell } from "./app/SalesWorkbenchShell.jsx";

function getBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function LoginScreen({ apiClient, onLogin }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const normalizedAccount = account.trim();
    if (!normalizedAccount || !password) {
      setError("请填写账号和密码");
      return;
    }
    if (!apiClient?.isEnabled) {
      setError("服务未连接，暂不能登录");
      return;
    }

    setIsSubmitting(true);
    try {
      const authenticated = await apiClient.login({
        account: normalizedAccount,
        password,
      });
      setError("");
      onLogin(createDisplaySession(authenticated));
    } catch (loginError) {
      setError(loginError?.status === 401 ? "账号或密码错误" : "登录失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="app-shell login-shell">
      <div className="login-window">
        <section className="login-brand-panel" aria-label="森特智行">
          <img className="login-logo" src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
          <div className="login-brand-copy">
            <span className="eyebrow">AI 销售作战台</span>
            <h1>登录工作台</h1>
          </div>
          <div className="login-signal-grid" aria-hidden="true">
            <span className="login-signal active">客户</span>
            <span className="login-signal">商机</span>
            <span className="login-signal">周报</span>
          </div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card-head">
            <span className="login-lock">
              <ShieldCheck size={24} />
            </span>
            <div>
              <span className="eyebrow">安全登录</span>
              <h2 id="login-title">进入系统</h2>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <label className="login-field">
              <span>账号</span>
              <div className="login-input">
                <UserRound size={18} />
                <input
                  aria-label="账号"
                  autoComplete="username"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="请输入账号"
                />
              </div>
            </label>

            <label className="login-field">
              <span>密码</span>
              <div className="login-input password-input">
                <LockKeyhole size={18} />
                <input
                  aria-label="密码"
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入密码"
                />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>

            {error ? <p className="login-error" role="alert">{error}</p> : null}

            <button className="primary-button login-submit" type="submit" data-testid="login-submit" disabled={isSubmitting}>
              <LogIn size={18} />
              {isSubmitting ? "登录中" : "登录"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function AuthCheckingScreen() {
  return (
    <main className="app-shell login-shell" data-testid="auth-checking">
      <div className="login-window">
        <section className="login-brand-panel" aria-label="森特智行">
          <img className="login-logo" src="/sent-zhixing-transparent-logo.png" alt="森特智行" />
          <div className="login-brand-copy">
            <span className="eyebrow">AI 销售作战台</span>
            <h1>销售工作台</h1>
          </div>
        </section>
        <section className="login-card" aria-live="polite" role="status">
          <div className="login-card-head">
            <span className="login-lock">
              <ShieldCheck size={24} />
            </span>
            <div>
              <span className="eyebrow">安全登录</span>
              <h2>正在验证登录状态</h2>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export function App() {
  const [authPhase, setAuthPhase] = useState("checking");
  const [authSession, setAuthSession] = useState(null);
  const apiBaseUrl = resolveApiBaseUrl(import.meta.env);
  const apiClient = useMemo(
    () => createSalesWorkbenchApi({
      baseUrl: apiBaseUrl,
      onUnauthorized: () => {
        setAuthSession(null);
        setAuthPhase("anonymous");
      },
    }),
    [apiBaseUrl],
  );

  useEffect(() => {
    clearLegacyAuthSession(getBrowserStorage());
    if (!apiClient.isEnabled) {
      setAuthPhase("anonymous");
      return undefined;
    }

    let cancelled = false;
    apiClient
      .restoreSession()
      .then((session) => {
        if (cancelled) return;
        setAuthSession(createDisplaySession(session));
        setAuthPhase("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        apiClient.setSession(null);
        setAuthSession(null);
        setAuthPhase("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  function handleLogin(session) {
    setAuthSession(createDisplaySession(session));
    setAuthPhase("authenticated");
  }

  async function handleLogout() {
    try {
      await apiClient.logout();
    } catch {
      // Local session state must still be cleared when the network is unavailable.
    } finally {
      apiClient.setSession(null);
      setAuthSession(null);
      setAuthPhase("anonymous");
    }
  }

  if (authPhase === "checking") {
    return <AuthCheckingScreen />;
  }

  if (authPhase !== "authenticated" || !authSession) {
    return <LoginScreen apiClient={apiClient} onLogin={handleLogin} />;
  }

  return <SalesWorkbenchShell apiClient={apiClient} authSession={authSession} onLogout={handleLogout} />;
}
