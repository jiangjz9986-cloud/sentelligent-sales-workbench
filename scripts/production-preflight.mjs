import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_PROJECT_SERVICES = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
]);

const ALLOWED_SERVICE_ACTIONS = Object.freeze([
  "enable",
  "is-active",
  "is-enabled",
  "restart",
  "start",
  "status",
  "stop",
]);
const REQUIRED_PROTECTED_OBJECTS = Object.freeze([
  "account-vault",
  "qingyang",
  "proxy",
]);
const REQUIRED_PROTECTED_LISTENERS = Object.freeze([
  { port: 4876, owner: "account-vault" },
  { port: 8797, owner: "qingyang" },
]);
const DEFAULT_PROJECT_PATH = "/opt/sentelligent-sales-workbench";
const PROJECT_CURRENT_PATH = `${DEFAULT_PROJECT_PATH}/current`;
const PROJECT_RELEASES_PATH = `${DEFAULT_PROJECT_PATH}/releases`;
const CADDY_CONFIG_PATH = "/etc/caddy/Caddyfile";
const PROJECT_NODE_EXECUTABLE =
  `${DEFAULT_PROJECT_PATH}/runtime/node-v24/bin/node`;
const NODE_EXECUTABLES = new Set([
  "/usr/bin/node",
  "/usr/local/bin/node",
  PROJECT_NODE_EXECUTABLE,
]);
const CADDY_EXECUTABLES = new Set([
  "/usr/bin/caddy",
  "/usr/local/bin/caddy",
]);
const SERVICE_USERS = Object.freeze({
  "sentelligent-backend.service": new Set(["root", "sentelligent", "sentzx"]),
  "sentelligent-frontend.service": new Set(["root", "sentelligent", "sentzx"]),
  "sentelligent-caddy.service": new Set(["root", "caddy", "sentelligent"]),
  "sentelligent-weixin-agent.service": new Set(["root", "sentelligent", "sentzx"]),
});
const REQUIRED_PROJECT_SERVICE_NAMES = new Set(REQUIRED_PROJECT_SERVICES);

function parseEnvFile(filePath) {
  const entries = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[name] = value;
  }
  return entries;
}

function decodeCanonicalBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  if (expectedLength !== undefined && decoded.length !== expectedLength) return null;
  return decoded;
}

function isCanonicalPasswordHash(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  const parts = value.split("$");
  if (parts.length !== 6) return false;
  const [name, n, r, p, salt, hash] = parts;
  return (
    name === "scrypt" &&
    n === "16384" &&
    r === "8" &&
    p === "1" &&
    decodeCanonicalBase64Url(salt, 16) !== null &&
    decodeCanonicalBase64Url(hash, 64) !== null
  );
}

function isStrongSessionValue(value) {
  const decoded = decodeCanonicalBase64Url(value);
  return decoded !== null && decoded.length >= 32;
}

function canonicalOrigins(values) {
  const origins = new Set();
  for (const value of values) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null"
    ) {
      throw new Error("Production CORS values must be exact HTTPS origins");
    }
    origins.add(url.origin);
  }
  return [...origins].sort();
}

function matchesExactCors(value, expectedOrigins) {
  try {
    const configured = String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const expected = canonicalOrigins(expectedOrigins);
    if (configured.length === 0 || expected.length === 0) return false;
    return JSON.stringify(canonicalOrigins(configured)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function nodeMajor(version) {
  const match = String(version ?? "").trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : 0;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function inspectSqlite(filePath, { requireNoSidecars = false } = {}) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return {
      quickCheck: "error",
      foreignKeyViolations: null,
      error: "database file is missing",
    };
  }
  const sidecars = [`${resolvedPath}-wal`, `${resolvedPath}-shm`, `${resolvedPath}-journal`]
    .filter(existsSync);
  if (requireNoSidecars && sidecars.length > 0) {
    return {
      quickCheck: "error",
      foreignKeyViolations: null,
      error: "database has active sidecar files",
    };
  }

  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(resolvedPath, { readOnly: true });
    const quickRows = database.prepare("PRAGMA quick_check").all();
    const quickCheck =
      quickRows.length === 1 && quickRows[0].quick_check === "ok"
        ? "ok"
        : quickRows.map((row) => row.quick_check).join("; ") || "no result";
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    return {
      quickCheck,
      foreignKeyViolations: foreignKeyViolations.length,
      error: null,
    };
  } catch {
    return {
      quickCheck: "error",
      foreignKeyViolations: null,
      error: "database inspection failed",
    };
  } finally {
    database?.close();
  }
}

function normalizedNativePath(realPath) {
  return process.platform === "win32" ? realPath.toLowerCase() : realPath;
}

function reliableIdentityValue(value) {
  if (typeof value === "bigint") return value > 0n;
  return Number.isSafeInteger(value) && value > 0;
}

const defaultIdentityFileSystem = Object.freeze({
  realpath(filePath) {
    return realpathSync.native(filePath);
  },
  stat(filePath) {
    return statSync(filePath, { bigint: true });
  },
});

export function compareDatabaseIdentity(
  databasePath,
  backupPath,
  fileSystem = defaultIdentityFileSystem,
) {
  try {
    if (
      typeof fileSystem?.realpath !== "function" ||
      typeof fileSystem?.stat !== "function"
    ) {
      return { distinct: false, verifiedBy: "unavailable" };
    }
    const resolvedDatabasePath = resolve(databasePath);
    const resolvedBackupPath = resolve(backupPath);
    const primaryPath = normalizedNativePath(
      fileSystem.realpath(resolvedDatabasePath),
    );
    const candidatePath = normalizedNativePath(
      fileSystem.realpath(resolvedBackupPath),
    );
    if (primaryPath === candidatePath) {
      return { distinct: false, verifiedBy: "resolved-path" };
    }

    const primary = fileSystem.stat(resolvedDatabasePath);
    const candidate = fileSystem.stat(resolvedBackupPath);
    const identityAvailable =
      reliableIdentityValue(primary?.dev) &&
      reliableIdentityValue(primary?.ino) &&
      reliableIdentityValue(candidate?.dev) &&
      reliableIdentityValue(candidate?.ino);
    if (!identityAvailable) {
      return { distinct: false, verifiedBy: "unavailable" };
    }
    if (
      primary.dev === candidate.dev &&
      primary.ino === candidate.ino
    ) {
      return { distinct: false, verifiedBy: "device-and-inode" };
    }
    return { distinct: true, verifiedBy: "device-and-inode" };
  } catch {
    return { distinct: false, verifiedBy: "unavailable" };
  }
}

function isEnabled(value) {
  return value === true || value === "enabled";
}

function isActive(value) {
  return value === true || value === "active";
}

function parsePlannedCommand(command) {
  if (typeof command !== "string" || /[\r\n;&|`$<>(){}]/.test(command)) {
    return null;
  }
  const services = REQUIRED_PROJECT_SERVICES
    .map((service) => service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^systemctl\\s+(${ALLOWED_SERVICE_ACTIONS.join("|")})\\s+` +
      `(${services})$`,
  );
  const match = command.trim().match(pattern);
  return match ? { action: match[1], service: match[2] } : null;
}

export function validatePlannedCommands(plan) {
  const commands = Array.isArray(plan?.plannedCommands)
    ? plan.plannedCommands
    : [];
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  if (commands.length === 0 || commands.length !== actions.length) return false;
  const parsed = commands.map(parsePlannedCommand);
  if (parsed.some((command) => command === null)) return false;
  if (parsed.some((command) => !REQUIRED_PROJECT_SERVICE_NAMES.has(command.service))) {
    return false;
  }
  const commandKeys = parsed
    .map((command) => `${command.action}:${command.service}`)
    .sort();
  const actionKeys = actions
    .map((action) => {
      if (
        !ALLOWED_SERVICE_ACTIONS.includes(action?.action) ||
        !REQUIRED_PROJECT_SERVICE_NAMES.has(action?.service)
      ) {
        return null;
      }
      return `${action.action}:${action.service}`;
    })
    .sort();
  return !actionKeys.includes(null) &&
    JSON.stringify(commandKeys) === JSON.stringify(actionKeys);
}

function approvedProjectPaths(plan) {
  if (!Array.isArray(plan?.projectPaths)) return null;
  const paths = [];
  for (const entry of plan.projectPaths) {
    const value = entry?.path;
    if (
      entry?.approved !== true ||
      typeof value !== "string" ||
      !posix.isAbsolute(value) ||
      value.split("/").includes("..")
    ) {
      return null;
    }
    const normalized = posix.normalize(value);
    const path = normalized.replace(/\/$/, "");
    if (
      path !== DEFAULT_PROJECT_PATH &&
      !pathWithin(path, PROJECT_CURRENT_PATH) &&
      !pathWithin(path, PROJECT_RELEASES_PATH) &&
      path !== CADDY_CONFIG_PATH
    ) {
      return null;
    }
    paths.push(path);
  }
  if (
    !paths.includes(DEFAULT_PROJECT_PATH) ||
    !paths.includes(CADDY_CONFIG_PATH)
  ) {
    return null;
  }
  return [...new Set(paths)];
}

function pathWithin(candidate, root) {
  const value = posix.normalize(candidate);
  return value === root || value.startsWith(`${root}/`);
}

function isReleaseEntryPath(candidate, entryPath) {
  if (candidate === `${DEFAULT_PROJECT_PATH}/${entryPath}`) return true;
  if (candidate === `${PROJECT_CURRENT_PATH}/${entryPath}`) return true;
  if (!candidate.startsWith(`${PROJECT_RELEASES_PATH}/`)) return false;
  const relativePath = candidate.slice(`${PROJECT_RELEASES_PATH}/`.length);
  const separator = relativePath.indexOf("/");
  if (separator <= 0) return false;
  const releaseId = relativePath.slice(0, separator);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) &&
    !releaseId.includes("..") &&
    relativePath.slice(separator + 1) === entryPath
  );
}

function exactExecTokens(command) {
  if (
    typeof command !== "string" ||
    command !== command.trim() ||
    /[\0\r\n;&|`$<>(){}[\]!'"\\]/.test(command)
  ) {
    return null;
  }
  const tokens = command.split(/[ \t]+/);
  return tokens.length > 0 && tokens.every(Boolean) ? tokens : null;
}

function isCurrentCentosFrontendCommand(tokens) {
  return JSON.stringify(tokens) === JSON.stringify([
    "/usr/local/bin/node",
    `${DEFAULT_PROJECT_PATH}/frontend/scripts/static-server.mjs`,
    "serve",
    "--host=0.0.0.0",
    "--port=8088",
    `--dist-path=${DEFAULT_PROJECT_PATH}/frontend/dist`,
    "--api-base-url=https://82.156.210.199",
  ]);
}

export function validateProjectServiceExecStart(serviceName, command) {
  const tokens = exactExecTokens(command);
  if (tokens === null) return false;

  if (serviceName === "sentelligent-backend.service") {
    return (
      tokens.length === 2 &&
      NODE_EXECUTABLES.has(tokens[0]) &&
      isReleaseEntryPath(tokens[1], "backend/src/server.js")
    );
  }
  if (serviceName === "sentelligent-frontend.service") {
    return isCurrentCentosFrontendCommand(tokens) || (
      tokens.length === 3 &&
      NODE_EXECUTABLES.has(tokens[0]) &&
      isReleaseEntryPath(
        tokens[1],
        "outputs/product-design-prototype/scripts/static-server.mjs",
      ) &&
      tokens[2] === "serve"
    );
  }
  if (serviceName === "sentelligent-caddy.service") {
    return (
      tokens.length === 4 &&
      CADDY_EXECUTABLES.has(tokens[0]) &&
      tokens[1] === "run" &&
      tokens[2] === "--config" &&
      tokens[3] === CADDY_CONFIG_PATH
    );
  }
  if (serviceName === "sentelligent-weixin-agent.service") {
    return (
      tokens.length === 3 &&
      NODE_EXECUTABLES.has(tokens[0]) &&
      isReleaseEntryPath(tokens[1], "backend/src/weixin/worker.js") &&
      tokens[2] === "start"
    );
  }
  return false;
}

function validateServiceSnapshot(plan, referenceTime) {
  const generatedAt = Date.parse(plan?.snapshotGeneratedAt ?? "");
  const reference = Date.parse(referenceTime);
  const age = reference - generatedAt;
  return (
    Number.isFinite(generatedAt) &&
    Number.isFinite(reference) &&
    age >= -5 * 60_000 &&
    age <= 24 * 60 * 60_000 &&
    typeof plan?.hostname === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(plan.hostname) &&
    approvedProjectPaths(plan) !== null
  );
}

function validateProjectServices(plan) {
  const services = Array.isArray(plan?.projectServices)
    ? plan.projectServices
    : [];
  if (approvedProjectPaths(plan) === null) return false;
  const serviceNames = services.map((service) => service?.name);
  if (
    services.length !== REQUIRED_PROJECT_SERVICES.length ||
    new Set(serviceNames).size !== REQUIRED_PROJECT_SERVICES.length ||
    !serviceNames.every((name) => REQUIRED_PROJECT_SERVICE_NAMES.has(name))
  ) {
    return false;
  }
  const serviceMap = new Map(services.map((service) => [service?.name, service]));
  const requiredReady = REQUIRED_PROJECT_SERVICES.every((name) => {
    const service = serviceMap.get(name);
    const fragmentPath = posix.normalize(service?.FragmentPath ?? "");
    const fragmentOwned = [
      `/etc/systemd/system/${name}`,
      `/lib/systemd/system/${name}`,
      `/usr/lib/systemd/system/${name}`,
    ].includes(fragmentPath);
    const workingDirectoryOwned = name === "sentelligent-caddy.service"
      ? service?.WorkingDirectory === "" ||
        pathWithin(service?.WorkingDirectory ?? "", DEFAULT_PROJECT_PATH)
      : typeof service?.WorkingDirectory === "string" &&
        pathWithin(service.WorkingDirectory, DEFAULT_PROJECT_PATH);
    const execStartOwned =
      typeof service?.ExecStart === "string" &&
      validateProjectServiceExecStart(name, service.ExecStart);
    return (
      service &&
      isEnabled(service.enabled) &&
      isActive(service.active) &&
      fragmentOwned &&
      execStartOwned &&
      SERVICE_USERS[name]?.has(service.User) &&
      workingDirectoryOwned
    );
  });
  return requiredReady;
}

function validatesUnrelatedProtection(plan) {
  const unrelated = Array.isArray(plan?.unrelatedServices)
    ? plan.unrelatedServices
    : [];
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  const protectedObjects = new Set(
    Array.isArray(plan?.protectedObjects) ? plan.protectedObjects : [],
  );
  const listeners = Array.isArray(plan?.listeners) ? plan.listeners : [];
  if (
    unrelated.length === 0 ||
    !REQUIRED_PROTECTED_OBJECTS.every((name) => protectedObjects.has(name))
  ) {
    return false;
  }
  const protectedNames = new Set(unrelated.map((service) => service?.name));
  const inventoryProtected = unrelated.every(
    (service) =>
      service?.protected === true &&
      typeof service?.name === "string" &&
      service.name.length > 0 &&
      typeof service.active === "boolean" &&
      !service.name.startsWith("sentelligent-") &&
      protectedObjects.has(service?.protectionId),
  );
  const requiredObjectsInventoried = REQUIRED_PROTECTED_OBJECTS.every((name) =>
    unrelated.some((service) => service?.protectionId === name),
  );
  const listenersProtected = listeners.length > 0 && listeners.every(
    (listener) =>
      Number.isInteger(listener?.port) &&
      listener.port > 0 &&
      listener.port <= 65_535 &&
      listener.protected === true &&
      protectedObjects.has(listener?.owner),
  );
  const requiredListenersPresent = REQUIRED_PROTECTED_LISTENERS.every(
    (required) =>
      listeners.some(
        (listener) =>
          listener?.port === required.port && listener?.owner === required.owner,
      ),
  );
  const actionsIsolated = actions.every(
    (action) => !protectedNames.has(action?.service),
  );
  return (
    inventoryProtected &&
    requiredObjectsInventoried &&
    listenersProtected &&
    requiredListenersPresent &&
    actionsIsolated
  );
}

function makeCheck(id, passed, passedMessage, failedMessage, details) {
  return {
    id,
    status: passed ? "passed" : "failed",
    message: passed ? passedMessage : failedMessage,
    ...(details === undefined ? {} : { details }),
  };
}

function safeReadEnvironment(envFile) {
  try {
    return { value: parseEnvFile(resolve(envFile)), error: null };
  } catch {
    return { value: {}, error: "production environment snapshot could not be read" };
  }
}

function safeReadServicePlan(servicePlanPath) {
  try {
    return {
      value: JSON.parse(readFileSync(resolve(servicePlanPath), "utf8")),
      error: null,
    };
  } catch {
    return { value: {}, error: "service protection plan could not be read" };
  }
}

export async function runProductionPreflight({
  envFile,
  databasePath,
  backupPath,
  expectedBackupSha256,
  expectedOrigins,
  servicePlanPath,
  nodeVersion = process.versions.node,
  createdAt = new Date().toISOString(),
} = {}) {
  const environmentResult = safeReadEnvironment(envFile);
  const environment = environmentResult.value;
  const servicePlanResult = safeReadServicePlan(servicePlanPath);
  const servicePlan = servicePlanResult.value;
  const database = await inspectSqlite(databasePath ?? "");
  const backup = await inspectSqlite(backupPath ?? "", {
    requireNoSidecars: true,
  });
  const databaseIdentity = compareDatabaseIdentity(
    databasePath ?? "",
    backupPath ?? "",
  );

  let actualBackupSha256 = "";
  try {
    actualBackupSha256 = sha256File(resolve(backupPath));
  } catch {
    actualBackupSha256 = "";
  }
  const expectedHashValid = /^[a-f0-9]{64}$/i.test(
    String(expectedBackupSha256 ?? ""),
  );
  const backupHashMatches =
    expectedHashValid &&
    actualBackupSha256 === String(expectedBackupSha256).toLowerCase();
  const expectedOriginList = Array.isArray(expectedOrigins)
    ? expectedOrigins
    : [];

  const checks = [
    makeCheck(
      "node.version",
      nodeMajor(nodeVersion) >= 24,
      "Node.js runtime is version 24 or newer.",
      "Node.js 24 or newer is required.",
    ),
    makeCheck(
      "env.production",
      environmentResult.error === null && environment.NODE_ENV === "production",
      "Environment is explicitly production.",
      environmentResult.error ?? "NODE_ENV must be production.",
    ),
    makeCheck(
      "env.authRequired",
      environment.AUTH_REQUIRED === "true",
      "Authentication is required.",
      "AUTH_REQUIRED must be true.",
    ),
    makeCheck(
      "env.authHash",
      Boolean(environment.AUTH_ACCOUNT) &&
        !environment.AUTH_PASSWORD &&
        isCanonicalPasswordHash(environment.AUTH_PASSWORD_HASH),
      "Account authentication uses a canonical scrypt hash without plaintext fallback.",
      "Production authentication requires an account and canonical scrypt hash, with no plaintext password.",
    ),
    makeCheck(
      "env.sessionSecret",
      isStrongSessionValue(environment.AUTH_SESSION_SECRET),
      "Session signing value is canonical base64url with at least 32 bytes.",
      "Session signing value must be canonical base64url with at least 32 bytes.",
    ),
    makeCheck(
      "env.secureCookie",
      environment.AUTH_COOKIE_SECURE === "true",
      "Secure cookies are enabled.",
      "AUTH_COOKIE_SECURE must be true.",
    ),
    makeCheck(
      "env.cors",
      matchesExactCors(environment.CORS_ALLOWED_ORIGINS, expectedOriginList),
      "CORS is restricted to the exact expected HTTPS origin set.",
      "CORS must exactly match the expected HTTPS origin set.",
    ),
    makeCheck(
      "env.solutionWrites",
      environment.SOLUTION_WRITES_ENABLED === "false",
      "Solution write operations are disabled.",
      "SOLUTION_WRITES_ENABLED must be false.",
    ),
    makeCheck(
      "database.quickCheck",
      database.quickCheck === "ok",
      "Primary database PRAGMA quick_check returned ok.",
      database.error ?? "Primary database PRAGMA quick_check failed.",
    ),
    makeCheck(
      "database.foreignKeys",
      database.foreignKeyViolations === 0,
      "Primary database has no foreign key violations.",
      "Primary database has foreign key violations or could not be inspected.",
      database.foreignKeyViolations === null
        ? undefined
        : { violations: database.foreignKeyViolations },
    ),
    makeCheck(
      "backup.identity",
      databaseIdentity.distinct,
      "Backup resolves to a different file identity from the primary database.",
      "Backup must not be the primary database, a symlink to it, or a hard link to it.",
      { verifiedBy: databaseIdentity.verifiedBy },
    ),
    makeCheck(
      "backup.sha256",
      backupHashMatches,
      "Backup SHA-256 matches the separately recorded value.",
      "Backup SHA-256 is missing, malformed, or does not match.",
      actualBackupSha256 ? { actualSha256: actualBackupSha256 } : undefined,
    ),
    makeCheck(
      "backup.quickCheck",
      backup.quickCheck === "ok",
      "Backup database PRAGMA quick_check returned ok.",
      backup.error ?? "Backup database PRAGMA quick_check failed.",
    ),
    makeCheck(
      "backup.foreignKeys",
      backup.foreignKeyViolations === 0,
      "Backup database has no foreign key violations.",
      "Backup database has foreign key violations or could not be inspected.",
      backup.foreignKeyViolations === null
        ? undefined
        : { violations: backup.foreignKeyViolations },
    ),
    makeCheck(
      "services.snapshot",
      servicePlanResult.error === null &&
        validateServiceSnapshot(servicePlan, createdAt),
      "Service inventory is a current, host-identified read-only snapshot with approved project paths.",
      servicePlanResult.error ??
        "Service snapshot requires a recent snapshotGeneratedAt, hostname, and approved project paths.",
    ),
    makeCheck(
      "services.project",
      servicePlanResult.error === null && validateProjectServices(servicePlan),
      "All required project services are active, enabled, and exclusively targeted.",
      servicePlanResult.error ??
        "Required project services must be active, enabled, and the only action targets.",
    ),
    makeCheck(
      "services.commands",
      servicePlanResult.error === null &&
        validatePlannedCommands(servicePlan),
      "Every planned command exactly matches one allowed systemctl action for one project service.",
      servicePlanResult.error ??
        "Planned commands must use the exact single-service systemctl allowlist without shell syntax.",
    ),
    makeCheck(
      "services.unrelatedProtection",
      servicePlanResult.error === null &&
        validatesUnrelatedProtection(servicePlan),
      "Unrelated services are inventoried, protected, and excluded from every planned action.",
      servicePlanResult.error ??
        "Unrelated services must be protected and broad process or service commands are forbidden.",
    ),
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.length - passed;
  return {
    schemaVersion: 2,
    generatedAt: new Date(createdAt).toISOString(),
    status: failed === 0 ? "passed" : "failed",
    summary: {
      total: checks.length,
      passed,
      failed,
    },
    checks,
  };
}

function parseArguments(argv) {
  const options = { expectedOrigins: [] };
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (name === "env-file") options.envFile = value;
    else if (name === "database") options.databasePath = value;
    else if (name === "backup") options.backupPath = value;
    else if (name === "backup-sha256") options.expectedBackupSha256 = value;
    else if (name === "expected-origin") options.expectedOrigins.push(value);
    else if (name === "service-plan") options.servicePlanPath = value;
    else if (name === "report") options.reportPath = value;
    else throw new Error(`Unknown argument: --${name}`);
  }
  for (const name of [
    "envFile",
    "databasePath",
    "backupPath",
    "expectedBackupSha256",
    "servicePlanPath",
  ]) {
    if (!options[name]) throw new Error(`Missing required preflight option: ${name}`);
  }
  if (options.expectedOrigins.length === 0) {
    throw new Error("At least one --expected-origin is required");
  }
  return options;
}

async function main() {
  const { reportPath, ...options } = parseArguments(process.argv.slice(2));
  const report = await runProductionPreflight(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    mkdirSync(dirname(absoluteReportPath), { recursive: true });
    writeFileSync(absoluteReportPath, output, { flag: "wx" });
  }
  if (report.status === "passed") process.stdout.write(output);
  else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
