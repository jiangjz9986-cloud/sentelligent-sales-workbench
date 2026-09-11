export const version = "0010";

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

export function apply(db) {
  if (!hasColumn(db, "tasks", "price_version_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN price_version_id TEXT REFERENCES price_versions(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_price_version ON tasks(price_version_id)");

  // Only fill legacy nulls. Once a task has a price pin, a later migration
  // rerun must not change the version used for its reservation or settlement.
  db.exec(`
    UPDATE tasks
       SET price_version_id = (
         SELECT pv.id
           FROM price_versions pv
          WHERE pv.model_id = tasks.model_id
            AND pv.effective_from <= tasks.requested_at
            AND (pv.effective_to IS NULL OR pv.effective_to > tasks.requested_at)
          ORDER BY pv.effective_from DESC, pv.created_at DESC, pv.id DESC
          LIMIT 1
       )
     WHERE price_version_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM price_versions pv
          WHERE pv.model_id = tasks.model_id
            AND pv.effective_from <= tasks.requested_at
            AND (pv.effective_to IS NULL OR pv.effective_to > tasks.requested_at)
       )
  `);
}
