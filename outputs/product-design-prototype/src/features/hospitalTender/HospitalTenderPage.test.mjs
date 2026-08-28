import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("./HospitalTenderPage.jsx", import.meta.url);
const appPath = new URL("../../App.jsx", import.meta.url);
const stylesPath = new URL("../../styles/global.css", import.meta.url);

test("hospital tender page exposes the read-only monitoring contract", async () => {
  const source = await readFile(pagePath, "utf8");
  const appSource = await readFile(appPath, "utf8");

  assert.match(source, /export function HospitalTenderPage\s*\(/);
  for (const prop of ["apiClient", "notices", "summary", "sources", "health", "customers", "loading", "error", "onRefresh", "onSelectCustomer", "onOpenSchedule"]) {
    assert.match(source, new RegExp(`\\b${prop}\\b`), `missing prop ${prop}`);
  }
  assert.match(source, /筛选公告类型/);
  assert.match(source, /筛选相关性/);
  assert.match(source, /筛选客户/);
  assert.match(source, /废标\/终止/);
  assert.match(source, /原文|查看原文/);
  assert.match(source, /来源健康|数据源健康/);
  assert.match(source, /匹配依据/);
  assert.match(source, /调度设置/);
  assert.match(source, /onOpenSchedule/);
  assert.match(appSource, /onOpenSchedule=\{\(\) => navigateTo\("settings-tender-schedule"\)\}/);
  assert.doesNotMatch(source, /立即检测下一批/);
  assert.doesNotMatch(source, /启用自动轮巡|停用自动轮巡/);
  assert.doesNotMatch(source, /PushPlus/);
  assert.doesNotMatch(source, /runHospitalTenderMonitor/);
  assert.doesNotMatch(source, /runHospitalTenderScheduler/);
  assert.doesNotMatch(source, /updateHospitalTenderScheduler/);
  assert.match(source, /listHospitalTenderPage/);
  assert.match(source, /搜索公告/);
  assert.match(source, /清除筛选/);
  assert.match(source, /lastSuccessAt/);
  assert.match(appSource, /scrollIntoView/);
  assert.match(source, /focusableSelector/);
  assert.match(source, /role="dialog"|aria-label="公告详情"/);
  assert.match(source, /hospital-tender-priority-strip/);
  assert.match(source, /hospital-tender-content-grid/);
  assert.match(source, /重点机会/);
  assert.match(source, /全部公告/);
  assert.match(source, /pill \$\{isUrgent \? "danger"/);
  assert.match(source, /userFacingTenderError/);
  assert.match(source, /publishedToday/);
  assert.match(source, /deadlineWithinNextSevenDays/);
  assert.doesNotMatch(source, /2026-08-18/);
});

test("hospital tender page avoids rendering raw payloads or credential-like fields", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.doesNotMatch(source, /JSON\.stringify\s*\(/);
  assert.doesNotMatch(source, /(?:api[_-]?key|secret|token|password|authorization)/i);
  assert.doesNotMatch(source, /notice\.(?:raw|payload|html|body)\b/i);
});

test("hospital tender search and clear controls keep accessible touch targets", async () => {
  const [source, styles] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);

  assert.match(source, /hospital-tender-clear-filter ghost-button/);
  assert.match(styles, /\.hospital-tender-filter select\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.hospital-tender-search\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.hospital-tender-search input\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.hospital-tender-search button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.hospital-tender-clear-filter\s*\{[^}]*min-height:\s*44px;/s);
});

test("hospital tender can open in one customer context and return to the all-customer view", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /customerId\s*=\s*""/);
  assert.match(source, /setCustomerFilter\(customerId \?\? ""\)/);
  assert.match(source, /useState\(customerId \?\? ""\)/);
  assert.match(source, /customerId:\s*customerFilter/);
  assert.match(source, /<option value="">全部客户<\/option>/);
  assert.match(source, /setCustomerFilter\(""\)/);
});
