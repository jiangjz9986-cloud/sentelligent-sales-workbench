import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  ASR_REQUEST_DIRECTORY_PATTERN,
  ASR_RUNTIME_DIRECTORY,
  ASR_RUNTIME_CLEANUP_REPORT_SCHEMA_VERSION,
  DEFAULT_MAX_AGE_MS,
  cleanupAsrRuntime,
  normalizeRuntimeDirectory,
  parseCleanupArguments,
  removeAsrWorkspaceAndVerify,
} from "./asr-runtime-cleanup.mjs";

const scriptPath = fileURLToPath(new URL("./asr-runtime-cleanup.mjs", import.meta.url));
const roots = [];

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "sent-zx-asr-cleanup-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

async function makeRequest(root, name = "request-abcdef") {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, "audio.bin"), Buffer.from("fixture"), { mode: 0o600 });
  return directory;
}

async function listNames(root) {
  return (await readdir(root)).sort();
}

function runCli(args, { env = {} } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});

describe("ASR runtime cleanup argument contract", () => {
  it("exposes one root package command for the versioned cleanup utility", async () => {
    const packageJson = JSON.parse(await readFile(
      resolve(fileURLToPath(new URL("..", import.meta.url)), "package.json"),
      "utf8",
    ));
    assert.equal(packageJson.scripts?.["asr:cleanup"], "node scripts/asr-runtime-cleanup.mjs");
  });

  it("pins the production runtime default and accepts only normalized absolute paths", () => {
    assert.equal(ASR_RUNTIME_DIRECTORY, "/run/sentelligent-asr");
    assert.equal(DEFAULT_MAX_AGE_MS, 600_000);
    assert.equal(ASR_RUNTIME_CLEANUP_REPORT_SCHEMA_VERSION, 1);
    assert.equal(ASR_REQUEST_DIRECTORY_PATTERN.test("request-abcdef"), true);
    assert.equal(ASR_REQUEST_DIRECTORY_PATTERN.test("request-a"), false);
    assert.equal(normalizeRuntimeDirectory("/tmp/asr-runtime"), "/tmp/asr-runtime");
    for (const value of ["/", "relative", "/tmp/asr-runtime/", "/tmp/../asr-runtime", "/tmp/asr\0runtime"]) {
      assert.throws(() => normalizeRuntimeDirectory(value), /runtime directory/);
    }
  });

  it("parses long and short option spellings without invoking a shell", () => {
    assert.deepEqual(
      parseCleanupArguments([
        "--runtime-dir", "/tmp/asr-runtime",
        "--mode=periodic",
        "--max-age-ms=42",
        "--json",
      ]),
      {
        runtimeDirectory: "/tmp/asr-runtime",
        mode: "periodic",
        maxAgeMs: 42,
        json: true,
        help: false,
      },
    );
    assert.equal(parseCleanupArguments(["--help"]).help, true);
    assert.throws(() => parseCleanupArguments(["--mode", "invalid"]), /mode must be/);
    assert.throws(() => parseCleanupArguments(["--root"]), /requires a value/);
    assert.throws(() => parseCleanupArguments(["--unknown"]), /unknown option/);
  });
});

describe("ASR runtime cleanup sweep", () => {
  it("startup removes every protected request workspace and reports a clean root", async () => {
    const root = await makeRoot();
    const first = await makeRequest(root, "request-abcdef");
    const second = await makeRequest(root, "request-XYZ_123");

    const report = await cleanupAsrRuntime({ runtimeDirectory: root });

    assert.equal(report.status, "clean");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ready, true);
    assert.equal(report.scannedCount, 2);
    assert.equal(report.requestDirectoryCount, 2);
    assert.equal(report.staleCount, 2);
    assert.equal(report.removedCount, 2);
    assert.equal(report.retainedCount, 0);
    assert.equal(report.anomalyCount, 0);
    assert.equal(report.residualEntryCount, 0);
    assert.equal(report.residualDirectoryCount, 0);
    assert.deepEqual(await listNames(root), []);
    assert.equal((await lstat(first).catch((error) => error.code)), "ENOENT");
    assert.equal((await lstat(second).catch((error) => error.code)), "ENOENT");
  });

  it("periodic mode removes only entries older than the threshold", async () => {
    const root = await makeRoot();
    const oldPath = await makeRequest(root, "request-old123");
    const freshPath = await makeRequest(root, "request-fresh1");
    const now = 10_000_000;
    await utimes(oldPath, new Date(now - 601_000), new Date(now - 601_000));
    await utimes(freshPath, new Date(now - 599_000), new Date(now - 599_000));

    const report = await cleanupAsrRuntime({
      runtimeDirectory: root,
      mode: "periodic",
      maxAgeMs: 600_000,
      now: () => now,
    });

    assert.equal(report.status, "clean");
    assert.equal(report.staleCount, 1);
    assert.equal(report.removedCount, 1);
    assert.equal(report.retainedCount, 1);
    assert.deepEqual(await listNames(root), ["request-fresh1"]);
    assert.equal((await lstat(oldPath).catch((error) => error.code)), "ENOENT");
  });

  it("leaves non-request entries untouched and marks readiness degraded", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "README"), "operator note", { mode: 0o600 });
    await makeRequest(root);

    const report = await cleanupAsrRuntime({ runtimeDirectory: root });

    assert.equal(report.status, "degraded");
    assert.equal(report.ready, false);
    assert.equal(report.anomalyCount, 1);
    assert.equal(report.residualEntryCount, 1);
    assert.equal(report.residualDirectoryCount, 0);
    assert.deepEqual(report.residualNames, ["README"]);
    assert.deepEqual(await listNames(root), ["README"]);
  });

  it("does not delete a request symlink or a request with a nested symlink", async () => {
    const root = await makeRoot();
    const target = await makeRequest(root, "request-target");
    const nested = await makeRequest(root, "request-nested");
    await symlink(target, join(root, "request-link1"));
    await symlink(target, join(nested, "escape"));

    const report = await cleanupAsrRuntime({ runtimeDirectory: root });

    assert.equal(report.status, "degraded");
    assert.equal(report.anomalyCount, 2);
    assert.equal(report.removedCount, 1);
    assert.equal(report.residualEntryCount, 2);
    assert.equal(report.residualDirectoryCount, 1);
    assert.deepEqual(report.residualNames, ["request-link1", "request-nested"]);
    assert.deepEqual(await listNames(root), ["request-link1", "request-nested"]);
    assert.equal((await lstat(target).catch((error) => error.code)), "ENOENT");
  });

  it("fails closed for an unsafe root and never creates it", async () => {
    const parent = await makeRoot();
    const missing = join(parent, "missing");
    await assert.rejects(
      cleanupAsrRuntime({ runtimeDirectory: missing }),
      (error) => error.code === "ASR_RUNTIME_MISSING",
    );
    assert.equal((await lstat(missing).catch((error) => error.code)), "ENOENT");

    const symlinkRoot = join(parent, "link-root");
    await symlink(parent, symlinkRoot);
    await assert.rejects(
      cleanupAsrRuntime({ runtimeDirectory: symlinkRoot }),
      (error) => error.code === "ASR_RUNTIME_UNSAFE",
    );
  });

  it("treats owner and mode mismatches as anomalies without removing the workspace", async () => {
    const root = await makeRoot();
    const wrongOwner = await makeRequest(root, "request-owner1");
    const wrongMode = await makeRequest(root, "request-mode12");
    await chmod(wrongMode, 0o755);
    const uid = process.getuid?.() ?? 0;

    const fsImpl = {
      lstat: async (path) => {
        const stat = await lstat(path);
        return path === wrongOwner ? { ...stat, uid: uid + 1 } : stat;
      },
      readdir,
      rm,
    };
    const report = await cleanupAsrRuntime({ runtimeDirectory: root, currentUid: uid, fsImpl });
    assert.equal(report.status, "degraded");
    assert.equal(report.removedCount, 0);
    assert.equal(report.anomalyCount, 2);
    assert.deepEqual(await listNames(root), ["request-mode12", "request-owner1"]);
    assert.ok(await lstat(wrongOwner));
  });

  it("retries a transient remove failure and verifies the final ENOENT", async () => {
    const root = await makeRoot();
    const workspace = await makeRequest(root);
    let removeCalls = 0;
    const fsImpl = {
      lstat,
      readdir,
      rm: async (...args) => {
        removeCalls += 1;
        if (removeCalls === 1) {
          const error = new Error("transient fixture failure");
          error.code = "EAGAIN";
          throw error;
        }
        return rm(...args);
      },
    };
    const report = await cleanupAsrRuntime({
      runtimeDirectory: root,
      fsImpl,
      cleanupAttempts: [0, 1],
      sleepImpl: async () => {},
    });
    assert.equal(report.status, "clean");
    assert.equal(report.removedCount, 1);
    assert.equal(removeCalls, 2);
    assert.equal((await lstat(workspace).catch((error) => error.code)), "ENOENT");
  });
});

describe("ASR runtime cleanup CLI", () => {
  it("returns a JSON clean result and exit 0 for a temporary root", async () => {
    const root = await makeRoot();
    await makeRequest(root);

    const result = await runCli(["--root", root, "--mode", "startup"]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "clean");
    assert.equal(report.removedCount, 1);
    assert.deepEqual(await listNames(root), []);
  });

  it("returns exit 1 and a degraded JSON result for an anomaly", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "unexpected"), "fixture", { mode: 0o600 });

    const result = await runCli(["--root=" + root]);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "degraded");
    assert.equal(report.anomalyCount, 1);
  });

  it("returns usage exit 64 for invalid arguments and does not touch the filesystem", async () => {
    const result = await runCli(["--mode", "invalid"]);
    assert.equal(result.code, 64);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.status, "error");
    assert.equal(payload.code, "USAGE");
  });
});
