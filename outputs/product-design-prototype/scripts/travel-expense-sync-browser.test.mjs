import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

async function openHarness(context, mode) {
  const port = await freePort();
  const vite = await createViteServer({
    root: appRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await vite.listen();
  context.after(() => vite.close());

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/travel-expense-sync-harness.html?mode=${mode}`);
  return page;
}

test("renders the ledger after a successful weekly workbench read", async (context) => {
  const page = await openHarness(context, "successful-load");

  const ledger = page.locator('[data-testid="expense-ledger-workbench"][aria-busy="false"]');
  await ledger.waitFor();
  assert.equal(await page.evaluate(() => window.__travelExpenseWorkbenchReads), 1);
  assert.equal(await page.locator('[data-testid="expense-ledger-workbench"][role="alert"]').count(), 0);
  assert.notEqual(await page.locator(".expense-week-stat").nth(1).locator("strong").textContent(), "正在同步");
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("ends a persistent conflict in a visible failure state with its request id", async (context) => {
  const page = await openHarness(context, "persistent-conflict");

  const alert = page.locator(".expense-page-alert.is-error");
  await alert.waitFor();
  assert.equal(await page.evaluate(() => window.__travelExpenseWorkbenchReads), 1);
  assert.match(await alert.textContent(), /SHORTCUT_LEDGER_RECEIPT_INCOMPLETE/u);
  assert.match(await alert.textContent(), /fixture-final-conflict/u);
  assert.equal(await page.locator(".expense-week-stat").nth(1).locator("strong").textContent(), "同步失败");
  assert.equal(await page.locator('[data-testid="expense-ledger-workbench"]').count(), 0);
});
