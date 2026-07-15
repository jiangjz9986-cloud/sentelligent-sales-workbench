export function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function apply(db) {
  for (const table of [
    "customers",
    "opportunities",
    "quick_records",
    "weekly_reports",
    "solution_drafts",
    "action_items",
    "risk_items",
    "knowledge_items",
  ]) {
    addColumnIfMissing(db, table, "version", "INTEGER NOT NULL DEFAULT 1");
  }

  for (const table of [
    "customers",
    "opportunities",
    "weekly_reports",
    "action_items",
    "risk_items",
    "knowledge_items",
  ]) {
    addColumnIfMissing(db, table, "deleted_at", "TEXT");
    addColumnIfMissing(db, table, "deleted_by", "TEXT");
  }

  addColumnIfMissing(db, "quick_records", "voided_at", "TEXT");
  addColumnIfMissing(db, "quick_records", "voided_by", "TEXT");
  addColumnIfMissing(db, "quick_records", "void_reason", "TEXT");

  addColumnIfMissing(db, "audit_logs", "request_id", "TEXT");
  addColumnIfMissing(db, "audit_logs", "before_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "audit_logs", "after_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "audit_logs", "entity_version", "INTEGER");

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      account TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
      ON auth_sessions(token_hash, expires_at, revoked_at);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      actor TEXT NOT NULL,
      method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
      response_status INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (actor, method, request_path, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
      ON idempotency_keys(expires_at);

    CREATE TABLE IF NOT EXISTS login_rate_limits (
      key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      blocked_until TEXT
    );
  `);
}
