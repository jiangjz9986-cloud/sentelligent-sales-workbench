import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./useWorkbenchHandlers.jsx", import.meta.url);

test("customer import handlers guard the backend, delegate all workflow steps, and refresh after confirm", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const handler of [
    "handlePreviewCustomerImport",
    "handleConfirmCustomerImport",
    "handleCancelCustomerImport",
  ]) {
    assert.ok(source.includes(`${handler}: async () => {}`), `missing ${handler} noop`);
    assert.match(source, new RegExp(`async function ${handler}`));
  }
  assert.match(source, /apiClient\.previewCustomerImport\(request\.file, request\)/u);
  assert.match(source, /apiClient\.confirmCustomerImport\(request\.batchId, request, request\)/u);
  assert.match(source, /apiClient\.cancelCustomerImport\(request\.batchId, request, request\)/u);
  assert.match(source, /if \(typeof reloadBootstrap === "function"\) await reloadBootstrap\(\)/);
  assert.match(source, /ensureBackend\("预览客户批量导入"\)/);
  assert.match(source, /ensureBackend\("确认客户批量导入"\)/);
  assert.match(source, /ensureBackend\("取消客户批量导入"\)/);
});
