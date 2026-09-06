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

async function rowText(page, account) {
  return page.locator(`[data-testid="user-row-${account}"]`).innerText();
}

test("walks the create, edit, disable, and enable lifecycle in a real browser", async (context) => {
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
  const confirmMessages = [];
  page.on("dialog", (dialog) => {
    confirmMessages.push(dialog.message());
    void dialog.accept();
  });
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/user-management-harness.html`);
  await page.waitForSelector('[data-testid="user-table"]');

  // 初始列表：种子管理员在场，自己的停用按钮不可点。
  assert.match(await rowText(page, "jiangjz"), /继振/);
  assert.equal(await page.locator('[data-testid="user-toggle-jiangjz"]').isDisabled(), true);
  assert.equal(
    await page.locator('[data-testid="user-toggle-jiangjz"]').getAttribute("title"),
    "不能停用自己",
  );

  // 建号 → 列表出现。
  await page.click('[data-testid="user-create-button"]');
  await page.waitForSelector('[data-testid="user-create-form"]');
  await page.fill('input[aria-label="账号"]', "colleague");
  await page.fill('input[aria-label="姓名"]', "同事");
  await page.fill('input[aria-label="初始密码"]', "unit-colleague-value");
  await page.click('[data-testid="user-create-form"] button[type="submit"]');
  await page.waitForSelector('[data-testid="user-row-colleague"]');
  assert.match(await rowText(page, "colleague"), /同事/);
  assert.match(await rowText(page, "colleague"), /成员/);
  assert.match(await rowText(page, "colleague"), /启用/);

  // 编辑姓名与角色。
  await page.click('[data-testid="user-edit-colleague"]');
  await page.waitForSelector('[data-testid="user-edit-form"]');
  await page.fill('[data-testid="user-edit-form"] input[aria-label="姓名"]', "同事甲");
  await page.selectOption('[data-testid="user-edit-form"] select[aria-label="角色"]', "admin");
  await page.click('[data-testid="user-edit-form"] button[type="submit"]');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="user-row-colleague"]')?.textContent?.includes("同事甲")
  ));
  assert.match(await rowText(page, "colleague"), /管理员/);

  // 停用（window.confirm 惯例）→ 状态翻转为已停用。
  await page.click('[data-testid="user-toggle-colleague"]');
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="user-row-colleague"]')?.textContent?.includes("已停用")
  ));
  assert.equal(confirmMessages.length, 1);
  assert.match(confirmMessages[0], /确定停用 同事甲/);

  // 启用 → 状态恢复。
  await page.click('[data-testid="user-toggle-colleague"]');
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="user-row-colleague"]')?.textContent ?? "";
    return text.includes("启用") && !text.includes("已停用");
  });
  assert.equal(confirmMessages.length, 2);
  assert.match(confirmMessages[1], /确定重新启用 同事甲/);

  // 桩收到的写入序列与乐观锁版本推进一致。
  const writes = await page.evaluate(() => window.__userWrites);
  assert.deepEqual(writes.map((write) => write.kind), ["create", "update", "update", "update"]);
  assert.equal(writes[1].payload.expectedVersion, 1);
  assert.equal(writes[2].payload.expectedVersion, 2);
  assert.equal(writes[2].payload.status, "disabled");
  assert.equal(writes[3].payload.expectedVersion, 3);
  assert.equal(writes[3].payload.status, "active");
});
