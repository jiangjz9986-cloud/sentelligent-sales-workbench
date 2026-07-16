import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import * as localDev from "./local-dev.mjs";

const {
  buildBackendCommand,
  buildFrontendCommand,
  createConfig,
  stop,
  toWslPath,
} = localDev;

describe("local WSL dev orchestration", () => {
  it("maps Windows paths into WSL mount paths without shell interpolation", () => {
    assert.equal(
      toWslPath("C:\\Users\\50159\\Desktop\\森特智行\\backend"),
      "/mnt/c/Users/50159/Desktop/森特智行/backend",
    );
  });

  it("builds a backend command that runs Node directly through wsl.exe", () => {
    const config = createConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\森特智行",
      backendPort: 8897,
      frontendPort: 5184,
      databaseUrl: "/tmp/sent-zx-local-dev.sqlite",
    });
    const command = buildBackendCommand(config);

    assert.equal(command.command, "wsl.exe");
    assert.deepEqual(command.args.slice(0, 5), [
      "--cd",
      "/mnt/c/Users/50159/Desktop/森特智行/backend",
      "--exec",
      "env",
      "PORT=8897",
    ]);
    assert.ok(command.args.includes("DATABASE_URL=/tmp/sent-zx-local-dev.sqlite"));
    assert.ok(command.args.includes("CORS_ALLOWED_ORIGINS=http://127.0.0.1:5184"));
    assert.ok(command.args.includes("AUTH_COOKIE_SECURE=false"));
    assert.ok(command.args.includes("NODE_ENV=development"));
    assert.ok(command.args.includes("node"));
    assert.ok(command.args.includes("src/server.js"));
    assert.equal(command.args.includes("bash"), false);
    assert.equal(command.args.includes("-lc"), false);
  });

  it("refuses to terminate a PID whose command line does not match the recorded project fingerprint", async () => {
    assert.equal(typeof localDev.stopOwnedWindowsProcess, "function");
    const terminated = [];

    const result = await localDev.stopOwnedWindowsProcess(
      {
        pid: 424242,
        fingerprint: {
          executable: "wsl.exe",
          commandTokens: ["/mnt/c/Users/50159/Desktop/project/backend", "src/server.js"],
        },
      },
      {
        inspectProcess: async () => ({
          pid: 424242,
          executable: "node.exe",
          commandLine: "node unrelated-service.js",
        }),
        terminateProcess: async (pid) => terminated.push(pid),
      },
    );

    assert.equal(result.status, "ownership_mismatch");
    assert.deepEqual(terminated, []);
  });

  it("terminates a PID only after its executable and complete command fingerprint match", async () => {
    const terminated = [];
    const result = await localDev.stopOwnedWindowsProcess(
      {
        pid: 434343,
        fingerprint: {
          executable: "wsl.exe",
          commandTokens: ["--exec", "/mnt/c/project/backend", "src/server.js"],
        },
      },
      {
        inspectProcess: async () => ({
          pid: 434343,
          executable: "C:\\Windows\\System32\\wsl.exe",
          commandLine: 'wsl.exe --cd "/mnt/c/project/backend" --exec env node src/server.js',
        }),
        terminateProcess: async (pid) => terminated.push(pid),
      },
    );

    assert.equal(result.status, "terminated");
    assert.deepEqual(terminated, [434343]);
  });

  it("preserves Unicode project markers while inspecting a real Windows child process", {
    skip: process.platform !== "win32",
  }, async () => {
    const marker = "森特智行-ownership-check";
    const args = ["--input-type=module", "--eval", "setInterval(() => {}, 1000)", marker];
    const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
    await new Promise((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });

    try {
      const result = await localDev.stopOwnedWindowsProcess({
        pid: child.pid,
        fingerprint: localDev.createWindowsProcessFingerprint({ command: process.execPath, args }),
      });

      assert.equal(result.status, "terminated");
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("builds a frontend command wired to the selected backend URL", () => {
    const config = createConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\森特智行",
      backendPort: 8897,
      frontendPort: 5184,
      databaseUrl: "/tmp/sent-zx-local-dev.sqlite",
    });
    const command = buildFrontendCommand(config);

    assert.equal(command.command, "cmd.exe");
    assert.deepEqual(command.args, [
      "/d",
      "/s",
      "/c",
      "npm.cmd",
      "run",
      "dev",
      "--",
      "--port",
      "5184",
      "--strictPort",
    ]);
    assert.equal(command.cwd.endsWith("outputs\\product-design-prototype"), true);
    assert.equal(command.env.VITE_API_BASE_URL, "http://127.0.0.1:8897");
  });

  it("removes the runtime file after stopping recorded local processes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "sent-zx-local-dev-"));
    const config = createConfig({
      workspaceRoot,
      backendPort: 18997,
      frontendPort: 15184,
      databaseUrl: "/tmp/sent-zx-local-dev-test.sqlite",
    });
    mkdirSync(dirname(config.runtimePath), { recursive: true });
    writeFileSync(
      config.runtimePath,
      JSON.stringify({
        runtimePath: config.runtimePath,
        backendPid: 999998,
        frontendPid: 999999,
        backendUrl: config.backendUrl,
        frontendUrl: config.frontendUrl,
      }),
    );

    try {
      const result = await stop(config);

      assert.equal(result.status, "stopped");
      assert.equal(existsSync(config.runtimePath), false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("ignores a tampered runtimePath and removes only the configured runtime state", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "sent-zx-local-dev-path-"));
    const config = createConfig({ workspaceRoot });
    const protectedPath = join(workspaceRoot, "do-not-delete.txt");
    mkdirSync(dirname(config.runtimePath), { recursive: true });
    writeFileSync(protectedPath, "protected\n");
    writeFileSync(
      config.runtimePath,
      JSON.stringify({
        runtimePath: protectedPath,
        processes: {},
      }),
    );

    try {
      await stop(config);

      assert.equal(existsSync(config.runtimePath), false);
      assert.equal(existsSync(protectedPath), true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
