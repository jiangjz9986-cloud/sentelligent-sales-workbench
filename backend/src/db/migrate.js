import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  {
    version: "0001",
    path: resolve(here, "migrations", "0001_baseline.sql")
  }
];

const baselineRepairs = [
  { table: "action_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "assignee", definition: "TEXT" },
  { table: "risk_items", column: "due", definition: "TEXT" },
  { table: "solution_drafts", column: "artifact_type", definition: "TEXT NOT NULL DEFAULT 'solution_framework'" }
];

export function canonicalMigrationSource(source) {
  return source.replace(/\r\n/g, "\n");
}

export function migrationChecksum(source) {
  return createHash("sha256").update(canonicalMigrationSource(source)).digest("hex");
}

function repairBaselineColumns(db) {
  for (const repair of baselineRepairs) {
    const columns = db.prepare(`PRAGMA table_info(${repair.table})`).all();
    if (!columns.some((column) => column.name === repair.column)) {
      db.exec(`ALTER TABLE ${repair.table} ADD COLUMN ${repair.column} ${repair.definition}`);
    }
  }
}

export function migrateDatabase(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const findMigration = db.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = :version"
    );
    const recordMigration = db.prepare(`
      INSERT INTO schema_migrations (version, checksum, applied_at)
      VALUES (:version, :checksum, CURRENT_TIMESTAMP)
    `);
    for (const migration of migrations) {
      const source = canonicalMigrationSource(readFileSync(migration.path, "utf8"));
      const checksum = migrationChecksum(source);
      const applied = findMigration.get({ version: migration.version });

      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(`Checksum mismatch for migration ${migration.version}`);
        }
        continue;
      }

      db.exec(source);
      if (migration.version === "0001") repairBaselineColumns(db);
      recordMigration.run({ version: migration.version, checksum });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
