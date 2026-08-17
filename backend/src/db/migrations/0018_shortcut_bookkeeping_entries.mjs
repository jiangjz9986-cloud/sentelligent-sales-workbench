export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shortcut_bookkeeping_entries (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
      target_system TEXT NOT NULL CHECK (target_system IN ('sentelligent', 'qingyang')),
      ledger_name TEXT NOT NULL CHECK (
        (ledger_name = '出差报销' AND target_system = 'sentelligent')
        OR (ledger_name = 'biubiu' AND target_system = 'qingyang')
      ),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
      category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 100),
      subcategory TEXT CHECK (subcategory IS NULL OR length(subcategory) BETWEEN 1 AND 100),
      note TEXT CHECK (note IS NULL OR length(note) <= 1000),
      idempotency_key_hash TEXT NOT NULL CHECK (
        length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      ),
      request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_id TEXT CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 200),
      raw_text TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 12000),
      captured_at TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'review_required', 'accepted', 'rejected')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_started_at TEXT,
      analysis_provider TEXT,
      analysis_model TEXT,
      analysis_json TEXT CHECK (analysis_json IS NULL OR json_valid(analysis_json)),
      warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
      occurred_on TEXT,
      amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
      merchant TEXT,
      purpose TEXT,
      expense_id TEXT REFERENCES travel_expenses(id) ON DELETE SET NULL,
      payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE SET NULL,
      remote_id TEXT CHECK (remote_id IS NULL OR length(remote_id) BETWEEN 1 AND 200),
      remote_reference TEXT CHECK (
        remote_reference IS NULL OR length(remote_reference) BETWEEN 1 AND 200
      ),
      remote_status TEXT CHECK (
        remote_status IS NULL OR remote_status IN (
          'pending', 'processing', 'review', 'failed', 'confirmed', 'rejected', 'voided'
        )
      ),
      error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        target_system != 'sentelligent'
        OR (ledger_name = '出差报销' AND entry_type = 'expense')
      ),
      CHECK (
        status != 'accepted'
        OR target_system != 'sentelligent'
        OR (expense_id IS NOT NULL AND payment_id IS NOT NULL)
      ),
      UNIQUE (owner, idempotency_key_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_shortcut_bookkeeping_owner_status
      ON shortcut_bookkeeping_entries(owner, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_shortcut_bookkeeping_target
      ON shortcut_bookkeeping_entries(owner, target_system, occurred_on);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcut_bookkeeping_remote_identity
      ON shortcut_bookkeeping_entries(target_system, remote_id)
      WHERE remote_id IS NOT NULL;
  `);
}
