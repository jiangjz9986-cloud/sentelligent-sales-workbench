/**
 * Loan income and reimbursement allocation overlay for Shortcut bookkeeping.
 *
 * The existing travel_expense_payments rows remain the source of truth for
 * what was paid. These tables record which received loan pool (if any) is
 * allocated to a payment, append-only, so a later correction can reverse a
 * plan without rewriting historical expense or payment facts.
 */
export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shortcut_bookkeeping_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      entry_id TEXT NOT NULL REFERENCES shortcut_bookkeeping_entries(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version >= 1),
      changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
      source TEXT NOT NULL CHECK (source IN ('capture', 'weixin_correction', 'system')),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      UNIQUE (entry_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_shortcut_bookkeeping_revisions_owner_entry
      ON shortcut_bookkeeping_revisions(owner, entry_id, version);

    CREATE TABLE IF NOT EXISTS travel_expense_advance_sources (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      entry_id TEXT NOT NULL UNIQUE REFERENCES shortcut_bookkeeping_entries(id) ON DELETE RESTRICT,
      advance_id TEXT NOT NULL UNIQUE REFERENCES travel_expense_advances(id) ON DELETE RESTRICT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      received_on TEXT NOT NULL CHECK (date(received_on) = received_on),
      week_start TEXT NOT NULL CHECK (
        date(week_start) = week_start AND strftime('%w', week_start) = '1'
      ),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      reversed_by TEXT,
      reversed_at TEXT,
      CHECK (status = 'active' OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expense_advance_sources_owner_week
      ON travel_expense_advance_sources(owner, week_start, received_on, created_at);

    CREATE TABLE IF NOT EXISTS travel_expense_advance_allocation_plans (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      advance_id TEXT REFERENCES travel_expense_advances(id) ON DELETE RESTRICT,
      week_start TEXT NOT NULL CHECK (
        date(week_start) = week_start AND strftime('%w', week_start) = '1'
      ),
      scope TEXT NOT NULL CHECK (scope IN ('week', 'expense')),
      status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'superseded', 'cancelled')),
      plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
      requested_cents INTEGER NOT NULL CHECK (requested_cents >= 0),
      allocated_cents INTEGER NOT NULL CHECK (allocated_cents >= 0),
      remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
      uncovered_cents INTEGER NOT NULL CHECK (uncovered_cents >= 0),
      overage_cents INTEGER NOT NULL CHECK (overage_cents >= 0),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      superseded_by TEXT REFERENCES travel_expense_advance_allocation_plans(id),
      superseded_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expense_advance_plans_owner_week
      ON travel_expense_advance_allocation_plans(owner, week_start, created_at);

    CREATE TABLE IF NOT EXISTS travel_expense_advance_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      plan_id TEXT NOT NULL REFERENCES travel_expense_advance_allocation_plans(id) ON DELETE RESTRICT,
      advance_id TEXT NOT NULL REFERENCES travel_expense_advances(id) ON DELETE RESTRICT,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE RESTRICT,
      payment_id TEXT NOT NULL REFERENCES travel_expense_payments(id) ON DELETE RESTRICT,
      week_start TEXT NOT NULL CHECK (
        date(week_start) = week_start AND strftime('%w', week_start) = '1'
      ),
      allocated_cents INTEGER NOT NULL CHECK (allocated_cents > 0),
      allocation_kind TEXT NOT NULL CHECK (allocation_kind IN ('explicit', 'fifo', 'retroactive')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
      created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      reversed_by TEXT,
      reversed_at TEXT,
      reason TEXT,
      CHECK (status = 'active' OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expense_advance_allocations_owner_week
      ON travel_expense_advance_allocations(owner, week_start, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_travel_expense_advance_allocations_payment
      ON travel_expense_advance_allocations(payment_id, status, created_at);
  `);
}
