export function apply(db) {
  db.exec(`
    ALTER TABLE customers ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE customers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
  `);
}
