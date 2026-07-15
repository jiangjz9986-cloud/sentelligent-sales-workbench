import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveDatabasePath(databaseUrl = "./data/sales-workbench.sqlite") {
  if (databaseUrl === ":memory:") return databaseUrl;
  if (databaseUrl.startsWith("file:")) return fileURLToPath(databaseUrl);
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl);
}

export function databaseMaintenanceLockPath(databaseUrl) {
  const databasePath = resolveDatabasePath(databaseUrl);
  return databasePath === ":memory:" ? null : `${databasePath}.maintenance-lock`;
}

export function databaseOpeningMarkerPrefix(databaseUrl) {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath === ":memory:") return null;
  return join(dirname(databasePath), `.${basename(databasePath)}.opening-`);
}

function assertDatabaseIsAvailable(databasePath) {
  const lockPath = databaseMaintenanceLockPath(databasePath);
  if (lockPath && existsSync(lockPath)) {
    throw new Error(`Database maintenance is in progress: ${lockPath}`);
  }
}

export function configureConnection(db, { fileBacked }) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  if (fileBacked) {
    db.exec("PRAGMA journal_mode = WAL");
  }

  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export function createConnection({ databaseUrl } = {}) {
  const databasePath = resolveDatabasePath(databaseUrl);
  const fileBacked = databasePath !== ":memory:";
  let openingMarkerPath = null;

  if (fileBacked && typeof databasePath === "string") {
    mkdirSync(dirname(databasePath), { recursive: true });
    openingMarkerPath = `${databaseOpeningMarkerPrefix(databasePath)}${process.pid}-${randomUUID()}.lock`;
    writeFileSync(
      openingMarkerPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }

  let db;
  let operationError;
  try {
    if (fileBacked) assertDatabaseIsAvailable(databasePath);
    db = new DatabaseSync(databasePath);
    configureConnection(db, { fileBacked });
    if (fileBacked) assertDatabaseIsAvailable(databasePath);
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  if (openingMarkerPath) {
    try {
      rmSync(openingMarkerPath);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (operationError || cleanupError) {
    db?.close();
    if (operationError && cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `${operationError.message}; database opening marker cleanup also failed`,
      );
    }
    throw operationError ?? cleanupError;
  }
  return db;
}
