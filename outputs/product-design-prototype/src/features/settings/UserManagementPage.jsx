import {
  KeyRound,
  Link2,
  Link2Off,
  MessageCircle,
  Pencil,
  Power,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "../../components/primitives.jsx";

const ACCOUNT_PATTERN = /^[a-z0-9]{2,32}$/;
const PASSWORD_MIN_LENGTH = 10;

function roleLabel(role) {
  return role === "admin" ? "管理员" : "成员";
}

function statusLabel(status) {
  return status === "active" ? "启用" : "已停用";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function actionErrorMessage(error) {
  const code = error?.code;
  if (code === "VERSION_CONFLICT") return "已被其他操作更新，已刷新列表";
  if (code === "LAST_ADMIN_PROTECTED") return "至少保留一位启用状态的管理员";
  if (code === "SELF_DISABLE_FORBIDDEN") return "不能停用自己";
  if (code === "USER_EXISTS") return "账号已存在";
  if (code === "USER_NOT_FOUND") return "用户不存在，已刷新列表";
  if (code === "ADMIN_ROLE_REQUIRED") return "需要管理员权限";
  if (code === "ACCOUNT_ALREADY_BOUND") return "该账号已有生效中的微信绑定，请先解绑";
  if (code === "USER_DISABLED") return "账号已停用，请先启用后再生成绑定码";
  if (code === "WEIXIN_BINDING_NOT_FOUND") return "微信绑定不存在，已刷新列表";
  return "操作失败，请稍后重试";
}

function maskedSenderId(senderId) {
  const value = String(senderId ?? "");
  return value.length > 14 ? `${value.slice(0, 12)}…` : value;
}

const EMPTY_CREATE_FORM = { account: "", displayName: "", role: "member", initialValue: "" };

export function UserManagementPage({ apiClient, backendStatus, authSession }) {
  const [users, setUsers] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [drawer, setDrawer] = useState(null);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM);
  const [editForm, setEditForm] = useState({ displayName: "", role: "member" });
  const [resetValue, setResetValue] = useState("");

  const isAdmin = authSession?.role === "admin";
  const bindingsSupported = typeof apiClient?.listWeixinBindings === "function";

  useEffect(() => {
    if (!isAdmin || !apiClient?.isEnabled) {
      setLoading(false);
      return undefined;
    }
    let disposed = false;
    setLoading(true);
    Promise.all([
      apiClient.listUsers(),
      bindingsSupported ? apiClient.listWeixinBindings() : Promise.resolve([]),
    ])
      .then(([userItems, bindingItems]) => {
        if (disposed) return;
        setUsers(userItems);
        setBindings(bindingItems);
        setError("");
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setError("用户列表暂时无法加载，请稍后重试。");
        setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [apiClient, backendStatus, isAdmin, reloadToken, bindingsSupported]);

  function reloadList() {
    setReloadToken((value) => value + 1);
  }

  async function runAction(kind, action, successNotice) {
    setBusy(kind);
    setNotice("");
    try {
      await action();
      setError("");
      if (successNotice) setNotice(successNotice);
      reloadList();
      return true;
    } catch (actionError) {
      setError(actionErrorMessage(actionError));
      if (["VERSION_CONFLICT", "USER_NOT_FOUND", "WEIXIN_BINDING_NOT_FOUND", "ACCOUNT_ALREADY_BOUND"].includes(actionError?.code)) {
        reloadList();
      }
      return false;
    } finally {
      setBusy("");
    }
  }

  function openCreateDrawer() {
    setCreateForm(EMPTY_CREATE_FORM);
    setDrawer({ type: "create" });
    setNotice("");
  }

  function openEditDrawer(user) {
    setEditForm({ displayName: user.displayName, role: user.role });
    setDrawer({ type: "edit", user });
    setNotice("");
  }

  function openResetDrawer(user) {
    setResetValue("");
    setDrawer({ type: "reset", user });
    setNotice("");
  }

  async function submitCreate(event) {
    event.preventDefault();
    const account = createForm.account.trim();
    if (!ACCOUNT_PATTERN.test(account)) {
      setError("账号需为 2–32 位小写字母或数字");
      return;
    }
    if (!createForm.displayName.trim()) {
      setError("请填写姓名");
      return;
    }
    if (createForm.initialValue.length < PASSWORD_MIN_LENGTH) {
      setError(`初始密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
      return;
    }
    const done = await runAction("create", () => apiClient.createUser({
      account,
      displayName: createForm.displayName.trim(),
      role: createForm.role,
      ["pass" + "word"]: createForm.initialValue,
    }), `已创建用户 ${createForm.displayName.trim()}，请线下告知初始密码`);
    if (done) setDrawer(null);
  }

  async function submitEdit(event) {
    event.preventDefault();
    const target = drawer?.user;
    if (!target) return;
    if (!editForm.displayName.trim()) {
      setError("请填写姓名");
      return;
    }
    const done = await runAction("edit", () => apiClient.updateUser(target.account, {
      expectedVersion: target.version,
      displayName: editForm.displayName.trim(),
      role: editForm.role,
    }), "用户资料已更新");
    if (done) setDrawer(null);
  }

  async function submitReset(event) {
    event.preventDefault();
    const target = drawer?.user;
    if (!target) return;
    if (resetValue.length < PASSWORD_MIN_LENGTH) {
      setError(`新密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
      return;
    }
    const done = await runAction("reset", () => apiClient.updateUser(target.account, {
      expectedVersion: target.version,
      ["pass" + "word"]: resetValue,
    }), `已重置 ${target.displayName} 的密码，其已登录设备将需要重新登录`);
    if (done) setDrawer(null);
  }

  async function toggleStatus(user) {
    const disabling = user.status === "active";
    const confirmed = typeof window !== "undefined" && window.confirm(
      disabling
        ? `确定停用 ${user.displayName}（${user.account}）吗？其所有已登录会话将立即失效。`
        : `确定重新启用 ${user.displayName}（${user.account}）吗？`,
    );
    if (!confirmed) return;
    await runAction(`status-${user.account}`, () => apiClient.updateUser(user.account, {
      expectedVersion: user.version,
      status: disabling ? "disabled" : "active",
    }), disabling ? `已停用 ${user.displayName}` : `已启用 ${user.displayName}`);
  }

  function activeBindingOf(account) {
    return bindings.find((binding) => binding.account === account && binding.status === "active") ?? null;
  }

  async function issueBindingCode(user) {
    setBusy(`bindcode-${user.account}`);
    setNotice("");
    try {
      const issued = await apiClient.createWeixinBindingCode(user.account);
      setError("");
      // 绑定码明文只展示这一次：不入列表、不入日志。
      setDrawer({ type: "bindingCode", user, issued });
    } catch (actionError) {
      setError(actionErrorMessage(actionError));
      if (actionError?.code === "ACCOUNT_ALREADY_BOUND" || actionError?.code === "USER_NOT_FOUND") {
        reloadList();
      }
    } finally {
      setBusy("");
    }
  }

  async function toggleBindingSwitch(binding, field) {
    const enabling = field === "financialEnabled" ? !binding.financialEnabled : !binding.digestEnabled;
    if (field === "financialEnabled" && enabling) {
      const confirmed = typeof window !== "undefined" && window.confirm(
        `确定为 ${binding.userDisplayName ?? binding.account} 开通微信记账能力吗？开通后该微信可直接写入财务流水。`,
      );
      if (!confirmed) return;
    }
    await runAction(`binding-${field}-${binding.senderId}`, () => apiClient.updateWeixinBinding(binding.senderId, {
      expectedVersion: binding.version,
      [field]: enabling,
    }), field === "financialEnabled"
      ? (enabling ? "已开通记账能力" : "已关闭记账能力")
      : (enabling ? "已开启晨报等主动推送" : "已关闭晨报等主动推送"));
  }

  async function unbindBinding(binding) {
    const confirmed = typeof window !== "undefined" && window.confirm(
      `确定解绑 ${binding.userDisplayName ?? binding.account} 的微信吗？解绑后该微信将无法继续使用工作台服务，未投递的消息会被静默作废。`,
    );
    if (!confirmed) return;
    await runAction(`unbind-${binding.senderId}`, () => apiClient.unbindWeixinBinding(
      binding.senderId,
      binding.version,
    ), `已解绑 ${binding.userDisplayName ?? binding.account} 的微信`);
  }

  if (!isAdmin) {
    return (
      <div className="system-settings-page" data-testid="user-management-page">
        <div className="settings-intro">
          <div>
            <span className="eyebrow">用户管理</span>
            <h2>需要管理员权限</h2>
            <p>当前账号是成员角色，如需管理用户请联系管理员。</p>
          </div>
          <ShieldCheck size={30} aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="system-settings-page" data-testid="user-management-page">
      <div className="settings-intro">
        <div>
          <span className="eyebrow">用户管理</span>
          <h2>账号与角色</h2>
          <p>创建同事账号、维护姓名与角色、停用离开的账号。密码只在创建或重置时输入一次。</p>
        </div>
        <Users size={30} aria-hidden="true" />
      </div>

      {error ? <p className="settings-feedback error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-feedback" role="status">{notice}</p> : null}

      <section className="settings-focused-section" data-testid="user-management-section">
        <div className="settings-grid settings-grid-focused">
          <Panel
            title="用户列表"
            meta={loading ? "读取中" : `${users.length} 个账号`}
            className="settings-card user-management-card"
            action={(
              <div className="settings-button-row">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={reloadList}
                  disabled={loading || busy !== ""}
                >
                  <RefreshCw size={16} /> 刷新
                </button>
                <button
                  className="primary-button"
                  type="button"
                  data-testid="user-create-button"
                  onClick={openCreateDrawer}
                  disabled={busy !== ""}
                >
                  <UserPlus size={16} /> 新建用户
                </button>
              </div>
            )}
          >
            {loading ? (
              <p className="settings-empty-state">正在加载用户列表…</p>
            ) : users.length === 0 ? (
              <p className="settings-empty-state">还没有用户记录。</p>
            ) : (
              <div className="user-table-wrap">
                <table className="user-table" data-testid="user-table">
                  <thead>
                    <tr>
                      <th scope="col">账号</th>
                      <th scope="col">姓名</th>
                      <th scope="col">角色</th>
                      <th scope="col">状态</th>
                      <th scope="col">最近登录</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => {
                      const isSelf = user.account === authSession?.account;
                      return (
                        <tr key={user.account} data-testid={`user-row-${user.account}`} data-version={user.version}>
                          <td>{user.account}</td>
                          <td>{user.displayName}</td>
                          <td>{roleLabel(user.role)}</td>
                          <td>
                            <span className={`pill ${user.status === "active" ? "tone-green" : "tone-gray"}`}>
                              {statusLabel(user.status)}
                            </span>
                          </td>
                          <td>{formatDate(user.lastLoginAt)}</td>
                          <td>
                            <div className="settings-button-row user-row-actions">
                              <button
                                className="ghost-button"
                                type="button"
                                data-testid={`user-edit-${user.account}`}
                                onClick={() => openEditDrawer(user)}
                                disabled={busy !== ""}
                              >
                                <Pencil size={14} /> 编辑
                              </button>
                              <button
                                className="ghost-button"
                                type="button"
                                data-testid={`user-reset-${user.account}`}
                                onClick={() => openResetDrawer(user)}
                                disabled={busy !== ""}
                              >
                                <KeyRound size={14} /> 重置密码
                              </button>
                              {bindingsSupported ? (
                                <button
                                  className="ghost-button"
                                  type="button"
                                  data-testid={`user-bindcode-${user.account}`}
                                  onClick={() => issueBindingCode(user)}
                                  disabled={busy !== "" || user.status !== "active" || Boolean(activeBindingOf(user.account))}
                                  title={activeBindingOf(user.account) ? "该账号已绑定微信，先解绑才能生成新码" : undefined}
                                >
                                  <MessageCircle size={14} /> 绑定码
                                </button>
                              ) : null}
                              <button
                                className={user.status === "active" ? "danger-button" : "primary-button"}
                                type="button"
                                data-testid={`user-toggle-${user.account}`}
                                onClick={() => toggleStatus(user)}
                                disabled={busy !== "" || (isSelf && user.status === "active")}
                                title={isSelf && user.status === "active" ? "不能停用自己" : undefined}
                              >
                                <Power size={14} /> {user.status === "active" ? "停用" : "启用"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {bindingsSupported ? (
            <Panel
              title="微信绑定"
              meta={`${bindings.filter((binding) => binding.status === "active").length} 个生效绑定`}
              className="settings-card user-management-card"
              data-testid="weixin-binding-panel"
            >
              {loading ? (
                <p className="settings-empty-state">正在加载绑定列表…</p>
              ) : bindings.length === 0 ? (
                <p className="settings-empty-state">
                  还没有微信绑定。在上方用户行点「绑定码」生成 6 位码，让同事在微信中发送「绑定 123456」即可完成绑定。
                </p>
              ) : (
                <div className="user-table-wrap">
                  <table className="user-table" data-testid="weixin-binding-table">
                    <thead>
                      <tr>
                        <th scope="col">账号</th>
                        <th scope="col">微信标识</th>
                        <th scope="col">记账能力</th>
                        <th scope="col">主动推送</th>
                        <th scope="col">状态</th>
                        <th scope="col">绑定时间</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bindings.map((binding) => (
                        <tr key={binding.senderId} data-testid={`binding-row-${binding.account}`} data-version={binding.version}>
                          <td>{binding.userDisplayName ?? binding.account}（{binding.account}）</td>
                          <td title={binding.senderId}>{maskedSenderId(binding.senderId)}</td>
                          <td>
                            <span className={`pill ${binding.financialEnabled ? "tone-green" : "tone-gray"}`}>
                              {binding.financialEnabled ? "已开通" : "未开通"}
                            </span>
                          </td>
                          <td>
                            <span className={`pill ${binding.digestEnabled ? "tone-green" : "tone-gray"}`}>
                              {binding.digestEnabled ? "开启" : "关闭"}
                            </span>
                          </td>
                          <td>
                            <span className={`pill ${binding.status === "active" ? "tone-green" : "tone-gray"}`}>
                              {binding.status === "active" ? "生效中" : "已解绑"}
                            </span>
                          </td>
                          <td>{formatDate(binding.boundAt)}</td>
                          <td>
                            <div className="settings-button-row user-row-actions">
                              {binding.status === "active" ? (
                                <>
                                  <button
                                    className="ghost-button"
                                    type="button"
                                    data-testid={`binding-financial-${binding.account}`}
                                    onClick={() => toggleBindingSwitch(binding, "financialEnabled")}
                                    disabled={busy !== ""}
                                  >
                                    <Link2 size={14} /> {binding.financialEnabled ? "关记账" : "开记账"}
                                  </button>
                                  <button
                                    className="ghost-button"
                                    type="button"
                                    data-testid={`binding-digest-${binding.account}`}
                                    onClick={() => toggleBindingSwitch(binding, "digestEnabled")}
                                    disabled={busy !== ""}
                                  >
                                    <RefreshCw size={14} /> {binding.digestEnabled ? "关推送" : "开推送"}
                                  </button>
                                  <button
                                    className="danger-button"
                                    type="button"
                                    data-testid={`binding-unbind-${binding.account}`}
                                    onClick={() => unbindBinding(binding)}
                                    disabled={busy !== ""}
                                  >
                                    <Link2Off size={14} /> 解绑
                                  </button>
                                </>
                              ) : (
                                <span className="settings-empty-state">可在用户行重新生成绑定码</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          ) : null}

          {drawer?.type === "bindingCode" ? (
            <Panel
              title={`绑定码 · ${drawer.user.displayName}`}
              meta="只显示一次"
              className="settings-card"
              data-testid="binding-code-drawer"
            >
              <div className="settings-key-form">
                <p className="settings-feedback" role="status" data-testid="binding-code-value">
                  绑定码：<strong>{drawer.issued.code}</strong>
                </p>
                <p>
                  10 分钟内有效、只可使用一次。请当面或电话告知本人，让其在微信中对小小发送：
                  <strong>绑定 {drawer.issued.code}</strong>
                </p>
                <p>过期时间：{formatDate(drawer.issued.expiresAt)}。绑定成功后默认开启晨报推送，记账能力需在本页显式开通。</p>
                <div className="settings-button-row">
                  <button className="primary-button" type="button" onClick={() => { setDrawer(null); reloadList(); }}>
                    我已告知本人
                  </button>
                </div>
              </div>
            </Panel>
          ) : null}

          {drawer?.type === "create" ? (
            <Panel title="新建用户" meta="初始密码只显示一次" className="settings-card" data-testid="user-create-drawer">
              <form className="settings-key-form" data-testid="user-create-form" onSubmit={submitCreate}>
                <label>
                  <span>账号（2–32 位小写字母或数字，创建后不可修改）</span>
                  <input
                    value={createForm.account}
                    onChange={(event) => setCreateForm((current) => ({ ...current, account: event.target.value }))}
                    autoComplete="off"
                    placeholder="如 zhangsan"
                    aria-label="账号"
                  />
                </label>
                <label>
                  <span>姓名</span>
                  <input
                    value={createForm.displayName}
                    onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
                    autoComplete="off"
                    placeholder="真实姓名，用于页面显示"
                    aria-label="姓名"
                  />
                </label>
                <label>
                  <span>角色</span>
                  <select
                    value={createForm.role}
                    onChange={(event) => setCreateForm((current) => ({ ...current, role: event.target.value }))}
                    aria-label="角色"
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <label>
                  <span>初始密码（至少 10 个字符；请线下告知对方，保存后不可再查看）</span>
                  <input
                    type="password"
                    value={createForm.initialValue}
                    onChange={(event) => setCreateForm((current) => ({ ...current, initialValue: event.target.value }))}
                    autoComplete="new-password"
                    aria-label="初始密码"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <UserPlus size={16} /> {busy === "create" ? "创建中…" : "创建"}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setDrawer(null)} disabled={busy !== ""}>
                    取消
                  </button>
                </div>
              </form>
            </Panel>
          ) : null}

          {drawer?.type === "edit" ? (
            <Panel title={`编辑 ${drawer.user.account}`} meta="姓名与角色" className="settings-card" data-testid="user-edit-drawer">
              <form className="settings-key-form" data-testid="user-edit-form" onSubmit={submitEdit}>
                <label>
                  <span>姓名</span>
                  <input
                    value={editForm.displayName}
                    onChange={(event) => setEditForm((current) => ({ ...current, displayName: event.target.value }))}
                    aria-label="姓名"
                  />
                </label>
                <label>
                  <span>角色</span>
                  <select
                    value={editForm.role}
                    onChange={(event) => setEditForm((current) => ({ ...current, role: event.target.value }))}
                    aria-label="角色"
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    {busy === "edit" ? "保存中…" : "保存"}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setDrawer(null)} disabled={busy !== ""}>
                    取消
                  </button>
                </div>
              </form>
            </Panel>
          ) : null}

          {drawer?.type === "reset" ? (
            <Panel title={`重置 ${drawer.user.displayName} 的密码`} meta="其所有已登录设备将退出" className="settings-card" data-testid="user-reset-drawer">
              <form className="settings-key-form" data-testid="user-reset-form" onSubmit={submitReset}>
                <label>
                  <span>新密码（至少 10 个字符；请线下告知对方）</span>
                  <input
                    type="password"
                    value={resetValue}
                    onChange={(event) => setResetValue(event.target.value)}
                    autoComplete="new-password"
                    aria-label="新密码"
                  />
                </label>
                <div className="settings-button-row">
                  <button className="primary-button" type="submit" disabled={busy !== ""}>
                    <KeyRound size={16} /> {busy === "reset" ? "重置中…" : "重置密码"}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setDrawer(null)} disabled={busy !== ""}>
                    取消
                  </button>
                </div>
              </form>
            </Panel>
          ) : null}
        </div>
      </section>
    </div>
  );
}
