import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { webkit } from "playwright";
import { createServer as createViteServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

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

async function chipCities(page) {
  return page.evaluate(() => [...document.querySelectorAll(
    '.trip-region-city-chips > span',
  )].map((chip) => chip.firstChild?.textContent ?? ""));
}

test("keeps the live region draft intact across background workbench polls", async (context) => {
  const port = await freePort();
  const vite = await createViteServer({
    root: appRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await vite.listen();
  context.after(() => vite.close());

  const browser = await webkit.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/trip-region-settings-harness.html`);
  await page.waitForSelector("[data-trip-region-focus-fallback]");

  // The card can open before the first profile arrives; the draft must
  // initialize exactly once when the profile first becomes available.
  await page.evaluate(() => {
    window.__openCard();
  });
  await page.waitForSelector('[data-testid="trip-region-settings-layer"]');
  assert.equal(await page.locator(".trip-region-settings-body").count(), 0);
  await page.evaluate(() => {
    window.__deliverProfile(3);
  });
  await page.waitForSelector(".trip-region-settings-body");

  await page.fill('input[aria-label="新增负责城市"]', "济宁");
  await page.click(".trip-region-city-input button");
  assert.deepEqual(await chipCities(page), ["济宁"]);

  // A half-typed second city plus the added chip must both survive repeated
  // background polls that replace the profile object identity.
  await page.fill('input[aria-label="新增负责城市"]', "东营");
  await page.evaluate(() => {
    window.__pollWorkbench(3);
    window.__pollWorkbench(3);
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="poll-count"]')?.textContent === "2"
  ));
  assert.deepEqual(await chipCities(page), ["济宁"]);
  assert.equal(await page.inputValue('input[aria-label="新增负责城市"]'), "东营");

  // Even a server-side version bump while editing must not clear the draft;
  // conflicts surface on save through the existing 409 copy instead.
  await page.evaluate(() => {
    window.__pollWorkbench(4);
  });
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="poll-count"]')?.textContent === "3"
  ));
  assert.deepEqual(await chipCities(page), ["济宁"]);

  await page.click(".trip-region-city-input button");
  assert.deepEqual(await chipCities(page), ["济宁", "东营"]);

  // Closing resets the once-per-open guard: reopening must rebuild the draft
  // from the latest polled profile instead of resurrecting the stale edit.
  await page.evaluate(() => {
    window.__closeCard();
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="trip-region-settings-layer"]'));
  await page.evaluate(() => {
    window.__pollWorkbench(5);
    window.__openCard();
  });
  await page.waitForSelector(".trip-region-settings-body");
  assert.deepEqual(await chipCities(page), []);
  assert.equal(await page.inputValue('input[aria-label="新增负责城市"]'), "");
});
