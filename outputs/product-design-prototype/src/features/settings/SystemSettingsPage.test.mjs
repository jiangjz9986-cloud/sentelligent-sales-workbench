import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("./SystemSettingsPage.jsx", import.meta.url);
const shellPath = new URL("../../app/SalesWorkbenchShell.jsx", import.meta.url);
const stylesPath = new URL("../../styles/global.css", import.meta.url);

test("system settings renders one focused child page for each grouped settings route", async () => {
  const [source, shellSource] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(shellPath, "utf8"),
  ]);

  assert.match(source, /section\s*=\s*"security"/);
  assert.match(source, /section\s*===\s*"security"/);
  assert.match(source, /section\s*===\s*"notifications"/);
  assert.match(source, /section\s*===\s*"tender-schedule"/);
  assert.match(source, /section\s*===\s*"bookkeeping-log"/);
  assert.match(source, /data-testid="settings-security-section"/);
  assert.match(source, /data-testid="settings-notifications-section"/);
  assert.match(source, /data-testid="settings-tender-schedule-section"/);
  assert.match(source, /data-testid="settings-bookkeeping-log-section"/);
  assert.match(shellSource, /<SystemSettingsPage[\s\S]*?section=\{settingsSection\}/);
});

test("notification settings show the bookkeeping, tender PushPlus, and in-app channel split", async () => {
  const [source, styles] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  const notificationSection = source.match(
    /\{!loading && section === "notifications"[\s\S]*?(?=\{!loading && section === "tender-schedule")/u,
  )?.[0] ?? "";

  assert.notEqual(notificationSection, "");
  assert.match(source, /\["notifications", "tender-schedule", "bookkeeping-log", "bookkeeping-categories"\]\.includes\(section\)/);
  assert.match(source, /readsNotifications \? read\("getWeixinBindingStatus"/);
  assert.match(source, /readsNotifications \|\| readsTenderSchedule \? read\("getHospitalTenderHealth"/);
  assert.match(notificationSection, /data-notification-mode="admin-configurable"/);
  assert.match(notificationSection, /渠道职责与状态/);
  assert.match(notificationSection, /meta="运行状态"/);
  assert.match(notificationSection, /meta="服务端管理"/);
  assert.match(notificationSection, /微信 Clawbot（仅记账）/);
  assert.match(notificationSection, /微信 Clawbot（仅记账）/);
  assert.match(notificationSection, /主动助手提醒统一进入站内通知中心/);
  assert.match(notificationSection, /“已受理”表示 PushPlus 接收了请求，不代表最终送达/);
  assert.match(notificationSection, /PushPlus 的提交、送达、失败或结果未知/);
  assert.match(source, /requestHospitalTenderPushplusCredentials/);
  assert.match(notificationSection, /data-testid="pushplus-credentials-form"/);
  assert.match(notificationSection, /data-testid="pushplus-token-input"/);
  assert.match(notificationSection, /type="password"/);
  assert.match(notificationSection, /页面不再读取明文/);
  assert.match(notificationSection, /空白字段不会覆盖现有 Token/);
  assert.match(source, /pushplusConfigured/);
  assert.doesNotMatch(notificationSection, /AccessKey/u);
  assert.doesNotMatch(source, /pushplusForm\.accessKey|pushplusAccessKeyMeta|deliveryVerification/u);
  assert.match(styles, /\.settings-card-icon\.clawbot\s*\{/);
  assert.doesNotMatch(styles, /\.settings-card-icon\.pushplus\s*\{/i);
});

test("bookkeeping realtime log polls the scoped audit feed read-only", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /listBookkeepingAuditLogs/);
  assert.match(source, /setInterval\([\s\S]{0,80}?10000\)/);
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /bookkeeping_client\.print_expense_list/);
  assert.match(source, /bookkeeping_client\.export_expense_xlsx/);
  assert.match(source, /shortcut_bookkeeping\.accept/);
  assert.match(source, /data-testid="bookkeeping-log-list"/);
  assert.match(source, /setBookkeepingLogReloadToken\(\(value\) => value \+ 1\)/);
  assert.match(source, /<RefreshCw size=\{16\} \/> 刷新\s*<\/button>/);
  assert.match(source, /toLocaleTimeString\("zh-CN", \{ hour12: false \}\)/);
  assert.match(source, /entityId \? entityId\.slice\(0, 8\) : ""/);
  assert.doesNotMatch(source, /confirmWeixinBookkeepingReview/);
});

test("bookkeeping categories expose owner-scoped CRUD controls and archived recovery", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="settings-bookkeeping-categories-section"/);
  assert.match(source, /listBookkeepingCategories/);
  assert.match(source, /createBookkeepingCategory/);
  assert.match(source, /updateBookkeepingCategory/);
  assert.match(source, /deleteBookkeepingCategory/);
  assert.match(source, /新增分类/);
  assert.match(source, /显示已停用/);
  assert.match(source, /恢复/);
  assert.match(source, /历史记账仍会保留该分类/);
});

test("tender schedule settings expose the existing scheduler controls without showing secrets", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /updateHospitalTenderScheduler/);
  assert.match(source, /runHospitalTenderScheduler/);
  assert.match(source, /intervalMinutes/);
  assert.match(source, /batchSize/);
  assert.match(source, /cycleNumber/);
  assert.match(source, /lastFinishedAt/);
  assert.match(source, /nextRunAt/);
  assert.match(source, /立即检测下一批/);
  assert.match(source, /启用自动轮巡/);
  assert.match(source, /固定节奏处理下一批客户/);
  assert.doesNotMatch(source, /固定的每小时/);
  assert.doesNotMatch(source, /每小时处理下一批/);
  assert.doesNotMatch(source, /name="intervalMinutes"/);
  assert.doesNotMatch(source, /name="batchSize"/);
  assert.doesNotMatch(source, /JSON\.stringify\s*\(/);
});

test("the security section carries a change-password card wired to the session-safe endpoint", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /data-testid="change-password-card"/);
  assert.match(source, /data-testid="change-password-form"/);
  assert.match(source, /aria-label="当前密码"/);
  assert.match(source, /aria-label="新密码"/);
  assert.match(source, /aria-label="确认新密码"/);
  assert.match(source, /两次输入的新密码不一致/);
  assert.match(source, /新密码至少 10 个字符/);
  assert.match(source, /apiClient\.changePassword\(\{/);
  assert.match(source, /密码已修改，其他已登录设备将需要重新登录/);
  assert.match(source, /CURRENT_PASSWORD_INCORRECT/);
  assert.match(source, /当前密码不正确/);
  assert.match(source, /status === 429/);
  assert.match(source, /尝试过于频繁，请 15 分钟后再试/);
});

test("members only see the change-password card in the security section", async () => {
  const [source, shellSource] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(shellPath, "utf8"),
  ]);

  assert.match(source, /role = "admin"/);
  assert.match(source, /role !== "admin" && section === "security"/);
  assert.match(source, /\{role === "admin" \? \(/);
  assert.match(shellSource, /<SystemSettingsPage[\s\S]*?role=\{authSession\?\.role \?\? "member"\}/);
});

test("admin AI platform entry uses the shared accessible button treatment", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(
    source,
    /<a href="\/api\/ai-platform\/console\/"[\s\S]*className="ghost-button"[\s\S]*>\s*<ExternalLink/,
  );
  assert.doesNotMatch(source, /className="button secondary"/);
});

test("grouped settings navigation and controls keep responsive accessible styling", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.module-subnav-item\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.module-subnav-context button\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.module-subnav-item:focus-visible/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.module-subnav-list\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.settings-scheduler-form[^}]*\{/);
});
