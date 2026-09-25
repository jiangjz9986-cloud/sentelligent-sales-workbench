// Separate durable in-app notices from bookkeeping-only WeChat delivery and
// record asynchronous PushPlus tender submissions without claiming delivery.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS in_app_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      category TEXT NOT NULL CHECK (category IN ('daily_digest', 'action_reminder', 'invoice_escalation', 'ops_alert', 'proactive_assistant')),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
      href TEXT NOT NULL CHECK (length(href) BETWEEN 1 AND 500 AND substr(href, 1, 1) = '/' AND substr(href, 1, 2) <> '//'),
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
      created_at TEXT NOT NULL,
      read_at TEXT,
      UNIQUE (owner, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_in_app_notifications_owner_created
      ON in_app_notifications(owner, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_in_app_notifications_owner_unread
      ON in_app_notifications(owner, created_at DESC) WHERE read_at IS NULL;

    CREATE TABLE IF NOT EXISTS hospital_tender_pushplus_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      delivery_key TEXT NOT NULL UNIQUE CHECK (length(delivery_key) = 64 AND delivery_key NOT GLOB '*[^0-9a-f]*'),
      cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 3500),
      status TEXT NOT NULL CHECK (status IN ('queued', 'submitting', 'accepted', 'sent', 'failed', 'uncertain')),
      provider_short_code TEXT CHECK (provider_short_code IS NULL OR length(provider_short_code) BETWEEN 1 AND 200),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
      next_check_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tender_pushplus_result_checks
      ON hospital_tender_pushplus_deliveries(status, next_check_at, created_at)
      WHERE status = 'accepted';

    UPDATE weixin_confirmation_outbox
       SET status = 'failed', last_error_code = 'CHANNEL_RETIRED', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'queued'
       AND json_valid(payload_json)
       AND json_extract(payload_json, '$.kind') IN (
         'hospital_tender_notice', 'action_reminder', 'daily_digest',
         'friday_closeout', 'ops_alert', 'invoice_gap_escalation', 'proactive_suggestion'
       );
  `);
}
