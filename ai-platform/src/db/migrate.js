import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as core from "./migrations/0001_core.mjs";
import * as seed from "./migrations/0002_seed.mjs";

const MIGRATIONS = [core, seed];

function migrationChecksum(migration) {
  const source = readFileSync(new URL(`./migrations/${migration.version}_${migration === core ? "core" : "seed"}.mjs`, import.meta.url));
  return createHash("sha256").update(source).digest("hex");
}

export function migrateAiPlatformDatabase(db, { clock = () => new Date() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const find = db.prepare("SELECT checksum FROM platform_migrations WHERE version = $version");
  const insert = db.prepare("INSERT INTO platform_migrations (version, checksum, applied_at) VALUES ($version, $checksum, $appliedAt)");
  for (const migration of MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    const row = find.get({ $version: migration.version });
    if (row && row.checksum !== checksum) throw new Error(`checksum mismatch for AI platform migration ${migration.version}`);
    if (row) continue;
    migration.apply(db);
    insert.run({ $version: migration.version, $checksum: checksum, $appliedAt: clock().toISOString() });
  }
  return db;
}
