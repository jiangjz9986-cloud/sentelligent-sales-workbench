import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";

import {
  buildServiceEnvironment,
  createRuntimeConfig,
} from "../scripts/runtime-config.mjs";

describe("backend WSL runtime configuration", () => {
  it("uses a persistent runtime root for database, logs, state, and backups", () => {
    const config = createRuntimeConfig({
      runtimeRoot: "/tmp/sent-zx-runtime",
      port: 8897,
      host: "127.0.0.1",
    });

    assert.equal(config.runtimeRoot, "/tmp/sent-zx-runtime");
    assert.equal(config.databaseUrl, posix.join("/tmp/sent-zx-runtime", "data", "sales-workbench.sqlite"));
    assert.equal(config.logPath, posix.join("/tmp/sent-zx-runtime", "logs", "backend.log"));
    assert.equal(config.statePath, posix.join("/tmp/sent-zx-runtime", "runtime", "backend-service.json"));
    assert.equal(config.backupDir, posix.join("/tmp/sent-zx-runtime", "backups"));
    assert.equal(config.port, 8897);
    assert.equal(config.host, "127.0.0.1");
  });

  it("builds explicit server environment without exposing secrets", () => {
    const config = createRuntimeConfig({
      runtimeRoot: "/tmp/sent-zx-runtime",
      databaseUrl: "/tmp/sent-zx-custom.sqlite",
      backupPath: "/tmp/sent-zx-runtime/backups/demo.sqlite",
      label: "before-demo",
      port: 8898,
      host: "0.0.0.0",
      aiAnalysisMode: "mock",
    });

    assert.equal(config.backupPath, "/tmp/sent-zx-runtime/backups/demo.sqlite");
    assert.equal(config.label, "before-demo");

    const env = buildServiceEnvironment(config);

    assert.equal(env.PORT, "8898");
    assert.equal(env.HOST, "0.0.0.0");
    assert.equal(env.DATABASE_URL, "/tmp/sent-zx-custom.sqlite");
    assert.equal(env.AI_ANALYSIS_MODE, "mock");
    assert.equal(Object.keys(env).some((key) => /key|secret|token/i.test(key)), false);
  });

  it("does not force AI mock mode when the service did not receive an explicit override", () => {
    const config = createRuntimeConfig({
      runtimeRoot: "/tmp/sent-zx-runtime",
      port: 8899,
      host: "127.0.0.1",
      AI_ANALYSIS_MODE: undefined,
    });

    const env = buildServiceEnvironment(config);

    assert.equal(config.aiAnalysisMode, undefined);
    assert.equal("AI_ANALYSIS_MODE" in env, false);
  });
});
