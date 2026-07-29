import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, webkit } from "playwright";

import { hashPassword } from "../../../backend/src/auth/password.js";
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
      const rect = element.closest(".search-box, .itinerary-filter, .voice-file-button")
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
      const target = element.closest(".search-box, .itinerary-filter, .voice-file-button") ?? element;
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

function installSafariVoiceFallback() {
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });

  const track = { stop() {} };
  const stream = { getTracks: () => [track] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });

  class TestMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(mediaStream) {
      this.stream = mediaStream;
      this.mimeType = "audio/webm";
      this.state = "inactive";
    }

    start() {
      this.state = "recording";
      this.onstart?.();
    }

    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["webkit-audio-fixture"], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }

  Object.defineProperty(window, "MediaRecorder", {
    configurable: true,
    value: TestMediaRecorder,
  });
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
  const backend = createBackendServer({
    databaseUrl: resolve(runtimeDirectory, "webkit.sqlite"),
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
    await context.addInitScript(installSafariVoiceFallback);
    const page = await context.newPage();
    const failedResponses = [];
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

    await page.getByTestId("nav-quick").click();
    await page.getByTestId("page-quick").waitFor();
    assert.equal(await page.getByTestId("quick-record-mode-voice").evaluate((item) => item.classList.contains("active")), true);
    const initialMetrics = await shellMetrics(page);
    assert.equal(initialMetrics.visualScale, 1);
    assert.equal(initialMetrics.overflowX, 0);
    assert.ok(initialMetrics.sidebarHeight <= 68, `mobile nav height ${initialMetrics.sidebarHeight}px`);
    assert.match(initialMetrics.logoCurrentSrc, /sent-zhixing-icon\.png$/);
    assert.deepEqual(initialMetrics.undersized, []);

    await page.getByRole("button", { name: /录音留存|开始转写/ }).click();
    await page.getByRole("button", { name: "停止录音" }).click();
    await page.getByTestId("voice-audio-card").waitFor();
    assert.equal(await page.getByTestId("voice-audio-card").locator("audio").count(), 1);
    assert.equal(await page.getByTestId("voice-audio-card").locator("a[download]").count(), 1);

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

    await page.getByTestId("nav-quick").click();
    await page.getByTestId("quick-record-mode-text").click();
    await page.getByTestId("nav-customer").click();
    await page.getByTestId("topbar-quick-record").click();
    assert.equal(await page.getByTestId("quick-record-mode-voice").evaluate((item) => item.classList.contains("active")), true);

    await page.setViewportSize({ width: 360, height: 800 });
    const smallMetrics = await shellMetrics(page);
    assert.equal(smallMetrics.visualScale, 1);
    assert.equal(smallMetrics.overflowX, 0);
    assert.ok(smallMetrics.sidebarHeight <= 68, `small mobile nav height ${smallMetrics.sidebarHeight}px`);
    assert.deepEqual(smallMetrics.undersized, []);

    const screenshotPath = resolve(evidenceDirectory, "webkit-iphone-360x800.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await page.getByTitle("退出登录").click();
    await page.getByTestId("login-submit").waitFor();
    assert.deepEqual(failedResponses, []);

    const report = {
      status: "passed",
      engine: "webkit",
      browserVersion: browser.version(),
      viewports: [initialMetrics, smallMetrics],
      checks: {
        voiceFallback: true,
        customerReadOnly: true,
        customerCancel: true,
        customerDeleteCancel: true,
        quickRecordVoiceReset: true,
        logout: true,
      },
      screenshot: screenshotPath,
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
