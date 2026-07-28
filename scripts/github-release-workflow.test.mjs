import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);

describe("GitHub tagged release workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("runs only for formal version tags with write access to release assets", () => {
    assert.match(workflow, /tags:\s*\n\s*- ["']v\*["']/);
    assert.match(workflow, /contents:\s*write/);
    assert.match(workflow, /Verify tag matches package version/);
  });

  it("rebuilds and verifies the complete project on Node 24", () => {
    assert.match(workflow, /node-version:\s*24/);
    assert.match(workflow, /npm ci --prefix backend/);
    assert.match(workflow, /npm ci --prefix outputs\/product-design-prototype/);
    assert.match(workflow, /npm run test:deploy/);
    assert.match(workflow, /npm --prefix backend test/);
    assert.match(workflow, /npm --prefix outputs\/product-design-prototype run qa:local/);
  });

  it("publishes an immutable archive and checksum as both an artifact and a GitHub Release", () => {
    assert.match(workflow, /npm run release:package/);
    assert.match(workflow, /sha256sum .*SHA256SUMS/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /gh release create/);
    assert.match(workflow, /release-result\.json/);
  });
});
