import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { webkit } from "playwright";

import { hashPassword } from "../../../backend/src/auth/password.js";
import { openDatabase } from "../../../backend/src/db.js";
import { createServer as createBackendServer } from "../../../backend/src/server.js";
import {
  createStaticServer,
  createStaticServerConfig,
} from "./static-server.mjs";
import {
  browserContextIdentity,
  prepareBrowserEvidence,
  restrictEvidenceNetwork,
} from "./browser-evidence.mjs";

const LOGIN_ACCOUNT = "jiangjz";
const LOGIN_PASSWORD = ["qa", "customer", "import", "password"].join("-");
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const VIEWPORTS = Object.freeze([
  { name: "desktop-large", width: 1920, height: 1080 },
  { name: "desktop-compact", width: 1366, height: 768 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "iphone", width: 390, height: 844 },
  { name: "mobile-small", width: 360, height: 800 },
  { name: "desktop-flow", width: 1440, height: 900, fullFlow: true },
]);

function listen(server, port = 0) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function freePort() {
  const probe = createProbeServer();
  await listen(probe);
  const { port } = probe.address();
  await closeServer(probe);
  return port;
}

function parseCookie(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")];
  return values.find(Boolean)?.split(";", 1)[0] ?? "";
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return { response, body: text ? JSON.parse(text) : null };
  } catch (error) {
    throw new Error(`Expected JSON response, received: ${text.slice(0, 300)}`, { cause: error });
  }
}

async function apiRequest(origin, path, {
  cookie = "",
  csrfToken = "",
  method = "GET",
  body,
  frontendOrigin,
} = {}) {
  const headers = { Accept: "application/json", Origin: frontendOrigin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return readJsonResponse(await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function loginApi(origin, frontendOrigin) {
  const result = await apiRequest(origin, "/api/auth/login", {
    method: "POST",
    frontendOrigin,
    body: { account: LOGIN_ACCOUNT, password: LOGIN_PASSWORD },
  });
  assert.equal(result.response.status, 200, "fixture login should succeed");
  const cookie = parseCookie(result.response);
  assert.ok(cookie, "fixture login should return a session cookie");
  assert.ok(result.body.csrfToken, "fixture login should return a CSRF token");
  return { cookie, csrfToken: result.body.csrfToken };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsvFixture({ newCustomerName, duplicateCustomerName, newRegion, duplicateRegion }) {
  const rows = [
    ["name", "region", "region_alt", "contact", "summary", "tags"],
    [
      newCustomerName,
      "初始区域不应写入",
      newRegion,
      "合成验收联系人 / 13800000000",
      "浏览器通过真实 multipart 预览后写入。\n第二行用于验证 CSV 引号和嵌入换行。",
      "批量导入；六视口；合成数据",
    ],
    [
      duplicateCustomerName,
      "旧重复区域不应写入",
      duplicateRegion,
      "合成合并联系人",
      "同 owner 规范名称命中后，由服务端预览为 merge。",
      "批量合并；合成数据",
    ],
    ["", "无效区域", "无效区域", "", "缺少名称的行必须拒绝", "错误行"],
  ];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function resultItem(body) {
  return body?.item ?? body;
}

function resultBatch(result) {
  return result?.customerImportBatch ?? result?.batch;
}

function resultRows(result) {
  return result?.customerImportRows ?? result?.rows ?? [];
}

function assertPreviewPlan(result, { newCustomerName, duplicateCustomerName }) {
  const batch = resultBatch(result);
  const rows = resultRows(result);
  assert.equal(batch.status, "preview");
  assert.equal(batch.totalRows, 3);
  assert.match(batch.fileSha256, /^[0-9a-f]{64}$/u);
  assert.match(result.previewDigest, /^[0-9a-f]{64}$/u);
  assert.equal(rows.length, 3);
  const byName = new Map(rows.map((row) => [row.normalized?.name ?? "", row]));
  assert.equal(byName.get(newCustomerName)?.action, "create");
  assert.equal(byName.get(duplicateCustomerName)?.action, "merge");
  const rejected = rows.find((row) => row.action === "reject");
  assert.ok(rejected, "missing-name row should be rejected by the service preview");
  assert.ok(rejected.errors.length > 0, "rejected row should expose validation errors");
}

function addInitScript(context) {
  return context.addInitScript(() => {
    try {
      localStorage.setItem("sentelligent_disable_sw", "1");
      localStorage.setItem("sentelligent_mobile_shell", "0");
      indexedDB.deleteDatabase("sentelligent-bootstrap");
    } catch {
      // Browser storage is only a cache; acceptance remains live-data based.
    }
  });
}

async function loginBrowser(page) {
  await page.getByLabel("账号").fill(LOGIN_ACCOUNT);
  await page.locator('input[aria-label="密码"]').fill(LOGIN_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("page-overview").waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="api-status"]')?.textContent?.trim() === "在线",
    null,
    { timeout: 10000 },
  );
}

async function openImportPanel(page) {
  await page.getByTestId("nav-customer").click();
  const list = page.getByTestId("customer-list-view");
  await list.waitFor();
  const firstRow = list.locator(".customer-list-row").first();
  await firstRow.waitFor();
  await firstRow.getByTestId("customer-open-detail").click();
  const panel = page.getByTestId("customer-import-panel");
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  return panel;
}

function matchesImportResponse(response, backendOrigin, action) {
  const url = new URL(response.url());
  if (url.origin !== backendOrigin) return false;
  if (action === "preview") return url.pathname === "/api/customer-imports/preview";
  return new RegExp(`/api/customer-imports/[^/]+/${action}$`, "u").test(url.pathname);
}

async function clickForImportResponse(page, backendOrigin, action, click) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => matchesImportResponse(candidate, backendOrigin, action)),
    click(),
  ]);
  const body = await response.json();
  assert.ok(response.status() >= 200 && response.status() < 300, `${action} should succeed: ${JSON.stringify(body)}`);
  return { response, body, item: resultItem(body) };
}

async function panelMetrics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="customer-import-panel"]');
    const content = document.querySelector(".content");
    const table = panel?.querySelector(".customer-import-table-wrap");
    const mobileRows = panel?.querySelector(".customer-import-mobile-rows");
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const outOfBounds = [...(panel?.querySelectorAll("button, select") ?? [])]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.left < -1 || item.right > innerWidth + 1);
    const overflow = (element) => element
      ? Math.max(0, Math.ceil(element.scrollWidth - element.clientWidth))
      : 0;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageOverflow: overflow(document.documentElement),
      contentOverflow: overflow(content),
      panelOverflow: overflow(panel),
      tableVisible: visible(table),
      mobileRowsVisible: visible(mobileRows),
      rowActionSelectCount: panel?.querySelectorAll(
        ".customer-import-table-wrap select, .customer-import-mobile-rows select",
      ).length ?? 0,
      mappingSelectCount: panel?.querySelectorAll(".customer-import-mapping-grid select").length ?? 0,
      outOfBounds,
    };
  });
}

function assertResponsivePreview(metrics, viewport) {
  assert.deepEqual(metrics.viewport, { width: viewport.width, height: viewport.height });
  assert.equal(metrics.pageOverflow, 0, `${viewport.name}: page should not overflow horizontally`);
  assert.equal(metrics.contentOverflow, 0, `${viewport.name}: content should not overflow horizontally`);
  assert.equal(metrics.panelOverflow, 0, `${viewport.name}: import panel should not overflow horizontally`);
  assert.equal(metrics.rowActionSelectCount, 0, `${viewport.name}: service row actions must remain read-only`);
  assert.ok(metrics.mappingSelectCount >= 12, `${viewport.name}: field mapping controls should remain available`);
  assert.deepEqual(metrics.outOfBounds, [], `${viewport.name}: visible import controls should stay inside the viewport`);
  if (viewport.width <= 640) {
    assert.equal(metrics.tableVisible, false, `${viewport.name}: desktop table should be hidden`);
    assert.equal(metrics.mobileRowsVisible, true, `${viewport.name}: mobile rows should be visible`);
  } else {
    assert.equal(metrics.tableVisible, true, `${viewport.name}: desktop table should be visible`);
    assert.equal(metrics.mobileRowsVisible, false, `${viewport.name}: mobile rows should be hidden`);
  }
}

async function runViewport(browser, {
  viewport,
  frontendOrigin,
  backendOrigin,
  filePath,
  fixture,
  evidenceDirectory,
}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  const blockedOrigins = await restrictEvidenceNetwork(context, frontendOrigin, backendOrigin);
  await addInitScript(context);
  const page = await context.newPage();
  const failedResponses = [];
  const previewRequestBodies = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
  });
  page.on("request", (request) => {
    if (request.url() === `${backendOrigin}/api/customer-imports/preview`) {
      previewRequestBodies.push(request.postData() ?? "");
    }
  });

  try {
    await page.goto(frontendOrigin, { waitUntil: "networkidle" });
    const browserIdentity = await browserContextIdentity(page, browser, "webkit");
    await loginBrowser(page);
    failedResponses.length = 0;
    const panel = await openImportPanel(page);
    await panel.locator('input[type="file"]').setInputFiles(filePath);
    const initialPreview = await clickForImportResponse(
      page,
      backendOrigin,
      "preview",
      () => panel.getByRole("button", { name: "生成预览", exact: true }).click(),
    );
    assertPreviewPlan(initialPreview.item, fixture);
    await panel.getByText("逐行执行预览", { exact: true }).waitFor();

    let activePreview = initialPreview.item;
    if (viewport.fullFlow) {
      const regionSelect = panel.getByLabel("区域映射");
      await regionSelect.selectOption("region_alt");
      await panel.getByText("文件或字段映射已变化，确认前请重新生成预览。", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "确认导入", exact: true }).isDisabled(), true);
      const refreshed = await clickForImportResponse(
        page,
        backendOrigin,
        "preview",
        () => panel.getByRole("button", { name: "重新生成预览", exact: true }).click(),
      );
      assertPreviewPlan(refreshed.item, fixture);
      assert.equal(refreshed.item.mapping.fieldToHeader.region, "region_alt");
      activePreview = refreshed.item;
      await page.waitForFunction(
        () => !document.querySelector(".customer-import-inline-warning"),
        null,
        { timeout: 10000 },
      );
    }

    const metrics = await panelMetrics(page);
    assertResponsivePreview(metrics, viewport);
    const screenshot = resolve(
      evidenceDirectory,
      `customer-import-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: false });

    let terminalResult;
    if (viewport.fullFlow) {
      await panel.getByRole("button", { name: "确认导入", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "确认导入客户" });
      await dialog.waitFor();
      const confirmed = await clickForImportResponse(
        page,
        backendOrigin,
        "confirm",
        () => dialog.getByRole("button", { name: "确认导入", exact: true }).click(),
      );
      terminalResult = confirmed.item;
      assert.equal(resultBatch(terminalResult).status, "committed");
      assert.equal(resultRows(terminalResult).filter((row) => row.status === "committed").length, 2);
      assert.equal(resultRows(terminalResult).filter((row) => row.status === "rejected").length, 1);
      await panel.getByText("客户导入已完成", { exact: true }).waitFor();

      await page.getByRole("button", { name: "返回列表", exact: true }).click();
      const search = page.getByTestId("customer-local-search");
      await search.fill(fixture.newCustomerName);
      const importedRow = page.locator(".customer-list-row").filter({ hasText: fixture.newCustomerName });
      await importedRow.waitFor();
      assert.match(await importedRow.innerText(), new RegExp(fixture.newRegion));
    } else {
      await panel.getByRole("button", { name: "取消预览", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "取消本次预览" });
      await dialog.waitFor();
      const cancelled = await clickForImportResponse(
        page,
        backendOrigin,
        "cancel",
        () => dialog.getByRole("button", { name: "取消本次预览", exact: true }).click(),
      );
      terminalResult = cancelled.item;
      assert.equal(resultBatch(terminalResult).status, "cancelled");
      await panel.getByText("没有写入客户资料", { exact: true }).waitFor();
    }

    assert.ok(previewRequestBodies.length >= 1, `${viewport.name}: preview request should be observed`);
    assert.ok(
      previewRequestBodies.every((body) => !body.includes("rowActions")),
      `${viewport.name}: multipart contract must remain file + mapping only`,
    );
    assert.deepEqual(blockedOrigins, [], `${viewport.name}: only loopback fixture traffic is allowed`);
    assert.deepEqual(failedResponses, [], `${viewport.name}: import flow should not produce HTTP errors`);
    return {
      browser: browserIdentity,
      metrics,
      screenshot,
      previewBatchId: resultBatch(activePreview).id,
      terminalBatchId: resultBatch(terminalResult).id,
      terminalStatus: resultBatch(terminalResult).status,
      previewRequestCount: previewRequestBodies.length,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const evidence = prepareBrowserEvidence({
    workspaceRoot,
    suite: "customer-import-acceptance",
    outputRoot: process.env.CUSTOMER_IMPORT_ACCEPTANCE_EVIDENCE_DIR,
  });
  const runtimeDirectory = mkdtempSync(resolve(tmpdir(), "sentelligent-customer-import-acceptance-"));
  const databaseUrl = resolve(runtimeDirectory, "customer-import-acceptance.sqlite");
  const report = {
    status: "failed",
    acceptanceScope: {
      csvFileUploadUi: true,
      batchImportApi: true,
      mappingRepreview: true,
      committedPersistence: true,
      xlsxParser: "covered by backend automated tests",
      productionData: false,
      productionServices: false,
      network: "127.0.0.1 loopback only",
    },
    checks: {},
    viewports: {},
    screenshots: {},
    browsers: {},
    batches: {},
  };

  let backend;
  let frontend;
  let browser;
  try {
    const backendPort = await freePort();
    const frontendPort = await freePort();
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    backend = createBackendServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      host: "127.0.0.1",
      port: backendPort,
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authRequired: true,
      authAccount: LOGIN_ACCOUNT,
      authPassword: "",
      authPasswordHash: await hashPassword(LOGIN_PASSWORD, { salt: Buffer.alloc(16, 41) }),
      authSessionSecret: Buffer.alloc(32, 42).toString("base64url"),
      authCookieSecure: false,
      corsAllowedOrigins: [frontendOrigin],
      proactiveAssistantAutoRun: false,
      proactiveNotificationAutoRun: false,
      hospitalTenderAutoRun: false,
      actionReminderAutoRun: false,
      invoiceEscalationAutoRun: false,
      dailyDigestAutoRun: false,
      weixinAgentApiToken: "",
      weixinAgentOwner: "",
    });
    frontend = createStaticServer(createStaticServerConfig({
      host: "127.0.0.1",
      port: frontendPort,
      apiBaseUrl: backendOrigin,
      distPath: evidence.distPath,
      runtimeRoot: resolve(runtimeDirectory, "frontend-runtime"),
    }));
    await listen(backend, backendPort);
    await listen(frontend, frontendPort);

    const session = await loginApi(backendOrigin, frontendOrigin);
    const before = await apiRequest(backendOrigin, "/api/customers", {
      ...session,
      frontendOrigin,
    });
    assert.equal(before.response.status, 200);
    const duplicateCustomer = before.body.items.find((item) => item.owner === LOGIN_ACCOUNT) ?? before.body.items[0];
    assert.ok(duplicateCustomer?.name, "seeded synthetic customer is required for merge acceptance");

    const suffix = String(evidence.identity.runId).replace(/[^a-z0-9]/giu, "").slice(-12) || "v0120";
    const fixture = {
      newCustomerName: `v0.12.0 批量导入验收客户 ${suffix}`,
      duplicateCustomerName: duplicateCustomer.name,
      newRegion: `华东合成区域 ${suffix}`,
      duplicateRegion: `合并后合成区域 ${suffix}`,
    };
    const filePath = resolve(runtimeDirectory, `customer-import-${suffix}.csv`);
    writeFileSync(filePath, buildCsvFixture(fixture), "utf8");
    report.fixture = { ...fixture, fileName: filePath.split("/").at(-1) };

    browser = await webkit.launch({ headless: true });
    for (const viewport of VIEWPORTS) {
      const result = await runViewport(browser, {
        viewport,
        frontendOrigin,
        backendOrigin,
        filePath,
        fixture,
        evidenceDirectory: evidence.directory,
      });
      report.viewports[viewport.name] = result.metrics;
      report.screenshots[viewport.name] = result.screenshot;
      report.browsers[viewport.name] = result.browser;
      report.batches[viewport.name] = {
        previewBatchId: result.previewBatchId,
        terminalBatchId: result.terminalBatchId,
        terminalStatus: result.terminalStatus,
        previewRequestCount: result.previewRequestCount,
      };
    }

    const after = await apiRequest(backendOrigin, "/api/customers", {
      ...session,
      frontendOrigin,
    });
    assert.equal(after.response.status, 200);
    const imported = after.body.items.find((item) => item.name === fixture.newCustomerName);
    const merged = after.body.items.find((item) => item.id === duplicateCustomer.id);
    assert.ok(imported, "confirmed batch should add the new customer to the live API");
    assert.equal(imported.owner, LOGIN_ACCOUNT);
    assert.equal(imported.region, fixture.newRegion);
    assert.equal(merged.region, fixture.duplicateRegion);
    report.checks.apiShowsCommittedCreateAndMerge = true;

    const db = openDatabase({ databaseUrl });
    try {
      const importedRow = db.prepare(
        "SELECT owner, region, tags FROM customers WHERE id = $id AND deleted_at IS NULL",
      ).get({ $id: imported.id });
      assert.equal(importedRow.owner, LOGIN_ACCOUNT);
      assert.equal(importedRow.region, fixture.newRegion);
      assert.deepEqual(JSON.parse(importedRow.tags), ["批量导入", "六视口", "合成数据"]);
      const mergedRow = db.prepare(
        "SELECT region FROM customers WHERE id = $id AND deleted_at IS NULL",
      ).get({ $id: duplicateCustomer.id });
      assert.equal(mergedRow.region, fixture.duplicateRegion);
      const committedBatch = db.prepare(
        "SELECT id, status, total_rows FROM customer_import_batches WHERE status = 'committed' ORDER BY committed_at DESC LIMIT 1",
      ).get();
      assert.ok(committedBatch);
      assert.equal(committedBatch.total_rows, 3);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM customer_import_rows WHERE batch_id = $batchId").get({ $batchId: committedBatch.id }).count,
        3,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer_import.confirm' AND entity_id = $batchId").get({ $batchId: committedBatch.id }).count,
        1,
      );
      const batchColumns = db.prepare("PRAGMA table_info(customer_import_batches)").all().map((row) => row.name);
      assert.ok(!batchColumns.some((name) => /(?:raw|blob|file_bytes|file_data)/iu.test(name)));
      report.checks.sqliteTransactionAuditAndNoRawFileColumn = true;
    } finally {
      db.close();
    }

    report.checks.fileAndMappingOnlyMultipart = true;
    report.checks.serverActionsReadOnlyAtSixViewports = true;
    report.checks.noHorizontalOverflowAtSixViewports = true;
    report.checks.loopbackOnly = true;
    report.status = "passed";
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await closeServer(frontend).catch(() => {});
    await closeServer(backend).catch(() => {});
    rmSync(runtimeDirectory, { recursive: true, force: true });
    evidence.finish(report);
  }

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    reportPath: evidence.reportPath,
    git: evidence.identity.git,
    viewports: VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
  }, null, 2)}\n`);
}

await main();
