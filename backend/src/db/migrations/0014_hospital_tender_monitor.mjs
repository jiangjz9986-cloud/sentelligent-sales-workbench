export function apply(db) {
  db.exec(`
    CREATE TABLE hospital_tender_notices (
      id TEXT PRIMARY KEY NOT NULL,
      identity_key TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      city TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      published_at TEXT NOT NULL,
      notice_type TEXT NOT NULL,
      purchaser TEXT,
      project_code TEXT,
      budget_text TEXT,
      deadline_text TEXT,
      content_text TEXT,
      hospital_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hospital_names_json)),
      source_item_id TEXT,
      content_sha256 TEXT CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')),
      relevance TEXT NOT NULL,
      match_customer_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(match_customer_ids_json)),
      match_reasons_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(match_reasons_json)),
      matched_needs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(matched_needs_json)),
      match_score INTEGER NOT NULL DEFAULT 0 CHECK (match_score >= 0),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX idx_hospital_tender_notices_published
      ON hospital_tender_notices(published_at DESC, id ASC);
    CREATE INDEX idx_hospital_tender_notices_source
      ON hospital_tender_notices(source_id, published_at DESC);
    CREATE INDEX idx_hospital_tender_notices_relevance
      ON hospital_tender_notices(relevance, published_at DESC);

    CREATE TABLE hospital_tender_sources (
      source_id TEXT PRIMARY KEY NOT NULL,
      source_name TEXT NOT NULL,
      status TEXT NOT NULL,
      last_run_at TEXT,
      last_success_at TEXT,
      last_item_count INTEGER NOT NULL DEFAULT 0 CHECK (last_item_count >= 0),
      last_upserted_count INTEGER NOT NULL DEFAULT 0 CHECK (last_upserted_count >= 0),
      last_rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (last_rejected_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE hospital_tender_runs (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
      upserted_count INTEGER NOT NULL DEFAULT 0 CHECK (upserted_count >= 0),
      rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
      error_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_hospital_tender_runs_finished
      ON hospital_tender_runs(started_at DESC, id DESC);
  `);
}
