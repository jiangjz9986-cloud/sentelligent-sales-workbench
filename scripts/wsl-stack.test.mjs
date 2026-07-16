import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFrontendBuildCommand,
  buildStaticServerCommand,
  createWslStackConfig,
} from "./wsl-stack.mjs";

describe("WSL full-stack production wrapper", () => {
  it("builds the frontend with the selected backend API base URL", () => {
    const config = createWslStackConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\妫壒鏅鸿",
      backendPort: 8921,
      frontendPort: 8091,
      runtimeRoot: "/tmp/sent-zx-fullstack-test",
    });
    const command = buildFrontendBuildCommand(config);

    assert.equal(command.command, "cmd.exe");
    assert.equal(command.cwd.endsWith("outputs\\product-design-prototype"), true);
    assert.equal(command.env.VITE_API_BASE_URL, "http://127.0.0.1:8921");
    assert.deepEqual(command.args, ["/d", "/s", "/c", "npm.cmd", "run", "build"]);
  });

  it("routes static frontend service commands into WSL without bash interpolation", () => {
    const config = createWslStackConfig({
      workspaceRoot: "C:\\Users\\50159\\Desktop\\妫壒鏅鸿",
      command: "start-frontend",
      backendPort: 8921,
      frontendPort: 8091,
      runtimeRoot: "/tmp/sent-zx-fullstack-test",
    });
    const command = buildStaticServerCommand(config, "start");

    assert.equal(command.command, "wsl.exe");
    assert.deepEqual(command.args.slice(0, 5), [
      "--cd",
      "/mnt/c/Users/50159/Desktop/妫壒鏅鸿/outputs/product-design-prototype",
      "--exec",
      "env",
      "PORT=8091",
    ]);
    assert.ok(command.args.includes("SENT_ZX_RUNTIME_ROOT=/tmp/sent-zx-fullstack-test"));
    assert.ok(command.args.includes("API_BASE_URL=http://127.0.0.1:8921"));
    assert.ok(command.args.includes("node"));
    assert.ok(command.args.includes("scripts/static-server.mjs"));
    assert.ok(command.args.includes("start"));
    assert.equal(command.args.includes("bash"), false);
    assert.equal(command.args.includes("-lc"), false);
  });
});
