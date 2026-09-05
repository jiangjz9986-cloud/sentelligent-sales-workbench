import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { webkit } from "playwright";
import { createServer as createViteServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const sharedId = "shared-suggestion";

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

async function sharedCard(page) {
  const card = page.locator(`[data-suggestion-id="${sharedId}"]`);
  await card.first().waitFor();
  return card.first();
}

async function assertSharedVersion(page, version, statusText = null) {
  const card = await sharedCard(page);
  assert.match(await card.innerText(), new RegExp(`版本 ${version}(?:\\D|$)`, "u"));
  if (statusText) assert.match(await card.innerText(), new RegExp(statusText, "u"));
  assert.equal(await card.getAttribute("data-suggestion-id"), sharedId);
}

test("uses the same persisted suggestion across Overview, customer, opportunity, Xiaoxiao, pagination, refresh, and relogin", {
  timeout: 60_000,
}, async () => {
  const port = await freePort();
  const vite = await createViteServer({
    root: appRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await vite.listen();
  let browser;
  try {
    browser = await webkit.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/proactive-cross-entry-harness.html`);

    await assertSharedVersion(page, 1, "待处理");
    await page.getByTestId("proactive-notification-summary").getByText("1 条未读通知", { exact: true }).waitFor();
    const overviewNotification = page.getByTestId(`proactive-notification-state-${sharedId}`);
    await overviewNotification.getByText("微信 · 待发送", { exact: true }).waitFor();
    await overviewNotification.getByText("未读", { exact: true }).waitFor();
    assert.equal(
      (await page.evaluate(() => window.__proactiveNotificationCalls)).filter((call) => call.type === "read").length,
      0,
    );

    await page.getByTestId("show-customer").click();
    await page.getByText("状态和确认字段提交后，刷新将以服务端回读为准。", { exact: true }).waitFor();
    await assertSharedVersion(page, 1, "待处理");
    let calls = await page.evaluate(() => window.__proactiveCalls);
    assert.deepEqual(calls.slice(-2).map(({ customerId, limit, offset, includeHistory }) => ({ customerId, limit, offset, includeHistory })), [
      { customerId: "cross-customer", limit: 100, offset: 0, includeHistory: true },
      { customerId: "cross-customer", limit: 100, offset: 100, includeHistory: true },
    ]);

    await page.getByTestId("show-opportunity").click();
    await page.getByText("状态和确认字段提交后，刷新将以服务端回读为准。", { exact: true }).waitFor();
    await assertSharedVersion(page, 1, "待处理");
    calls = await page.evaluate(() => window.__proactiveCalls);
    assert.deepEqual(calls.slice(-2).map(({ opportunityId, limit, offset, includeHistory }) => ({ opportunityId, limit, offset, includeHistory })), [
      { opportunityId: "cross-opportunity", limit: 100, offset: 0, includeHistory: true },
      { opportunityId: "cross-opportunity", limit: 100, offset: 100, includeHistory: true },
    ]);

    await page.getByTestId("show-chat").click();
    await page.locator(".assistant-proactive-queue-item-title", { hasText: "同一条跨入口建议" }).waitFor();
    await page.getByTestId("assistant-proactive-unread-count").getByText("1 条未读", { exact: true }).waitFor();
    const chatNotification = page.getByTestId(`assistant-proactive-notification-${sharedId}`);
    await chatNotification.getByText("微信 · 待发送 · 未读", { exact: true }).waitFor();
    calls = await page.evaluate(() => window.__proactiveCalls);
    assert.deepEqual(calls.slice(-2).map(({ limit, offset, includeHistory }) => ({ limit, offset, includeHistory })), [
      { limit: 100, offset: 0, includeHistory: true },
      { limit: 100, offset: 100, includeHistory: true },
    ]);
    await page.getByTestId("assistant-proactive-mark-read-shared-notification-v1").click();
    await chatNotification.getByText("微信 · 已读", { exact: true }).waitFor();
    await page.getByTestId("assistant-proactive-unread-count").getByText("0 条未读", { exact: true }).waitFor();
    assert.deepEqual(
      (await page.evaluate(() => window.__proactiveNotificationCalls)).filter((call) => call.type === "read"),
      [{ type: "read", notificationId: "shared-notification-v1" }],
    );
    await page.locator(".assistant-proactive-queue-item", { hasText: "同一条跨入口建议" }).click();
    await assertSharedVersion(page, 1, "待处理");
    await page.getByTestId(`proactive-notification-state-${sharedId}`).getByText("已读", { exact: true }).waitFor();

    await page.getByTestId("proactive-lifecycle-action-deferred").first().click();
    await page.locator(`[data-suggestion-id="${sharedId}"]`, { hasText: "版本 2" }).waitFor();
    await assertSharedVersion(page, 2, "稍后");

    await page.getByTestId("show-customer").click();
    await page.locator(`[data-suggestion-id="${sharedId}"]`, { hasText: "版本 2" }).waitFor();
    await assertSharedVersion(page, 2, "稍后");
    await page.getByTestId("proactive-assistant-refresh").click();
    await page.locator(`[data-suggestion-id="${sharedId}"]`, { hasText: "版本 3" }).waitFor();
    await assertSharedVersion(page, 3, "稍后");

    await page.getByTestId("show-overview").click();
    await assertSharedVersion(page, 3, "稍后");

    await page.getByTestId("relogin").click();
    await page.getByTestId("session-epoch").getByText("2", { exact: true }).waitFor();
    await page.locator(`[data-suggestion-id="${sharedId}"]`, { hasText: "版本 3" }).waitFor();
    await assertSharedVersion(page, 3, "稍后");
  } finally {
    if (browser) await browser.close();
    await vite.close();
  }
});
