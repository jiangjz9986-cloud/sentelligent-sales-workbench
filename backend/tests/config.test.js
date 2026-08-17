import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { assertWeixinSenderAllowed } from "../src/assistant/weixinEvent.js";

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
        "AMAP_WEB_SERVICE_KEY=amap-secret-from-env-file",
        "AMAP_TIMEOUT_MS=12345",
        "AUTH_ACCOUNT=jiangjz",
        "AUTH_PASSWORD=secret-from-env-file",
        "AUTH_SESSION_SECRET=session-secret-from-env-file",
        "WEIXIN_AGENT_API_TOKEN=machine-token-from-env-file",
        "WEIXIN_AGENT_BACKEND_URL=https://example.test",
        "WEIXIN_ALLOWED_SENDER_IDS=sender-from-env-file,sender-two",
        "WEIXIN_ALLOW_GROUPS=false",
        "WEIXIN_ALLOWED_GROUP_IDS=",
        "ICOST_WEBHOOK_TOKEN=icost-token-from-env-file",
        "ICOST_WEBHOOK_OWNER=jiangjz",
        "ICOST_WEBHOOK_RATE_LIMIT=18",
        "ICOST_WEBHOOK_WINDOW_MS=90000",
        "SHORTCUT_WEBHOOK_TOKEN=shortcut-token-from-env-file",
        "SHORTCUT_WEBHOOK_OWNER=jiangjz",
        "SHORTCUT_WEBHOOK_RATE_LIMIT=19",
        "SHORTCUT_WEBHOOK_WINDOW_MS=91000",
        "INVOICE_OCR_COMMAND=C:/Tools/tesseract.exe",
        "INVOICE_PDF_TEXT_COMMAND=C:/Tools/pdftotext.exe",
        "INVOICE_OCR_LANGUAGES=chi_sim+eng",
        "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS=45678",
        "HOSPITAL_TENDER_AUTO_RUN=true",
        "HOSPITAL_TENDER_INTERVAL_MINUTES=120",
        "HOSPITAL_TENDER_BATCH_SIZE=8",
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
      assert.equal(config.amapWebServiceKey, "amap-secret-from-env-file");
      assert.equal(config.amapTimeoutMs, 12345);
      assert.equal(config.authAccount, "jiangjz");
      assert.equal(config.authPassword, "secret-from-env-file");
      assert.equal(config.authSessionSecret, "session-secret-from-env-file");
      assert.equal(config.weixinAgentApiToken, "machine-token-from-env-file");
      assert.equal(config.weixinAgentBackendUrl, "https://example.test");
      assert.equal(Object.hasOwn(config, "weixinAgentSenderId"), false);
      assert.equal(Object.hasOwn(config, "weixinAgentChatType"), false);
      assert.deepEqual(config.weixinAllowedSenderIds, ["sender-from-env-file", "sender-two"]);
      assert.equal(config.weixinAllowGroups, false);
      assert.deepEqual(config.weixinAllowedGroupIds, []);
      assert.equal(config.icostWebhookToken, "icost-token-from-env-file");
      assert.equal(config.icostWebhookOwner, "jiangjz");
      assert.equal(config.icostWebhookRateLimit, 18);
      assert.equal(config.icostWebhookWindowMs, 90_000);
      assert.equal(config.shortcutWebhookToken, "shortcut-token-from-env-file");
      assert.equal(config.shortcutWebhookOwner, "jiangjz");
      assert.equal(config.shortcutWebhookRateLimit, 19);
      assert.equal(config.shortcutWebhookWindowMs, 91_000);
      assert.equal(config.invoiceOcrCommand, "C:/Tools/tesseract.exe");
      assert.equal(config.invoicePdfTextCommand, "C:/Tools/pdftotext.exe");
      assert.equal(config.invoiceOcrLanguages, "chi_sim+eng");
      assert.equal(config.invoiceTextExtractionTimeoutMs, 45_678);
      assert.equal(config.hospitalTenderAutoRun, true);
      assert.equal(config.hospitalTenderIntervalMinutes, 120);
      assert.equal(config.hospitalTenderBatchSize, 8);
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
    assert.equal(config.amapWebServiceKey, "");
    assert.equal(config.amapTimeoutMs, 10_000);
    assert.equal(config.icostWebhookToken, "");
    assert.equal(config.icostWebhookOwner, "jiangjz");
    assert.equal(config.icostWebhookRateLimit, 30);
    assert.equal(config.icostWebhookWindowMs, 300_000);
    assert.equal(config.shortcutWebhookToken, "");
    assert.equal(config.shortcutWebhookOwner, "jiangjz");
    assert.equal(config.shortcutWebhookRateLimit, 60);
    assert.equal(config.shortcutWebhookWindowMs, 300_000);
    assert.equal(config.invoiceOcrCommand, "");
    assert.equal(config.invoicePdfTextCommand, "");
    assert.equal(config.invoiceOcrLanguages, "chi_sim+eng");
    assert.equal(config.invoiceTextExtractionTimeoutMs, 30_000);
    assert.equal(config.hospitalTenderAutoRun, false);
    assert.equal(config.hospitalTenderIntervalMinutes, 60);
    assert.equal(config.hospitalTenderBatchSize, 10);
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
    const validMachineToken = Buffer.alloc(32, 6).toString("base64url");
    const validConfirmationSecret = Buffer.alloc(32, 8).toString("base64url");
    const validSettingsEncryptionKey = Buffer.alloc(32, 10).toString("base64url");
    const valid = {
      envFile,
      NODE_ENV: " Production ",
      AUTH_REQUIRED: "true",
      AUTH_ACCOUNT: " jiangjz ",
      AUTH_PASSWORD_HASH: validPasswordHash,
      AUTH_SESSION_SECRET: validSessionSecret,
      WEIXIN_AGENT_API_TOKEN: validMachineToken,
      ASSISTANT_CONFIRMATION_SECRET: validConfirmationSecret,
      SETTINGS_ENCRYPTION_KEY: validSettingsEncryptionKey,
      WEIXIN_ALLOWED_SENDER_IDS: "production-sender",
      WEIXIN_ALLOW_GROUPS: "false",
      WEIXIN_ALLOWED_GROUP_IDS: "",
      AUTH_COOKIE_SECURE: "true",
      CORS_ALLOWED_ORIGINS: "https://sales.example.test/,https://sales.example.test",
    };

    const config = loadConfig(valid);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.authAccount, "jiangjz");
    assert.equal(config.authCookieSecure, true);
    assert.equal(config.weixinAgentApiToken, validMachineToken);
    assert.equal(config.assistantConfirmationSecret, validConfirmationSecret);
    assert.deepEqual(config.weixinAllowedSenderIds, ["production-sender"]);
    assert.equal(config.weixinAllowGroups, false);
    assert.deepEqual(config.weixinAllowedGroupIds, []);
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
    assert.throws(
      () => loadConfig({ ...valid, ...Object.fromEntries([["WEIXIN_AGENT_API_TOKEN", "short"]]) }),
      /WEIXIN_AGENT_API_TOKEN/,
    );
    assert.throws(
      () => loadConfig({ ...valid, ...Object.fromEntries([["ASSISTANT_CONFIRMATION_SECRET", "short"]]) }),
      /ASSISTANT_CONFIRMATION_SECRET/,
    );
    assert.throws(() => loadConfig({ ...valid, ASSISTANT_CONFIRMATION_SECRET: validSessionSecret }), /independent|ASSISTANT_CONFIRMATION_SECRET/);
    assert.throws(() => loadConfig({ ...valid, WEIXIN_AGENT_API_TOKEN: validSessionSecret }), /independent|WEIXIN_AGENT_API_TOKEN/);
    assert.throws(
      () => loadConfig({ ...valid, SHORTCUT_WEBHOOK_TOKEN: Buffer.alloc(32, 4).toString("base64url") }),
      /SHORTCUT_WEBHOOK_TOKEN.*not allowed in production/,
    );
    const unbound = loadConfig({ ...valid, WEIXIN_ALLOWED_SENDER_IDS: "" });
    assert.deepEqual(unbound.weixinAllowedSenderIds, []);
    assert.throws(
      () => assertWeixinSenderAllowed(unbound, { senderId: "not-yet-bound", chatType: "direct" }),
      (error) => error?.code === "WEIXIN_SENDER_NOT_ALLOWED",
    );
    assert.throws(() => loadConfig({ ...valid, WEIXIN_ALLOW_GROUPS: "true" }), /WEIXIN_ALLOW_GROUPS/);
    assert.throws(() => loadConfig({ ...valid, WEIXIN_ALLOWED_GROUP_IDS: "production-group" }), /WEIXIN_ALLOWED_GROUP_IDS/);
  });

  it("allows synthetic group policy only outside production when explicitly configured", () => {
    const config = loadConfig({
      envFile: join(tmpdir(), "sent-zx-explicit-test-groups-missing.env"),
      NODE_ENV: "test",
      WEIXIN_ALLOWED_SENDER_IDS: "synthetic-sender",
      WEIXIN_ALLOW_GROUPS: "true",
      WEIXIN_ALLOWED_GROUP_IDS: "synthetic-group",
    });

    assert.deepEqual(config.weixinAllowedSenderIds, ["synthetic-sender"]);
    assert.equal(config.weixinAllowGroups, true);
    assert.deepEqual(config.weixinAllowedGroupIds, ["synthetic-group"]);
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
      assert.throws(() => loadConfig({ ...base, AMAP_TIMEOUT_MS: value }), /AMAP_TIMEOUT_MS/);
      assert.throws(() => loadConfig({ ...base, ICOST_WEBHOOK_RATE_LIMIT: value }), /ICOST_WEBHOOK_RATE_LIMIT/);
      assert.throws(() => loadConfig({ ...base, ICOST_WEBHOOK_WINDOW_MS: value }), /ICOST_WEBHOOK_WINDOW_MS/);
      assert.throws(() => loadConfig({ ...base, SHORTCUT_WEBHOOK_RATE_LIMIT: value }), /SHORTCUT_WEBHOOK_RATE_LIMIT/);
      assert.throws(() => loadConfig({ ...base, SHORTCUT_WEBHOOK_WINDOW_MS: value }), /SHORTCUT_WEBHOOK_WINDOW_MS/);
      assert.throws(() => loadConfig({ ...base, INVOICE_TEXT_EXTRACTION_TIMEOUT_MS: value }), /INVOICE_TEXT_EXTRACTION_TIMEOUT_MS/);
    }
    assert.throws(() => loadConfig({ ...base, INVOICE_OCR_LANGUAGES: "chi sim;rm" }), /INVOICE_OCR_LANGUAGES/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_AUTO_RUN: "yes" }), /HOSPITAL_TENDER_AUTO_RUN/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_INTERVAL_MINUTES: 1441 }), /HOSPITAL_TENDER_INTERVAL_MINUTES/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_BATCH_SIZE: 201 }), /HOSPITAL_TENDER_BATCH_SIZE/);
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
