import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./CustomerPage.jsx", import.meta.url);

test("customer detail mounts the local-state import panel with all workflow handlers", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /import \{ CustomerImportPanel \} from "\.\.\/\.\.\/customerImport\/CustomerImportPanel\.jsx"/u);
  assert.match(source, /<CustomerImportPanel[\s\S]*?onPreview=\{handlePreviewCustomerImport\}[\s\S]*?onConfirm=\{handleConfirmCustomerImport\}[\s\S]*?onCancel=\{handleCancelCustomerImport\}/u);
  assert.match(source, /disabled=\{!apiClient\?\.isEnabled \|\| backendStatus !== "connected"\}/u);
  assert.doesNotMatch(source, /useState\([^)]*customerImport/iu);
});
