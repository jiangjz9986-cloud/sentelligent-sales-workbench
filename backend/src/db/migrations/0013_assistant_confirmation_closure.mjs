export function apply(db) {
  db.exec(`
    CREATE TABLE assistant_pending_actions_0013 (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_id TEXT REFERENCES assistant_conversations(id) ON DELETE SET NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'confirmed', 'executed', 'expired', 'cancelled', 'failed')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      confirmation_code_hash TEXT NOT NULL CHECK (length(confirmation_code_hash) = 64 AND confirmation_code_hash NOT GLOB '*[^0-9a-f]*'),
      lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
      lease_expires_at TEXT,
      expires_at TEXT NOT NULL,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      plan_digest TEXT,
      confirmation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_attempts BETWEEN 0 AND 5),
      confirmation_locked_at TEXT
    );

    INSERT INTO assistant_pending_actions_0013 (
      id, owner, channel, conversation_id, action_type, payload_json, status, version,
      confirmation_code_hash, lease_token_hash, lease_expires_at, expires_at, result_json,
      error_code, created_at, updated_at, plan_digest, confirmation_attempts,
      confirmation_locked_at
    )
    SELECT
      id, owner, channel, conversation_id, action_type, payload_json, status, version,
      confirmation_code_hash, lease_token_hash, lease_expires_at, expires_at, result_json,
      error_code, created_at, updated_at, plan_digest, 0, NULL
    FROM assistant_pending_actions;

    DROP TABLE assistant_pending_actions;
    ALTER TABLE assistant_pending_actions_0013 RENAME TO assistant_pending_actions;

    CREATE INDEX idx_assistant_actions_status
      ON assistant_pending_actions(owner, channel, status, expires_at);
    CREATE UNIQUE INDEX idx_assistant_actions_one_active_per_conversation
      ON assistant_pending_actions(owner, channel, conversation_id)
      WHERE conversation_id IS NOT NULL AND status IN ('pending', 'processing', 'confirmed');

    CREATE TABLE assistant_confirmation_attempts (
      action_id TEXT NOT NULL REFERENCES assistant_pending_actions(id) ON DELETE CASCADE,
      event_id_hash TEXT NOT NULL CHECK (length(event_id_hash) = 64 AND event_id_hash NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (action_id, event_id_hash)
    );
  `);
}
