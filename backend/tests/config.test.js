import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  it("parses development auth and HTTP security defaults", () => {
    const config = loadConfig({
      envFile: join(tmpdir(), "sent-zx-config-missing.env"),
      NODE_ENV: "development",
      AUTH_ACCOUNT: "jiangjz",
      AUTH_PASSWORD: "development-only-password",
      AUTH_SESSION_SECRET: "development-session-secret",
    });

    assert.equal(config.authRequired, true);
    assert.equal(config.authAccount, "jiangjz");
    assert.equal(config.authPassword, "development-only-password");
    assert.equal(config.authPasswordHash, "");
    assert.equal(config.authCookieName, "sentelligent_session");
    assert.equal(config.authCookieSecure, false);
    assert.equal(config.authCookieSameSite, "Lax");
    assert.deepEqual(config.corsAllowedOrigins, [
      "http://127.0.0.1:5184",
      "http://localhost:5184",
    ]);
    assert.equal(config.jsonBodyLimitBytes, 1_048_576);
    assert.equal(config.nodeEnv, "development");
  });

  it("requires complete explicit authentication settings in production", () => {
    const envFile = join(tmpdir(), "sent-zx-production-config-missing.env");
    const validPasswordHash = [
      "scrypt",
      "16384",
      "8",
      "1",
      Buffer.alloc(16, 7).toString("base64url"),
      Buffer.alloc(64, 9).toString("base64url"),
    ].join("$");
    const validSessionSecret = Buffer.alloc(32, 5).toString("base64url");
    const valid = {
      envFile,
      NODE_ENV: " Production ",
      AUTH_REQUIRED: "true",
      AUTH_ACCOUNT: " jiangjz ",
      AUTH_PASSWORD_HASH: validPasswordHash,
      AUTH_SESSION_SECRET: validSessionSecret,
      AUTH_COOKIE_SECURE: "true",
      CORS_ALLOWED_ORIGINS: "https://sales.example.test/,https://sales.example.test",
    };

    const config = loadConfig(valid);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.authAccount, "jiangjz");
    assert.equal(config.authCookieSecure, true);
    assert.deepEqual(config.corsAllowedOrigins, ["https://sales.example.test"]);

    for (const [field, message] of [
      ["AUTH_ACCOUNT", /AUTH_ACCOUNT/],
      ["AUTH_PASSWORD_HASH", /AUTH_PASSWORD_HASH/],
      ["AUTH_SESSION_SECRET", /AUTH_SESSION_SECRET/],
      ["AUTH_COOKIE_SECURE", /AUTH_COOKIE_SECURE/],
      ["CORS_ALLOWED_ORIGINS", /CORS_ALLOWED_ORIGINS/],
    ]) {
      assert.throws(() => loadConfig({ ...valid, [field]: "" }), message);
    }
    assert.throws(() => loadConfig({ ...valid, AUTH_ACCOUNT: "   " }), /AUTH_ACCOUNT/);
    assert.throws(() => loadConfig({ ...valid, AUTH_PASSWORD_HASH: "not-a-hash" }), /AUTH_PASSWORD_HASH/);
    assert.throws(() => loadConfig({ ...valid, AUTH_SESSION_SECRET: "too-short" }), /AUTH_SESSION_SECRET/);
    assert.throws(() => loadConfig({ ...valid, AUTH_REQUIRED: "false" }), /AUTH_REQUIRED/);
    assert.throws(() => loadConfig({ ...valid, AUTH_PASSWORD: "legacy-plaintext" }), /AUTH_PASSWORD/);
  });

  it("rejects malformed environment, boolean, origin, and body-limit values", () => {
    const envFile = join(tmpdir(), "sent-zx-strict-config-missing.env");
    const base = { envFile, NODE_ENV: "development" };

    assert.throws(() => loadConfig({ ...base, NODE_ENV: "prod" }), /NODE_ENV/);
    assert.throws(() => loadConfig({ ...base, AUTH_REQUIRED: "treu" }), /AUTH_REQUIRED/);
    assert.throws(() => loadConfig({ ...base, AUTH_COOKIE_SECURE: "yes" }), /AUTH_COOKIE_SECURE/);
    for (const value of ["*", "null", "https://user:pass@example.test", "https://example.test/path", "ftp://example.test"]) {
      assert.throws(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: value }), /CORS_ALLOWED_ORIGINS/);
    }
    for (const value of [0, -1, 1.5, "1e6", "NaN", true]) {
      assert.throws(() => loadConfig({ ...base, JSON_BODY_LIMIT_BYTES: value }), /JSON_BODY_LIMIT_BYTES/);
    }
  });

  it("emits the plaintext development-password warning once without leaking its value", () => {
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const source = `
      import { loadConfig } from ${JSON.stringify(configUrl)};
      const settings = {
        envFile: "missing-warning-test.env",
        NODE_ENV: "development",
        AUTH_REQUIRED: "true",
        AUTH_ACCOUNT: "jiangjz",
        AUTH_PASSWORD: "warning-sentinel-password",
        AUTH_SESSION_SECRET: "warning-session-secret"
      };
      loadConfig(settings);
      loadConfig(settings);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stderr.match(/development compatibility setting/g) ?? []).length, 1);
    assert.doesNotMatch(result.stderr, /warning-sentinel-password|warning-session-secret/);
  });

  it("does not emit the development-password warning in test mode", () => {
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const source = `
      import { loadConfig } from ${JSON.stringify(configUrl)};
      loadConfig({
        envFile: "missing-test-warning.env",
        NODE_ENV: "test",
        AUTH_REQUIRED: "true",
        AUTH_ACCOUNT: "jiangjz",
        AUTH_PASSWORD: "test-only-password",
        AUTH_SESSION_SECRET: "test-session-secret"
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /development compatibility setting/);
  });
});
