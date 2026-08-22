export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_confirmation_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      conversation_id TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 300),
      idempotency_key_hash TEXT NOT NULL CHECK (
        length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      ),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 20000),
      payload_hash TEXT NOT NULL CHECK (
        length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at TEXT NOT NULL,
      lease_proof_hash TEXT CHECK (
        lease_proof_hash IS NULL OR (length(lease_proof_hash) = 64 AND lease_proof_hash NOT GLOB '*[^0-9a-f]*')
      ),
      lease_until TEXT,
      last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
      provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE (owner, idempotency_key_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_weixin_confirmation_outbox_ready
      ON weixin_confirmation_outbox(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_weixin_confirmation_outbox_owner
      ON weixin_confirmation_outbox(owner, status, created_at);
  `);
}
