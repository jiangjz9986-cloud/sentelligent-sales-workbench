import { createHash } from "node:crypto";

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function codeCandidate(occurredOn, id, length) {
  const day = String(occurredOn).replaceAll("-", "");
  const suffix = createHash("sha256").update(String(id), "utf8").digest("hex").slice(0, length).toUpperCase();
  return `EXP-${day}-${suffix}`;
}

function ensureReferenceCodes(db) {
  if (!columnNames(db, "travel_expenses").has("reference_code")) {
    db.exec("ALTER TABLE travel_expenses ADD COLUMN reference_code TEXT");
  }

  const used = new Set(
    db.prepare("SELECT reference_code FROM travel_expenses WHERE reference_code IS NOT NULL AND reference_code <> ''")
      .all()
      .map((row) => row.reference_code),
  );
  const update = db.prepare("UPDATE travel_expenses SET reference_code = $referenceCode WHERE id = $id");
  const rows = db.prepare(`
    SELECT id, occurred_on
    FROM travel_expenses
    WHERE reference_code IS NULL OR reference_code = ''
    ORDER BY occurred_on, id
  `).all();

  for (const row of rows) {
    let referenceCode;
    for (const length of [4, 6, 8, 10, 12]) {
      const candidate = codeCandidate(row.occurred_on, row.id, length);
      if (!used.has(candidate)) {
        referenceCode = candidate;
        break;
      }
    }
    if (!referenceCode) throw new Error(`Could not generate a unique travel expense reference for ${row.id}`);
    update.run({ $id: row.id, $referenceCode: referenceCode });
    used.add(referenceCode);
  }
}

export function apply(db) {
  ensureReferenceCodes(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_travel_expenses_reference_code
      ON travel_expenses(reference_code)
      WHERE reference_code IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_travel_expenses_reference_code_insert
    BEFORE INSERT ON travel_expenses
    WHEN NEW.reference_code IS NULL OR NEW.reference_code = ''
    BEGIN
      SELECT RAISE(ABORT, 'travel expense reference_code is required');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_travel_expenses_reference_code_clear
    BEFORE UPDATE OF reference_code ON travel_expenses
    WHEN NEW.reference_code IS NULL OR NEW.reference_code = ''
    BEGIN
      SELECT RAISE(ABORT, 'travel expense reference_code is required');
    END;

    CREATE TABLE IF NOT EXISTS travel_expense_ingestions (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('icost', 'weixin', 'manual')),
      idempotency_key_hash TEXT NOT NULL CHECK (
        length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
      ),
      request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_id TEXT,
      raw_text TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 12000),
      captured_at TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'review_required', 'accepted', 'failed')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_started_at TEXT,
      analysis_provider TEXT,
      analysis_model TEXT,
      analysis_json TEXT CHECK (analysis_json IS NULL OR json_valid(analysis_json)),
      warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
      expense_id TEXT REFERENCES travel_expenses(id) ON DELETE SET NULL,
      payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE SET NULL,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, source, idempotency_key_hash)
    );

    CREATE TABLE IF NOT EXISTS travel_expense_document_inbox (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('weixin', 'manual')),
      source_message_id TEXT,
      document_kind TEXT NOT NULL CHECK (document_kind IN ('payment_proof', 'invoice')),
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (
        media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      ),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 12582912),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      content_blob BLOB NOT NULL CHECK (length(content_blob) = size_bytes),
      status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'review_required', 'matched', 'failed', 'rejected')
      ),
      extracted_text TEXT,
      recognition_json TEXT CHECK (recognition_json IS NULL OR json_valid(recognition_json)),
      matched_expense_id TEXT REFERENCES travel_expenses(id) ON DELETE SET NULL,
      matched_payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE SET NULL,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner, document_kind, sha256)
    );

    CREATE TABLE IF NOT EXISTS invoice_documents (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'weixin')),
      source_ref TEXT,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (
        media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      ),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 12582912),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      content_blob BLOB NOT NULL CHECK (length(content_blob) = size_bytes),
      status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'review_required', 'unmatched', 'matched', 'rejected')
      ),
      extracted_text TEXT,
      ocr_json TEXT CHECK (ocr_json IS NULL OR json_valid(ocr_json)),
      model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json)),
      conflict_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_json)),
      invoice_code TEXT,
      invoice_number TEXT,
      issued_on TEXT CHECK (issued_on IS NULL OR date(issued_on) = issued_on),
      seller_name TEXT,
      buyer_name TEXT,
      amount_ex_tax_cents INTEGER CHECK (amount_ex_tax_cents IS NULL OR amount_ex_tax_cents >= 0),
      tax_cents INTEGER CHECK (tax_cents IS NULL OR tax_cents >= 0),
      total_cents INTEGER CHECK (total_cents IS NULL OR total_cents >= 0),
      suggested_category TEXT CHECK (
        suggested_category IS NULL OR suggested_category IN (
          'breakfast', 'lunch', 'dinner', 'lodging', 'transport', 'hospitality', 'other'
        )
      ),
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by TEXT,
      UNIQUE (owner, sha256)
    );

    CREATE TABLE IF NOT EXISTS invoice_matches (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      invoice_id TEXT NOT NULL REFERENCES invoice_documents(id) ON DELETE CASCADE,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE CASCADE,
      allocated_cents INTEGER NOT NULL CHECK (allocated_cents > 0),
      match_method TEXT NOT NULL CHECK (
        match_method IN ('manual_code', 'manual_selection', 'rule_candidate')
      ),
      state TEXT NOT NULL DEFAULT 'suggested' CHECK (
        state IN ('suggested', 'confirmed', 'rejected', 'revoked')
      ),
      score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
      rationale_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rationale_json)),
      confirmed_by TEXT,
      confirmed_at TEXT,
      revoked_by TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS travel_expense_no_invoice_confirmations (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE CASCADE,
      amount_snapshot_cents INTEGER NOT NULL CHECK (amount_snapshot_cents >= 0),
      reason TEXT NOT NULL,
      confirmed_by TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      revoked_by TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoice_match_candidates (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      owner TEXT NOT NULL,
      week_start TEXT NOT NULL CHECK (
        week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(week_start) = week_start
        AND strftime('%w', week_start) = '1'
      ),
      invoice_id TEXT NOT NULL REFERENCES invoice_documents(id) ON DELETE CASCADE,
      expense_id TEXT NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      payment_id TEXT REFERENCES travel_expense_payments(id) ON DELETE CASCADE,
      proposed_cents INTEGER NOT NULL CHECK (proposed_cents > 0),
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      rationale_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rationale_json)),
      status TEXT NOT NULL DEFAULT 'suggested' CHECK (
        status IN ('suggested', 'accepted', 'rejected', 'expired')
      ),
      accepted_match_id TEXT REFERENCES invoice_matches(id) ON DELETE SET NULL,
      decided_by TEXT,
      decided_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_travel_expense_ingestions_status
      ON travel_expense_ingestions(owner, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_travel_expense_document_inbox_status
      ON travel_expense_document_inbox(owner, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_documents_owner_status
      ON invoice_documents(owner, status, issued_on, created_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_matches_expense
      ON invoice_matches(owner, expense_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_invoice_matches_invoice
      ON invoice_matches(owner, invoice_id, state, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_matches_active_target
      ON invoice_matches(invoice_id, expense_id, COALESCE(payment_id, ''))
      WHERE state IN ('suggested', 'confirmed');
    CREATE UNIQUE INDEX IF NOT EXISTS ux_no_invoice_confirmation_active_target
      ON travel_expense_no_invoice_confirmations(expense_id, COALESCE(payment_id, ''))
      WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_match_candidates_active_target
      ON invoice_match_candidates(invoice_id, expense_id, COALESCE(payment_id, ''))
      WHERE status = 'suggested';
  `);
}
