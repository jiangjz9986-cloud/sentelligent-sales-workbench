// v0.13.4 provider credential synchronization journal.
//
// secure_settings remains the business-owned compatibility mirror.  These
// tables record the cross-service operation separately so a platform write
// can be compensated without putting plaintext credentials in the business
// audit log or relying on an environment fallback.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secure_setting_sync_state (
      setting_key TEXT PRIMARY KEY NOT NULL
        CHECK (setting_key IN ('deepseek_api_key', 'asr_api_key')),
      state TEXT NOT NULL DEFAULT 'local'
        CHECK (state IN ('local', 'pending', 'synchronized', 'degraded', 'unknown')),
      operation_id TEXT,
      platform_revision INTEGER NOT NULL DEFAULT 0
        CHECK (platform_revision >= 0),
      last_error_code TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secure_setting_sync_operations (
      id TEXT PRIMARY KEY NOT NULL,
      setting_key TEXT NOT NULL
        CHECK (setting_key IN ('deepseek_api_key', 'asr_api_key')),
      operation TEXT NOT NULL CHECK (operation IN ('set', 'clear')),
      state TEXT NOT NULL
        CHECK (state IN ('prepared', 'platform_applied', 'synchronized', 'aborted', 'compensated', 'unknown')),
      previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
      desired_status TEXT NOT NULL CHECK (desired_status IN ('active', 'cleared')),
      desired_ciphertext TEXT,
      desired_digest TEXT NOT NULL CHECK (length(desired_digest) = 64),
      platform_revision_before INTEGER NOT NULL DEFAULT 0
        CHECK (platform_revision_before >= 0),
      platform_revision_after INTEGER
        CHECK (platform_revision_after IS NULL OR platform_revision_after >= 0),
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_secure_setting_sync_operations_key
      ON secure_setting_sync_operations(setting_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_setting_sync_operations_state
      ON secure_setting_sync_operations(state, updated_at DESC);
  `);
}
