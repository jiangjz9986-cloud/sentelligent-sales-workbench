import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ASR_CONFIG_DEFAULTS, ASR_LIMITS } from "./asr/contracts.js";
import { validatePasswordHashEncoding } from "./auth/password.js";
import { isValidSettingsEncryptionKey } from "./settings/secretBox.js";

export const MODEL_TIMEOUT_MS_MAX = 120_000;
export const PROACTIVE_ASSISTANT_INTERVAL_SECONDS_MAX = 24 * 60 * 60;
export const PROACTIVE_ASSISTANT_BATCH_SIZE_MAX = 500;
export const PROACTIVE_ASSISTANT_POLL_MS_MAX = 24 * 60 * 60 * 1000;
export const PROACTIVE_ASSISTANT_MODEL_CACHE_TTL_MS_MAX = 30 * 24 * 60 * 60 * 1000;
export const PROACTIVE_ASSISTANT_MODEL_OWNER_DAILY_LIMIT_MAX = 1_000_000;
export const PROACTIVE_ASSISTANT_MODEL_GLOBAL_DAILY_LIMIT_MAX = 10_000_000;

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

function timeOfDayValue(value, fallback, name) {
  // Accept an already-parsed value so loadConfig stays idempotent when the
  // server entry point feeds a loaded config back in as overrides.
  if (value && typeof value === "object"
    && Number.isSafeInteger(value.hour) && value.hour >= 0 && value.hour <= 23
    && Number.isSafeInteger(value.minute) && value.minute >= 0 && value.minute <= 59) {
    return { hour: value.hour, minute: value.minute };
  }
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const match = String(raw).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/u);
  if (!match) throw new Error(`${name} must be HH:MM in the 24-hour clock`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
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

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${name} contains an invalid identifier`);
  const item = value.trim();
  if (!item || item.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(item)) {
    throw new Error(`${name} contains an invalid identifier`);
  }
  return item;
}

function executableValue(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 300 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error(`${name} must be a bounded executable path`);
  }
  return normalized;
}

function modelIdentifierValue(value, fallback, name) {
  const normalized = String(value ?? fallback).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(normalized)) {
    throw new Error(`${name} must be a bounded model identifier`);
  }
  return normalized;
}

function asrEnumValue(value, fallback, name, allowed) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (typeof candidate !== "string" || !allowed.includes(candidate)) {
    throw new Error(`${name} must be ${allowed.join(" or ")}`);
  }
  return candidate;
}

function aiAnalysisModeValue(value, fallback = "mock") {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("AI_ANALYSIS_MODE must be mock or model");
  const normalized = value.trim().toLowerCase();
  if (!["mock", "model"].includes(normalized)) {
    throw new Error("AI_ANALYSIS_MODE must be mock or model");
  }
  return normalized;
}

function modelBaseUrlValue(value, { nodeEnv, allowModelTestLoopbackHttp }) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || value.length > 2_048) {
    throw new Error("MODEL_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MODEL_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("MODEL_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (url.protocol !== "https:") {
    const isExplicitTestLoopback = nodeEnv === "test"
      && allowModelTestLoopbackHttp === true
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!isExplicitTestLoopback) {
      throw new Error("MODEL_BASE_URL must use https unless explicit test-only loopback injection is active");
    }
  }
  return value;
}

function optionalAsrModelValue(value) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(normalized)) {
    throw new Error("ASR_MODEL must be empty or a bounded model identifier");
  }
  return normalized;
}

function asrBaseUrlValue(value, { nodeEnv, allowAsrTestLoopbackHttp }) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value !== value.trim() || value.length > 2_048) {
    throw new Error("ASR_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ASR_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("ASR_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (url.protocol !== "https:") {
    const isExplicitTestLoopback = nodeEnv === "test"
      && allowAsrTestLoopbackHttp === true
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!isExplicitTestLoopback) {
      throw new Error("ASR_BASE_URL must use https unless explicit test-only loopback injection is active");
    }
  }
  return value;
}

function boundedAsrPathValue(value, fallback, name) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || candidate.length > 300
    || candidate !== candidate.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate)
  ) {
    throw new Error(`${name} must be a bounded path`);
  }
  return candidate;
}

function boundedAsrInteger(value, fallback, name, { min = 1, max }) {
  const parsed = positiveInteger(value === undefined || value === null ? fallback : value, name);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
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
  // v0.9.3：WEIXIN_BOOKKEEPING_SENDER_ID/OWNER 与 WEIXIN_ALLOWED_SENDER_IDS 的三条
  // 硬校验退役——sender 白名单与业务归属由 weixin_bindings 表承载（运行时
  // ensureBootstrapBinding + bindings 巡检字段替代），三枚 env 键保留一版仅供
  // bootstrap 种子，v1.0.0-rc 连同键值一起退役。
  if (config.hospitalTenderSyncToken && !isStrongIndependentSecret(config.hospitalTenderSyncToken)) {
    throw new Error("HOSPITAL_TENDER_SYNC_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  if (config.opsAlertToken && !isStrongIndependentSecret(config.opsAlertToken)) {
    throw new Error("OPS_ALERT_TOKEN must contain at least 32 bytes of high-entropy data in production");
  }
  if (config.amapMode === "mock") {
    throw new Error("AMAP_MODE must not be mock in production");
  }
  if (config.asrTempRoot !== ASR_CONFIG_DEFAULTS.tempRoot || !isAbsolute(config.asrTempRoot)) {
    throw new Error(`ASR_TEMP_ROOT must be ${ASR_CONFIG_DEFAULTS.tempRoot} in production`);
  }
  if (!isAbsolute(config.asrFfprobeCommand)) {
    throw new Error("ASR_FFPROBE_COMMAND must be an absolute path in production");
  }
  if (!isAbsolute(config.asrFfmpegCommand)) {
    throw new Error("ASR_FFMPEG_COMMAND must be an absolute path in production");
  }
  if (config.asrBaseUrl && new URL(config.asrBaseUrl).protocol !== "https:") {
    throw new Error("ASR_BASE_URL must use https in production");
  }
  if (config.asrReuseModelCredential) {
    throw new Error("ASR_REUSE_MODEL_CREDENTIAL must remain false without production compatibility evidence");
  }
  if (config.asrMode === "live") {
    if (!config.asrBaseUrl) throw new Error("ASR_BASE_URL is required when ASR_MODE=live in production");
    if (!config.asrModel) throw new Error("ASR_MODEL is required when ASR_MODE=live in production");
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
  const independentSecrets = [
    config.authSessionSecret,
    config.settingsEncryptionKey,
    config.weixinAgentApiToken,
    config.assistantConfirmationSecret,
    ...(config.hospitalTenderSyncToken ? [config.hospitalTenderSyncToken] : []),
    ...(config.opsAlertToken ? [config.opsAlertToken] : []),
  ];
  if (new Set(independentSecrets).size !== independentSecrets.length) {
    throw new Error("Production session, settings, machine, and confirmation secrets must be independent");
  }
  if (!config.authCookieSecure) throw new Error("AUTH_COOKIE_SECURE must be true in production");
  if (!explicitAllowedOrigins || config.corsAllowedOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS is required in production");
  }
}

export function loadConfig(
  overrides = {},
  { allowAsrTestLoopbackHttp = false, allowModelTestLoopbackHttp = false } = {},
) {
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
  const weixinOutboxPollMs = boundedPositiveInteger(
    env.weixinOutboxPollMs ?? env.WEIXIN_OUTBOX_POLL_MS ?? 5_000,
    "WEIXIN_OUTBOX_POLL_MS",
    60_000,
  );
  if (weixinOutboxPollMs < 500) throw new Error("WEIXIN_OUTBOX_POLL_MS must be at least 500 milliseconds");
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
  const weixinBookkeepingSenderId = optionalIdentifier(
    env.weixinBookkeepingSenderId ?? env.WEIXIN_BOOKKEEPING_SENDER_ID,
    "WEIXIN_BOOKKEEPING_SENDER_ID",
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
  // The proactive assistant scanner owns its durable cursor and retry state
  // in SQLite (migration 0039).  These process settings only control whether
  // the timer is started and the safe upper bounds used when the state row is
  // first initialized; persisted state remains authoritative afterwards.
  const proactiveAssistantIntervalMinutes = boundedPositiveInteger(
    env.proactiveAssistantIntervalMinutes
      ?? env.PROACTIVE_ASSISTANT_INTERVAL_MINUTES
      ?? 5,
    "PROACTIVE_ASSISTANT_INTERVAL_MINUTES",
    1440,
  );
  const proactiveAssistantBatchSize = boundedPositiveInteger(
    env.proactiveAssistantBatchSize
      ?? env.PROACTIVE_ASSISTANT_BATCH_SIZE
      ?? 50,
    "PROACTIVE_ASSISTANT_BATCH_SIZE",
    500,
  );
  const proactiveAssistantLeaseMs = boundedPositiveInteger(
    env.proactiveAssistantLeaseMs
      ?? env.PROACTIVE_ASSISTANT_LEASE_MS
      ?? 120_000,
    "PROACTIVE_ASSISTANT_LEASE_MS",
    24 * 60 * 60 * 1000,
  );
  if (proactiveAssistantLeaseMs < 1_000) {
    throw new Error("PROACTIVE_ASSISTANT_LEASE_MS must be at least 1000 milliseconds");
  }
  const proactiveAssistantRetryBaseMs = boundedPositiveInteger(
    env.proactiveAssistantRetryBaseMs
      ?? env.PROACTIVE_ASSISTANT_RETRY_BASE_MS
      ?? 30_000,
    "PROACTIVE_ASSISTANT_RETRY_BASE_MS",
    24 * 60 * 60 * 1000,
  );
  if (proactiveAssistantRetryBaseMs < 1_000) {
    throw new Error("PROACTIVE_ASSISTANT_RETRY_BASE_MS must be at least 1000 milliseconds");
  }
  const proactiveAssistantPollMs = boundedPositiveInteger(
    env.proactiveAssistantPollMs
      ?? env.PROACTIVE_ASSISTANT_POLL_MS
      ?? 30_000,
    "PROACTIVE_ASSISTANT_POLL_MS",
    24 * 60 * 60 * 1000,
  );
  if (proactiveAssistantPollMs < 1_000) {
    throw new Error("PROACTIVE_ASSISTANT_POLL_MS must be at least 1000 milliseconds");
  }
  const proactiveAssistantModelConcurrency = boundedPositiveInteger(
    env.proactiveAssistantModelConcurrency
      ?? env.PROACTIVE_ASSISTANT_MODEL_CONCURRENCY
      ?? 2,
    "PROACTIVE_ASSISTANT_MODEL_CONCURRENCY",
    20,
  );
  const proactiveAssistantModelRetryLimit = boundedPositiveInteger(
    env.proactiveAssistantModelRetryLimit
      ?? env.PROACTIVE_ASSISTANT_MODEL_RETRY_LIMIT
      ?? 1,
    "PROACTIVE_ASSISTANT_MODEL_RETRY_LIMIT",
    3,
  );
  const proactiveAssistantModelCacheTtlMs = boundedPositiveInteger(
    env.proactiveAssistantModelCacheTtlMs
      ?? env.PROACTIVE_ASSISTANT_MODEL_CACHE_TTL_MS
      ?? 24 * 60 * 60 * 1000,
    "PROACTIVE_ASSISTANT_MODEL_CACHE_TTL_MS",
    PROACTIVE_ASSISTANT_MODEL_CACHE_TTL_MS_MAX,
  );
  const proactiveAssistantModelOwnerDailyLimit = boundedPositiveInteger(
    env.proactiveAssistantModelOwnerDailyLimit
      ?? env.PROACTIVE_ASSISTANT_MODEL_OWNER_DAILY_LIMIT
      ?? 100,
    "PROACTIVE_ASSISTANT_MODEL_OWNER_DAILY_LIMIT",
    PROACTIVE_ASSISTANT_MODEL_OWNER_DAILY_LIMIT_MAX,
  );
  const proactiveAssistantModelGlobalDailyLimit = boundedPositiveInteger(
    env.proactiveAssistantModelGlobalDailyLimit
      ?? env.PROACTIVE_ASSISTANT_MODEL_GLOBAL_DAILY_LIMIT
      ?? 1000,
    "PROACTIVE_ASSISTANT_MODEL_GLOBAL_DAILY_LIMIT",
    PROACTIVE_ASSISTANT_MODEL_GLOBAL_DAILY_LIMIT_MAX,
  );
  const proactiveAssistantModelBudgetTimezone = String(
    env.proactiveAssistantModelBudgetTimezone
      ?? env.PROACTIVE_ASSISTANT_MODEL_BUDGET_TIMEZONE
      ?? "Asia/Shanghai",
  ).trim();
  if (!proactiveAssistantModelBudgetTimezone) {
    throw new Error("PROACTIVE_ASSISTANT_MODEL_BUDGET_TIMEZONE is required");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: proactiveAssistantModelBudgetTimezone }).format(new Date());
  } catch {
    throw new Error("PROACTIVE_ASSISTANT_MODEL_BUDGET_TIMEZONE is invalid");
  }
  const proactiveAssistantIntervalSeconds = proactiveAssistantIntervalMinutes * 60;
  const proactiveNotificationPollMs = boundedPositiveInteger(
    env.proactiveNotificationPollMs ?? env.PROACTIVE_NOTIFICATION_POLL_MS ?? 60_000,
    "PROACTIVE_NOTIFICATION_POLL_MS",
    24 * 60 * 60 * 1000,
  );
  if (proactiveNotificationPollMs < 1_000) throw new Error("PROACTIVE_NOTIFICATION_POLL_MS must be at least 1000 milliseconds");
  const proactiveNotificationQuietStart = timeOfDayValue(
    env.proactiveNotificationQuietStart ?? env.PROACTIVE_NOTIFICATION_QUIET_START,
    "22:00", "PROACTIVE_NOTIFICATION_QUIET_START",
  );
  const proactiveNotificationQuietEnd = timeOfDayValue(
    env.proactiveNotificationQuietEnd ?? env.PROACTIVE_NOTIFICATION_QUIET_END,
    "08:00", "PROACTIVE_NOTIFICATION_QUIET_END",
  );
  const proactiveNotificationHourlyLimit = boundedPositiveInteger(
    env.proactiveNotificationHourlyLimit ?? env.PROACTIVE_NOTIFICATION_HOURLY_LIMIT ?? 3,
    "PROACTIVE_NOTIFICATION_HOURLY_LIMIT", 100,
  );
  const proactiveNotificationDailyLimit = boundedPositiveInteger(
    env.proactiveNotificationDailyLimit ?? env.PROACTIVE_NOTIFICATION_DAILY_LIMIT ?? 12,
    "PROACTIVE_NOTIFICATION_DAILY_LIMIT", 1000,
  );
  const amapMode = String(env.amapMode ?? env.AMAP_MODE ?? "live").trim().toLowerCase();
  if (!["live", "mock"].includes(amapMode)) {
    throw new Error("AMAP_MODE must be live or mock");
  }
  const asrMode = asrEnumValue(
    env.asrMode ?? env.ASR_MODE,
    ASR_CONFIG_DEFAULTS.mode,
    "ASR_MODE",
    ["disabled", "live"],
  );
  const asrProvider = asrEnumValue(
    env.asrProvider ?? env.ASR_PROVIDER,
    ASR_CONFIG_DEFAULTS.provider,
    "ASR_PROVIDER",
    [ASR_CONFIG_DEFAULTS.provider],
  );
  const asrTimeoutMs = boundedAsrInteger(
    env.asrTimeoutMs ?? env.ASR_TIMEOUT_MS,
    ASR_CONFIG_DEFAULTS.timeoutMs,
    "ASR_TIMEOUT_MS",
    { max: ASR_LIMITS.providerTimeoutMs },
  );
  const asrUploadMaxBytes = boundedAsrInteger(
    env.asrUploadMaxBytes ?? env.ASR_UPLOAD_MAX_BYTES,
    ASR_CONFIG_DEFAULTS.uploadMaxBytes,
    "ASR_UPLOAD_MAX_BYTES",
    { max: ASR_LIMITS.uploadMaxBytes },
  );
  const asrQuickMaxDurationMs = boundedAsrInteger(
    env.asrQuickMaxDurationMs ?? env.ASR_QUICK_MAX_DURATION_MS,
    ASR_CONFIG_DEFAULTS.quickMaxDurationMs,
    "ASR_QUICK_MAX_DURATION_MS",
    { min: ASR_LIMITS.minDurationMs, max: ASR_CONFIG_DEFAULTS.quickMaxDurationMs },
  );
  const asrAssistantMaxDurationMs = boundedAsrInteger(
    env.asrAssistantMaxDurationMs ?? env.ASR_ASSISTANT_MAX_DURATION_MS,
    ASR_CONFIG_DEFAULTS.assistantMaxDurationMs,
    "ASR_ASSISTANT_MAX_DURATION_MS",
    { min: ASR_LIMITS.minDurationMs, max: ASR_CONFIG_DEFAULTS.assistantMaxDurationMs },
  );
  if (asrAssistantMaxDurationMs > asrQuickMaxDurationMs) {
    throw new Error("ASR_ASSISTANT_MAX_DURATION_MS must not exceed ASR_QUICK_MAX_DURATION_MS");
  }
  const aiAnalysisMode = aiAnalysisModeValue(
    env.aiAnalysisMode !== undefined ? env.aiAnalysisMode : env.AI_ANALYSIS_MODE,
  );
  const modelBaseUrl = modelBaseUrlValue(
    env.modelBaseUrl !== undefined
      ? env.modelBaseUrl
      : env.MODEL_BASE_URL !== undefined
        ? env.MODEL_BASE_URL
        : env.DEEPSEEK_BASE_URL !== undefined
          ? env.DEEPSEEK_BASE_URL
          : "https://api.deepseek.com",
    { nodeEnv, allowModelTestLoopbackHttp },
  );
  const config = {
    host: env.host ?? env.HOST ?? "127.0.0.1",
    port: Number(env.port ?? env.PORT ?? 8787),
    databaseUrl: env.databaseUrl ?? env.DATABASE_URL ?? "./data/sales-workbench.sqlite",
    aiAnalysisMode,
    modelProvider: env.modelProvider ?? env.MODEL_PROVIDER ?? "deepseek",
    modelApiKey: env.modelApiKey ?? env.MODEL_API_KEY ?? env.DEEPSEEK_API_KEY ?? "",
    modelBaseUrl,
    modelName: modelIdentifierValue(
      env.modelName ?? env.MODEL_NAME ?? env.DEEPSEEK_MODEL,
      "deepseek-v4-flash",
      "MODEL_NAME",
    ),
    modelVisionName: modelIdentifierValue(
      env.modelVisionName ?? env.MODEL_VISION_NAME ?? env.DEEPSEEK_VISION_MODEL,
      "deepseek-v4-flash-vision-exp",
      "MODEL_VISION_NAME",
    ),
    modelTimeoutMs: boundedPositiveInteger(
      env.modelTimeoutMs ?? env.MODEL_TIMEOUT_MS ?? 30_000,
      "MODEL_TIMEOUT_MS",
      MODEL_TIMEOUT_MS_MAX,
    ),
    asrMode,
    asrProvider,
    asrBaseUrl: asrBaseUrlValue(env.asrBaseUrl ?? env.ASR_BASE_URL, {
      nodeEnv,
      allowAsrTestLoopbackHttp,
    }),
    asrModel: optionalAsrModelValue(env.asrModel ?? env.ASR_MODEL),
    asrTimeoutMs,
    asrUploadMaxBytes,
    asrQuickMaxDurationMs,
    asrAssistantMaxDurationMs,
    asrFfprobeCommand: boundedAsrPathValue(
      env.asrFfprobeCommand ?? env.ASR_FFPROBE_COMMAND,
      ASR_CONFIG_DEFAULTS.ffprobeCommand,
      "ASR_FFPROBE_COMMAND",
    ),
    asrFfmpegCommand: boundedAsrPathValue(
      env.asrFfmpegCommand ?? env.ASR_FFMPEG_COMMAND,
      ASR_CONFIG_DEFAULTS.ffmpegCommand,
      "ASR_FFMPEG_COMMAND",
    ),
    asrTempRoot: boundedAsrPathValue(
      env.asrTempRoot ?? env.ASR_TEMP_ROOT,
      ASR_CONFIG_DEFAULTS.tempRoot,
      "ASR_TEMP_ROOT",
    ),
    asrReuseModelCredential: booleanValue(
      env.asrReuseModelCredential ?? env.ASR_REUSE_MODEL_CREDENTIAL,
      ASR_CONFIG_DEFAULTS.reuseModelCredential,
      "ASR_REUSE_MODEL_CREDENTIAL",
    ),
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
    proactiveAssistantAutoRun: booleanValue(
      env.proactiveAssistantAutoRun ?? env.PROACTIVE_ASSISTANT_AUTO_RUN,
      nodeEnv === "production",
      "PROACTIVE_ASSISTANT_AUTO_RUN",
    ),
    proactiveAssistantIntervalSeconds,
    proactiveAssistantIntervalMinutes,
    proactiveAssistantBatchSize,
    proactiveAssistantLeaseMs,
    proactiveAssistantRetryBaseMs,
    proactiveAssistantPollMs,
    proactiveAssistantModelConcurrency,
    proactiveAssistantModelRetryLimit,
    proactiveAssistantModelCacheTtlMs,
    proactiveAssistantModelOwnerDailyLimit,
    proactiveAssistantModelGlobalDailyLimit,
    proactiveAssistantModelBudgetTimezone,
    proactiveNotificationAutoRun: booleanValue(
      env.proactiveNotificationAutoRun ?? env.PROACTIVE_NOTIFICATION_AUTO_RUN,
      nodeEnv === "production",
      "PROACTIVE_NOTIFICATION_AUTO_RUN",
    ),
    proactiveNotificationPollMs,
    proactiveNotificationQuietStart,
    proactiveNotificationQuietEnd,
    proactiveNotificationHourlyLimit,
    proactiveNotificationDailyLimit,
    actionReminderAutoRun: booleanValue(
      env.actionReminderAutoRun ?? env.ACTION_REMINDER_AUTO_RUN,
      nodeEnv === "production",
      "ACTION_REMINDER_AUTO_RUN",
    ),
    actionReminderPollMs: (() => {
      const raw = env.actionReminderPollMs ?? env.ACTION_REMINDER_POLL_MS;
      if (raw === undefined || raw === null || raw === "") return 60_000;
      const parsed = boundedPositiveInteger(raw, "ACTION_REMINDER_POLL_MS", 600_000);
      if (parsed < 5_000) throw new Error("ACTION_REMINDER_POLL_MS must be at least 5000");
      return parsed;
    })(),
    invoiceEscalationAutoRun: booleanValue(
      env.invoiceEscalationAutoRun ?? env.INVOICE_ESCALATION_AUTO_RUN,
      false,
      "INVOICE_ESCALATION_AUTO_RUN",
    ),
    invoiceEscalationPollMs: (() => {
      const raw = env.invoiceEscalationPollMs ?? env.INVOICE_ESCALATION_POLL_MS;
      if (raw === undefined || raw === null || raw === "") return 60_000;
      const parsed = boundedPositiveInteger(raw, "INVOICE_ESCALATION_POLL_MS", 600_000);
      if (parsed < 5_000) throw new Error("INVOICE_ESCALATION_POLL_MS must be at least 5000");
      return parsed;
    })(),
    dailyDigestAutoRun: booleanValue(
      env.dailyDigestAutoRun ?? env.DAILY_DIGEST_AUTO_RUN,
      nodeEnv === "production",
      "DAILY_DIGEST_AUTO_RUN",
    ),
    dailyDigestTime: timeOfDayValue(
      env.dailyDigestTime ?? env.DAILY_DIGEST_TIME,
      "09:00",
      "DAILY_DIGEST_TIME",
    ),
    dailyDigestFridayTime: timeOfDayValue(
      env.dailyDigestFridayTime ?? env.DAILY_DIGEST_FRIDAY_TIME,
      "16:30",
      "DAILY_DIGEST_FRIDAY_TIME",
    ),
    dailyDigestPollMs: (() => {
      const raw = env.dailyDigestPollMs ?? env.DAILY_DIGEST_POLL_MS;
      if (raw === undefined || raw === null || raw === "") return 60_000;
      const parsed = boundedPositiveInteger(raw, "DAILY_DIGEST_POLL_MS", 600_000);
      if (parsed < 5_000) throw new Error("DAILY_DIGEST_POLL_MS must be at least 5000");
      return parsed;
    })(),
    // Synchronous time budget for the sales-decision stage review attached to
    // a confirmed forward stage move; on timeout the receipt tells the user to
    // pull the full analysis via 项目分析 instead of waiting.
    opportunityStageReviewBudgetMs: (() => {
      const raw = env.opportunityStageReviewBudgetMs ?? env.OPPORTUNITY_STAGE_REVIEW_BUDGET_MS;
      if (raw === undefined || raw === null || raw === "") return 8_000;
      const parsed = boundedPositiveInteger(raw, "OPPORTUNITY_STAGE_REVIEW_BUDGET_MS", 30_000);
      if (parsed < 1_000) throw new Error("OPPORTUNITY_STAGE_REVIEW_BUDGET_MS must be at least 1000");
      return parsed;
    })(),
    hospitalTenderPushplusToken: String(
      env.hospitalTenderPushplusToken ?? env.HOSPITAL_TENDER_PUSHPLUS_TOKEN ?? "",
    ).trim(),
    settingsEncryptionKey: String(
      env.settingsEncryptionKey ?? env.SETTINGS_ENCRYPTION_KEY ?? "",
    ).trim(),
    amapWebServiceKey: String(env.amapWebServiceKey ?? env.AMAP_WEB_SERVICE_KEY ?? "").trim(),
    amapTimeoutMs,
    amapMode,
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
    opsAlertToken: String(env.opsAlertToken ?? env.OPS_ALERT_TOKEN ?? "").trim(),
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
    weixinBookkeepingOwner: String(
      env.weixinBookkeepingOwner
      ?? env.WEIXIN_BOOKKEEPING_OWNER
      ?? env.AUTH_ACCOUNT
      ?? env.authAccount
      ?? "",
    ).trim(),
    weixinBookkeepingSenderId,
    weixinBookkeepingConfirmationEnabled: booleanValue(
      env.weixinBookkeepingConfirmationEnabled
        ?? env.WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED,
      false,
      "WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED",
    ),
    weixinAgentSessionHome: env.weixinAgentSessionHome ?? env.WEIXIN_AGENT_SESSION_HOME ?? "",
    weixinOutboxPollMs,
    weixinAllowedSenderIds,
    weixinAllowedGroupIds,
    weixinAllowGroups: booleanValue(
      env.weixinAllowGroups ?? env.WEIXIN_ALLOW_GROUPS,
      false,
      "WEIXIN_ALLOW_GROUPS",
    ),
    invoiceOcrCommand: String(env.invoiceOcrCommand ?? env.INVOICE_OCR_COMMAND ?? "").trim(),
    invoicePdfTextCommand: String(
      env.invoicePdfTextCommand ?? env.INVOICE_PDF_TEXT_COMMAND ?? "",
    ).trim(),
    invoicePdfImageCommand: executableValue(
      env.invoicePdfImageCommand ?? env.INVOICE_PDF_IMAGE_COMMAND ?? "pdftoppm",
      "INVOICE_PDF_IMAGE_COMMAND",
    ),
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
