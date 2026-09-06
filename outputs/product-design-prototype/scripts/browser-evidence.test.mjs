import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

import { prepareBrowserEvidence, restrictEvidenceNetwork } from "./browser-evidence.mjs";

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
}

function outputDirectory(name) {
  return mkdtempSync(resolve(tmpdir(), `sentelligent-browser-evidence-${name}-`));
}

function createFixture({ mutateDuringBuild = false, failDuringBuild = false } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "sentelligent-browser-evidence-test-"));
  const app = resolve(root, "outputs/product-design-prototype");
  mkdirSync(resolve(app, "node_modules"), { recursive: true });
  const vite = resolve(app, "node_modules/vite/bin");
  mkdirSync(resolve(app, "src"), { recursive: true });
  mkdirSync(vite, { recursive: true });
  writeFileSync(resolve(root, "package.json"), "{\"private\":true}\n");
  writeFileSync(resolve(app, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  writeFileSync(resolve(app, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(resolve(app, "index.html"), "<div id=app></div>\n");
  writeFileSync(resolve(app, "src/main.js"), "export default true;\n");
  writeFileSync(resolve(app, "vite.config.mjs"), "export default {};\n");
  writeFileSync(resolve(app, "node_modules/vite/package.json"), "{\"version\":\"test-vite\"}\n");
  mkdirSync(resolve(app, "node_modules/playwright"), { recursive: true });
  writeFileSync(resolve(app, "node_modules/playwright/package.json"), "{\"version\":\"test-playwright\"}\n");
  writeFileSync(resolve(vite, "vite.js"), `
    import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { dirname, resolve } from "node:path";
    const outIndex = process.argv[process.argv.indexOf("--outDir") + 1];
    if (existsSync(resolve("src", "fail-build"))) throw new Error("synthetic build failure");
    if (existsSync(resolve("src", "mutate-during-build"))) appendFileSync(resolve("src", "main.js"), "changed during build\\n");
    mkdirSync(outIndex, { recursive: true });
    writeFileSync(resolve(outIndex, "index.html"), readFileSync("index.html"));
  `);
  if (mutateDuringBuild) writeFileSync(resolve(app, "src/mutate-during-build"), "1\n");
  if (failDuringBuild) writeFileSync(resolve(app, "src/fail-build"), "1\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "qa@example.invalid");
  git(root, "config", "user.name", "QA Fixture");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return { root, app };
}

test("builds a fresh isolated dist and records the actual clean HEAD identity", () => {
  const fixture = createFixture();
  const outputRoot = outputDirectory("clean");
  try {
    const evidence = prepareBrowserEvidence({
      workspaceRoot: fixture.root,
      suite: "identity-test",
      outputRoot,
    });
    assert.match(evidence.identity.git.head, /^[a-f0-9]{40}$/u);
    assert.equal(evidence.identity.git.clean, true);
    assert.equal(evidence.identity.source.matchesHead, true);
    assert.equal(evidence.identity.build.status, "built");
    assert.equal(evidence.identity.build.strategy, "fresh-isolated-source-snapshot");
    assert.equal(existsSync(resolve(evidence.distPath, "index.html")), true);
    assert.match(evidence.identity.build.output.treeSha256, /^[a-f0-9]{64}$/u);
    evidence.finish({ status: "passed" });
    const report = JSON.parse(readFileSync(evidence.reportPath, "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.identity.verifiedAt !== undefined, true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("keeps dirty-tree runs explicit while still binding the source snapshot to the run", () => {
  const fixture = createFixture();
  const outputRoot = outputDirectory("dirty");
  try {
    writeFileSync(resolve(fixture.app, "src/main.js"), "export default false;\n");
    const evidence = prepareBrowserEvidence({
      workspaceRoot: fixture.root,
      suite: "dirty-test",
      outputRoot,
    });
    assert.equal(evidence.identity.git.clean, false);
    assert.equal(evidence.identity.source.matchesHead, false);
    evidence.finish({ status: "passed" });
    const report = JSON.parse(readFileSync(evidence.reportPath, "utf8"));
    assert.equal(report.identity.git.clean, false);
    assert.equal(report.identity.gitAtCompletion.clean, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when the source changes during the isolated build", () => {
  const fixture = createFixture({ mutateDuringBuild: true });
  const outputRoot = outputDirectory("mutation");
  try {
    assert.throws(
      () => prepareBrowserEvidence({
        workspaceRoot: fixture.root,
        suite: "mutation-test",
        outputRoot,
      }),
      /Build mutated its source snapshot|Source changed during evidence run/u,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when the controlled build fails instead of using an old dist", () => {
  const fixture = createFixture({ failDuringBuild: true });
  const outputRoot = outputDirectory("failed-build");
  try {
    assert.throws(
      () => prepareBrowserEvidence({
        workspaceRoot: fixture.root,
        suite: "failed-build-test",
        outputRoot,
      }),
      /Frontend build|synthetic build failure/u,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not allow evidence output to overwrite an unignored worktree path", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => prepareBrowserEvidence({
        workspaceRoot: fixture.root,
        suite: "output-collision-test",
        outputRoot: resolve(fixture.root, "evidence"),
      }),
      /standard ignored run directory or outside the worktree/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("allows every explicitly listed loopback origin and blocks all other network traffic", async () => {
  let routeHandler;
  const continued = [];
  const aborted = [];
  const context = {
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      routeHandler = handler;
    },
  };
  const blocked = await restrictEvidenceNetwork(
    context,
    "http://127.0.0.1:3100/",
    "http://127.0.0.1:3200",
  );
  const routeFor = (url) => ({
    request: () => ({ url: () => url }),
    continue: () => continued.push(url),
    abort: (reason) => aborted.push({ url, reason }),
  });

  await routeHandler(routeFor("http://127.0.0.1:3100/assets/app.js"));
  await routeHandler(routeFor("http://127.0.0.1:3200/api/session"));
  await routeHandler(routeFor("data:text/plain,fixture"));
  await routeHandler(routeFor("https://example.com/should-be-blocked"));

  assert.deepEqual(continued, [
    "http://127.0.0.1:3100/assets/app.js",
    "http://127.0.0.1:3200/api/session",
    "data:text/plain,fixture",
  ]);
  assert.deepEqual(aborted, [{
    url: "https://example.com/should-be-blocked",
    reason: "blockedbyclient",
  }]);
  assert.deepEqual(blocked, ["https://example.com"]);
});
