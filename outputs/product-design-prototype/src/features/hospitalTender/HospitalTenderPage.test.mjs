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
  for (const prop of ["apiClient", "notices", "summary", "sources", "health", "customers", "loading", "error", "onRefresh", "onSelectCustomer"]) {
    assert.match(source, new RegExp(`\\b${prop}\\b`), `missing prop ${prop}`);
  }
  assert.match(source, /筛选公告类型/);
  assert.match(source, /筛选相关性/);
  assert.match(source, /筛选客户/);
  assert.match(source, /废标\/终止/);
  assert.match(source, /原文|查看原文/);
  assert.match(source, /来源健康|数据源健康/);
  assert.match(source, /匹配依据/);
  assert.match(source, /立即检测/);
  assert.match(source, /runHospitalTenderMonitor/);
  assert.match(source, /自动轮巡/);
  assert.match(source, /每批/);
  assert.match(source, /最近批次/);
  assert.match(source, /下次运行/);
  assert.match(source, /runHospitalTenderScheduler/);
  assert.match(source, /getHospitalTenderScheduler/);
  assert.match(source, /listHospitalTenderPage/);
  assert.match(source, /轮巡进度/);
  assert.match(source, /本批新增高相关/);
  assert.match(source, /检测部分完成/);
  assert.match(source, /HOSPITAL_TENDER_RUN_IN_PROGRESS/);
  assert.match(source, /搜索公告/);
  assert.match(source, /清除筛选/);
  assert.match(source, /lastSuccessAt/);
  assert.match(source, /PushPlus/);
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
