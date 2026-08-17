export function apply(db) {
  db.exec(`
    CREATE TABLE hospital_tender_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 1 AND 1440),
      batch_size INTEGER NOT NULL DEFAULT 10 CHECK (batch_size BETWEEN 1 AND 200),
      cursor_customer_id TEXT,
      cycle_number INTEGER NOT NULL DEFAULT 0 CHECK (cycle_number >= 0),
      snapshot_id TEXT,
      cycle_customer_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_customer_count >= 0),
      cycle_processed_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_processed_count >= 0),
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (last_status IN ('idle', 'running', 'success', 'partial', 'failed', 'disabled', 'waiting')),
      last_error TEXT,
      last_batch_start_customer_id TEXT,
      last_batch_end_customer_id TEXT,
      last_batch_count INTEGER NOT NULL DEFAULT 0 CHECK (last_batch_count >= 0),
      last_accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (last_accepted_count >= 0),
      last_rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (last_rejected_count >= 0),
      last_high_relevance_count INTEGER NOT NULL DEFAULT 0 CHECK (last_high_relevance_count >= 0),
      notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
      next_run_at TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO hospital_tender_scheduler_state (id, updated_at)
    VALUES (1, CURRENT_TIMESTAMP);

    CREATE TABLE hospital_tender_scheduler_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
      generated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error_text TEXT
    );

    CREATE INDEX idx_hospital_tender_scheduler_snapshots_status
      ON hospital_tender_scheduler_snapshots(status, created_at DESC);

    CREATE TABLE hospital_tender_scheduler_runs (
      id TEXT PRIMARY KEY NOT NULL,
      cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
      snapshot_id TEXT,
      batch_start_customer_id TEXT,
      batch_end_customer_id TEXT,
      batch_count INTEGER NOT NULL DEFAULT 0 CHECK (batch_count >= 0),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
      accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
      rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
      high_relevance_count INTEGER NOT NULL DEFAULT 0 CHECK (high_relevance_count >= 0),
      notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
      error_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_hospital_tender_scheduler_runs_started
      ON hospital_tender_scheduler_runs(started_at DESC, id DESC);

    CREATE TABLE hospital_tender_scheduler_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO hospital_tender_scheduler_lock (id, updated_at)
    VALUES (1, CURRENT_TIMESTAMP);
  `);
}
