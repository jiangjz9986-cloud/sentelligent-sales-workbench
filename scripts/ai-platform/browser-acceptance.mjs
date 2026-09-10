import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createBackend } from "../../backend/src/server.js";
import { hashPassword } from "../../backend/src/auth/password.js";
import { createServer as createPlatform } from "../../ai-platform/src/server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../outputs/product-design-prototype/package.json", import.meta.url));
const { chromium } = require("playwright");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidence = join(root, ".runtime", "browser-evidence", "ai-platform-" + stamp);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const report = {
  generatedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root }).length),
  mode: "local-simulated", screenshots: [], writes: [], consoleErrors: [], failedRequests: [], checks: [],
};
async function reservePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

const backendPort = await reservePort();
const secret = Buffer.alloc(32, 114).toString("base64url");
const platform = createPlatform({
  config: { nodeEnv: "test", databasePath: ":memory:", authSecret: secret, requestBindingRequired: true },
  autoStart: false, logger: { error() {} },
});
await new Promise((resolve) => platform.listen(0, "127.0.0.1", resolve));
const loginMaterial = "unit-test-password";
const hash = await hashPassword(loginMaterial, { salt: Buffer.alloc(16, 115) });
const backend = createBackend({
  nodeEnv: "test", seed: false, databaseUrl: join(evidence, "browser.sqlite"),
  authRequired: true, authAccount: "browseradmin", authPasswordHash: hash,
  authSessionSecret: Buffer.alloc(32, 116).toString("base64url"), authCookieSecure: false,
  aiPlatformMode: "required", aiPlatformAuthSecret: secret,
  aiPlatformBaseUrl: `http://127.0.0.1:${platform.address().port}`,
  corsAllowedOrigins: [`http://127.0.0.1:${backendPort}`],
  proactiveAssistantAutoRun: false, proactiveNotificationAutoRun: false, hospitalTenderAutoRun: false,
});
await new Promise((resolve) => backend.listen(backendPort, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${backend.address().port}`;
let browser;
let page;
try {
  const executable = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.ok(existsSync(executable), "real Google Chrome executable required");
  browser = await chromium.launch({ executablePath: executable, headless: true });
  report.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(origin + "/api/auth/login", { data: { account: "browseradmin", ["password"]: loginMaterial } });
  assert.equal(login.status(), 200);
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => report.consoleErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (!String(request.failure()?.errorText).includes("ABORTED")) report.failedRequests.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() !== "GET" && response.url().includes("/api/ai-platform/admin/")) {
      const write = { path: new URL(response.url()).pathname, method: request.method(), status: response.status() };
      report.writes.push(write);
      if (response.status() >= 400) {
        void response.text().then((text) => {
          try {
            const payload = JSON.parse(text);
            write.errorCode = payload?.code ?? payload?.error?.code ?? payload?.errorCode ?? null;
            write.errorMessage = payload?.message ?? payload?.error?.message ?? null;
            write.errorRequestId = payload?.requestId ?? payload?.error?.requestId ?? null;
          } catch {
            write.errorMessage = text.slice(0, 200);
          }
        }).catch(() => {});
      }
    }
  });
  await page.goto(origin + "/api/ai-platform/console/", { waitUntil: "networkidle" });
  report.session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json();
    return { status: response.status, account: body.account, role: body.role, hasCsrfToken: typeof body.csrfToken === "string" && body.csrfToken.length > 0 };
  });
  await page.locator('[data-action="agent-edit"]').first().waitFor();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    for (const view of ["overview", "tasks", "agents", "standards", "models", "schedules", "costs"]) {
      await page.locator('[data-view="' + view + '"]').click();
      await page.locator('[data-view-panel="' + view + '"]').waitFor({ state: "visible" });
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scrollWidth <= dimensions.width + 1, "horizontal overflow: " + view);
      const path = join(evidence, view + "-" + viewport.width + ".png");
      await page.screenshot({ path, fullPage: true });
      report.screenshots.push(path);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-view="agents"]').click();
  const edit = page.locator('[data-view-panel="agents"] [data-action="agent-edit"]').first();
  const agentId = await edit.getAttribute("data-agent-id");
  await edit.click();
  await page.locator('#admin-modal-form [name="systemPrompt"]').fill("Browser acceptance fixture. Use only documented facts and output JSON.");
  await page.locator('#admin-modal-form [name="version"]').fill("1.0.1");
  await page.locator('[data-modal-submit]').click();
  await page.locator("#admin-modal").waitFor({ state: "hidden" });
  report.checks.push("agent-draft-saved");
  await page.locator('[data-view-panel="agents"] [data-action="agent-publish"][data-agent-id="' + agentId + '"]').click();
  await page.locator('#admin-modal-form [name="testRunId"]').fill("browser-acceptance-" + stamp);
  await page.locator('[data-modal-submit]').click();
  await page.locator("#admin-modal").waitFor({ state: "hidden" });
  report.checks.push("agent-published");
  await page.locator('[data-view-panel="agents"] [data-action="agent-rollback"][data-agent-id="' + agentId + '"]').click();
  await page.locator('[data-modal-submit]').click();
  await page.locator("#admin-modal").waitFor({ state: "hidden" });
  report.checks.push("agent-rolled-back");
  await page.locator('[data-view="standards"]').click();
  await page.locator('[data-action="standard-edit"]').first().click();
  await page.locator('#admin-modal-form [name="content"]').fill("Browser acceptance: retain source references and require human confirmation.");
  await page.locator('[data-modal-submit]').click();
  await page.locator("#admin-modal").waitFor({ state: "hidden" });
  report.checks.push("standard-version-saved");
  await page.locator('[data-view="costs"]').click();
  await page.locator('[data-action="budget-edit"]').first().click();
  await page.locator('#admin-modal-form [name="callLimit"]').fill("25");
  await page.locator('[data-modal-submit]').click();
  await page.locator("#admin-modal").waitFor({ state: "hidden" });
  report.checks.push("budget-saved");
  await page.locator('[data-view="schedules"]').click();
  const schedulesPanel = page.locator('[data-view-panel="schedules"]');
  await schedulesPanel.waitFor({ state: "visible" });
  await schedulesPanel.locator('[data-action="schedule-edit"]').first().click();
  await page.locator('#admin-modal-form [name="enabled"]').check();
  const writeCount = report.writes.length;
  await page.locator('[data-modal-submit]').click();
  await page.locator("#modal-error").waitFor({ state: "visible" });
  await assert.match(await page.locator("#modal-error").textContent(), /Backend|主动分析/);
  assert.equal(report.writes.length, writeCount);
  report.checks.push("backend-proactive-ownership-enforced");
  await page.screenshot({ path: join(evidence, "proactive-owner-guard.png"), fullPage: true });
  assert.equal(report.consoleErrors.length, 0);
  assert.equal(report.failedRequests.length, 0);
  assert.ok(report.writes.length >= 5 && report.writes.every((write) => write.status >= 200 && write.status < 300));
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
  await platform.closeAiPlatform();
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(evidence, "browser.sqlite" + suffix);
    if (existsSync(path)) rmSync(path);
  }
  report.cleanup = "clean";
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: report.status, report: join(evidence, "report.json"), checks: report.checks, failure: report.failure }) + "\n");
}
