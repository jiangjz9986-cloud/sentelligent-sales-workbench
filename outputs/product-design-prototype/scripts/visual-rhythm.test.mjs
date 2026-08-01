import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { createStaticServer, createStaticServerConfig } from "./static-server.mjs";

const chromePath = findChrome();
const visualApiBaseUrl = "https://visual-api.test";

const viewports = [
  { name: "desktop-large", width: 1920, height: 1080, mobile: false },
  { name: "desktop-compact", width: 1366, height: 768, mobile: false },
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 834, height: 1194, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "mobile-small", width: 360, height: 800, mobile: true },
];

const mobileShellViewports = viewports.filter((viewport) => viewport.mobile);

const pages = [
  { name: "overview", navIndex: 0, testId: "page-overview" },
  { name: "quick", navIndex: 1, testId: "page-quick" },
  { name: "customer", navIndex: 2, testId: "page-customer" },
  { name: "opportunity", navIndex: 3, testId: "page-opportunity" },
  { name: "actions", navIndex: 4, testId: "page-actions" },
  { name: "itinerary", navIndex: 5, testId: "page-itinerary" },
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

function traceVisualQa(message) {
  if (process.env.VISUAL_QA_TRACE === "1") {
    process.stderr.write(`[visual-qa] ${message}\n`);
  }
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
  const processGroup = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: processGroup,
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
  child.processGroup = processGroup;
  return child;
}

function destroyChildIo(child) {
  child?.stdout?.destroy?.();
  child?.stderr?.destroy?.();
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", handleClose);
      child.off("error", handleError);
      resolveWait(closed);
    };
    const handleClose = () => finish(true);
    const handleError = () => finish(false);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("close", handleClose);
    child.once("error", handleError);
  });
}

function isProcessGone(error) {
  return error?.code === "ESRCH";
}

async function waitForProcessGroupExit(pid, killProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      killProcess(-pid, 0);
    } catch (error) {
      if (isProcessGone(error)) return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
}

function runWindowsTreeKill(child, spawnProcess, timeoutMs) {
  return new Promise((resolveKill, rejectKill) => {
    const killer = spawnProcess(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killer.off("close", handleClose);
      killer.off("error", handleError);
      if (error) rejectKill(error);
      else resolveKill(code);
    };
    const handleClose = (code) => finish(null, code);
    const handleError = (error) => finish(error);
    const timeout = setTimeout(() => {
      killer.kill?.();
      finish(new Error(`taskkill timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    killer.once("close", handleClose);
    killer.once("error", handleError);
  });
}

async function stopProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    killProcess = process.kill,
    timeoutMs = 2_000,
  } = {},
) {
  if (!child?.pid) return;

  try {
    if (platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const taskkillCode = await runWindowsTreeKill(child, spawnProcess, timeoutMs);
      const closed = await waitForChildClose(child, timeoutMs);
      if (!closed) {
        throw new Error(`Chrome process tree did not exit within ${timeoutMs} ms`);
      }
      if (taskkillCode !== 0 && child.exitCode === null && child.signalCode === null) {
        throw new Error(`taskkill exited with code ${taskkillCode}`);
      }
      return;
    }

    if (child.processGroup) {
      try {
        killProcess(-child.pid, "SIGKILL");
      } catch (error) {
        if (!isProcessGone(error)) throw error;
      }
      await waitForChildClose(child, timeoutMs);
      const groupExited = await waitForProcessGroupExit(child.pid, killProcess, timeoutMs);
      if (!groupExited) {
        throw new Error(`Chrome process group did not exit within ${timeoutMs} ms`);
      }
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (!isProcessGone(error)) throw error;
    }
    if (!(await waitForChildClose(child, timeoutMs))) {
      throw new Error(`Chrome process did not exit within ${timeoutMs} ms`);
    }
  } finally {
    destroyChildIo(child);
  }
}

function closeHttpServer(server, timeoutMs) {
  server.closeAllConnections?.();
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectClose(error);
      else resolveClose();
    };
    const timeout = setTimeout(() => {
      finish(new Error(`HTTP server close timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      server.close(finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function closeVisualResources({ cdp, server, serverTimeoutMs = 5_000 }) {
  const errors = [];
  try {
    if (cdp) await cdp.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeHttpServer(server, serverTimeoutMs);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Visual QA resource cleanup failed");
}

function connectCdp(
  wsUrl,
  { commandTimeoutMs = 20_000, connectionTimeoutMs = 5_000 } = {},
) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let opened = false;
    const pending = new Map();

    const rejectPending = (error) => {
      for (const call of pending.values()) call.reject(error);
      pending.clear();
    };

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });

    const connectionTimeout = setTimeout(() => {
      const error = new Error(`CDP connection timed out after ${connectionTimeoutMs} ms`);
      ws.close();
      reject(error);
    }, connectionTimeoutMs);

    ws.addEventListener(
      "open",
      () => {
        opened = true;
        clearTimeout(connectionTimeout);
        resolveConnect({
          ws,
          send(method, params = {}) {
            const callId = ++id;
            return new Promise((resolveCall, rejectCall) => {
              const timeout = setTimeout(() => {
                pending.delete(callId);
                rejectCall(new Error(`${method} timed out after ${commandTimeoutMs} ms`));
              }, commandTimeoutMs);
              const settle = (callback) => (value) => {
                clearTimeout(timeout);
                callback(value);
              };
              pending.set(callId, {
                resolve: settle(resolveCall),
                reject: settle(rejectCall),
              });
              try {
                ws.send(JSON.stringify({ id: callId, method, params }));
              } catch (error) {
                pending.delete(callId);
                clearTimeout(timeout);
                rejectCall(error);
              }
            });
          },
        });
      },
      { once: true },
    );
    ws.addEventListener("error", (event) => {
      const error = event instanceof Error ? event : new Error("CDP WebSocket failed");
      clearTimeout(connectionTimeout);
      if (!opened) reject(error);
      rejectPending(error);
    });
    ws.addEventListener("close", () => {
      const error = new Error("CDP WebSocket closed before the command completed");
      clearTimeout(connectionTimeout);
      if (!opened) reject(error);
      rejectPending(error);
    });
  });
}

async function cleanupChromeSession({ cdp, chrome, profilePath, requestBrowserClose }) {
  const errors = [];
  if (requestBrowserClose && cdp) {
    await cdp.send("Browser.close").catch(() => {});
  }
  try {
    cdp?.ws.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await stopProcessTree(chrome);
    traceVisualQa(`stopped browser pid ${chrome.pid ?? "missing"}`);
  } catch (error) {
    errors.push(error);
  }
  try {
    rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    traceVisualQa(`removed profile ${profilePath}`);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Chrome cleanup failed");
}

async function openChromeCdp({ failFirstBootstrap = false, opportunities = [] } = {}) {
  const profilePath = mkdtempSync(join(tmpdir(), "sent-zx-visual-chrome-"));
  traceVisualQa(`created profile ${profilePath}`);
  const chrome = spawnManaged(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "about:blank",
  ]);
  traceVisualQa(`spawned browser pid ${chrome.pid ?? "missing"}`);

  let cdp;
  try {
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
    traceVisualQa(`discovered DevTools port ${port}`);

    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json());
    const page = targets.find((item) => item.type === "page");
    if (!page) throw new Error("No Chrome page target found for visual rhythm QA.");
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    traceVisualQa("connected to CDP");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      const nativeFetch = window.fetch.bind(window);
      window.__visualApiCalls = {};
      window.__visualErrors = [];
      window.addEventListener('error', (event) => {
        window.__visualErrors.push(event.error?.stack ?? event.message ?? 'Unknown window error');
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__visualErrors.push(event.reason?.stack ?? String(event.reason));
      });
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
            '/api/itineraries',
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
              ? {
                  items: pathname === '/api/opportunities'
                    ? ${JSON.stringify(opportunities)}
                    : [],
                }
              : isSummary
                ? {
                    item: {
                      metrics: {
                        quickRecords: { value: 0, badge: '暂无记录', tone: 'blue' },
                        opportunities: {
                          value: ${opportunities.length},
                          badge: '真实商机',
                          tone: 'amber',
                        },
                        forecast: { value: '待确认', badge: '暂无预测', tone: 'green' },
                        risks: { value: 0, badge: '暂无风险', tone: 'red' },
                      },
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
    traceVisualQa("initialized CDP page hooks");

    return {
      ...cdp,
      async close() {
        traceVisualQa(`closing browser pid ${chrome.pid ?? "missing"}`);
        await cleanupChromeSession({
          cdp,
          chrome,
          profilePath,
          requestBrowserClose: true,
        });
      },
    };
  } catch (error) {
    traceVisualQa(`browser setup failed: ${error.message}`);
    const output = chrome.output.trim();
    const setupError = new Error(output ? `${error.message}\nChrome output:\n${output}` : error.message, {
      cause: error,
    });
    try {
      await cleanupChromeSession({
        cdp,
        chrome,
        profilePath,
        requestBrowserClose: false,
      });
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "Chrome setup and cleanup failed");
    }
    throw setupError;
  }
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
        const anchorRect = headingRect ?? firstRect;
        const topInset = contentRect && anchorRect ? round(anchorRect.top - contentRect.top) : null;
        const titleToFirst = titleRect && firstRect ? round(firstRect.top - titleRect.bottom) : (firstRect ? 0 : null);
        const headingToFirst = headingRect && firstRect ? round(firstRect.top - headingRect.bottom) : null;
        const firstViewportRatio = firstRect ? Number((firstRect.top / window.innerHeight).toFixed(3)) : null;
        results.push({
          page: page.name,
          mobile: ${JSON.stringify(viewport.mobile)},
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

async function measureMobileShell(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url });
  await delay(1200);

  return evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
      const started = Date.now();
      while (!document.querySelector('[data-testid="page-overview"]')) {
        if (Date.now() - started > 5000) throw new Error('Timed out waiting for mobile shell');
        await wait(50);
      }
      const sidebar = document.querySelector('.sidebar');
      const logo = document.querySelector('.brand-area img');
      const navKicker = document.querySelector('.nav-kicker');
      const rect = sidebar?.getBoundingClientRect();
      return {
        sidebarHeight: rect ? Math.round(rect.height) : null,
        scrollbarThickness: sidebar ? Math.max(0, sidebar.offsetHeight - sidebar.clientHeight) : null,
        navKickerDisplay: navKicker ? getComputedStyle(navKicker).display : null,
        logoCurrentSrc: logo?.currentSrc ?? '',
        visualScale: window.visualViewport?.scale ?? null,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()
  `);
}

describe("CDP command lifecycle", () => {
  it("rejects a stalled browser command within the configured deadline", async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    class StalledWebSocket extends EventTarget {
      static instance;

      constructor() {
        super();
        StalledWebSocket.instance = this;
      }

      send() {}

      close() {}
    }

    globalThis.WebSocket = StalledWebSocket;
    try {
      const connection = connectCdp("ws://visual-qa.test", { commandTimeoutMs: 10 });
      StalledWebSocket.instance.dispatchEvent(new Event("open"));
      const cdp = await connection;

      await assert.rejects(
        Promise.race([
          cdp.send("Runtime.evaluate"),
          delay(100).then(() => {
            throw new Error("CDP command remained pending without a deadline");
          }),
        ]),
        /Runtime\.evaluate timed out after 10 ms/,
      );
    } finally {
      globalThis.WebSocket = OriginalWebSocket;
    }
  });

  it("terminates a stalled browser directly on non-Windows runners", async () => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.exitCode = null;
    child.signalCode = null;
    child.processGroup = true;
    child.kill = () => {
      throw new Error("single-process termination must not be used for a Chrome process group");
    };
    const signals = [];
    const killProcess = (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") {
        queueMicrotask(() => child.emit("close", null, signal));
        return;
      }
      const error = new Error("process group is gone");
      error.code = "ESRCH";
      throw error;
    };

    await stopProcessTree(child, { platform: "linux", killProcess, timeoutMs: 20 });

    assert.deepEqual(signals, [
      { pid: -999_999, signal: "SIGKILL" },
      { pid: -999_999, signal: 0 },
    ]);
  });

  it("fails closed when Windows tree termination does not finish", async () => {
    const child = new EventEmitter();
    child.pid = 999_998;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = { destroyed: false, destroy() { this.destroyed = true; } };
    child.stderr = { destroyed: false, destroy() { this.destroyed = true; } };
    const killer = new EventEmitter();
    killer.kill = () => true;

    await assert.rejects(
      stopProcessTree(child, {
        platform: "win32",
        spawnProcess: () => killer,
        timeoutMs: 10,
      }),
      /taskkill timed out after 10 ms/,
    );
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });

  it("closes the HTTP server even when browser cleanup fails", async () => {
    const events = [];
    const cdp = {
      async close() {
        events.push("browser");
        throw new Error("browser cleanup failed");
      },
    };
    const server = {
      closeAllConnections() {
        events.push("connections");
      },
      close(callback) {
        events.push("server");
        callback();
      },
    };

    await assert.rejects(
      closeVisualResources({ cdp, server, serverTimeoutMs: 20 }),
      /browser cleanup failed/,
    );
    assert.deepEqual(events, ["browser", "connections", "server"]);
  });

  it("fails closed when the HTTP server close callback stalls", async () => {
    const server = {
      closeAllConnections() {},
      close() {},
    };

    await assert.rejects(
      closeVisualResources({ server, serverTimeoutMs: 10 }),
      /HTTP server close timed out after 10 ms/,
    );
  });
});

describe("visual rhythm", () => {
  it("keeps the mobile brand and horizontal navigation compact without a visible scrollbar", async () => {
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
      for (const viewport of mobileShellViewports) {
        const shell = await measureMobileShell(cdp, `http://127.0.0.1:${port}`, viewport);
        assert.ok(shell.sidebarHeight <= 68, `${viewport.name} navigation is too tall: ${shell.sidebarHeight}px`);
        assert.ok(shell.scrollbarThickness <= 2, `${viewport.name} should hide the native navigation scrollbar`);
        assert.equal(shell.navKickerDisplay, "none", `${viewport.name} should hide the desktop navigation kicker`);
        assert.match(shell.logoCurrentSrc, /sent-zhixing-icon\.png$/, `${viewport.name} should use the compact company icon`);
        assert.equal(shell.visualScale, 1, `${viewport.name} should render at 100% scale`);
        assert.equal(shell.overflowX, 0, `${viewport.name} should not overflow horizontally`);
      }
    } finally {
      await closeVisualResources({ cdp, server });
    }
  });

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
        const maxTopInset = item.mobile ? 16 : 30;
        const maxTitleGap = item.mobile ? 34 : 42;
        const isEmptyState = item.firstClass === "workbench-state-panel" || /-list-view$/.test(item.firstClass);
        const maxFirstViewportRatio = item.viewport === "desktop"
          ? 0.34
          : item.mobile && isEmptyState
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
      await closeVisualResources({ cdp, server });
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
      await closeVisualResources({ cdp, server });
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
          [...document.querySelectorAll('.nav-item')]
            .find((item) => item.textContent.includes('周报'))?.click();
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
      await closeVisualResources({ cdp, server });
    }
  });

  it("renders real opportunity timeline items and an explicit empty state", async () => {
    assert.equal(existsSync(resolve("dist", "index.html")), true, "run npm run build before visual rhythm QA");

    const opportunities = [
      {
        id: "op-timeline-real",
        version: 1,
        customerId: "customer-real",
        name: "数据中心更新项目",
        customer: "真实客户甲",
        stage: "需求确认",
        amount: "待确认",
        owner: "负责人甲",
        probability: 35,
        days: 2,
        requirements: [],
        competitors: [],
        solutionDirection: [],
        sourceRecord: "CRM-20260719-001 客户现场沟通纪要",
        risk: null,
        next: null,
        tone: "blue",
        createdAt: "2026-07-18T02:00:00.000Z",
        updatedAt: "2026-07-19T03:30:00.000Z",
      },
      {
        id: "op-timeline-empty",
        version: 1,
        customerId: "customer-empty",
        name: "待补充商机",
        customer: "真实客户乙",
        stage: "初步接触",
        amount: null,
        owner: null,
        probability: 10,
        days: 0,
        requirements: [],
        competitors: [],
        solutionDirection: [],
        sourceRecord: null,
        risk: null,
        next: null,
        tone: "gray",
      },
    ];
    const port = await getFreePort();
    const server = createStaticServer(createStaticServerConfig({
      port,
      distPath: resolve("dist"),
      apiBaseUrl: visualApiBaseUrl,
    }));
    await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

    let cdp;
    try {
      cdp = await openChromeCdp({ opportunities });
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}` });
      await delay(1200);
      const result = await evaluate(cdp, `
        (async () => {
          const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
          const waitUntil = async (predicate, label, timeoutMs = 5000) => {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
              const value = predicate();
              if (value) return value;
              await wait(50);
            }
            throw new Error(
              'Timed out waiting for ' + label
              + '; body=' + document.body.innerText.slice(0, 500)
              + '; apiCalls=' + JSON.stringify(window.__visualApiCalls)
              + '; errors=' + JSON.stringify(window.__visualErrors),
            );
          };

          await waitUntil(() => document.querySelector('[data-testid="page-overview"]'), 'workbench bootstrap');
          document.querySelectorAll('.nav-item')[3]?.click();
          await waitUntil(() => document.querySelector('[data-testid="opportunity-list-view"]'), 'opportunity list');

          const openButtons = () => [...document.querySelectorAll('[data-testid="opportunity-open-detail"]')];
          openButtons()[0]?.click();
          await waitUntil(
            () => document.querySelector('[data-testid="opportunity-detail-view"] .timeline'),
            'real opportunity timeline',
          );
          const realTimelineText = document.querySelector('[data-testid="opportunity-detail-view"] .timeline')?.innerText ?? '';

          document.querySelector('[data-testid="opportunity-detail-view"] .sticky-subview-toolbar > button')?.click();
          await waitUntil(() => document.querySelector('[data-testid="opportunity-list-view"]'), 'opportunity list return');
          openButtons()[1]?.click();
          await waitUntil(
            () => document.querySelector('[data-testid="opportunity-detail-view"] .timeline'),
            'empty opportunity timeline',
          );

          return {
            realTimelineText,
            emptyTimelineText: document.querySelector('[data-testid="opportunity-detail-view"] .timeline')?.innerText ?? '',
            hasEmptyState: Boolean(document.querySelector('[data-testid="opportunity-timeline-empty"]')),
          };
        })()
      `);

      assert.match(result.realTimelineText, /CRM-20260719-001 客户现场沟通纪要/);
      assert.doesNotMatch(
        result.realTimelineText,
        /日照中医医院|胜利油田中心医院|黄岛区中医院|黄岛中心医院/,
      );
      assert.equal(result.hasEmptyState, true);
      assert.match(result.emptyTimelineText, /暂无时间线记录/);
      assert.doesNotMatch(
        result.emptyTimelineText,
        /日照中医医院|胜利油田中心医院|黄岛区中医院|黄岛中心医院/,
      );
    } finally {
      await closeVisualResources({ cdp, server });
    }
  });
});
