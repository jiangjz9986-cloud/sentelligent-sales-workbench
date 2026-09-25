export function apply(db) {
  db.exec(`
    ALTER TABLE customers
      ADD COLUMN tender_sources TEXT NOT NULL DEFAULT '[]';
  `);
}
