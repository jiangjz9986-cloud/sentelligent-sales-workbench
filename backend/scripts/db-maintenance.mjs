import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateDatabase, openDatabase } from "../src/db.js";
import {
  databaseMaintenanceLockPath,
  databaseOpeningMarkerPrefix,
  resolveDatabasePath,
} from "../src/db/connection.js";
import {
  inspectDatabase as inspectDatabaseIntegrity,
  inspectDatabaseConnection,
} from "../src/db/integrity.js";
import {
  createRuntimeConfig,
  ensureRuntimeDirs,
  parseOptions,
} from "./runtime-config.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function labelPart(value = "manual") {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "manual";
}

export function backupDatabase({ databaseUrl, backupDir, label } = {}) {
  const config = createRuntimeConfig({ databaseUrl, backupDir });
  ensureRuntimeDirs(config);
  const backupPath = join(config.backupDir, `${timestamp()}-${labelPart(label)}.sqlite`);

  const db = openDatabase({ databaseUrl: config.databaseUrl });
  try {
    db.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    db.close();
  }

  return {
    status: "backed_up",
    databasePath: config.databaseUrl,
    backupPath,
    bytes: statSync(backupPath).size,
  };
}

export function restoreDatabase({ databaseUrl, backupPath, backupDir } = {}) {
  if (!backupPath) throw new Error("backupPath is required for restore");

  const config = createRuntimeConfig({ databaseUrl, backupDir });
  const sourcePath = resolveDatabasePath(backupPath);
  assertDatabaseIsOffline(config.databaseUrl, "live database");
  if (!existsSync(sourcePath)) throw new Error(`Backup does not exist: ${sourcePath}`);
  assertDatabaseIsOffline(sourcePath, "backup source");
  ensureRuntimeDirs(config);
  mkdirSync(dirname(config.databaseUrl), { recursive: true });

  const candidatePath = join(dirname(config.databaseUrl), `.${timestamp()}-restore-candidate.sqlite`);
  const preRestoreBackupPath = existsSync(config.databaseUrl)
    ? join(config.backupDir, `${timestamp()}-pre-restore.sqlite`)
    : null;
  let result;
  let operationError;

  try {
    snapshotRestoreSource({ sourcePath, candidatePath });
    assertDatabaseIsOffline(sourcePath, "backup source");
    assertDatabaseIsOffline(candidatePath, "restore candidate");
    prepareRestoreCandidate(candidatePath);
    assertDatabaseIsOffline(candidatePath, "restore candidate");
    installRestoreCandidate({
      databaseUrl: config.databaseUrl,
      candidatePath,
      preRestoreBackupPath,
    });
    const info = inspectDatabase({ databaseUrl: config.databaseUrl });

    result = {
      status: "restored",
      databasePath: config.databaseUrl,
      backupPath: sourcePath,
      preRestoreBackupPath,
      tables: info.tables,
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupError = removeRestoreCandidate(candidatePath);
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `${operationError.message}; restore candidate cleanup also failed`,
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function snapshotRestoreSource({ sourcePath, candidatePath } = {}) {
  if (!sourcePath) throw new Error("sourcePath is required to snapshot a restore source");
  if (!candidatePath) throw new Error("candidatePath is required to snapshot a restore source");
  if (existsSync(candidatePath)) {
    throw new Error(`Restore snapshot destination already exists: ${candidatePath}`);
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    source.prepare("VACUUM INTO ?").run(candidatePath);
  } finally {
    source.close();
  }
}

function databaseSidecars(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`].filter(existsSync);
}

function assertDatabaseIsOffline(databasePath, label) {
  const sidecars = databaseSidecars(databasePath);
  if (sidecars.length > 0) {
    throw new Error(
      `Restore refused: ${label} has active SQLite/WAL sidecars (${sidecars.join(", ")}). Stop the service and checkpoint first.`
    );
  }
}

function validateDatabaseIntegrity(databaseUrl, { requireBusinessTables = true } = {}) {
  const db = new DatabaseSync(databaseUrl, { readOnly: true });
  try {
    let report;
    try {
      report = inspectDatabaseConnection(db);
    } catch (error) {
      throw new Error(`Restore candidate failed PRAGMA quick_check: ${error.message}`, {
        cause: error,
      });
    }
    if (report.quickCheck !== "ok") {
      throw new Error(`Restore candidate failed PRAGMA quick_check: ${report.quickCheck}`);
    }
    if (report.foreignKeyViolations.length > 0) {
      throw new Error(
        `Restore candidate failed PRAGMA foreign_key_check: ${JSON.stringify(report.foreignKeyViolations.slice(0, 5))}`
      );
    }
    if (requireBusinessTables && report.missingTables.length > 0) {
      throw new Error(`Restore candidate is missing required tables: ${report.missingTables.join(", ")}`);
    }
    return report;
  } finally {
    db.close();
  }
}

function prepareRestoreCandidate(databaseUrl) {
  validateDatabaseIntegrity(databaseUrl);
  const db = new DatabaseSync(databaseUrl);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = NORMAL");
    migrateDatabase(db);
  } finally {
    db.close();
  }
  validateDatabaseIntegrity(databaseUrl);
}

function acquireDatabaseMaintenanceLock(databaseUrl) {
  const lockPath = databaseMaintenanceLockPath(databaseUrl);
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
    if (error.code === "EEXIST") {
      throw new Error(`Database maintenance is already in progress: ${lockPath}`, { cause: error });
    }
    throw error;
  }

  return () => {
    try {
      closeSync(descriptor);
    } finally {
      rmSync(lockPath, { force: true });
    }
  };
}

function removeRestoreCandidate(candidatePath) {
  const sidecars = databaseSidecars(candidatePath);
  if (sidecars.length > 0) {
    return new Error(
      `Restore candidate cleanup refused because active sidecars remain: ${sidecars.join(", ")}`,
    );
  }
  try {
    rmSync(candidatePath, { force: true });
    return null;
  } catch (error) {
    return error;
  }
}

function syncFile(databasePath) {
  const descriptor = openSync(databasePath, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directoryPath) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFileAndDirectory(filePath) {
  syncFile(filePath);
  syncDirectory(dirname(filePath));
}

function assertNoDatabaseConnectionIsOpening(databasePath) {
  const markerPathPrefix = databaseOpeningMarkerPrefix(databasePath);
  const markerDirectory = dirname(markerPathPrefix);
  const markerNamePrefix = basename(markerPathPrefix);
  const markers = readdirSync(markerDirectory)
    .filter((name) => name.startsWith(markerNamePrefix));
  if (markers.length > 0) {
    throw new Error(
      `Restore refused because a database connection is opening: ${markers.join(", ")}. Retry after it finishes.`,
    );
  }
}

export function installRestoreCandidate({
  databaseUrl,
  candidatePath,
  preRestoreBackupPath = null,
  validate = validateDatabaseIntegrity,
} = {}) {
  if (!databaseUrl) throw new Error("databaseUrl is required to install a restore candidate");
  if (!candidatePath) throw new Error("candidatePath is required to install a restore candidate");
  const databasePath = resolveDatabasePath(databaseUrl);
  const resolvedCandidatePath = resolveDatabasePath(candidatePath);
  if (databasePath === resolvedCandidatePath) {
    throw new Error("Restore candidate must be different from the live database");
  }
  if (dirname(databasePath) !== dirname(resolvedCandidatePath)) {
    throw new Error("Restore candidate must be in the same directory as the live database");
  }
  if (!existsSync(resolvedCandidatePath)) {
    throw new Error(`Restore candidate does not exist: ${resolvedCandidatePath}`);
  }
  assertDatabaseIsOffline(resolvedCandidatePath, "restore candidate");

  const releaseMaintenanceLock = acquireDatabaseMaintenanceLock(databasePath);
  let operationError;
  try {
    assertNoDatabaseConnectionIsOpening(databasePath);
    assertDatabaseIsOffline(databasePath, "live database");
    installCandidateWhileLocked({
      databasePath,
      candidatePath: resolvedCandidatePath,
      preRestoreBackupPath,
      validate,
    });
  } catch (error) {
    operationError = error;
  }

  try {
    releaseMaintenanceLock();
  } catch (lockError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, lockError],
        `${operationError.message}; maintenance lock cleanup also failed`,
      );
    }
    throw lockError;
  }
  if (operationError) throw operationError;
}

function installCandidateWhileLocked({ databasePath, candidatePath, preRestoreBackupPath, validate }) {
  const hadLiveDatabase = existsSync(databasePath);
  const rollbackPath = join(
    dirname(databasePath),
    `.${timestamp()}-${process.pid}-restore-rollback.sqlite`,
  );

  if (hadLiveDatabase) renameSync(databasePath, rollbackPath);

  try {
    if (hadLiveDatabase && preRestoreBackupPath) {
      copyFileSync(rollbackPath, preRestoreBackupPath);
      syncFileAndDirectory(preRestoreBackupPath);
    }
    renameSync(candidatePath, databasePath);
    validate(databasePath);
    syncFileAndDirectory(databasePath);
  } catch (error) {
    const recoveryErrors = [];
    try {
      assertDatabaseIsOffline(databasePath, "installed restore candidate");
    } catch (sidecarError) {
      recoveryErrors.push(sidecarError);
    }

    if (recoveryErrors.length === 0 && existsSync(databasePath)) {
      try {
        renameSync(databasePath, candidatePath);
      } catch (renameError) {
        recoveryErrors.push(renameError);
      }
    }
    if (recoveryErrors.length === 0 && hadLiveDatabase && existsSync(rollbackPath)) {
      try {
        renameSync(rollbackPath, databasePath);
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
    }
    if (recoveryErrors.length === 0) {
      const cleanupError = removeRestoreCandidate(candidatePath);
      if (cleanupError) recoveryErrors.push(cleanupError);
    }

    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Restore installation failed and recovery was incomplete. Previous database: ${rollbackPath}`,
      );
    }
    throw error;
  }

  if (hadLiveDatabase) {
    rmSync(rollbackPath, { force: true });
    syncDirectory(dirname(databasePath));
  }
}

export function inspectDatabase({ databaseUrl } = {}) {
  const config = createRuntimeConfig({ databaseUrl });
  const report = inspectDatabaseIntegrity(config.databaseUrl);
  return {
    status:
      !report.error &&
      report.quickCheck === "ok" &&
      Array.isArray(report.foreignKeyViolations) &&
      report.foreignKeyViolations.length === 0 &&
      report.missingTables.length === 0
        ? "ready"
        : "invalid",
    databasePath: config.databaseUrl,
    exists: existsSync(config.databaseUrl),
    bytes: existsSync(config.databaseUrl) ? statSync(config.databaseUrl).size : 0,
    ...report,
    tables: report.tableCounts,
  };
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  const config = createRuntimeConfig(options);
  let result;

  if (command === "backup") {
    result = backupDatabase(config);
  } else if (command === "restore") {
    result = restoreDatabase(config);
  } else if (command === "info") {
    result = inspectDatabase(config);
  } else {
    throw new Error(`Unknown database command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
