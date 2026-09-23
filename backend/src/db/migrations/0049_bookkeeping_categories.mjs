// v0.13.14: owner-scoped bookkeeping category dictionary.
// Categories are archived instead of physically deleted so historical entries
// can keep resolving their original classification after a user removes it
// from the active menu.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookkeeping_categories (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      ledger_name TEXT NOT NULL CHECK (ledger_name = '出差报销'),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      subcategories_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subcategories_json)),
      is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, ledger_name, entry_type, name)
    );

    CREATE INDEX IF NOT EXISTS idx_bookkeeping_categories_owner_scope
      ON bookkeeping_categories(owner, ledger_name, entry_type, status, name);
  `);
}
