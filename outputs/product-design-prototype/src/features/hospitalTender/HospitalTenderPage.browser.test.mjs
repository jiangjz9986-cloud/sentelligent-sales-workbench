import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { webkit } from "playwright";
import { createServer as createViteServer } from "vite";

import { hashPassword } from "../../../../../backend/src/auth/password.js";
import { createServer as createBackendServer } from "../../../../../backend/src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../../..");
const fixtureAccount = "jiangjz";
const fixtureLoginValue = "ui-browser-fixture-value";
const fixtureSyncValue = "ui-browser-sync-fixture-value-123456";

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

function snapshotPayload() {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-09-02T01:00:00.000Z",
    notices: [{
      identityKey: "source-browser:item-1",
      sourceId: "source-browser",
      sourceName: "示例采购平台",
      city: "日照市",
      title: "日照中医医院 PACS 存储扩容中标公告",
      url: "https://example.com/notices/browser-1",
      publishedAt: "2026-09-02T00:00:00.000Z",
      noticeType: "result",
      purchaser: "日照中医医院",
      projectCode: "RZ-BROWSER-01",
      budgetText: "500 万元",
      deadlineText: "2026-09-10",
      contentText: "采购 PACS 双活存储和灾备服务。",
      hospitalNames: ["日照中医医院"],
      sourceItemId: "item-1",
      contentSha256: "a".repeat(64),
      relevance: "high",
    }],
    sources: [{
      sourceId: "source-browser",
      sourceName: "示例采购平台",
      status: "healthy",
      lastRunAt: "2026-09-02T00:00:00.000Z",
      lastSuccessAt: "2026-09-02T00:00:00.000Z",
      lastItemCount: 1,
      lastUpsertedCount: 1,
      lastRejectedCount: 0,
    }],
  };
}

async function conversionCounts(page, backendOrigin) {
  return page.evaluate(async (origin) => {
    const [opportunityResponse, actionResponse] = await Promise.all([
      window.fetch(`${origin}/api/opportunities`, { credentials: "include" }),
      window.fetch(`${origin}/api/actions`, { credentials: "include" }),
    ]);
    if (!opportunityResponse.ok || !actionResponse.ok) {
      throw new Error("owner-scoped conversion count request failed");
    }
    const opportunities = await opportunityResponse.json();
    const actions = await actionResponse.json();
    const tenderOpportunities = opportunities.items.filter((item) => (
      String(item.sourceRecord ?? "").startsWith("hospital_tender:")
    ));
    const opportunityIds = new Set(tenderOpportunities.map((item) => item.id));
    return {
      opportunities: tenderOpportunities.length,
      actions: actions.items.filter((item) => opportunityIds.has(item.opportunityId)).length,
    };
  }, backendOrigin);
}

async function openTenderDetail(page) {
  await page.getByRole("button", { name: "客户画像", exact: true }).click();
  await page.getByRole("button", { name: "招标监测", exact: true }).click();
  await page.getByRole("heading", { name: "医院招标监测", exact: true }).waitFor();
  await page.getByRole("button", {
    name: /日照中医医院 PACS 存储扩容中标公告 日照中医医院/u,
  }).first().click();
  await page.getByTestId("hospital-tender-lead-conversion").waitFor();
}

test("finishes preview, cancel, confirm, replay, and bounded-error flows in a real browser", {
  timeout: 60_000,
}, async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "sentelligent-tender-ui-test-"));
  const backendPort = await freePort();
  const frontendPort = await freePort();
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const previousApiBase = process.env.VITE_API_BASE_URL;
  let backend;
  let vite;
  let browser;

  try {
    backend = createBackendServer({
      databaseUrl: resolve(runtimeDirectory, "browser.sqlite"),
      seed: true,
      nodeEnv: "test",
      aiAnalysisMode: "mock",
      authRequired: true,
      authAccount: fixtureAccount,
      authPassword: "",
      authPasswordHash: await hashPassword(fixtureLoginValue, { salt: Buffer.alloc(16, 11) }),
      authSessionSecret: "fixture-session-secret-placeholder-value",
      authCookieSecure: false,
      corsAllowedOrigins: [frontendOrigin],
      hospitalTenderSyncToken: fixtureSyncValue,
      hospitalTenderAutoRun: false,
    });
    await listen(backend, backendPort);

    const syncResponse = await fetch(`${backendOrigin}/api/integrations/hospital-tenders/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fixtureSyncValue}`,
      },
      body: JSON.stringify(snapshotPayload()),
    });
    assert.equal(syncResponse.status, 200);

    process.env.VITE_API_BASE_URL = backendOrigin;
    vite = await createViteServer({
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: frontendPort, strictPort: true },
    });
    await vite.listen();

    browser = await webkit.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(frontendOrigin);
    await page.getByLabel("账号", { exact: true }).fill(fixtureAccount);
    await page.getByLabel("密码", { exact: true }).fill(fixtureLoginValue);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('[data-testid="api-status"]').waitFor();
    await openTenderDetail(page);

    let delayedPreviewObserved = false;
    await page.route("**/lead-conversion/preview", async (route) => {
      delayedPreviewObserved = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      await route.continue();
    });
    await page.getByRole("button", { name: "生成转商机预览", exact: true }).click();
    await page.getByRole("button", { name: "正在生成预览", exact: true }).waitFor();
    await page.getByRole("button", { name: "确认创建商机和待办", exact: true }).waitFor();
    assert.equal(delayedPreviewObserved, true);

    await page.getByRole("button", { name: "取消本次预览", exact: true }).click();
    await page.getByText("本次预览已取消，没有写入业务数据。", { exact: true }).waitFor();
    assert.deepEqual(await conversionCounts(page, backendOrigin), { opportunities: 0, actions: 0 });

    await page.getByRole("button", { name: "重新生成预览", exact: true }).click();
    await page.getByRole("button", { name: "确认创建商机和待办", exact: true }).waitFor();
    await page.getByRole("button", { name: "确认创建商机和待办", exact: true }).click();
    await page.getByText("商机和跟进待办已创建。", { exact: true }).waitFor();
    assert.deepEqual(await conversionCounts(page, backendOrigin), { opportunities: 1, actions: 1 });

    await page.getByRole("button", { name: "再次核对创建结果", exact: true }).click();
    await page.getByText("这条公告已转为商机，本次没有重复创建。", { exact: true }).waitFor();
    assert.deepEqual(await conversionCounts(page, backendOrigin), { opportunities: 1, actions: 1 });

    await page.getByRole("button", { name: "关闭公告详情", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", {
      name: /日照中医医院 PACS 存储扩容中标公告 日照中医医院/u,
    }).first().click();
    await page.getByTestId("hospital-tender-lead-conversion").waitFor();
    await page.getByRole("button", { name: "生成转商机预览", exact: true }).click();
    await page.getByRole("button", { name: "确认创建商机和待办", exact: true }).waitFor();

    const staleHandler = (route) => route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "PREVIEW_STALE", message: "fixture detail must remain hidden" },
      }),
    });
    await page.route("**/lead-conversion/confirm", staleHandler);
    await page.getByRole("button", { name: "确认创建商机和待办", exact: true }).click();
    await page.getByText("公告或客户信息已经变化，请重新生成预览后再确认。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "生成转商机预览", exact: true }).waitFor();
    assert.equal(await page.getByText("fixture detail must remain hidden", { exact: false }).count(), 0);
    await page.unroute("**/lead-conversion/confirm", staleHandler);

    const internalErrorHandler = (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "sqlite stack fixture must remain hidden" },
      }),
    });
    await page.route("**/lead-conversion/preview", internalErrorHandler);
    await page.getByRole("button", { name: "生成转商机预览", exact: true }).click();
    await page.getByText("转商机操作未完成，请稍后重试。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "生成转商机预览", exact: true }).isEnabled(), true);
    assert.equal(await page.getByText("sqlite stack fixture must remain hidden", { exact: false }).count(), 0);
    await page.unroute("**/lead-conversion/preview", internalErrorHandler);
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (backend) await closeServer(backend);
    if (previousApiBase === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousApiBase;
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
