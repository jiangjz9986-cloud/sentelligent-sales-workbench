import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import {
  matchesPosixProcessFingerprint,
  registerOwnedPosixChildProcess,
  stopOwnedPosixChildProcess,
  stopOwnedPosixProcess,
} from "./owned-posix-process.mjs";

const fingerprint = {
  executable: "node",
  commandTokens: ["src/server.js"],
  cwd: "/workspace/backend",
  allowExecutableWrapper: false,
};

const processInfo = {
  executable: "/opt/node/bin/node",
  commandLine: "/opt/node/bin/node src/server.js",
  commandTokens: ["/opt/node/bin/node", "src/server.js"],
  cwd: "/workspace/backend",
};

describe("owned POSIX process cleanup", () => {
  it("matches an exact executable, working directory, and complete command fingerprint", () => {
    assert.equal(matchesPosixProcessFingerprint(processInfo, fingerprint), true);
    assert.equal(
      matchesPosixProcessFingerprint(
        { ...processInfo, commandLine: "/opt/node/bin/node other.js", commandTokens: ["/opt/node/bin/node", "other.js"] },
        fingerprint,
      ),
      false,
    );
    assert.equal(
      matchesPosixProcessFingerprint({ ...processInfo, cwd: "/workspace/other" }, fingerprint),
      false,
    );
    assert.equal(
      matchesPosixProcessFingerprint({ ...processInfo, cwd: "/Workspace/backend" }, fingerprint),
      false,
    );
    assert.equal(
      matchesPosixProcessFingerprint(
        { ...processInfo, commandLine: "/opt/node/bin/node src/Server.js", commandTokens: ["/opt/node/bin/node", "src/Server.js"] },
        fingerprint,
      ),
      false,
    );
    assert.equal(
      matchesPosixProcessFingerprint(
        { ...processInfo, commandLine: "/opt/node/bin/node src/server.js.bak", commandTokens: ["/opt/node/bin/node", "src/server.js.bak"] },
        fingerprint,
      ),
      false,
    );
  });

  it("allows a declared executable wrapper only with multiple matching command tokens", () => {
    const chromeFingerprint = {
      executable: "google-chrome",
      commandTokens: ["--headless=new", "--user-data-dir=/tmp/sent-zx-profile"],
      cwd: "/workspace/frontend",
      allowExecutableWrapper: true,
    };
    const chromeProcess = {
      executable: "/opt/google/chrome/chrome",
      commandLine: "/opt/google/chrome/chrome --headless=new --user-data-dir=/tmp/sent-zx-profile",
      commandTokens: [
        "/opt/google/chrome/chrome",
        "--headless=new",
        "--user-data-dir=/tmp/sent-zx-profile",
      ],
      cwd: "/workspace/frontend",
    };

    assert.equal(matchesPosixProcessFingerprint(chromeProcess, chromeFingerprint), true);
    assert.equal(
      matchesPosixProcessFingerprint(
        chromeProcess,
        { ...chromeFingerprint, commandTokens: ["--headless=new"] },
      ),
      false,
    );
  });

  it("returns fail-closed statuses without signaling an unverified process", async () => {
    const signals = [];
    const terminateProcessGroup = async (...args) => signals.push(args);

    assert.deepEqual(await stopOwnedPosixProcess(null), { status: "not_running", pid: null });
    assert.deepEqual(await stopOwnedPosixProcess({ pid: 42 }), {
      status: "ownership_unverified",
      pid: 42,
    });
    assert.deepEqual(
      await stopOwnedPosixProcess(
        { pid: 42, fingerprint },
        { inspectProcess: async () => ({ ...processInfo, cwd: "/wrong" }), terminateProcessGroup },
      ),
      { status: "ownership_mismatch", pid: 42 },
    );
    assert.deepEqual(signals, []);
  });

  it("reports inspection failures without signaling the process group", async () => {
    const result = await stopOwnedPosixProcess(
      { pid: 42, fingerprint },
      {
        inspectProcess: async () => {
          throw new Error("proc unavailable");
        },
        terminateProcessGroup: async () => assert.fail("must not terminate after inspection failure"),
      },
    );

    assert.deepEqual(result, {
      status: "inspection_failed",
      pid: 42,
      message: "proc unavailable",
    });
  });

  it("terminates the verified process group and waits for it to disappear", async () => {
    const calls = [];
    const result = await stopOwnedPosixProcess(
      { pid: 42, fingerprint },
      {
        inspectProcess: async () => processInfo,
        terminateProcessGroup: async (pid) => calls.push(["terminate", pid]),
        waitForProcessGroupExit: async (pid) => {
          calls.push(["wait", pid]);
          return true;
        },
      },
    );

    assert.deepEqual(result, { status: "terminated", pid: 42 });
    assert.deepEqual(calls, [["terminate", 42], ["wait", 42]]);
  });

  it("fails when the verified process group remains alive", async () => {
    const result = await stopOwnedPosixProcess(
      { pid: 42, fingerprint },
      {
        inspectProcess: async () => processInfo,
        terminateProcessGroup: async () => {},
        waitForProcessGroupExit: async () => false,
      },
    );

    assert.equal(result.status, "termination_failed");
    assert.equal(result.pid, 42);
    assert.match(result.message, /did not exit/i);
  });

  it("terminates a registered detached child and closes its output pipes", async () => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "setInterval(() => {}, 1000)",
    ], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerOwnedPosixChildProcess(child, {
      detached: true,
      pgid: child.pid,
      cwd: process.cwd(),
      executable: process.execPath,
      commandTokens: ["--input-type=module", "--eval"],
    });

    const result = await stopOwnedPosixChildProcess(child, { timeoutMs: 1000 });

    assert.equal(result.status, "terminated");
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });
});
