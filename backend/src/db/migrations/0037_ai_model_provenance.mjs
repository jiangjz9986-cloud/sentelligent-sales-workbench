// v0.11.1 AI provenance: keep the generation source and bounded fallback
// reason beside every direct Web draft/suggestion record. Existing rows are
// deliberately labelled `legacy` rather than being reclassified after the
// fact. The migration is idempotent so it can upgrade both fresh and
// previously deployed databases.

function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  for (const table of ["weekly_reports", "solution_drafts", "ai_suggestions"]) {
    const columns = columnsFor(db, table);
    addColumnIfMissing(db, table, columns, "source", "TEXT NOT NULL DEFAULT 'legacy'");
    addColumnIfMissing(db, table, columns, "fallback_reason", "TEXT");
  }

  db.exec(`
    UPDATE weekly_reports
       SET source = 'legacy'
     WHERE source IS NULL OR trim(source) = '';
    UPDATE solution_drafts
       SET source = 'legacy'
     WHERE source IS NULL OR trim(source) = '';
    UPDATE ai_suggestions
       SET source = 'legacy'
     WHERE source IS NULL OR trim(source) = '';

    CREATE INDEX IF NOT EXISTS idx_weekly_reports_source_created
      ON weekly_reports(source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_solution_drafts_source_created
      ON solution_drafts(source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_source_created
      ON ai_suggestions(source, created_at DESC);
  `);
}
