import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("./UserManagementPage.jsx", import.meta.url);
const appPath = new URL("../../App.jsx", import.meta.url);
const navRoutesPath = new URL("../../app/navRoutes.js", import.meta.url);
const routesPath = new URL("../../app/routes.js", import.meta.url);
const dataPath = new URL("../../data/salesWorkbenchData.js", import.meta.url);

test("user management page renders the roster table with per-row lifecycle actions", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="user-management-page"/);
  assert.match(source, /data-testid="user-table"/);
  for (const column of ["账号", "姓名", "角色", "状态", "最近登录", "操作"]) {
    assert.match(source, new RegExp(column));
  }
  assert.match(source, /data-testid=\{`user-row-\$\{user\.account\}`\}/);
  assert.match(source, /data-testid=\{`user-edit-\$\{user\.account\}`\}/);
  assert.match(source, /data-testid=\{`user-reset-\$\{user\.account\}`\}/);
  assert.match(source, /data-testid=\{`user-toggle-\$\{user\.account\}`\}/);
  assert.match(source, /listUsers\(\)/);
});

test("the create drawer validates account, name, and initial secret before submitting", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="user-create-button"/);
  assert.match(source, /data-testid="user-create-form"/);
  assert.match(source, /\^\[a-z0-9\]\{2,32\}\$/);
  assert.match(source, /账号需为 2–32 位小写字母或数字/);
  assert.match(source, /请填写姓名/);
  assert.match(source, /初始密码至少/);
  assert.match(source, /请线下告知对方，保存后不可再查看/);
  assert.match(source, /createUser\(\{/);
});

test("disable and enable go through window.confirm and block self-disable in the row", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /window\.confirm\(/);
  assert.match(source, /确定停用 \$\{user\.displayName\}/);
  assert.match(source, /其所有已登录会话将立即失效/);
  assert.match(source, /确定重新启用 \$\{user\.displayName\}/);
  assert.match(source, /isSelf && user\.status === "active"/);
  assert.match(source, /title=\{isSelf && user\.status === "active" \? "不能停用自己" : undefined\}/);
});

test("the reset drawer sends the new secret with the row version for optimistic locking", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="user-reset-form"/);
  assert.match(source, /expectedVersion: target\.version/);
  assert.match(source, /其已登录设备将需要重新登录/);
  assert.match(source, /updateUser\(target\.account/);
});

test("error codes map to operator-friendly toasts and conflicts refresh the list", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /已被其他操作更新，已刷新列表/);
  assert.match(source, /至少保留一位启用状态的管理员/);
  assert.match(source, /不能停用自己/);
  assert.match(source, /账号已存在/);
  assert.match(source, /VERSION_CONFLICT/);
  assert.match(source, /LAST_ADMIN_PROTECTED/);
  assert.match(source, /SELF_DISABLE_FORBIDDEN/);
  assert.match(source, /USER_EXISTS/);
  assert.match(source, /reloadList\(\)/);
});

test("the weixin binding panel lists bindings with switches, unbind, and a one-time code drawer (v0.9.3)", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="weixin-binding-panel"/);
  assert.match(source, /data-testid="weixin-binding-table"/);
  for (const column of ["微信标识", "记账能力", "主动推送", "绑定时间"]) {
    assert.match(source, new RegExp(column));
  }
  assert.match(source, /data-testid=\{`user-bindcode-\$\{user\.account\}`\}/);
  assert.match(source, /data-testid=\{`binding-financial-\$\{binding\.account\}`\}/);
  assert.match(source, /data-testid=\{`binding-digest-\$\{binding\.account\}`\}/);
  assert.match(source, /data-testid=\{`binding-unbind-\$\{binding\.account\}`\}/);
  assert.match(source, /listWeixinBindings/);
  assert.match(source, /createWeixinBindingCode\(user\.account\)/);
  assert.match(source, /updateWeixinBinding\(binding\.senderId/);
  assert.match(source, /unbindWeixinBinding\(/);
  // 绑定码一次性展示与开通记账的显式确认。
  assert.match(source, /data-testid="binding-code-drawer"/);
  assert.match(source, /只显示一次/);
  assert.match(source, /10 分钟内有效、只可使用一次/);
  assert.match(source, /开通后该微信可直接写入财务流水/);
  assert.match(source, /未投递的消息会被静默作废/);
  // 错误词表映射。
  assert.match(source, /ACCOUNT_ALREADY_BOUND/);
  assert.match(source, /USER_DISABLED/);
  assert.match(source, /WEIXIN_BINDING_NOT_FOUND/);
  assert.match(source, /该账号已有生效中的微信绑定，请先解绑/);
});

test("members see the admin-required placeholder instead of the roster", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /authSession\?\.role === "admin"/);
  assert.match(source, /需要管理员权限/);
  assert.match(source, /当前账号是成员角色/);
});

test("the page is registered at every navigation layer (v0.7.1 lesson)", async () => {
  const [appSource, navRoutesSource, routesSource, dataSource] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(navRoutesPath, "utf8"),
    readFile(routesPath, "utf8"),
    readFile(dataPath, "utf8"),
  ]);

  assert.match(appSource, /<UserManagementPage[\s\S]*?authSession=\{authSession\}/);
  assert.match(appSource, /active === "settings-users"/);
  assert.match(navRoutesSource, /"settings-users": Object\.freeze\(\{ page: "settings\/users", mode: "index" \}\)/);
  assert.match(navRoutesSource, /"settings\/users": "settings-users"/);
  assert.match(navRoutesSource, /"settings-users": "settings"/);
  assert.match(routesSource, /"settings\/users": Object\.freeze\(\{ active: "settings", defaultMode: "index", readOnly: false \}\)/);
  assert.match(routesSource, /segments\[1\] === "users"/);
  assert.match(dataSource, /\{ id: "settings-users", label: "用户管理", icon: Users \}/);
});

test("the settings subnav is role-filtered so members only see the security entry", async () => {
  const appSource = await readFile(appPath, "utf8");

  assert.match(appSource, /authSession\?\.role === "admin"/);
  assert.match(appSource, /item\.id === "settings"/);
  assert.match(appSource, /安全设置/);
});
