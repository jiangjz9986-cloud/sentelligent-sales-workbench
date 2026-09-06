/**
 * Extend the encrypted settings store for provider-managed notification
 * credentials and bounded delivery health metadata.
 *
 * This is a table rebuild because SQLite cannot alter a CHECK constraint in
 * place. Existing ciphertext is copied byte-for-byte; no secret is decrypted
 * or written to a second plaintext location during migration.
 */
export function apply(db) {
  db.exec(`
    CREATE TABLE secure_settings_next (
      setting_key TEXT PRIMARY KEY NOT NULL CHECK (
        setting_key IN (
          'icost_webhook_token',
          'deepseek_api_key',
          'hospital_tender_pushplus_token'
        )
      ),
      ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      updated_at TEXT NOT NULL,
      last_success_at TEXT,
      last_failure_at TEXT,
      last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
      last_delivery_count INTEGER CHECK (last_delivery_count IS NULL OR last_delivery_count >= 0),
      last_chunk_count INTEGER CHECK (last_chunk_count IS NULL OR last_chunk_count >= 0),
      CHECK ((status = 'active' AND ciphertext IS NOT NULL) OR (status = 'cleared' AND ciphertext IS NULL))
    );

    INSERT INTO secure_settings_next (
      setting_key, ciphertext, status, created_at, rotated_at, updated_at
    )
    SELECT setting_key, ciphertext, status, created_at, rotated_at, updated_at
    FROM secure_settings;

    DROP TABLE secure_settings;
    ALTER TABLE secure_settings_next RENAME TO secure_settings;
  `);
}
