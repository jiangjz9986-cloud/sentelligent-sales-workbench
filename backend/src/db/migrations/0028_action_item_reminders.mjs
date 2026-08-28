export function apply(db) {
  db.exec(`
    ALTER TABLE action_items ADD COLUMN owner TEXT;
    ALTER TABLE action_items ADD COLUMN remind_at TEXT;
    ALTER TABLE action_items ADD COLUMN reminded_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_action_items_remind
      ON action_items(remind_at)
      WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL;
    UPDATE action_items
       SET owner = (SELECT c.owner FROM customers c WHERE c.id = action_items.customer_id)
     WHERE owner IS NULL AND customer_id IS NOT NULL;
  `);
}
