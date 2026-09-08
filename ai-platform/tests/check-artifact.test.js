import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const checker = join(repositoryRoot, "scripts/ai-platform/check-artifact.sh");

function runChecker(path) {
  return spawnSync("bash", [checker, `--path=${path}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function writeEntry(root, relativePath, content = "fixture\n") {
  const target = join(root, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function createArchive(root, archivePath) {
  const result = spawnSync("tar", ["-czf", archivePath, "-C", root, "."], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

describe("AI platform artifact name boundary", () => {
  it("allows source filenames containing token while rejecting credential artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-platform-artifact-safe-"));
    try {
      writeEntry(root, "backend/src/db/migrations/0017_shortcut_webhook_tokens.mjs");
      writeEntry(root, "src/auth/token.js");
      writeEntry(root, "scripts/secret-scan.mjs");
      assert.equal(runChecker(root).status, 0);

      writeEntry(root, "config/credentials.json");
      const rejected = runChecker(root);
      assert.notEqual(rejected.status, 0);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /credentials\.json/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the same boundary to tar archive members", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-platform-artifact-tar-"));
    const archive = join(root, "release.tar.gz");
    const safeTree = join(root, "safe");
    const unsafeTree = join(root, "unsafe");
    try {
      mkdirSync(safeTree, { recursive: true });
      writeEntry(safeTree, "backend/src/db/migrations/0017_shortcut_webhook_tokens.mjs");
      createArchive(safeTree, archive);
      assert.equal(runChecker(archive).status, 0);

      mkdirSync(unsafeTree, { recursive: true });
      writeEntry(unsafeTree, "config/api-token.txt");
      createArchive(unsafeTree, archive);
      const rejected = runChecker(archive);
      assert.notEqual(rejected.status, 0);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /api-token\.txt/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
