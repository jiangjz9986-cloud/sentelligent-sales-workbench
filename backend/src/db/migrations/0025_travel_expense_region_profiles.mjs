/**
 * Owner-scoped natural-week travel regions and immutable expense snapshots.
 *
 * A profile is mutable configuration for one natural week. Formal expense
 * rows keep the resolved region and provenance that existed when the user
 * confirmed the bookkeeping draft, so later profile edits cannot rewrite
 * historical accounting facts.
 */
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS travel_expense_region_profiles (
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      week_start TEXT NOT NULL CHECK (
        date(week_start) = week_start AND strftime('%w', week_start) = '1'
      ),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      cities_json TEXT NOT NULL CHECK (json_valid(cities_json) AND json_type(cities_json) = 'array'),
      default_city TEXT CHECK (default_city IS NULL OR length(default_city) BETWEEN 1 AND 100),
      date_overrides_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(date_overrides_json) AND json_type(date_overrides_json) = 'array'),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
      updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, week_start)
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expense_region_profiles_owner_week
      ON travel_expense_region_profiles(owner, week_start, updated_at);
  `);

  const columns = new Set(
    db.prepare("PRAGMA table_info(travel_expenses)").all().map((column) => column.name),
  );
  if (!columns.has("trip_region")) {
    db.exec(`
      ALTER TABLE travel_expenses
      ADD COLUMN trip_region TEXT
        CHECK (trip_region IS NULL OR length(trip_region) BETWEEN 1 AND 100)
    `);
  }
  if (!columns.has("trip_region_source")) {
    db.exec(`
      ALTER TABLE travel_expenses
      ADD COLUMN trip_region_source TEXT
        CHECK (trip_region_source IS NULL OR trip_region_source IN (
          'week_default', 'date_override', 'user_correction', 'itinerary', 'payment_text'
        ))
    `);
  }
}
