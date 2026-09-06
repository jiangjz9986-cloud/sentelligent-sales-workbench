import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { webkit } from "playwright";
import React from "react";
import { createServer } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const componentPath = path.join(projectRoot, "src/features/customerImport/CustomerImportPanel.jsx");
const stylesheetPath = path.join(projectRoot, "src/features/customerImport/CustomerImportPanel.css");
const harnessPath = path.join(os.tmpdir(), `customer-import-panel-harness-${process.pid}.jsx`);
const csvPath = path.join(os.tmpdir(), `customer-import-panel-fixture-${process.pid}.csv`);

const fileDigest = "a".repeat(64);
const previewDigest = "b".repeat(64);

const fixture = {
  batch: {
    id: "batch-browser-1",
    owner: "fixture-owner",
    status: "preview",
    fileName: "customers.csv",
    mediaType: "text/csv",
    fileSizeBytes: 88,
    fileSha256: fileDigest,
    totalRows: 2,
    validRows: 2,
    errorRows: 0,
    duplicateRows: 1,
  },
  previewDigest,
  mapping: {
    fieldToHeader: { name: "客户名称", region: "区域", contact: "联系人" },
    headerToField: { "客户名称": "name", "区域": "region", "联系人": "contact" },
    ignoredHeaders: ["owner"],
    unmappedHeaders: [],
    requiredFields: ["name"],
    digest: "c".repeat(64),
  },
  rows: [
    {
      id: "browser-row-1",
      rowNumber: 2,
      status: "valid",
      action: "create",
      canonicalName: "海州医院",
      normalized: { name: "海州医院", region: "连云港", contact: "张主任" },
      errors: [],
    },
    {
      id: "browser-row-2",
      rowNumber: 3,
      status: "duplicate",
      action: "merge",
      canonicalName: "东城医院",
      customerId: "customer-browser-1",
      matchedBy: "alias",
      normalized: { name: "东城医院", region: "南京" },
      errors: [],
    },
  ],
};

let vite;
let browser;
let origin;

function harnessSource() {
  return `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomerImportPanel } from "/src/features/customerImport/CustomerImportPanel.jsx";

const fixture = ${JSON.stringify(fixture)};
const events = [];

function resultFor(status, overrides = {}) {
  return {
    ...fixture,
    ...overrides,
    batch: { ...fixture.batch, status },
    receipt: status === "committed" || status === "cancelled" ? {
      batchId: fixture.batch.id,
      previewDigest: fixture.previewDigest,
      counts: { created: 1, merged: 1, skipped: 0, rejected: 0 },
      rows: fixture.rows.map((row) => ({ rowNumber: row.rowNumber, action: row.action, status: "committed", customerId: row.customerId })),
    } : null,
  };
}

function App() {
  const [result, setResult] = useState(null);
  return <CustomerImportPanel
    result={result}
    onPreview={async (request) => {
      events.push({
        type: "preview",
        mapping: request.mapping ?? {},
        requestKeys: Object.keys(request).sort(),
        hasRowActions: Object.hasOwn(request, "rowActions"),
      });
      const next = {
        ...fixture,
        mapping: {
          ...fixture.mapping,
          fieldToHeader: { ...fixture.mapping.fieldToHeader, ...(request.mapping ?? {}) },
        },
      };
      setResult(next);
      return next;
    }}
    onConfirm={async (request) => {
      events.push({ type: "confirm", request });
      const next = resultFor("committed");
      setResult(next);
      return next;
    }}
    onCancel={async (request) => {
      events.push({ type: "cancel", request });
      const next = resultFor("cancelled");
      setResult(next);
      return next;
    }}
    onReset={() => setResult(null)}
  />;
}

createRoot(document.getElementById("root")).render(<App />);
window.__customerImportEvents = events;
`;
}

before(async () => {
  await writeFile(harnessPath, harnessSource(), "utf8");
  await writeFile(csvPath, "客户名称,区域,联系人\n海州医院,连云港,张主任\n东城医院,南京,李主任\n", "utf8");
  vite = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [projectRoot, os.tmpdir()] } },
    appType: "custom",
    plugins: [{
      name: "customer-import-panel-harness",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/__customer-import-panel-test") {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(`<!doctype html>
<html><head><script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root"></div><script type="module" src="/@fs${harnessPath}"></script></body></html>`);
        });
      },
    }],
  });
  await vite.listen();
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await webkit.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await vite?.close();
  await rm(harnessPath, { force: true });
  await rm(csvPath, { force: true });
});

test("component exposes the injected preview contract and local responsive states", async () => {
  const [source, styles] = await Promise.all([readFile(componentPath, "utf8"), readFile(stylesheetPath, "utf8")]);
  for (const token of ["onPreview", "onConfirm", "onCancel", "buildCustomerImportPreviewRequest", "buildCustomerImportConfirmRequest", "buildCustomerImportCancelRequest", "previewDigest", "服务端预览动作", "data-testid=\"customer-import-panel\""]) {
    assert.ok(source.includes(token), `missing ${token}`);
  }
  for (const token of ["customer-import-mobile-rows", "customer-import-action-preview", "@media (max-width: 640px)", "min-height: 44px", "customer-import-dialog-backdrop", "customer-import-digests"]) {
    assert.ok(styles.includes(token), `missing ${token}`);
  }
  assert.doesNotMatch(source, /rowActions(?:Draft)?|setRowActionsDraft|updateRowAction|customer-import-action-select/u);
  assert.doesNotMatch(styles, /customer-import-action-select|customer-import-row-action/u);
});

test("browser flow keeps service actions read-only across mobile and desktop while mapping replay, cancel, and confirm work", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    page.on("console", (message) => console.error(`[customer-import browser console] ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[customer-import browser error] ${error.stack || error.message}`));
    await page.goto(`${origin}/__customer-import-panel-test`);
    await page.locator('[data-testid="customer-import-panel"]').waitFor();
    assert.equal(await page.getByLabel("选择客户导入文件").isVisible(), false);
    await page.getByRole("button", { name: "选择文件", exact: true }).waitFor();

    await page.locator('input[type="file"]').setInputFiles(csvPath);
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await page.locator(".customer-import-mobile-rows").getByText("海州医院", { exact: true }).waitFor();
    assert.equal(await page.locator(".customer-import-table-wrap").isVisible(), false);
    assert.equal(await page.locator(".customer-import-mobile-rows").isVisible(), true);
    assert.equal(await page.getByText("确认导入", { exact: true }).count(), 1);
    assert.equal(await page.locator(".customer-import-mobile-rows select").count(), 0);
    await page.locator(".customer-import-mobile-rows").getByLabel("第 3 行服务端预览动作：合并到现有客户").waitFor();

    await page.getByRole("combobox", { name: "区域映射" }).selectOption("联系人");
    await page.getByText("文件或字段映射已变化，确认前请重新生成预览。", { exact: true }).waitFor();
    await page.getByText("需要重新生成预览", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "确认导入", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "重新生成预览", exact: true }).click();
    await page.locator('.customer-import-mobile-rows .customer-import-row-number').filter({ hasText: "第 3 行" }).waitFor();

    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator(".customer-import-table-wrap").isVisible(), true);
    assert.equal(await page.locator(".customer-import-mobile-rows").isVisible(), false);
    assert.equal(await page.locator(".customer-import-table-wrap select").count(), 0);
    await page.locator(".customer-import-table-wrap").getByLabel("第 3 行服务端预览动作：合并到现有客户").waitFor();

    await page.getByRole("button", { name: "取消预览", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "取消本次预览", exact: true }).click();
    await page.getByText("本次预览已取消", { exact: true }).waitFor();

    await page.getByRole("button", { name: "开始新的导入", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles(csvPath);
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await page.locator(".customer-import-table-wrap").getByText("海州医院", { exact: true }).waitFor();
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认导入", exact: true }).click();
    await page.getByText("客户导入已完成", { exact: true }).waitFor();

    const events = await page.evaluate(() => window.__customerImportEvents);
    assert.deepEqual(events.map((event) => event.type), ["preview", "preview", "cancel", "preview", "confirm"]);
    assert.equal(events.filter((event) => event.type === "preview").every((event) => event.hasRowActions === false), true);
    assert.equal(events[1].mapping.region, "联系人");
    assert.deepEqual(events[1].requestKeys, ["file", "idempotencyKey", "mapping"]);
    assert.equal(events[4].request.confirmed, true);
    assert.equal(events[4].request.previewDigest, previewDigest);
  } finally {
    await page.close();
  }
});
