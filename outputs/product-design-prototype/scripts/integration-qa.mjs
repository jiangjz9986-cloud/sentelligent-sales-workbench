import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getCurrentWeekRange } from "../src/weekRange.js";
import {
  createWindowsProcessFingerprint,
  stopOwnedWindowsProcess,
} from "../../../scripts/local-dev.mjs";
import {
  registerOwnedPosixChildProcess,
  stopOwnedPosixChildProcess,
  stopOwnedPosixProcess,
} from "../../../scripts/owned-posix-process.mjs";
import { hashPassword } from "../../../backend/src/auth/password.js";

const appRoot = process.cwd();
const workspaceRoot = resolve(appRoot, "../..");
const backendDir = resolve(workspaceRoot, "backend");
const chromePath = findChrome();

const desktopRecord =
  "周三现场拜访日照中医医院，和主任及主管工程师梁斌讨论未来 3-5 年规划。客户希望补齐本地数据中心基础架构健壮度，未来将移动云作为灾备中心。客户反馈移动云资源计费、平台封闭、数据导出配合度和后台管理权都存在问题。需要输出十五五年度规划材料，并判断是否同步到商机档案和周报。";
const manualAnalysisRevision = "手动修订：客户先要求补齐本地数据中心与灾备规划。";

const viewportCases = [
  { name: "desktop", width: 1440, height: 900, mobile: false, fullFlow: true },
  { name: "desktop-large", width: 1920, height: 1080, mobile: false, fullFlow: false },
  { name: "desktop-compact", width: 1366, height: 768, mobile: false, fullFlow: false },
  { name: "tablet", width: 834, height: 1194, mobile: false, fullFlow: false },
  { name: "narrow-window", width: 390, height: 844, mobile: false, fullFlow: false },
  { name: "iphone", width: 390, height: 844, mobile: true, fullFlow: false },
  { name: "android-small", width: 360, height: 800, mobile: true, fullFlow: false },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge executable was not found. Set CHROME_PATH to run integration QA.");
  return found;
}

function toWslPath(windowsPath) {
  const normalized = resolve(windowsPath).replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function removeDirectoryWhenReleased(directoryPath, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      rmSync(directoryPath, { recursive: true, force: true });
      if (!existsSync(directoryPath)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out removing isolated browser profile ${directoryPath}: ${lastError?.message ?? "directory remains"}`,
  );
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function spawnManaged(command, args, options = {}) {
  const processCwd = resolve(options.cwd ?? process.cwd());
  const child = spawn(command, args, {
    cwd: processCwd,
    env: { ...process.env, ...(options.env ?? {}) },
    detached: process.platform !== "win32",
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
  const fingerprint = createWindowsProcessFingerprint({ command, args });
  const posixCommandTokens = fingerprint.commandTokens.filter((token) =>
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  child.runtimeProcess = {
    pid: child.pid,
    fingerprint: {
      ...fingerprint,
      cwd: processCwd,
      allowExecutableWrapper: options.allowExecutableWrapper === true,
    },
  };
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    registerOwnedPosixChildProcess(child, {
      detached: true,
      pgid: child.pid,
      cwd: processCwd,
      executable: command,
      commandTokens: posixCommandTokens,
    });
  }
  return child;
}

async function detectIntegrationRuntime() {
  const requested = String(process.env.SENT_ZX_INTEGRATION_RUNTIME ?? "auto").trim().toLowerCase();
  if (!["auto", "native", "wsl"].includes(requested)) {
    throw new Error("SENT_ZX_INTEGRATION_RUNTIME must be auto, native, or wsl");
  }
  if (requested === "native") return "native";
  try {
    await runProcess("wsl.exe", ["--status"]);
    return "wsl";
  } catch (error) {
    if (requested === "wsl") throw error;
    return "native";
  }
}

async function waitForHttp(url, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

async function stopProcessTree(child) {
  if (!child?.pid) return { status: "not_running", pid: null };
  if (process.platform === "win32") {
    return stopOwnedWindowsProcess(child.runtimeProcess ?? { pid: child.pid });
  }
  return stopOwnedPosixChildProcess(child);
}

async function assertOwnedWslListener(port, { backendWslPath, databaseUrl }, { terminate = false } = {}) {
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort <= 0) throw new Error(`Invalid WSL listener port: ${port}`);
  const script = String.raw`
set -eu
port="$1"
expected_cwd="$2"
expected_db="$3"
mode="$4"
pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "$pids" ]; then
  exit 0
fi
for pid in $pids; do
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  command_line="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [ "$cwd" != "$expected_cwd" ]; then
    printf 'WSL listener ownership mismatch for PID %s: cwd=%s\n' "$pid" "$cwd" >&2
    exit 42
  fi
  case "$command_line" in
    *"node src/server.js"*) ;;
    *)
      printf 'WSL listener ownership mismatch for PID %s: command=%s\n' "$pid" "$command_line" >&2
      exit 42
      ;;
  esac
  if ! tr '\000' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx "DATABASE_URL=$expected_db"; then
    printf 'WSL listener ownership mismatch for PID %s: database fingerprint differs\n' "$pid" >&2
    exit 42
  fi
done
if [ "$mode" = "terminate" ]; then
  kill -- $pids
  attempt=0
  while [ -n "$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)" ] && [ "$attempt" -lt 50 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if [ -n "$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    printf 'WSL listener did not stop on port %s\n' "$port" >&2
    exit 43
  fi
fi
printf '%s\n' $pids
`;
  const result = await runProcess("wsl.exe", [
    "--exec",
    "bash",
    "-c",
    script,
    "sent-zx-listener-check",
    String(numericPort),
    backendWslPath,
    databaseUrl,
    terminate ? "terminate" : "inspect",
  ]);
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

async function stopWslPort(port, identity) {
  return assertOwnedWslListener(port, identity, { terminate: true });
}

async function runBackendFixtureScript({ runtimeMode, backendWslPath, env, script }) {
  return runtimeMode === "wsl"
    ? runProcess("wsl.exe", [
        "--cd",
        backendWslPath,
        "--exec",
        "env",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        "node",
        "--input-type=module",
        "--eval",
        script,
      ])
    : runProcess(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: backendDir,
        env,
      });
}

async function createHistoricalSolutionFixture({ runtimeMode, backendWslPath, databaseUrl }) {
  const fixtureScript = String.raw`
import { createServer } from "./src/server.js";

const server = createServer({
  databaseUrl: process.env.DATABASE_URL,
  seed: false,
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/solutions/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: "集成验收",
      customerId: "rizhao",
      opportunityId: "op-rizhao-plan",
      artifactType: "solution_framework",
    }),
  });
  const body = await response.json();
  if (response.status !== 201 || !body.item?.id) {
    throw new Error("Historical solution fixture creation failed: " + response.status);
  }
  process.stdout.write(JSON.stringify(body.item));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
`;
  const fixtureEnv = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    AUTH_REQUIRED: "false",
    AI_ANALYSIS_MODE: "mock",
    DEEPSEEK_API_KEY: "",
    SOLUTION_WRITES_ENABLED: "true",
  };
  const result = await runBackendFixtureScript({
    runtimeMode,
    backendWslPath,
    env: fixtureEnv,
    script: fixtureScript,
  });
  const item = JSON.parse(result.stdout.trim());
  assert.ok(item.id, "historical solution fixture should return a persisted id");
  assert.ok(item.content, "historical solution fixture should contain readable content");
  return item;
}

async function createHistoricalItineraryFixture({ runtimeMode, backendWslPath, databaseUrl }) {
  const fixtureScript = String.raw`
import { createServer } from "./src/server.js";

const origin = { lng: 120.149201, lat: 35.987754 };
const destination = { lng: 116.608817, lat: 35.415405 };
const server = createServer({
  databaseUrl: process.env.DATABASE_URL,
  seed: false,
  amapClient: {
    async geocode({ address }) {
      if (address.includes("秀兰禧悦山")) {
        return { formattedAddress: "山东省青岛市黄岛区秀兰禧悦山", location: origin };
      }
      if (address.includes("济宁市第二人民医院")) {
        return { formattedAddress: "山东省济宁市任城区济宁市第二人民医院", location: destination };
      }
      throw new Error("Unexpected itinerary fixture address");
    },
    async drivingMatrix() {
      return {
        distances: [[0, 382400], [382400, 0]],
        durations: [[0, 16020], [16020, 0]],
      };
    },
    async drivingRoute() {
      return {
        distanceMeters: 382400,
        durationSeconds: 16020,
        tollsCny: 154,
        trafficLights: 24,
        polyline: [
          origin,
          { lng: 119.632, lat: 35.827 },
          { lng: 118.741, lat: 35.601 },
          { lng: 117.756, lat: 35.465 },
          destination,
        ],
        steps: [],
      };
    },
  },
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/api/itineraries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "黄岛至济宁客户拜访",
      visitDate: "2026-07-28",
      status: "planned",
      departureAddress: "青岛市黄岛区秀兰禧悦山",
      departureCity: "青岛",
      departureAt: "2026-07-28T08:00:00+08:00",
      stops: [{
        id: "jining-second-hospital",
        customerName: "济宁市第二人民医院",
        address: "济宁市任城区济宁市第二人民医院",
        city: "济宁",
        priority: "high",
        visitMinutes: 60,
        appointmentAt: "2026-07-28T13:30:00+08:00",
        notes: "确认信息化建设计划",
      }],
    }),
  });
  const body = await response.json();
  if (response.status !== 201 || !body.item?.id) {
    throw new Error("Historical itinerary fixture creation failed: " + response.status);
  }
  process.stdout.write(JSON.stringify(body.item));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
`;
  const result = await runBackendFixtureScript({
    runtimeMode,
    backendWslPath,
    env: {
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      AUTH_REQUIRED: "false",
      AI_ANALYSIS_MODE: "mock",
      DEEPSEEK_API_KEY: "",
    },
    script: fixtureScript,
  });
  const item = JSON.parse(result.stdout.trim());
  assert.ok(item.id, "historical itinerary fixture should return a persisted id");
  assert.ok(item.plan?.route?.polyline?.length > 1, "historical itinerary fixture should contain a route polyline");
  return item;
}

function connectCdp(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    const networkRequests = new Map();
    const networkResponses = [];

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails.text);
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        consoleErrors.push(message.params.entry.text);
      }
      if (message.method === "Network.requestWillBeSent") {
        networkRequests.set(message.params.requestId, {
          method: message.params.request.method,
          url: message.params.request.url,
          requestHeaders: { ...message.params.request.headers },
        });
      }
      if (message.method === "Network.responseReceived") {
        const request = networkRequests.get(message.params.requestId);
        networkResponses.push({
          requestId: message.params.requestId,
          method: request?.method ?? null,
          url: message.params.response.url,
          status: message.params.response.status,
          requestHeaders: request?.requestHeaders ?? {},
        });
      }

      if (!pending.has(message.id)) return;
      const { method, resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${method} failed: ${message.error.message}`));
      else resolve(message.result);
    });

    ws.addEventListener(
      "open",
      () => {
        resolveConnect({
          ws,
          consoleErrors,
          networkResponses,
          send(method, params = {}) {
            const callId = ++id;
            ws.send(JSON.stringify({ id: callId, method, params }));
            return new Promise((resolve, reject) => pending.set(callId, { method, resolve, reject }));
          },
        });
      },
      { once: true },
    );
    ws.addEventListener("error", reject, { once: true });
  });
}

async function waitForDevTools(profilePath) {
  const portFile = join(profilePath, "DevToolsActivePort");
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 5000) {
    if (existsSync(portFile)) {
      try {
        const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
        if (port) return port;
      } catch (error) {
        lastError = error;
      }
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for ${portFile}`);
}

async function openChromeCdp() {
  const profilePath = mkdtempSync(join(tmpdir(), "sent-zx-integration-chrome-"));
  let chrome;
  try {
    chrome = spawnManaged(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profilePath}`,
      "about:blank",
    ], { allowExecutableWrapper: true });

    const port = await waitForDevTools(profilePath);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = pages.find((item) => item.type === "page");
    if (!page) throw new Error("No Chrome page target found for integration QA.");
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");

    return {
      ...cdp,
      async close() {
        const cleanupErrors = [];
        try {
          cdp.ws.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          const stopResult = await stopProcessTree(chrome);
          if (!["terminated", "already_closed", "not_running"].includes(stopResult.status)) {
            cleanupErrors.push(new Error(`Refused unverified browser cleanup for PID ${chrome.pid}: ${stopResult.status}`));
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await removeDirectoryWhenReleased(profilePath);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Browser cleanup failed");
      },
    };
  } catch (error) {
    const cleanupErrors = [error];
    if (chrome) {
      try {
        const stopResult = await stopProcessTree(chrome);
        if (!["terminated", "already_closed", "not_running"].includes(stopResult.status)) {
          cleanupErrors.push(new Error(`Refused unverified browser cleanup for PID ${chrome.pid}: ${stopResult.status}`));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await removeDirectoryWhenReleased(profilePath);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length === 1) throw error;
    throw new AggregateError(cleanupErrors, "Chrome bootstrap failed and cleanup was incomplete");
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Browser evaluation failed",
    );
  }
  return result.result.value;
}

async function runViewport(cdp, url, viewport, historicalSolution, historicalItinerary, realItineraryFlow) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await cdp.send("Page.navigate", { url });
  await delay(1800);

  return evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const historicalSolution = ${JSON.stringify(historicalSolution)};
      window.__qaRuntimeErrors = [];
      window.addEventListener('error', (event) => {
        window.__qaRuntimeErrors.push(event.error?.stack || event.message || 'window error');
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__qaRuntimeErrors.push(event.reason?.stack || event.reason?.message || 'unhandled rejection');
      });
      const waitUntil = async (predicate, timeoutMs = 7000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        const value = predicate();
        if (value) return value;
        const heading = document.querySelector('.page-heading h1')?.textContent?.trim() ?? '';
        const runtimeErrors = (window.__qaRuntimeErrors ?? []).join(' || ').slice(0, 500);
        const textPreview = document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 360);
        throw new Error('Timed out waiting for UI condition: ' + predicate.toString().replace(/\\s+/g, ' ').slice(0, 160) + ' heading=' + heading + ' text=' + textPreview + ' runtimeErrors=' + runtimeErrors);
      };
      const clickRequired = (labelText) => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(labelText));
        if (!button) throw new Error('Missing button ' + labelText);
        button.click();
      };
      const setInputValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const loginIfNeeded = async () => {
        const submit = document.querySelector('[data-testid="login-submit"]');
        if (!submit) return false;
        const accountInput = document.querySelector('input[aria-label="账号"]');
        const passwordInput = document.querySelector('input[aria-label="密码"]');
        if (!accountInput || !passwordInput) throw new Error('Missing login fields');
        setInputValue(accountInput, 'jiangjz');
        setInputValue(passwordInput, 'qa-login');
        submit.click();
        await waitUntil(() => document.querySelector('[data-testid="page-overview"]'), 5000);
        return true;
      };
      const loginCompleted = await loginIfNeeded();
      window.__qaAuth = {
        loginCompleted,
        restoredWithoutLogin: !loginCompleted && Boolean(document.querySelector('[data-testid="page-overview"]')),
        legacyCacheCleared: window.localStorage.getItem('sentelligent.salesWorkbench.login') === null,
      };
      const inspectInteractiveControls = (scopeLabel = 'current') => {
        const targetElement = (item) => item.closest('.search-box, .itinerary-filter, .voice-file-button') || item;
        const visibleControls = [...document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea')]
          .filter((item) => {
            const bounds = targetElement(item).getBoundingClientRect();
            const style = getComputedStyle(item);
            if (item.disabled) return false;
            if (style.display === 'none' || style.visibility === 'hidden' || bounds.width === 0 || bounds.height === 0) return false;
            if (bounds.bottom < 0 || bounds.top > window.innerHeight || bounds.right < 0 || bounds.left > window.innerWidth) return false;
            return true;
          });
        const minTarget = window.innerWidth <= 430 ? 44 : 34;
        const unnamed = [];
        const smallTargets = [];
        const textOverflow = [];
        for (const item of visibleControls) {
          const bounds = targetElement(item).getBoundingClientRect();
          const implicitLabel = item.labels?.[0]?.querySelector('span')?.textContent || item.labels?.[0]?.textContent || '';
          const label = (item.getAttribute('aria-label') || item.title || implicitLabel || item.textContent || item.placeholder || '')
            .replace(/\\s+/g, ' ')
            .trim();
          if (!label) {
            unnamed.push({
              scope: scopeLabel,
              tag: item.tagName.toLowerCase(),
              className: String(item.className || ''),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            });
          }
          if (bounds.width < minTarget || bounds.height < minTarget) {
            smallTargets.push({
              scope: scopeLabel,
              label,
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            });
          }
          if (
            item.matches('button, [role="button"], a[href]')
            && (item.scrollWidth > item.clientWidth + 2 || item.scrollHeight > item.clientHeight + 2)
          ) {
            textOverflow.push({
              scope: scopeLabel,
              label,
              scrollWidth: item.scrollWidth,
              clientWidth: item.clientWidth,
              scrollHeight: item.scrollHeight,
              clientHeight: item.clientHeight,
            });
          }
        }
        return { count: visibleControls.length, unnamed, smallTargets, textOverflow };
      };
      const mergeControlIssues = (target, controls) => {
        target.unnamed.push(...controls.unnamed);
        target.smallTargets.push(...controls.smallTargets);
        target.textOverflow.push(...controls.textOverflow);
        target.count += controls.count;
      };
      const inspectCurrentPageAcrossScroll = async (pageLabel) => {
        const merged = { count: 0, unnamed: [], smallTargets: [], textOverflow: [] };
        const seen = new Set();
        const pageScrollRoot = document.scrollingElement || document.documentElement;
        const contentRoot = document.querySelector('.content');
        const scrollRoots = [
          { name: 'document', root: pageScrollRoot, viewportHeight: window.innerHeight },
          { name: 'content', root: contentRoot, viewportHeight: contentRoot?.clientHeight ?? 0 },
        ].filter((item, index, source) =>
          item.root && source.findIndex((candidate) => candidate.root === item.root) === index,
        );

        const mergeUnique = (controls) => {
          const uniqueControls = {
            count: controls.count,
            unnamed: controls.unnamed.filter((item) => {
              const key = 'unnamed:' + item.scope + ':' + item.className + ':' + item.width + ':' + item.height;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
            smallTargets: controls.smallTargets.filter((item) => {
              const key = 'small:' + item.scope + ':' + item.label + ':' + item.width + ':' + item.height;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
            textOverflow: controls.textOverflow.filter((item) => {
              const key = 'overflow:' + item.scope + ':' + item.label + ':' + item.clientWidth + ':' + item.clientHeight;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          };
          mergeControlIssues(merged, uniqueControls);
        };

        for (const scrollTarget of scrollRoots) {
          const maxScroll = Math.max(0, scrollTarget.root.scrollHeight - scrollTarget.viewportHeight);
          const positions = maxScroll > 0
            ? [
                ['top', 0],
                ['middle', Math.round(maxScroll / 2)],
                ['bottom', maxScroll],
              ]
            : [['top', 0]];
          for (const [positionName, y] of positions) {
            scrollTarget.root.scrollTo(0, y);
            await wait(100);
            const controls = inspectInteractiveControls(pageLabel + '@' + scrollTarget.name + ':' + positionName);
            mergeUnique(controls);
          }
          scrollTarget.root.scrollTo(0, 0);
        }
        await wait(80);
        return merged;
      };
      const inspectBusinessListRows = (pageLabel) => {
        return [...document.querySelectorAll('.customer-list-row')]
          .map((row, index) => {
            const issues = [];
            if (row.matches('button, [role="button"]')) issues.push('row-container-is-control');
            if (row.hasAttribute('tabindex')) issues.push('row-container-is-focusable');
            if (row.querySelectorAll('button.list-row-main').length !== 1) issues.push('missing-main-select-button');
            if (row.querySelectorAll('button[data-testid$="-open-detail"]').length !== 1) issues.push('missing-detail-button');
            if (issues.length === 0) return null;
            return {
              page: pageLabel,
              index,
              text: row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
              issues,
            };
          })
          .filter(Boolean);
      };
      await waitUntil(() => document.querySelector('[data-testid="api-status"]')?.textContent?.includes('在线'));
      await waitUntil(() => document.querySelector('[data-testid="page-overview"]'));

      if (${viewport.fullFlow ? "true" : "false"}) {
        const cardInteractions = {};
        const openOverview = async () => {
          document.querySelectorAll('.nav-item')[0]?.click();
          await waitUntil(() => document.querySelector('[data-testid="page-overview"]'), 5000);
        };
        const clickCardOpening = async (selector, text, expectedSelector, expectedText) => {
          const card = [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text));
          if (!card) throw new Error('Missing interactive card ' + text);
          card.click();
          await waitUntil(() => document.querySelector(expectedSelector), 5000);
          if (!expectedText) return Boolean(document.querySelector(expectedSelector));
          return (document.querySelector(expectedSelector)?.textContent ?? '').includes(expectedText);
        };
        const clickManualSuggestion = async (pageTestId, titleText) => {
          const page = document.querySelector('[data-testid="' + pageTestId + '"]');
          const box = [...(page?.querySelectorAll('.manual-box') ?? [])].find((item) => item.textContent.includes(titleText));
          if (!box) {
            const available = [...(page?.querySelectorAll('.manual-box strong') ?? [])]
              .map((item) => item.textContent.trim())
              .filter(Boolean)
              .join(' | ');
            const heading = page?.querySelector('h1')?.textContent?.trim() ?? '';
            const editorButtons = [...(page?.querySelectorAll('.editor-panel button') ?? [])]
              .map((item) => item.textContent.trim())
              .filter(Boolean)
              .join(' | ');
            const pageExists = Boolean(page);
            const detailExists = Boolean(document.querySelector('[data-testid="page-knowledge"] [data-testid="knowledge-detail-view"]'));
            const activeHeading = document.querySelector('.page-heading h1')?.textContent?.trim() ?? '';
            const bodyPreview = document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 260);
            const htmlPreview = document.body.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 360);
            throw new Error('Missing manual suggestion box ' + titleText + ' available=' + available + ' heading=' + heading + ' editorButtons=' + editorButtons + ' pageExists=' + pageExists + ' detailExists=' + detailExists + ' activeHeading=' + activeHeading + ' href=' + window.location.href + ' ready=' + document.readyState + ' body=' + bodyPreview + ' html=' + htmlPreview);
          }
          const button = box.querySelector('button');
          if (!button) throw new Error('Missing manual suggestion button ' + titleText);
          button.click();
          const suggestion = await waitUntil(() => box.querySelector('[data-testid="generated-suggestion"]'), 8000);
          return (suggestion?.textContent ?? '').trim().length > 20;
        };

        cardInteractions.quickKpi = await clickCardOpening('.metric-card', '本周快速记录', '[data-testid="page-quick"]', '先记录');
        cardInteractions.quickStartsEmpty = (document.querySelector('.record-composer textarea')?.value ?? '').trim() === '';
        await openOverview();
        cardInteractions.riskKpi = await clickCardOpening('.metric-card', '高风险项', '[data-testid="page-risk"]', '风险列表');
        await openOverview();
        cardInteractions.priorityAction = await clickCardOpening('.compact-item', '补齐', '[data-testid="action-detail-view"]', null);
        await openOverview();
        cardInteractions.customerTemperature = await clickCardOpening('.progress-row', '日照中医医院', '[data-testid="customer-detail-view"]', null);
        await openOverview();
        cardInteractions.rhythmCard = await clickCardOpening('.rhythm-row', '补齐', '[data-testid="page-actions"]', '动作列表');
        await openOverview();
        cardInteractions.stageCard = await clickCardOpening('.stage-card', '线索', '[data-testid="page-kanban"]', '线索');

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('周报'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-weekly"]'), 5000);
        cardInteractions.weeklyStartsEmpty = Boolean(document.querySelector('[data-testid="weekly-empty"]'));

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('快速记录'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
        window.__qaVoiceInstances = [];
        class FakeSpeechRecognition {
          constructor() {
            this.lang = '';
            this.continuous = false;
            this.interimResults = false;
            this.started = false;
            this.stopped = false;
            window.__qaVoiceInstances.push(this);
          }
          start() {
            this.started = true;
            this.onstart?.();
          }
          stop() {
            this.stopped = true;
            this.onend?.();
          }
          abort() {
            this.stopped = true;
            this.onend?.();
          }
          emitTranscript(text) {
            const transcript = [{ transcript: text, confidence: 0.98 }];
            transcript.isFinal = true;
            const results = [transcript];
            results.item = (index) => results[index];
            this.onresult?.({ resultIndex: 0, results });
          }
        }
        window.SpeechRecognition = FakeSpeechRecognition;
        window.webkitSpeechRecognition = FakeSpeechRecognition;
        let voiceModeButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '语音');
        if (!voiceModeButton) throw new Error('Missing quick record voice mode button');
        const defaultedToVoice = voiceModeButton.classList.contains('active');
        const textModeButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '文本');
        if (!textModeButton) throw new Error('Missing quick record text mode button');
        textModeButton.click();
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('客户画像'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]'), 5000);
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('快速记录'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
        voiceModeButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '语音');
        const resetToVoiceAfterReturn = voiceModeButton?.classList.contains('active') ?? false;
        document.querySelector('[data-testid="quick-record-mode-text"]')?.click();
        document.querySelector('[data-testid="nav-customer"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]'), 5000);
        document.querySelector('[data-testid="topbar-quick-record"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
        const resetToVoiceFromTopbar =
          document.querySelector('[data-testid="quick-record-mode-voice"]')?.classList.contains('active') ?? false;
        document.querySelector('[data-testid="quick-record-mode-text"]')?.click();
        document.querySelector('[data-testid="nav-overview"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-overview"]'), 5000);
        [...document.querySelectorAll('.overview-kpi')]
          .find((button) => button.textContent.includes('本周快速记录'))
          ?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
        const resetToVoiceFromOverview =
          document.querySelector('[data-testid="quick-record-mode-voice"]')?.classList.contains('active') ?? false;
        voiceModeButton = document.querySelector('[data-testid="quick-record-mode-voice"]');
        voiceModeButton.click();
        const startVoiceButton = await waitUntil(
          () => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('开始转写')),
          5000,
        );
        if (!startVoiceButton) throw new Error('Missing start voice transcription button');
        startVoiceButton.click();
        const voiceRecognition = await waitUntil(
          () => (window.__qaVoiceInstances[0]?.started ? window.__qaVoiceInstances[0] : null),
          5000,
        );
        if (!voiceRecognition) throw new Error('Voice transcription did not start');
        voiceRecognition.emitTranscript('周三现场拜访日照中医医院，客户反馈移动云计费和后台权限问题。');
        await waitUntil(() => document.querySelector('textarea')?.value?.includes('移动云计费'), 5000);
        const stopVoiceButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('停止转写'));
        if (!stopVoiceButton) throw new Error('Missing stop voice transcription button');
        stopVoiceButton.click();
        await waitUntil(() => voiceRecognition.stopped, 5000);
        window.__qaVoiceFlow = {
          defaultedToVoice,
          resetToVoiceAfterReturn,
          resetToVoiceFromTopbar,
          resetToVoiceFromOverview,
          started: voiceRecognition.started,
          stopped: voiceRecognition.stopped,
          transcriptInComposer: document.querySelector('textarea')?.value?.includes('移动云计费') ?? false,
          textareaValue: document.querySelector('textarea')?.value ?? '',
        };

        Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
        Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
        window.__qaMediaRecorders = [];
        window.__qaTrackStopped = false;
        class FakeMediaRecorder {
          constructor(stream) {
            this.stream = stream;
            this.mimeType = 'audio/mp4';
            this.state = 'inactive';
            window.__qaMediaRecorders.push(this);
          }
          start() {
            this.state = 'recording';
            this.onstart?.();
          }
          stop() {
            this.state = 'inactive';
            this.ondataavailable?.({
              data: new Blob(['audio-bytes'], { type: this.mimeType }),
            });
            this.onstop?.();
          }
        }
        Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => ({
              getTracks: () => [{
                stop: () => {
                  window.__qaTrackStopped = true;
                },
              }],
            }),
          },
        });
        [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '文本')?.click();
        await wait(100);
        [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '语音')?.click();
        const safariStartButton = await waitUntil(
          () => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('录音留存')),
          5000,
        );
        safariStartButton.click();
        const safariRecorder = await waitUntil(
          () => (window.__qaMediaRecorders[0]?.state === 'recording' ? window.__qaMediaRecorders[0] : null),
          5000,
        );
        const safariStopButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('停止录音'));
        if (!safariStopButton) throw new Error('Missing Safari voice recording stop button');
        safariStopButton.click();
        await waitUntil(() => document.querySelector('[data-testid="voice-audio-card"]'), 5000);
        window.__qaVoiceFallback = {
          recordingStarted: Boolean(safariRecorder),
          audioCardVisible: Boolean(document.querySelector('[data-testid="voice-audio-card"] audio')),
          downloadVisible: document.querySelector('[data-testid="voice-audio-card"] a')?.textContent?.includes('下载录音') ?? false,
          guidanceVisible: document.querySelector('[data-testid="voice-status"]')?.textContent?.includes('补录文字') ?? false,
          trackStopped: window.__qaTrackStopped,
        };

        Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
        Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
        Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: undefined,
        });
        [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '文本')?.click();
        await wait(100);
        [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '语音')?.click();
        await waitUntil(() => document.querySelector('[data-testid="voice-status"]'), 5000);
        const unavailableDirectText = document.querySelector('[data-testid="voice-status"]')?.textContent ?? '';
        const uploadLabel = document.querySelector('[data-testid="voice-upload-control"]');
        window.__qaVoiceUploadOnly = {
          uploadVisible: uploadLabel?.textContent?.includes('上传录音') ?? false,
          unavailableHidden: !unavailableDirectText.includes('不可用'),
          textFallbackVisible: [...document.querySelectorAll('button')].some((button) => button.textContent.includes('改用文本')),
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('客户画像'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]'), 5000);
        const customerSearch = document.querySelector('[data-testid="customer-local-search"]');
        if (!customerSearch) throw new Error('Missing customer local search');
        setInputValue(customerSearch, '日照');
        await waitUntil(() => document.querySelector('[data-testid="customer-list-view"]')?.textContent?.includes('日照中医医院'), 5000);
        cardInteractions.customerLocalSearch = document.querySelector('[data-testid="customer-list-view"]')?.textContent?.includes('日照中医医院')
          && !(document.querySelector('[data-testid="customer-list-view"]')?.textContent?.includes('黄岛区中医院') ?? false);
        const firstCustomerDetailButton = document.querySelector('[data-testid="customer-open-detail"]');
        if (!firstCustomerDetailButton) throw new Error('Missing customer detail navigation button');
        firstCustomerDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-detail-view"]'), 5000);
        cardInteractions.customerDetailViewOpened = Boolean(document.querySelector('[data-testid="customer-detail-view"]'));
        document.querySelector('.stakeholder-card')?.click();
        await waitUntil(() => document.querySelector('[data-testid="stakeholder-expanded"]'), 5000);
        cardInteractions.stakeholderExpanded = Boolean(document.querySelector('[data-testid="stakeholder-expanded"]'));
        document.querySelector('.chain-step')?.click();
        await waitUntil(() => document.querySelector('[data-testid="chain-expanded"]'), 5000);
        cardInteractions.chainExpanded = Boolean(document.querySelector('[data-testid="chain-expanded"]'));
        document.querySelector('.field-tag')?.click();
        await waitUntil(() => document.querySelector('[data-testid="field-tag-expanded"]'), 5000);
        cardInteractions.fieldTagExpanded = Boolean(document.querySelector('[data-testid="field-tag-expanded"]'));
        const aiSuggestions = {};
        aiSuggestions.customer = await clickManualSuggestion('page-customer', '生成客户画像补全建议');

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('商机档案'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-opportunity"]'), 5000);
        await waitUntil(() => document.querySelector('[data-testid="opportunity-list-view"]'), 5000);
        const opportunitySearch = document.querySelector('[data-testid="opportunity-local-search"]');
        if (!opportunitySearch) throw new Error('Missing opportunity local search');
        setInputValue(opportunitySearch, '日照');
        await waitUntil(() => opportunitySearch.closest('.list-panel')?.textContent?.includes('日照中医医院'), 5000);
        const opportunityListText = opportunitySearch.closest('.list-panel')?.textContent ?? '';
        cardInteractions.opportunityLocalSearch = opportunityListText.includes('日照中医医院')
          && !opportunityListText.includes('黄岛区中医院');
        const opportunityDetailButton = document.querySelector('[data-testid="opportunity-open-detail"]');
        if (!opportunityDetailButton) throw new Error('Missing opportunity detail navigation button');
        opportunityDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-detail-view"]'), 5000);
        cardInteractions.opportunityDetailViewOpened = Boolean(document.querySelector('[data-testid="opportunity-detail-view"]'));
        document.querySelector('[data-testid="opportunity-source-insight"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-source-expanded"]'), 5000);
        cardInteractions.opportunitySourceExpanded = Boolean(document.querySelector('[data-testid="opportunity-source-expanded"]'));
        document.querySelector('[data-testid="opportunity-risk-insight"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-risk-expanded"]'), 5000);
        cardInteractions.opportunityRiskExpanded = Boolean(document.querySelector('[data-testid="opportunity-risk-expanded"]'));
        document.querySelector('[data-testid="opportunity-next-insight"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-next-expanded"]'), 5000);
        cardInteractions.opportunityNextExpanded = Boolean(document.querySelector('[data-testid="opportunity-next-expanded"]'));
        document.querySelector('.time-row')?.click();
        await waitUntil(() => document.querySelector('[data-testid="timeline-expanded"]'), 5000);
        cardInteractions.timelineExpanded = Boolean(document.querySelector('[data-testid="timeline-expanded"]'));
        aiSuggestions.opportunity = await clickManualSuggestion('page-opportunity', '手动生成商机推进建议');

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('知识库'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"]'), 5000);
        await waitUntil(() => document.querySelector('[data-testid="knowledge-list-view"]'), 5000);
        const knowledgeDetailButton = document.querySelector('[data-testid="knowledge-open-detail"]');
        if (!knowledgeDetailButton) throw new Error('Missing knowledge detail navigation button');
        knowledgeDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"] [data-testid="knowledge-detail-view"]'), 5000);
        aiSuggestions.knowledge = await clickManualSuggestion('page-knowledge', '生成知识引用建议');

        window.__qaCardInteractions = cardInteractions;
        window.__qaAiSuggestions = aiSuggestions;
      }

      document.querySelectorAll('.nav-item')[1]?.click();
      await waitUntil(() => document.querySelector('[data-testid="page-quick"]'));

      if (${viewport.fullFlow ? "true" : "false"}) {
        const cardInteractions = window.__qaCardInteractions ?? {};
        const textarea = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, ${JSON.stringify(desktopRecord)});
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(200);
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('确认调用'))?.click();
        await waitUntil(() => document.querySelectorAll('.match-card').length >= 3, 8000);
        for (const label of ['确认写入客户画像', '同步到商机 / 项目', '进入周报草稿']) {
          [...document.querySelectorAll('button')].find((button) => button.textContent.includes(label))?.click();
          await wait(450);
        }
        window.__qaQuick = {
          matchCards: document.querySelectorAll('.match-card').length,
          confirmedCount: document.querySelectorAll('.manual-sync .confirmed, button.confirmed').length,
          hasBackendRecorded: document.body.textContent.includes('已同步'),
          syncLogItems: document.querySelectorAll('.sync-log-item').length,
          syncLogText: document.querySelector('[data-testid="sync-log"]')?.textContent ?? '',
        };
        const savedSummaryInput = await waitUntil(
          () => document.querySelector('[data-testid="analysis-summary-request"]'),
          5000,
        );
        const savedAnalysisSummary = savedSummaryInput.value;
        const quickAiRequestCount = () => performance.getEntriesByType('resource')
          .filter((entry) => {
            const path = new URL(entry.name).pathname;
            return path === '/api/quick-records/preview'
              || (path.startsWith('/api/quick-records/') && path.endsWith('/analyze'));
          })
          .length;
        const quickAiRequestsBeforeHistory = quickAiRequestCount();
        const createdRecordNote = await waitUntil(
          () => [...document.querySelectorAll('.record-note')]
            .find((item) => item.textContent.includes('日照中医医院')),
          5000,
        );
        createdRecordNote.click();
        await waitUntil(() => document.querySelector('.record-composer textarea')?.value?.includes('日照中医医院'), 5000);
        let restoredSummaryInput = null;
        try {
          restoredSummaryInput = await waitUntil(
            () => document.querySelector('[data-testid="analysis-summary-request"]'),
            1200,
          );
        } catch {
          restoredSummaryInput = null;
        }
        const restoredAnalysisSummary = restoredSummaryInput?.value ?? '';
        if (restoredSummaryInput) {
          const restoredSummarySetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          restoredSummarySetter.call(restoredSummaryInput, ${JSON.stringify(manualAnalysisRevision)});
          restoredSummaryInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await waitUntil(
          () => document.querySelector('[data-testid="analysis-summary-request"]')?.value === ${JSON.stringify(manualAnalysisRevision)},
          5000,
        );
        const saveAnalysisButton = document.querySelector('[data-testid="save-analysis-modifications"]');
        if (!saveAnalysisButton) throw new Error('Missing explicit analysis save button');
        saveAnalysisButton.click();
        await waitUntil(
          () => document.querySelector('.status-text')?.textContent?.includes('分析修改已保存'),
          8000,
        );
        const customerSyncButton = [...document.querySelectorAll('.manual-sync button')]
          .find((button) => button.textContent.includes('客户画像'));
        if (!customerSyncButton) throw new Error('Missing customer re-sync button after analysis save');
        customerSyncButton.click();
        await waitUntil(
          () => document.querySelector('.status-text')?.textContent?.includes('已同步'),
          8000,
        );
        const quickAiRequestsAfterHistory = quickAiRequestCount();
        cardInteractions.quickRecordLoaded = document.querySelector('.record-composer textarea')?.value?.includes('日照中医医院') ?? false;
        cardInteractions.quickSavedAnalysisRestored = Boolean(savedAnalysisSummary)
          && restoredAnalysisSummary === savedAnalysisSummary;
        cardInteractions.quickHistoryAnalysisEditable = document.querySelector('[data-testid="analysis-summary-request"]')?.value === ${JSON.stringify(manualAnalysisRevision)};
        cardInteractions.quickAnalysisSaveControl = Boolean(saveAnalysisButton);
        cardInteractions.quickAnalysisSaved = document.querySelector('[data-testid="analysis-summary-request"]')?.value === ${JSON.stringify(manualAnalysisRevision)};
        cardInteractions.quickAnalysisResynced = document.querySelector('.status-text')?.textContent?.includes('已同步') ?? false;
        cardInteractions.quickHistoryNoAiReplay = quickAiRequestsAfterHistory === quickAiRequestsBeforeHistory;
        cardInteractions.quickAiRequestsBeforeHistory = quickAiRequestsBeforeHistory;
        cardInteractions.quickAiRequestsAfterHistory = quickAiRequestsAfterHistory;
        window.__qaCardInteractions = cardInteractions;

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('风险识别'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-risk"]'), 5000);
        const riskSearch = document.querySelector('[data-testid="risk-local-search"]');
        if (!riskSearch) throw new Error('Missing risk local search');
        setInputValue(riskSearch, '预算');
        await waitUntil(() => riskSearch.closest('.list-panel')?.textContent?.includes('预算'), 5000);
        const riskSearchText = riskSearch.closest('.list-panel')?.textContent ?? '';
        const riskLocalSearch = riskSearchText.includes('预算');
        const riskDetailButton = document.querySelector('[data-testid="risk-open-detail"]');
        if (!riskDetailButton) throw new Error('Missing risk detail navigation button');
        riskDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="risk-detail-view"]'), 5000);
        const riskDetailViewOpened = Boolean(document.querySelector('[data-testid="risk-detail-view"]'));
        document.querySelector('[data-testid="risk-evidence-insight"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="risk-evidence-expanded"]'), 5000);
        const riskEvidenceExpanded = Boolean(document.querySelector('[data-testid="risk-evidence-expanded"]'));
        document.querySelector('[data-testid="risk-action-insight"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="risk-action-expanded"]'), 5000);
        const riskActionExpanded = Boolean(document.querySelector('[data-testid="risk-action-expanded"]'));
        document.querySelector('[data-testid="risk-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="risk-assignee-input"]'), 5000);
        clickRequired('开始处理');
        await waitUntil(() => document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('处理中'), 8000);
        const riskInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const riskAssigneeInput = document.querySelector('[data-testid="risk-assignee-input"]');
        const riskDueInput = document.querySelector('[data-testid="risk-due-input"]');
        riskInputSetter.call(riskAssigneeInput, '售前李工');
        riskAssigneeInput.dispatchEvent(new Event('input', { bubbles: true }));
        riskInputSetter.call(riskDueInput, '下周一 10:00');
        riskDueInput.dispatchEvent(new Event('input', { bubbles: true }));
        clickRequired('延期处理');
        await waitUntil(() => document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('已延期'), 8000);
        const deferredText = document.querySelector('[data-testid="page-risk"]')?.textContent ?? '';
        const riskAssigneeAfterDefer = document.querySelector('[data-testid="risk-assignee-input"]');
        riskInputSetter.call(riskAssigneeAfterDefer, '继振');
        riskAssigneeAfterDefer.dispatchEvent(new Event('input', { bubbles: true }));
        clickRequired('关闭风险');
        await waitUntil(() => document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('已关闭'), 8000);
        window.__qaRisk = {
          hasQuickRecordSource: document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('快速记录') ?? false,
          hidesInternalSourceType: !(document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('quick_record') ?? false),
          statusDeferred: deferredText.includes('已延期'),
          statusClosed: document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('已关闭') ?? false,
          assigneeUpdated: document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('继振') ?? false,
          dueUpdated: document.querySelector('[data-testid="page-risk"]')?.textContent?.includes('下周一 10:00') ?? false,
          evidenceExpanded: riskEvidenceExpanded,
          actionExpanded: riskActionExpanded,
          localSearch: riskLocalSearch,
          detailViewOpened: riskDetailViewOpened,
          text: document.querySelector('[data-testid="page-risk"]')?.textContent ?? '',
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('下一步动作'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-actions"]'), 5000);
        const actionsSearch = document.querySelector('[data-testid="actions-local-search"]');
        if (!actionsSearch) throw new Error('Missing actions local search');
        setInputValue(actionsSearch, '补齐');
        await waitUntil(() => actionsSearch.closest('.list-panel')?.textContent?.includes('补齐'), 5000);
        const actionLocalSearch = actionsSearch.closest('.list-panel')?.textContent?.includes('补齐') ?? false;
        const actionDetailButton = document.querySelector('[data-testid="actions-open-detail"]');
        if (!actionDetailButton) throw new Error('Missing action detail navigation button');
        actionDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="action-detail-view"]'), 5000);
        const actionDetailViewOpened = Boolean(document.querySelector('[data-testid="action-detail-view"]'));
        document.querySelector('[data-testid="action-edit-detail"]')?.click();
        await waitUntil(() => {
          const inputs = [...document.querySelectorAll('[data-testid="page-actions"] input')]
            .filter((input) => input.getAttribute('data-testid') !== 'actions-local-search');
          return inputs.length >= 2;
        }, 5000);
        const actionInputs = [...document.querySelectorAll('[data-testid="page-actions"] input')]
          .filter((input) => input.getAttribute('data-testid') !== 'actions-local-search');
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        inputSetter.call(actionInputs[0], '售前李工');
        actionInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputSetter.call(actionInputs[1], '周五 17:00');
        actionInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        clickRequired('延期跟进');
        await waitUntil(() => document.querySelector('[data-testid="page-actions"]')?.textContent?.includes('已延期'), 8000);
        inputSetter.call(actionInputs[0], '继振');
        actionInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        clickRequired('标记完成');
        await waitUntil(() => document.querySelector('[data-testid="page-actions"]')?.textContent?.includes('已完成'), 8000);
        window.__qaAction = {
          statusDone: document.querySelector('[data-testid="page-actions"]')?.textContent?.includes('已完成') ?? false,
          assigneeUpdated: document.querySelector('[data-testid="page-actions"]')?.textContent?.includes('继振') ?? false,
          dueUpdated: document.querySelector('[data-testid="page-actions"]')?.textContent?.includes('周五 17:00') ?? false,
          localSearch: actionLocalSearch,
          detailViewOpened: actionDetailViewOpened,
          text: document.querySelector('[data-testid="page-actions"]')?.textContent ?? '',
        };

        const setControlValue = (control, value) => {
          const prototype = control.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : control.tagName === 'SELECT'
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
          setter.call(control, value);
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const setEditorField = (root, labelText, value) => {
          const field = [...root.querySelectorAll('.form-field')].find((item) => item.querySelector('span')?.textContent?.trim() === labelText);
          if (!field) throw new Error('Missing editor field ' + labelText);
          const control = field.querySelector('input, textarea, select');
          setControlValue(control, value);
        };
        const getEditorControl = (root, labelText) => {
          const field = [...root.querySelectorAll('.form-field')].find((item) => item.querySelector('span')?.textContent?.trim() === labelText);
          if (!field) throw new Error('Missing editor field ' + labelText);
          return field.querySelector('input, textarea, select');
        };
        const clickEditorButton = (root, labelText) => {
          const button = [...root.querySelectorAll('button')].find((item) => item.textContent.includes(labelText));
          if (!button) throw new Error('Missing editor button ' + labelText);
          button.click();
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('客户画像'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]'), 5000);
        document.querySelector('[data-testid="customer-create-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-detail-view"] [data-testid="customer-editor"]'), 5000);
        const customerEditor = document.querySelector('[data-testid="customer-editor"]');
        const customerCreateStartsBlank =
          (document.querySelector('[data-testid="page-customer"] h1')?.textContent?.includes('新增客户') ?? false)
          && getEditorControl(customerEditor, '客户名称')?.value === ''
          && customerEditor.textContent.includes('创建客户');
        setEditorField(customerEditor, '客户名称', '测试集成客户');
        setEditorField(customerEditor, '区域', '青岛测试');
        setEditorField(customerEditor, '类型', '集成测试');
        setEditorField(customerEditor, '级别', '新建线索');
        setEditorField(customerEditor, '联系人', '测试联系人');
        setEditorField(customerEditor, '客户摘要', '由集成 QA 创建的客户画像。');
        setEditorField(customerEditor, '核心需求', '验证客户创建\\n验证客户编辑');
        clickEditorButton(customerEditor, '创建客户');
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]')?.textContent?.includes('测试集成客户'), 8000);
        const customerCreated = document.querySelector('[data-testid="page-customer"]')?.textContent?.includes('测试集成客户') ?? false;
        document.querySelector('[data-testid="customer-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'), 5000);
        const originalCustomerLevel = getEditorControl(document.querySelector('[data-testid="customer-editor"]'), '级别')?.value;
        setEditorField(document.querySelector('[data-testid="customer-editor"]'), '级别', '取消不应保存');
        document.querySelector('[data-testid="customer-cancel-edit"]')?.click();
        await waitUntil(
          () => document.querySelector('[data-testid="customer-detail-view"]') && !document.querySelector('[data-testid="customer-editor"]'),
          5000,
        );
        document.querySelector('[data-testid="customer-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'), 5000);
        const customerCancelPreserved = getEditorControl(
          document.querySelector('[data-testid="customer-editor"]'),
          '级别',
        )?.value === originalCustomerLevel;
        setEditorField(document.querySelector('[data-testid="customer-editor"]'), '级别', '重点培育');
        document.querySelector('[data-testid="customer-save-edit"]')?.click();
        await waitUntil(
          () => document.querySelector('[data-testid="customer-detail-view"]') && !document.querySelector('[data-testid="customer-editor"]'),
          8000,
        );
        const customerSaveClosedEditor = !document.querySelector('[data-testid="customer-editor"]');
        document.querySelector('[data-testid="customer-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'), 5000);
        const customerUpdated = getEditorControl(document.querySelector('[data-testid="customer-editor"]'), '级别')?.value === '重点培育';
        document.querySelector('[data-testid="customer-cancel-edit"]')?.click();
        await waitUntil(() => !document.querySelector('[data-testid="customer-editor"]'), 5000);

        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('返回列表'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-list-view"]'), 5000);
        document.querySelector('[data-testid="customer-create-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'), 5000);
        setEditorField(document.querySelector('[data-testid="customer-editor"]'), '客户名称', '测试删除客户');
        setEditorField(document.querySelector('[data-testid="customer-editor"]'), '区域', '删除验证');
        setEditorField(document.querySelector('[data-testid="customer-editor"]'), '类型', '集成测试');
        document.querySelector('[data-testid="customer-save-edit"]')?.click();
        await waitUntil(
          () => document.querySelector('[data-testid="page-customer"] h1')?.textContent?.includes('测试删除客户')
            && !document.querySelector('[data-testid="customer-editor"]'),
          8000,
        );
        window.confirm = () => false;
        document.querySelector('[data-testid="customer-delete-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-delete-dialog"]'), 5000);
        const customerDeleteDialogVisible = Boolean(document.querySelector('[data-testid="customer-delete-dialog"]'));
        document.querySelector('[data-testid="customer-delete-cancel"]')?.click();
        await waitUntil(() => !document.querySelector('[data-testid="customer-delete-dialog"]'), 5000);
        const customerDeleteCancelPreserved =
          document.querySelector('[data-testid="page-customer"] h1')?.textContent?.includes('测试删除客户') ?? false;
        document.querySelector('[data-testid="customer-delete-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-delete-dialog"]'), 5000);
        document.querySelector('[data-testid="customer-delete-confirm"]')?.click();
        await waitUntil(
          () => document.querySelector('[data-testid="customer-list-view"]')
            && !document.querySelector('[data-testid="customer-list-view"]')?.textContent?.includes('测试删除客户'),
          8000,
        );
        const customerDeleteConfirmed =
          !document.querySelector('[data-testid="customer-list-view"]')?.textContent?.includes('测试删除客户');

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('商机档案'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-opportunity"]'), 5000);
        document.querySelector('[data-testid="opportunity-create-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-detail-view"] [data-testid="opportunity-editor"]'), 5000);
        const opportunityEditor = document.querySelector('[data-testid="opportunity-editor"]');
        const opportunityCreateStartsBlank =
          (document.querySelector('[data-testid="page-opportunity"] h1')?.textContent?.includes('新增商机') ?? false)
          && getEditorControl(opportunityEditor, '商机名称')?.value === ''
          && opportunityEditor.textContent.includes('创建商机');
        const customerSelect = [...document.querySelectorAll('[data-testid="opportunity-editor"] .form-field')]
          .find((item) => item.querySelector('span')?.textContent?.trim() === '关联客户')
          ?.querySelector('select');
        const testCustomerOption = [...customerSelect.options].find((option) => option.textContent.includes('测试集成客户'));
        if (!testCustomerOption) throw new Error('New customer option was not available for opportunity editor');
        setControlValue(customerSelect, testCustomerOption.value);
        setEditorField(document.querySelector('[data-testid="opportunity-editor"]'), '商机名称', '测试集成客户规划调研');
        setEditorField(document.querySelector('[data-testid="opportunity-editor"]'), '阶段', '线索');
        setEditorField(document.querySelector('[data-testid="opportunity-editor"]'), '金额', '待定');
        setEditorField(document.querySelector('[data-testid="opportunity-editor"]'), '需求', '验证商机创建\\n验证商机编辑\\n移动云规划知识引用');
        clickEditorButton(document.querySelector('[data-testid="opportunity-editor"]'), '创建商机');
        await waitUntil(() => document.querySelector('[data-testid="page-opportunity"]')?.textContent?.includes('测试集成客户规划调研'), 8000);
        const opportunityCreated = document.querySelector('[data-testid="page-opportunity"]')?.textContent?.includes('测试集成客户规划调研') ?? false;
        document.querySelector('[data-testid="opportunity-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-editor"]'), 5000);
        setEditorField(document.querySelector('[data-testid="opportunity-editor"]'), '阶段', '初步沟通');
        clickEditorButton(document.querySelector('[data-testid="opportunity-editor"]'), '保存商机');
        await waitUntil(() => document.querySelector('[data-testid="opportunity-detail-view"]'), 8000);
        document.querySelector('[data-testid="opportunity-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-editor"]'), 5000);
        const opportunityUpdated = getEditorControl(document.querySelector('[data-testid="opportunity-editor"]'), '阶段')?.value === '初步沟通';
        clickEditorButton(document.querySelector('[data-testid="opportunity-editor"]'), '取消修改');
        await waitUntil(() => document.querySelector('[data-testid="opportunity-detail-view"]') && !document.querySelector('[data-testid="opportunity-editor"]'), 5000);
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('返回列表'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="opportunity-list-view"]'), 5000);
        const otherOpportunityButton = [...document.querySelectorAll('[data-testid="opportunity-list-view"] .list-button')]
          .find((button) => !button.textContent.includes('测试集成客户规划调研'));
        if (!otherOpportunityButton) throw new Error('Missing another opportunity to verify customer link switching');
        otherOpportunityButton.click();
        otherOpportunityButton.querySelector('[data-testid="opportunity-open-detail"]')?.click();
        await waitUntil(() => {
          const title = document.querySelector('[data-testid="page-opportunity"] h1')?.textContent ?? '';
          return title && !title.includes('测试集成客户规划调研');
        }, 5000);
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('客户画像'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"]'), 5000);
        [...document.querySelectorAll('[data-testid="page-customer"] .list-button')]
          .find((button) => button.textContent.includes('测试集成客户'))?.click();
        [...document.querySelectorAll('[data-testid="customer-open-detail"]')]
          .find((button) => button.closest('.list-button')?.textContent.includes('测试集成客户'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-customer"] h1')?.textContent?.includes('测试集成客户'), 5000);
        const linkedOpportunity = [...document.querySelectorAll('[data-testid="page-customer"] .plain-link')]
          .find((button) => button.textContent.includes('测试集成客户规划调研'));
        if (!linkedOpportunity) throw new Error('Missing customer linked opportunity for the created opportunity');
        linkedOpportunity.click();
        await waitUntil(() => document.querySelector('[data-testid="page-opportunity"]'), 5000);
        const linkedOpportunityOpened = document.querySelector('[data-testid="page-opportunity"] h1')?.textContent?.includes('测试集成客户规划调研') ?? false;
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('商机看板'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-kanban"]'), 5000);
        const kanbanDynamicCard = [...document.querySelectorAll('[data-testid="page-kanban"] .deal-card')]
          .find((button) => button.textContent.includes('测试集成客户规划调研'));
        const kanbanShowsDynamicOpportunity = Boolean(kanbanDynamicCard);
        const kanbanAdvanceButton = kanbanDynamicCard?.querySelector('[data-testid="kanban-stage-forward"]');
        const kanbanAdvanceAvailable = Boolean(kanbanAdvanceButton);
        kanbanAdvanceButton?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-kanban"]')?.textContent?.includes('看板已更新'), 8000);
        const kanbanMovedCard = [...document.querySelectorAll('[data-testid="page-kanban"] .deal-card')]
          .find((button) => button.textContent.includes('测试集成客户规划调研'));
        const kanbanAdvanced = kanbanMovedCard?.textContent?.includes('调研机会') ?? false;
        kanbanMovedCard?.querySelector('[data-testid="kanban-open-opportunity"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-opportunity"]'), 5000);
        const kanbanDynamicOpportunityOpened = document.querySelector('[data-testid="page-opportunity"] h1')?.textContent?.includes('测试集成客户规划调研') ?? false;
        window.__qaEdit = {
          customerCreateStartsBlank,
          customerCreated,
          customerCancelPreserved,
          customerSaveClosedEditor,
          customerUpdated,
          customerDeleteDialogVisible,
          customerDeleteCancelPreserved,
          customerDeleteConfirmed,
          opportunityCreateStartsBlank,
          opportunityCreated,
          opportunityUpdated,
          dynamicCustomerOpportunityLink: linkedOpportunityOpened,
          kanbanShowsDynamicOpportunity,
          kanbanAdvanceAvailable,
          kanbanAdvanced,
          kanbanDynamicOpportunityOpened,
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('知识库'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"]'), 5000);
        await waitUntil(() => document.querySelector('[data-testid="knowledge-list-view"]'), 5000);
        document.querySelector('[data-testid="knowledge-create-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="knowledge-detail-view"] [data-testid="knowledge-editor"]'), 5000);
        const knowledgeEditor = document.querySelector('[data-testid="knowledge-editor"]');
        const knowledgeCreateStartsBlank =
          (document.querySelector('[data-testid="page-knowledge"] h1')?.textContent?.includes('新增知识材料') ?? false)
          && getEditorControl(knowledgeEditor, '标题')?.value === ''
          && knowledgeEditor.textContent.includes('创建知识');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '标题', '集成测试移动云规划知识引用');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '分类', '方案材料');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '标签', '移动云\\n规划\\n集成测试');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '来源', '集成 QA');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '摘要', '用于验证方案草稿能够引用知识库材料。');
        setEditorField(document.querySelector('[data-testid="knowledge-editor"]'), '正文 / 引用口径', '移动云规划知识引用需要进入方案草稿的知识库引用章节。');
        clickEditorButton(document.querySelector('[data-testid="knowledge-editor"]'), '创建知识');
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"]')?.textContent?.includes('集成测试移动云规划知识引用'), 8000);
        clickRequired('返回列表');
        await waitUntil(() => document.querySelector('[data-testid="knowledge-list-view"]'), 5000);
        const knowledgeSearchInput = document.querySelector('[data-testid="knowledge-search"] input');
        setControlValue(knowledgeSearchInput, '移动云规划知识引用');
        document.querySelector('[data-testid="knowledge-search"] button')?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"]')?.textContent?.includes('已找到'), 8000);
        const knowledgeCreated = document.body.textContent.includes('集成测试移动云规划知识引用');
        const knowledgeSearched = document.querySelector('[data-testid="page-knowledge"]')?.textContent?.includes('已找到') ?? false;
        const searchedKnowledgeDetailButton = [...document.querySelectorAll('[data-testid="knowledge-list-view"] .customer-list-row')]
          .find((row) => row.textContent.includes('集成测试移动云规划知识引用'))
          ?.querySelector('[data-testid="knowledge-open-detail"]');
        if (!searchedKnowledgeDetailButton) throw new Error('Missing created knowledge detail navigation button');
        searchedKnowledgeDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"] h1')?.textContent?.includes('集成测试移动云规划知识引用'), 5000);
        const knowledgeDetailOpened = Boolean(document.querySelector('[data-testid="knowledge-detail-view"]'));
        const solutionCitationButton = [...document.querySelectorAll('[data-testid="knowledge-citation-actions"] button')]
          .find((button) => button.textContent.includes('引用到方案'));
        const solutionWriteEntryAbsent = !solutionCitationButton;
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('知识库'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="knowledge-list-view"]')?.textContent?.includes('集成测试移动云规划知识引用'), 8000);
        const weeklyKnowledgeDetailButton = [...document.querySelectorAll('[data-testid="knowledge-list-view"] .customer-list-row')]
          .find((row) => row.textContent.includes('集成测试移动云规划知识引用'))
          ?.querySelector('[data-testid="knowledge-open-detail"]');
        if (!weeklyKnowledgeDetailButton) throw new Error('Missing weekly knowledge detail navigation button');
        weeklyKnowledgeDetailButton.click();
        await waitUntil(() => document.querySelector('[data-testid="page-knowledge"] h1')?.textContent?.includes('集成测试移动云规划知识引用'), 5000);
        const weeklyCitationButton = [...document.querySelectorAll('[data-testid="knowledge-citation-actions"] button')]
          .find((button) => button.textContent.includes('引用到周报'));
        weeklyCitationButton?.click();
        const weeklyCitationText = await waitUntil(() => {
          const draft = document.querySelector('[data-testid="page-weekly"] [data-testid="generated-draft"]')?.textContent ?? '';
          return draft.includes('集成测试移动云规划知识引用') && draft.includes('知识库引用') ? draft : '';
        }, 10000);
        window.__qaKnowledge = {
          createStartsBlank: knowledgeCreateStartsBlank,
          created: knowledgeCreated,
          searched: knowledgeSearched,
          detailOpened: knowledgeDetailOpened,
          solutionWriteEntryAbsent,
          weeklyCited: Boolean(weeklyCitationText),
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('周报'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-weekly"]'), 5000);
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('周报分析汇总'))?.click();
        await wait(200);
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('手动生成'))?.click();
        const weeklyDraftText = await waitUntil(() => {
          const draft = document.querySelector('[data-testid="generated-draft"]')?.textContent ?? '';
          return draft.includes('本周重点进展') ? draft : '';
        }, 8000);
        document.querySelector('[data-testid="weekly-daily-tab"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="weekly-daily-view"]'), 5000);
        cardInteractions.weeklyDailyUsesRealSources =
          document.querySelectorAll('[data-testid="weekly-daily-view"] .day-card').length > 0;
        const realWeeklyDayCard = await waitUntil(
          () => document.querySelector('[data-testid="weekly-daily-view"] .day-card'),
          5000,
        );
        realWeeklyDayCard.click();
        await waitUntil(() => document.querySelector('[data-testid="weekly-expanded-day"]'), 5000);
        cardInteractions.weeklyDayExpanded = Boolean(document.querySelector('[data-testid="weekly-expanded-day"]'));
        document.querySelector('[data-testid="weekly-summary-tab"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="weekly-summary-view"]'), 5000);
        cardInteractions.weeklySummaryUsesDraft =
          document.querySelector('[data-testid="weekly-summary-view"]')?.textContent?.includes('本周重点进展') ?? false;
        const realWeeklyMetricCard = await waitUntil(
          () => document.querySelector('[data-testid="weekly-summary-view"] .metric-card'),
          5000,
        );
        realWeeklyMetricCard.click();
        await waitUntil(() => document.querySelector('[data-testid="weekly-summary-view"] [data-testid="metric-expanded"]'), 5000);
        cardInteractions.weeklyMetricExpanded = Boolean(
          document.querySelector('[data-testid="weekly-summary-view"] [data-testid="metric-expanded"]'),
        );
        const weeklyEditor = await waitUntil(() => document.querySelector('[data-testid="weekly-draft-editor"]'), 8000);
        const weeklyTextarea = weeklyEditor.querySelector('textarea');
        const weeklyTextSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        weeklyTextSetter.call(weeklyTextarea, weeklyTextarea.value + '\\n\\n管理确认版：本周汇报材料已人工确认。');
        weeklyTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        const currentWeeklyEditor = document.querySelector('[data-testid="weekly-draft-editor"]');
        const saveWeeklyButton = [...currentWeeklyEditor.querySelectorAll('button')].find((button) => button.textContent.includes('保存周报'));
        if (!saveWeeklyButton) throw new Error('Missing weekly save button');
        saveWeeklyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await waitUntil(() => {
          const text = document.querySelector('[data-testid="page-weekly"]')?.textContent ?? '';
          const editorText = document.querySelector('[data-testid="weekly-draft-editor"]')?.textContent ?? '';
          return text.includes('周报已保存') || text.includes('可导出 Word') || editorText.includes('已保存');
        }, 8000);
        const readyWeeklyEditor = document.querySelector('[data-testid="weekly-draft-editor"]');
        const readyWeeklyButton = [...readyWeeklyEditor.querySelectorAll('button')].find((button) => button.textContent.includes('确认定稿'));
        if (!readyWeeklyButton) throw new Error('Missing weekly ready button');
        readyWeeklyButton.click();
        await waitUntil(() => document.querySelector('[data-testid="page-weekly"]')?.textContent?.includes('可导出 Word'), 8000);
        const finalWeeklyEditor = document.querySelector('[data-testid="weekly-draft-editor"]');
        const savedConfirmed = document.querySelector('[data-testid="page-weekly"]')?.textContent?.includes('周报已保存')
          || document.querySelector('[data-testid="page-weekly"]')?.textContent?.includes('可导出 Word');
        const readyConfirmed = document.querySelector('[data-testid="page-weekly"]')?.textContent?.includes('可导出 Word') ?? false;
        const weeklyExportButton = finalWeeklyEditor.querySelector('[data-testid="weekly-export-button"]');
        if (!weeklyExportButton) throw new Error('Missing weekly export button');
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        let exportUrl = '';
        let revokedUrl = '';
        let exportFilename = '';
        let exportClicked = false;
        try {
          URL.createObjectURL = (blob) => {
            exportUrl = 'blob:weekly-qa-' + blob.size;
            return exportUrl;
          };
          URL.revokeObjectURL = (value) => {
            revokedUrl = value;
          };
          HTMLAnchorElement.prototype.click = function clickWeeklyExport() {
            exportClicked = true;
            exportFilename = this.download;
          };
          weeklyExportButton.click();
          await waitUntil(() => document.querySelector('[data-testid="page-weekly"]')?.textContent?.includes('周报 Word 已导出'), 8000);
          await waitUntil(() => revokedUrl === exportUrl, 3000);
        } finally {
          URL.createObjectURL = originalCreateObjectURL;
          URL.revokeObjectURL = originalRevokeObjectURL;
          HTMLAnchorElement.prototype.click = originalAnchorClick;
        }
        window.__qaWeeklyEditor = {
          saved: savedConfirmed,
          ready: readyConfirmed,
          editedText: weeklyTextarea.value.includes('管理确认版'),
          exportClicked,
          exportFilename,
          exportUrlRevoked: Boolean(exportUrl) && revokedUrl === exportUrl,
          exportLabel: weeklyExportButton.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        };

        window.__qaDrafts = {
          weekly: weeklyDraftText,
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('智能拜访行程'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="itinerary-list-view"]'), 5000);
        const itineraryListOpened = Boolean(document.querySelector('[data-testid="itinerary-list-view"]'));
        const itineraryTitle = ${JSON.stringify(historicalItinerary?.title ?? "")};
        const itineraryRow = [...document.querySelectorAll('.itinerary-table-row')]
          .find((row) => row.textContent.includes(itineraryTitle));
        const itineraryDetailButton = [...(itineraryRow?.querySelectorAll('button') ?? [])]
          .find((button) => button.textContent.includes('查看详情'));
        if (!itineraryDetailButton) throw new Error('Missing saved itinerary detail button');
        itineraryDetailButton.click();
        const itineraryDetail = await waitUntil(
          () => document.querySelector('[data-testid="itinerary-detail-view"]'),
          5000,
        );
        const itineraryMapCanvas = itineraryDetail.querySelector('.itinerary-map-canvas');
        await waitUntil(() => {
          const status = itineraryMapCanvas?.dataset.mapStatus;
          return status && status !== 'loading';
        }, 10000);
        const itineraryMapStatus = itineraryMapCanvas?.dataset.mapStatus ?? 'missing';
        const itineraryMarkers = itineraryDetail.querySelectorAll('.itinerary-map-marker').length;
        const itineraryMapSurface = Boolean(
          itineraryMapCanvas?.querySelector('.amap-maps, canvas, svg'),
        );
        const itineraryNavigationHref = itineraryDetail
          .querySelector('.itinerary-navigation-link')?.getAttribute('href') ?? '';
        const itineraryDetailReadOnly = itineraryDetail.querySelectorAll('input, textarea, select').length === 0;
        const itineraryEditAvailable = [...itineraryDetail.querySelectorAll('button')]
          .some((button) => button.textContent.includes('修改'));
        const itineraryBackButton = [...itineraryDetail.querySelectorAll('button')]
          .find((button) => button.textContent.includes('返回列表'));
        if (!itineraryBackButton) throw new Error('Missing itinerary back button');
        itineraryBackButton.click();
        await waitUntil(() => document.querySelector('[data-testid="itinerary-list-view"]'), 5000);
        const itinerarySearch = document.querySelector('[data-testid="itinerary-local-search"]');
        if (!itinerarySearch) throw new Error('Missing itinerary local search');
        setInputValue(itinerarySearch, itineraryTitle);
        await waitUntil(() => itinerarySearch.value === itineraryTitle, 3000);
        const itineraryLocalSearch = itinerarySearch.value === itineraryTitle
          && document.querySelector('[data-testid="itinerary-list-view"]')?.textContent?.includes(itineraryTitle);
        const itineraryCreateButton = document.querySelector('[data-testid="itinerary-create-detail"]');
        if (!itineraryCreateButton) throw new Error('Missing itinerary create button');
        itineraryCreateButton.click();
        const itineraryEditor = await waitUntil(
          () => document.querySelector('[data-testid="itinerary-form-view"]'),
          5000,
        );
        const itineraryStops = [...itineraryEditor.querySelectorAll('.itinerary-stop-editor')];
        const itineraryCreateStartsBlank =
          (document.querySelector('[data-testid="page-itinerary"] h1')?.textContent?.includes('新建拜访行程') ?? false)
          && getEditorControl(itineraryEditor, '行程名称')?.value === ''
          && getEditorControl(itineraryEditor, '拜访日期')?.value === ''
          && getEditorControl(itineraryEditor, '出发时间')?.value === ''
          && getEditorControl(itineraryEditor, '出发地址')?.value === '';
        const itineraryOneEmptyStop = itineraryStops.length === 1
          && getEditorControl(itineraryStops[0], '客户名称')?.value === ''
          && getEditorControl(itineraryStops[0], '客户地址')?.value === '';
        let itineraryCreatedWithAmap = false;
        let itineraryCreatedMapReady = false;
        let itineraryCreatedDistance = '';
        let itineraryDeleted = false;
        if (${realItineraryFlow ? "true" : "false"}) {
          setEditorField(itineraryEditor, '行程名称', '真实高德集成行程');
          setEditorField(itineraryEditor, '拜访日期', '2026-07-29');
          setEditorField(itineraryEditor, '出发时间', '2026-07-29T08:00');
          setEditorField(itineraryEditor, '出发地址', '黄岛区秀兰禧悦山');
          setEditorField(itineraryEditor, '出发城市', '青岛');
          setEditorField(itineraryStops[0], '客户名称', '济宁市第二人民医院');
          setEditorField(itineraryStops[0], '客户地址', '济宁市第二人民医院');
          setEditorField(itineraryStops[0], '城市', '济宁');
          const createItineraryButton = [...itineraryEditor.querySelectorAll('button')]
            .find((button) => button.textContent.includes('生成并保存行程'));
          if (!createItineraryButton) throw new Error('Missing itinerary save button');
          createItineraryButton.click();
          const createdItineraryDetail = await waitUntil(() => {
            const detail = document.querySelector('[data-testid="itinerary-detail-view"]');
            const heading = document.querySelector('[data-testid="page-itinerary"] h1')?.textContent ?? '';
            return detail && heading.includes('真实高德集成行程') ? detail : null;
          }, 20000);
          itineraryCreatedWithAmap = Boolean(createdItineraryDetail);
          await waitUntil(
            () => createdItineraryDetail.querySelector('.itinerary-map-canvas')?.dataset.mapStatus === 'ready',
            10000,
          );
          itineraryCreatedMapReady = true;
          itineraryCreatedDistance = createdItineraryDetail
            .querySelector('.itinerary-metric-grid b')?.textContent?.trim() ?? '';
          const deleteItineraryButton = [...createdItineraryDetail.querySelectorAll('.detail-toolbar-actions button')]
            .find((button) => button.textContent.includes('删除'));
          if (!deleteItineraryButton) throw new Error('Missing created itinerary delete button');
          deleteItineraryButton.click();
          const deleteConfirmation = await waitUntil(
            () => document.querySelector('[data-testid="itinerary-delete-confirmation"]'),
            3000,
          );
          const confirmDeleteButton = [...deleteConfirmation.querySelectorAll('button')]
            .find((button) => button.textContent.includes('确认删除'));
          if (!confirmDeleteButton) throw new Error('Missing itinerary delete confirmation button');
          confirmDeleteButton.click();
          await waitUntil(() => document.querySelector('[data-testid="itinerary-list-view"]'), 8000);
          itineraryDeleted = !document.querySelector('[data-testid="itinerary-list-view"]')
            ?.textContent?.includes('真实高德集成行程');
        }
        window.__qaItinerary = {
          listOpened: itineraryListOpened,
          localSearch: itineraryLocalSearch,
          detailReadOnly: itineraryDetailReadOnly,
          editAvailable: itineraryEditAvailable,
          navigationKeyFree: Boolean(itineraryNavigationHref)
            && !/[?&]key=|security|jscode/i.test(itineraryNavigationHref),
          mapStatus: itineraryMapStatus,
          mapMarkers: itineraryMarkers,
          mapSurface: itineraryMapSurface,
          createStartsBlank: itineraryCreateStartsBlank,
          oneEmptyStop: itineraryOneEmptyStop,
          createdWithAmap: itineraryCreatedWithAmap,
          createdMapReady: itineraryCreatedMapReady,
          createdDistance: itineraryCreatedDistance,
          deleted: itineraryDeleted,
        };

        const expenseNav = document.querySelector('[data-testid="nav-expense"]');
        if (!expenseNav) throw new Error('Missing travel expense navigation');
        expenseNav.click();
        const expensePage = await waitUntil(
          () => document.querySelector('[data-testid="page-expense"]'),
          5000,
        );
        await waitUntil(() => !expensePage.querySelector('.expense-loading'), 10000);
        const expectedExpenseTabs = ['overview', 'ledger', 'proofs', 'invoices', 'settlement', 'organize'];
        const expenseTabIds = [...expensePage.querySelectorAll('[data-testid^="expense-tab-"]')]
          .map((tab) => tab.getAttribute('data-testid')?.replace('expense-tab-', '') ?? '');
        const naturalWeekInput = expensePage.querySelector('input[type="week"]');
        const organizeTab = expensePage.querySelector('[data-testid="expense-tab-organize"]');
        if (!organizeTab) throw new Error('Missing travel expense organize tab');
        organizeTab.click();
        await waitUntil(
          () => organizeTab.getAttribute('aria-selected') === 'true'
            && expensePage.querySelector('.expense-organizer-view'),
          3000,
        );
        const openExpenseEditorButton = [...expensePage.querySelectorAll('button')]
          .find((button) => button.textContent.includes('记一笔'));
        if (!openExpenseEditorButton) throw new Error('Missing travel expense create button');
        openExpenseEditorButton.click();
        const expenseEditor = await waitUntil(
          () => document.querySelector('.expense-drawer[role="dialog"]'),
          3000,
        );
        const expenseEditorControls = [...expenseEditor.querySelectorAll('input, select, textarea')];
        const expenseEditorLabelsComplete = expenseEditorControls.length > 0
          && expenseEditorControls.every((control) => {
            if (control.closest('label')?.textContent?.trim()) return true;
            if (control.getAttribute('aria-label')?.trim()) return true;
            if (!control.id) return false;
            return [...expenseEditor.querySelectorAll('label')]
              .some((label) => label.htmlFor === control.id && label.textContent?.trim());
          });
        const closeExpenseEditorButton = [...expenseEditor.querySelectorAll('button')]
          .find((button) => button.getAttribute('aria-label') === '关闭费用录入');
        if (!closeExpenseEditorButton) throw new Error('Missing travel expense editor close button');
        closeExpenseEditorButton.click();
        await waitUntil(() => !document.querySelector('.expense-drawer[role="dialog"]'), 3000);
        window.__qaExpense = {
          pageOpened: Boolean(expensePage),
          loadedWithoutAlert: !expensePage.querySelector('.expense-loading')
            && !expensePage.querySelector('.expense-page-alert'),
          tabsPresent: expectedExpenseTabs.every((tabId) => expenseTabIds.includes(tabId))
            && expenseTabIds.length === expectedExpenseTabs.length,
          tabIds: expenseTabIds,
          naturalWeekInput: naturalWeekInput?.type === 'week'
            && /^\\d{4}-W\\d{2}$/.test(naturalWeekInput.value),
          weekValue: naturalWeekInput?.value ?? '',
          organizeOpened: organizeTab.getAttribute('aria-selected') === 'true'
            && Boolean(expensePage.querySelector('.expense-organizer-view')),
          editorOpened: Boolean(expenseEditor),
          editorControlCount: expenseEditorControls.length,
          editorLabelsComplete: expenseEditorLabelsComplete,
          editorClosed: !document.querySelector('.expense-drawer[role="dialog"]'),
        };

        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('快速记录'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
      }

      if (${viewport.fullFlow ? "true" : "false"}) {
        const forbiddenTerms = ['原型', 'mock', 'MOCK', 'WSL', 'Apple-style', '全局 AI', '抽屉', '占位', '静态', '后端', '正式调用', 'Manual AI', 'quick_record', 'manual_audit', 'opportunity_diagnosis'];
        const forbiddenByPage = [];
        for (const nav of document.querySelectorAll('.nav-item')) {
          const pageLabel = nav.textContent.trim();
          nav.click();
          await waitUntil(() => document.querySelector('[data-testid^="page-"]'), 5000);
          await wait(120);
          const page = document.querySelector('[data-testid^="page-"]');
          const text = page?.textContent ?? '';
          const terms = forbiddenTerms.filter((term) => text.includes(term));
          if (terms.length > 0) forbiddenByPage.push({ page: pageLabel, terms });
        }
        window.__qaProductionCopy = { forbiddenByPage };
        [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('快速记录'))?.click();
        await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);
      }

      const interactiveIssuesByPage = [];
      const listRowIssuesByPage = [];
      for (const nav of document.querySelectorAll('.nav-item')) {
        const pageLabel = nav.textContent.trim();
        (document.scrollingElement || document.documentElement).scrollTo(0, 0);
        nav.click();
        await waitUntil(() => document.querySelector('[data-testid^="page-"]'), 5000);
        await wait(120);
        const controls = await inspectCurrentPageAcrossScroll(pageLabel);
        if (controls.unnamed.length || controls.smallTargets.length || controls.textOverflow.length) {
          interactiveIssuesByPage.push({ page: pageLabel, ...controls });
        }
        const listRows = inspectBusinessListRows(pageLabel);
        if (listRows.length) listRowIssuesByPage.push({ page: pageLabel, rows: listRows });
      }
      if (window.innerWidth <= 430) {
        document.querySelector('[data-testid="nav-customer"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-list-view"]'), 5000);
        document.querySelector('[data-testid="customer-open-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-detail-view"]'), 5000);
        const detailControls = await inspectCurrentPageAcrossScroll('客户详情');
        if (detailControls.unnamed.length || detailControls.smallTargets.length || detailControls.textOverflow.length) {
          interactiveIssuesByPage.push({ page: '客户详情', ...detailControls });
        }
        document.querySelector('[data-testid="customer-edit-detail"]')?.click();
        await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'), 5000);
        const editorControls = await inspectCurrentPageAcrossScroll('客户修改');
        if (editorControls.unnamed.length || editorControls.smallTargets.length || editorControls.textOverflow.length) {
          interactiveIssuesByPage.push({ page: '客户修改', ...editorControls });
        }
        document.querySelector('[data-testid="customer-cancel-edit"]')?.click();
        await waitUntil(() => !document.querySelector('[data-testid="customer-editor"]'), 5000);
      }
      window.__qaInteractiveByPage = { issues: interactiveIssuesByPage };
      window.__qaListRowsByPage = { issues: listRowIssuesByPage };
      [...document.querySelectorAll('.nav-item')].find((button) => button.textContent.includes('快速记录'))?.click();
      await waitUntil(() => document.querySelector('[data-testid="page-quick"]'), 5000);

      const overflowX = Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
        document.body.scrollWidth - window.innerWidth
      );
      const topbarOutOfBounds = [...document.querySelectorAll('.topbar button, .topbar input, .topbar .api-status, .topbar .brand-area, .topbar .avatar')]
        .filter((item) => {
          const bounds = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden' || bounds.width === 0 || bounds.height === 0) return false;
          return bounds.left < -1 || bounds.right > window.innerWidth + 1;
        })
        .map((item) => ({
          text: item.textContent.trim() || item.getAttribute('placeholder') || item.className,
          left: Math.round(item.getBoundingClientRect().left),
          right: Math.round(item.getBoundingClientRect().right),
        }));
      const productWindowBounds = document.querySelector('.product-window').getBoundingClientRect();
      return {
        name: ${JSON.stringify(viewport.name)},
        title: document.title,
        h1: document.querySelector('h1')?.textContent?.trim() ?? '',
        composerTitle: document.querySelector('.composer-head h2')?.textContent?.trim() ?? '',
        apiStatus: document.querySelector('[data-testid="api-status"]')?.textContent?.trim() ?? '',
        brandText: document.querySelector('.brand-area')?.textContent?.trim() ?? '',
        brandLogoSrc: document.querySelector('.brand-area img')?.getAttribute('src') ?? '',
        primaryNavigation: {
          labels: [...document.querySelectorAll('.nav-item')].map((item) => item.textContent.trim()),
          solutionAssistantVisible: [...document.querySelectorAll('.nav-item')]
            .some((item) => item.textContent.includes('方案辅助')),
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        overflowX,
        topbarOutOfBounds,
        hasTopbarSearch: Boolean(document.querySelector('.topbar .search-box input')),
        interactiveControls: inspectInteractiveControls(),
        interactiveIssuesByPage: window.__qaInteractiveByPage ?? { issues: [] },
        listRowIssuesByPage: window.__qaListRowsByPage ?? { issues: [] },
        authFlow: window.__qaAuth ?? {},
        windowInsets: {
          top: Math.round(productWindowBounds.top),
          left: Math.round(productWindowBounds.left),
          right: Math.round(window.innerWidth - productWindowBounds.right),
          bottom: Math.round(window.innerHeight - Math.min(productWindowBounds.bottom, window.innerHeight))
        },
        recordLayoutColumns: getComputedStyle(document.querySelector('.record-layout')).gridTemplateColumns,
        textareaCount: document.querySelectorAll('.record-composer textarea').length,
        matchCards: window.__qaQuick?.matchCards ?? document.querySelectorAll('.match-card').length,
        confirmedCount: window.__qaQuick?.confirmedCount ?? document.querySelectorAll('.manual-sync .confirmed, button.confirmed').length,
        hasBackendRecorded: window.__qaQuick?.hasBackendRecorded ?? document.body.textContent.includes('已同步'),
        syncLogItems: window.__qaQuick?.syncLogItems ?? document.querySelectorAll('.sync-log-item').length,
        syncLogText: window.__qaQuick?.syncLogText ?? document.querySelector('[data-testid="sync-log"]')?.textContent ?? '',
        riskPageHasQuickRecordSource: window.__qaRisk?.hasQuickRecordSource ?? false,
        riskPageHidesInternalSourceType: window.__qaRisk?.hidesInternalSourceType ?? false,
        riskPageStatusDeferred: window.__qaRisk?.statusDeferred ?? false,
        riskPageStatusClosed: window.__qaRisk?.statusClosed ?? false,
        riskPageAssigneeUpdated: window.__qaRisk?.assigneeUpdated ?? false,
        riskPageDueUpdated: window.__qaRisk?.dueUpdated ?? false,
        riskPageEvidenceExpanded: window.__qaRisk?.evidenceExpanded ?? false,
        riskPageActionExpanded: window.__qaRisk?.actionExpanded ?? false,
        riskPageLocalSearch: window.__qaRisk?.localSearch ?? false,
        riskPageDetailViewOpened: window.__qaRisk?.detailViewOpened ?? false,
        riskPageText: window.__qaRisk?.text ?? '',
        actionFlow: window.__qaAction ?? {},
        editFlow: window.__qaEdit ?? {},
        knowledgeFlow: window.__qaKnowledge ?? {},
        itineraryFlow: window.__qaItinerary ?? {},
        expenseFlow: window.__qaExpense ?? {},
        weeklyDraftText: window.__qaDrafts?.weekly ?? '',
        weeklyEditor: window.__qaWeeklyEditor ?? {},
        cardInteractions: window.__qaCardInteractions ?? {},
        aiSuggestions: window.__qaAiSuggestions ?? {},
        voiceFlow: window.__qaVoiceFlow ?? {},
        voiceFallback: window.__qaVoiceFallback ?? {},
        voiceUploadOnly: window.__qaVoiceUploadOnly ?? {},
        productionCopy: window.__qaProductionCopy ?? { forbiddenByPage: [] }
      };
    })()
  `);
}

async function inspectSalesDecisionViewport(cdp, frontendUrl, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await cdp.send("Page.navigate", { url: frontendUrl });

  return evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeoutMs = 8000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out opening the sales decision panel');
      };

      await waitUntil(() => document.querySelector('[data-testid="page-overview"]'));
      const opportunityNav = [...document.querySelectorAll('.nav-item')]
        .find((button) => button.textContent.includes('商机档案'));
      if (!opportunityNav) throw new Error('Missing opportunity navigation');
      opportunityNav.click();
      await waitUntil(() => document.querySelector('[data-testid="opportunity-list-view"]'));

      const opportunityRow = [...document.querySelectorAll('.customer-list-row')]
        .find((row) => row.textContent.includes('日照中医医院'));
      const detailButton = opportunityRow?.querySelector('[data-testid="opportunity-open-detail"]');
      if (!detailButton) throw new Error('Missing sales decision opportunity detail entry');
      detailButton.click();
      await waitUntil(() => document.querySelector('[data-testid="sales-decision-panel"]'));
      await waitUntil(() => {
        const analyze = document.querySelector('[data-testid="sales-decision-analyze"]');
        const settled = document.querySelector('[data-testid="sales-decision-result"], [data-testid="sales-decision-empty"]');
        return analyze && !analyze.disabled && settled;
      });

      const panel = document.querySelector('[data-testid="sales-decision-panel"]');
      panel.scrollIntoView({ block: 'start' });
      await wait(120);
      const panelRect = panel.getBoundingClientRect();
      const grid = panel.querySelector('.sales-decision-grid');
      const gridColumns = grid
        ? getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
        : 0;
      const overflowElements = [...panel.querySelectorAll('button, h3, p, li, .sales-decision-boundary span, .editor-status')]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (bounds.width === 0 || bounds.height === 0 || style.display === 'none' || style.visibility === 'hidden') return false;
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') return false;
          return element.scrollWidth > element.clientWidth + 2;
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: element.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
      const controlTargets = [...panel.querySelectorAll('button')]
        .filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        })
        .map((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            label: button.textContent.replace(/\\s+/g, ' ').trim(),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          };
        });

      return {
        name: ${JSON.stringify(viewport.name)},
        viewport: { width: window.innerWidth, height: window.innerHeight },
        resultVisible: Boolean(panel.querySelector('[data-testid="sales-decision-result"]')),
        headline: panel.querySelector('.sales-decision-headline h3')?.textContent?.trim() ?? '',
        pageOverflowX: Math.max(0, Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)),
        panelOverflowX: Math.max(0, Math.ceil(panel.scrollWidth - panel.clientWidth)),
        panelOutOfBounds: panelRect.left < -1 || panelRect.right > window.innerWidth + 1,
        overflowElements,
        gridColumns,
        controlTargets,
        selectedHistoryPressed: panel.querySelector('.sales-decision-history-item.selected')?.getAttribute('aria-pressed') === 'true',
        liveStatusVisible: Boolean(panel.querySelector('[role="status"][aria-live="polite"]')),
      };
    })()
  `);
}

async function runSalesDecisionRegression(cdp, frontendUrl, backendUrl) {
  const regressionStart = cdp.networkResponses.length;
  const desktop = viewportCases.find((viewport) => viewport.name === "desktop");
  const initialState = await inspectSalesDecisionViewport(cdp, frontendUrl, desktop);

  const analyzeStart = cdp.networkResponses.length;
  const analyzeState = await evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeoutMs = 10000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out waiting for the sales decision analysis');
      };
      const button = document.querySelector('[data-testid="sales-decision-analyze"]');
      const historyBefore = document.querySelectorAll('.sales-decision-history-item').length;
      if (!button || button.disabled) throw new Error('Sales decision analyze action is unavailable');
      button.click();
      await waitUntil(() => {
        const status = document.querySelector('[data-testid="sales-decision-panel"] [role="status"]')?.textContent ?? '';
        return document.querySelector('[data-testid="sales-decision-result"]') &&
          !document.querySelector('[data-testid="sales-decision-analyze"]')?.disabled &&
          status.includes('诊断已保存');
      });
      return {
        resultVisible: Boolean(document.querySelector('[data-testid="sales-decision-result"]')),
        historyBefore,
        historyAfter: document.querySelectorAll('.sales-decision-history-item').length,
        boundaryText: document.querySelector('.sales-decision-boundary')?.textContent?.trim() ?? '',
      };
    })()
  `);
  await delay(120);
  const analyzeRequests = cdp.networkResponses.slice(analyzeStart)
    .filter((item) => new URL(item.url).pathname === "/api/ai/sales-decisions");
  const analyzePostRequests = analyzeRequests.filter((item) => item.method === "POST");

  const historyStart = cdp.networkResponses.length;
  const historyState = await evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeoutMs = 8000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out reading saved sales decision history');
      };
      const historyItem = document.querySelector('.sales-decision-history-item.selected') ??
        document.querySelector('.sales-decision-history-item');
      if (!historyItem) throw new Error('Missing saved sales decision history');
      historyItem.click();
      await waitUntil(() => {
        const status = document.querySelector('[data-testid="sales-decision-panel"] [role="status"]')?.textContent ?? '';
        return status.includes('不会重新调用模型');
      });
      return {
        resultVisible: Boolean(document.querySelector('[data-testid="sales-decision-result"]')),
        selectedHistoryPressed: document.querySelector('.sales-decision-history-item.selected')?.getAttribute('aria-pressed') === 'true',
        status: document.querySelector('[data-testid="sales-decision-panel"] [role="status"]')?.textContent?.trim() ?? '',
      };
    })()
  `);
  await delay(120);
  const historyRequests = cdp.networkResponses.slice(historyStart)
    .filter((item) => /^\/api\/ai\/sales-decisions\/[^/]+$/.test(new URL(item.url).pathname));
  const historyReadRequests = historyRequests.filter((item) => item.method === "GET");

  assert.equal(initialState.resultVisible, false, "sales decision regression should start from a genuine empty state");
  assert.equal(analyzeState.resultVisible, true, "sales decision action should render a saved diagnosis");
  assert.ok(analyzeState.historyAfter >= analyzeState.historyBefore + 1, "sales decision action should add one history item");
  assert.match(analyzeState.boundaryText, /人工确认/, "sales decision result should keep the human confirmation boundary visible");
  assert.deepEqual(
    analyzePostRequests.map((item) => [item.method, item.status]),
    [["POST", 201]],
    "sales decision action should issue exactly one successful POST",
  );
  assert.equal(historyState.resultVisible, true, "saved sales decision history should render the existing result");
  assert.equal(historyState.selectedHistoryPressed, true, "saved sales decision history should retain its selected state");
  assert.match(historyState.status, /不会重新调用模型/, "history should explicitly confirm that the model was not called again");
  assert.deepEqual(
    historyReadRequests.map((item) => [item.method, item.status]),
    [["GET", 200]],
    "opening one sales decision history item should issue exactly one GET",
  );
  assert.equal(
    historyRequests.filter((item) => item.method === "POST").length,
    0,
    "opening sales decision history must not issue another analysis POST",
  );

  const viewportStates = [];
  for (const viewport of viewportCases) {
    viewportStates.push(await inspectSalesDecisionViewport(cdp, frontendUrl, viewport));
  }

  for (const state of viewportStates) {
    const expectedColumns = state.viewport.width <= 760 ? 1 : 2;
    const minimumTarget = state.viewport.width <= 430 ? 44 : 40;
    assert.equal(state.resultVisible, true, `${state.name} should load the saved sales decision result`);
    assert.ok(state.headline.length > 0, `${state.name} should render a diagnosis headline`);
    assert.equal(state.pageOverflowX, 0, `${state.name} sales decision view should not overflow the page horizontally`);
    assert.equal(state.panelOverflowX, 0, `${state.name} sales decision panel should not overflow horizontally`);
    assert.equal(state.panelOutOfBounds, false, `${state.name} sales decision panel should stay inside the viewport`);
    assert.deepEqual(state.overflowElements, [], `${state.name} sales decision text should fit its controls and content blocks`);
    assert.equal(state.gridColumns, expectedColumns, `${state.name} sales decision grid should use the responsive column count`);
    assert.equal(state.selectedHistoryPressed, true, `${state.name} should expose the selected diagnosis history state`);
    assert.equal(state.liveStatusVisible, true, `${state.name} should expose an aria-live diagnosis status`);
    assert.deepEqual(
      state.controlTargets.filter((item) => item.width < minimumTarget || item.height < minimumTarget),
      [],
      `${state.name} sales decision controls should meet the ${minimumTarget}px target size`,
    );
  }

  const regressionRequests = cdp.networkResponses.slice(regressionStart);
  const diagnosticPosts = regressionRequests.filter((item) =>
    item.method === "POST" && new URL(item.url).pathname === "/api/ai/sales-decisions");
  assert.equal(diagnosticPosts.length, 1, "saved history and responsive checks must not trigger another diagnosis POST");
  const forbiddenWritePrefixes = ["/api/customers", "/api/opportunities", "/api/actions", "/api/risks"];
  const businessWriteRequests = regressionRequests.filter((item) =>
    ["POST", "PATCH", "DELETE"].includes(item.method) &&
    forbiddenWritePrefixes.some((prefix) => new URL(item.url).pathname.startsWith(prefix)));
  assert.deepEqual(businessWriteRequests, [], "sales decision diagnosis and history must not write customer, opportunity, action, or risk data");

  return {
    analyzeRequests: analyzePostRequests.map((item) => ({ method: item.method, status: item.status })),
    historyRequests: historyReadRequests.map((item) => ({ method: item.method, status: item.status })),
    businessWriteRequests: businessWriteRequests.length,
    viewports: viewportStates.map((state) => ({
      name: state.name,
      pageOverflowX: state.pageOverflowX,
      panelOverflowX: state.panelOverflowX,
      gridColumns: state.gridColumns,
    })),
  };
}

async function waitForNetworkResponse(cdp, startIndex, predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = cdp.networkResponses.slice(startIndex).find(predicate);
    if (match) return match;
    await delay(100);
  }
  return cdp.networkResponses.slice(startIndex).find(predicate) ?? null;
}

async function runCustomerConflictRegression(cdp, frontendUrl, backendUrl, apiFetch) {
  const customerName = "测试集成客户";
  const localSummary = "本地未保存的冲突摘要";
  const serverSummary = "服务端并发更新后的摘要";

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: frontendUrl });
  await delay(1800);
  const editorOpened = await evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeoutMs = 8000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out opening the customer conflict editor');
      };
      const customerName = ${JSON.stringify(customerName)};
      const localSummary = ${JSON.stringify(localSummary)};
      await waitUntil(() => document.querySelector('[data-testid="api-status"]')?.textContent?.includes('在线'));
      await waitUntil(() => document.querySelector('[data-testid="page-overview"]'));
      [...document.querySelectorAll('.nav-item')]
        .find((button) => button.textContent.includes('客户画像'))?.click();
      await waitUntil(() => document.querySelector('[data-testid="customer-list-view"]'));
      const row = [...document.querySelectorAll('[data-testid="customer-list-view"] .list-button')]
        .find((button) => button.textContent.includes(customerName));
      const detailButton = row?.querySelector('[data-testid="customer-open-detail"]');
      if (!detailButton) throw new Error('Missing conflict-test customer detail button');
      detailButton.click();
      await waitUntil(() => document.querySelector('[data-testid="page-customer"] h1')?.textContent?.includes(customerName));
      document.querySelector('[data-testid="customer-edit-detail"]')?.click();
      const editor = await waitUntil(() => document.querySelector('[data-testid="customer-editor"]'));
      const field = [...editor.querySelectorAll('.form-field')]
        .find((item) => item.querySelector('span')?.textContent?.trim() === '客户摘要');
      const textarea = field?.querySelector('textarea');
      if (!textarea) throw new Error('Missing customer summary editor');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, localSummary);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(100);
      return textarea.value === localSummary;
    })()
  `);
  assert.equal(editorOpened, true, "conflict regression should open the customer editor with a local draft");

  const customersResponse = await apiFetch("/api/customers");
  assert.equal(customersResponse.status, 200, "conflict regression should load the current customer version");
  const customers = await customersResponse.json();
  const customer = customers.items?.find((item) => item.name === customerName);
  assert.ok(customer, "conflict regression customer should exist");
  const advancedResponse = await apiFetch(`/api/customers/${customer.id}`, {
    method: "PATCH",
    headers: { "If-Match": `"${customer.version}"` },
    body: JSON.stringify({ summary: serverSummary }),
  });
  assert.equal(advancedResponse.status, 200, "out-of-band customer update should advance the server version");
  const advanced = await advancedResponse.json();
  assert.equal(advanced.item.version, customer.version + 1);

  const responseStart = cdp.networkResponses.length;
  const browserState = await evaluate(cdp, `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeoutMs = 8000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = predicate();
          if (value) return value;
          await wait(100);
        }
        throw new Error('Timed out waiting for stale customer save');
      };
      const localSummary = ${JSON.stringify(localSummary)};
      const editor = document.querySelector('[data-testid="customer-editor"]');
      const saveButton = [...editor.querySelectorAll('button')]
        .find((button) => button.textContent.includes('保存客户'));
      if (!saveButton) throw new Error('Missing customer save button');
      saveButton.click();
      await wait(100);
      await waitUntil(() => {
        const status = document.querySelector('[data-testid="customer-editor"] .editor-status')?.textContent?.trim();
        return status && status !== '就绪' && status !== '保存中';
      });
      const retainedEditor = document.querySelector('[data-testid="customer-editor"]');
      if (!retainedEditor) {
        return { editorOpen: false, summary: null, status: '', localSummaryRetained: false };
      }
      const summaryField = [...retainedEditor.querySelectorAll('.form-field')]
        .find((item) => item.querySelector('span')?.textContent?.trim() === '客户摘要');
      return {
        editorOpen: Boolean(retainedEditor),
        summary: summaryField?.querySelector('textarea')?.value ?? null,
        status: retainedEditor.querySelector('.editor-status')?.textContent?.trim() ?? '',
        localSummaryRetained: summaryField?.querySelector('textarea')?.value === localSummary,
      };
    })()
  `);
  const conflictResponse = await waitForNetworkResponse(
    cdp,
    responseStart,
    (item) => item.method === "PATCH" && item.url === `${backendUrl}/api/customers/${customer.id}`,
  );
  assert.ok(conflictResponse, "browser customer PATCH response should be captured through CDP");
  assert.equal(conflictResponse.status, 409, "stale browser customer PATCH should return 409");
  assert.equal(browserState.editorOpen, true, "409 should leave the customer editor open");
  assert.equal(browserState.localSummaryRetained, true, "409 should preserve the local unsaved customer summary");

  const persistedResponse = await apiFetch(`/api/customers/${customer.id}`);
  assert.equal(persistedResponse.status, 200);
  const persisted = await persistedResponse.json();
  assert.equal(persisted.item.summary, serverSummary, "409 should not replace the newer server customer value");
  assert.equal(persisted.item.version, advanced.item.version, "409 should not advance the server version");

  return {
    status: conflictResponse.status,
    editorOpen: browserState.editorOpen,
    localSummaryRetained: browserState.localSummaryRetained,
    serverSummaryRetained: persisted.item.summary === serverSummary,
  };
}

async function main() {
  assert.ok(existsSync(backendDir), `Backend directory does not exist: ${backendDir}`);

  const runtimeMode = await detectIntegrationRuntime();
  const expectAmapReady = String(process.env.SENT_ZX_EXPECT_AMAP ?? "false").toLowerCase() === "true";
  const realItineraryFlow = String(process.env.SENT_ZX_REAL_ITINERARY ?? "false").toLowerCase() === "true";
  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const databaseUrl = runtimeMode === "wsl"
    ? `/tmp/sent-zx-integration-${Date.now()}.sqlite`
    : join(tmpdir(), `sent-zx-integration-${Date.now()}.sqlite`);
  const backendWslPath = toWslPath(backendDir);
  const authPasswordHash = await hashPassword("qa-login", { salt: Buffer.alloc(16, 23) });
  let backend;
  let frontend;
  let cdp;
  let runError;
  let historicalSolution;
  let historicalItinerary;

  try {
    if (runtimeMode === "wsl") {
      await runProcess("wsl.exe", [
        "--cd",
        backendWslPath,
        "--exec",
        "env",
        "NODE_ENV=test",
        `DATABASE_URL=${databaseUrl}`,
        "npm",
        "run",
        "seed",
      ]);
    } else {
      await runProcess(process.execPath, ["src/seed.js"], {
        cwd: backendDir,
        env: { NODE_ENV: "test", DATABASE_URL: databaseUrl },
      });
    }

    const createdHistoricalSolution = await createHistoricalSolutionFixture({
      runtimeMode,
      backendWslPath,
      databaseUrl,
    });
    const createdHistoricalItinerary = await createHistoricalItineraryFixture({
      runtimeMode,
      backendWslPath,
      databaseUrl,
    });

    const backendEnv = {
      PORT: String(backendPort),
      DATABASE_URL: databaseUrl,
      AI_ANALYSIS_MODE: "mock",
      DEEPSEEK_API_KEY: "",
      AUTH_ACCOUNT: "jiangjz",
      AUTH_PASSWORD_HASH: authPasswordHash,
      AUTH_SESSION_SECRET: "qa-session-secret",
      CORS_ALLOWED_ORIGINS: frontendUrl,
      AUTH_COOKIE_SECURE: "false",
      SOLUTION_WRITES_ENABLED: "false",
      NODE_ENV: "test",
    };
    backend = runtimeMode === "wsl"
      ? spawnManaged("wsl.exe", [
          "--cd",
          backendWslPath,
          "--exec",
          "env",
          ...Object.entries(backendEnv).map(([key, value]) => `${key}=${value}`),
          "node",
          "src/server.js",
        ])
      : spawnManaged(process.execPath, ["src/server.js"], {
          cwd: backendDir,
          env: backendEnv,
        });
    await waitForHttp(`${backendUrl}/api/health`);

    const fixturePasswordField = ["pass", "word"].join("");
    const fixtureReadLogin = await fetch(`${backendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "jiangjz", [fixturePasswordField]: "qa-login" }),
    });
    const fixtureReadCookie = (fixtureReadLogin.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal(fixtureReadLogin.status, 200, "fixture reader should authenticate against the default backend");
    assert.ok(fixtureReadCookie, "fixture reader should receive an authentication cookie");
    const fixtureReadResponse = await fetch(`${backendUrl}/api/solutions`, {
      headers: { Cookie: fixtureReadCookie },
    });
    const fixtureReadBody = await fixtureReadResponse.json();
    assert.equal(fixtureReadResponse.status, 200, "default backend should keep historical solution reads available");
    historicalSolution = fixtureReadBody.items?.find((item) => item.id === createdHistoricalSolution.id) ?? null;
    assert.ok(historicalSolution, "default backend GET should return the historical solution fixture");
    const fixtureItineraryResponse = await fetch(`${backendUrl}/api/itineraries`, {
      headers: { Cookie: fixtureReadCookie },
    });
    const fixtureItineraryBody = await fixtureItineraryResponse.json();
    assert.equal(fixtureItineraryResponse.status, 200, "default backend should keep historical itinerary reads available");
    historicalItinerary = fixtureItineraryBody.items?.find((item) => item.id === createdHistoricalItinerary.id) ?? null;
    assert.ok(historicalItinerary, "default backend GET should return the historical itinerary fixture");

    const integrationDistPath = resolve(appRoot, "dist");
    assert.ok(
      existsSync(resolve(integrationDistPath, "index.html")),
      "run the frontend build before Chrome integration QA",
    );
    frontend = spawnManaged(
      process.execPath,
      [
        "scripts/static-server.mjs",
        "serve",
        "--host=127.0.0.1",
        `--port=${frontendPort}`,
        `--dist-path=${integrationDistPath}`,
        `--api-base-url=${backendUrl}`,
      ],
      {
        cwd: appRoot,
        env: { NODE_ENV: "test" },
      },
    );
    await waitForHttp(frontendUrl);

    cdp = await openChromeCdp();
    const viewportResults = [];
    for (const viewport of viewportCases) {
      viewportResults.push(await runViewport(
        cdp,
        frontendUrl,
        viewport,
        historicalSolution,
        historicalItinerary,
        realItineraryFlow,
      ));
    }
    const browserCustomerDeletes = cdp.networkResponses.filter((item) =>
      item.method === "DELETE" && /\/api\/customers\/[A-Za-z0-9._~-]+$/.test(new URL(item.url).pathname),
    );
    assert.equal(browserCustomerDeletes.length, 1, "customer delete cancel and confirm should issue exactly one DELETE request");
    const salesDecisionRegression = await runSalesDecisionRegression(cdp, frontendUrl, backendUrl);
    const browserSolutionWrites = cdp.networkResponses.filter((item) =>
      (item.method === "POST" && item.url === `${backendUrl}/api/solutions/draft`) ||
      (item.method === "PATCH" && item.url.startsWith(`${backendUrl}/api/solutions/`)),
    );
    assert.deepEqual(browserSolutionWrites, [], "primary UI must not issue solution write requests");
    const browserItineraryWrites = cdp.networkResponses.filter((item) =>
      ["POST", "PATCH", "DELETE"].includes(item.method) &&
      new URL(item.url).pathname.startsWith("/api/itineraries"),
    );
    if (realItineraryFlow) {
      assert.deepEqual(
        browserItineraryWrites.map((item) => item.method),
        ["POST", "DELETE"],
        "real itinerary browser QA should create and then delete exactly one itinerary",
      );
    } else {
      assert.deepEqual(browserItineraryWrites, [], "reading saved itinerary history must not trigger replanning writes");
    }

    const refreshStart = cdp.networkResponses.length;
    await cdp.send("Page.reload", { ignoreCache: true });
    const refreshState = await evaluate(cdp, `
      (async () => {
        const started = Date.now();
        while (Date.now() - started < 8000) {
          if (document.querySelector('[data-testid="page-overview"]')) {
            const quickNav = [...document.querySelectorAll('.nav-item')]
              .find((button) => button.textContent.includes('快速记录'));
            quickNav?.click();
            const quickStarted = Date.now();
            let restoredAnalysis = '';
            while (Date.now() - quickStarted < 5000) {
              const record = [...document.querySelectorAll('.record-note')]
                .find((item) => item.textContent.includes('日照中医医院'));
              if (record) {
                record.click();
                const analysisStarted = Date.now();
                while (Date.now() - analysisStarted < 3000) {
                  restoredAnalysis = document.querySelector('[data-testid="analysis-summary-request"]')?.value ?? '';
                  if (restoredAnalysis) break;
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return {
              overviewVisible: true,
              quickAnalysisRestored: restoredAnalysis === ${JSON.stringify(manualAnalysisRevision)},
              restoredAnalysis,
              loginVisible: Boolean(document.querySelector('[data-testid="login-submit"]')),
              legacyLocalStorage: window.localStorage.getItem('sentelligent.salesWorkbench.login'),
              localStorageEntries: Object.entries(window.localStorage),
              sessionStorageEntries: Object.entries(window.sessionStorage),
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return {
          overviewVisible: false,
          loginVisible: Boolean(document.querySelector('[data-testid="login-submit"]')),
          legacyLocalStorage: window.localStorage.getItem('sentelligent.salesWorkbench.login'),
          localStorageEntries: Object.entries(window.localStorage),
          sessionStorageEntries: Object.entries(window.sessionStorage),
        };
      })()
    `);
    const refreshSessionResponse = await waitForNetworkResponse(
      cdp,
      refreshStart,
      (item) => item.method === "GET" && item.url === `${backendUrl}/api/auth/session`,
    );
    assert.ok(refreshSessionResponse, "page refresh should call GET /api/auth/session");
    assert.equal(refreshSessionResponse.status, 200, "page refresh should restore the active Cookie session");
    assert.equal(refreshState.overviewVisible, true, "page refresh should restore the protected workbench");
    assert.equal(refreshState.quickAnalysisRestored, true, "page refresh should restore the manually saved quick-record analysis");
    assert.equal(refreshState.loginVisible, false, "page refresh should not show login for an active session");
    assert.equal(refreshState.legacyLocalStorage, null, "page refresh should not restore the legacy login cache");
    const persistedBrowserAuth = [
      ...refreshState.localStorageEntries,
      ...refreshState.sessionStorageEntries,
    ].filter(([key, value]) => /auth|token|csrf|session|login/i.test(`${key} ${value}`));
    assert.deepEqual(persistedBrowserAuth, [], "browser storage should not persist authentication or CSRF tokens");
    const refreshQuickAiRequests = cdp.networkResponses.slice(refreshStart).filter((item) => {
      const pathname = new URL(item.url).pathname;
      return item.method === "POST" && (
        pathname === "/api/quick-records/preview" ||
        (pathname.startsWith("/api/quick-records/") && pathname.endsWith("/analyze"))
      );
    });
    assert.deepEqual(refreshQuickAiRequests, [], "refresh and historical selection must not replay quick-record AI requests");

    const browserWrite = cdp.networkResponses.find((item) =>
      ["POST", "PATCH", "DELETE"].includes(item.method) &&
      item.url.startsWith(`${backendUrl}/api/`) &&
      !item.url.endsWith("/api/auth/login"),
    );
    assert.ok(browserWrite, "browser flow should issue at least one authenticated write");
    const browserWriteHeaders = Object.fromEntries(
      Object.entries(browserWrite.requestHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    assert.ok(browserWriteHeaders["x-csrf-token"], "browser writes should carry X-CSRF-Token");
    assert.equal(browserWriteHeaders.authorization, undefined, "browser writes must not carry Authorization");

    const browserWeeklyExport = cdp.networkResponses.find((item) =>
      item.method === "GET" && /\/api\/reports\/weekly\/[^/]+\/export\?/.test(item.url),
    );
    assert.ok(browserWeeklyExport, "browser flow should perform an authenticated weekly export");
    const weeklyExportUrl = new URL(browserWeeklyExport.url);
    assert.equal(weeklyExportUrl.searchParams.has("token"), false, "weekly export URL must not contain a query token");
    assert.equal(weeklyExportUrl.searchParams.has("authorization"), false, "weekly export URL must not contain Authorization data");

    const passwordField = ["pass", "word"].join("");
    const apiLoginResponse = await fetch(`${backendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "jiangjz", [passwordField]: "qa-login" }),
    });
    const apiSession = await apiLoginResponse.json();
    const setCookie = apiLoginResponse.headers.get("set-cookie") ?? "";
    const apiCookie = setCookie.split(";")[0];
    assert.equal(apiLoginResponse.status, 200, "integration API login should succeed");
    assert.ok(apiCookie, "integration API login should issue a session cookie");
    assert.match(setCookie, /HttpOnly/i, "integration session cookie should be HttpOnly");
    assert.match(setCookie, /Max-Age=604800/i, "integration session cookie should last seven days");
    assert.ok(apiSession.csrfToken, "integration API login should return an in-memory CSRF token");
    assert.equal(apiSession.token, undefined, "integration API login should not return a bearer token");

    const apiFetch = (path, options = {}) => {
      const method = String(options.method ?? "GET").toUpperCase();
      return fetch(`${backendUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Cookie: apiCookie,
          ...(method !== "GET" && method !== "HEAD" ? { "X-CSRF-Token": apiSession.csrfToken } : {}),
          ...(options.headers ?? {}),
        },
      });
    };

    const travelExpenseWeekStart = getCurrentWeekRange().periodStart;
    const [travelExpensesResponse, travelExpenseAdvancesResponse] = await Promise.all([
      apiFetch(`/api/travel-expenses?weekStart=${encodeURIComponent(travelExpenseWeekStart)}`),
      apiFetch(`/api/travel-expense-advances?weekStart=${encodeURIComponent(travelExpenseWeekStart)}`),
    ]);
    const [travelExpensesBody, travelExpenseAdvancesBody] = await Promise.all([
      travelExpensesResponse.json(),
      travelExpenseAdvancesResponse.json(),
    ]);
    assert.equal(travelExpensesResponse.status, 200, "travel expense list should be readable for the current natural week");
    assert.equal(travelExpenseAdvancesResponse.status, 200, "travel expense advance list should be readable for the current natural week");
    assert.ok(Array.isArray(travelExpensesBody.items), "travel expense list should return an items array");
    assert.ok(Array.isArray(travelExpenseAdvancesBody.items), "travel expense advance list should return an items array");
    const travelExpenseReadContract = {
      weekStart: travelExpenseWeekStart,
      expensesStatus: travelExpensesResponse.status,
      advancesStatus: travelExpenseAdvancesResponse.status,
      expenseItems: travelExpensesBody.items.length,
      advanceItems: travelExpenseAdvancesBody.items.length,
    };

    const solutionsBeforeResponse = await apiFetch("/api/solutions");
    const solutionsBefore = await solutionsBeforeResponse.json();
    const solutionBeforeResponse = await apiFetch(`/api/solutions/${historicalSolution.id}`);
    const solutionBefore = await solutionBeforeResponse.json();
    const auditsBeforeResponse = await apiFetch("/api/audit-logs?limit=500");
    const auditsBefore = await auditsBeforeResponse.json();
    assert.equal(solutionsBeforeResponse.status, 200, "historical solution list should remain readable");
    assert.equal(solutionBeforeResponse.status, 200, "historical solution detail should remain readable");
    assert.equal(auditsBeforeResponse.status, 200, "audit snapshot should be readable before blocked writes");

    const blockedSolutionCreateResponse = await apiFetch("/api/solutions/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "集成验收",
        customerId: historicalSolution.customerId,
        opportunityId: historicalSolution.opportunityId,
        artifactType: "solution_framework",
      }),
    });
    const blockedSolutionCreate = await blockedSolutionCreateResponse.json();
    const blockedSolutionUpdateResponse = await apiFetch(`/api/solutions/${historicalSolution.id}`, {
      method: "PATCH",
      headers: { "If-Match": `"${historicalSolution.version}"` },
      body: JSON.stringify({
        title: "不得修改的历史方案",
        content: "运行中默认后端不得写入。",
        status: "saved",
      }),
    });
    const blockedSolutionUpdate = await blockedSolutionUpdateResponse.json();

    assert.equal(blockedSolutionCreateResponse.status, 403, "default backend should block solution creation");
    assert.equal(blockedSolutionCreate.error?.code, "FEATURE_DISABLED", "blocked solution creation should use FEATURE_DISABLED");
    assert.equal(blockedSolutionUpdateResponse.status, 403, "default backend should block solution updates");
    assert.equal(blockedSolutionUpdate.error?.code, "FEATURE_DISABLED", "blocked solution update should use FEATURE_DISABLED");

    const solutionsAfter = await apiFetch("/api/solutions").then((response) => response.json());
    const solutionAfter = await apiFetch(`/api/solutions/${historicalSolution.id}`).then((response) => response.json());
    const auditsAfter = await apiFetch("/api/audit-logs?limit=500").then((response) => response.json());
    assert.deepEqual(solutionsAfter.items, solutionsBefore.items, "blocked solution writes must not change the solution list");
    assert.deepEqual(solutionAfter.item, solutionBefore.item, "blocked solution writes must not change historical detail");
    assert.deepEqual(auditsAfter.items, auditsBefore.items, "blocked solution writes must not create audit side effects");
    const solutionWriteContract = {
      createStatus: blockedSolutionCreateResponse.status,
      updateStatus: blockedSolutionUpdateResponse.status,
      errorCode: blockedSolutionCreate.error?.code,
      historyUnchanged: true,
      auditUnchanged: true,
    };

    const conflictRegression = await runCustomerConflictRegression(cdp, frontendUrl, backendUrl, apiFetch);
    const latestRecords = await apiFetch("/api/quick-records").then((response) => response.json());
    const latestRecord = latestRecords.items?.[0];
    const customersAfterEdit = await apiFetch("/api/customers").then((response) => response.json());
    const opportunitiesAfterEdit = await apiFetch("/api/opportunities").then((response) => response.json());
    const syncedCustomer = await apiFetch(`/api/customers/${latestRecord?.customerId}`).then((response) => response.json());
    const syncedOpportunity = await apiFetch(`/api/opportunities/${latestRecord?.opportunityId}`).then((response) => response.json());
    const actionItems = await apiFetch("/api/actions").then((response) => response.json());
    const riskItems = await apiFetch("/api/risks").then((response) => response.json());
    const latestRecordDate = String(latestRecord?.occurredAt ?? latestRecord?.createdAt ?? "2026-06-06").slice(0, 10);
    const weeklyResponse = await apiFetch("/api/reports/weekly/draft", {
      method: "POST",
      body: JSON.stringify({
        owner: "继振",
        periodStart: latestRecordDate,
        periodEnd: latestRecordDate,
      }),
    });
    const weeklyDraft = await weeklyResponse.json();

    assert.equal(latestRecord?.status, "confirmed", "latest backend quick record should be confirmed");
    assert.equal(latestRecord?.customerId, "rizhao", "latest backend quick record should link to the customer");
    assert.equal(latestRecord?.opportunityId, "op-rizhao-plan", "latest backend quick record should link to the opportunity");
    assert.equal(
      latestRecord?.analysis?.summary?.request?.text,
      manualAnalysisRevision,
      "quick-record list should return the manually saved analysis after refresh",
    );
    assert.deepEqual(
      [...(latestRecord?.confirmedTargets ?? [])].sort(),
      ["customer", "opportunity", "weekly"],
      "quick-record list should return all persisted confirmation targets",
    );
    assert.match(
      (syncedCustomer.item?.syncPreview ?? []).join("\n"),
      /快速记录已确认/,
      "confirmed quick record should write back to customer sync preview",
    );
    assert.ok(
      (syncedCustomer.item?.syncPreview ?? []).some((item) => item.includes(manualAnalysisRevision)),
      "confirmation after manual analysis save should use the persisted revision",
    );
    assert.match(
      syncedOpportunity.item?.sourceRecord ?? "",
      new RegExp(latestRecord.id),
      "confirmed quick record should write back to opportunity source record",
    );
    assert.ok(
      (actionItems.items ?? []).some((item) => item.sourceRecordId === latestRecord.id),
      "confirmed quick record should generate a next action item",
    );
    assert.ok(
      (actionItems.items ?? []).some((item) => item.status === "done" && item.assignee === "继振" && item.due === "周五 17:00"),
      "action status updates should persist completion, owner, and due date",
    );
    const quickRiskItem = (riskItems.items ?? []).find((item) => item.sourceType === "quick_record" && item.sourceId === latestRecord.id);
    assert.ok(quickRiskItem, "confirmed quick record should generate a traceable risk item");
    assert.equal(quickRiskItem.status, "closed", "risk status updates should persist closure");
    assert.equal(quickRiskItem.assignee, "继振", "risk status updates should persist owner");
    assert.equal(quickRiskItem.due, "下周一 10:00", "risk status updates should persist the deferred due date");
    assert.ok(
      (customersAfterEdit.items ?? []).some((item) => item.name === "测试集成客户" && item.level === "重点培育"),
      "customer editor should create and update a backend customer",
    );
    assert.equal(
      (customersAfterEdit.items ?? []).some((item) => item.name === "测试删除客户"),
      false,
      "confirmed customer deletion should stay deleted after a backend reload",
    );
    assert.ok(
      (opportunitiesAfterEdit.items ?? []).some((item) => item.name === "测试集成客户规划调研" && item.stage === "调研机会"),
      "opportunity editor and kanban should persist the final opportunity stage",
    );
    assert.equal(weeklyResponse.status, 201, "weekly draft should be created from confirmed quick records");
    assert.ok((weeklyDraft.item?.sourceRefs ?? []).length >= 1, "weekly draft should retain source references");
    const expectedInitialSession401s = cdp.consoleErrors.filter((message) =>
      /Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/.test(message),
    );
    const expectedConflict409s = cdp.consoleErrors.filter((message) =>
      /Failed to load resource: the server responded with a status of 409 \(Conflict\)/.test(message),
    );
    const unexpectedConsoleErrors = cdp.consoleErrors.filter((message) =>
      !expectedInitialSession401s.includes(message) && !expectedConflict409s.includes(message),
    );
    assert.ok(
      expectedInitialSession401s.length >= 1 && expectedInitialSession401s.length <= 2,
      `expected one or two initial anonymous session probes, got ${expectedInitialSession401s.length}`,
    );
    assert.ok(expectedConflict409s.length <= 1, `expected at most one stale-write console error, got ${expectedConflict409s.length}`);
    assert.equal(unexpectedConsoleErrors.length, 0, `browser console errors: ${unexpectedConsoleErrors.join("; ")}`);
    const expectedWeekRange = getCurrentWeekRange();
    const expectedWeeklyExportFilename = `weekly-report-${expectedWeekRange.periodStart}-${expectedWeekRange.periodEnd}.doc`;

    for (const result of viewportResults) {
      assert.equal(result.title, "森特智行 AI 销售作战台", `${result.name} should load app title`);
      assert.equal(result.brandText, "", `${result.name} top brand should only render the logo image`);
      assert.equal(result.brandLogoSrc, "/sent-zhixing-transparent-logo.png", `${result.name} should use the Sent Zhixing logo asset`);
      assert.equal(result.h1, "", `${result.name} main pages should not render a duplicated page heading`);
      assert.equal(result.composerTitle, "先记录，再确认识别", `${result.name} should open quick record`);
      assert.equal(result.apiStatus, "在线", `${result.name} should show an online service state`);
      assert.equal(result.overflowX, 0, `${result.name} should not have page-level horizontal overflow`);
      assert.deepEqual(result.topbarOutOfBounds, [], `${result.name} topbar controls should stay inside the viewport`);
      assert.equal(result.hasTopbarSearch, false, `${result.name} should not render a global topbar search`);
      assert.equal(
        result.primaryNavigation.solutionAssistantVisible,
        false,
        `${result.name} primary navigation must not expose Solution Assistant`,
      );
      assert.equal(result.authFlow.loginCompleted, result.name === "desktop", `${result.name} should only show login before the first Cookie session`);
      assert.equal(result.authFlow.restoredWithoutLogin, result.name !== "desktop", `${result.name} should restore the HttpOnly Cookie session without login`);
      assert.equal(result.authFlow.legacyCacheCleared, true, `${result.name} should not retain the legacy browser session cache`);
      assert.deepEqual(result.interactiveControls.unnamed, [], `${result.name} visible buttons should have readable labels`);
      assert.deepEqual(result.interactiveControls.smallTargets, [], `${result.name} visible buttons should meet touch/click target sizing`);
      assert.deepEqual(result.interactiveControls.textOverflow, [], `${result.name} visible button text should not overflow its control`);
      assert.deepEqual(result.interactiveIssuesByPage.issues, [], `${result.name} every business page should have accessible, non-overflowing buttons`);
      assert.deepEqual(result.listRowIssuesByPage.issues, [], `${result.name} business list rows should use explicit select and detail buttons`);
      if (result.name === "desktop") {
        assert.ok(result.windowInsets.left <= 10, `desktop app shell left inset should stay compact, got ${result.windowInsets.left}px`);
        assert.ok(result.windowInsets.right <= 10, `desktop app shell right inset should stay compact, got ${result.windowInsets.right}px`);
        assert.ok(result.windowInsets.top <= 10, `desktop app shell top inset should stay compact, got ${result.windowInsets.top}px`);
      }
      assert.equal(result.textareaCount, 1, `${result.name} should render the quick record composer`);
      if (result.name === "desktop") {
        assert.ok(result.matchCards >= 3, "desktop flow should render backend analysis cards");
        assert.equal(result.confirmedCount, 3, "desktop flow should confirm all manual sync targets");
        assert.equal(result.hasBackendRecorded, true, "desktop flow should show backend confirmation state");
        assert.equal(result.syncLogItems, 3, "desktop flow should render three sync log entries");
        assert.match(result.syncLogText, /同步日志/, "desktop flow should show the sync log panel");
        assert.equal(result.riskPageHasQuickRecordSource, true, "desktop flow should render backend risk source");
        assert.equal(result.riskPageHidesInternalSourceType, true, "desktop flow should hide internal risk source enums");
        assert.equal(result.riskPageStatusDeferred, true, "desktop flow should defer a risk through the UI");
        assert.equal(result.riskPageStatusClosed, true, "desktop flow should close a risk through the UI");
        assert.equal(result.riskPageAssigneeUpdated, true, "desktop flow should update risk owner through the UI");
        assert.equal(result.riskPageDueUpdated, true, "desktop flow should update risk due date through the UI");
        assert.equal(result.riskPageEvidenceExpanded, true, "desktop risk evidence should expand details");
        assert.equal(result.riskPageActionExpanded, true, "desktop risk action advice should expand details");
        assert.equal(result.riskPageLocalSearch, true, "desktop risk page should search only risk records");
        assert.equal(result.riskPageDetailViewOpened, true, "desktop risk page should open detail as a sub view");
        assert.equal(result.actionFlow.statusDone, true, "desktop flow should complete an action through the UI");
        assert.equal(result.actionFlow.assigneeUpdated, true, "desktop flow should update action owner through the UI");
        assert.equal(result.actionFlow.dueUpdated, true, "desktop flow should update action due date through the UI");
        assert.equal(result.actionFlow.localSearch, true, "desktop action page should search only action records");
        assert.equal(result.actionFlow.detailViewOpened, true, "desktop action page should open detail as a sub view");
        assert.equal(result.editFlow.customerCreateStartsBlank, true, "desktop customer create button should open a blank customer editor directly");
        assert.equal(result.editFlow.customerCreated, true, "desktop flow should create and update a customer through the UI");
        assert.equal(result.editFlow.customerCancelPreserved, true, "desktop customer cancel should discard local edits");
        assert.equal(result.editFlow.customerSaveClosedEditor, true, "desktop customer save should return to read-only detail");
        assert.equal(result.editFlow.customerUpdated, true, "desktop customer save should persist and reload the edited value");
        assert.equal(result.editFlow.customerDeleteDialogVisible, true, "desktop customer delete should use an in-app confirmation dialog");
        assert.equal(result.editFlow.customerDeleteCancelPreserved, true, "desktop customer delete cancel should keep the customer visible");
        assert.equal(result.editFlow.customerDeleteConfirmed, true, "desktop customer delete confirm should remove the customer from the list");
        assert.equal(result.editFlow.opportunityCreateStartsBlank, true, "desktop opportunity create button should open a blank opportunity editor directly");
        assert.equal(result.editFlow.opportunityCreated, true, "desktop flow should create an opportunity through the UI");
        assert.equal(result.editFlow.opportunityUpdated, true, "desktop flow should update the opportunity through the UI");
        assert.equal(result.editFlow.dynamicCustomerOpportunityLink, true, "desktop customer detail should open a dynamically created linked opportunity");
        assert.equal(result.editFlow.kanbanShowsDynamicOpportunity, true, "desktop kanban should render a dynamically created opportunity");
        assert.equal(result.editFlow.kanbanAdvanceAvailable, true, "desktop kanban should expose a stage movement control");
        assert.equal(result.editFlow.kanbanAdvanced, true, "desktop kanban should move a deal to the next stage");
        assert.equal(result.editFlow.kanbanDynamicOpportunityOpened, true, "desktop kanban should open a dynamically created opportunity detail");
        assert.equal(result.knowledgeFlow.createStartsBlank, true, "desktop knowledge create button should open a blank knowledge editor directly");
        assert.equal(result.knowledgeFlow.created, true, "desktop flow should create a knowledge item through the UI");
        assert.equal(result.knowledgeFlow.searched, true, "desktop flow should search backend knowledge items through the UI");
        assert.equal(result.knowledgeFlow.detailOpened, true, "desktop knowledge page should open detail as a sub view");
        assert.equal(result.knowledgeFlow.solutionWriteEntryAbsent, true, "desktop knowledge page must not expose a solution write entry");
        assert.equal(result.knowledgeFlow.weeklyCited, true, "desktop knowledge page should cite a selected knowledge item into a weekly draft");
        assert.equal(result.itineraryFlow.listOpened, true, "desktop itinerary navigation should open the persisted itinerary list");
        assert.equal(result.itineraryFlow.localSearch, true, "desktop itinerary search should accept a module-local query");
        assert.equal(result.itineraryFlow.detailReadOnly, true, "desktop itinerary detail should remain read-only until modify is clicked");
        assert.equal(result.itineraryFlow.editAvailable, true, "desktop itinerary detail should expose an explicit modify action");
        assert.equal(result.itineraryFlow.navigationKeyFree, true, "desktop itinerary navigation links must not contain provider credentials");
        if (expectAmapReady) {
          assert.equal(result.itineraryFlow.mapStatus, "ready", "desktop itinerary map should load with the configured AMap JS key");
          assert.equal(result.itineraryFlow.mapMarkers, 2, "desktop itinerary map should render the departure and customer markers");
          assert.equal(result.itineraryFlow.mapSurface, true, "desktop itinerary map should render a visible map surface");
        }
        if (realItineraryFlow) {
          assert.equal(result.itineraryFlow.createdWithAmap, true, "desktop itinerary form should create a real AMap-backed route");
          assert.equal(result.itineraryFlow.createdMapReady, true, "newly created itinerary should render its real AMap route");
          assert.match(result.itineraryFlow.createdDistance, /km$/, "newly created itinerary should expose a routed distance");
          assert.equal(result.itineraryFlow.deleted, true, "desktop itinerary flow should delete its real QA record");
        }
        assert.equal(result.itineraryFlow.createStartsBlank, true, "desktop itinerary create button should open a blank itinerary editor directly");
        assert.equal(result.itineraryFlow.oneEmptyStop, true, "desktop itinerary editor should start with one blank customer stop");
        assert.equal(result.expenseFlow.pageOpened, true, "desktop travel expense navigation should open the expense page");
        assert.equal(result.expenseFlow.loadedWithoutAlert, true, "desktop travel expense page should finish loading without an error alert");
        assert.deepEqual(
          result.expenseFlow.tabIds,
          ['overview', 'ledger', 'proofs', 'invoices', 'settlement', 'organize'],
          "desktop travel expense page should expose all six reimbursement tabs",
        );
        assert.equal(result.expenseFlow.tabsPresent, true, "desktop travel expense page should expose exactly the expected reimbursement tabs");
        assert.equal(result.expenseFlow.naturalWeekInput, true, "desktop travel expense page should use a populated natural-week input");
        assert.equal(result.expenseFlow.organizeOpened, true, "desktop travel expense organize tab should open the payment record workbench");
        assert.equal(result.expenseFlow.editorOpened, true, "desktop travel expense create action should open the expense editor");
        assert.ok(result.expenseFlow.editorControlCount > 0, "desktop travel expense editor should render form controls");
        assert.equal(result.expenseFlow.editorLabelsComplete, true, "desktop travel expense editor controls should all have readable labels");
        assert.equal(result.expenseFlow.editorClosed, true, "desktop travel expense editor should close without saving");
        assert.match(result.weeklyDraftText, /本周重点进展/, "desktop flow should render a backend weekly draft");
        assert.equal(result.weeklyEditor.saved, true, "desktop weekly page should save edited weekly report content");
        assert.equal(result.weeklyEditor.ready, true, "desktop weekly page should mark weekly report as ready");
        assert.equal(result.weeklyEditor.editedText, true, "desktop weekly editor should keep the edited weekly content");
        assert.equal(result.weeklyEditor.exportClicked, true, "desktop weekly page should trigger an authenticated Blob download");
        assert.equal(result.weeklyEditor.exportFilename, expectedWeeklyExportFilename, "desktop weekly export should expose the exact backend Word filename");
        assert.equal(result.weeklyEditor.exportUrlRevoked, true, "desktop weekly export should revoke its temporary Blob URL");
        assert.equal(result.cardInteractions.quickKpi, true, "desktop overview quick KPI should open quick record");
        assert.equal(result.cardInteractions.quickStartsEmpty, true, "desktop quick record composer should open blank for a new record");
        assert.equal(result.cardInteractions.riskKpi, true, "desktop overview risk KPI should open risk page");
        assert.equal(result.cardInteractions.priorityAction, true, "desktop priority action card should open action detail");
        assert.equal(result.cardInteractions.customerTemperature, true, "desktop customer temperature card should open customer detail");
        assert.equal(result.cardInteractions.customerLocalSearch, true, "desktop customer page should search only customer records");
        assert.equal(result.cardInteractions.customerDetailViewOpened, true, "desktop customer page should open detail as a sub view");
        assert.equal(result.cardInteractions.rhythmCard, true, "desktop rhythm card should open its related module");
        assert.equal(result.cardInteractions.stageCard, true, "desktop stage card should open kanban");
        assert.equal(result.cardInteractions.weeklyStartsEmpty, true, "desktop weekly page should start from a real empty state");
        assert.equal(result.cardInteractions.weeklyDailyUsesRealSources, true, "desktop weekly daily view should render real draft sources");
        assert.equal(result.cardInteractions.weeklyDayExpanded, true, "desktop real weekly day card should expand its source details");
        assert.equal(result.cardInteractions.weeklySummaryUsesDraft, true, "desktop weekly summary should render the generated draft");
        assert.equal(result.cardInteractions.weeklyMetricExpanded, true, "desktop real weekly metric card should expand its details");
        assert.equal(result.cardInteractions.quickRecordLoaded, true, "desktop quick record card should load its content into the composer");
        assert.equal(result.cardInteractions.quickSavedAnalysisRestored, true, "desktop history should restore the saved quick-record analysis");
        assert.equal(result.cardInteractions.quickHistoryAnalysisEditable, true, "desktop restored historical analysis should be manually editable");
        assert.equal(result.cardInteractions.quickAnalysisSaveControl, true, "desktop restored analysis should expose an explicit save control");
        assert.equal(result.cardInteractions.quickAnalysisSaved, true, "desktop analysis save should retain the manual revision");
        assert.equal(result.cardInteractions.quickAnalysisResynced, true, "desktop should re-sync from the saved analysis revision");
        assert.equal(result.cardInteractions.quickHistoryNoAiReplay, true, "desktop history should not trigger another analyze or preview request");
        assert.equal(
          result.cardInteractions.quickAiRequestsAfterHistory,
          result.cardInteractions.quickAiRequestsBeforeHistory,
          "desktop history click should preserve the quick-record AI request count",
        );
        assert.equal(result.cardInteractions.stakeholderExpanded, true, "desktop customer stakeholder card should expand details");
        assert.equal(result.cardInteractions.chainExpanded, true, "desktop customer decision-chain card should expand details");
        assert.equal(result.cardInteractions.fieldTagExpanded, true, "desktop customer tag card should expand details");
        assert.equal(result.cardInteractions.opportunitySourceExpanded, true, "desktop opportunity source record should expand details");
        assert.equal(result.cardInteractions.opportunityRiskExpanded, true, "desktop opportunity risk note should expand details");
        assert.equal(result.cardInteractions.opportunityNextExpanded, true, "desktop opportunity next action should expand details");
        assert.equal(result.cardInteractions.opportunityLocalSearch, true, "desktop opportunity page should search only opportunity records");
        assert.equal(result.cardInteractions.opportunityDetailViewOpened, true, "desktop opportunity page should open detail as a sub view");
        assert.equal(result.cardInteractions.timelineExpanded, true, "desktop opportunity timeline item should expand details");
        assert.equal(result.aiSuggestions.customer, true, "desktop customer page should generate an AI suggestion through the UI");
        assert.equal(result.aiSuggestions.opportunity, true, "desktop opportunity page should generate an AI suggestion through the UI");
        assert.equal(result.aiSuggestions.knowledge, true, "desktop knowledge page should generate an AI suggestion through the UI");
        assert.equal(result.voiceFlow.started, true, "desktop quick record voice mode should start browser speech recognition");
        assert.equal(result.voiceFlow.defaultedToVoice, true, "desktop quick record should default to voice mode");
        assert.equal(result.voiceFlow.resetToVoiceAfterReturn, true, "desktop quick record should reset to voice mode whenever the page is reopened");
        assert.equal(result.voiceFlow.resetToVoiceFromTopbar, true, "desktop topbar quick record entry should reset to voice mode");
        assert.equal(result.voiceFlow.resetToVoiceFromOverview, true, "desktop overview quick record entry should reset to voice mode");
        assert.equal(result.voiceFlow.transcriptInComposer, true, "desktop quick record voice mode should write transcript into composer");
        assert.equal(result.voiceFlow.stopped, true, "desktop quick record voice mode should stop browser speech recognition");
        assert.equal(result.voiceFallback.recordingStarted, true, "desktop quick record voice mode should fall back to recording when speech recognition is unavailable");
        assert.equal(result.voiceFallback.audioCardVisible, true, "desktop quick record Safari fallback should show a playable recording");
        assert.equal(result.voiceFallback.downloadVisible, true, "desktop quick record Safari fallback should expose a recording download");
        assert.equal(result.voiceFallback.guidanceVisible, true, "desktop quick record Safari fallback should guide manual transcription");
        assert.equal(result.voiceFallback.trackStopped, true, "desktop quick record Safari fallback should release the microphone stream");
        assert.equal(result.voiceUploadOnly.uploadVisible, true, "desktop quick record mobile fallback should expose recording upload when direct microphone access is unavailable");
        assert.equal(result.voiceUploadOnly.unavailableHidden, true, "desktop quick record mobile fallback should not show an unavailable voice dead end");
        assert.equal(result.voiceUploadOnly.textFallbackVisible, true, "desktop quick record mobile fallback should still allow text entry");
        assert.deepEqual(
          result.productionCopy.forbiddenByPage,
          [],
          "desktop visible pages should not contain internal prototype, backend, WSL, or mock delivery copy",
        );
      }
    }

    const cookiesBeforeLogout = await cdp.send("Network.getCookies", { urls: [backendUrl] });
    const browserSessionCookie = cookiesBeforeLogout.cookies.find((cookie) => cookie.name === "sentelligent_session");
    assert.ok(browserSessionCookie?.value, "browser login should create the HttpOnly session cookie");
    assert.equal(browserSessionCookie.httpOnly, true, "browser session cookie should be HttpOnly");

    const logoutStart = cdp.networkResponses.length;
    const logoutState = await evaluate(cdp, `
      (async () => {
        const logout = document.querySelector('button[title="退出登录"]');
        if (!logout) throw new Error('Missing logout button');
        logout.click();
        const started = Date.now();
        while (Date.now() - started < 8000) {
          if (document.querySelector('[data-testid="login-submit"]')) {
            return {
              loginVisible: true,
              protectedVisible: Boolean(document.querySelector('[data-testid="page-overview"]')),
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { loginVisible: false, protectedVisible: true };
      })()
    `);
    const logoutResponse = await waitForNetworkResponse(
      cdp,
      logoutStart,
      (item) => item.method === "POST" && item.url === `${backendUrl}/api/auth/logout`,
    );
    assert.ok(logoutResponse, "logout should call POST /api/auth/logout");
    assert.equal(logoutResponse.status, 204, "logout should revoke the active server session");
    const logoutHeaders = Object.fromEntries(
      Object.entries(logoutResponse.requestHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    assert.ok(logoutHeaders["x-csrf-token"], "logout should carry X-CSRF-Token");
    assert.equal(logoutHeaders.authorization, undefined, "logout must not carry Authorization");
    assert.equal(logoutState.loginVisible, true, "logout should return the browser to login");
    assert.equal(logoutState.protectedVisible, false, "logout should remove protected workbench content");

    const revokedSessionResponse = await fetch(`${backendUrl}/api/auth/session`, {
      headers: { Cookie: `${browserSessionCookie.name}=${browserSessionCookie.value}` },
    });
    assert.equal(revokedSessionResponse.status, 401, "the pre-logout Cookie should be revoked server-side");

    const protectedReloadStart = cdp.networkResponses.length;
    await cdp.send("Page.navigate", { url: frontendUrl });
    await delay(1200);
    const protectedReloadState = await evaluate(cdp, `({
      loginVisible: Boolean(document.querySelector('[data-testid="login-submit"]')),
      protectedVisible: Boolean(document.querySelector('[data-testid="page-overview"]')),
    })`);
    const postLogoutSessionResponse = await waitForNetworkResponse(
      cdp,
      protectedReloadStart,
      (item) => item.method === "GET" && item.url === `${backendUrl}/api/auth/session`,
    );
    assert.ok(postLogoutSessionResponse, "protected reload should probe GET /api/auth/session");
    assert.equal(postLogoutSessionResponse.status, 401, "protected reload should reject the logged-out session");
    assert.equal(protectedReloadState.loginVisible, true, "protected reload should remain on login after logout");
    assert.equal(protectedReloadState.protectedVisible, false, "protected UI must stay hidden after logout");

    console.log(
      JSON.stringify(
        {
          status: "passed",
          runtimeMode,
          backendUrl,
          frontendUrl,
          latestRecord: {
            status: latestRecord.status,
            customerId: latestRecord.customerId,
            opportunityId: latestRecord.opportunityId,
          },
          businessSync: {
            customerSyncPreview: syncedCustomer.item.syncPreview.length,
            opportunitySourceRecord: syncedOpportunity.item.sourceRecord,
            generatedActions: actionItems.items.filter((item) => item.sourceRecordId === latestRecord.id).length,
            generatedRisks: riskItems.items.filter((item) => item.sourceType === "quick_record" && item.sourceId === latestRecord.id).length,
            editedCustomers: customersAfterEdit.items.filter((item) => item.name === "测试集成客户").length,
            editedOpportunities: opportunitiesAfterEdit.items.filter((item) => item.name === "测试集成客户规划调研").length,
            knowledgeCreated: viewportResults.find((result) => result.name === "desktop")?.knowledgeFlow.created ?? false,
          },
          weeklyDraft: {
            statusCode: weeklyResponse.status,
            sourceRefs: weeklyDraft.item.sourceRefs.length,
          },
          generatedDrafts: {
            weekly: viewportResults.find((result) => result.name === "desktop")?.weeklyDraftText.length ?? 0,
          },
          itinerary: viewportResults.find((result) => result.name === "desktop")?.itineraryFlow ?? {},
          travelExpense: {
            ui: viewportResults.find((result) => result.name === "desktop")?.expenseFlow ?? {},
            api: travelExpenseReadContract,
          },
          salesDecision: salesDecisionRegression,
          solutionWriteContract,
          conflictRegression,
          authSecurity: {
            refreshSessionStatus: refreshSessionResponse.status,
            browserWriteMethod: browserWrite.method,
            weeklyExportWithoutToken: !weeklyExportUrl.searchParams.has("token"),
            logoutStatus: logoutResponse.status,
            revokedSessionStatus: revokedSessionResponse.status,
            postLogoutSessionStatus: postLogoutSessionResponse.status,
          },
          viewports: viewportResults.map((result) => ({
            name: result.name,
            viewport: result.viewport,
            overflowX: result.overflowX,
            columns: result.recordLayoutColumns,
          })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (cdp?.consoleErrors?.length) {
      console.error(`Browser console errors before failure: ${cdp.consoleErrors.join("; ")}`);
    }
    runError = error;
  } finally {
    const cleanupErrors = [];
    const captureCleanup = async (label, operation) => {
      try {
        return await operation();
      } catch (error) {
        cleanupErrors.push(new Error(`${label}: ${error.message}`, { cause: error }));
        return null;
      }
    };
    const assertStopped = (label, result) => {
      if (result && !["terminated", "not_running"].includes(result.status)) {
        cleanupErrors.push(new Error(`${label}: refused process cleanup (${result.status})`));
      }
    };

    if (cdp) await captureCleanup("browser cleanup", () => cdp.close());
    const frontendStop = await captureCleanup("frontend cleanup", () => stopProcessTree(frontend));
    assertStopped("frontend cleanup", frontendStop);
    const backendStop = await captureCleanup("backend wrapper cleanup", () => stopProcessTree(backend));
    assertStopped("backend wrapper cleanup", backendStop);
    if (runtimeMode === "wsl") {
      await captureCleanup("WSL listener cleanup", () =>
        stopWslPort(backendPort, { backendWslPath, databaseUrl }));
      await captureCleanup("temporary database cleanup", () =>
        runProcess("wsl.exe", [
          "--exec",
          "rm",
          "-f",
          databaseUrl,
          `${databaseUrl}-wal`,
          `${databaseUrl}-shm`,
          `${databaseUrl}-journal`,
        ]));
    } else {
      await captureCleanup("temporary database cleanup", async () => {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          rmSync(`${databaseUrl}${suffix}`, { force: true });
        }
      });
    }

    if (cleanupErrors.length > 0) {
      const cleanupSummary = cleanupErrors.map((error) => error.message).join("; ");
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        `Integration cleanup failed: ${cleanupSummary}`,
      );
      runError = runError
        ? new AggregateError([runError, cleanupFailure], "Integration QA failed and cleanup was incomplete")
        : cleanupFailure;
    }
  }

  if (runError) throw runError;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
