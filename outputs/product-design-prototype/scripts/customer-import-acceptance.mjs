import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, webkit } from "playwright";

import { hashPassword } from "../../../backend/src/auth/password.js";
import { openDatabase } from "../../../backend/src/db.js";
import { createServer as createBackendServer } from "../../../backend/src/server.js";
import {
  createStaticServer,
  createStaticServerConfig,
} from "./static-server.mjs";
import { createCustomerImportFixture } from "./fixtures/customer-import-fixture.mjs";

const BASELINE_COMMIT = "23695628a8bcaf6012c0548774a91fe5726bf3cc";
const loginAccount = "jiangjz";
const loginInput = "customer-acceptance-password";
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const distPath = resolve(appRoot, "dist");

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
    server.close((error) => (error ? reject(error) : resolveClose()));
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
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON response, received: ${text.slice(0, 300)}`, { cause: error });
  }
  return { response, body };
}

async function apiRequest(origin, path, {
  cookie = "",
  csrfToken = "",
  method = "GET",
  body,
  frontendOrigin,
} = {}) {
  const headers = {
    Accept: "application/json",
    Origin: frontendOrigin,
  };
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
    body: { account: loginAccount, password: loginInput },
  });
  assert.equal(result.response.status, 200, "fixture login should succeed");
  assert.equal(result.body.account, loginAccount);
  assert.ok(result.body.csrfToken, "fixture login should return a CSRF token");
  const cookie = parseCookie(result.response);
  assert.ok(cookie, "fixture login should return a session cookie");
  return { cookie, csrfToken: result.body.csrfToken };
}

function addInitScript(context) {
  return context.addInitScript(() => {
    try {
      localStorage.setItem("sentelligent_disable_sw", "1");
      localStorage.setItem("sentelligent_mobile_shell", "0");
      indexedDB.deleteDatabase("sentelligent-bootstrap");
    } catch {
      // Browser storage is only a cache; the acceptance run must remain live-data based.
    }
  });
}

async function loginBrowser(page) {
  await page.getByLabel("账号").fill(loginAccount);
  await page.locator('input[aria-label="密码"]').fill(loginInput);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("page-overview").waitFor();
  await page.getByTestId("api-status").waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="api-status"]')?.textContent?.trim() === "在线",
    null,
    { timeout: 10000 },
  );
}

async function openCustomerList(page) {
  await page.getByTestId("nav-customer").click();
  await page.getByTestId("customer-list-view").waitFor();
  await page.getByTestId("customer-local-search").waitFor();
}

async function customerLayoutMetrics(page) {
  return page.evaluate(() => {
    const pageRoot = document.querySelector('[data-testid="page-customer"]');
    const detail = pageRoot?.querySelector('[data-testid="customer-detail-view"]');
    const meta = pageRoot?.querySelector('[data-testid="customer-record-meta"]');
    const visibleControls = [...(pageRoot?.querySelectorAll("button, input, select, textarea") ?? [])]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          testId: element.dataset.testid ?? "",
          label: element.getAttribute("aria-label") || element.textContent?.trim() || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
    const overflow = (element) => element
      ? Math.max(0, Math.ceil(element.scrollWidth - element.clientWidth))
      : 0;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageOverflow: Math.max(0, Math.ceil(document.documentElement.scrollWidth - document.documentElement.clientWidth)),
      contentOverflow: overflow(document.querySelector(".content")),
      detailOverflow: overflow(detail),
      metadataOverflow: overflow(meta),
      controls: visibleControls,
    };
  });
}

function assertNoHorizontalOverflow(metrics, label) {
  assert.equal(metrics.pageOverflow, 0, `${label}: page should not overflow horizontally`);
  assert.equal(metrics.contentOverflow, 0, `${label}: content should not overflow horizontally`);
  assert.equal(metrics.detailOverflow, 0, `${label}: customer detail should not overflow horizontally`);
  assert.equal(metrics.metadataOverflow, 0, `${label}: customer metadata should not overflow horizontally`);
}

async function captureResponsiveContext(browser, {
  name,
  contextOptions,
  frontendOrigin,
  customerName,
  evidenceDirectory,
}) {
  const context = await browser.newContext({
    locale: "zh-CN",
    ...contextOptions,
  });
  await addInitScript(context);
  const page = await context.newPage();
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
  });
  try {
    await page.goto(frontendOrigin, { waitUntil: "networkidle" });
    await loginBrowser(page);
    failedResponses.length = 0;
    await openCustomerList(page);
    const row = page.locator(".customer-list-row").filter({ hasText: customerName });
    await row.waitFor();
    await row.getByTestId("customer-open-detail").click();
    await page.getByTestId("customer-detail-view").waitFor();
    assert.equal(await page.locator(".page-heading h1").innerText(), customerName);
    assert.notEqual(await page.getByTestId("customer-version").innerText(), "");
    assert.notEqual(await page.getByTestId("customer-source").innerText(), "");
    const metrics = await customerLayoutMetrics(page);
    assertNoHorizontalOverflow(metrics, name);
    const minimumHeight = name === "iphone" ? 44 : 40;
    const keyControls = metrics.controls.filter((control) => [
      "customer-edit-detail",
      "customer-delete-detail",
      "proactive-assistant-refresh",
    ].includes(control.testId));
    assert.ok(keyControls.length >= 2, `${name}: key customer controls should be visible`);
    assert.ok(
      keyControls.every((control) => control.height >= minimumHeight),
      `${name}: key customer controls should meet ${minimumHeight}px height`,
    );
    const screenshot = resolve(evidenceDirectory, `customer-${name}-${metrics.viewport.width}x${metrics.viewport.height}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    return { metrics, screenshot, failedResponses };
  } finally {
    await context.close();
  }
}

async function main() {
  assert.equal(existsSync(resolve(distPath, "index.html")), true, "run npm run build before acceptance");
  const runtimeDirectory = mkdtempSync(resolve(tmpdir(), "sentelligent-customer-acceptance-"));
  const evidenceDirectory = resolve(
    process.env.CUSTOMER_ACCEPTANCE_EVIDENCE_DIR
      || resolve(workspaceRoot, ".runtime", "customer-import-acceptance"),
  );
  mkdirSync(evidenceDirectory, { recursive: true });

  const backendPort = await freePort();
  const frontendPort = await freePort();
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const databaseUrl = resolve(runtimeDirectory, "customer-acceptance.sqlite");
  const runId = `${Date.now()}-${process.pid}`;
  const fixture = createCustomerImportFixture(runId);
  const report = {
    status: "failed",
    baselineCommit: BASELINE_COMMIT,
    generatedAt: new Date().toISOString(),
    importContract: {
      fileUploadUi: false,
      batchImportApi: false,
      availableAlternative: "POST /api/customers with an authenticated session",
      interpretation: "The customer was created through the real API alternative; this is not evidence of file import support.",
    },
    importedCustomer: { name: fixture.name },
    checks: {},
    viewports: {},
    screenshots: {},
    failedResponses: [],
  };

  let backend;
  let frontend;
  let browser;
  try {
    backend = createBackendServer({
      databaseUrl,
      seed: true,
      nodeEnv: "test",
      host: "127.0.0.1",
      port: backendPort,
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authRequired: true,
      authAccount: loginAccount,
      authPassword: "",
      authPasswordHash: await hashPassword(loginInput, { salt: Buffer.alloc(16, 41) }),
      authSessionSecret: Buffer.alloc(32, 42).toString("base64url"),
      authCookieSecure: false,
      corsAllowedOrigins: [frontendOrigin],
    });
    frontend = createStaticServer(createStaticServerConfig({
      host: "127.0.0.1",
      port: frontendPort,
      apiBaseUrl: backendOrigin,
      distPath,
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
    assert.ok(!before.body.items.some((item) => item.name === fixture.name), "fixture customer must not pre-exist");
    report.checks.preImportNameAbsent = true;

    const created = await apiRequest(backendOrigin, "/api/customers", {
      ...session,
      frontendOrigin,
      method: "POST",
      body: fixture,
    });
    assert.equal(created.response.status, 201, "customer API alternative should create a record");
    const createdCustomer = created.body.item;
    assert.equal(createdCustomer.name, fixture.name);
    assert.equal(createdCustomer.version, 1);
    assert.equal(createdCustomer.syncPreview[0], fixture.syncPreview[0]);
    assert.deepEqual(createdCustomer.aliases, fixture.aliases);
    assert.deepEqual(createdCustomer.tags, fixture.tags);
    assert.ok(createdCustomer.createdAt);
    assert.ok(createdCustomer.updatedAt);
    report.importedCustomer = {
      id: createdCustomer.id,
      name: createdCustomer.name,
      version: createdCustomer.version,
      source: createdCustomer.syncPreview[0],
      aliases: createdCustomer.aliases,
      tags: createdCustomer.tags,
      createdAt: createdCustomer.createdAt,
      updatedAt: createdCustomer.updatedAt,
    };
    report.checks.apiCreateAlternative = true;

    const detail = await apiRequest(backendOrigin, `/api/customers/${encodeURIComponent(createdCustomer.id)}`, {
      ...session,
      frontendOrigin,
    });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.id, createdCustomer.id);
    assert.equal(detail.body.item.summary, fixture.summary);
    report.checks.apiDetailRoundTrip = true;

    const db = openDatabase({ databaseUrl });
    try {
      const persisted = db.prepare("SELECT id, name, version, sync_preview, aliases, tags FROM customers WHERE id = ?").get(createdCustomer.id);
      assert.ok(persisted, "the alternative API create must persist in the temporary database");
      assert.equal(persisted.name, fixture.name);
      assert.equal(persisted.version, 1);
      assert.deepEqual(JSON.parse(persisted.sync_preview), fixture.syncPreview);
      assert.deepEqual(JSON.parse(persisted.aliases), fixture.aliases);
      assert.deepEqual(JSON.parse(persisted.tags), fixture.tags);
    } finally {
      db.close();
    }
    report.checks.sqlitePersistence = true;

    browser = await webkit.launch({ headless: true });
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
    });
    await addInitScript(desktopContext);
    const desktopPage = await desktopContext.newPage();
    const desktopFailedResponses = [];
    desktopPage.on("response", (response) => {
      if (response.status() >= 400) desktopFailedResponses.push({ status: response.status(), url: response.url() });
    });
    try {
      await desktopPage.goto(frontendOrigin, { waitUntil: "networkidle" });
      await loginBrowser(desktopPage);
      desktopFailedResponses.length = 0;
      await openCustomerList(desktopPage);
      const customerRow = desktopPage.locator(".customer-list-row").filter({ hasText: fixture.name });
      await customerRow.waitFor();
      assert.equal(await customerRow.count(), 1, "the API-created customer must render in the list");
      assert.match(await desktopPage.getByTestId("customer-list-view").innerText(), new RegExp(fixture.name));
      report.checks.uiRendersApiCreatedCustomer = true;

      const search = desktopPage.getByTestId("customer-local-search");
      await search.fill(fixture.aliases[0]);
      await customerRow.waitFor();
      assert.equal(await desktopPage.locator(".customer-list-row").count(), 1, "customer search should filter to the fixture");
      assert.match(await desktopPage.getByTestId("customer-list-view").innerText(), new RegExp(fixture.name));
      report.checks.searchFindsImportedCustomer = true;
      await search.fill("");

      await customerRow.getByTestId("customer-open-detail").click();
      await desktopPage.getByTestId("customer-detail-view").waitFor();
      assert.equal(await desktopPage.locator(".page-heading h1").innerText(), fixture.name);
      assert.equal(await desktopPage.getByTestId("customer-summary").innerText(), fixture.summary);
      assert.match(await desktopPage.getByTestId("customer-source").innerText(), new RegExp(fixture.syncPreview[0]));
      assert.equal(await desktopPage.getByTestId("customer-version").innerText(), "v1");
      assert.match(await desktopPage.getByTestId("customer-imported-fields").innerText(), new RegExp(fixture.aliases[0]));
      assert.match(await desktopPage.getByTestId("customer-imported-fields").innerText(), new RegExp(fixture.tags[0]));
      assert.notEqual(await desktopPage.getByTestId("customer-created-at").innerText(), "未记录");
      assert.notEqual(await desktopPage.getByTestId("customer-updated-at").innerText(), "未记录");
      report.checks.detailShowsVersionSourceAndImportedFields = true;

      const initialMetrics = await customerLayoutMetrics(desktopPage);
      assertNoHorizontalOverflow(initialMetrics, "desktop detail");
      report.viewports.desktopInitial = initialMetrics;
      report.screenshots.desktopDetail = resolve(evidenceDirectory, "customer-desktop-detail-1440x900.png");
      await desktopPage.screenshot({ path: report.screenshots.desktopDetail, fullPage: false });

      await desktopPage.getByTestId("customer-edit-detail").click();
      const editor = desktopPage.getByTestId("customer-editor");
      await editor.waitFor();
      const levelInput = editor.locator(".form-field").filter({ hasText: "级别" }).locator("input");
      const originalLevel = await levelInput.inputValue();
      await levelInput.fill("取消不应保存");
      await desktopPage.getByTestId("customer-cancel-edit").click();
      await editor.waitFor({ state: "detached" });
      await desktopPage.getByTestId("customer-edit-detail").click();
      await editor.waitFor();
      assert.equal(await levelInput.inputValue(), originalLevel, "cancel should discard a local customer edit");
      report.checks.cancelDiscardsLocalEdit = true;

      const editedSummary = `${fixture.summary} 已完成 UI 保存回归。`;
      await editor.locator(".form-field").filter({ hasText: "客户摘要" }).locator("textarea").fill(editedSummary);
      await desktopPage.getByTestId("customer-save-edit").click();
      await editor.waitFor({ state: "detached" });
      await desktopPage.getByTestId("customer-detail-view").waitFor();
      assert.match(await desktopPage.getByTestId("customer-detail-view").innerText(), new RegExp(editedSummary));
      assert.equal(await desktopPage.getByTestId("customer-version").innerText(), "v2");
      report.checks.editSaveRendersVersionIncrement = true;

      const afterSave = await apiRequest(backendOrigin, `/api/customers/${encodeURIComponent(createdCustomer.id)}`, {
        ...session,
        frontendOrigin,
      });
      assert.equal(afterSave.response.status, 200);
      assert.equal(afterSave.body.item.version, 2);
      assert.equal(afterSave.body.item.summary, editedSummary);
      assert.deepEqual(afterSave.body.item.tags, fixture.tags, "UI edit should preserve imported tags");
      assert.deepEqual(afterSave.body.item.aliases, fixture.aliases, "UI edit should preserve imported aliases");
      report.checks.editSavePersistsAndPreservesImportedFields = true;

      await desktopPage.getByTestId("customer-delete-detail").click();
      await desktopPage.getByTestId("customer-delete-dialog").waitFor();
      await desktopPage.getByTestId("customer-delete-cancel").click();
      await desktopPage.getByTestId("customer-delete-dialog").waitFor({ state: "detached" });
      assert.equal(await desktopPage.getByTestId("customer-detail-view").count(), 1);
      report.checks.deleteCancelKeepsCustomer = true;

      const desktopFinalMetrics = await customerLayoutMetrics(desktopPage);
      assertNoHorizontalOverflow(desktopFinalMetrics, "desktop final detail");
      report.viewports.desktop = desktopFinalMetrics;
      assert.ok(desktopFinalMetrics.controls.some((control) => control.testId === "customer-edit-detail"));
      report.checks.keyCustomerButtonsUsable = true;
    } finally {
      report.failedResponses.push(...desktopFailedResponses);
      await desktopContext.close();
    }

    const tablet = await captureResponsiveContext(browser, {
      name: "tablet",
      contextOptions: { viewport: { width: 820, height: 1180 } },
      frontendOrigin,
      customerName: fixture.name,
      evidenceDirectory,
    });
    report.viewports.tablet = tablet.metrics;
    report.screenshots.tabletDetail = tablet.screenshot;
    report.failedResponses.push(...tablet.failedResponses);

    const iphone = await captureResponsiveContext(browser, {
      name: "iphone",
      contextOptions: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
      frontendOrigin,
      customerName: fixture.name,
      evidenceDirectory,
    });
    report.viewports.iphone = iphone.metrics;
    report.screenshots.iphoneDetail = iphone.screenshot;
    report.failedResponses.push(...iphone.failedResponses);
    assert.deepEqual(report.failedResponses, [], "customer acceptance should not produce HTTP error responses");
    report.checks.desktopTabletIphoneResponsive = true;
    report.status = "passed";
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    report.generatedAt = new Date().toISOString();
    writeFileSync(
      resolve(evidenceDirectory, "customer-import-acceptance-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    await browser?.close().catch(() => {});
    await closeServer(frontend).catch(() => {});
    await closeServer(backend).catch(() => {});
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
