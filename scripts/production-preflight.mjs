import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_PROJECT_SERVICES = Object.freeze([
  "sentelligent-backend.service",
  "sentelligent-frontend.service",
  "sentelligent-caddy.service",
  "sentelligent-weixin-agent.service",
]);

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

async function inspectSqlite(filePath) {
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
  if (sidecars.length > 0) {
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

function isEnabled(value) {
  return value === true || value === "enabled";
}

function isActive(value) {
  return value === true || value === "active";
}

function unsafeCommand(command) {
  const source = String(command ?? "").trim();
  const forbiddenProcessCommand = [
    /\bpkill\b/i,
    /\bkillall\b/i,
    /taskkill(?:\.exe)?\s+\/im\s+node/i,
    /docker\s+compose\s+down/i,
  ].some((pattern) => pattern.test(source));
  if (forbiddenProcessCommand) return true;

  const mutatesSystemd = /\bsystemctl\s+(?:disable|enable|restart|start|stop)\b/i
    .test(source);
  if (!mutatesSystemd) return false;
  return !/^(?:sudo\s+)?systemctl\s+(?:disable|enable|restart|start|stop)\s+sentelligent-[A-Za-z0-9@_.-]+\.service$/i
    .test(source);
}

function validateProjectServices(plan) {
  const services = Array.isArray(plan?.projectServices)
    ? plan.projectServices
    : [];
  const serviceMap = new Map(services.map((service) => [service?.name, service]));
  const requiredReady = REQUIRED_PROJECT_SERVICES.every((name) => {
    const service = serviceMap.get(name);
    return (
      service &&
      isEnabled(service.enabled) &&
      isActive(service.active)
    );
  });
  const ownedNamesOnly = services.every((service) =>
    /^sentelligent-[A-Za-z0-9@_.-]+\.service$/.test(service?.name ?? ""),
  );
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  const actionsOwned = actions.every(
    (action) =>
      ["enable", "restart", "start", "status", "stop"].includes(action?.action) &&
      serviceMap.has(action?.service) &&
      /^sentelligent-[A-Za-z0-9@_.-]+\.service$/.test(action.service),
  );
  return requiredReady && ownedNamesOnly && actionsOwned;
}

function validatesUnrelatedProtection(plan) {
  const unrelated = Array.isArray(plan?.unrelatedServices)
    ? plan.unrelatedServices
    : [];
  const actions = Array.isArray(plan?.plannedActions) ? plan.plannedActions : [];
  const commands = Array.isArray(plan?.plannedCommands)
    ? plan.plannedCommands
    : [];
  if (unrelated.length === 0) return false;
  const protectedNames = new Set(unrelated.map((service) => service?.name));
  const inventoryProtected = unrelated.every(
    (service) =>
      service?.protected === true &&
      typeof service?.name === "string" &&
      service.name.length > 0 &&
      !service.name.startsWith("sentelligent-"),
  );
  const actionsIsolated = actions.every(
    (action) => !protectedNames.has(action?.service),
  );
  return (
    inventoryProtected &&
    actionsIsolated &&
    commands.every((command) => !unsafeCommand(command))
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
  const backup = await inspectSqlite(backupPath ?? "");

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
      "services.project",
      servicePlanResult.error === null && validateProjectServices(servicePlan),
      "All required project services are active, enabled, and exclusively targeted.",
      servicePlanResult.error ??
        "Required project services must be active, enabled, and the only action targets.",
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
    schemaVersion: 1,
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
