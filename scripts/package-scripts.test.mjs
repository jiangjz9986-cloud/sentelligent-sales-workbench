import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const ciWorkflow = readFileSync(
  resolve(".github", "workflows", "ci.yml"),
  "utf8",
);

describe("root package QA scripts", () => {
  it("exposes one command for the full formal delivery verification", () => {
    const script = packageJson.scripts?.["qa:full"];

    assert.ok(script, "qa:full should exist");
    assert.match(script, /npm run test:deploy/);
    assert.match(script, /npm --prefix backend test/);
    assert.match(script, /npm --prefix outputs\/product-design-prototype run qa:local/);
    assert.match(script, /npm --prefix outputs\/product-design-prototype run qa:integration/);
  });

  it("pins the GitHub Linux Chrome executable for browser-backed frontend QA", () => {
    assert.match(ciWorkflow, /CHROME_PATH:\s*\/usr\/bin\/google-chrome/);
    assert.match(
      ciWorkflow,
      /npm --prefix outputs\/product-design-prototype run qa:local/,
    );
  });
});
