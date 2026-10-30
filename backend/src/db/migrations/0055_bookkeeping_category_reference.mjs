export function apply(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(shortcut_bookkeeping_entries)").all().map((row) => row.name));
  if (!columns.has("category_id")) {
    db.exec(`
      ALTER TABLE shortcut_bookkeeping_entries
      ADD COLUMN category_id TEXT REFERENCES bookkeeping_categories(id) ON DELETE SET NULL;
    `);
  }
  if (!columns.has("category_snapshot_json")) {
    db.exec(`
      ALTER TABLE shortcut_bookkeeping_entries
      ADD COLUMN category_snapshot_json TEXT
      CHECK (category_snapshot_json IS NULL OR json_valid(category_snapshot_json));
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shortcut_bookkeeping_category_reference
      ON shortcut_bookkeeping_entries(owner, category_id);
  `);

  const drafts = db.prepare(`
    SELECT id, owner, ledger_name, entry_type, category, subcategory
    FROM shortcut_bookkeeping_entries
    WHERE target_system = 'sentelligent'
      AND status IN ('received', 'processing', 'review_required')
      AND category_id IS NULL AND category_snapshot_json IS NULL
  `).all();
  const candidates = db.prepare(`
    SELECT id, version, subcategories_json
    FROM bookkeeping_categories
    WHERE owner = $owner AND ledger_name = $ledgerName
      AND entry_type = $entryType AND name = $category
  `);
  const update = db.prepare(`
    UPDATE shortcut_bookkeeping_entries
    SET category_id = $categoryId, category_snapshot_json = $snapshot
    WHERE id = $id AND owner = $owner
      AND category_id IS NULL AND category_snapshot_json IS NULL
  `);
  // Names cannot reconstruct a renamed category or a removed subcategory safely.
  for (const draft of drafts) {
    const matches = candidates.all({
      $owner: draft.owner, $ledgerName: draft.ledger_name,
      $entryType: draft.entry_type, $category: draft.category,
    });
    if (matches.length !== 1) continue;
    const category = matches[0];
    const subcategories = JSON.parse(category.subcategories_json);
    if (!Array.isArray(subcategories)
      || (draft.subcategory !== null && !subcategories.includes(draft.subcategory))) continue;
    update.run({
      $id: draft.id,
      $owner: draft.owner,
      $categoryId: category.id,
      $snapshot: JSON.stringify({
        version: 1,
        owner: draft.owner,
        categoryId: category.id,
        categoryVersion: Number(category.version),
        ledgerName: draft.ledger_name,
        entryType: draft.entry_type,
        category: draft.category,
        subcategory: draft.subcategory,
      }),
    });
  }
}
