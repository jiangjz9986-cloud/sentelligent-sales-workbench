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

function checksumFor(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function migrateDatabase(db) {
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
    const checksum = checksumFor(migration.path);
    const applied = findMigration.get({ version: migration.version });

    if (applied) {
      if (applied.checksum !== checksum) {
        throw new Error(`Checksum mismatch for migration ${migration.version}`);
      }
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(migration.path, "utf8"));
      recordMigration.run({ version: migration.version, checksum });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
