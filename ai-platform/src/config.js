import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderPolicies } from "./providers/openAiCompatible.js";

import {
  AI_EXECUTION_MODE,
  AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER,
  AI_TARGET_MODEL,
  AI_TARGET_REASONING_EFFORT,
} from "../../shared/aiPlatformContract.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function text(value, fallback, max = 500) {
  const candidate = value === undefined || value === null || value === "" ? fallback : String(value);
  if (!candidate || candidate.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate)) {
    throw new Error("invalid AI platform configuration");
  }
  return candidate;
}

function positiveInteger(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error("invalid AI platform numeric configuration");
  return parsed;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error("invalid AI platform boolean configuration");
}

function fixedTarget(value, expected, name, max) {
  if (value === undefined || value === null || value === "") return expected;
  const candidate = String(value);
  if (candidate !== expected || candidate.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate)) {
    throw new Error(`${name} must be ${expected}`);
  }
  return expected;
}

export function loadAiPlatformConfig(overrides = {}, env = process.env) {
  const nodeEnv = text(overrides.nodeEnv ?? env.NODE_ENV, "development", 40);
  const host = text(overrides.host ?? env.AI_PLATFORM_HOST, "127.0.0.1", 200);
  const port = positiveInteger(overrides.port ?? env.AI_PLATFORM_PORT, 18997, 65_535);
  const databasePathValue = text(
    overrides.databasePath ?? env.AI_PLATFORM_DATABASE,
    ".runtime/ai-platform/ai-platform.sqlite",
    1_000,
  );
  const databasePath = databasePathValue === ":memory:"
    ? databasePathValue
    : (isAbsolute(databasePathValue) ? databasePathValue : resolve(PROJECT_ROOT, databasePathValue));
  const authSecret = text(overrides.authSecret ?? env.AI_PLATFORM_AUTH_SECRET, "ai-platform-development-secret-change-me", 4_000);
  const externalProvidersEnabled = booleanValue(
    overrides.externalProvidersEnabled ?? env.AI_PLATFORM_EXTERNAL_PROVIDERS,
    false,
  );
  const staticDirectoryValue = text(
    overrides.staticDirectory ?? env.AI_PLATFORM_STATIC_DIRECTORY,
    "outputs/ai-platform-admin",
    2_000,
  );
  const staticDirectory = isAbsolute(staticDirectoryValue)
    ? staticDirectoryValue
    : resolve(PROJECT_ROOT, staticDirectoryValue);
  const approvedOrigins = overrides.providerAllowedOrigins ?? String(env.AI_PLATFORM_PROVIDER_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
  if (!Array.isArray(approvedOrigins) || approvedOrigins.length > 8
    || approvedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.origin !== origin || url.username || url.password;
      } catch { return true; }
    })) throw new Error("invalid AI platform provider allowed origins");
  const providerPolicies = normalizeProviderPolicies(overrides.providerPolicies ?? env.AI_PLATFORM_PROVIDER_POLICIES ?? [], {
    allowedOrigins: approvedOrigins,
    allowTestLoopback: nodeEnv === "test" && overrides.allowProviderTestLoopback === true,
  });
  const config = {
    nodeEnv,
    host,
    port,
    databasePath,
    mediaDirectory: overrides.mediaDirectory ?? env.AI_PLATFORM_MEDIA_DIRECTORY ?? null,
    mediaEncryptionKey: overrides.mediaEncryptionKey ?? env.AI_PLATFORM_MEDIA_ENCRYPTION_KEY ?? null,
    mediaMaxBytes: positiveInteger(overrides.mediaMaxBytes ?? env.AI_PLATFORM_MEDIA_MAX_BYTES, 16 * 1024 * 1024, 32 * 1024 * 1024),
    mediaCapacityBytes: positiveInteger(overrides.mediaCapacityBytes ?? env.AI_PLATFORM_MEDIA_CAPACITY_BYTES, 64 * 1024 * 1024, 256 * 1024 * 1024),
    pdfImageCommand: text(overrides.pdfImageCommand ?? env.AI_PLATFORM_PDF_IMAGE_COMMAND, "/usr/bin/pdftoppm", 1000),
    authSecret,
    trustedIssuer: text(overrides.trustedIssuer ?? env.AI_PLATFORM_TRUSTED_ISSUER, "sentelligent-sales-backend", 400),
    requestBindingRequired: booleanValue(overrides.requestBindingRequired ?? env.AI_PLATFORM_REQUEST_BINDING_REQUIRED, nodeEnv === "production"),
    externalProvidersEnabled,
    providerPolicies,
    providerAllowedOrigins: Object.freeze(approvedOrigins.slice()),
    staticDirectory,
    targetModel: fixedTarget(
      overrides.targetModel ?? env.AI_PLATFORM_TARGET_MODEL,
      AI_TARGET_MODEL,
      "AI_PLATFORM_TARGET_MODEL",
      200,
    ),
    targetReasoningEffort: fixedTarget(
      overrides.targetReasoningEffort ?? env.AI_PLATFORM_TARGET_REASONING_EFFORT,
      AI_TARGET_REASONING_EFFORT,
      "AI_PLATFORM_TARGET_REASONING_EFFORT",
      40,
    ),
    executionMode: text(
      overrides.executionMode ?? env.AI_PLATFORM_EXECUTION_MODE,
      AI_EXECUTION_MODE,
      40,
    ),
    proactiveScheduleOwner: fixedTarget(
      overrides.proactiveScheduleOwner ?? env.AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER,
      AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER,
      "AI_PLATFORM_PROACTIVE_SCHEDULE_OWNER",
      40,
    ),
    bodyLimitBytes: positiveInteger(overrides.bodyLimitBytes ?? env.AI_PLATFORM_BODY_LIMIT_BYTES, 512 * 1024, 8 * 1024 * 1024),
    taskLeaseMs: positiveInteger(overrides.taskLeaseMs ?? env.AI_PLATFORM_TASK_LEASE_MS, 60_000, 10 * 60_000),
    taskTimeoutMaxMs: positiveInteger(overrides.taskTimeoutMaxMs ?? env.AI_PLATFORM_TASK_TIMEOUT_MAX_MS, 10 * 60_000, 10 * 60_000),
    taskPollMs: positiveInteger(overrides.taskPollMs ?? env.AI_PLATFORM_TASK_POLL_MS, 500, 60_000),
    taskConcurrency: positiveInteger(overrides.taskConcurrency ?? env.AI_PLATFORM_TASK_CONCURRENCY, 2, 20),
    taskOwnerConcurrency: positiveInteger(overrides.taskOwnerConcurrency ?? env.AI_PLATFORM_TASK_OWNER_CONCURRENCY, 2, 20),
    taskQueueLimit: positiveInteger(overrides.taskQueueLimit ?? env.AI_PLATFORM_TASK_QUEUE_LIMIT, 1_000, 100_000),
    taskRetentionDays: positiveInteger(overrides.taskRetentionDays ?? env.AI_PLATFORM_TASK_RETENTION_DAYS, 30, 3650),
    drainTimeoutMs: positiveInteger(overrides.drainTimeoutMs ?? env.AI_PLATFORM_DRAIN_TIMEOUT_MS, 180_000, 15 * 60_000),
    taskAdmissionEnabled: booleanValue(overrides.taskAdmissionEnabled ?? env.AI_PLATFORM_TASK_ADMISSION_ENABLED, nodeEnv !== "production"),
    adminEnabled: booleanValue(overrides.adminEnabled ?? env.AI_PLATFORM_ADMIN_ENABLED, true),
  };
  if (!new Set(["local-simulated", "external-provider"]).has(config.executionMode)) {
    throw new Error("AI_PLATFORM_EXECUTION_MODE is invalid");
  }
  if (config.executionMode === "external-provider" && !config.externalProvidersEnabled) {
    throw new Error("external-provider execution requires AI_PLATFORM_EXTERNAL_PROVIDERS=true");
  }
  if (nodeEnv === "production") {
    if (!config.requestBindingRequired) throw new Error("request binding is required in production");
    if (!["127.0.0.1", "::1"].includes(config.host)) throw new Error("AI platform must bind to loopback in production");
    if (!config.pdfImageCommand.startsWith("/")) throw new Error("AI platform PDF command must be absolute in production");
    if (config.authSecret.length < 32 || config.authSecret.includes("change-me")) {
      throw new Error("AI_PLATFORM_AUTH_SECRET must be a strong production secret");
    }
  }
  return Object.freeze(config);
}
