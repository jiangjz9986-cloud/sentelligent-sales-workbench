/**
 * Extend the encrypted settings store with the server-side ASR credential.
 *
 * SQLite cannot alter the existing setting_key CHECK constraint in place, so
 * this migration rebuilds the table. The migration runner owns the enclosing
 * transaction. Existing ciphertext and delivery metadata are copied as opaque
 * values and verified before the original table is replaced.
 */
export function apply(db) {
  db.exec(`
    CREATE TABLE secure_settings_next (
      setting_key TEXT PRIMARY KEY NOT NULL CHECK (
        setting_key IN (
          'icost_webhook_token',
          'deepseek_api_key',
          'hospital_tender_pushplus_token',
          'asr_api_key'
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
      setting_key,
      ciphertext,
      status,
      created_at,
      rotated_at,
      updated_at,
      last_success_at,
      last_failure_at,
      last_error_code,
      last_delivery_count,
      last_chunk_count
    )
    SELECT
      setting_key,
      ciphertext,
      status,
      created_at,
      rotated_at,
      updated_at,
      last_success_at,
      last_failure_at,
      last_error_code,
      last_delivery_count,
      last_chunk_count
    FROM secure_settings;
  `);

  const sourceCount = db.prepare("SELECT COUNT(*) AS count FROM secure_settings").get().count;
  const copiedCount = db.prepare("SELECT COUNT(*) AS count FROM secure_settings_next").get().count;
  const missingSourceKeys = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT setting_key FROM secure_settings
      EXCEPT
      SELECT setting_key FROM secure_settings_next
    )
  `).get().count;
  const unexpectedCopiedKeys = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT setting_key FROM secure_settings_next
      EXCEPT
      SELECT setting_key FROM secure_settings
    )
  `).get().count;
  const missingSourceRows = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      FROM secure_settings
      EXCEPT
      SELECT
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      FROM secure_settings_next
    )
  `).get().count;
  const unexpectedCopiedRows = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      FROM secure_settings_next
      EXCEPT
      SELECT
        setting_key, ciphertext, status, created_at, rotated_at, updated_at,
        last_success_at, last_failure_at, last_error_code,
        last_delivery_count, last_chunk_count
      FROM secure_settings
    )
  `).get().count;

  if (
    sourceCount !== copiedCount
    || missingSourceKeys !== 0
    || unexpectedCopiedKeys !== 0
    || missingSourceRows !== 0
    || unexpectedCopiedRows !== 0
  ) {
    throw new Error("Secure settings ASR migration verification failed");
  }

  db.exec(`
    DROP TABLE secure_settings;
    ALTER TABLE secure_settings_next RENAME TO secure_settings;
  `);
}
