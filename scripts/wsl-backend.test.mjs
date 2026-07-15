import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWslBackendCommand,
  createWslBackendConfig,
} from "./wsl-backend.mjs";

describe("WSL backend service wrapper", () => {
  it("routes service commands into backend/scripts/service.mjs without shell interpolation", () => {
    const config = createWslBackendConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\妫壒鏅鸿",
      command: "start",
      port: 8897,
      runtimeRoot: "/tmp/sent-zx-runtime",
      databaseUrl: "/tmp/sent-zx-runtime/data/sales-workbench.sqlite",
    });
    const command = buildWslBackendCommand(config);

    assert.equal(command.command, "wsl.exe");
    assert.deepEqual(command.args.slice(0, 4), [
      "--cd",
      "/mnt/c/Users/50159/Desktop/妫壒鏅鸿/backend",
      "env",
      "PORT=8897",
    ]);
    assert.ok(command.args.includes("SENT_ZX_RUNTIME_ROOT=/tmp/sent-zx-runtime"));
    assert.ok(command.args.includes("DATABASE_URL=/tmp/sent-zx-runtime/data/sales-workbench.sqlite"));
    assert.ok(command.args.includes("node"));
    assert.ok(command.args.includes("scripts/service.mjs"));
    assert.ok(command.args.includes("start"));
    assert.equal(command.args.includes("bash"), false);
    assert.equal(command.args.includes("-lc"), false);
  });

  it("routes database commands into backend/scripts/db-maintenance.mjs", () => {
    const config = createWslBackendConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\妫壒鏅鸿",
      command: "backup",
      runtimeRoot: "/tmp/sent-zx-runtime",
    });
    const command = buildWslBackendCommand(config);

    assert.ok(command.args.includes("scripts/db-maintenance.mjs"));
    assert.ok(command.args.includes("backup"));
  });
});
