import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const runtimeFiles = [
  "scripts/local-dev.mjs",
  "scripts/wsl-backend.mjs",
  "scripts/wsl-stack.mjs",
  "scripts/fixed-stack-smoke.mjs",
  "backend/scripts/service.mjs",
  "outputs/product-design-prototype/scripts/integration-qa.mjs",
  "outputs/product-design-prototype/scripts/static-server.mjs",
  "docs/正式交付验收手册.md",
];

const sources = new Map(
  runtimeFiles.map((file) => [file, readFileSync(resolve(file), "utf8")]),
);

describe("Phase 1 release boundary", () => {
  it("rejects commands that can stop unrelated services", () => {
    const forbidden = [
      /pkill\s+node/i,
      /taskkill(?:\.exe)?\s+\/im\s+node/i,
      /docker\s+compose\s+down/i,
      /systemctl\s+(?:restart|stop)\s+(?!sentelligent)/i,
    ];

    for (const [file, source] of sources) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${file} contains an unsafe service-wide stop command`);
      }
    }
  });

  it("requires a verified project fingerprint before Windows or WSL PID termination", () => {
    const localDev = sources.get("scripts/local-dev.mjs");
    const integrationQa = sources.get("outputs/product-design-prototype/scripts/integration-qa.mjs");

    assert.match(localDev, /stopOwnedWindowsProcess/);
    assert.match(localDev, /fingerprint/);
    assert.match(integrationQa, /stopOwnedWindowsProcess/);
    assert.match(integrationQa, /assertOwnedWslListener/);
  });

  it("pins loopback authentication environment by runtime purpose", () => {
    const localDev = sources.get("scripts/local-dev.mjs");
    const integrationQa = sources.get("outputs/product-design-prototype/scripts/integration-qa.mjs");

    assert.match(localDev, /CORS_ALLOWED_ORIGINS/);
    assert.match(localDev, /AUTH_COOKIE_SECURE/);
    assert.match(localDev, /NODE_ENV=development/);
    assert.match(
      integrationQa,
      /AUTH_COOKIE_SECURE["']?\s*(?::|=)\s*["']?false["']?/,
    );
    assert.match(integrationQa, /NODE_ENV=test/);
    assert.match(integrationQa, /AUTH_PASSWORD_HASH["']?\s*(?::|=)/);
    assert.doesNotMatch(integrationQa, /["'`]AUTH_PASSWORD=/);
  });

  it("waits for the isolated browser profile to be released and never hides cleanup failure", () => {
    const integrationQa = sources.get("outputs/product-design-prototype/scripts/integration-qa.mjs");

    assert.match(integrationQa, /async function removeDirectoryWhenReleased/);
    assert.match(integrationQa, /await removeDirectoryWhenReleased\(profilePath\)/);
    assert.doesNotMatch(integrationQa, /rmSync\(profilePath[\s\S]{0,240}catch \{\}/);
  });

  it("runs every integration cleanup step and reports ownership or deletion failures", () => {
    const integrationQa = sources.get("outputs/product-design-prototype/scripts/integration-qa.mjs");

    assert.match(integrationQa, /cleanupErrors/);
    assert.match(integrationQa, /AggregateError/);
    assert.doesNotMatch(integrationQa, /stopWslPort\([^\n]+\.catch\(\(\) => \{\}\)/);
    assert.doesNotMatch(integrationQa, /runProcess\("wsl\.exe", \[[\s\S]{0,300}\]\)\.catch\(\(\) => \{\}\)/);
  });

  it("runs the WSL ownership check in a non-login shell", () => {
    const integrationQa = sources.get("outputs/product-design-prototype/scripts/integration-qa.mjs");

    assert.match(integrationQa, /"bash",\s*"-c",\s*script/);
    assert.doesNotMatch(integrationQa, /"bash",\s*"-lc",\s*script/);
  });
});
