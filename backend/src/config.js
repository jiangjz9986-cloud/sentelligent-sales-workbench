import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePasswordHashEncoding } from "./auth/password.js";

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

function isStrongSessionSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function isStrongIndependentSecret(value) {
  if (isStrongSessionSecret(value)) return true;
  return typeof value === "string" && /^[A-Za-z0-9_-]{64,}$/.test(value);
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
  if (!isStrongIndependentSecret(config.weixinAgentApiToken)) {
    throw new Error("WEIXIN_AGENT_API_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  if (!isStrongIndependentSecret(config.assistantConfirmationSecret)) {
    throw new Error("ASSISTANT_CONFIRMATION_SECRET must contain at least 32 bytes of high-entropy data in production");
  }
  if (config.weixinAllowedSenderIds.length === 0) {
    throw new Error("WEIXIN_ALLOWED_SENDER_IDS must contain at least one sender in production");
  }
  if (config.weixinAllowGroups) {
    throw new Error("WEIXIN_ALLOW_GROUPS must be false in production");
  }
  if (config.weixinAllowedGroupIds.length > 0) {
    throw new Error("WEIXIN_ALLOWED_GROUP_IDS must be empty in production");
  }
  if (new Set([
    config.authSessionSecret,
    config.weixinAgentApiToken,
    config.assistantConfirmationSecret,
  ]).size !== 3) {
    throw new Error("Production session, machine, and confirmation secrets must be independent");
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
    assistantConfirmationSecret: String(
      env.assistantConfirmationSecret ?? env.ASSISTANT_CONFIRMATION_SECRET ?? "",
    ).trim(),
    weixinAgentBackendUrl: env.weixinAgentBackendUrl ?? env.WEIXIN_AGENT_BACKEND_URL ?? "",
    weixinAgentOwner: env.weixinAgentOwner ?? env.WEIXIN_AGENT_OWNER ?? env.AUTH_ACCOUNT ?? env.authAccount ?? "",
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
