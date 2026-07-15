import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it } from "node:test";

import { scanProjectSecrets } from "./project-secret-scan.mjs";

const sampleProviderKey = `sk-${"1234567890abcdef1234567890abcdef"}`;

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "sent-zx-secret-scan-"));
  return {
    root,
    write(relativePath, content) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("project secret scan", () => {
  it("finds OpenAI-style provider keys in project text files", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write("notes/requirements.txt", `model key ${sampleProviderKey}`);

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "failed");
      assert.deepEqual(result.findings.map((item) => item.file), ["notes/requirements.txt"]);
      assert.equal(result.findings[0].pattern, "OpenAI-style key");
    } finally {
      workspace.cleanup();
    }
  });

  it("ignores dependency and generated folders", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write("node_modules/pkg/index.js", `const key = '${sampleProviderKey}';`);
      workspace.write("dist/app.js", `const key = '${sampleProviderKey}';`);
      workspace.write(".runtime/local.json", `{"token":"${sampleProviderKey}"}`);
      workspace.write("src/index.js", "console.log('clean');");

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.equal(result.findings.length, 0);
      assert.equal(result.scannedFiles, 1);
    } finally {
      workspace.cleanup();
    }
  });

  it("passes when scanned project files contain only placeholders", () => {
    const workspace = makeWorkspace();
    try {
      workspace.write("README.md", "Use MODEL_API_KEY=[redacted-backend-env-only] in backend .env.");

      const result = scanProjectSecrets({ root: workspace.root });

      assert.equal(result.status, "passed");
      assert.equal(result.scannedFiles, 1);
    } finally {
      workspace.cleanup();
    }
  });
});
