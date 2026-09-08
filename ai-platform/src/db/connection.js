import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function resolveAiDatabasePath(databasePath) {
  if (databasePath === ":memory:") return databasePath;
  return isAbsolute(databasePath) ? databasePath : resolve(process.cwd(), databasePath);
}

export function createAiPlatformConnection(databasePath) {
  const path = resolveAiDatabasePath(databasePath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}
