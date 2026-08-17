export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shortcut_webhook_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL UNIQUE CHECK (
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
      ),
      token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 1 AND 12),
      label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
      account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shortcut_webhook_tokens_account
      ON shortcut_webhook_tokens(account, revoked_at, created_at);
  `);
}
