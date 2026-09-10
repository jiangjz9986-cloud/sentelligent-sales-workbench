import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as core from "./migrations/0001_core.mjs";
import * as seed from "./migrations/0002_seed.mjs";
import * as control from "./migrations/0003_operational_control.mjs";
import * as authReplays from "./migrations/0004_auth_replays.mjs";
import * as mediaObjects from "./migrations/0005_media_objects.mjs";
import * as priceCalendars from "./migrations/0006_price_calendars.mjs";
import * as providerCredentials from "./migrations/0007_provider_credentials.mjs";
import * as payloadRetention from "./migrations/0008_task_payload_retention.mjs";
import { withImmediateTransaction } from "../utils.js";

const MIGRATIONS = [
  { migration: core, file: "0001_core.mjs" },
  { migration: seed, file: "0002_seed.mjs" },
  { migration: control, file: "0003_operational_control.mjs" },
  { migration: authReplays, file: "0004_auth_replays.mjs" },
  { migration: mediaObjects, file: "0005_media_objects.mjs" },
  { migration: priceCalendars, file: "0006_price_calendars.mjs" },
  { migration: providerCredentials, file: "0007_provider_credentials.mjs" },
  { migration: payloadRetention, file: "0008_task_payload_retention.mjs" },
];

function migrationChecksum(file) {
  const source = readFileSync(new URL(`./migrations/${file}`, import.meta.url));
  return createHash("sha256").update(source).digest("hex");
}

export function migrateAiPlatformDatabase(db, { clock = () => new Date() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const find = db.prepare("SELECT checksum FROM platform_migrations WHERE version = $version");
  const insert = db.prepare("INSERT INTO platform_migrations (version, checksum, applied_at) VALUES ($version, $checksum, $appliedAt)");
  for (const { migration, file } of MIGRATIONS) {
    const checksum = migrationChecksum(file);
    withImmediateTransaction(db, () => {
      const row = find.get({ $version: migration.version });
      if (row && row.checksum !== checksum) throw new Error(`checksum mismatch for AI platform migration ${migration.version}`);
      if (row) return;
      migration.apply(db);
      insert.run({ $version: migration.version, $checksum: checksum, $appliedAt: clock().toISOString() });
    });
  }
  return db;
}
