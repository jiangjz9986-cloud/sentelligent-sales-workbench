export function apply(db) {
  // Keep source/target identifiers as history even if a payment is later rebuilt.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookkeeping_proof_detachments (
      owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
      inbox_id TEXT NOT NULL CHECK (length(inbox_id) BETWEEN 1 AND 200),
      expense_id TEXT NOT NULL CHECK (length(expense_id) BETWEEN 1 AND 200),
      payment_id TEXT NOT NULL CHECK (length(payment_id) BETWEEN 1 AND 200),
      attachment_id TEXT NOT NULL CHECK (length(attachment_id) BETWEEN 1 AND 200),
      reason TEXT NOT NULL CHECK (reason IN ('deleted', 'replaced')),
      detached_by TEXT NOT NULL CHECK (length(detached_by) BETWEEN 1 AND 200),
      detached_at TEXT NOT NULL,
      PRIMARY KEY (owner, inbox_id, expense_id, payment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookkeeping_proof_detachments_attachment
      ON bookkeeping_proof_detachments(owner, attachment_id);
  `);
}
