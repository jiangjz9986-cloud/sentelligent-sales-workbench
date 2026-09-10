export const version = "0008";
export function apply(db) {
  db.exec("ALTER TABLE tasks ADD COLUMN payload_pruned_at TEXT");
  db.exec("CREATE INDEX idx_tasks_payload_retention ON tasks(completed_at) WHERE payload_pruned_at IS NULL AND status IN ('succeeded','failed','cancelled','expired')");
}
