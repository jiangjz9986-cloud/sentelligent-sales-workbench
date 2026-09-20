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

test("routes invoice-blocked expense deletion to invoice management without repeating the delete", async (context) => {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/expense-delete-harness.html`);

  const expenseRow = page.locator('[data-ledger-expense-id="expense-delete-test"]:visible');
  const deleteButton = page.locator('[data-testid="expense-delete-ledger"]:visible').first();
  await deleteButton.waitFor();
  assert.equal(await expenseRow.count(), 1);

  await deleteButton.click();
  await page.getByTestId("travel-expense-delete-confirm").click();
  await page.getByRole("heading", { name: "这笔记账暂不能删除" }).waitFor();

  assert.equal(await page.evaluate(() => window.__expenseDeleteAttempts), 1);
  assert.equal(await expenseRow.count(), 1);
  assert.match(await page.locator(".confirm-dialog-error").textContent(), /发票匹配、替票候选、无票确认或待处理凭证/);
  assert.match(await page.locator(".confirm-dialog-error").textContent(), /费用记录和发票原件均未删除/);
  assert.equal(await page.getByTestId("travel-expense-delete-confirm").textContent(), "去处理票据关联");
  assert.equal(await page.getByTestId("travel-expense-delete-confirm").getAttribute("class"), "primary-button");
  await page.screenshot({ path: "/tmp/expense-delete-recovery.png" });

  await page.getByTestId("travel-expense-delete-cancel").click();
  await page.getByTestId("travel-expense-delete-dialog").waitFor({ state: "detached" });
  await deleteButton.click();
  await page.getByRole("heading", { name: "删除这笔记账？" }).waitFor();
  assert.equal(await page.getByTestId("travel-expense-delete-confirm").textContent(), "删除记账");
  await page.getByTestId("travel-expense-delete-cancel").click();

  await deleteButton.click();
  await page.getByTestId("travel-expense-delete-confirm").click();
  await page.getByRole("heading", { name: "这笔记账暂不能删除" }).waitFor();
  assert.equal(await page.evaluate(() => window.__expenseDeleteAttempts), 2);

  await page.getByTestId("travel-expense-delete-confirm").click();
  await page.getByTestId("travel-expense-delete-dialog").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("expense-tab-invoices").getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => window.__expenseDeleteAttempts), 2);

  await page.getByTestId("expense-tab-ledger").click();
  await deleteButton.waitFor();
  await deleteButton.click();
  await page.getByRole("heading", { name: "删除这笔记账？" }).waitFor();
  assert.equal(await page.getByTestId("travel-expense-delete-confirm").textContent(), "删除记账");

  await page.getByTestId("travel-expense-delete-cancel").click();
  await page.getByTestId("travel-expense-delete-dialog").waitFor({ state: "detached" });
  await deleteButton.click();
  await page.getByRole("heading", { name: "删除这笔记账？" }).waitFor();
  assert.equal(await page.getByTestId("travel-expense-delete-confirm").textContent(), "删除记账");
  assert.equal(await page.evaluate(() => window.__expenseDeleteAttempts), 2);
});
