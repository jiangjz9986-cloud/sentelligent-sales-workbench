import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveDatabasePath(databaseUrl = "./data/sales-workbench.sqlite") {
  if (databaseUrl === ":memory:") return databaseUrl;
  if (databaseUrl.startsWith("file:")) return fileURLToPath(databaseUrl);
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl);
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

  if (fileBacked && typeof databasePath === "string") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  try {
    return configureConnection(db, { fileBacked });
  } catch (error) {
    db.close();
    throw error;
  }
}
