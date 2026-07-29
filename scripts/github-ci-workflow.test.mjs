import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

describe("GitHub CI workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("runs browser integration QA for pull requests and main pushes", () => {
    assert.match(workflow, /pull_request:\s*(?:\r?\n)/);
    assert.match(workflow, /push:\s*\r?\n\s+branches:\s*\r?\n\s+- main/);

    const integrationRuns =
      workflow.match(
        /run:\s*npm --prefix outputs\/product-design-prototype run qa:integration/g,
      ) ?? [];

    assert.equal(integrationRuns.length, 1, "CI must run browser integration QA exactly once");
    assert.doesNotMatch(workflow, /if:\s*.*github\.event_name/);
  });

  it("runs every root Node test instead of the partial release test script", () => {
    assert.match(workflow, /run:\s*node --test scripts\/\*\.test\.mjs/);
    assert.doesNotMatch(workflow, /run:\s*npm run test:release/);
  });
});
