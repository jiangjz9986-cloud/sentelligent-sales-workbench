export const version = "0004";

export function apply(db) {
  db.exec(`
    CREATE TABLE platform_auth_replays (
      nonce_digest TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_platform_auth_replays_expiry ON platform_auth_replays(expires_at);
  `);
}
