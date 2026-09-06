// v0.11.1 proactive assistant confirmation previews: persist the exact,
// server-generated preview that a person saw before any action/risk writeback.
// The row keeps the owner, source snapshot versions, digest, revision and
// lifecycle timestamps so a later confirmation can be audited and replayed
// without trusting mutable client text.

export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_confirmation_previews (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      suggestion_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('action', 'risk')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled', 'expired')),
      customer_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      opportunity_version INTEGER NOT NULL CHECK (opportunity_version >= 1),
      customer_version INTEGER NOT NULL CHECK (customer_version >= 1),
      preview_digest TEXT NOT NULL CHECK (length(preview_digest) = 64),
      preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      confirmed_by TEXT,
      result_item_id TEXT,
      UNIQUE (owner, suggestion_id, target, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_confirmation_previews_owner_status
      ON proactive_confirmation_previews(owner, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_confirmation_previews_suggestion
      ON proactive_confirmation_previews(owner, suggestion_id, target, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_confirmation_previews_expiry
      ON proactive_confirmation_previews(status, expires_at);
  `);
}
