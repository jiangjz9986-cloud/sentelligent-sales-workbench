import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("backend model configuration", () => {
  it("loads model provider settings from backend env without changing the public default", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-zx-config-"));
    const envFile = join(root, ".env");
    writeFileSync(
      envFile,
      [
        "AI_ANALYSIS_MODE=model",
        "MODEL_PROVIDER=deepseek",
        "DEEPSEEK_API_KEY=secret-from-env-file",
        "DEEPSEEK_BASE_URL=https://api.deepseek.com",
        "DEEPSEEK_MODEL=deepseek-v4-flash",
        "AUTH_ACCOUNT=jiangjz",
        "AUTH_PASSWORD=secret-from-env-file",
        "AUTH_SESSION_SECRET=session-secret-from-env-file",
        "WEIXIN_AGENT_API_TOKEN=machine-token-from-env-file",
        "WEIXIN_AGENT_BACKEND_URL=https://example.test",
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadConfig({ envFile, PORT: 8788 });

      assert.equal(config.aiAnalysisMode, "model");
      assert.equal(config.modelProvider, "deepseek");
      assert.equal(config.modelBaseUrl, "https://api.deepseek.com");
      assert.equal(config.modelName, "deepseek-v4-flash");
      assert.equal(config.modelApiKey, "secret-from-env-file");
      assert.equal(config.authAccount, "jiangjz");
      assert.equal(config.authPassword, "secret-from-env-file");
      assert.equal(config.authSessionSecret, "session-secret-from-env-file");
      assert.equal(config.weixinAgentApiToken, "machine-token-from-env-file");
      assert.equal(config.weixinAgentBackendUrl, "https://example.test");
      assert.equal(config.port, 8788);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
