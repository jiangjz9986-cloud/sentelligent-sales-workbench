// v0.12.0 preserves the complete human-reviewed writeback draft and its
// provenance on action/risk rows.
function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  const actionColumns = columnsFor(db, "action_items");
  addColumnIfMissing(db, "action_items", actionColumns, "expected_result", "TEXT");
  addColumnIfMissing(db, "action_items", actionColumns, "source_type", "TEXT");
  addColumnIfMissing(db, "action_items", actionColumns, "source_id", "TEXT");
  addColumnIfMissing(db, "action_items", actionColumns, "source_proactive_id", "TEXT");
  addColumnIfMissing(db, "action_items", actionColumns, "writeback_digest", "TEXT");

  const riskColumns = columnsFor(db, "risk_items");
  addColumnIfMissing(db, "risk_items", riskColumns, "expected_result", "TEXT");
  addColumnIfMissing(db, "risk_items", riskColumns, "source_proactive_id", "TEXT");
  addColumnIfMissing(db, "risk_items", riskColumns, "writeback_digest", "TEXT");

  db.exec(`
    UPDATE action_items
       SET source_type = COALESCE(source_type, CASE WHEN source_record_id IS NOT NULL THEN 'quick_record' ELSE NULL END),
           source_id = COALESCE(source_id, source_record_id)
     WHERE source_type IS NULL OR source_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_action_items_source_identity
      ON action_items(owner, source_type, source_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_action_items_proactive_source
      ON action_items(owner, source_proactive_id)
      WHERE source_proactive_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_risk_items_proactive_source
      ON risk_items(owner, source_proactive_id)
      WHERE source_proactive_id IS NOT NULL;
  `);
}
