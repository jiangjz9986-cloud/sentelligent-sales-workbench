import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";

const serviceName = "sentelligent-sales-workbench";

function isPosixAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function resolveRuntimePath(value) {
  return isPosixAbsolutePath(value) ? value : resolve(value);
}

function joinRuntimePath(root, ...parts) {
  return isPosixAbsolutePath(root) ? posix.join(root, ...parts) : join(root, ...parts);
}

export function parseOptions(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, rawValue] = arg.slice(2).split("=");
    const key = rawKey.replaceAll("-", "_");
    if (rawValue !== undefined) {
      options[key] = rawValue;
    } else if (rest[index + 1] && !rest[index + 1].startsWith("--")) {
      options[key] = rest[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return {
    command,
    options: normalizeOptions(options),
  };
}

export function normalizeOptions(options = {}) {
  return {
    runtimeRoot: options.runtime_root,
    databaseUrl: options.database_url,
    backupDir: options.backup_dir,
    backupPath: options.backup_path,
    label: options.label,
    host: options.host,
    port: options.port,
    aiAnalysisMode: options.ai_analysis_mode,
    modelProvider: options.model_provider,
    seed: options.seed,
  };
}

export function createRuntimeConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const runtimeRoot = resolveRuntimePath(
    env.runtimeRoot ??
      env.SENT_ZX_RUNTIME_ROOT ??
      join(homedir(), `.${serviceName}`),
  );
  const dataDir = joinRuntimePath(runtimeRoot, "data");
  const logDir = joinRuntimePath(runtimeRoot, "logs");
  const stateDir = joinRuntimePath(runtimeRoot, "runtime");
  const backupDir = resolveRuntimePath(env.backupDir ?? env.SENT_ZX_BACKUP_DIR ?? joinRuntimePath(runtimeRoot, "backups"));
  const databaseUrl = String(
    env.databaseUrl ??
      env.DATABASE_URL ??
      joinRuntimePath(dataDir, "sales-workbench.sqlite"),
  );

  return {
    serviceName,
    runtimeRoot,
    dataDir,
    logDir,
    stateDir,
    backupDir,
    backupPath: env.backupPath,
    label: env.label,
    databaseUrl,
    statePath: joinRuntimePath(stateDir, "backend-service.json"),
    logPath: joinRuntimePath(logDir, "backend.log"),
    host: env.host ?? env.HOST ?? "127.0.0.1",
    port: Number(env.port ?? env.PORT ?? 8897),
    aiAnalysisMode: env.aiAnalysisMode ?? env.AI_ANALYSIS_MODE,
    modelProvider: env.modelProvider ?? env.MODEL_PROVIDER ?? "",
    seed: env.seed === false || env.seed === "false" ? false : true,
  };
}

export function ensureRuntimeDirs(config) {
  for (const path of [config.dataDir, config.logDir, config.stateDir, config.backupDir, dirname(config.databaseUrl)]) {
    mkdirSync(path, { recursive: true });
  }
}

export function buildServiceEnvironment(config) {
  const env = {
    PORT: String(config.port),
    HOST: config.host,
    DATABASE_URL: config.databaseUrl,
  };
  if (config.aiAnalysisMode) env.AI_ANALYSIS_MODE = config.aiAnalysisMode;
  if (config.modelProvider) env.MODEL_PROVIDER = config.modelProvider;
  return env;
}

export function publicConfig(config) {
  return {
    serviceName: config.serviceName,
    runtimeRoot: config.runtimeRoot,
    databaseUrl: config.databaseUrl,
    backupDir: config.backupDir,
    statePath: config.statePath,
    logPath: config.logPath,
    host: config.host,
    port: config.port,
    aiAnalysisMode: config.aiAnalysisMode,
    seed: config.seed,
  };
}
