// v0.13.15: owner-managed recognition keywords for bookkeeping categories.
export function apply(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(bookkeeping_categories)").all().map((row) => row.name));
  if (!columns.has("aliases_json")) {
    db.exec(`
      ALTER TABLE bookkeeping_categories
      ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(aliases_json));
    `);
  }
}
