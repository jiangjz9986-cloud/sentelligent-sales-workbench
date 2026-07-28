import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

describe("GitHub CI workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("runs every root Node test instead of the partial release test script", () => {
    assert.match(workflow, /run:\s*node --test scripts\/\*\.test\.mjs/);
    assert.doesNotMatch(workflow, /run:\s*npm run test:release/);
  });
});
