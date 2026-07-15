import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ONLINE = "\u5728\u7ebf";
const TITLE = "\u68ee\u7279\u667a\u884c AI \u9500\u552e\u4f5c\u6218\u53f0";
const CUSTOMER = "\u5ba2\u6237\u753b\u50cf";
const ACTIONS = "\u4e0b\u4e00\u6b65\u52a8\u4f5c";
const RISK = "\u98ce\u9669\u8bc6\u522b";
const KNOWLEDGE = "\u77e5\u8bc6\u5e93";
const BACK_LIST = "\u8fd4\u56de\u5217\u8868";
const BUQI = "\u8865\u9f50";
const YUSUAN = "\u9884\u7b97";
const MOBILE_CLOUD = "\u79fb\u52a8\u4e91";
const OLD_GLOBAL_SEARCH = "\u641c\u7d22\u5ba2\u6237\u3001\u5546\u673a\u3001\u52a8\u4f5c\u3001\u6750\u6599";
const REMOVED_UI_COPY = [
  "\u5217\u8868\u4f18\u5148",
  "\u624b\u52a8\u786e\u8ba4",
  "\u5feb\u901f\u8bb0\u5f55\u5165\u5468\u62a5",
  "\u6309\u5ba2\u6237\u3001\u533a\u57df",
  "\u6309\u5546\u673a\u3001\u5ba2\u6237",
  "\u4ece\u8bb0\u5f55\u548c\u5546\u673a\u4e2d\u627f\u63a5",
  "\u5468\u62a5\u6765\u81ea\u5feb\u901f\u8bb0\u5f55",
  "\u6309\u98ce\u9669\u3001\u5ba2\u6237",
  "\u6309\u5ba2\u6237\u573a\u666f",
  "\u6309\u5546\u673a\u9636\u6bb5",
  "\u8f6c\u5199\u6837\u4f8b",
  "WORKSPACE",
  "\u5de5\u4f5c\u8282\u594f",
];
const BRAND_ICON = "/sent-zhixing-transparent-logo.png";

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    options[match[1].replaceAll("-", "_")] = match[2];
  }
  return {
    backendUrl: options.backend_url ?? process.env.SENT_ZX_BACKEND_URL ?? "http://127.0.0.1:8897",
    frontendUrl: options.frontend_url ?? process.env.SENT_ZX_FRONTEND_URL ?? "http://127.0.0.1:8088",
  };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge executable was not found. Set CHROME_PATH to run fixed stack smoke.");
  return found;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function runProcess(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("close", () => resolveRun());
    child.on("error", () => resolveRun());
  });
}

async function waitForDevTools(profilePath) {
  const portFile = join(profilePath, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
      if (port) return port;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${portFile}`);
}

function connectCdp(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails.text);
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        consoleErrors.push(message.params.entry.text);
      }

      if (!pending.has(message.id)) return;
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    });

    ws.addEventListener(
      "open",
      () => {
        resolveConnect({
          ws,
          consoleErrors,
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

async function openBrowser() {
  const profilePath = mkdtempSync(join(tmpdir(), "sent-zx-fixed-smoke-"));
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "about:blank",
  ], {
    windowsHide: true,
    stdio: "ignore",
  });

  const port = await waitForDevTools(profilePath);
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page");
  if (!page) throw new Error("No Chrome page target found.");

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  return {
    ...cdp,
    async close() {
      cdp.ws.close();
      await runProcess("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"]);
      await delay(400);
      try {
        rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    },
  };
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression, true).catch((error) => ({ error: error.message }));
    if (last && !last.error) return last;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${expression}: ${JSON.stringify(last)}`);
}

async function navigate(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    mobile: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 3 : 1,
  });
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, `new Promise((resolve, reject) => {
    const ready = document.querySelector('.app-shell')
      && document.querySelector('[data-testid="api-status"]')?.innerText.includes(${JSON.stringify(ONLINE)});
    ready ? resolve(true) : reject(new Error('app not ready'));
  })`);
}

async function clickText(cdp, text) {
  await evaluate(cdp, `(() => {
    const target = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((item) => item.innerText && item.innerText.includes(${JSON.stringify(text)}));
    if (!target) throw new Error('Missing clickable text ' + ${JSON.stringify(text)});
    target.click();
    return true;
  })()`);
  await delay(300);
}

async function clickTestId(cdp, testId) {
  await evaluate(cdp, `(() => {
    const target = document.querySelector('[data-testid="${testId}"]');
    if (!target) throw new Error('Missing test id ${testId}');
    target.click();
    return true;
  })()`);
  await delay(300);
}

async function setInputByTestId(cdp, testId, value) {
  await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-testid="${testId}"]');
    if (!input) throw new Error('Missing input ${testId}');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await delay(250);
}

async function setKnowledgeSearch(cdp, value) {
  await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-testid="knowledge-search"] input');
    if (!input) throw new Error('Missing knowledge search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await delay(250);
}

async function getShellState(cdp) {
  return evaluate(cdp, `(() => {
    const html = document.documentElement;
    const body = document.body;
    const content = document.querySelector('.content');
    const brandLogo = document.querySelector('.brand-logo-mark');
    const brandLogoImg = document.querySelector('.brand-area img');
    const brandLogoRect = brandLogo?.getBoundingClientRect();
    const brandLogoImgRect = brandLogoImg?.getBoundingClientRect();
    const text = body.innerText;
    return {
      title: document.title,
      apiStatus: document.querySelector('[data-testid="api-status"]')?.innerText.trim() ?? '',
      favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '',
      appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? '',
      brandLogoSrc: brandLogoImg?.getAttribute('src') ?? '',
      brandLogoRect: brandLogoRect ? {
        width: Math.round(brandLogoRect.width),
        height: Math.round(brandLogoRect.height),
      } : null,
      brandLogoImgRect: brandLogoImgRect ? {
        width: Math.round(brandLogoImgRect.width),
        height: Math.round(brandLogoImgRect.height),
      } : null,
      brandLogoNatural: brandLogoImg ? {
        width: brandLogoImg.naturalWidth,
        height: brandLogoImg.naturalHeight,
      } : null,
      hasTopbarSearch: Boolean(document.querySelector('.topbar input')),
      hasOldGlobalSearchCopy: text.includes(${JSON.stringify(OLD_GLOBAL_SEARCH)}),
      removedCopyMatches: ${JSON.stringify(REMOVED_UI_COPY)}.filter((copy) => text.includes(copy)),
      headingChipCount: document.querySelectorAll('.heading-chips').length,
      pageHeadingParagraphCount: document.querySelectorAll('.page-heading p').length,
      sideNoteCount: document.querySelectorAll('.side-note').length,
      overflowX: Math.max(0, html.scrollWidth - html.clientWidth, body.scrollWidth - body.clientWidth),
      bodyOverflowY: Math.max(0, html.scrollHeight - window.innerHeight, body.scrollHeight - window.innerHeight),
      contentScrollable: content ? content.scrollHeight > content.clientHeight + 2 : false,
    };
  })()`);
}

async function assertSubView(cdp, navText, searchTestId, searchValue, listTestId, detailButtonTestId, detailTestId, detailRequiredTestId) {
  await clickText(cdp, navText);
  await waitFor(cdp, `new Promise((resolve, reject) =>
    document.querySelector('[data-testid="${listTestId}"]') ? resolve(true) : reject(new Error('missing ${listTestId}'))
  )`);
  if (searchTestId) {
    await setInputByTestId(cdp, searchTestId, searchValue);
  }
  const listState = await evaluate(cdp, `(() => ({
    rows: document.querySelectorAll('[data-testid="${listTestId}"] .customer-list-row').length,
    hasDetail: Boolean(document.querySelector('[data-testid="${detailTestId}"]'))
  }))()`);
  assert.equal(listState.hasDetail, false, `${listTestId} should not show detail before navigation`);
  assert.ok(listState.rows >= 1, `${listTestId} should have at least one visible row`);
  await clickTestId(cdp, detailButtonTestId);
  const opened = await waitFor(cdp, `new Promise((resolve, reject) => {
    const detail = document.querySelector('[data-testid="${detailTestId}"]');
    const required = ${JSON.stringify(detailRequiredTestId)} ? document.querySelector('[data-testid="${detailRequiredTestId}"]') : true;
    detail && required && detail.innerText.includes(${JSON.stringify(BACK_LIST)})
      ? resolve(true)
      : reject(new Error('missing ${detailTestId}'));
  })`);
  assert.equal(opened, true, `${detailTestId} should open`);
  await clickText(cdp, BACK_LIST);
  await waitFor(cdp, `new Promise((resolve, reject) =>
    document.querySelector('[data-testid="${listTestId}"]') ? resolve(true) : reject(new Error('${listTestId} not restored'))
  )`);
  return { rows: listState.rows, detailOpened: opened };
}

async function assertKnowledgeSubView(cdp) {
  await clickText(cdp, KNOWLEDGE);
  await waitFor(cdp, `new Promise((resolve, reject) =>
    document.querySelector('[data-testid="knowledge-list-view"]') ? resolve(true) : reject(new Error('missing knowledge list'))
  )`);
  await setKnowledgeSearch(cdp, MOBILE_CLOUD);
  await evaluate(cdp, `document.querySelector('[data-testid="knowledge-search"] button')?.click()`);
  await waitFor(cdp, `new Promise((resolve, reject) => {
    const list = document.querySelector('[data-testid="knowledge-list-view"]');
    list?.innerText.includes(${JSON.stringify(MOBILE_CLOUD)}) ? resolve(true) : reject(new Error('knowledge search not reflected'));
  })`);
  const listState = await evaluate(cdp, `(() => ({
    rows: document.querySelectorAll('[data-testid="knowledge-list-view"] .customer-list-row').length,
    hasDetail: Boolean(document.querySelector('[data-testid="knowledge-detail-view"]'))
  }))()`);
  assert.equal(listState.hasDetail, false, "knowledge list should not show detail before navigation");
  assert.ok(listState.rows >= 1, "knowledge list should have at least one visible row");
  await clickTestId(cdp, "knowledge-open-detail");
  const opened = await waitFor(cdp, `new Promise((resolve, reject) => {
    const detail = document.querySelector('[data-testid="knowledge-detail-view"]');
    detail && document.querySelector('[data-testid="knowledge-editor"]') && document.querySelector('[data-testid="knowledge-citation-actions"]')
      ? resolve(detail.innerText.includes(${JSON.stringify(BACK_LIST)}))
      : reject(new Error('missing knowledge detail'));
  })`);
  assert.equal(opened, true, "knowledge detail should open");
  return { rows: listState.rows, detailOpened: opened };
}

async function assertLongPageScrollAudit(cdp) {
  await clickText(cdp, CUSTOMER);
  await waitFor(cdp, `new Promise((resolve, reject) =>
    document.querySelector('[data-testid="customer-list-view"]') ? resolve(true) : reject(new Error('missing customer list'))
  )`);
  await clickTestId(cdp, "customer-open-detail");
  await waitFor(cdp, `new Promise((resolve, reject) =>
    document.querySelector('[data-testid="customer-detail-view"]') ? resolve(true) : reject(new Error('missing customer detail'))
  )`);
  const audit = await evaluate(cdp, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.querySelector('.content');
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    const positions = [0, Math.round(maxScroll / 2), maxScroll];
    const visibleButtons = [];
    for (const y of positions) {
      root.scrollTo(0, y);
      await wait(80);
      visibleButtons.push(...[...document.querySelectorAll('button,[role="button"]')]
        .filter((item) => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return !item.disabled
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0
            && rect.bottom >= 0
            && rect.top <= window.innerHeight;
        })
        .map((item) => ({
          label: (item.innerText || item.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
          width: Math.round(item.getBoundingClientRect().width),
          height: Math.round(item.getBoundingClientRect().height),
        })));
    }
    root.scrollTo(0, 0);
    return {
      maxScroll,
      visibleButtons: visibleButtons.length,
      small: visibleButtons.filter((item) => item.width < 34 || item.height < 34),
      unlabeled: visibleButtons.filter((item) => !item.label),
    };
  })()`, true);
  assert.ok(audit.maxScroll > 0, "customer detail should use internal content scroll");
  assert.ok(audit.visibleButtons > 0, "scroll audit should sample visible buttons");
  assert.deepEqual(audit.small, [], "sampled internal-scroll buttons should meet minimum desktop target size");
  assert.deepEqual(audit.unlabeled, [], "sampled internal-scroll buttons should have labels");
  return audit;
}

async function assertBackend(config) {
  const health = await fetch(`${config.backendUrl}/api/health`).then((response) => response.json());
  assert.equal(health.status, "ok", "backend health status should be ok");
  assert.equal(health.modelProvider, "deepseek", "fixed business stack should use DeepSeek provider");
  assert.equal(health.modelName, "deepseek-v4-flash", "fixed business stack should use DeepSeek-V4-Flash");
  assert.equal(health.modelReady, true, "fixed business stack model should be ready");
  return health;
}

async function assertFrontendHtml(config) {
  const html = await fetch(config.frontendUrl).then((response) => response.text());
  assert.match(html, /sent-zhixing-transparent-logo\.png/, "frontend HTML should reference the Sent Zhixing logo icon");
  assert.match(html, /apple-touch-icon/, "frontend HTML should expose an Apple touch icon");
  assert.doesNotMatch(html, /data:image\/svg\+xml/, "frontend HTML should not use the old generic SVG favicon");
  const iconResponse = await fetch(new URL(BRAND_ICON, config.frontendUrl));
  assert.equal(iconResponse.status, 200, "brand icon should be served by the fixed frontend");
  assert.match(iconResponse.headers.get("content-type") ?? "", /image\/png/, "brand icon should be served as PNG");
  return { brandedIcon: true, appleTouchIcon: true, genericSvgRemoved: true };
}

async function runBrowserSmoke(config) {
  const cdp = await openBrowser();
  try {
    await navigate(cdp, config.frontendUrl, { width: 1440, height: 900, mobile: false });
    const desktop = await getShellState(cdp);
    assert.equal(desktop.title, TITLE, "desktop title should be branded");
    assert.equal(desktop.apiStatus, ONLINE, "desktop API status should be online");
    assert.equal(desktop.favicon, BRAND_ICON, "desktop favicon should use the Sent Zhixing logo");
    assert.equal(desktop.appleTouchIcon, BRAND_ICON, "desktop touch icon should use the Sent Zhixing logo");
    assert.equal(desktop.brandLogoSrc, BRAND_ICON, "desktop header should use the Sent Zhixing logo");
    assert.ok(desktop.brandLogoRect?.width >= 200, `desktop should show the full horizontal logo, got ${desktop.brandLogoRect?.width}px`);
    assert.ok(desktop.brandLogoImgRect?.width <= desktop.brandLogoRect.width + 2, "desktop logo image should fit inside its container");
    assert.ok(desktop.brandLogoNatural?.width > desktop.brandLogoNatural?.height, "brand logo asset should be a horizontal image");
    assert.equal(desktop.hasTopbarSearch, false, "desktop should not render the removed global search");
    assert.equal(desktop.hasOldGlobalSearchCopy, false, "desktop should not contain old global search copy");
    assert.deepEqual(desktop.removedCopyMatches, [], "desktop should not render removed prototype or explanatory copy");
    assert.equal(desktop.headingChipCount, 0, "desktop should not render removed page heading chips");
    assert.equal(desktop.pageHeadingParagraphCount, 0, "desktop page headings should not render explanatory paragraphs");
    assert.equal(desktop.sideNoteCount, 0, "desktop sidebar should not render removed note cards");
    assert.equal(desktop.overflowX, 0, "desktop should not overflow horizontally");
    assert.equal(desktop.bodyOverflowY, 0, "desktop body should not be the primary scroll area");
    assert.equal(desktop.contentScrollable, true, "desktop content area should own vertical scrolling");

    const customer = await assertSubView(cdp, CUSTOMER, "customer-local-search", "\u65e5\u7167", "customer-list-view", "customer-open-detail", "customer-detail-view", "customer-editor");
    const action = await assertSubView(cdp, ACTIONS, "actions-local-search", BUQI, "action-list-view", "actions-open-detail", "action-detail-view", "action-status-toolbar");
    const risk = await assertSubView(cdp, RISK, "risk-local-search", YUSUAN, "risk-list-view", "risk-open-detail", "risk-detail-view", "risk-status-toolbar");
    const knowledge = await assertKnowledgeSubView(cdp);
    const scrollAudit = await assertLongPageScrollAudit(cdp);

    await navigate(cdp, config.frontendUrl, { width: 390, height: 844, mobile: true });
    const mobile = await getShellState(cdp);
    assert.equal(mobile.apiStatus, ONLINE, "mobile API status should be online");
    assert.equal(mobile.brandLogoSrc, BRAND_ICON, "mobile header should use the Sent Zhixing logo");
    assert.ok(mobile.brandLogoRect?.width <= 60, `mobile should collapse the logo to an icon-width container, got ${mobile.brandLogoRect?.width}px`);
    assert.ok(mobile.brandLogoImgRect?.width > mobile.brandLogoRect.width, "mobile should crop the horizontal logo instead of squeezing it");
    assert.equal(mobile.hasTopbarSearch, false, "mobile should not render the removed global search");
    assert.deepEqual(mobile.removedCopyMatches, [], "mobile should not render removed prototype or explanatory copy");
    assert.equal(mobile.headingChipCount, 0, "mobile should not render removed page heading chips");
    assert.equal(mobile.pageHeadingParagraphCount, 0, "mobile page headings should not render explanatory paragraphs");
    assert.equal(mobile.sideNoteCount, 0, "mobile sidebar should not render removed note cards");
    assert.equal(mobile.overflowX, 0, "mobile should not overflow horizontally");
    assert.equal(mobile.bodyOverflowY, 0, "mobile body should not be the primary scroll area");

    const consoleErrors = cdp.consoleErrors.filter((error) => !String(error).includes("favicon"));
    assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join("; ")}`);

    return {
      desktop,
      subViews: { customer, action, risk, knowledge },
      scrollAudit: {
        maxScroll: scrollAudit.maxScroll,
        visibleButtons: scrollAudit.visibleButtons,
      },
      mobile,
      consoleErrors: consoleErrors.length,
    };
  } finally {
    await cdp.close();
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const backend = await assertBackend(config);
  const html = await assertFrontendHtml(config);
  const browser = await runBrowserSmoke(config);
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    backendUrl: config.backendUrl,
    frontendUrl: config.frontendUrl,
    backend: {
      status: backend.status,
      modelProvider: backend.modelProvider,
      modelName: backend.modelName,
      modelReady: backend.modelReady,
    },
    html,
    browser,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
