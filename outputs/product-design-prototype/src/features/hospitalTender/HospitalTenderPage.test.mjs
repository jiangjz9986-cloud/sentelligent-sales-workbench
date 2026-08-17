import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("./HospitalTenderPage.jsx", import.meta.url);

test("hospital tender page exposes the read-only monitoring contract", async () => {
  const source = await readFile(pagePath, "utf8");

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
  assert.match(source, /轮巡进度/);
  assert.match(source, /本批新增高相关/);
  assert.match(source, /role="dialog"|aria-label="公告详情"/);
});

test("hospital tender page avoids rendering raw payloads or credential-like fields", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.doesNotMatch(source, /JSON\.stringify\s*\(/);
  assert.doesNotMatch(source, /(?:api[_-]?key|secret|token|password|authorization)/i);
  assert.doesNotMatch(source, /notice\.(?:raw|payload|html|body)\b/i);
});
