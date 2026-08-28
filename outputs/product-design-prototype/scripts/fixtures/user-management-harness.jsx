import { createRoot } from "react-dom/client";

import { UserManagementPage } from "../../src/features/settings/UserManagementPage.jsx";
import "../../src/styles/global.css";

// 内存用户表桩：契约与 /api/admin/users 端点一致（乐观锁 + 错误码），
// 让浏览器走查覆盖 建号→列表→编辑→停用→启用 全链 DOM 行为。
const users = new Map([
  ["jiangjz", {
    account: "jiangjz",
    displayName: "继振",
    role: "admin",
    status: "active",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    lastLoginAt: "2026-08-29T01:00:00.000Z",
    version: 1,
  }],
]);

function apiError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

window.__userWrites = [];

const apiClient = {
  isEnabled: true,
  async listUsers() {
    return [...users.values()]
      .map((user) => ({ ...user }))
      .sort((left, right) => left.account.localeCompare(right.account, "en"));
  },
  async createUser(payload) {
    window.__userWrites.push({ kind: "create", payload });
    if (users.has(payload.account)) throw apiError("USER_EXISTS", 409);
    const now = new Date().toISOString();
    const item = {
      account: payload.account,
      displayName: payload.displayName,
      role: payload.role ?? "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      version: 1,
    };
    users.set(item.account, item);
    return { ...item };
  },
  async updateUser(account, payload) {
    window.__userWrites.push({ kind: "update", account, payload });
    const current = users.get(account);
    if (!current) throw apiError("USER_NOT_FOUND", 404);
    if (payload.expectedVersion !== current.version) throw apiError("VERSION_CONFLICT", 409);
    if (account === "jiangjz" && payload.status === "disabled") throw apiError("SELF_DISABLE_FORBIDDEN", 409);
    const next = {
      ...current,
      ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
      ...(payload.role !== undefined ? { role: payload.role } : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    users.set(account, next);
    return { ...next };
  },
};

createRoot(document.querySelector("#root")).render(
  <UserManagementPage
    apiClient={apiClient}
    backendStatus="connected"
    authSession={{ account: "jiangjz", displayName: "继振", role: "admin" }}
  />,
);
