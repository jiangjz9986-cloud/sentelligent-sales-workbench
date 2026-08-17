import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePasswordHashEncoding } from "./auth/password.js";
import { isValidSettingsEncryptionKey } from "./settings/secretBox.js";

export function loadEnvFile(filePath = resolve(process.cwd(), ".env")) {
  if (!existsSync(filePath)) return {};

  const entries = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }

  return entries;
}

let warnedAboutPlaintextDevelopmentPassword = false;

function booleanValue(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new Error(`${name} must be true or false`);
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function originList(value, name = "CORS_ALLOWED_ORIGINS") {
  const items = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const origins = new Set();
  for (const item of items) {
    let url;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`${name} contains an invalid origin: ${item}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null" ||
      item === "*"
    ) {
      throw new Error(`${name} contains an invalid origin: ${item}`);
    }
    origins.add(url.origin);
  }
  return [...origins];
}

function positiveInteger(value, name) {
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function boundedPositiveInteger(value, name, max) {
  const parsed = positiveInteger(value, name);
  if (parsed > max) throw new Error(`${name} must be no greater than ${max}`);
  return parsed;
}

function invoiceOcrLanguagesValue(value) {
  const normalized = String(value ?? "chi_sim+eng").trim();
  if (!/^[A-Za-z0-9_.+-]{1,100}$/.test(normalized)) {
    throw new Error("INVOICE_OCR_LANGUAGES contains unsupported characters");
  }
  return normalized;
}

function identifierList(value, name) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const result = [];
  for (const raw of values) {
    if (typeof raw !== "string") throw new Error(`${name} contains an invalid identifier`);
    const item = raw.trim();
    if (!item) continue;
    if (item.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(item)) {
      throw new Error(`${name} contains an invalid identifier`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function executableValue(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 300 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error(`${name} must be a bounded executable path`);
  }
  return normalized;
}

function isStrongSessionSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function isStrongIndependentSecret(value) {
  if (isStrongSessionSecret(value)) return true;
  return typeof value === "string" && /^[A-Za-z0-9_-]{64,}$/.test(value);
}

export const QINGYANG_BOOKKEEPING_BRIDGE_URL =
  "http://127.0.0.1:8797/api/integrations/sentelligent/bookkeeping";

function qingyangBridgeUrl(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (normalized !== QINGYANG_BOOKKEEPING_BRIDGE_URL) {
    throw new Error(`QINGYANG_BOOKKEEPING_BRIDGE_URL must be exactly ${QINGYANG_BOOKKEEPING_BRIDGE_URL}`);
  }
  return normalized;
}

function validateProductionConfig(config, { explicitAllowedOrigins }) {
  if (config.nodeEnv !== "production") return;
  if (!config.authRequired) throw new Error("AUTH_REQUIRED must be true in production");
  if (!config.authAccount) throw new Error("AUTH_ACCOUNT is required in production");
  if (config.authPassword) throw new Error("AUTH_PASSWORD is not allowed in production");
  if (!validatePasswordHashEncoding(config.authPasswordHash)) {
    throw new Error("AUTH_PASSWORD_HASH must be a canonical scrypt hash in production");
  }
  if (!isStrongSessionSecret(config.authSessionSecret)) {
    throw new Error("AUTH_SESSION_SECRET must be canonical base64url encoding of at least 32 bytes in production");
  }
  if (!isValidSettingsEncryptionKey(config.settingsEncryptionKey)) {
    throw new Error("SETTINGS_ENCRYPTION_KEY must be canonical base64url encoding of exactly 32 bytes in production");
  }
  if (!isStrongIndependentSecret(config.weixinAgentApiToken)) {
    throw new Error("WEIXIN_AGENT_API_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  if (!isStrongIndependentSecret(config.assistantConfirmationSecret)) {
    throw new Error("ASSISTANT_CONFIRMATION_SECRET must contain at least 32 bytes of high-entropy data in production");
  }
  if (!config.weixinAgentOwner) {
    throw new Error("WEIXIN_AGENT_OWNER is required in production");
  }
  if (config.hospitalTenderSyncToken && !isStrongIndependentSecret(config.hospitalTenderSyncToken)) {
    throw new Error("HOSPITAL_TENDER_SYNC_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  // An empty sender allowlist is an intentional unbound state during the
  // initial production rollout. The event boundary still rejects every
  // sender until an operator configures a real WeChat sender ID.
  if (config.weixinAllowGroups) {
    throw new Error("WEIXIN_ALLOW_GROUPS must be false in production");
  }
  if (config.weixinAllowedGroupIds.length > 0) {
    throw new Error("WEIXIN_ALLOWED_GROUP_IDS must be empty in production");
  }
  if (new Set([
    config.authSessionSecret,
    config.settingsEncryptionKey,
    config.weixinAgentApiToken,
    config.assistantConfirmationSecret,
    ...(config.hospitalTenderSyncToken ? [config.hospitalTenderSyncToken] : []),
  ]).size !== (config.hospitalTenderSyncToken ? 5 : 4)) {
    throw new Error("Production session, settings, machine, and confirmation secrets must be independent");
  }
  if (config.shortcutWebhookToken) {
    throw new Error("SHORTCUT_WEBHOOK_TOKEN is not allowed in production; use account-bound database tokens");
  }
  if (config.qingyangBookkeepingBridgeUrl !== QINGYANG_BOOKKEEPING_BRIDGE_URL) {
    throw new Error("QINGYANG_BOOKKEEPING_BRIDGE_URL is required in production");
  }
  if (!isStrongIndependentSecret(config.qingyangBookkeepingBridgeToken)) {
    throw new Error("QINGYANG_BOOKKEEPING_BRIDGE_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  if (new Set([
    config.authSessionSecret,
    config.settingsEncryptionKey,
    config.weixinAgentApiToken,
    config.assistantConfirmationSecret,
    config.qingyangBookkeepingBridgeToken,
    ...(config.hospitalTenderSyncToken ? [config.hospitalTenderSyncToken] : []),
  ]).size !== (config.hospitalTenderSyncToken ? 6 : 5)) {
    throw new Error("Production session, settings, machine, confirmation, and Qingyang bridge secrets must be independent");
  }
  if (!config.authCookieSecure) throw new Error("AUTH_COOKIE_SECURE must be true in production");
  if (!explicitAllowedOrigins || config.corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS is required in production");
  }
}

export function loadConfig(overrides = {}) {
  const envFile = loadEnvFile(overrides.envFile);
  const env = { ...envFile, ...process.env, ...overrides };
  const nodeEnv = String(env.nodeEnv ?? env.NODE_ENV ?? "development").trim().toLowerCase();
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const authRequired = booleanValue(
    env.authRequired ?? env.AUTH_REQUIRED,
    true,
    "AUTH_REQUIRED",
  );
  const authPasswordHash = String(env.authPasswordHash ?? env.AUTH_PASSWORD_HASH ?? "").trim();
  const authPassword = env.authPassword ?? env.AUTH_PASSWORD ?? "";
  const explicitAllowedOrigins = env.corsAllowedOrigins ?? env.CORS_ALLOWED_ORIGINS;
  const corsAllowedOrigins = originList(
    explicitAllowedOrigins ?? "http://127.0.0.1:5184,http://localhost:5184",
  );
  const jsonBodyLimitBytes = positiveInteger(
    env.jsonBodyLimitBytes ?? env.JSON_BODY_LIMIT_BYTES ?? 1_048_576,
    "JSON_BODY_LIMIT_BYTES",
  );
  const amapTimeoutMs = positiveInteger(
    env.amapTimeoutMs ?? env.AMAP_TIMEOUT_MS ?? 10_000,
    "AMAP_TIMEOUT_MS",
  );
  const icostWebhookRateLimit = positiveInteger(
    env.icostWebhookRateLimit ?? env.ICOST_WEBHOOK_RATE_LIMIT ?? 30,
    "ICOST_WEBHOOK_RATE_LIMIT",
  );
  const icostWebhookWindowMs = positiveInteger(
    env.icostWebhookWindowMs ?? env.ICOST_WEBHOOK_WINDOW_MS ?? 300_000,
    "ICOST_WEBHOOK_WINDOW_MS",
  );
  const shortcutWebhookRateLimit = positiveInteger(
    env.shortcutWebhookRateLimit ?? env.SHORTCUT_WEBHOOK_RATE_LIMIT ?? 60,
    "SHORTCUT_WEBHOOK_RATE_LIMIT",
  );
  const shortcutWebhookWindowMs = positiveInteger(
    env.shortcutWebhookWindowMs ?? env.SHORTCUT_WEBHOOK_WINDOW_MS ?? 300_000,
    "SHORTCUT_WEBHOOK_WINDOW_MS",
  );
  const qingyangBookkeepingBridgeTimeoutMs = boundedPositiveInteger(
    env.qingyangBookkeepingBridgeTimeoutMs
      ?? env.QINGYANG_BOOKKEEPING_BRIDGE_TIMEOUT_MS
      ?? 10_000,
    "QINGYANG_BOOKKEEPING_BRIDGE_TIMEOUT_MS",
    30_000,
  );
  const invoiceTextExtractionTimeoutMs = positiveInteger(
    env.invoiceTextExtractionTimeoutMs ?? env.INVOICE_TEXT_EXTRACTION_TIMEOUT_MS ?? 30_000,
    "INVOICE_TEXT_EXTRACTION_TIMEOUT_MS",
  );
  const weixinAllowedSenderIds = identifierList(
    env.weixinAllowedSenderIds ?? env.WEIXIN_ALLOWED_SENDER_IDS,
    "WEIXIN_ALLOWED_SENDER_IDS",
  );
  const weixinAllowedGroupIds = identifierList(
    env.weixinAllowedGroupIds ?? env.WEIXIN_ALLOWED_GROUP_IDS,
    "WEIXIN_ALLOWED_GROUP_IDS",
  );
  const hospitalTenderIntervalMinutes = boundedPositiveInteger(
    env.hospitalTenderIntervalMinutes ?? env.HOSPITAL_TENDER_INTERVAL_MINUTES ?? 60,
    "HOSPITAL_TENDER_INTERVAL_MINUTES",
    1440,
  );
  const hospitalTenderBatchSize = boundedPositiveInteger(
    env.hospitalTenderBatchSize ?? env.HOSPITAL_TENDER_BATCH_SIZE ?? 10,
    "HOSPITAL_TENDER_BATCH_SIZE",
    200,
  );
  const config = {
    host: env.host ?? env.HOST ?? "127.0.0.1",
    port: Number(env.port ?? env.PORT ?? 8787),
    databaseUrl: env.databaseUrl ?? env.DATABASE_URL ?? "./data/sales-workbench.sqlite",
    aiAnalysisMode: env.aiAnalysisMode ?? env.AI_ANALYSIS_MODE ?? "mock",
    modelProvider: env.modelProvider ?? env.MODEL_PROVIDER ?? "deepseek",
    modelApiKey: env.modelApiKey ?? env.MODEL_API_KEY ?? env.DEEPSEEK_API_KEY ?? "",
    modelBaseUrl: env.modelBaseUrl ?? env.MODEL_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    modelName: env.modelName ?? env.MODEL_NAME ?? env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    modelTimeoutMs: Number(env.modelTimeoutMs ?? env.MODEL_TIMEOUT_MS ?? 30000),
    hospitalTenderPython: executableValue(
      env.hospitalTenderPython ?? env.HOSPITAL_TENDER_PYTHON ?? "python3",
      "HOSPITAL_TENDER_PYTHON",
    ),
    hospitalTenderAutoRun: booleanValue(
      env.hospitalTenderAutoRun ?? env.HOSPITAL_TENDER_AUTO_RUN,
      nodeEnv === "production",
      "HOSPITAL_TENDER_AUTO_RUN",
    ),
    hospitalTenderIntervalMinutes,
    hospitalTenderBatchSize,
    hospitalTenderPushplusToken: String(
      env.hospitalTenderPushplusToken ?? env.HOSPITAL_TENDER_PUSHPLUS_TOKEN ?? "",
    ).trim(),
    settingsEncryptionKey: String(
      env.settingsEncryptionKey ?? env.SETTINGS_ENCRYPTION_KEY ?? "",
    ).trim(),
    amapWebServiceKey: String(env.amapWebServiceKey ?? env.AMAP_WEB_SERVICE_KEY ?? "").trim(),
    amapTimeoutMs,
    solutionWritesEnabled: booleanValue(
      env.solutionWritesEnabled ?? env.SOLUTION_WRITES_ENABLED,
      false,
      "SOLUTION_WRITES_ENABLED",
    ),
    authAccount: String(env.authAccount ?? env.AUTH_ACCOUNT ?? "").trim(),
    authRequired,
    authPassword,
    authPasswordHash,
    authSessionSecret: String(env.authSessionSecret ?? env.AUTH_SESSION_SECRET ?? ""),
    authCookieName: env.authCookieName ?? env.AUTH_COOKIE_NAME ?? "sentelligent_session",
    authCookieSecure: booleanValue(
      env.authCookieSecure ?? env.AUTH_COOKIE_SECURE,
      nodeEnv === "production",
      "AUTH_COOKIE_SECURE",
    ),
    authCookieSameSite: "Lax",
    corsAllowedOrigins,
    jsonBodyLimitBytes,
    nodeEnv,
    weixinAgentApiToken: env.weixinAgentApiToken ?? env.WEIXIN_AGENT_API_TOKEN ?? "",
    hospitalTenderSyncToken: String(
      env.hospitalTenderSyncToken ?? env.HOSPITAL_TENDER_SYNC_TOKEN ?? "",
    ).trim(),
    hospitalTenderSyncOwner: String(
      env.hospitalTenderSyncOwner
      ?? env.HOSPITAL_TENDER_SYNC_OWNER
      ?? env.AUTH_ACCOUNT
      ?? env.authAccount
      ?? "hospital-tender-monitor",
    ).trim(),
    assistantConfirmationSecret: String(
      env.assistantConfirmationSecret ?? env.ASSISTANT_CONFIRMATION_SECRET ?? "",
    ).trim(),
    weixinAgentBackendUrl: env.weixinAgentBackendUrl ?? env.WEIXIN_AGENT_BACKEND_URL ?? "",
    weixinAgentOwner: String(env.weixinAgentOwner ?? env.WEIXIN_AGENT_OWNER ?? "").trim(),
    weixinAgentSessionHome: env.weixinAgentSessionHome ?? env.WEIXIN_AGENT_SESSION_HOME ?? "",
    weixinAllowedSenderIds,
    weixinAllowedGroupIds,
    weixinAllowGroups: booleanValue(
      env.weixinAllowGroups ?? env.WEIXIN_ALLOW_GROUPS,
      false,
      "WEIXIN_ALLOW_GROUPS",
    ),
    icostWebhookToken: String(env.icostWebhookToken ?? env.ICOST_WEBHOOK_TOKEN ?? "").trim(),
    icostWebhookOwner: String(
      env.icostWebhookOwner ?? env.ICOST_WEBHOOK_OWNER ?? env.AUTH_ACCOUNT ?? env.authAccount ?? "icost",
    ).trim(),
    icostWebhookRateLimit,
    icostWebhookWindowMs,
    shortcutWebhookToken: String(
      env.shortcutWebhookToken ?? env.SHORTCUT_WEBHOOK_TOKEN ?? "",
    ).trim(),
    shortcutWebhookOwner: String(
      env.shortcutWebhookOwner
        ?? env.SHORTCUT_WEBHOOK_OWNER
        ?? env.AUTH_ACCOUNT
        ?? env.authAccount
        ?? "shortcut",
    ).trim(),
    shortcutWebhookRateLimit,
    shortcutWebhookWindowMs,
    qingyangBookkeepingBridgeUrl: qingyangBridgeUrl(
      env.qingyangBookkeepingBridgeUrl ?? env.QINGYANG_BOOKKEEPING_BRIDGE_URL,
    ),
    qingyangBookkeepingBridgeToken: String(
      env.qingyangBookkeepingBridgeToken ?? env.QINGYANG_BOOKKEEPING_BRIDGE_TOKEN ?? "",
    ).trim(),
    qingyangBookkeepingBridgeTimeoutMs,
    invoiceOcrCommand: String(env.invoiceOcrCommand ?? env.INVOICE_OCR_COMMAND ?? "").trim(),
    invoicePdfTextCommand: String(
      env.invoicePdfTextCommand ?? env.INVOICE_PDF_TEXT_COMMAND ?? "",
    ).trim(),
    invoiceOcrLanguages: invoiceOcrLanguagesValue(
      env.invoiceOcrLanguages ?? env.INVOICE_OCR_LANGUAGES,
    ),
    invoiceTextExtractionTimeoutMs,
  };

  validateProductionConfig(config, { explicitAllowedOrigins });
  if (
    config.nodeEnv === "development" &&
    config.authRequired &&
    !config.authPasswordHash &&
    config.authPassword &&
    !warnedAboutPlaintextDevelopmentPassword
  ) {
    console.warn("AUTH_PASSWORD is a development compatibility setting; configure AUTH_PASSWORD_HASH instead.");
    warnedAboutPlaintextDevelopmentPassword = true;
  }
  return config;
}
