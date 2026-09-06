function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function optionalCursor(value) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, "afterExpenseId", 200);
}

function boundedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 101) {
    throw new TypeError("limit must be a positive safe integer no greater than 101");
  }
  return value;
}

function nonNegativeSafeInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return normalized;
}

function gapFromRow(row) {
  if (!row) return null;
  const reimbursementCents = nonNegativeSafeInteger(row.reimbursement_cents, "reimbursementCents");
  const confirmedCoverageCents = Math.min(
    reimbursementCents,
    nonNegativeSafeInteger(row.confirmed_coverage_cents, "confirmedCoverageCents"),
  );
  const invoiceMissingCents = reimbursementCents - confirmedCoverageCents;
  const noInvoiceConfirmedCents = Math.min(
    invoiceMissingCents,
    nonNegativeSafeInteger(row.no_invoice_confirmed_cents, "noInvoiceConfirmedCents"),
  );
  const unacknowledgedMissingCents = invoiceMissingCents - noInvoiceConfirmedCents;
  const noInvoiceConfirmed = invoiceMissingCents > 0 && unacknowledgedMissingCents === 0;
  const expenseVersion = nonNegativeSafeInteger(row.expense_version, "expenseVersion");

  return Object.freeze({
    owner: requiredText(row.owner, "owner", 200),
    expenseId: requiredText(row.expense_id, "expenseId", 200),
    expenseReference: requiredText(row.reference_code, "expenseReference", 200),
    // The version is bumped by every supported expense edit, confirmed match,
    // match revocation, no-invoice confirmation and no-invoice revocation.  The
    // current monetary aggregates are included as an additional fence against
    // legacy/manual rows that pre-date those repository invariants.
    revision: [
      expenseVersion,
      reimbursementCents,
      confirmedCoverageCents,
      noInvoiceConfirmedCents,
    ].join(":"),
    missingCents: noInvoiceConfirmed ? invoiceMissingCents : unacknowledgedMissingCents,
    // Product clock: invoice aging follows the expense occurrence date.  It
    // intentionally survives partial/full coverage and later revocation, so a
    // reopened old expense does not silently receive a fresh grace period.
    // First enablement therefore catches an old open gap up at its one current
    // highest level instead of replaying lower levels.  No persisted episode
    // timestamp (and thus no new migration) is required for this definition.
    startedOn: requiredText(row.occurred_on, "startedOn", 10),
    serverConfirmed: true,
    noInvoiceConfirmed,
  });
}

const GAP_SELECT = `
  SELECT expense.id AS expense_id,
         expense.reference_code,
         expense.owner,
         expense.version AS expense_version,
         expense.occurred_on,
         COALESCE((
           SELECT SUM(payment.reimbursement_cents)
           FROM travel_expense_payments payment
           WHERE payment.expense_id = expense.id
         ), 0) AS reimbursement_cents,
         COALESCE((
           SELECT SUM(match.allocated_cents)
           FROM invoice_matches match
           JOIN invoice_documents invoice
             ON invoice.id = match.invoice_id
            AND invoice.owner = match.owner
            AND invoice.deleted_at IS NULL
           WHERE match.owner = expense.owner
             AND match.expense_id = expense.id
             AND match.state = 'confirmed'
         ), 0) AS confirmed_coverage_cents,
         COALESCE((
           SELECT SUM(confirmation.amount_snapshot_cents)
           FROM travel_expense_no_invoice_confirmations confirmation
           WHERE confirmation.owner = expense.owner
             AND confirmation.expense_id = expense.id
             AND confirmation.revoked_at IS NULL
         ), 0) AS no_invoice_confirmed_cents
  FROM travel_expenses expense
`;

export function createInvoiceEscalationGapRepository(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A synchronous SQLite connection is required");
  }

  const listStatement = db.prepare(`${GAP_SELECT}
    WHERE expense.owner = $owner
      AND expense.deleted_at IS NULL
      AND ($afterExpenseId IS NULL OR expense.id > $afterExpenseId)
    ORDER BY expense.id ASC
    LIMIT $limit
  `);
  const getStatement = db.prepare(`${GAP_SELECT}
    WHERE expense.owner = $owner
      AND expense.id = $expenseId
      AND expense.deleted_at IS NULL
    LIMIT 1
  `);

  function listInvoiceGaps({ owner, limit = 50, afterExpenseId = null } = {}) {
    return listStatement.all({
      $owner: requiredText(owner, "owner", 200),
      $afterExpenseId: optionalCursor(afterExpenseId),
      $limit: boundedLimit(limit),
    }).map(gapFromRow);
  }

  function getInvoiceGap({ owner, expenseId } = {}) {
    return gapFromRow(getStatement.get({
      $owner: requiredText(owner, "owner", 200),
      $expenseId: requiredText(expenseId, "expenseId", 200),
    }));
  }

  return Object.freeze({ listInvoiceGaps, getInvoiceGap });
}
