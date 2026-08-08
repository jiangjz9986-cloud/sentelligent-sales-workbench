export function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS travel_expenses (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      occurred_on TEXT NOT NULL CHECK (
        occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(occurred_on) = occurred_on
      ),
      category TEXT NOT NULL CHECK (
        category IN ('breakfast', 'lunch', 'dinner', 'lodging', 'transport', 'hospitality', 'other')
      ),
      purpose TEXT NOT NULL,
      merchant TEXT,
      itinerary_id TEXT,
      customer_id TEXT,
      invoice_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (invoice_status IN ('pending', 'covered', 'partial', 'missing')),
      notes TEXT,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by TEXT
    );

    CREATE TABLE IF NOT EXISTS travel_expense_payments (
      id TEXT PRIMARY KEY NOT NULL,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      paid_at TEXT NOT NULL,
      merchant TEXT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      reimbursement_cents INTEGER NOT NULL CHECK (
        reimbursement_cents >= 0 AND reimbursement_cents <= amount_cents
      ),
      funding_source TEXT NOT NULL CHECK (funding_source IN ('personal', 'company', 'advance')),
      payment_method TEXT NOT NULL DEFAULT 'other'
        CHECK (payment_method IN ('wechat', 'alipay', 'card', 'cash', 'other')),
      account_last4 TEXT CHECK (account_last4 IS NULL OR length(account_last4) <= 4),
      difference_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (expense_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS travel_expense_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      kind TEXT NOT NULL CHECK (kind IN ('payment_proof', 'invoice', 'substitute')),
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
      content BLOB NOT NULL CHECK (length(content) = size_bytes),
      covered_cents INTEGER NOT NULL DEFAULT 0 CHECK (covered_cents >= 0),
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (expense_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS travel_expense_attachment_payments (
      attachment_id TEXT NOT NULL REFERENCES travel_expense_attachments(id) ON DELETE CASCADE,
      payment_id TEXT NOT NULL REFERENCES travel_expense_payments(id) ON DELETE CASCADE,
      PRIMARY KEY (attachment_id, payment_id)
    );

    CREATE TABLE IF NOT EXISTS travel_expense_advances (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      week_start TEXT NOT NULL CHECK (
        week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(week_start) = week_start
        AND strftime('%w', week_start) = '1'
      ),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'requested', 'received', 'closed')),
      requested_cents INTEGER NOT NULL DEFAULT 0 CHECK (requested_cents >= 0),
      received_cents INTEGER NOT NULL DEFAULT 0 CHECK (received_cents >= 0),
      requested_on TEXT CHECK (requested_on IS NULL OR date(requested_on) = requested_on),
      received_on TEXT CHECK (received_on IS NULL OR date(received_on) = received_on),
      purpose TEXT NOT NULL,
      notes TEXT,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expenses_owner_week
      ON travel_expenses(owner, occurred_on, updated_at)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_travel_expense_payments_expense
      ON travel_expense_payments(expense_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_travel_expense_attachments_expense
      ON travel_expense_attachments(expense_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_travel_expense_attachment_payments_payment
      ON travel_expense_attachment_payments(payment_id, attachment_id);

    CREATE INDEX IF NOT EXISTS idx_travel_expense_advances_owner_week
      ON travel_expense_advances(owner, week_start, created_at)
      WHERE deleted_at IS NULL;
  `);
}
