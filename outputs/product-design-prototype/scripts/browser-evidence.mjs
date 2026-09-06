import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Historical production reference only. Tested HEAD is always read from Git.
export const PRODUCTION_BASELINE_COMMIT = "23695628a8bcaf6012c0548774a91fe5726bf3cc";
const FRONTEND = "outputs/product-design-prototype";
const EVIDENCE_RELEASE = "v0120";
const SOURCE_PATHS = [
  "package.json", "backend/package.json", "backend/package-lock.json",
  "backend/src", "backend/vendor", "shared",
  ...["package.json", "package-lock.json", "index.html", "vite.config.mjs", "src", "public", "scripts"]
    .map((path) => `${FRONTEND}/${path}`),
];
const EXCLUDED_NAMES = new Set(["node_modules", ".git", ".runtime", "dist", "build", "coverage", ".DS_Store"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8Order = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
}

function inventory(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => utf8Order(a, b)));
  // Same path/checksum index format as scripts/release-package.mjs.
  return {
    algorithm: "sha256",
    files: sorted,
    treeSha256: hash(Object.entries(sorted).map(([path, checksum]) => `${checksum}  ${path}\n`).join("")),
  };
}

function readTree(root, paths, { excludeLocalFiles = false } = {}) {
  const contents = new Map();
  function visit(path) {
    const fullPath = resolve(root, path);
    const metadata = lstatSync(fullPath);
    assert.ok(!metadata.isSymbolicLink(), `Evidence inputs must not be symlinks: ${path}`);
    if (metadata.isDirectory()) {
      for (const name of readdirSync(fullPath).sort(utf8Order)) {
        if (excludeLocalFiles && (EXCLUDED_NAMES.has(name) || name === ".env" || name.startsWith(".env."))) continue;
        visit(`${path}/${name}`);
      }
    } else {
      assert.ok(metadata.isFile(), `Evidence input is not a regular file: ${path}`);
      contents.set(path.replace(/^\.\//u, ""), readFileSync(fullPath));
    }
  }
  for (const path of paths) if (existsSync(resolve(root, path))) visit(path);
  return contents;
}

export function captureEvidenceSource(workspaceRoot) {
  const head = git(workspaceRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  const status = git(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const contents = readTree(workspaceRoot, SOURCE_PATHS, { excludeLocalFiles: true });
  const ignored = git(workspaceRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...SOURCE_PATHS])
    .split("\0").filter((path) => contents.has(path));
  const clean = status === "";
  return {
    contents,
    git: { head, clean, statusSha256: hash(status) },
    source: {
      ...inventory(Object.fromEntries([...contents].map(([path, bytes]) => [path, hash(bytes)]))),
      matchesHead: clean && ignored.length === 0,
      ignoredInputCount: ignored.length,
      scope: SOURCE_PATHS,
      excludes: ["dotenv files", "node_modules", "runtime data", "existing dist"],
    },
  };
}

function assertSourceUnchanged(initial, current) {
  assert.deepEqual(current.git, initial.git, "Git HEAD or worktree status changed during evidence run");
  assert.equal(current.source.treeSha256, initial.source.treeSha256, "Source changed during evidence run");
}

function buildEnvironment() {
  const environment = { NODE_ENV: "production", PATH: dirname(process.execPath) };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (key) environment[name] = process.env[key];
  }
  return environment;
}

function hashDist(distPath) {
  const files = Object.fromEntries([...readTree(distPath, ["."])].map(([path, bytes]) => [path, hash(bytes)]));
  assert.ok(files["index.html"], "Fresh evidence build did not produce index.html");
  return inventory(files);
}

export function prepareBrowserEvidence({ workspaceRoot, suite, outputRoot }) {
  assert.match(suite, /^[a-z0-9-]+$/u);
  // Keep paths lexical here so macOS /var -> /private/var aliases cannot make
  // an in-worktree output look like an external directory.
  workspaceRoot = resolve(workspaceRoot);
  const root = resolve(outputRoot || resolve(workspaceRoot, ".runtime", "browser-evidence", EVIDENCE_RELEASE, suite));
  const localPath = relative(workspaceRoot, root);
  if (localPath !== ".." && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath)) {
    const standardPath = `.runtime/browser-evidence/${EVIDENCE_RELEASE}/${suite}`;
    assert.equal(localPath, standardPath, "Evidence output must be the standard ignored run directory or outside the worktree");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const initial = captureEvidenceSource(workspaceRoot);
  const startedAt = new Date().toISOString();
  const state = initial.source.matchesHead ? "clean" : "dirty-snapshot";
  const directory = mkdtempSync(resolve(root, `${startedAt.replace(/[:.]/gu, "-")}-${initial.git.head.slice(0, 12)}-${state}-`));
  const runId = directory.split(sep).at(-1);
  const reportPath = resolve(directory, `${suite}-report.json`);
  const distPath = resolve(directory, "dist");
  const snapshotRoot = resolve(directory, "build-source");
  const snapshotApp = resolve(snapshotRoot, FRONTEND);
  const identity = {
    schemaVersion: 1, suite, runId, startedAt,
    productionBaselineCommit: PRODUCTION_BASELINE_COMMIT,
    git: initial.git,
    source: initial.source,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    privacy: { fixtures: "synthetic-only", database: "temporary-sqlite", model: "mock", productionAccess: false },
    build: { status: "building", strategy: "fresh-isolated-source-snapshot", startedAt: new Date().toISOString() },
  };
  const writeReport = (report) => writeFileSync(reportPath, `${JSON.stringify({
    ...report, identity, reportPath, completedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  try {
    for (const [path, bytes] of initial.contents) {
      const target = resolve(snapshotRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const packageJson = JSON.parse(readFileSync(resolve(snapshotApp, "package.json"), "utf8"));
    assert.equal(packageJson.scripts.build, "vite build", "Evidence build must use the project's controlled vite build command");
    const dependencies = realpathSync(resolve(workspaceRoot, FRONTEND, "node_modules"));
    symlinkSync(dependencies, resolve(snapshotApp, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const environment = buildEnvironment();
    identity.build = {
      ...identity.build,
      sourceTreeSha256: initial.source.treeSha256,
      command: "node node_modules/vite/bin/vite.js build --outDir <run>/dist --emptyOutDir",
      environment: { policy: "allowlist-no-dotenv", allowedNames: Object.keys(environment).sort() },
      dependencies: {
        policy: "reuse-local-node_modules-not-a-release-reproduction",
        viteVersion: JSON.parse(readFileSync(resolve(dependencies, "vite/package.json"), "utf8")).version,
        playwrightVersion: JSON.parse(readFileSync(resolve(dependencies, "playwright/package.json"), "utf8")).version,
        lockfileSha256: initial.source.files[`${FRONTEND}/package-lock.json`],
      },
    };
    execFileSync(process.execPath, [resolve(snapshotApp, "node_modules/vite/bin/vite.js"), "build", "--outDir", distPath, "--emptyOutDir"], {
      cwd: snapshotApp, env: environment, encoding: "utf8", timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    assertSourceUnchanged(initial, captureEvidenceSource(workspaceRoot));
    const snapshot = captureSnapshotHashes(snapshotRoot);
    assert.equal(snapshot.treeSha256, initial.source.treeSha256, "Build mutated its source snapshot");
    identity.build = { ...identity.build, status: "built", completedAt: new Date().toISOString(), output: hashDist(distPath) };
    writeReport({ status: "running" });
  } catch (error) {
    identity.build.status = "failed";
    writeReport({ status: "failed", stage: "build-identity", error: { name: error.name, message: error.message } });
    throw error;
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }

  return {
    directory, distPath, reportPath, identity,
    finish(report) {
      try {
        const current = captureEvidenceSource(workspaceRoot);
        identity.gitAtCompletion = current.git;
        identity.sourceTreeSha256AtCompletion = current.source.treeSha256;
        identity.build.treeSha256AtCompletion = hashDist(distPath).treeSha256;
        assertSourceUnchanged(initial, current);
        assert.equal(identity.build.treeSha256AtCompletion, identity.build.output.treeSha256, "Tested dist changed during evidence run");
        identity.verifiedAt = new Date().toISOString();
        writeReport(report);
      } catch (error) {
        writeReport({ ...report, status: "failed", stage: "final-identity", error: { name: error.name, message: error.message } });
        throw error;
      }
    },
  };
}

function captureSnapshotHashes(root) {
  return inventory(Object.fromEntries([...readTree(root, SOURCE_PATHS, { excludeLocalFiles: true })]
    .map(([path, bytes]) => [path, hash(bytes)])));
}

export async function browserContextIdentity(page, browser, engine) {
  return {
    engine, version: browser.version(), capturedAt: new Date().toISOString(),
    ...await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio, touch: navigator.maxTouchPoints > 0,
    })),
  };
}

export async function restrictEvidenceNetwork(context, ...allowedOriginValues) {
  assert.ok(allowedOriginValues.length > 0, "Evidence must specify at least one allowed origin");
  const allowedOrigins = new Set(allowedOriginValues.map((originValue) => {
    const origin = new URL(originValue);
    assert.equal(origin.hostname, "127.0.0.1", "Evidence must use loopback fixture servers");
    return origin.origin;
  }));
  const blocked = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (allowedOrigins.has(url.origin) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    blocked.push(url.origin);
    return route.abort("blockedbyclient");
  });
  return blocked;
}
