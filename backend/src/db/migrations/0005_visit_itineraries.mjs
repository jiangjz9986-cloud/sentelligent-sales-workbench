export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visit_itineraries (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      title TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'completed', 'cancelled')),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_visit_itineraries_active_date
      ON visit_itineraries(visit_date DESC, updated_at DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_visit_itineraries_status
      ON visit_itineraries(status, visit_date DESC)
      WHERE deleted_at IS NULL;
  `);
}
