import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const frontendPackageJson = JSON.parse(readFileSync(
  resolve("outputs", "product-design-prototype", "package.json"),
  "utf8",
));
const ciWorkflow = readFileSync(
  resolve(".github", "workflows", "ci.yml"),
  "utf8",
);
const releaseWorkflow = readFileSync(
  resolve(".github", "workflows", "release.yml"),
  "utf8",
);

describe("root package QA scripts", () => {
  it("explicitly runs the proactive panel regression in regular frontend QA", () => {
    const command = frontendPackageJson.scripts?.["test:proactive-assistant"] ?? "";
    assert.match(command, /^node --test /);
    assert.ok(command.split(/\s+/u).includes("src/features/salesWorkbench/components/ProactiveAssistantPanel.test.mjs"));
    assert.ok(frontendPackageJson.scripts["qa:local"].split(" && ").includes("npm run test:proactive-assistant"));
  });

  it("runs customer metadata and browser evidence identity tests in regular frontend QA", () => {
    for (const [name, file] of [
      ["test:customer-metadata", "src/features/salesWorkbench/pages/customerRecordMetadata.test.js"],
      ["test:browser-evidence", "scripts/browser-evidence.test.mjs"],
    ]) {
      assert.equal(frontendPackageJson.scripts?.[name], `node --test ${file}`);
      assert.ok(frontendPackageJson.scripts["qa:local"].split(" && ").includes(`npm run ${name}`));
    }
  });

  it("keeps both identity-bound browser acceptance runners in integration QA", () => {
    for (const [name, file] of [
      ["test:scroll-wheel", "scripts/scroll-wheel-qa.test.mjs"],
      ["test:customer-import-acceptance", "scripts/customer-import-acceptance.mjs"],
    ]) {
      assert.equal(frontendPackageJson.scripts?.[name], `node ${file}`);
      assert.ok(frontendPackageJson.scripts["qa:integration"].split(" && ").includes(`npm run ${name}`));
    }
    assert.equal(frontendPackageJson.scripts.build, "vite build");
  });

  it("exposes one command for the full formal delivery verification", () => {
    const script = packageJson.scripts?.["qa:full"];

    assert.ok(script, "qa:full should exist");
    assert.match(script, /npm run test:deploy/);
    assert.match(script, /npm run test:ai-platform/);
    assert.match(script, /npm --prefix backend test/);
    assert.match(script, /npm --prefix outputs\/product-design-prototype run qa:local/);
    assert.match(script, /npm --prefix outputs\/product-design-prototype run qa:integration/);
    assert.match(script, /npm --prefix outputs\/product-design-prototype run qa:webkit/);
  });

  it("keeps the isolated AI platform in local, CI, and release verification", () => {
    assert.equal(
      packageJson.scripts?.["test:ai-platform"],
      "npm --prefix ai-platform test && node --test backend/src/aiPlatform/*.test.js && node --test scripts/ai-platform/*.test.mjs",
    );
    assert.match(ciWorkflow, /npm run test:ai-platform/);
    assert.match(releaseWorkflow, /npm run test:ai-platform/);
  });

  it("pins the GitHub Linux Chrome executable for browser-backed frontend QA", () => {
    assert.match(ciWorkflow, /CHROME_PATH:\s*\/usr\/bin\/google-chrome/);
    assert.match(
      ciWorkflow,
      /npm --prefix outputs\/product-design-prototype run qa:local/,
    );
  });

  it("checks out complete history before the mandatory secret scan", () => {
    const checkout = ciWorkflow.indexOf("uses: actions/checkout@v4");
    const fullHistory = ciWorkflow.indexOf("fetch-depth: 0");
    const secretScan = ciWorkflow.indexOf("npm run scan:secrets");

    assert.ok(checkout >= 0, "CI must check out the repository");
    assert.ok(fullHistory > checkout, "CI checkout must include complete Git history");
    assert.ok(secretScan > fullHistory, "the secret scan must run after complete checkout");
  });

  it("makes complete Git history scanning explicit in the shared secret command", () => {
    assert.match(
      packageJson.scripts?.["scan:secrets"] ?? "",
      /project-secret-scan\.mjs --history/,
    );
  });

  it("exposes the guarded production HTTPS smoke runner", () => {
    assert.equal(
      packageJson.scripts?.["smoke:production:https"],
      "node scripts/production-https-smoke.mjs",
    );
  });

  it("exposes the guarded ASR production smoke runner without embedding a target or credential", () => {
    assert.equal(
      packageJson.scripts?.["smoke:production:asr"],
      "node scripts/asr-production-smoke.mjs",
    );
    assert.doesNotMatch(packageJson.scripts?.["smoke:production:asr"] ?? "", /password|cookie|csrf|82\.156/iu);
  });

  it("exposes repeatable WebKit acceptance for iPhone Safari equivalence", () => {
    assert.equal(
      frontendPackageJson.scripts?.["qa:webkit"],
      "node scripts/webkit-qa.mjs",
    );
    assert.equal(frontendPackageJson.devDependencies?.playwright, "1.61.1");
    assert.match(ciWorkflow, /playwright install --with-deps chromium webkit/);
    assert.match(
      ciWorkflow,
      /npm --prefix outputs\/product-design-prototype run qa:webkit/,
    );
  });
});
