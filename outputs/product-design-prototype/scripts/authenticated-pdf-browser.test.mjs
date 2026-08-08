import assert from "node:assert/strict";
import { createServer as createProbeServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { webkit } from "playwright";
import { createServer as createViteServer } from "vite";

import { multiPagePdf, VALID_PDF } from "../../../backend/tests/helpers/image-fixtures.js";

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

test("keeps four-up printing disabled until PDF.js renders the authenticated PDF Canvas", async (context) => {
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
  let releasePdfResponse;
  const pdfResponseGate = new Promise((resolveGate) => {
    releasePdfResponse = resolveGate;
  });
  context.after(() => releasePdfResponse?.());
  await page.route("**/qa-authenticated-invoice.pdf", async (route) => {
    await pdfResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      body: VALID_PDF,
    });
  });

  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/authenticated-pdf-harness.html`);
  await page.waitForFunction(() => document.querySelector("[data-authenticated-pdf-state]")
    ?.getAttribute("data-authenticated-pdf-state") === "loading");
  const beforeRender = await page.evaluate(() => {
    const button = document.querySelector(".invoice-print-preview-toolbar .primary-button");
    return { disabled: button?.disabled, label: button?.textContent?.trim() };
  });
  assert.equal(beforeRender.disabled, true, JSON.stringify(beforeRender));
  assert.match(beforeRender.label, /加载 PDF/);

  releasePdfResponse();
  await page.waitForFunction(() => document.querySelector("[data-authenticated-pdf-state]")
    ?.getAttribute("data-authenticated-pdf-state") === "ready");

  const result = await page.evaluate(() => ({
    state: document.querySelector("[data-authenticated-pdf-state]")
      ?.getAttribute("data-authenticated-pdf-state"),
    iframeCount: document.querySelectorAll("iframe").length,
    printButton: (() => {
      const button = document.querySelector(".invoice-print-preview-toolbar .primary-button");
      return { disabled: button?.disabled, label: button?.textContent?.trim() };
    })(),
    canvas: (() => {
      const element = document.querySelector("canvas");
      return element ? { width: element.width, height: element.height } : null;
    })(),
  }));
  assert.equal(result.state, "ready", JSON.stringify(result));
  assert.equal(result.iframeCount, 0, JSON.stringify(result));
  assert.equal(result.printButton.disabled, false, JSON.stringify(result));
  assert.match(result.printButton.label, /^打印$/);
  assert.equal(Boolean(result.canvas?.width > 0 && result.canvas?.height > 0), true, JSON.stringify(result));
});

test("retries PDF.js after a transient runtime load failure", async (context) => {
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
  let runtimeFailures = 0;
  await page.route("**/*pdfjs-dist*.js*", async (route) => {
    if (runtimeFailures === 0) {
      runtimeFailures += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.route("**/qa-authenticated-invoice.pdf", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: VALID_PDF,
  }));

  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/authenticated-pdf-harness.html`);
  await page.waitForFunction(() => document.querySelector("[data-authenticated-pdf-state]")
    ?.getAttribute("data-authenticated-pdf-state") === "error");
  await page.locator('[data-authenticated-pdf-state="error"] button').click();
  await page.waitForFunction(() => document.querySelector("[data-authenticated-pdf-state]")
    ?.getAttribute("data-authenticated-pdf-state") === "ready");

  const result = await page.evaluate(() => ({
    state: document.querySelector("[data-authenticated-pdf-state]")
      ?.getAttribute("data-authenticated-pdf-state"),
    canvas: (() => {
      const element = document.querySelector("canvas");
      return element ? { width: element.width, height: element.height } : null;
    })(),
  }));
  assert.equal(runtimeFailures, 1, JSON.stringify({ runtimeFailures, result }));
  assert.equal(result.state, "ready", JSON.stringify(result));
  assert.equal(Boolean(result.canvas?.width > 0 && result.canvas?.height > 0), true, JSON.stringify(result));
});

test("keeps payment-record printing disabled until every authenticated PDF proof Canvas is ready", async (context) => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const releases = [];
  for (const number of [1, 2]) {
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    releases.push(release);
    await page.route(`**/qa-payment-pdf-${number}.pdf`, async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: number === 1 ? multiPagePdf(2, "two-page-payment-proof") : VALID_PDF,
      });
    });
  }
  context.after(() => releases.forEach((release) => release?.()));

  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/authenticated-payment-pdf-harness.html`);
  await page.waitForFunction(() => document.querySelectorAll('[data-authenticated-pdf-state="loading"]').length === 2);
  assert.equal(await page.locator(".expense-print-preview-toolbar .primary-button").isDisabled(), true);

  releases[0]();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-authenticated-pdf-state="ready"]').length === 1
    && document.querySelectorAll('[data-authenticated-pdf-state="loading"]').length === 1
  ));
  assert.equal(await page.locator(".expense-print-preview-toolbar .primary-button").isDisabled(), true);

  releases[1]();
  await page.waitForFunction(() => document.querySelectorAll('[data-authenticated-pdf-state="ready"]').length === 2);
  const beforePrint = await page.evaluate(() => ({
    disabled: document.querySelector(".expense-print-preview-toolbar .primary-button")?.disabled,
    pageCounts: [...document.querySelectorAll(".expense-print-pdf-canvas")]
      .map((frame) => Number(frame.getAttribute("data-pdf-page-count"))),
    canvases: [...document.querySelectorAll(".expense-print-pdf-canvas canvas")].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    })),
  }));
  assert.equal(beforePrint.disabled, false, JSON.stringify(beforePrint));
  assert.deepEqual(beforePrint.pageCounts, [2, 1], JSON.stringify(beforePrint));
  assert.equal(beforePrint.canvases.length, 3, JSON.stringify(beforePrint));
  assert.equal(beforePrint.canvases.every((canvas) => canvas.width > 0 && canvas.height > 0), true, JSON.stringify(beforePrint));

  await page.locator(".expense-print-preview-toolbar .primary-button").click();
  await page.waitForFunction(() => window.__paymentPrintCalls === 1);
  assert.equal(await page.evaluate(() => window.__paymentPrintCalls), 1);
});

test("restores payment-record printing after a failed PDF proof is reloaded", async (context) => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let firstProofRequests = 0;
  await page.route("**/qa-payment-pdf-1.pdf", async (route) => {
    firstProofRequests += 1;
    if (firstProofRequests === 1) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary failure" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/pdf", body: VALID_PDF });
  });
  await page.route("**/qa-payment-pdf-2.pdf", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: VALID_PDF,
  }));

  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/authenticated-payment-pdf-harness.html`);
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-authenticated-pdf-state="error"]').length === 1
    && document.querySelectorAll('[data-authenticated-pdf-state="ready"]').length === 1
  ));
  assert.equal(await page.locator(".expense-print-preview-toolbar .primary-button").isDisabled(), true);
  assert.match(await page.locator(".expense-page-alert").innerText(), /重新加载/);

  await page.locator('[data-authenticated-pdf-state="error"] button').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-authenticated-pdf-state="ready"]').length === 2);

  const recovered = await page.evaluate(() => ({
    disabled: document.querySelector(".expense-print-preview-toolbar .primary-button")?.disabled,
    states: [...document.querySelectorAll("[data-authenticated-pdf-state]")]
      .map((element) => element.getAttribute("data-authenticated-pdf-state")),
    canvases: [...document.querySelectorAll(".expense-print-pdf-canvas canvas")].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    })),
  }));
  assert.equal(firstProofRequests, 2, JSON.stringify({ firstProofRequests, recovered }));
  assert.deepEqual(recovered.states, ["ready", "ready"]);
  assert.equal(recovered.disabled, false, JSON.stringify(recovered));
  assert.equal(recovered.canvases.every((canvas) => canvas.width > 0 && canvas.height > 0), true, JSON.stringify(recovered));

  await page.locator(".expense-print-preview-toolbar .primary-button").click();
  await page.waitForFunction(() => window.__paymentPrintCalls === 1);
  assert.equal(await page.evaluate(() => window.__paymentPrintCalls), 1);
});
