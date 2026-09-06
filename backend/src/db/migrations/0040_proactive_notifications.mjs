// Durable in-app and external-delivery ledger for proactive suggestions.
// One row represents one immutable suggestion revision.  The row is always
// retained for the in-app inbox even when WeChat/PushPlus is unavailable.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      suggestion_id TEXT NOT NULL REFERENCES ai_suggestions(id),
      suggestion_version INTEGER NOT NULL CHECK (suggestion_version >= 1),
      channel TEXT NOT NULL DEFAULT 'in_app'
        CHECK (channel IN ('in_app', 'weixin', 'pushplus')),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'read')),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      trigger TEXT NOT NULL CHECK (length(trigger) BETWEEN 1 AND 100),
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
      outbox_id TEXT REFERENCES weixin_confirmation_outbox(id),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at TEXT NOT NULL,
      last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
      delivery_started_at TEXT,
      sent_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, suggestion_id, suggestion_version)
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_notifications_owner_status
      ON proactive_notifications(owner, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_notifications_due
      ON proactive_notifications(status, available_at, created_at)
      WHERE status IN ('queued', 'processing');
    CREATE INDEX IF NOT EXISTS idx_proactive_notifications_suggestion
      ON proactive_notifications(owner, suggestion_id, suggestion_version DESC);
  `);
}
