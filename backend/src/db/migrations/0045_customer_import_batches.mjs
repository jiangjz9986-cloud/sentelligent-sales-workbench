// v0.12.0 customer file-import staging and row-level audit ledger.
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_import_batches (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
      status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'confirmed', 'committed', 'cancelled', 'failed')),
      file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
      media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 120),
      file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
      file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'),
      total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
      valid_rows INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
      error_rows INTEGER NOT NULL DEFAULT 0 CHECK (error_rows >= 0),
      duplicate_rows INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT,
      UNIQUE (owner, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS customer_import_rows (
      id TEXT PRIMARY KEY NOT NULL,
      batch_id TEXT NOT NULL REFERENCES customer_import_batches(id) ON DELETE CASCADE,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      row_number INTEGER NOT NULL CHECK (row_number >= 1),
      status TEXT NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'duplicate', 'error', 'committed', 'skipped', 'rejected')),
      action TEXT NOT NULL DEFAULT 'create'
        CHECK (action IN ('create', 'merge', 'skip', 'reject')),
      canonical_name TEXT NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 200),
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
      errors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors_json)),
      row_digest TEXT NOT NULL CHECK (length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (batch_id, row_number)
    );

    CREATE INDEX IF NOT EXISTS idx_customer_import_batches_owner_status
      ON customer_import_batches(owner, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_import_rows_batch
      ON customer_import_rows(batch_id, row_number);
    CREATE INDEX IF NOT EXISTS idx_customer_import_rows_owner_name
      ON customer_import_rows(owner, canonical_name, status);
  `);
}
