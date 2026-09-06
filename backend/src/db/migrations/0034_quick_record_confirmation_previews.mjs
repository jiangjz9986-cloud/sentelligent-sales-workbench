// v0.11 快速记录确认 v2：把 AI 建议预览作为独立、可恢复的持久对象保存，
// 并给周报增加结构化条目列。预览创建本身只写确认元数据；只有显式确认后，
// repository 才会修改 customers.needs / opportunities.requirements /
// weekly_reports.entries_json。

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function apply(db) {
  db.exec(`
    CREATE TABLE quick_record_confirmation_previews (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      quick_record_id TEXT NOT NULL
        REFERENCES quick_records(id) ON DELETE CASCADE,
      draft_hash TEXT NOT NULL CHECK (length(draft_hash) = 64),
      identity TEXT NOT NULL CHECK (length(identity) = 64),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
      preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, quick_record_id, draft_hash)
    );

    CREATE INDEX idx_quick_record_confirmation_previews_owner
      ON quick_record_confirmation_previews(owner);
    CREATE INDEX idx_quick_record_confirmation_previews_record
      ON quick_record_confirmation_previews(quick_record_id);
    CREATE INDEX idx_quick_record_confirmation_previews_status
      ON quick_record_confirmation_previews(owner, status, updated_at DESC);
  `);

  addColumnIfMissing(
    db,
    "quick_records",
    "confirmation_preview_id",
    "TEXT REFERENCES quick_record_confirmation_previews(id) ON DELETE SET NULL",
  );
  addColumnIfMissing(
    db,
    "quick_records",
    "confirmation_preview_status",
    "TEXT CHECK (confirmation_preview_status IS NULL OR confirmation_preview_status IN ('open', 'completed', 'cancelled'))",
  );
  addColumnIfMissing(db, "weekly_reports", "entries_json", "TEXT NOT NULL DEFAULT '[]'");

  db.exec(`
    CREATE INDEX idx_quick_records_confirmation_preview
      ON quick_records(owner, confirmation_preview_status, confirmation_preview_id);
  `);
}
