export const version = "0005";

export function apply(db) {
  db.exec(`
    CREATE TABLE platform_media_objects (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      audio_seconds INTEGER,
      task_id TEXT REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX idx_platform_media_expiry ON platform_media_objects(deleted_at, expires_at);
    CREATE INDEX idx_platform_media_task ON platform_media_objects(task_id);
  `);
}
