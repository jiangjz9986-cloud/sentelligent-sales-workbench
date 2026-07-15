import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "schema.sql");

export function resolveDatabasePath(databaseUrl = "./data/sales-workbench.sqlite") {
  if (databaseUrl === ":memory:") return databaseUrl;
  if (databaseUrl.startsWith("file:")) return fileURLToPath(databaseUrl);
  return isAbsolute(databaseUrl) ? databaseUrl : resolve(process.cwd(), databaseUrl);
}

export function openDatabase({ databaseUrl } = {}) {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(db);
  return db;
}

export function migrateDatabase(db) {
  db.exec(readFileSync(schemaPath, "utf8"));
  ensureColumn(db, "action_items", "assignee", "TEXT");
  ensureColumn(db, "risk_items", "assignee", "TEXT");
  ensureColumn(db, "risk_items", "due", "TEXT");
  ensureColumn(db, "solution_drafts", "artifact_type", "TEXT NOT NULL DEFAULT 'solution_framework'");
}

function ensureColumn(db, table, column, definition) {
  const existingColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (existingColumns.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function run(db, sql, params = {}) {
  return db.prepare(sql).run(params);
}

export function get(db, sql, params = {}) {
  return db.prepare(sql).get(params);
}

export function all(db, sql, params = {}) {
  return db.prepare(sql).all(params);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--migrate")) {
  const { loadConfig } = await import("./config.js");
  const db = openDatabase({ databaseUrl: loadConfig().databaseUrl });
  db.close();
  console.log("Database migrated");
}
