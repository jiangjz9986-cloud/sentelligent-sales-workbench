// v0.11.1 durable proactive runtime.
//
// The existing ai_suggestions table is the shared suggestion ledger used by
// the manual AI review surface.  Proactive rows stay in that ledger and use
// the `proactive_*` columns below for their distinct lifecycle/deduplication
// contract; legacy/manual rows keep their existing status semantics.  Scanner
// state, execution history, leases and business-change events have separate
// tables because those concerns do not fit assistant_agent_runs or the
// assistant inbound-event (HTTP/conversation) contract.

function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  const columns = columnsFor(db, "ai_suggestions");
  const proactiveColumns = [
    ["proactive_trigger", "TEXT"],
    ["proactive_subject_type", "TEXT"],
    ["proactive_subject_id", "TEXT"],
    ["proactive_customer_id", "TEXT"],
    ["proactive_opportunity_id", "TEXT"],
    ["proactive_dedupe_key", "TEXT"],
    ["proactive_rule_version", "TEXT"],
    ["proactive_priority", "INTEGER NOT NULL DEFAULT 0"],
    ["proactive_status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["proactive_stale_at", "TEXT"],
    ["proactive_snoozed_until", "TEXT"],
    ["proactive_dismiss_reason", "TEXT"],
    ["proactive_resolved_at", "TEXT"],
    ["proactive_result_refs", "TEXT NOT NULL DEFAULT '[]'"],
    ["proactive_run_id", "TEXT"],
    ["proactive_event_id", "TEXT"],
    ["proactive_generated_at", "TEXT"],
    ["proactive_last_seen_at", "TEXT"],
    ["proactive_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ["proactive_next_retry_at", "TEXT"],
    ["proactive_payload_hash", "TEXT"],
  ];
  for (const [name, definition] of proactiveColumns) {
    addColumnIfMissing(db, "ai_suggestions", columns, name, definition);
  }

  db.exec(`
    UPDATE ai_suggestions
       SET proactive_status = COALESCE(NULLIF(proactive_status, ''), 'pending'),
           proactive_result_refs = CASE
             WHEN proactive_result_refs IS NULL OR trim(proactive_result_refs) = '' THEN '[]'
             ELSE proactive_result_refs
           END,
           proactive_failure_count = COALESCE(proactive_failure_count, 0)
     WHERE proactive_trigger IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_suggestions_proactive_dedupe
      ON ai_suggestions(owner, proactive_dedupe_key)
      WHERE proactive_dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_proactive_owner_status
      ON ai_suggestions(owner, proactive_status, proactive_priority DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_proactive_subject
      ON ai_suggestions(owner, proactive_subject_type, proactive_subject_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_proactive_retry
      ON ai_suggestions(proactive_status, proactive_next_retry_at)
      WHERE proactive_next_retry_at IS NOT NULL;

    DROP TRIGGER IF EXISTS ai_suggestions_proactive_status_insert_guard;
    DROP TRIGGER IF EXISTS ai_suggestions_proactive_status_update_guard;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_proactive_status_insert_guard
    BEFORE INSERT ON ai_suggestions
    WHEN NEW.proactive_status NOT IN (
      'pending', 'deferred', 'snoozed', 'dismissed', 'ignored', 'resolved',
      'confirmed', 'executed', 'conflict', 'expired', 'failed'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid proactive suggestion status');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_proactive_status_update_guard
    BEFORE UPDATE OF proactive_status ON ai_suggestions
    WHEN NEW.proactive_status NOT IN (
      'pending', 'deferred', 'snoozed', 'dismissed', 'ignored', 'resolved',
      'confirmed', 'executed', 'conflict', 'expired', 'failed'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid proactive suggestion status');
    END;

    CREATE TABLE IF NOT EXISTS proactive_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (interval_seconds BETWEEN 30 AND 86400),
      batch_size INTEGER NOT NULL DEFAULT 50 CHECK (batch_size BETWEEN 1 AND 500),
      cursor_owner TEXT,
      cursor_opportunity_id TEXT,
      cycle_number INTEGER NOT NULL DEFAULT 0 CHECK (cycle_number >= 0),
      cycle_object_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_object_count >= 0),
      cycle_processed_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_processed_count >= 0),
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (last_status IN ('idle', 'running', 'success', 'partial', 'failed', 'disabled', 'waiting')),
      last_error TEXT,
      last_run_id TEXT,
      last_batch_count INTEGER NOT NULL DEFAULT 0 CHECK (last_batch_count >= 0),
      last_suggestion_count INTEGER NOT NULL DEFAULT 0 CHECK (last_suggestion_count >= 0),
      last_inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (last_inserted_count >= 0),
      last_deduped_count INTEGER NOT NULL DEFAULT 0 CHECK (last_deduped_count >= 0),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      next_retry_at TEXT,
      next_run_at TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO proactive_scan_state (id, updated_at)
    VALUES (1, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS proactive_scan_runs (
      id TEXT PRIMARY KEY NOT NULL,
      cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
      trigger TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (trigger IN ('scheduled', 'event', 'manual', 'recovery')),
      worker_id TEXT NOT NULL,
      cursor_owner TEXT,
      cursor_opportunity_id TEXT,
      next_cursor_owner TEXT,
      next_cursor_opportunity_id TEXT,
      batch_count INTEGER NOT NULL DEFAULT 0 CHECK (batch_count >= 0),
      object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
      suggestion_count INTEGER NOT NULL DEFAULT 0 CHECK (suggestion_count >= 0),
      inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
      deduped_count INTEGER NOT NULL DEFAULT 0 CHECK (deduped_count >= 0),
      event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
      error_code TEXT,
      error_text TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_scan_runs_started
      ON proactive_scan_runs(started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_scan_runs_status
      ON proactive_scan_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS proactive_scan_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      worker_id TEXT,
      lease_token_hash TEXT,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO proactive_scan_lease (id, updated_at)
    VALUES (1, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS proactive_scan_events (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 500),
      event_type TEXT NOT NULL DEFAULT 'business_change'
        CHECK (length(event_type) BETWEEN 1 AND 100),
      entity_type TEXT,
      entity_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at TEXT NOT NULL,
      lease_token_hash TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      last_error_text TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_scan_events_claim
      ON proactive_scan_events(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_proactive_scan_events_owner_status
      ON proactive_scan_events(owner, status, updated_at DESC);
  `);
}
