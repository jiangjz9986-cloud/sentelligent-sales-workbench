import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, chromium, webkit } from "playwright";

import { hashPassword } from "../../../backend/src/auth/password.js";
import { createServer as createBackendServer } from "../../../backend/src/server.js";
import {
  createStaticServer,
  createStaticServerConfig,
} from "./static-server.mjs";
import { browserContextIdentity, prepareBrowserEvidence, restrictEvidenceNetwork } from "./browser-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const loginInput = "scroll-wheel-qa-password";

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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function shellMetrics(page) {
  return page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        selector,
        className: String(element.className),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        overflowY: style.overflowY,
        minHeight: style.minHeight,
        display: style.display,
      };
    };
    const content = document.querySelector(".content");
    const pageRoot = document.scrollingElement || document.documentElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      appShell: read(".app-shell"),
      productWindow: read(".product-window"),
      workspace: read(".workspace"),
      pullToRefresh: read(".pull-to-refresh"),
      content: read(".content"),
      document: {
        scrollingElement: pageRoot.tagName,
        scrollTop: pageRoot.scrollTop,
        clientHeight: pageRoot.clientHeight,
        scrollHeight: pageRoot.scrollHeight,
        bodyScrollHeight: document.body.scrollHeight,
      },
      mobileShell: document.querySelector(".app-shell")?.classList.contains("mobile-shell-on") ?? false,
      contentIsPageRoot: content?.parentElement?.classList.contains("pull-to-refresh") ?? false,
    };
  });
}

async function assertPageScrollRoot(page, label) {
  const metrics = await shellMetrics(page);
  assert.equal(metrics.contentIsPageRoot, true, `${label}: content should remain inside PullToRefresh`);
  assert.ok(metrics.content.scrollHeight > metrics.content.clientHeight + 20, `${label}: content needs a vertical scroll range`);
  assert.ok(
    metrics.pullToRefresh.scrollHeight <= metrics.pullToRefresh.clientHeight + 1,
    `${label}: pull-to-refresh wrapper must not become a second scroll root`,
  );
  assert.ok(
    metrics.workspace.scrollHeight <= metrics.workspace.clientHeight + 1,
    `${label}: workspace must stay within the viewport row`,
  );
  assert.ok(
    Math.abs(metrics.pullToRefresh.clientHeight - metrics.workspace.clientHeight) <= 1,
    `${label}: pull-to-refresh wrapper must fill the workspace row`,
  );
  assert.ok(
    metrics.document.scrollHeight <= metrics.document.clientHeight + 1,
    `${label}: document must not own the app page scroll`,
  );
  return metrics;
}

async function assertDesktopWheel(page, label) {
  const content = page.locator(".content");
  await content.evaluate((element) => { element.scrollTop = 0; });
  const box = await content.boundingBox();
  assert.ok(box, `${label}: content should have a measurable viewport`);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(160, box.height / 2));
  await page.mouse.wheel(0, 560);
  await page.waitForTimeout(80);
  const result = await page.evaluate(() => ({
    contentScrollTop: document.querySelector(".content")?.scrollTop ?? 0,
    documentScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
  }));
  assert.ok(result.contentScrollTop > 0, `${label}: mouse wheel should move content.scrollTop`);
  assert.equal(result.documentScrollTop, 0, `${label}: mouse wheel must not move document scrollTop`);
  return result;
}

async function addNestedScrollFixture(page) {
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    if (!content) throw new Error("content scroll root is missing");
    content.scrollTop = 0;
    const spacer = document.createElement("div");
    spacer.style.cssText = "height: 320px";
    const panel = document.createElement("div");
    panel.dataset.testid = "scroll-wheel-nested-panel";
    panel.style.cssText = [
      "height: 140px",
      "overflow-y: auto",
      "margin: 16px 0",
      "border: 1px solid transparent",
    ].join(";");
    const child = document.createElement("div");
    child.style.cssText = "height: 640px";
    panel.append(child);
    content.prepend(panel);
    content.prepend(spacer);
  });
  const panel = page.locator('[data-testid="scroll-wheel-nested-panel"]');
  await panel.waitFor();
  return panel;
}

async function assertNestedBoundaries(page, label) {
  const panel = await addNestedScrollFixture(page);
  const panelBox = await panel.boundingBox();
  assert.ok(panelBox, `${label}: nested panel should be measurable`);
  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const panel = document.querySelector('[data-testid="scroll-wheel-nested-panel"]');
    content.scrollTop = 0;
    panel.scrollTop = 0;
  });
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(80);
  const innerScroll = await page.evaluate(() => ({
    panel: document.querySelector('[data-testid="scroll-wheel-nested-panel"]').scrollTop,
    content: document.querySelector(".content").scrollTop,
  }));
  assert.ok(innerScroll.panel > 0, `${label}: nested panel should consume wheel while it can scroll`);
  assert.equal(innerScroll.content, 0, `${label}: parent should not move before nested panel reaches its edge`);

  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const panel = document.querySelector('[data-testid="scroll-wheel-nested-panel"]');
    content.scrollTop = 0;
    panel.scrollTop = panel.scrollHeight;
  });
  const bottomPanelBox = await panel.boundingBox();
  assert.ok(bottomPanelBox, `${label}: nested panel should remain visible at its bottom edge`);
  await page.mouse.move(bottomPanelBox.x + bottomPanelBox.width / 2, bottomPanelBox.y + bottomPanelBox.height / 2);
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(80);
  const bottomChain = await page.evaluate(() => ({
    panel: document.querySelector('[data-testid="scroll-wheel-nested-panel"]').scrollTop,
    panelMax: document.querySelector('[data-testid="scroll-wheel-nested-panel"]').scrollHeight
      - document.querySelector('[data-testid="scroll-wheel-nested-panel"]').clientHeight,
    content: document.querySelector(".content").scrollTop,
  }));
  assert.equal(Math.round(bottomChain.panel), Math.round(bottomChain.panelMax), `${label}: nested panel should remain at its bottom edge`);
  assert.ok(bottomChain.content > 0, `${label}: wheel should chain to page content at nested bottom edge`);

  await page.evaluate(() => {
    const content = document.querySelector(".content");
    const panel = document.querySelector('[data-testid="scroll-wheel-nested-panel"]');
    content.scrollTop = 300;
    panel.scrollTop = 0;
  });
  const topPanelBox = await panel.boundingBox();
  assert.ok(topPanelBox, `${label}: nested panel should remain visible at its top edge`);
  await page.mouse.move(topPanelBox.x + topPanelBox.width / 2, topPanelBox.y + topPanelBox.height / 2);
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(80);
  const topChain = await page.evaluate(() => ({
    panel: document.querySelector('[data-testid="scroll-wheel-nested-panel"]').scrollTop,
    content: document.querySelector(".content").scrollTop,
  }));
  assert.equal(topChain.panel, 0, `${label}: nested panel should remain at its top edge`);
  assert.ok(topChain.content < 300, `${label}: wheel should chain to page content at nested top edge`);
  await page.locator('[data-testid="scroll-wheel-nested-panel"]').evaluate((element) => element.remove());
  return { innerScroll, bottomChain, topChain };
}

async function assertMobileTouchLayout(page, label, { canWheel }) {
  const metrics = await assertPageScrollRoot(page, label);
  assert.equal(metrics.mobileShell, true, `${label}: mobile viewport should use the mobile shell`);
  const content = page.locator(".content");
  await content.evaluate((element) => { element.scrollTop = 0; });
  if (canWheel) {
    const box = await content.boundingBox();
    assert.ok(box, `${label}: mobile content should be measurable`);
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 2));
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(80);
    assert.ok(
      await content.evaluate((element) => element.scrollTop > 0),
      `${label}: emulated mobile wheel should still move the content root`,
    );
  } else {
    await content.evaluate((element) => { element.scrollTop = 180; });
    assert.equal(
      await content.evaluate((element) => element.scrollTop),
      180,
      `${label}: touch viewport must retain a scrollable content root`,
    );
  }
  return metrics;
}

async function exerciseBrowser(browserType, browserLabel, frontendOrigin, evidenceDirectory, report) {
  const browser = await browserType.launch({ headless: true });
  report.browserVersion = browser.version();
  try {
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      serviceWorkers: "block",
    });
    const desktopBlockedOrigins = await restrictEvidenceNetwork(desktopContext, frontendOrigin);
    await desktopContext.addInitScript(() => localStorage.setItem("sentelligent_disable_sw", "1"));
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto(frontendOrigin, { waitUntil: "networkidle" });
    report.desktopBrowser = await browserContextIdentity(desktopPage, browser, browserLabel);
    await desktopPage.getByLabel("账号").fill("jiangjz");
    await desktopPage.locator('input[aria-label="密码"]').fill(loginInput);
    await desktopPage.getByTestId("login-submit").click();
    await desktopPage.getByTestId("page-overview").waitFor();
    await desktopPage.waitForTimeout(120);
    const desktopRoot = await assertPageScrollRoot(desktopPage, `${browserLabel}/desktop`);
    const wheel = await assertDesktopWheel(desktopPage, `${browserLabel}/desktop`);
    const desktopScreenshot = resolve(evidenceDirectory, `scroll-${browserLabel}-desktop-1440x900.png`);
    await desktopPage.screenshot({ path: desktopScreenshot, fullPage: false });
    const nested = await assertNestedBoundaries(desktopPage, `${browserLabel}/desktop`);
    report.desktop = { root: desktopRoot, wheel, nested, screenshot: desktopScreenshot };
    assert.deepEqual(desktopBlockedOrigins, [], "desktop: only local synthetic fixture traffic is allowed");
    await desktopContext.close();

    const mobileContext = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      locale: "zh-CN",
      serviceWorkers: "block",
    });
    const mobileBlockedOrigins = await restrictEvidenceNetwork(mobileContext, frontendOrigin);
    await mobileContext.addInitScript(() => localStorage.setItem("sentelligent_disable_sw", "1"));
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(frontendOrigin, { waitUntil: "networkidle" });
    report.mobileBrowser = await browserContextIdentity(mobilePage, browser, browserLabel);
    await mobilePage.getByLabel("账号").fill("jiangjz");
    await mobilePage.locator('input[aria-label="密码"]').fill(loginInput);
    await mobilePage.getByTestId("login-submit").click();
    await mobilePage.getByTestId("page-overview").waitFor();
    await mobilePage.waitForTimeout(120);
    report.mobile = await assertMobileTouchLayout(
      mobilePage,
      `${browserLabel}/mobile`,
      { canWheel: browserLabel === "chromium" },
    );
    report.mobileVerification = browserLabel === "chromium" ? "emulated-mobile-wheel" : "programmatic-scrollability-not-touch-gesture";
    report.mobileScreenshot = resolve(evidenceDirectory, `scroll-${browserLabel}-mobile-390x844.png`);
    await mobilePage.screenshot({ path: report.mobileScreenshot, fullPage: false });
    assert.deepEqual(mobileBlockedOrigins, [], "mobile: only local synthetic fixture traffic is allowed");
    await mobileContext.close();
  } finally {
    await browser.close();
  }
  return report;
}

async function main() {
  const evidence = prepareBrowserEvidence({
    workspaceRoot,
    suite: "scroll-wheel",
    outputRoot: process.env.SCROLL_WHEEL_EVIDENCE_DIR,
  });
  const runtimeDirectory = mkdtempSync(resolve(tmpdir(), "sentelligent-scroll-wheel-qa-"));
  const report = { status: "failed", acceptanceScope: "synthetic-local-scroll-regression", browsers: [] };
  let backend;
  let frontend;
  try {
  const frontendPort = await freePort();
  const backendPort = await freePort();
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  backend = createBackendServer({
    databaseUrl: resolve(runtimeDirectory, "scroll-wheel.sqlite"),
    seed: true,
    nodeEnv: "test",
    host: "127.0.0.1",
    port: backendPort,
    aiAnalysisMode: "mock",
    modelApiKey: "",
    authRequired: true,
    authAccount: "jiangjz",
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
    distPath: evidence.distPath,
    runtimeRoot: resolve(runtimeDirectory, "frontend-runtime"),
  }));

    await listen(backend, backendPort);
    await listen(frontend, frontendPort);
    for (const [label, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
      const browserReport = { engine: label };
      report.browsers.push(browserReport);
      await exerciseBrowser(browserType, label, frontendOrigin, evidence.directory, browserReport);
    }
    report.status = "passed";
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    await closeServer(frontend).catch(() => {});
    await closeServer(backend).catch(() => {});
    rmSync(runtimeDirectory, { recursive: true, force: true });
    evidence.finish(report);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: evidence.reportPath, git: evidence.identity.git }, null, 2)}\n`);
}

await main();
