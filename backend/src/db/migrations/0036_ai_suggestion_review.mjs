function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, columns, name, definition) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function apply(db) {
  const columns = columnsFor(db, "ai_suggestions");
  addColumnIfMissing(db, "ai_suggestions", columns, "version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "ai_suggestions", columns, "draft_content", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "ai_suggestions", columns, "confidence", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "ai_suggestions", columns, "source_id", "TEXT");
  addColumnIfMissing(db, "ai_suggestions", columns, "confirmation_preview", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "ai_suggestions", columns, "updated_at", "TEXT");
  addColumnIfMissing(db, "ai_suggestions", columns, "confirmed_at", "TEXT");
  addColumnIfMissing(db, "ai_suggestions", columns, "cancelled_at", "TEXT");

  db.exec(`
    UPDATE ai_suggestions
       SET status = 'pending'
     WHERE status = 'generated';

    UPDATE ai_suggestions
       SET draft_content = content
     WHERE draft_content = '';

    UPDATE ai_suggestions
       SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
     WHERE updated_at IS NULL;

    UPDATE ai_suggestions
       SET source_id = CASE
         WHEN json_valid(source_refs) THEN json_extract(source_refs, '$[0].id')
         ELSE NULL
       END
     WHERE source_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_owner_type_created
      ON ai_suggestions(owner, type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_owner_type_source_created
      ON ai_suggestions(owner, type, source_id, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_status_insert_guard
    BEFORE INSERT ON ai_suggestions
    WHEN NEW.status NOT IN ('pending', 'confirmed', 'cancelled', 'failed', 'expired', 'conflict')
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion status');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_status_update_guard
    BEFORE UPDATE OF status ON ai_suggestions
    WHEN NEW.status NOT IN ('pending', 'confirmed', 'cancelled', 'failed', 'expired', 'conflict')
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion status');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_confidence_insert_guard
    BEFORE INSERT ON ai_suggestions
    WHEN NEW.confidence < 0 OR NEW.confidence > 100
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion confidence');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_confidence_update_guard
    BEFORE UPDATE OF confidence ON ai_suggestions
    WHEN NEW.confidence < 0 OR NEW.confidence > 100
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion confidence');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_type_insert_guard
    BEFORE INSERT ON ai_suggestions
    WHEN NEW.type NOT IN ('customer_profile', 'opportunity_push', 'knowledge_talk')
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion type');
    END;

    CREATE TRIGGER IF NOT EXISTS ai_suggestions_type_update_guard
    BEFORE UPDATE OF type ON ai_suggestions
    WHEN NEW.type NOT IN ('customer_profile', 'opportunity_push', 'knowledge_talk')
    BEGIN
      SELECT RAISE(ABORT, 'invalid ai suggestion type');
    END;
  `);
}
