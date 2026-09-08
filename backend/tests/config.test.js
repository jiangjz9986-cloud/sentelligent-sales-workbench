import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { assertWeixinGroupAllowed } from "../src/assistant/weixinEvent.js";

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
        "MODEL_VISION_NAME=deepseek-v4-flash-vision-exp",
        "AMAP_WEB_SERVICE_KEY=amap-secret-from-env-file",
        "AMAP_TIMEOUT_MS=12345",
        "AUTH_ACCOUNT=jiangjz",
        "AUTH_PASSWORD=secret-from-env-file",
        "AUTH_SESSION_SECRET=session-secret-from-env-file",
        "WEIXIN_AGENT_API_TOKEN=machine-token-from-env-file",
        "WEIXIN_AGENT_OWNER=jiangjz",
        "WEIXIN_AGENT_BACKEND_URL=https://example.test",
        "WEIXIN_ALLOWED_SENDER_IDS=sender-from-env-file,sender-two",
        "WEIXIN_ALLOW_GROUPS=false",
        "WEIXIN_ALLOWED_GROUP_IDS=",
        "WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED=true",
        "WEIXIN_BOOKKEEPING_OWNER=jiangjz",
        "WEIXIN_BOOKKEEPING_SENDER_ID=sender-from-env-file",
        "INVOICE_OCR_COMMAND=C:/Tools/tesseract.exe",
        "INVOICE_PDF_TEXT_COMMAND=C:/Tools/pdftotext.exe",
        "INVOICE_PDF_IMAGE_COMMAND=C:/Tools/pdftoppm.exe",
        "INVOICE_OCR_LANGUAGES=chi_sim+eng",
        "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS=45678",
        "HOSPITAL_TENDER_AUTO_RUN=true",
        "HOSPITAL_TENDER_INTERVAL_MINUTES=120",
        "HOSPITAL_TENDER_BATCH_SIZE=8",
        "PROACTIVE_ASSISTANT_AUTO_RUN=true",
        "PROACTIVE_ASSISTANT_INTERVAL_MINUTES=15",
        "PROACTIVE_ASSISTANT_BATCH_SIZE=25",
        "PROACTIVE_ASSISTANT_LEASE_MS=60000",
        "PROACTIVE_ASSISTANT_RETRY_BASE_MS=5000",
        "PROACTIVE_ASSISTANT_POLL_MS=10000",
        "PROACTIVE_ASSISTANT_MODEL_CONCURRENCY=4",
        "PROACTIVE_ASSISTANT_MODEL_RETRY_LIMIT=2",
        "PROACTIVE_NOTIFICATION_AUTO_RUN=true",
        "PROACTIVE_NOTIFICATION_POLL_MS=20000",
        "PROACTIVE_NOTIFICATION_QUIET_START=23:00",
        "PROACTIVE_NOTIFICATION_QUIET_END=07:00",
        "PROACTIVE_NOTIFICATION_HOURLY_LIMIT=4",
        "PROACTIVE_NOTIFICATION_DAILY_LIMIT=20",
        "HOSPITAL_TENDER_PUSHPLUS_TOKEN=fixture-pushplus-token",
        "INVOICE_ESCALATION_AUTO_RUN=true",
        "INVOICE_ESCALATION_POLL_MS=45000",
      ].join("\n"),
      "utf8",
    );

    try {
      const config = loadConfig({ envFile, PORT: 8788 });

      assert.equal(config.aiAnalysisMode, "model");
      assert.equal(config.modelProvider, "deepseek");
      assert.equal(config.modelBaseUrl, "https://api.deepseek.com");
      assert.equal(config.modelName, "deepseek-v4-flash");
      assert.equal(config.modelVisionName, "deepseek-v4-flash-vision-exp");
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
      assert.equal(config.weixinBookkeepingConfirmationEnabled, true);
      assert.equal(config.weixinBookkeepingOwner, "jiangjz");
      assert.equal(config.weixinBookkeepingSenderId, "sender-from-env-file");
      assert.equal(config.invoiceOcrCommand, "C:/Tools/tesseract.exe");
      assert.equal(config.invoicePdfTextCommand, "C:/Tools/pdftotext.exe");
      assert.equal(config.invoicePdfImageCommand, "C:/Tools/pdftoppm.exe");
      assert.equal(config.invoiceOcrLanguages, "chi_sim+eng");
      assert.equal(config.invoiceTextExtractionTimeoutMs, 45_678);
      assert.equal(config.hospitalTenderAutoRun, true);
      assert.equal(config.hospitalTenderIntervalMinutes, 120);
      assert.equal(config.hospitalTenderBatchSize, 8);
      assert.equal(config.proactiveAssistantAutoRun, true);
      assert.equal(config.proactiveAssistantIntervalMinutes, 15);
      assert.equal(config.proactiveAssistantIntervalSeconds, 900);
      assert.equal(config.proactiveAssistantBatchSize, 25);
      assert.equal(config.proactiveAssistantLeaseMs, 60_000);
      assert.equal(config.proactiveAssistantRetryBaseMs, 5_000);
      assert.equal(config.proactiveAssistantPollMs, 10_000);
      assert.equal(config.proactiveAssistantModelConcurrency, 4);
      assert.equal(config.proactiveAssistantModelRetryLimit, 2);
      assert.equal(config.proactiveNotificationAutoRun, true);
      assert.equal(config.proactiveNotificationPollMs, 20_000);
      assert.deepEqual(config.proactiveNotificationQuietStart, { hour: 23, minute: 0 });
      assert.deepEqual(config.proactiveNotificationQuietEnd, { hour: 7, minute: 0 });
      assert.equal(config.proactiveNotificationHourlyLimit, 4);
      assert.equal(config.proactiveNotificationDailyLimit, 20);
      assert.equal(Object.hasOwn(config, "hospitalTenderPushplusToken"), false);
      assert.equal(config.invoiceEscalationAutoRun, true);
      assert.equal(config.invoiceEscalationPollMs, 45_000);
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
    assert.equal(config.weixinBookkeepingConfirmationEnabled, false);
    assert.equal(config.weixinBookkeepingOwner, "jiangjz");
    assert.equal(config.weixinBookkeepingSenderId, "");
    assert.equal(config.invoiceOcrCommand, "");
    assert.equal(config.invoicePdfTextCommand, "");
    assert.equal(config.invoicePdfImageCommand, "pdftoppm");
    assert.equal(config.modelVisionName, "deepseek-v4-flash-vision-exp");
    assert.equal(config.invoiceOcrLanguages, "chi_sim+eng");
    assert.equal(config.invoiceTextExtractionTimeoutMs, 30_000);
    assert.equal(config.hospitalTenderAutoRun, false);
    assert.equal(config.hospitalTenderIntervalMinutes, 60);
    assert.equal(config.hospitalTenderBatchSize, 10);
    assert.equal(config.proactiveAssistantAutoRun, false);
    assert.equal(config.proactiveAssistantIntervalMinutes, 5);
    assert.equal(config.proactiveAssistantIntervalSeconds, 300);
    assert.equal(config.proactiveAssistantBatchSize, 50);
    assert.equal(config.proactiveAssistantLeaseMs, 120_000);
    assert.equal(config.proactiveAssistantRetryBaseMs, 30_000);
    assert.equal(config.proactiveAssistantPollMs, 30_000);
    assert.equal(config.proactiveAssistantModelConcurrency, 2);
    assert.equal(config.proactiveAssistantModelRetryLimit, 1);
    assert.equal(config.proactiveNotificationAutoRun, false);
    assert.equal(config.proactiveNotificationPollMs, 60_000);
    assert.deepEqual(config.proactiveNotificationQuietStart, { hour: 22, minute: 0 });
    assert.deepEqual(config.proactiveNotificationQuietEnd, { hour: 8, minute: 0 });
    assert.equal(config.proactiveNotificationHourlyLimit, 3);
    assert.equal(config.proactiveNotificationDailyLimit, 12);
    assert.equal(Object.hasOwn(config, "hospitalTenderPushplusToken"), false);
    assert.equal(config.invoiceEscalationAutoRun, false);
    assert.equal(config.invoiceEscalationPollMs, 60_000);
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
      WEIXIN_AGENT_OWNER: "jiangjz",
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
    assert.equal(config.invoiceEscalationAutoRun, false);
    assert.equal(config.invoiceEscalationPollMs, 60_000);
    assert.equal(config.proactiveAssistantAutoRun, true);
    assert.equal(config.proactiveAssistantIntervalMinutes, 5);
    assert.equal(config.proactiveAssistantIntervalSeconds, 300);
    assert.equal(config.proactiveAssistantBatchSize, 50);
    assert.equal(config.proactiveAssistantLeaseMs, 120_000);
    assert.equal(config.proactiveAssistantRetryBaseMs, 30_000);
    assert.equal(config.proactiveAssistantPollMs, 30_000);
    assert.equal(config.proactiveAssistantModelConcurrency, 2);
    assert.equal(config.proactiveAssistantModelRetryLimit, 1);

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
    // v0.9.3：sender 白名单退役为 bootstrap 种子键（运行时 sender 过滤由 weixin_bindings
    // 表承担，入口对未绑定 sender 固定拒答）；群闸语义原样保留。
    const unbound = loadConfig({ ...valid, WEIXIN_ALLOWED_SENDER_IDS: "" });
    assert.deepEqual(unbound.weixinAllowedSenderIds, []);
    assert.throws(
      () => assertWeixinGroupAllowed(unbound, { senderId: "any-sender", chatType: "group", groupId: "g-1" }),
      (error) => error?.code === "WEIXIN_GROUP_NOT_ALLOWED",
    );
    // 三条 BOOKKEEPING 生产硬校验退役：开启确认面但 env 键缺失/不一致不再拒启动。
    const bindingTableEra = loadConfig({
      ...valid,
      WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED: "true",
      WEIXIN_BOOKKEEPING_SENDER_ID: "",
      WEIXIN_BOOKKEEPING_OWNER: "someoneelse",
    });
    assert.equal(bindingTableEra.weixinBookkeepingConfirmationEnabled, true);
    assert.throws(() => loadConfig({ ...valid, WEIXIN_ALLOW_GROUPS: "true" }), /WEIXIN_ALLOW_GROUPS/);
    assert.throws(() => loadConfig({ ...valid, WEIXIN_ALLOWED_GROUP_IDS: "production-group" }), /WEIXIN_ALLOWED_GROUP_IDS/);

    // v0.9.0 ops alert token: optional, but when configured in production it
    // must be high-entropy and independent from every other secret.
    const validOpsToken = Buffer.alloc(32, 11).toString("base64url");
    const withOpsToken = loadConfig({ ...valid, OPS_ALERT_TOKEN: validOpsToken });
    assert.equal(withOpsToken.opsAlertToken, validOpsToken);
    assert.throws(
      () => loadConfig({ ...valid, ...Object.fromEntries([["OPS_ALERT_TOKEN", "short"]]) }),
      /OPS_ALERT_TOKEN/,
    );
    assert.throws(() => loadConfig({ ...valid, OPS_ALERT_TOKEN: validMachineToken }), /independent/);

    // v0.9.0 AMAP_MODE: mock is a hard production gate.
    assert.equal(loadConfig(valid).amapMode, "live");
    assert.throws(() => loadConfig({ ...valid, AMAP_MODE: "mock" }), /AMAP_MODE/);
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
      assert.throws(() => loadConfig({ ...base, INVOICE_TEXT_EXTRACTION_TIMEOUT_MS: value }), /INVOICE_TEXT_EXTRACTION_TIMEOUT_MS/);
      assert.throws(() => loadConfig({ ...base, MODEL_TIMEOUT_MS: value }), /MODEL_TIMEOUT_MS/);
    }
    assert.equal(loadConfig(base).modelTimeoutMs, 30_000);
    assert.equal(loadConfig({ ...base, MODEL_TIMEOUT_MS: "45000" }).modelTimeoutMs, 45_000);
    assert.equal(loadConfig({ ...base, MODEL_TIMEOUT_MS: "120000" }).modelTimeoutMs, 120_000);
    for (const value of ["120001", "2147483648", "4294967296", Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => loadConfig({ ...base, MODEL_TIMEOUT_MS: value }), /MODEL_TIMEOUT_MS/);
    }
    assert.throws(() => loadConfig({ ...base, INVOICE_OCR_LANGUAGES: "chi sim;rm" }), /INVOICE_OCR_LANGUAGES/);
    assert.throws(() => loadConfig({ ...base, MODEL_VISION_NAME: "vision model" }), /MODEL_VISION_NAME/);
    assert.throws(() => loadConfig({ ...base, INVOICE_PDF_IMAGE_COMMAND: "" }), /INVOICE_PDF_IMAGE_COMMAND/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_AUTO_RUN: "yes" }), /HOSPITAL_TENDER_AUTO_RUN/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_INTERVAL_MINUTES: 1441 }), /HOSPITAL_TENDER_INTERVAL_MINUTES/);
    assert.throws(() => loadConfig({ ...base, HOSPITAL_TENDER_BATCH_SIZE: 201 }), /HOSPITAL_TENDER_BATCH_SIZE/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_ASSISTANT_AUTO_RUN: "yes" }), /PROACTIVE_ASSISTANT_AUTO_RUN/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_AUTO_RUN: "yes" }), /PROACTIVE_NOTIFICATION_AUTO_RUN/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_POLL_MS: 999 }), /PROACTIVE_NOTIFICATION_POLL_MS/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_QUIET_START: "25:00" }), /PROACTIVE_NOTIFICATION_QUIET_START/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_QUIET_END: "bad" }), /PROACTIVE_NOTIFICATION_QUIET_END/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_HOURLY_LIMIT: 101 }), /PROACTIVE_NOTIFICATION_HOURLY_LIMIT/);
    assert.throws(() => loadConfig({ ...base, PROACTIVE_NOTIFICATION_DAILY_LIMIT: 1001 }), /PROACTIVE_NOTIFICATION_DAILY_LIMIT/);
    for (const value of [0, 1_441, 1.5, "1e3", true]) {
      assert.throws(
        () => loadConfig({ ...base, PROACTIVE_ASSISTANT_INTERVAL_MINUTES: value }),
        /PROACTIVE_ASSISTANT_INTERVAL_MINUTES/,
      );
    }
    for (const value of [0, 501, 1.5, "1e3", true]) {
      assert.throws(
        () => loadConfig({ ...base, PROACTIVE_ASSISTANT_BATCH_SIZE: value }),
        /PROACTIVE_ASSISTANT_BATCH_SIZE/,
      );
    }
    for (const value of [0, 999, 86_400_001, 1.5, "1e3", true]) {
      assert.throws(
        () => loadConfig({ ...base, PROACTIVE_ASSISTANT_LEASE_MS: value }),
        /PROACTIVE_ASSISTANT_LEASE_MS/,
      );
      assert.throws(
        () => loadConfig({ ...base, PROACTIVE_ASSISTANT_RETRY_BASE_MS: value }),
        /PROACTIVE_ASSISTANT_RETRY_BASE_MS/,
      );
      assert.throws(
        () => loadConfig({ ...base, PROACTIVE_ASSISTANT_POLL_MS: value }),
        /PROACTIVE_ASSISTANT_POLL_MS/,
      );
    }
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_INTERVAL_MINUTES: 1 }).proactiveAssistantIntervalSeconds, 60);
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_INTERVAL_MINUTES: 1_440 }).proactiveAssistantIntervalSeconds, 86_400);
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_BATCH_SIZE: 500 }).proactiveAssistantBatchSize, 500);
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_LEASE_MS: 1_000 }).proactiveAssistantLeaseMs, 1_000);
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_RETRY_BASE_MS: 86_400_000 }).proactiveAssistantRetryBaseMs, 86_400_000);
    assert.equal(loadConfig({ ...base, PROACTIVE_ASSISTANT_POLL_MS: 1_000 }).proactiveAssistantPollMs, 1_000);
    assert.throws(() => loadConfig({ ...base, INVOICE_ESCALATION_AUTO_RUN: "yes" }), /INVOICE_ESCALATION_AUTO_RUN/);
    for (const value of [0, 4_999, 600_001, 1.5, "1e5", true]) {
      assert.throws(
        () => loadConfig({ ...base, INVOICE_ESCALATION_POLL_MS: value }),
        /INVOICE_ESCALATION_POLL_MS/,
      );
    }
    assert.equal(loadConfig({ ...base, INVOICE_ESCALATION_POLL_MS: 5_000 }).invoiceEscalationPollMs, 5_000);
    assert.equal(loadConfig({ ...base, INVOICE_ESCALATION_POLL_MS: 600_000 }).invoiceEscalationPollMs, 600_000);
    assert.equal(loadConfig(base).amapMode, "live");
    assert.equal(loadConfig({ ...base, AMAP_MODE: " Mock " }).amapMode, "mock");
    assert.throws(() => loadConfig({ ...base, AMAP_MODE: "sandbox" }), /AMAP_MODE/);
  });

  it("normalizes AI analysis mode and validates the model endpoint", () => {
    const base = { envFile: join(tmpdir(), "sent-zx-model-boundary-missing.env"), NODE_ENV: "test" };
    assert.equal(loadConfig({ ...base, AI_ANALYSIS_MODE: "  MoDeL  " }).aiAnalysisMode, "model");
    assert.equal(loadConfig({ ...base, AI_ANALYSIS_MODE: "model\n" }).aiAnalysisMode, "model");
    assert.equal(loadConfig({ ...base, AI_ANALYSIS_MODE: " MOCK " }).aiAnalysisMode, "mock");
    for (const value of ["", "   ", "typo", true, null]) {
      assert.throws(() => loadConfig({ ...base, AI_ANALYSIS_MODE: value }), /AI_ANALYSIS_MODE/);
    }

    assert.equal(
      loadConfig({ ...base, MODEL_BASE_URL: "https://api.deepseek.com/v1" }).modelBaseUrl,
      "https://api.deepseek.com/v1",
    );
    for (const value of [
      "",
      "   ",
      "not-a-url",
      "http://api.deepseek.com",
      "https://user:pass@example.com",
      "https://example.com/path?query=1",
      "https://example.com/path#fragment",
      "ftp://example.com",
    ]) {
      assert.throws(() => loadConfig({ ...base, MODEL_BASE_URL: value }), /MODEL_BASE_URL/);
    }
    assert.equal(
      loadConfig(
        { ...base, MODEL_BASE_URL: "http://127.0.0.1:8787" },
        { allowModelTestLoopbackHttp: true },
      ).modelBaseUrl,
      "http://127.0.0.1:8787",
    );
    assert.throws(
      () => loadConfig({ ...base, MODEL_BASE_URL: "http://127.0.0.1:8787" }),
      /MODEL_BASE_URL/,
    );
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
