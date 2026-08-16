export function apply(db) {
  db.exec(`
    CREATE TABLE secure_settings (
      setting_key TEXT PRIMARY KEY NOT NULL CHECK (setting_key IN ('icost_webhook_token', 'deepseek_api_key')),
      ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'active' AND ciphertext IS NOT NULL) OR (status = 'cleared' AND ciphertext IS NULL))
    );
  `);
}
