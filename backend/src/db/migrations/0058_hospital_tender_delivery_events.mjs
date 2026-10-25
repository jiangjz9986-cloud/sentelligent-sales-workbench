import { createHash } from "node:crypto";

export function apply(db) {
  const legacyPending = db.prepare(`
    SELECT 1 FROM hospital_tender_scheduler_state state
    JOIN hospital_tender_scheduler_snapshots snapshot ON snapshot.id = state.snapshot_id
    WHERE snapshot.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hospital_tender_notification_batches'
      )
  `).get();
  if (legacyPending) {
    // The old notifier can have accepted some chunks before rejecting another.
    // Its original keys must be reconciled before a silent historical baseline.
    throw new Error("LEGACY_TENDER_NOTIFICATION_RECOVERY_REQUIRED");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_tender_notification_batches (
      id TEXT PRIMARY KEY NOT NULL,
      cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'cancelled')),
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hospital_tender_notification_events (
      id TEXT PRIMARY KEY NOT NULL,
      canonical_notice_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      batch_id TEXT REFERENCES hospital_tender_notification_batches(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'suppressed', 'cancelled')),
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      UNIQUE (canonical_notice_id, customer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_pending_notification_batches
      ON hospital_tender_notification_batches(created_at, id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_notification_batch_events
      ON hospital_tender_notification_events(batch_id, status);
    CREATE TABLE IF NOT EXISTS hospital_tender_collector_progress (
      source_id TEXT PRIMARY KEY NOT NULL,
      configuration_digest TEXT NOT NULL CHECK (length(configuration_digest) = 64),
      cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
      updated_at TEXT NOT NULL
    );
  `);

  // Establish a quiet upgrade baseline; historical routing is not evidence
  // that an old notice should be sent again when this outbox is introduced.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO hospital_tender_notification_events
      (id, canonical_notice_id, customer_id, status, created_at, acknowledged_at)
    VALUES (?, ?, ?, 'acknowledged', ?, ?)
  `);
  for (const row of db.prepare(`
    SELECT canonical_notice_id, identity_key, match_customer_ids_json, last_seen_at
    FROM hospital_tender_notices
  `).all()) {
    const canonicalId = row.canonical_notice_id || row.identity_key;
    let ids;
    try { ids = JSON.parse(row.match_customer_ids_json); } catch { continue; }
    if (!canonicalId || !Array.isArray(ids)) continue;
    for (const customerId of new Set(ids)) {
      if (typeof customerId !== "string" || !customerId.trim()) continue;
      const id = createHash("sha256").update(JSON.stringify([canonicalId, customerId])).digest("hex");
      insert.run(id, canonicalId, customerId, row.last_seen_at, row.last_seen_at);
    }
  }
}
