// v0.12.0 mutually exclusive invoice type for each travel expense.
export function apply(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(travel_expenses)").all().map((column) => column.name),
  );
  if (!columns.has("invoice_type")) {
    db.exec(`
      ALTER TABLE travel_expenses
      ADD COLUMN invoice_type TEXT
        CHECK (invoice_type IS NULL OR invoice_type IN ('electronic', 'paper', 'substitute'))
    `);
  }
}
