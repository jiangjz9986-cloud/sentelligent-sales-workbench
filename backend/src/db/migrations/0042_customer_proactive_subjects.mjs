// v0.12.0 customer-level proactive subject identity.
//
// Customer suggestions are aggregated across the owner's opportunities.  The
// subject ledger is separate from ai_suggestions so the scanner can advance a
// customer revision without losing the immutable suggestion history.
function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  const suggestionColumns = columnsFor(db, "ai_suggestions");
  addColumnIfMissing(db, "ai_suggestions", suggestionColumns, "proactive_subject_key", "TEXT");
  addColumnIfMissing(db, "ai_suggestions", suggestionColumns, "proactive_subject_version", "INTEGER");
  addColumnIfMissing(db, "ai_suggestions", suggestionColumns, "proactive_source_digest", "TEXT");
  addColumnIfMissing(db, "ai_suggestions", suggestionColumns, "proactive_source_refs", "TEXT NOT NULL DEFAULT '[]'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_subjects (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      subject_type TEXT NOT NULL CHECK (subject_type IN ('customer')),
      subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
      subject_key TEXT NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 500),
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, subject_type, subject_id),
      UNIQUE (owner, subject_key)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_subjects_owner_updated
      ON proactive_subjects(owner, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_subjects_customer
      ON proactive_subjects(owner, customer_id);
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_proactive_subject_key
      ON ai_suggestions(owner, proactive_subject_key, proactive_subject_version, created_at DESC)
      WHERE proactive_subject_key IS NOT NULL;
  `);
}
