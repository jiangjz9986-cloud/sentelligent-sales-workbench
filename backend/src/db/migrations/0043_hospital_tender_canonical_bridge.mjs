// v0.12.0 canonical hospital-tender notice identity and owner/customer bridge.
function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  const columns = columnsFor(db, "hospital_tender_notices");
  addColumnIfMissing(db, "hospital_tender_notices", columns, "canonical_notice_id", "TEXT");
  addColumnIfMissing(db, "hospital_tender_notices", columns, "canonical_revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "hospital_tender_notices", columns, "canonical_digest", "TEXT");
  addColumnIfMissing(db, "hospital_tender_notices", columns, "bridge_status", "TEXT NOT NULL DEFAULT 'unbridged'");
  addColumnIfMissing(db, "hospital_tender_notices", columns, "bridge_refs_json", "TEXT NOT NULL DEFAULT '[]'");

  db.exec(`
    UPDATE hospital_tender_notices
       SET canonical_notice_id = COALESCE(NULLIF(canonical_notice_id, ''), identity_key),
           canonical_revision = COALESCE(canonical_revision, 1),
           canonical_digest = COALESCE(canonical_digest, content_sha256),
           bridge_status = COALESCE(NULLIF(bridge_status, ''), 'unbridged'),
           bridge_refs_json = CASE
             WHEN bridge_refs_json IS NULL OR trim(bridge_refs_json) = '' THEN '[]'
             ELSE bridge_refs_json
           END;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_hospital_tender_canonical_notice
      ON hospital_tender_notices(canonical_notice_id)
      WHERE canonical_notice_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_notice_bridge_status
      ON hospital_tender_notices(bridge_status, published_at DESC);

    CREATE TABLE IF NOT EXISTS hospital_tender_bridges (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      canonical_notice_id TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unconverted'
        CHECK (status IN ('unconverted', 'previewed', 'confirmed', 'cancelled', 'conflict')),
      notice_revision INTEGER NOT NULL DEFAULT 1 CHECK (notice_revision >= 1),
      notice_digest TEXT NOT NULL CHECK (length(notice_digest) = 64 AND notice_digest NOT GLOB '*[^0-9a-f]*'),
      opportunity_id TEXT,
      action_item_id TEXT,
      preview_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, canonical_notice_id, customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_hospital_tender_bridges_owner_status
      ON hospital_tender_bridges(owner, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_bridges_notice
      ON hospital_tender_bridges(canonical_notice_id, customer_id);
  `);
}
