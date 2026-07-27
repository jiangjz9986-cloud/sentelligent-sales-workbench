import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { resolveDatabasePath } from "./connection.js";

export const BUSINESS_TABLES = [
  "customers",
  "opportunities",
  "quick_records",
  "ai_insights",
  "manual_confirmations",
  "weekly_reports",
  "solution_drafts",
  "ai_suggestions",
  "action_items",
  "risk_items",
  "knowledge_items",
  "visit_itineraries",
  "sales_decision_analyses",
  "audit_logs",
];

function quickCheckResult(db) {
  const rows = db.prepare("PRAGMA quick_check").all();
  if (rows.length === 1 && rows[0].quick_check === "ok") return "ok";
  return rows.map((row) => row.quick_check).join("; ") || "no result";
}

function unavailableReport(code, message) {
  return {
    quickCheck: "error",
    foreignKeyViolations: null,
    tableCounts: Object.fromEntries(BUSINESS_TABLES.map((table) => [table, null])),
    missingTables: [...BUSINESS_TABLES],
    pragmas: {
      foreignKeys: null,
      journalMode: null,
      busyTimeout: null,
    },
    error: { code, message },
  };
}

function databaseSidecars(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
    .filter(existsSync);
}

function busyReport(sidecars) {
  return unavailableReport(
    "DATABASE_BUSY",
    `Database has active SQLite sidecars: ${sidecars.join(", ")}. Stop writers and checkpoint first.`,
  );
}

function persistentJournalMode(databasePath) {
  const header = Buffer.alloc(20);
  const descriptor = openSync(databasePath, "r");
  try {
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead < header.length || header.subarray(0, 16).toString("utf8") !== "SQLite format 3\0") {
      throw new Error("Database header is not a valid SQLite format");
    }
  } finally {
    closeSync(descriptor);
  }

  if (header[18] === 2 || header[19] === 2) return "wal";
  if (header[18] === 1 && header[19] === 1) return "delete";
  return "unknown";
}

export function inspectDatabaseConnection(db, { journalMode } = {}) {
  const quickCheck = quickCheckResult(db);
  const pragmas = {
    foreignKeys: db.prepare("PRAGMA foreign_keys").get().foreign_keys,
    journalMode: journalMode ?? db.prepare("PRAGMA journal_mode").get().journal_mode,
    busyTimeout: db.prepare("PRAGMA busy_timeout").get().timeout,
  };

  if (quickCheck !== "ok") {
    return {
      ...unavailableReport("QUICK_CHECK_FAILED", quickCheck),
      quickCheck,
      pragmas,
    };
  }

  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  const missingTables = BUSINESS_TABLES.filter((table) => !existingTables.has(table));
  const tableCounts = Object.fromEntries(
    BUSINESS_TABLES.map((table) => [
      table,
      existingTables.has(table)
        ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
        : null,
    ]),
  );

  return {
    quickCheck,
    foreignKeyViolations,
    tableCounts,
    missingTables,
    pragmas,
    error: null,
  };
}

export function inspectDatabase(databaseUrl) {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (!existsSync(databasePath)) {
    return unavailableReport("DATABASE_NOT_FOUND", `Database does not exist: ${databasePath}`);
  }

  const sidecarsBefore = databaseSidecars(databasePath);
  if (sidecarsBefore.length > 0) return busyReport(sidecarsBefore);

  let db;
  let report;
  let inspectionError;
  try {
    const journalMode = persistentJournalMode(databasePath);
    const databaseUrl = pathToFileURL(databasePath);
    databaseUrl.searchParams.set("immutable", "1");
    db = new DatabaseSync(databaseUrl, { readOnly: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    report = inspectDatabaseConnection(db, { journalMode });
  } catch (error) {
    inspectionError = error;
  } finally {
    try {
      db?.close();
    } catch (error) {
      inspectionError ??= error;
    }
  }

  const sidecarsAfter = databaseSidecars(databasePath);
  if (sidecarsAfter.length > 0) return busyReport(sidecarsAfter);
  if (inspectionError) return unavailableReport("INSPECTION_FAILED", inspectionError.message);
  return report;
}
