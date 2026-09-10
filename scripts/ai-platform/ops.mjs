#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, fsyncSync, openSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../..");
const SERVICE_NAME = "sentelligent-ai-unified-platform";
const ENTRY_RELATIVE_PATH = "ai-platform/src/cli.js";
const DEFAULT_PORT = 18997;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WAIT_SECONDS = 45;
const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_RETENTION_COUNT = 14;
const MAX_HEALTH_BODY_BYTES = 1024 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

class OpsError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function fail(code, message, details = {}, exitCode = 1) {
  throw new OpsError(code, message, details, exitCode);
}

function usage() {
  return [
    "Usage: <start.sh|stop.sh|status.sh|health.sh|backup.sh|restore.sh> [options]",
    "",
    "Common options:",
    "  --root=<path>              AI platform worktree or release root",
    "  --host=<host>              Bind/health host (default 127.0.0.1)",
    "  --port=<1..65535>          API port (default 18997)",
    "  --database=<path>          SQLite path (default <root>/.runtime/ai-platform/ai-platform.sqlite)",
    "  --runtime-dir=<path>       Private PID/runtime directory",
    "  --pid-file=<path>          PID file inside runtime directory",
    "  --runtime-file=<path>      Runtime JSON file inside runtime directory",
    "  --log-file=<path>          Application stdout/stderr log",
    "  --node=<path>              Node.js executable used by the platform",
    "  --wait-seconds=<n>         Start/health wait limit",
    "  --timeout-seconds=<n>      Stop/request timeout",
    "  --format=json|text         Output format (default json)",
    "  --force                    Stop may use SIGKILL after a verified timeout; restore may replace a database",
    "  --help                    Show this help",
    "",
    "Backup options:",
    "  --backup-dir=<path>        Backup directory (default <runtime-dir>/backups)",
    "  --backup-file=<path>       Explicit backup source or destination",
    "  --keep=<n>                 Number of matching backups to retain (default 14)",
    "",
    "No option accepts a secret. Provider credentials must remain in an external environment file.",
  ].join("\n");
}

function normalizeOptionName(name) {
  return name.replaceAll("-", "_");
}

function parseArgs(argv) {
  const knownValueOptions = new Set([
    "root",
    "host",
    "port",
    "database",
    "runtime_dir",
    "pid_file",
    "runtime_file",
    "log_file",
    "node",
    "wait_seconds",
    "timeout_seconds",
    "format",
    "backup_dir",
    "backup_file",
    "keep",
  ]);
  const knownBooleanOptions = new Set(["force", "help", "json", "text"]);
  let command = argv[0] ?? "status";
  if (command === "serve") command = "start";
  const options = {};
  const explicit = new Set();

  if (command.startsWith("--")) {
    command = "status";
    argv = ["status", ...argv];
  }
  if (!["start", "stop", "status", "health", "backup", "restore"].includes(command)) {
    fail("invalid_command", `unknown AI platform operations command: ${command}`);
  }

  for (let index = 1; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (!argument.startsWith("--")) fail("invalid_argument", `unexpected positional argument: ${argument}`);
    const equalIndex = argument.indexOf("=");
    const rawName = equalIndex >= 0 ? argument.slice(2, equalIndex) : argument.slice(2);
    const name = normalizeOptionName(rawName);
    if (!knownValueOptions.has(name) && !knownBooleanOptions.has(name)) {
      fail("invalid_argument", `unknown option: --${rawName}`);
    }
    if (knownBooleanOptions.has(name)) {
      if (equalIndex >= 0) fail("invalid_argument", `boolean option cannot use a value: --${rawName}`);
      if (name === "json" || name === "text") options.format = name;
      else options[name] = true;
      explicit.add(name);
      continue;
    }
    let value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : null;
    if (value === null) {
      if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) {
        fail("invalid_argument", `option requires a value: --${rawName}`);
      }
      index += 1;
      value = String(argv[index]);
    }
    if (value.length === 0) fail("invalid_argument", `option value cannot be empty: --${rawName}`);
    options[name] = value;
    explicit.add(name);
  }
  return { command, options, explicit };
}

function environmentOptions() {
  return {
    root: process.env.AI_PLATFORM_OPS_ROOT,
    host: process.env.AI_PLATFORM_OPS_HOST,
    port: process.env.AI_PLATFORM_OPS_PORT,
    database: process.env.AI_PLATFORM_OPS_DATABASE,
    runtime_dir: process.env.AI_PLATFORM_OPS_RUNTIME_DIR,
    pid_file: process.env.AI_PLATFORM_OPS_PID_FILE,
    runtime_file: process.env.AI_PLATFORM_OPS_RUNTIME_FILE,
    log_file: process.env.AI_PLATFORM_OPS_LOG_FILE,
    node: process.env.AI_PLATFORM_OPS_NODE,
    wait_seconds: process.env.AI_PLATFORM_OPS_WAIT_SECONDS,
    timeout_seconds: process.env.AI_PLATFORM_OPS_TIMEOUT_SECONDS,
    backup_dir: process.env.AI_PLATFORM_OPS_BACKUP_DIR,
    backup_file: process.env.AI_PLATFORM_OPS_BACKUP_FILE,
    keep: process.env.AI_PLATFORM_OPS_KEEP,
  };
}

function mergeOptions(cliOptions) {
  const env = environmentOptions();
  const merged = { ...env };
  for (const [key, value] of Object.entries(cliOptions)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function assertSafeText(value, label) {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("invalid_configuration", `${label} contains an invalid value`);
  }
  return value;
}

function parsePositiveInteger(value, fallback, label, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) fail("invalid_configuration", `${label} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    fail("invalid_configuration", `${label} is outside the supported range`);
  }
  return parsed;
}

function resolveInputPath(root, value, base = root) {
  assertSafeText(String(value), "path");
  return isAbsolute(String(value)) ? resolve(String(value)) : resolve(base, String(value));
}

async function canonicalExistingDirectory(input, label) {
  const candidate = resolve(String(input));
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") fail("path_unavailable", `${label} does not exist: ${candidate}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("path_unavailable", `${label} is not a real directory: ${candidate}`);
  return realpath(candidate);
}

async function assertDirectory(path, label, { create = false, mode = 0o700 } = {}) {
  if (create) await mkdir(path, { recursive: true, mode });
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail("path_unavailable", `${label} is unavailable: ${path}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail("path_unavailable", `${label} is not a real directory: ${path}`);
  if (create) await chmod(path, mode);
  return path;
}

async function assertRegularOrAbsent(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail("unsafe_path", `${label} must not be a symbolic link: ${path}`);
    if (!info.isFile()) fail("unsafe_path", `${label} must be a regular file: ${path}`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureParentDirectory(path, label) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertDirectory(parent, `${label} parent`);
}

function isWithin(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function buildConfig(rawOptions) {
  const rootInput = rawOptions.root ?? DEFAULT_ROOT;
  const root = await canonicalExistingDirectory(rootInput, "AI platform root");
  const entry = resolve(root, ENTRY_RELATIVE_PATH);
  const entryExists = await assertRegularOrAbsent(entry, "AI platform entrypoint");
  if (!entryExists) fail("path_unavailable", `AI platform entrypoint is unavailable: ${entry}`);

  const runtimeDirInput = rawOptions.runtime_dir ?? resolve(root, ".runtime", "ai-platform");
  const runtimeDir = resolveInputPath(root, runtimeDirInput, root);
  const databaseInput = rawOptions.database ?? resolve(runtimeDir, "ai-platform.sqlite");
  if (databaseInput === ":memory:") fail("invalid_configuration", "a persistent database path is required");
  const database = resolveInputPath(root, databaseInput, root);

  const pidFile = resolveInputPath(
    root,
    rawOptions.pid_file ?? resolve(runtimeDir, "ai-platform.pid"),
    runtimeDir,
  );
  const runtimeFile = resolveInputPath(
    root,
    rawOptions.runtime_file ?? resolve(runtimeDir, "runtime.json"),
    runtimeDir,
  );
  const logFile = resolveInputPath(
    root,
    rawOptions.log_file ?? resolve(runtimeDir, "ai-platform.log"),
    runtimeDir,
  );
  if (!isWithin(runtimeDir, pidFile) || !isWithin(runtimeDir, runtimeFile)) {
    fail("unsafe_path", "PID and runtime files must remain inside the private runtime directory");
  }

  const host = assertSafeText(String(rawOptions.host ?? DEFAULT_HOST), "host");
  if (!/^[A-Za-z0-9:.%_-]+$/u.test(host)) fail("invalid_configuration", "host contains unsupported characters");
  const port = parsePositiveInteger(rawOptions.port, DEFAULT_PORT, "port", 65_535);
  const waitSeconds = parsePositiveInteger(rawOptions.wait_seconds, DEFAULT_WAIT_SECONDS, "wait-seconds", 300);
  const timeoutSeconds = parsePositiveInteger(rawOptions.timeout_seconds, DEFAULT_TIMEOUT_SECONDS, "timeout-seconds", 300);
  const keep = parsePositiveInteger(rawOptions.keep, DEFAULT_RETENTION_COUNT, "keep", 10_000);
  const format = rawOptions.format ?? "json";
  if (format !== "json" && format !== "text") fail("invalid_configuration", "format must be json or text");

  const nodeInput = rawOptions.node ?? process.execPath;
  const nodeBin = resolveInputPath(root, nodeInput, root);
  try {
    await access(nodeBin, fsConstants.X_OK);
  } catch {
    fail("path_unavailable", `Node executable is unavailable or not executable: ${nodeBin}`);
  }

  const backupDir = resolveInputPath(
    root,
    rawOptions.backup_dir ?? resolve(runtimeDir, "backups"),
    root,
  );
  const backupFile = rawOptions.backup_file
    ? resolveInputPath(root, rawOptions.backup_file, root)
    : null;

  return Object.freeze({
    service: SERVICE_NAME,
    root,
    entry,
    cwd: root,
    host,
    port,
    database,
    runtimeDir,
    pidFile,
    runtimeFile,
    logFile,
    nodeBin,
    waitSeconds,
    timeoutSeconds,
    keep,
    format,
    backupDir,
    backupFile,
    commandArgs: [entry, "start", `--host=${host}`, `--port=${port}`, `--database=${database}`],
  });
}

async function readJsonFile(path, label) {
  const exists = await assertRegularOrAbsent(path, label);
  if (!exists) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("runtime_invalid", `${label} is not valid JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("runtime_invalid", `${label} must contain a JSON object: ${path}`);
  }
  return parsed;
}

async function resolveCommandContext(parsed) {
  let options = mergeOptions(parsed.options);
  let config = await buildConfig(options);
  let runtime = null;
  if (["start", "stop", "status", "health", "restore"].includes(parsed.command)) {
    runtime = await readJsonFile(config.runtimeFile, "runtime file");
    if (runtime?.service === SERVICE_NAME) {
      if (runtime.root !== undefined && resolve(String(runtime.root)) !== config.root) {
        fail("runtime_invalid", "runtime file points outside the selected AI platform root", {
          runtimeFile: config.runtimeFile,
        });
      }
      const runtimeFields = [
        ["root", "root"],
        ["host", "host"],
        ["port", "port"],
        ["database", "database"],
        ["runtimeDir", "runtime_dir"],
        ["pidFile", "pid_file"],
        ["runtimeFile", "runtime_file"],
        ["logFile", "log_file"],
        ["node", "node"],
      ];
      const merged = { ...options };
      for (const [runtimeKey, optionKey] of runtimeFields) {
        if (!parsed.explicit.has(optionKey) && runtime[runtimeKey] !== undefined && runtime[runtimeKey] !== null) {
          merged[optionKey] = String(runtime[runtimeKey]);
        }
      }
      options = merged;
      config = await buildConfig(options);
      runtime = await readJsonFile(config.runtimeFile, "runtime file");
    }
    if (runtime && runtime.service !== SERVICE_NAME) {
      fail("runtime_invalid", "runtime file belongs to another service", { runtimeFile: config.runtimeFile });
    }
  }
  return { config, runtime, parsed };
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await ensureParentDirectory(path, "JSON file");
  await assertRegularOrAbsent(path, "JSON file");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });
  await chmod(temporary, mode);
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  await rename(temporary, path);
  const parentDescriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

async function writePidFile(path, pid) {
  await ensureParentDirectory(path, "PID file");
  const existing = await assertRegularOrAbsent(path, "PID file");
  if (existing) fail("runtime_conflict", `PID file already exists: ${path}`);
  await writeFile(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function readPidFile(path) {
  const exists = await assertRegularOrAbsent(path, "PID file");
  if (!exists) return null;
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[1-9][0-9]*$/u.test(value)) fail("runtime_invalid", `PID file is malformed: ${path}`);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) fail("runtime_invalid", `PID file contains an unsafe PID: ${path}`);
  return pid;
}

async function removeOwnedRuntimeFile(path, label) {
  const exists = await assertRegularOrAbsent(path, label);
  if (exists) await rm(path, { force: false });
}

async function acquireLock(runtimeDir, name) {
  await assertDirectory(runtimeDir, "runtime directory", { create: true, mode: 0o700 });
  const lockPath = resolve(runtimeDir, `.${name}.lock`);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("operation_locked", `another AI platform ${name} operation is running, or a stale lock needs review: ${lockPath}`);
    }
    throw error;
  }
  try {
    await writeFile(resolve(lockPath, "owner"), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return async () => {
    let info;
    try {
      info = await lstat(lockPath);
    } catch {
      return;
    }
    if (!info.isSymbolicLink() && info.isDirectory()) {
      await rm(lockPath, { recursive: true, force: false });
    }
  };
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout ?? "").trim();
}

function normalizeCommandLine(value) {
  return String(value ?? "").replaceAll("\\", "/").replaceAll("'", "").replaceAll('"', "");
}

async function readLinuxProcessInfo(pid) {
  try {
    const [commandBuffer, cwd, executable, statText] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`),
      readlink(`/proc/${pid}/cwd`),
      realpath(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandTokens = commandBuffer.toString("utf8").split("\0").filter(Boolean);
    const closingParenthesis = statText.lastIndexOf(")");
    const statFields = closingParenthesis >= 0 ? statText.slice(closingParenthesis + 2).trim().split(/\s+/u) : [];
    return {
      pid,
      commandTokens,
      commandLine: commandTokens.join(" "),
      cwd,
      executable,
      startMarker: statFields[19] ?? null,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function readMacProcessInfo(pid) {
  const commandLine = runCapture("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  if (!commandLine) return null;
  const cwdOutput = runCapture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = cwdOutput.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  const startMarker = runCapture("ps", ["-p", String(pid), "-o", "lstart="]) || null;
  const commandTokens = commandLine.split(/\s+/u).filter(Boolean);
  return {
    pid,
    commandTokens,
    commandLine,
    cwd,
    executable: commandTokens[0] ?? null,
    startMarker,
  };
}

async function readProcessInfo(pid) {
  if (process.platform === "linux") return readLinuxProcessInfo(pid);
  return readMacProcessInfo(pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function expectedCommandNeedles(config) {
  return [
    normalizeCommandLine(config.entry),
    " start",
    `--host=${normalizeCommandLine(config.host)}`,
    `--port=${config.port}`,
    `--database=${normalizeCommandLine(config.database)}`,
  ];
}

function processMatchesConfig(info, config, runtime = null) {
  if (!info || !info.cwd || resolve(info.cwd) !== resolve(config.cwd)) return { owned: false, reason: "working_directory_mismatch" };
  const normalizedCommand = normalizeCommandLine(info.commandLine);
  const missing = expectedCommandNeedles(config).find((needle) => !normalizedCommand.includes(needle));
  if (missing) return { owned: false, reason: `command_mismatch:${missing}` };
  const executableName = basename(String(info.executable ?? "")).toLowerCase();
  const expectedExecutableName = basename(config.nodeBin).toLowerCase();
  if (executableName !== expectedExecutableName && !["node", "nodejs"].includes(executableName)) {
    return { owned: false, reason: "executable_mismatch" };
  }
  if (runtime?.pidStartMarker && info.startMarker && String(runtime.pidStartMarker) !== String(info.startMarker)) {
    return { owned: false, reason: "pid_reused" };
  }
  return { owned: true, reason: "verified" };
}

async function inspectProcessOwnership(config, pid, runtime = null) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { alive: false, owned: false, reason: "invalid_pid", info: null };
  if (!processIsAlive(pid)) return { alive: false, owned: false, reason: "not_running", info: null };
  let info;
  try {
    info = await readProcessInfo(pid);
  } catch (error) {
    return { alive: true, owned: false, reason: `inspection_failed:${error.message}`, info: null };
  }
  if (!info) return { alive: false, owned: false, reason: "not_running", info: null };
  const match = processMatchesConfig(info, config, runtime);
  return { alive: true, ...match, info };
}

async function probePort(host, port) {
  return new Promise((resolveProbe) => {
    const server = createNetServer();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch {}
      resolveProbe(result);
    };
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") finish({ inUse: true, error: "address_in_use" });
      else finish({ inUse: false, error: error?.code ?? error?.message ?? "port_probe_failed" });
    });
    server.listen({ host, port }, () => finish({ inUse: false, error: null }));
  });
}

function portDetails(port) {
  const lsof = runCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (lsof) return lsof;
  const ss = runCapture("ss", ["-H", "-ltn", `sport = :${port}`]);
  if (ss) return ss;
  const netstat = runCapture("netstat", ["-an", "-p", "tcp"]);
  const matching = netstat.split("\n").filter((line) => line.includes(`.${port}`) && /LISTEN/u.test(line));
  return matching.join("\n");
}

function hostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function requestHealth(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  const endpoint = `http://${hostForUrl(config.host)}:${config.port}/healthz`;
  try {
    const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_HEALTH_BODY_BYTES) {
      return { endpoint, httpStatus: response.status, ok: false, error: "health_response_too_large" };
    }
    let body = null;
    try { body = JSON.parse(bodyText); } catch { body = null; }
    const ok = response.status === 200 && body?.status === "ok" && body?.database === "ready";
    return { endpoint, httpStatus: response.status, ok, body, ...(ok ? {} : { error: "health_not_ready" }) };
  } catch (error) {
    return {
      endpoint,
      httpStatus: null,
      ok: false,
      error: error?.name === "AbortError" ? "health_timeout" : "health_unreachable",
      message: error?.message ?? "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(config, pid) {
  const deadline = Date.now() + config.waitSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    if (pid && !processIsAlive(pid)) break;
    last = await requestHealth(config);
    if (last.ok) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return last ?? { endpoint: `http://${hostForUrl(config.host)}:${config.port}/healthz`, ok: false, error: "health_timeout" };
}

function runtimePayload(config, pid, state, startedAt, readyAt, processInfo) {
  return {
    schemaVersion: 1,
    service: config.service,
    state,
    pid,
    root: config.root,
    cwd: config.cwd,
    entry: config.entry,
    node: config.nodeBin,
    host: config.host,
    port: config.port,
    database: config.database,
    runtimeDir: config.runtimeDir,
    pidFile: config.pidFile,
    runtimeFile: config.runtimeFile,
    logFile: config.logFile,
    command: [config.nodeBin, ...config.commandArgs],
    startedAt,
    ...(readyAt ? { readyAt } : {}),
    ...(processInfo?.startMarker ? { pidStartMarker: String(processInfo.startMarker) } : {}),
  };
}

function publicRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") return null;
  const keys = [
    "schemaVersion",
    "service",
    "state",
    "pid",
    "root",
    "cwd",
    "entry",
    "node",
    "host",
    "port",
    "database",
    "runtimeDir",
    "pidFile",
    "runtimeFile",
    "logFile",
    "startedAt",
    "readyAt",
  ];
  return Object.fromEntries(keys.filter((key) => runtime[key] !== undefined).map((key) => [key, runtime[key]]));
}

async function prepareRuntimeFiles(config) {
  await assertDirectory(config.runtimeDir, "runtime directory", { create: true, mode: 0o700 });
  await ensureParentDirectory(config.pidFile, "PID file");
  await ensureParentDirectory(config.runtimeFile, "runtime file");
  await ensureParentDirectory(config.logFile, "log file");
  await ensureParentDirectory(config.database, "database");
  await assertRegularOrAbsent(config.pidFile, "PID file");
  await assertRegularOrAbsent(config.runtimeFile, "runtime file");
  await assertRegularOrAbsent(config.logFile, "log file");
  await assertRegularOrAbsent(config.database, "database");
  const logExists = await assertRegularOrAbsent(config.logFile, "log file");
  if (!logExists) await writeFile(config.logFile, "", { flag: "wx", mode: 0o600 });
  await chmod(config.logFile, 0o600);
  const databaseExists = await assertRegularOrAbsent(config.database, "database");
  if (databaseExists) await chmod(config.database, 0o600);
}

async function hardenDatabaseFile(config) {
  const exists = await assertRegularOrAbsent(config.database, "database");
  if (!exists) fail("database_unavailable", `database was not created: ${config.database}`);
  await chmod(config.database, 0o600);
}

async function spawnPlatform(config) {
  const logDescriptor = openSync(config.logFile, "a", 0o600);
  let child;
  try {
    child = spawn(config.nodeBin, config.commandArgs, {
      cwd: config.cwd,
      detached: true,
      env: {
        ...process.env,
        AI_PLATFORM_HOST: config.host,
        AI_PLATFORM_PORT: String(config.port),
        AI_PLATFORM_DATABASE: config.database,
      },
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
  } finally {
    closeSync(logDescriptor);
  }
  child.unref();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) fail("start_failed", "platform process did not return a safe PID");
  return child;
}

async function startCommand(config) {
  const releaseLock = await acquireLock(config.runtimeDir, "operation");
  try {
    const pidExists = await assertRegularOrAbsent(config.pidFile, "PID file");
    const runtimeExists = await assertRegularOrAbsent(config.runtimeFile, "runtime file");
    const existingRuntime = runtimeExists ? await readJsonFile(config.runtimeFile, "runtime file") : null;
    if (pidExists !== runtimeExists) {
      fail("runtime_incomplete", "PID and runtime files must either both exist or both be absent", {
        pidFile: config.pidFile,
        runtimeFile: config.runtimeFile,
      });
    }
    if (pidExists && existingRuntime?.service !== SERVICE_NAME) {
      fail("runtime_conflict", "existing runtime file belongs to another service");
    }
    if (pidExists) {
      const existingPid = await readPidFile(config.pidFile);
      const ownership = await inspectProcessOwnership(config, existingPid, existingRuntime);
      if (ownership.alive && ownership.owned) {
        return {
          status: "already_running",
          service: SERVICE_NAME,
          pid: existingPid,
          port: config.port,
          database: config.database,
          runtimeFile: config.runtimeFile,
          health: await requestHealth(config),
        };
      }
      if (ownership.alive && !ownership.owned) {
        fail("ownership_mismatch", "refusing to replace a live process that does not match the AI platform fingerprint", {
          pid: existingPid,
          reason: ownership.reason,
        });
      }
      await removeOwnedRuntimeFile(config.pidFile, "PID file");
      await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
    }

    await prepareRuntimeFiles(config);
    const portProbe = await probePort(config.host, config.port);
    if (portProbe.inUse) {
      fail("port_in_use", `port ${config.port} is already in use; no process was stopped`, {
        host: config.host,
        port: config.port,
        details: portDetails(config.port) || null,
      });
    }

    const startedAt = new Date().toISOString();
    const child = await spawnPlatform(config);
    const pid = child.pid;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const initialOwnership = await inspectProcessOwnership(config, pid);
    if (!initialOwnership.alive || !initialOwnership.owned) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await waitForProcessExit(pid, config.timeoutSeconds * 1000);
      fail("start_failed", "new process did not pass the ownership fingerprint", {
        pid,
        reason: initialOwnership.reason,
      });
    }
    await writePidFile(config.pidFile, pid);
    const startingRuntime = runtimePayload(config, pid, "starting", startedAt, null, initialOwnership.info);
    await writeJsonAtomic(config.runtimeFile, startingRuntime, 0o600);

    const health = await waitForHealth(config, pid);
    if (!health.ok) {
      const currentOwnership = await inspectProcessOwnership(config, pid, startingRuntime);
      let processStopped = !currentOwnership.alive;
      if (currentOwnership.alive && currentOwnership.owned) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        processStopped = await waitForProcessExit(pid, config.timeoutSeconds * 1000);
      }
      if (processStopped) {
        await removeOwnedRuntimeFile(config.pidFile, "PID file");
        await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
      }
      fail("start_failed", "AI platform did not become healthy before the start deadline", {
        pid,
        health,
        logFile: config.logFile,
        ...(processStopped ? {} : {
          pidFile: config.pidFile,
          runtimeFile: config.runtimeFile,
          reason: currentOwnership.owned ? "process_still_running_after_sigterm" : currentOwnership.reason,
        }),
      });
    }
    const readyAt = new Date().toISOString();
    await hardenDatabaseFile(config);
    await writeJsonAtomic(
      config.runtimeFile,
      runtimePayload(config, pid, "running", startedAt, readyAt, initialOwnership.info),
      0o600,
    );
    return {
      status: "started",
      service: SERVICE_NAME,
      pid,
      host: config.host,
      port: config.port,
      database: config.database,
      logFile: config.logFile,
      runtimeFile: config.runtimeFile,
      health,
    };
  } finally {
    await releaseLock();
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return !processIsAlive(pid);
}

async function stopCommand(config, runtime) {
  const releaseLock = await acquireLock(config.runtimeDir, "operation");
  try {
    const pid = await readPidFile(config.pidFile);
    const runtimeExists = await assertRegularOrAbsent(config.runtimeFile, "runtime file");
    if (pid !== null && !runtimeExists) {
      fail("runtime_incomplete", "PID file exists without a runtime file; refusing to signal the PID", {
        pidFile: config.pidFile,
        runtimeFile: config.runtimeFile,
      });
    }
    if (pid === null) {
      if (runtimeExists) {
        fail("runtime_incomplete", "runtime file exists without a PID file; refusing cleanup", { runtimeFile: config.runtimeFile });
      }
      return { status: "already_stopped", service: SERVICE_NAME, runtimeFile: config.runtimeFile };
    }
    const ownership = await inspectProcessOwnership(config, pid, runtime);
    if (ownership.alive && !ownership.owned) {
      fail("ownership_mismatch", "refusing to signal a process that does not match the AI platform fingerprint", {
        pid,
        reason: ownership.reason,
      });
    }
    if (!ownership.alive) {
      await removeOwnedRuntimeFile(config.pidFile, "PID file");
      if (runtimeExists) await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
      return { status: "already_stopped", service: SERVICE_NAME, pid, runtimeFile: config.runtimeFile };
    }

    process.kill(pid, "SIGTERM");
    if (await waitForProcessExit(pid, config.timeoutSeconds * 1000)) {
      await removeOwnedRuntimeFile(config.pidFile, "PID file");
      await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
      return { status: "stopped", service: SERVICE_NAME, pid, signal: "SIGTERM" };
    }

    const afterTimeout = await inspectProcessOwnership(config, pid, runtime);
    if (!afterTimeout.alive) {
      await removeOwnedRuntimeFile(config.pidFile, "PID file");
      await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
      return { status: "stopped", service: SERVICE_NAME, pid, signal: "SIGTERM" };
    }
    if (!afterTimeout.owned) {
      fail("ownership_lost", "process identity changed during stop; no further signal was sent", {
        pid,
        reason: afterTimeout.reason,
      });
    }
    if (!config.force) {
      fail("stop_timeout", "verified AI platform process did not exit after SIGTERM; no SIGKILL was sent", {
        pid,
        timeoutSeconds: config.timeoutSeconds,
        logFile: config.logFile,
      });
    }
    process.kill(pid, "SIGKILL");
    if (!(await waitForProcessExit(pid, config.timeoutSeconds * 1000))) {
      fail("stop_failed", "verified AI platform process remained alive after SIGKILL", { pid });
    }
    await removeOwnedRuntimeFile(config.pidFile, "PID file");
    await removeOwnedRuntimeFile(config.runtimeFile, "runtime file");
    return { status: "stopped", service: SERVICE_NAME, pid, signal: "SIGKILL", forced: true };
  } finally {
    await releaseLock();
  }
}

async function statusCommand(config, runtime) {
  const pid = await readPidFile(config.pidFile);
  const databaseExists = await assertRegularOrAbsent(config.database, "database");
  const port = await probePort(config.host, config.port);
  let processState = {
    alive: false,
    owned: false,
    reason: pid === null ? "no_pid_file" : "not_running",
    pid,
  };
  if (pid !== null) {
    const ownership = await inspectProcessOwnership(config, pid, runtime);
    processState = {
      alive: ownership.alive,
      owned: ownership.owned,
      reason: ownership.reason,
      pid,
      ...(ownership.info ? {
        cwd: ownership.info.cwd,
        command: ownership.info.commandLine,
        startMarker: ownership.info.startMarker,
      } : {}),
    };
  }
  let status = "not_initialized";
  if (processState.alive && processState.owned) status = "running";
  else if (processState.alive) status = "ownership_mismatch";
  else if (pid !== null || runtime !== null) status = "stale";
  else if (databaseExists) status = "stopped";
  return {
    status,
    service: SERVICE_NAME,
    root: config.root,
    host: config.host,
    port: config.port,
    database: config.database,
    databasePresent: databaseExists,
    runtimeFile: config.runtimeFile,
    pidFile: config.pidFile,
    logFile: config.logFile,
    portProbe: {
      host: config.host,
      number: config.port,
      inUse: port.inUse,
      details: portDetails(config.port) || null,
    },
    process: processState,
    runtime: publicRuntime(runtime),
  };
}

async function healthCommand(config, runtime) {
  const pid = await readPidFile(config.pidFile);
  if (pid === null) {
    return {
      status: "unhealthy",
      service: SERVICE_NAME,
      reason: "not_running",
      runtimeFile: config.runtimeFile,
      endpoint: `http://${hostForUrl(config.host)}:${config.port}/healthz`,
    };
  }
  const ownership = await inspectProcessOwnership(config, pid, runtime);
  if (!ownership.alive || !ownership.owned) {
    return {
      status: "unhealthy",
      service: SERVICE_NAME,
      reason: ownership.alive ? ownership.reason : "not_running",
      pid,
      runtimeFile: config.runtimeFile,
    };
  }
  const health = await requestHealth(config);
  return {
    status: health.ok ? "ok" : "unhealthy",
    service: SERVICE_NAME,
    pid,
    endpoint: health.endpoint,
    httpStatus: health.httpStatus,
    health: health.body,
    ...(health.error ? { reason: health.error, message: health.message } : {}),
  };
}

function fsyncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function verifySqliteIntegrity(path, label) {
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const quick = database.prepare("PRAGMA quick_check").all();
    const foreign = database.prepare("PRAGMA foreign_key_check").all();
    if (quick.length !== 1 || quick[0].quick_check !== "ok") {
      fail("database_invalid", `${label} failed SQLite quick_check`);
    }
    if (foreign.length !== 0) fail("database_invalid", `${label} failed SQLite foreign_key_check`);
    const migrationRow = database.prepare("SELECT COUNT(*) AS count FROM platform_migrations").get();
    return { quickCheck: "ok", foreignKeyErrors: 0, migrations: Number(migrationRow?.count ?? 0) };
  } catch (error) {
    if (error instanceof OpsError) throw error;
    fail("database_invalid", `${label} could not be opened or verified`, { message: error?.message ?? "unknown error" });
  } finally {
    database?.close();
  }
}

async function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writeTextAtomic(path, text, mode = 0o600) {
  await ensureParentDirectory(path, "output file");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, text, { flag: "wx", mode });
  await chmod(temporary, mode);
  fsyncFile(temporary);
  await rename(temporary, path);
  fsyncFile(dirname(path));
}

function backupName() {
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `ai-platform-${stamp}-${process.pid}.sqlite`;
}

async function assertBackupNotInArtifactTree(config, path) {
  const forbidden = [
    resolve(config.root, "ai-platform"),
    resolve(config.root, "scripts", "ai-platform"),
    resolve(config.root, "docs", "ai-platform"),
    resolve(config.root, "outputs"),
  ];
  if (forbidden.some((tree) => isWithin(tree, path))) {
    fail("unsafe_path", "backup output must remain outside source and generated artifact directories", { path });
  }
}

async function createBackup(config) {
  const releaseLock = await acquireLock(config.runtimeDir, "operation");
  let staging = null;
  try {
    const sourceExists = await assertRegularOrAbsent(config.database, "database");
    if (!sourceExists) fail("database_unavailable", `database does not exist: ${config.database}`);
    await assertDirectory(config.backupDir, "backup directory", { create: true, mode: 0o700 });
    const destination = config.backupFile ?? resolve(config.backupDir, backupName());
    await assertBackupNotInArtifactTree(config, destination);
    if (resolve(destination) === resolve(config.database)) fail("unsafe_path", "backup destination must differ from the live database");
    if (await assertRegularOrAbsent(destination, "backup destination")) {
      fail("backup_exists", `backup destination already exists: ${destination}`);
    }
    const destinationParent = dirname(destination);
    await mkdir(destinationParent, { recursive: true, mode: 0o700 });
    await assertDirectory(destinationParent, "backup destination parent");
    staging = resolve(destinationParent, `.${basename(destination)}.staging-${process.pid}-${randomUUID()}`);
    const source = new DatabaseSync(config.database, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout = 5000");
      source.prepare("VACUUM INTO ?").run(staging);
    } finally {
      source.close();
    }
    await assertRegularOrAbsent(staging, "backup staging file");
    await chmod(staging, 0o600);
    const integrity = await verifySqliteIntegrity(staging, "backup staging file");
    fsyncFile(staging);
    await rename(staging, destination);
    staging = null;
    fsyncFile(destination);
    const digest = await sha256File(destination);
    const sizeBytes = (await stat(destination)).size;
    const sidecar = `${destination}.sha256`;
    await writeTextAtomic(sidecar, `${digest}  ${basename(destination)}\n`);
    const manifest = `${destination}.json`;
    const manifestPayload = {
      schemaVersion: 1,
      kind: "ai-platform-database-backup",
      createdAt: new Date().toISOString(),
      sourceDatabase: config.database,
      backupFile: destination,
      sha256: digest,
      sizeBytes,
      integrity,
      containsDatabaseData: true,
    };
    await writeJsonAtomic(manifest, manifestPayload, 0o600);

    const inventoryDir = dirname(destination);
    const entries = (await readdir(inventoryDir))
      .filter((name) => /^ai-platform-.*\.sqlite$/u.test(name))
      .map((name) => resolve(inventoryDir, name));
    const inventory = [];
    for (const path of entries) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      inventory.push({ path, mtimeMs: info.mtimeMs });
    }
    inventory.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
    const removed = [];
    for (const entry of inventory.slice(config.keep)) {
      await rm(entry.path, { force: false });
      for (const companion of [`${entry.path}.sha256`, `${entry.path}.json`]) {
        await assertRegularOrAbsent(companion, "backup companion file");
        await rm(companion, { force: true }).catch(() => {});
      }
      removed.push(entry.path);
    }
    return {
      status: "backed_up",
      service: SERVICE_NAME,
      backupFile: destination,
      sha256: digest,
      sizeBytes,
      sidecar,
      manifest,
      retainedCount: Math.min(inventory.length, config.keep),
      removedCount: removed.length,
      integrity,
    };
  } catch (error) {
    if (staging) await rm(staging, { force: true }).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}

async function verifyBackupFile(path) {
  const exists = await assertRegularOrAbsent(path, "backup file");
  if (!exists) fail("backup_unavailable", `backup file does not exist: ${path}`);
  const digest = await sha256File(path);
  const sidecarPath = `${path}.sha256`;
  let sidecarVerified = false;
  if (await assertRegularOrAbsent(sidecarPath, "backup hash sidecar")) {
    const sidecar = await readFile(sidecarPath, "utf8");
    const match = sidecar.match(/^([0-9a-f]{64})[ \t]+/u);
    if (!match || match[1] !== digest) fail("backup_hash_mismatch", `backup hash sidecar does not match: ${path}`);
    sidecarVerified = true;
  }
  const integrity = await verifySqliteIntegrity(path, "backup file");
  return { digest, sidecarVerified, integrity };
}

async function assertServiceStopped(config, runtime) {
  const pid = await readPidFile(config.pidFile);
  if (pid === null) {
    if (runtime) fail("runtime_incomplete", "runtime file exists without a PID file; restore is blocked");
    return;
  }
  const ownership = await inspectProcessOwnership(config, pid, runtime);
  if (ownership.alive) {
    if (ownership.owned) fail("service_running", "stop the AI platform before restoring its database", { pid });
    fail("ownership_mismatch", "cannot prove that the PID belongs to this AI platform; restore is blocked", {
      pid,
      reason: ownership.reason,
    });
  }
}

async function restoreCommand(config, runtime) {
  if (!config.backupFile) fail("invalid_argument", "restore requires --backup-file=<path>");
  if (!config.force) fail("confirmation_required", "restore requires --force and a stopped service");
  const releaseLock = await acquireLock(config.runtimeDir, "operation");
  let temporary = null;
  try {
    await assertServiceStopped(config, runtime);
    const source = resolve(config.backupFile);
    if (source === resolve(config.database)) fail("unsafe_path", "restore source must differ from the live database");
    const verification = await verifyBackupFile(source);
    await ensureParentDirectory(config.database, "database");
    const targetExists = await assertRegularOrAbsent(config.database, "database");
    const walPath = `${config.database}-wal`;
    const shmPath = `${config.database}-shm`;
    const walExists = await assertRegularOrAbsent(walPath, "database WAL sidecar");
    const shmExists = await assertRegularOrAbsent(shmPath, "database SHM sidecar");
    if (!targetExists && (walExists || shmExists)) {
      fail("restore_conflict", "database WAL/SHM sidecars exist without the target database; inspect before restoring");
    }
    temporary = `${config.database}.restore-${process.pid}-${randomUUID()}`;
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await verifySqliteIntegrity(temporary, "restore staging file");
    fsyncFile(temporary);

    const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    let previousDatabase = null;
    let previousWal = null;
    let previousShm = null;
    if (targetExists) {
      previousDatabase = `${config.database}.before-restore-${stamp}`;
      if (await assertRegularOrAbsent(previousDatabase, "pre-restore database")) {
        fail("restore_conflict", `pre-restore database already exists: ${previousDatabase}`);
      }
      await rename(config.database, previousDatabase);
      if (walExists) {
        previousWal = `${walPath}.before-restore-${stamp}`;
        await rename(walPath, previousWal);
      }
      if (shmExists) {
        previousShm = `${shmPath}.before-restore-${stamp}`;
        await rename(shmPath, previousShm);
      }
    }
    try {
      await rename(temporary, config.database);
      temporary = null;
      await verifySqliteIntegrity(config.database, "restored database");
    } catch (error) {
      await rm(config.database, { force: true }).catch(() => {});
      if (previousDatabase) await rename(previousDatabase, config.database).catch(() => {});
      if (previousWal) await rename(previousWal, walPath).catch(() => {});
      if (previousShm) await rename(previousShm, shmPath).catch(() => {});
      throw error;
    }
    return {
      status: "restored",
      service: SERVICE_NAME,
      database: config.database,
      backupFile: source,
      sha256: verification.digest,
      hashSidecarVerified: verification.sidecarVerified,
      integrity: verification.integrity,
      ...(previousDatabase ? { previousDatabase } : {}),
      ...(previousWal ? { previousWal } : {}),
      ...(previousShm ? { previousShm } : {}),
    };
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    await releaseLock();
  }
}

function textOutput(value) {
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item !== null && typeof item === "object") lines.push(`${key}=${JSON.stringify(item)}`);
    else lines.push(`${key}=${item}`);
  }
  return lines.join("\n");
}

function printResult(value, format) {
  if (format === "text") process.stdout.write(`${textOutput(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(error, format) {
  const value = {
    status: "error",
    code: error?.code ?? "ops_failed",
    message: error?.message ?? String(error),
    ...(error?.details && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  };
  if (format === "text") process.stderr.write(`${textOutput(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(parsed) {
  const context = await resolveCommandContext(parsed);
  const { config, runtime } = context;
  if (config.database.startsWith("/var/lib/sentelligent-ai-platform/")
    && ["start", "stop", "restore", "status", "health"].includes(parsed.command)) {
    fail("production_control_required", "Production service changes require the systemd transition tool");
  }
  if (parsed.command === "start") return { value: await startCommand({ ...config, force: parsed.options.force === true }), config };
  if (parsed.command === "stop") return { value: await stopCommand({ ...config, force: parsed.options.force === true }), config };
  if (parsed.command === "status") return { value: await statusCommand(config, runtime), config };
  if (parsed.command === "health") return { value: await healthCommand(config, runtime), config };
  if (parsed.command === "backup") return { value: await createBackup(config), config };
  if (parsed.command === "restore") return { value: await restoreCommand({ ...config, force: parsed.options.force === true }, runtime), config };
  fail("invalid_command", `unsupported command: ${parsed.command}`);
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = await run(parsed);
    printResult(result.value, result.config.format);
    if (
      ["unhealthy", "ownership_mismatch", "stale"].includes(result.value.status)
      || result.value.health?.ok === false
    ) return 1;
    return 0;
  } catch (error) {
    const format = parsed?.options?.format ?? "json";
    printError(error, format);
    return error?.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
