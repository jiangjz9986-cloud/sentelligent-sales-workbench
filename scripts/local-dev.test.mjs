import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  buildBackendCommand,
  buildFrontendCommand,
  createConfig,
  stop,
  toWslPath,
} from "./local-dev.mjs";

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
    assert.deepEqual(command.args.slice(0, 4), [
      "--cd",
      "/mnt/c/Users/50159/Desktop/森特智行/backend",
      "env",
      "PORT=8897",
    ]);
    assert.ok(command.args.includes("DATABASE_URL=/tmp/sent-zx-local-dev.sqlite"));
    assert.ok(command.args.includes("node"));
    assert.ok(command.args.includes("src/server.js"));
    assert.equal(command.args.includes("bash"), false);
    assert.equal(command.args.includes("-lc"), false);
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
});
