import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { createStaticServer, createStaticServerConfig } from "./static-server.mjs";

const chromePath = findChrome();
const visualApiBaseUrl = "https://visual-api.test";

const viewports = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 834, height: 1194, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

const pages = [
  { name: "overview", navIndex: 0, testId: "page-overview" },
  { name: "quick", navIndex: 1, testId: "page-quick" },
  { name: "customer", navIndex: 2, testId: "page-customer" },
  { name: "opportunity", navIndex: 3, testId: "page-opportunity" },
  { name: "actions", navIndex: 4, testId: "page-actions" },
  { name: "solution", navIndex: 5, testId: "page-solution" },
  { name: "weekly", navIndex: 6, testId: "page-weekly" },
  { name: "risk", navIndex: 7, testId: "page-risk" },
  { name: "knowledge", navIndex: 8, testId: "page-knowledge" },
  { name: "kanban", navIndex: 9, testId: "page-kanban" },
  { name: "weixin", navIndex: 10, testId: "page-weixin" },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge executable was not found. Set CHROME_PATH to run visual rhythm QA.");
  return found;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
    server.on("error", reject);
  });
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk.toString();
  });
  return child;
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  await new Promise((resolveStop) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("close", resolveStop);
    killer.on("error", resolveStop);
  });
}

function connectCdp(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });

    ws.addEventListener(
      "open",
      () => {
        resolveConnect({
          ws,
          send(method, params = {}) {
            const callId = ++id;
            ws.send(JSON.stringify({ id: callId, method, params }));
            return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
          },
        });
      },
      { once: true },
    );
    ws.addEventListener("error", reject, { once: true });
  });
}

async function openChromeCdp({ failFirstBootstrap = false } = {}) {
  const profilePath = mkdtempSync(join(tmpdir(), "sent-zx-visual-chrome-"));
  const chrome = spawnManaged(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "about:blank",
  ]);

  const portFile = join(profilePath, "DevToolsActivePort");
  let port = "";
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(portFile)) {
      port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
      if (port) break;
    }
    await delay(100);
  }
  if (!port) throw new Error("Timed out waiting for Chrome DevTools port.");

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = targets.find((item) => item.type === "page");
  if (!page) throw new Error("No Chrome page target found for visual rhythm QA.");
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      const nativeFetch = window.fetch.bind(window);
      window.__visualApiCalls = {};
      window.fetch = async (input, init) => {
        const requestUrl = String(typeof input === 'string' ? input : input?.url ?? '');
        if (requestUrl.startsWith('${visualApiBaseUrl}/api/')) {
          const pathname = new URL(requestUrl).pathname;
          window.__visualApiCalls[pathname] = (window.__visualApiCalls[pathname] ?? 0) + 1;
          const isSession = pathname === '/api/auth/session';
          const isCollection = [
            '/api/customers',
            '/api/opportunities',
            '/api/actions',
            '/api/risks',
            '/api/knowledge',
            '/api/quick-records',
            '/api/solutions',
          ].includes(pathname);
          const isSummary = pathname === '/api/dashboard/summary';
          const isBootstrap = isCollection || isSummary;
          const shouldFail = ${JSON.stringify(failFirstBootstrap)}
            && isBootstrap
            && window.__visualApiCalls[pathname] === 1;
          if (shouldFail) {
            return new Response(JSON.stringify({
              error: { code: 'VISUAL_QA_BOOTSTRAP_FAILURE', message: 'First bootstrap failed' },
            }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const body = isSession
            ? {
                account: 'visual-qa',
                displayName: 'visual-qa',
                expiresAt: '2099-01-01T00:00:00.000Z',
                csrfToken: 'visual-csrf',
              }
            : isCollection
              ? { items: [] }
              : isSummary
                ? {
                    item: {
                      metrics: {},
                      priorityActions: [],
                      customerHeat: [],
                      recentRecords: [],
                      opportunities: [],
                      rhythm: [],
                      stageCounts: [],
                      generatedAt: '2099-01-01T00:00:00.000Z',
                    },
                  }
            : {
                error: {
                  code: 'VISUAL_QA_OFFLINE',
                  message: 'Visual QA uses local business fixtures',
                  requestId: 'visual-qa',
                },
              };
          return new Response(JSON.stringify(body), {
            status: isSession || isCollection || isSummary ? 200 : 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return nativeFetch(input, init);
      };
    `,
  });

  return {
    ...cdp,
    async close() {
      await cdp.send("Browser.close").catch(() => {});
      cdp.ws.close();
      await stopProcessTree(chrome);
      rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
  return result.result.value;
}

async function measureVisualRhythm(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await cdp.send("Page.navigate", { url });
  await delay(1200);

  return evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const pages = ${JSON.stringify(pages)};
      const round = (value) => Math.round(value);
      const waitUntil = async (predicate, timeoutMs = 5000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out waiting for visual rhythm page condition');
      };
      const visibleRect = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return rect;
      };
      const firstBusinessBlock = (content, heading) => {
        return [...content.children].find((child) => {
          if (child === heading) return false;
          if (child.classList.contains('page-heading')) return false;
          return Boolean(visibleRect(child));
        });
      };
      const results = [];
      await waitUntil(() => document.querySelector('[data-testid="page-overview"]'));
      for (const page of pages) {
        document.querySelectorAll('.nav-item')[page.navIndex]?.click();
        await waitUntil(() => document.querySelector('[data-testid="' + page.testId + '"]'));
        await wait(180);
        const content = document.querySelector('[data-testid="' + page.testId + '"]');
        const heading = content?.querySelector('.page-heading');
        const title = heading?.querySelector('h1');
        const first = firstBusinessBlock(content, heading);
        const contentRect = visibleRect(content);
        const headingRect = visibleRect(heading);
        const titleRect = visibleRect(title);
        const firstRect = visibleRect(first);
        const topInset = contentRect && headingRect ? round(headingRect.top - contentRect.top) : null;
        const titleToFirst = titleRect && firstRect ? round(firstRect.top - titleRect.bottom) : null;
        const headingToFirst = headingRect && firstRect ? round(firstRect.top - headingRect.bottom) : null;
        const firstViewportRatio = firstRect ? Number((firstRect.top / window.innerHeight).toFixed(3)) : null;
        results.push({
          page: page.name,
          h1: title?.textContent?.trim() ?? '',
          topInset,
          titleToFirst,
          headingToFirst,
          firstViewportRatio,
          firstClass: first?.className ?? '',
          firstTop: firstRect ? round(firstRect.top) : null,
          viewportHeight: window.innerHeight,
        });
      }
      return results;
    })()
  `);
}

async function measureDesktopListDensity(cdp, url) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url });
  await delay(1200);

  const listPages = pages.filter((page) => ["customer", "opportunity", "actions", "risk", "knowledge"].includes(page.name));

  return evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const listPages = ${JSON.stringify(listPages)};
      const waitUntil = async (predicate, timeoutMs = 5000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out waiting for list density page condition');
      };
      await waitUntil(() => document.querySelector('[data-testid="page-overview"]'));
      const results = [];
      for (const page of listPages) {
        document.querySelectorAll('.nav-item')[page.navIndex]?.click();
        await waitUntil(() => document.querySelector('[data-testid="' + page.testId + '"]'));
        await wait(180);
        const content = document.querySelector('[data-testid="' + page.testId + '"]');
        const panel = content?.querySelector('.customer-list-panel, .opportunity-list-panel, .action-list-panel, .risk-list-panel, .knowledge-list-panel');
        const contentStyle = getComputedStyle(document.querySelector('.content'));
        const contentRect = document.querySelector('.content').getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        const availableWidth = contentRect.width - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight);
        results.push({
          page: page.name,
          panelWidth: panelRect ? Math.round(panelRect.width) : null,
          availableWidth: Math.round(availableWidth),
          fillRatio: panelRect ? Number((panelRect.width / availableWidth).toFixed(3)) : null,
        });
      }
      return results;
    })()
  `);
}

describe("visual rhythm", () => {
  it("keeps page headings and first business modules visually connected across viewports", async () => {
    assert.equal(existsSync(resolve("dist", "index.html")), true, "run npm run build before visual rhythm QA");

    const port = await getFreePort();
    const server = createStaticServer(createStaticServerConfig({
      port,
      distPath: resolve("dist"),
      apiBaseUrl: visualApiBaseUrl,
    }));
    await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

    let cdp;
    try {
      cdp = await openChromeCdp();
      const allResults = [];
      for (const viewport of viewports) {
        const measurements = await measureVisualRhythm(cdp, `http://127.0.0.1:${port}`, viewport);
        allResults.push(...measurements.map((item) => ({ viewport: viewport.name, ...item })));
      }

      const failures = allResults.filter((item) => {
        const maxTopInset = item.viewport === "mobile" ? 16 : 30;
        const maxTitleGap = item.viewport === "mobile" ? 34 : 42;
        const isEmptyState = item.firstClass === "workbench-state-panel" || /-list-view$/.test(item.firstClass);
        const maxFirstViewportRatio = item.viewport === "desktop"
          ? 0.34
          : item.viewport === "mobile" && isEmptyState
            ? 0.62
            : 0.42;
        return (
          item.topInset === null ||
          item.titleToFirst === null ||
          item.topInset > maxTopInset ||
          item.titleToFirst > maxTitleGap ||
          item.firstViewportRatio > maxFirstViewportRatio
        );
      });

      assert.deepEqual(failures, []);
    } finally {
      if (cdp) await cdp.close();
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it("lets desktop list pages use the available workspace instead of leaving a wide blank gutter", async () => {
    assert.equal(existsSync(resolve("dist", "index.html")), true, "run npm run build before visual rhythm QA");

    const port = await getFreePort();
    const server = createStaticServer(createStaticServerConfig({
      port,
      distPath: resolve("dist"),
      apiBaseUrl: visualApiBaseUrl,
    }));
    await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

    let cdp;
    try {
      cdp = await openChromeCdp();
      const measurements = await measureDesktopListDensity(cdp, `http://127.0.0.1:${port}`);
      const failures = measurements.filter((item) => item.fillRatio === null || item.fillRatio < 0.9);

      assert.deepEqual(failures, []);
    } finally {
      if (cdp) await cdp.close();
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it("retries an empty bootstrap without rendering demo customer or weekly data", async () => {
    assert.equal(existsSync(resolve("dist", "index.html")), true, "run npm run build before visual rhythm QA");

    const port = await getFreePort();
    const server = createStaticServer(createStaticServerConfig({
      port,
      distPath: resolve("dist"),
      apiBaseUrl: visualApiBaseUrl,
    }));
    await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

    let cdp;
    try {
      cdp = await openChromeCdp({ failFirstBootstrap: true });
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}` });
      await delay(1200);
      const result = await evaluate(cdp, `
        (async () => {
          const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
          const waitUntil = async (predicate, timeoutMs = 5000) => {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
              const value = predicate();
              if (value) return value;
              await wait(50);
            }
            throw new Error('Timed out waiting for bootstrap retry state');
          };
          await waitUntil(() => document.querySelector('[data-testid="bootstrap-retry"]'));
          document.querySelector('[data-testid="bootstrap-retry"]').click();
          await waitUntil(() => document.querySelector('[data-testid="workbench-empty"]'));
          document.querySelectorAll('.nav-item')[6]?.click();
          await waitUntil(() => document.querySelector('[data-testid="page-weekly"]'));
          await wait(100);
          return {
            customerBootstrapCalls: window.__visualApiCalls['/api/customers'] ?? 0,
            text: document.querySelector('[data-testid="page-weekly"]')?.innerText ?? '',
          };
        })()
      `);

      assert.equal(result.customerBootstrapCalls, 2);
      assert.match(result.text, /尚未生成周报/);
      assert.doesNotMatch(result.text, /日照中医医院|胜利油田中心医院|黄岛区中医院|黄岛中心医院|680\s*万/);
    } finally {
      if (cdp) await cdp.close();
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
