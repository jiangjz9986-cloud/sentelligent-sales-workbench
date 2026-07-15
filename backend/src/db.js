import { fileURLToPath } from "node:url";

import { createConnection, resolveDatabasePath } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";

export { migrateDatabase, resolveDatabasePath };

export function openDatabase({ databaseUrl } = {}) {
  const db = createConnection({ databaseUrl });
  try {
    migrateDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
