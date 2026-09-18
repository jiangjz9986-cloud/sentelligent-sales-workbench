import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AI_PLATFORM_SOCKET_DIRECTORY_MODE,
  AI_PLATFORM_SOCKET_MODE,
  assertAiPlatformSocket,
} from "../../shared/aiPlatformSocketTransport.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(repositoryRoot, "ai-platform/src/cli.js");

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let ready = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`AI platform CLI did not become ready: ${stdout}\n${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!ready && stdout.includes("AI platform listening on its protected local socket")) {
        ready = true;
        clearTimeout(timer);
        resolve({ stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!ready) reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`AI platform CLI exited before ready: code=${code} signal=${signal}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("serve applies the protected socket mode before announcing readiness", { skip: process.platform === "win32" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-cli-socket-")));
  const socketPath = join(root, "api.sock");
  const databasePath = join(root, "ai-platform.sqlite");
  chmodSync(root, AI_PLATFORM_SOCKET_DIRECTORY_MODE);
  const directory = lstatSync(root);
  const currentUid = process.getuid?.();
  const currentGid = process.getegid?.();
  if (currentGid !== undefined && directory.gid !== currentGid) {
    t.skip("temporary directory group cannot model the systemd service group");
    rmSync(root, { recursive: true, force: true });
    return;
  }

  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_PLATFORM_SOCKET_PATH: socketPath,
      AI_PLATFORM_DATABASE: databasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const output = await waitForListening(child);
    assert.match(output.stdout, /protected local socket/u);
    const layout = assertAiPlatformSocket(socketPath, { ownerUid: currentUid, groupGid: currentGid });
    assert.equal(layout.directory.mode & 0o777, AI_PLATFORM_SOCKET_DIRECTORY_MODE);
    assert.equal(layout.socket.mode & 0o777, AI_PLATFORM_SOCKET_MODE);
    assert.equal(layout.socket.uid, layout.directory.uid);
    assert.equal(layout.socket.gid, layout.directory.gid);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await waitForExit(child);
    rmSync(root, { recursive: true, force: true });
  }
});
