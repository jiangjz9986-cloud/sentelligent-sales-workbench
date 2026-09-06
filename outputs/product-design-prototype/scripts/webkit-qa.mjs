import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, webkit } from "playwright";

import { hashPassword } from "../../../backend/src/auth/password.js";
import { openDatabase } from "../../../backend/src/db.js";
import { createVisitItineraryRepository } from "../../../backend/src/itinerary/repository.js";
import { createServer as createBackendServer } from "../../../backend/src/server.js";
import {
  createStaticServer,
  createStaticServerConfig,
} from "./static-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const distPath = resolve(appRoot, "dist");
const loginPassword = "qa-login-password";
const expenseTabs = ["ledger", "invoices"];

function listen(server, port) {
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

function readTemperatureWritebackProof(databaseUrl) {
  const db = openDatabase({ databaseUrl });
  try {
    const suggestion = db.prepare(`
      SELECT id, customer_id, customer_version, previous_value, suggested_value,
             status, confirmed_customer_version, confirmed_relation
      FROM visit_temperature_suggestions
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get();
    if (!suggestion) return null;
    const customer = db.prepare(`
      SELECT id, relation, version
      FROM customers
      WHERE id = $id
    `).get({ $id: suggestion.customer_id });
    const audit = db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_logs
      WHERE action = 'customer.relation.update'
        AND entity_id = $id
    `).get({ $id: suggestion.customer_id });
    return {
      suggestion,
      customer,
      relationUpdateAuditCount: Number(audit?.count ?? 0),
    };
  } finally {
    db.close();
  }
}

async function freePort() {
  const probe = createProbeServer();
  await listen(probe, 0);
  const { port } = probe.address();
  await closeServer(probe);
  return port;
}

async function shellMetrics(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const interactive = [...document.querySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), select, textarea",
    )].filter((element) => {
      const rect = element.closest(".search-box, .itinerary-filter")
        ?.getBoundingClientRect() ?? element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !element.disabled
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0
        && rect.bottom >= 0
        && rect.top <= innerHeight;
    });
    const undersized = interactive.map((element) => {
      const target = element.closest(".search-box, .itinerary-filter") ?? element;
      const rect = target.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label") || element.textContent?.trim() || element.title || "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }).filter((item) => item.width < 44 || item.height < 44);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      visualScale: window.visualViewport?.scale ?? null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebarHeight: sidebar ? Math.round(sidebar.height) : null,
      logoCurrentSrc: document.querySelector(".brand-area img")?.currentSrc ?? "",
      undersized,
    };
  });
}

async function assertExpensePageReady(page) {
  const expensePage = page.locator('.expense-page[data-testid="page-expense"]');
  await expensePage.waitFor();
  await expensePage.locator(".expense-loading").waitFor({ state: "detached" });
  assert.equal(await expensePage.locator('.expense-page-alert[role="alert"]').count(), 0);

  for (const tabId of expenseTabs) {
    const tab = page.getByTestId(`expense-tab-${tabId}`);
    await tab.waitFor();
    assert.equal(await tab.count(), 1, `expense tab ${tabId} should render once`);
  }

  const ledgerTab = page.getByTestId("expense-tab-ledger");
  assert.equal(await ledgerTab.getAttribute("aria-selected"), "true");
  await expensePage.getByTestId("expense-ledger-workbench").waitFor();
  assert.equal(
    await expensePage.locator(".expense-ledger-child-card").count(),
    2,
    "scheme-three ledger keeps payment proofs and received advances; the WeChat review card was removed in v0.8.2",
  );

  const naturalWeekInput = expensePage.locator('input[type="week"]');
  await naturalWeekInput.waitFor();
  assert.equal(await naturalWeekInput.count(), 1);
  assert.equal(await naturalWeekInput.getAttribute("type"), "week");
}

function installVoiceRecognitionUnavailable() {
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
}

async function main() {
  assert.equal(existsSync(resolve(distPath, "index.html")), true, "run the frontend build before WebKit QA");
  const runtimeDirectory = mkdtempSync(resolve(tmpdir(), "sentelligent-webkit-qa-"));
  const evidenceDirectory = resolve(
    process.env.WEBKIT_EVIDENCE_DIR || resolve(workspaceRoot, ".runtime", "webkit-qa"),
  );
  mkdirSync(evidenceDirectory, { recursive: true });

  const backendPort = await freePort();
  const frontendPort = await freePort();
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const databaseUrl = resolve(runtimeDirectory, "webkit.sqlite");
  const fixtureDb = openDatabase({ databaseUrl });
  try {
    createVisitItineraryRepository(fixtureDb, {
      idFactory: () => "webkit-itinerary-fixture",
      clock: () => new Date("2026-07-27T12:00:00.000Z"),
    }).create({
      actor: "jiangjz",
      title: "黄岛至济宁候选验收行程",
      visitDate: "2026-07-29",
      status: "planned",
      request: {
        title: "黄岛至济宁候选验收行程",
        visitDate: "2026-07-29",
        status: "planned",
        departureAddress: "青岛市黄岛区秀兰禧悦山",
        departureCity: "青岛",
        departureAt: "2026-07-29T00:00:00.000Z",
        stops: [{
          id: "webkit-stop-jining",
          customerName: "济宁市第二人民医院",
          address: "济宁市任城区济宁市第二人民医院",
          city: "济宁",
          priority: "high",
          visitMinutes: 60,
          appointmentAt: "2026-07-29T05:30:00.000Z",
          notes: "移动端日期视觉验收",
        }],
      },
      plan: {
        provider: "qa-fixture",
        summary: "黄岛出发前往济宁，完成单客户拜访。",
        advice: ["出发前确认预约时间。"],
        departure: { formattedAddress: "青岛市黄岛区秀兰禧悦山" },
        stops: [{
          id: "webkit-stop-jining",
          customerName: "济宁市第二人民医院",
          address: "济宁市任城区济宁市第二人民医院",
          formattedAddress: "济宁市任城区济宁市第二人民医院",
          priority: "high",
          visitMinutes: 60,
        }],
        orderedStopIds: ["webkit-stop-jining"],
        schedule: [],
        route: { distanceMeters: 379100, durationSeconds: 15120, tollsCny: 0, polyline: [] },
        totals: {},
      },
    });
  } finally {
    fixtureDb.close();
  }
  const backend = createBackendServer({
    databaseUrl,
    seed: true,
    nodeEnv: "test",
    host: "127.0.0.1",
    port: backendPort,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: "jiangjz",
    authPassword: "",
    authPasswordHash: await hashPassword(loginPassword, { salt: Buffer.alloc(16, 31) }),
    authSessionSecret: Buffer.alloc(32, 32).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [frontendOrigin],
  });
  const frontend = createStaticServer(createStaticServerConfig({
    host: "127.0.0.1",
    port: frontendPort,
    apiBaseUrl: backendOrigin,
    distPath,
    runtimeRoot: resolve(runtimeDirectory, "frontend-runtime"),
  }));

  let browser;
  try {
    await listen(backend, backendPort);
    await listen(frontend, frontendPort);
    browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("sentelligent_disable_sw", "1");
        localStorage.setItem("sentelligent_mobile_shell", "0");
        indexedDB.deleteDatabase("sentelligent-bootstrap");
      } catch {}
    });
    await context.addInitScript(installVoiceRecognitionUnavailable);
    const page = await context.newPage();
    const failedResponses = [];
    const aiSuggestionRequests = [];
    const temperatureConfirmRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/ai/suggestions")) {
        aiSuggestionRequests.push({ method: request.method(), url: request.url() });
      }
      if (
        request.method() === "POST"
        && /\/api\/visit-temperature-suggestions\/[^/]+\/confirm$/u.test(request.url())
      ) {
        temperatureConfirmRequests.push({ method: request.method(), url: request.url() });
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && response.status() !== 401) {
        failedResponses.push({ status: response.status(), url: response.url() });
      }
    });

    await page.goto(frontendOrigin, { waitUntil: "networkidle" });
    await page.getByLabel("账号").fill("jiangjz");
    await page.locator('input[aria-label="密码"]').fill(loginPassword);
    await page.getByTestId("login-submit").click();
    await page.getByTestId("page-overview").waitFor();

    async function exerciseAiSuggestionCard({ module, type, action }) {
      await page.getByTestId(`nav-${module}`).click();
      await page.getByTestId(`${module}-list-view`).waitFor();
      await page.getByTestId(`${module}-open-detail`).first().click();
      await page.getByTestId(`${module}-detail-view`).waitFor();
      const panel = page.getByTestId(`manual-ai-suggestion-${type}`);
      await panel.waitFor();
      const generate = page.getByTestId(`ai-suggestion-generate-${type}`);
      await generate.waitFor();
      await page.waitForFunction((testId) => (
        document.querySelector(`[data-testid="${testId}"]`)?.disabled === false
      ), `ai-suggestion-generate-${type}`);
      await generate.click();
      const card = panel.getByTestId("ai-result-card");
      await card.waitFor();
      assert.equal(await card.getAttribute("data-status"), "pending");
      assert.match(await card.locator(".ai-result-card-confidence").innerText(), /%/);
      assert.ok(await card.locator(".ai-result-card-evidence-list li").count() >= 1);
      const draft = card.getByTestId("ai-result-card-draft");
      await draft.fill(`${type} 人工调整后的验收草稿`);
      const postCountBeforeReview = aiSuggestionRequests.filter((item) => item.method === "POST").length;

      if (action === "refresh-confirm") {
        await page.reload({ waitUntil: "networkidle" });
        await panel.waitFor();
        const restoredCard = panel.getByTestId("ai-result-card");
        await restoredCard.waitFor();
        assert.equal(await restoredCard.getAttribute("data-status"), "pending");
        assert.equal(await restoredCard.getAttribute("data-readonly"), "false");
        assert.equal(await restoredCard.getByTestId("ai-result-card-draft").count(), 1);
        assert.equal(await restoredCard.getByTestId("ai-result-card-confirm").isEnabled(), true);
        assert.equal(await restoredCard.getByRole("button", { name: "取消本次建议" }).isEnabled(), true);
        assert.equal(
          aiSuggestionRequests.filter((item) => item.method === "POST").length,
          postCountBeforeReview,
          "reload must restore pending history through GET without rerunning the model",
        );
        await restoredCard.getByTestId("ai-result-card-draft").fill(`${type} 刷新后人工确认草稿`);
        await restoredCard.getByTestId("ai-result-card-confirm").click();
        await page.waitForFunction((testId) => (
          document.querySelector(`[data-testid="${testId}"] [data-testid="ai-result-card"]`)?.dataset.status === "confirmed"
        ), `manual-ai-suggestion-${type}`);
        assert.match(await panel.locator(".editor-status").innerText(), /均未自动修改/u);
      } else if (action === "confirm") {
        await card.getByTestId("ai-result-card-confirm").click();
        await page.waitForFunction((testId) => (
          document.querySelector(`[data-testid="${testId}"] [data-testid="ai-result-card"]`)?.dataset.status === "confirmed"
        ), `manual-ai-suggestion-${type}`);
        assert.match(await panel.locator(".editor-status").innerText(), /均未自动修改/u);
      } else if (action === "cancel") {
        await card.getByRole("button", { name: "取消本次建议" }).click();
        await page.waitForFunction((testId) => (
          document.querySelector(`[data-testid="${testId}"] [data-testid="ai-result-card"]`)?.dataset.status === "cancelled"
        ), `manual-ai-suggestion-${type}`);
        assert.match(await panel.locator(".editor-status").innerText(), /没有写入任何业务档案/u);
      }

      const history = panel.getByTestId(`ai-suggestion-history-${type}`).getByRole("button").first();
      await history.click();
      await page.waitForFunction((testId) => (
        document.querySelector(`[data-testid="${testId}"] [data-testid="ai-result-card"]`)?.dataset.readonly === "true"
      ), `manual-ai-suggestion-${type}`);
      assert.equal(await panel.getByTestId("ai-result-card-draft").count(), 0);
      assert.equal(
        aiSuggestionRequests.filter((item) => item.method === "POST").length,
        action ? postCountBeforeReview + 1 : postCountBeforeReview,
        "opening a history snapshot must not generate or mutate a suggestion",
      );
      const layout = await panel.evaluate((element) => ({
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: element.scrollWidth - element.clientWidth,
        controls: [...element.querySelectorAll("button, textarea")].map((control) => {
          const rect = control.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        }),
      }));
      assert.equal(layout.pageOverflow, 0);
      assert.ok(layout.panelOverflow <= 1, `AI suggestion panel overflow ${layout.panelOverflow}px`);
      assert.ok(layout.controls.every((control) => control.width > 0 && control.height >= 44));
      return layout;
    }

    for (const module of ["customer", "opportunity", "knowledge", "itinerary"]) {
      await page.getByTestId(`nav-${module}`).click();
      const createAction = page.getByTestId(`${module}-create-detail`);
      await createAction.waitFor();
      assert.equal(
        await createAction.evaluate((element) => Boolean(element.closest(".panel-title"))),
        true,
        `${module} create action should live inside its list panel header`,
      );
    }
    const itineraryDate = page.locator(".itinerary-date-tile").first();
    const itineraryDateParts = await itineraryDate.evaluate((element) => ({
      label: element.getAttribute("aria-label"),
      month: element.querySelector(".itinerary-date-month")?.textContent?.trim(),
      day: element.querySelector(".itinerary-date-day")?.textContent?.trim(),
      weekday: element.querySelector(".itinerary-date-weekday")?.textContent?.trim(),
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
    }));
    assert.match(itineraryDateParts.label, /^\d{4}年\d{1,2}月\d{1,2}日 周[日一二三四五六]$/);
    assert.match(itineraryDateParts.month, /^\d{1,2}月$/);
    assert.match(itineraryDateParts.day, /^\d{2}$/);
    assert.match(itineraryDateParts.weekday, /^周[日一二三四五六]$/);
    assert.ok(itineraryDateParts.width >= 70 && itineraryDateParts.height >= 60);

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopItineraryMetrics = await shellMetrics(page);
    assert.equal(desktopItineraryMetrics.overflowX, 0);
    assert.deepEqual(desktopItineraryMetrics.undersized, []);
    assert.ok(await page.getByTestId("itinerary-create-detail").evaluate(
      (element) => element.getBoundingClientRect().height >= 44,
    ));
    const desktopScreenshotPath = resolve(evidenceDirectory, "webkit-itinerary-1440x900.png");
    await page.screenshot({ path: desktopScreenshotPath, fullPage: false });

    await page.getByTestId("nav-expense").click();
    await assertExpensePageReady(page);
    const desktopExpenseMetrics = await shellMetrics(page);
    assert.equal(desktopExpenseMetrics.overflowX, 0);
    assert.deepEqual(desktopExpenseMetrics.undersized, []);
    const desktopExpenseScreenshotPath = resolve(evidenceDirectory, "webkit-expense-1440x900.png");
    await page.screenshot({ path: desktopExpenseScreenshotPath, fullPage: false });

    assert.equal(await page.getByTestId("expense-tab-export").count(), 0);
    const reimbursementActions = page.getByTestId("ledger-reimbursement-actions");
    await reimbursementActions.waitFor();
    assert.equal(await reimbursementActions.getByRole("button").count(), 2);
    assert.equal(await reimbursementActions.getByText("打印费用清单", { exact: true }).count(), 1);
    assert.equal(await reimbursementActions.getByText(/导出费用清单/).count(), 1);

    await page.getByRole("button", { name: "编辑我的负责区域" }).click();
    await page.getByTestId("trip-region-settings-layer").waitFor();
    const desktopRegionScreenshotPath = resolve(evidenceDirectory, "webkit-expense-region-1440x900.png");
    await page.screenshot({ path: desktopRegionScreenshotPath, fullPage: false });
    await page.getByRole("button", { name: "关闭区域设置" }).click();
    await page.getByTestId("trip-region-settings-layer").waitFor({ state: "detached" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("nav-expense").click();
    await assertExpensePageReady(page);
    const mobileExpenseMetrics = await shellMetrics(page);
    assert.equal(mobileExpenseMetrics.overflowX, 0);
    assert.deepEqual(mobileExpenseMetrics.undersized, []);
    const mobileExpenseScreenshotPath = resolve(evidenceDirectory, "webkit-expense-390x844.png");
    await page.screenshot({ path: mobileExpenseScreenshotPath, fullPage: false });
    await page.getByRole("button", { name: "编辑我的负责区域" }).click();
    await page.getByTestId("trip-region-settings-layer").waitFor();
    const mobileRegionScreenshotPath = resolve(evidenceDirectory, "webkit-expense-region-390x844.png");
    await page.screenshot({ path: mobileRegionScreenshotPath, fullPage: false });
    await page.getByRole("button", { name: "关闭区域设置" }).click();
    await page.getByTestId("trip-region-settings-layer").waitFor({ state: "detached" });

    await page.getByTestId("nav-quick").click();
    await page.getByTestId("page-quick").waitFor();
    assert.equal(await page.getByTestId("quick-record-mode-voice").evaluate((item) => item.classList.contains("active")), true);
    const initialMetrics = await shellMetrics(page);
    assert.equal(initialMetrics.visualScale, 1);
    assert.equal(initialMetrics.overflowX, 0);
    assert.ok(initialMetrics.sidebarHeight <= 68, `mobile nav height ${initialMetrics.sidebarHeight}px`);
    assert.match(initialMetrics.logoCurrentSrc, /sent-zhixing-icon\.png$/);
    assert.deepEqual(initialMetrics.undersized, []);

    await page.getByTestId("voice-status").waitFor();
    assert.match(await page.getByTestId("voice-status").innerText(), /改用文本/);
    assert.equal(await page.getByTestId("voice-audio-card").count(), 0);
    assert.equal(await page.getByTestId("voice-upload-control").count(), 0);
    assert.equal(await page.getByRole("button", { name: "录音留存" }).count(), 0);
    await page.getByRole("button", { name: "改用文本" }).waitFor();

    // Exercise the real durable-confirmation page at the target handset size.
    // A long saved summary makes the actual before/after arrays wrap inside the
    // production card rather than relying on a synthetic HTML layout fixture.
    await page.getByTestId("quick-record-mode-text").click();
    await page.getByLabel("快速记录内容").fill(
      "现场拜访日照中医医院，讨论十五五规划和移动云灾备中心，客户要求补齐本地数据中心规划。",
    );
    await page.getByTestId("confirm-ai-analysis").click();
    await page.getByTestId("quick-analysis-result").waitFor();
    const longRequest = `客户要求：${"补齐本地数据中心、灾备中心与迁移边界的逐项规划说明；".repeat(24)}`;
    await page.getByTestId("analysis-summary-request").fill(longRequest);
    await page.getByTestId("save-analysis-modifications").click();
    await page.getByTestId("create-quick-record-confirmation-preview").waitFor({ state: "visible" });
    try {
      await page.waitForFunction(() => (
        document.querySelector('[data-testid="create-quick-record-confirmation-preview"]')?.disabled === false
      ), null, { timeout: 10_000 });
    } catch (error) {
      const saveDiagnostics = await page.evaluate(() => ({
        statuses: [...document.querySelectorAll(".status-text")].map((item) => item.textContent?.trim()),
        saveDisabled: document.querySelector('[data-testid="save-analysis-modifications"]')?.disabled,
        previewDisabled: document.querySelector('[data-testid="create-quick-record-confirmation-preview"]')?.disabled,
      }));
      throw new Error(`quick-record analysis save did not settle: ${JSON.stringify({ saveDiagnostics, failedResponses })}`, { cause: error });
    }
    await page.getByTestId("create-quick-record-confirmation-preview").click();
    await page.locator(".confirmation-preview-item").first().waitFor();

    const previewMetrics = await page.evaluate(() => {
      const controls = [...document.querySelectorAll(".confirmation-preview-actions button")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const overflowCandidates = [...document.querySelectorAll(
        ".confirmation-preview, .confirmation-preview-item, .confirmation-preview-values, .confirmation-preview-values span",
      )].map((element) => ({
        className: element.className,
        overflow: Math.ceil(element.scrollWidth - element.clientWidth),
      })).filter((item) => item.overflow > 1);
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        controls,
        overflowCandidates,
      };
    });
    assert.equal(previewMetrics.overflowX, 0);
    assert.deepEqual(previewMetrics.overflowCandidates, []);
    assert.equal(previewMetrics.controls.length, 3);
    assert.ok(previewMetrics.controls.every((control) => control.width > 0 && control.height >= 44));
    const mobileQuickPreviewScreenshotPath = resolve(evidenceDirectory, "webkit-quick-confirmation-390x844.png");
    await page.getByTestId("quick-record-confirmation-preview").scrollIntoViewIfNeeded();
    await page.screenshot({ path: mobileQuickPreviewScreenshotPath, fullPage: false });

    await page.getByRole("button", { name: "全部确认可写入项" }).click();
    await page.getByText("此预览已进入只读终态").waitFor();
    assert.equal(await page.getByTestId("quick-record-confirmation-preview").getByText("已完成", { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-testid^="analysis-summary-"]').count(), 0);
    assert.equal(await page.getByLabel("快速记录内容").getAttribute("readonly"), "");
    assert.equal(await page.getByTestId("confirm-ai-analysis").isDisabled(), true);
    assert.equal(await page.getByTestId("save-analysis-modifications").isDisabled(), true);

    // The completed V2 preview is the real eligibility signal for a visit
    // temperature proposal. Exercise the same shared AiResultCard used by the
    // other AI surfaces and prove that the pinned numeric draft is read-only
    // while the explicit confirm/cancel actions remain available.
    const temperaturePanel = page.getByTestId("visit-temperature-suggestions");
    await temperaturePanel.scrollIntoViewIfNeeded();
    const temperatureGenerate = temperaturePanel.getByRole("button", { name: "生成当前拜访建议" });
    await temperatureGenerate.waitFor({ state: "visible" });
    await temperatureGenerate.click();
    const temperatureShell = temperaturePanel.locator('[data-testid^="temperature-suggestion-"]').first();
    await temperatureShell.waitFor();
    const temperatureCard = temperatureShell.getByTestId("ai-result-card");
    await temperatureCard.waitFor();
    assert.equal(await temperatureCard.getAttribute("data-status"), "pending");
    assert.equal(await temperatureCard.getAttribute("data-readonly"), "true");
    assert.equal(await temperatureCard.getByTestId("ai-result-card-draft").count(), 0);
    assert.equal(await temperatureCard.getByTestId("ai-result-card-readonly-draft").count(), 1);
    assert.equal(await temperatureCard.getByRole("button", { name: "确认此条" }).isEnabled(), true);
    assert.equal(await temperatureCard.getByRole("button", { name: "取消此条" }).isEnabled(), true);
    assert.equal(await temperaturePanel.getByRole("button", { name: /全部确认/u }).count(), 0);
    const temperatureCardMetrics = await temperatureShell.evaluate((element) => ({
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardOverflow: element.scrollWidth - element.clientWidth,
      controls: [...element.querySelectorAll("button")].map((control) => {
        const rect = control.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    }));
    assert.equal(temperatureCardMetrics.pageOverflow, 0);
    assert.ok(temperatureCardMetrics.cardOverflow <= 1);
    assert.ok(temperatureCardMetrics.controls.every((control) => control.width > 0 && control.height >= 44));
    const mobileTemperatureScreenshotPath = resolve(evidenceDirectory, "webkit-temperature-ai-card-390x844.png");
    await page.screenshot({ path: mobileTemperatureScreenshotPath, fullPage: false });
    const temperatureBefore = readTemperatureWritebackProof(databaseUrl);
    assert.ok(temperatureBefore?.suggestion);
    assert.ok(temperatureBefore?.customer);
    assert.equal(temperatureBefore.suggestion.status, "pending");
    assert.equal(temperatureBefore.customer.id, temperatureBefore.suggestion.customer_id);
    assert.equal(temperatureBefore.customer.version, temperatureBefore.suggestion.customer_version);
    assert.equal(temperatureBefore.customer.relation, temperatureBefore.suggestion.previous_value);
    assert.equal(temperatureBefore.relationUpdateAuditCount, 0);
    await temperatureCard.getByRole("button", { name: "确认此条" }).click();
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="visit-temperature-suggestions"] [data-testid="ai-result-card"]')?.dataset.status === "confirmed"
    ));
    assert.equal(await temperatureCard.getAttribute("data-readonly"), "true");
    assert.equal(await temperatureCard.getByRole("button", { name: "确认此条" }).count(), 0);
    assert.equal(temperatureConfirmRequests.length, 1);
    const temperatureAfter = readTemperatureWritebackProof(databaseUrl);
    assert.equal(temperatureAfter.suggestion.id, temperatureBefore.suggestion.id);
    assert.equal(temperatureAfter.suggestion.status, "confirmed");
    assert.equal(temperatureAfter.customer.relation, temperatureBefore.suggestion.suggested_value);
    assert.equal(temperatureAfter.customer.version, temperatureBefore.customer.version + 1);
    assert.equal(temperatureAfter.suggestion.confirmed_relation, temperatureAfter.customer.relation);
    assert.equal(temperatureAfter.suggestion.confirmed_customer_version, temperatureAfter.customer.version);
    assert.equal(temperatureAfter.relationUpdateAuditCount, 1);
    await page.getByTestId("new-quick-record").click();

    await page.getByTestId("nav-customer").click();
    await page.getByTestId("customer-list-view").waitFor();
    await page.getByTestId("customer-open-detail").first().click();
    await page.getByTestId("customer-detail-view").waitFor();
    assert.equal(await page.getByTestId("customer-editor").count(), 0);
    await page.getByTestId("customer-edit-detail").click();
    await page.getByTestId("customer-editor").waitFor();
    const levelField = page.getByTestId("customer-editor").locator(".form-field").filter({ hasText: "级别" }).locator("input");
    const originalLevel = await levelField.inputValue();
    await levelField.fill("不应保存");
    await page.getByTestId("customer-cancel-edit").click();
    await page.getByTestId("customer-editor").waitFor({ state: "detached" });
    await page.getByTestId("customer-edit-detail").click();
    assert.equal(await levelField.inputValue(), originalLevel);
    const editorHeights = await page.getByTestId("customer-editor").locator("input, select").evaluateAll(
      (items) => items.map((item) => Math.round(item.getBoundingClientRect().height)),
    );
    assert.ok(editorHeights.every((height) => height >= 44), `mobile editor heights: ${editorHeights.join(",")}`);
    await page.getByTestId("customer-cancel-edit").click();
    await page.getByTestId("customer-delete-detail").click();
    await page.getByTestId("customer-delete-dialog").waitFor();
    await page.getByTestId("customer-delete-cancel").click();
    await page.getByTestId("customer-delete-dialog").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("customer-detail-view").count(), 1);

    const customerAiCardMetrics = await exerciseAiSuggestionCard({
      module: "customer",
      type: "customer_profile",
      action: "confirm",
    });
    const opportunityAiCardMetrics = await exerciseAiSuggestionCard({
      module: "opportunity",
      type: "opportunity_push",
      action: "cancel",
    });
    const knowledgeAiCardMetrics = await exerciseAiSuggestionCard({
      module: "knowledge",
      type: "knowledge_talk",
      action: "refresh-confirm",
    });
    const mobileAiCardScreenshotPath = resolve(evidenceDirectory, "webkit-ai-result-card-390x844.png");
    await page.getByTestId("manual-ai-suggestion-knowledge_talk").scrollIntoViewIfNeeded();
    await page.screenshot({ path: mobileAiCardScreenshotPath, fullPage: false });

    await page.getByTestId("nav-quick").click();
    await page.getByTestId("quick-record-mode-text").click();
    await page.getByTestId("nav-customer").click();
    await page.getByTestId("topbar-quick-record").click();
    assert.equal(await page.getByTestId("quick-record-mode-voice").evaluate((item) => item.classList.contains("active")), true);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByTestId("nav-itinerary").click();
    await page.getByTestId("itinerary-list-view").waitFor();
    const smallMetrics = await shellMetrics(page);
    assert.equal(smallMetrics.visualScale, 1);
    assert.equal(smallMetrics.overflowX, 0);
    assert.ok(smallMetrics.sidebarHeight <= 68, `small mobile nav height ${smallMetrics.sidebarHeight}px`);
    assert.deepEqual(smallMetrics.undersized, []);

    const screenshotPath = resolve(evidenceDirectory, "webkit-iphone-360x800.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await page.getByTestId("avatar-menu-trigger").click();
    await page.getByTestId("avatar-menu-logout").click();
    await page.getByTestId("login-submit").waitFor();
    assert.deepEqual(failedResponses, []);

    const report = {
      status: "passed",
      engine: "webkit",
      browserVersion: browser.version(),
      viewports: [
        desktopItineraryMetrics,
        desktopExpenseMetrics,
        mobileExpenseMetrics,
        initialMetrics,
        {
          viewport: { width: 390, height: 844 },
          visualScale: 1,
          overflowX: previewMetrics.overflowX,
          nestedOverflow: previewMetrics.overflowCandidates,
          confirmationControls: previewMetrics.controls,
        },
        {
          viewport: { width: 390, height: 844 },
          aiSuggestionCards: {
            customer: customerAiCardMetrics,
            opportunity: opportunityAiCardMetrics,
            knowledge: knowledgeAiCardMetrics,
          },
        },
        {
          viewport: { width: 390, height: 844 },
          temperatureAiCard: temperatureCardMetrics,
          temperatureWriteback: {
            confirmRequests: temperatureConfirmRequests.length,
            customerVersionDelta: temperatureAfter.customer.version - temperatureBefore.customer.version,
            relationUpdateAuditCount: temperatureAfter.relationUpdateAuditCount,
          },
        },
        smallMetrics,
      ],
      checks: {
        listActionsInPanelHeaders: true,
        semanticItineraryDate: true,
        expenseDesktop: true,
        expenseMobile: true,
        expenseTabs,
        expenseNaturalWeek: true,
        expenseNoAlert: true,
        expenseRegionSettings: true,
        voiceFallback: true,
        customerReadOnly: true,
        customerCancel: true,
        customerDeleteCancel: true,
        quickRecordDurablePreview: true,
        quickRecordTerminalReadOnly: true,
        visitTemperatureCompletedPreviewEligible: true,
        visitTemperatureSharedAiCardReadOnlyDraft: true,
        visitTemperatureExplicitConfirm: true,
        visitTemperatureSingleWriteback: true,
        quickRecordVoiceReset: true,
        aiSuggestionCustomerConfirm: true,
        aiSuggestionOpportunityCancel: true,
        aiSuggestionKnowledgePendingRestoredAfterReload: true,
        aiSuggestionKnowledgeHistoryReadOnly: true,
        logout: true,
      },
      screenshots: {
        desktopItinerary: desktopScreenshotPath,
        desktopExpense: desktopExpenseScreenshotPath,
        desktopExpenseRegion: desktopRegionScreenshotPath,
        mobileExpense: mobileExpenseScreenshotPath,
        mobileExpenseRegion: mobileRegionScreenshotPath,
        mobileQuickConfirmation: mobileQuickPreviewScreenshotPath,
        mobileTemperatureAiCard: mobileTemperatureScreenshotPath,
        mobileAiResultCard: mobileAiCardScreenshotPath,
        mobileItinerary: screenshotPath,
      },
    };
    writeFileSync(
      resolve(evidenceDirectory, "webkit-qa-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await closeServer(frontend).catch(() => {});
    await closeServer(backend).catch(() => {});
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}

await main();
