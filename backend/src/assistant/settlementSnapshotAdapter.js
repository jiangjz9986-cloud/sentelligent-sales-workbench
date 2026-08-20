const MAX_ITEMS = 100;
const MAX_PAYMENTS_PER_EXPENSE = 25;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const EXPENSE_CATEGORIES = new Set(["breakfast", "lunch", "dinner", "lodging", "transport", "hospitality", "other"]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const INVOICE_STATUSES = new Set(["pending", "covered", "partial", "missing"]);

function createBusinessDateFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function validClockDate(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid Date");
  return new Date(value.getTime());
}

function isoNow(value) {
  return value.toISOString();
}

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return value.trim();
}

function boundedText(value, max = 500) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

function safeIdentifier(value, name = "id") {
  const normalized = requiredText(value, name, 200);
  if (!/^[\u4e00-\u9fffA-Za-z0-9_.:-]+$/u.test(normalized) || normalized.startsWith("synthetic:")) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function asSafeInteger(value) {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeAdd(left, right) {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function formatDateOnlyUtc(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function currentWeekStart(clock, formatter) {
  const now = validClockDate(clock);
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const businessDate = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = (businessDate.getUTCDay() + 6) % 7;
  businessDate.setUTCDate(businessDate.getUTCDate() - day);
  return formatDateOnlyUtc(businessDate);
}

function normalizeWeekStart(value, clock, formatter) {
  if (value === undefined || value === null || value === "" || value === "current") {
    return currentWeekStart(clock, formatter);
  }
  const normalized = requiredText(value, "weekStart", 10);
  const date = dateOnly(normalized);
  if (!date || new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new TypeError("weekStart is invalid");
  }
  return date;
}

function refsForExpenses(expenses) {
  return expenses.slice(0, MAX_ITEMS).map((item) => ({ type: "travel_expense", id: item.id }));
}

function refsForAdvances(advances) {
  return advances.slice(0, MAX_ITEMS).map((item) => ({ type: "travel_expense_advance", id: item.id }));
}

function normalizeAdvance(row) {
  const id = safeIdentifier(row.id, "advance.id");
  const requestedCents = asSafeInteger(row.requested_cents);
  const receivedCents = asSafeInteger(row.received_cents);
  const status = typeof row.status === "string" && ["draft", "requested", "received", "closed"].includes(row.status)
    ? row.status
    : null;
  const item = {
    id,
    version: asSafeInteger(row.version),
    weekStart: dateOnly(row.week_start),
    status,
    requestedCents,
    receivedCents,
    requestedOn: dateOnly(row.requested_on),
    receivedOn: dateOnly(row.received_on),
    purpose: boundedText(row.purpose, 1000),
  };
  const issues = [];
  if (item.version === null || item.version < 1) issues.push("invalid_version");
  if (!item.weekStart) issues.push("invalid_week_start");
  if (!item.status) issues.push("invalid_status");
  if (requestedCents === null) issues.push("invalid_requested_amount");
  if (receivedCents === null) issues.push("invalid_received_amount");
  if (requestedCents !== null && receivedCents !== null && receivedCents > requestedCents) {
    issues.push("received_exceeds_requested");
  }
  if (!item.purpose) issues.push("missing_purpose");
  return { item, issues };
}

function normalizePayment(row) {
  const id = safeIdentifier(row.id, "payment.id");
  const amountCents = asSafeInteger(row.amount_cents);
  const reimbursementCents = asSafeInteger(row.reimbursement_cents);
  const fundingSource = FUNDING_SOURCES.has(row.funding_source) ? row.funding_source : null;
  const issues = [];
  if (amountCents === null) issues.push("invalid_amount");
  if (reimbursementCents === null) issues.push("invalid_reimbursement");
  if (amountCents !== null && reimbursementCents !== null && reimbursementCents > amountCents) {
    issues.push("reimbursement_exceeds_paid");
  }
  if (!fundingSource) issues.push("invalid_funding_source");
  return {
    item: {
      id,
      amountCents,
      reimbursementCents,
      fundingSource,
      paidAt: boundedText(row.paid_at, 100),
    },
    issues,
  };
}

function derivedInvoiceStatus(reimbursementCents, confirmedCents, noInvoiceConfirmedCents) {
  if (reimbursementCents > 0 && confirmedCents >= reimbursementCents) return "covered";
  if (confirmedCents > 0) return "partial";
  if (noInvoiceConfirmedCents > 0) return "missing";
  return "pending";
}

function normalizeExpense(row, payments, coverage) {
  const id = safeIdentifier(row.id, "expense.id");
  const normalizedPayments = payments.map(normalizePayment);
  const issues = normalizedPayments.flatMap((payment) => payment.issues);
  const category = EXPENSE_CATEGORIES.has(row.category) ? row.category : null;
  if (!category) issues.push("invalid_category");
  const occurredOn = dateOnly(row.occurred_on);
  if (!occurredOn) issues.push("invalid_occurred_on");

  let actualPaidCents = 0;
  let reimbursementCents = 0;
  let settlementEligibleCents = 0;
  let personalPaidCents = 0;
  let companyDirectPaidCents = 0;
  let companyDirectReimbursementCents = 0;
  let advanceFundedCents = 0;
  for (const payment of normalizedPayments) {
    const { amountCents, reimbursementCents: reimbursement, fundingSource } = payment.item;
    if (amountCents === null || reimbursement === null || !fundingSource) continue;
    actualPaidCents = safeAdd(actualPaidCents, amountCents);
    reimbursementCents = safeAdd(reimbursementCents, reimbursement);
    if (actualPaidCents === null || reimbursementCents === null) issues.push("amount_overflow");
    if (fundingSource === "company") {
      companyDirectPaidCents = safeAdd(companyDirectPaidCents, amountCents);
      companyDirectReimbursementCents = safeAdd(companyDirectReimbursementCents, reimbursement);
    } else {
      settlementEligibleCents = safeAdd(settlementEligibleCents, reimbursement);
      if (fundingSource === "personal") personalPaidCents = safeAdd(personalPaidCents, amountCents);
      if (fundingSource === "advance") advanceFundedCents = safeAdd(advanceFundedCents, amountCents);
    }
  }
  const confirmedCents = Math.min(reimbursementCents ?? 0, coverage.confirmedCents);
  const missingCents = Math.max(0, (reimbursementCents ?? 0) - confirmedCents);
  const noInvoiceConfirmedCents = Math.min(missingCents, coverage.noInvoiceConfirmedCents);
  const unacknowledgedMissingCents = Math.max(0, missingCents - noInvoiceConfirmedCents);
  const storedInvoiceStatus = INVOICE_STATUSES.has(row.invoice_status) ? row.invoice_status : null;
  const invoiceStatus = derivedInvoiceStatus(reimbursementCents ?? 0, confirmedCents, noInvoiceConfirmedCents);
  if (!storedInvoiceStatus) issues.push("invalid_invoice_status");
  if (storedInvoiceStatus && storedInvoiceStatus !== invoiceStatus) issues.push("invoice_status_mismatch");
  if (coverage.confirmedCents < 0 || coverage.noInvoiceConfirmedCents < 0) issues.push("invalid_invoice_coverage");

  return {
    item: {
      id,
      referenceCode: boundedText(row.reference_code, 100),
      version: asSafeInteger(row.version),
      occurredOn,
      category,
      purpose: boundedText(row.purpose, 500),
      invoiceStatus,
      payments: normalizedPayments.map((payment) => payment.item),
      actualPaidCents,
      reimbursementCents,
      settlementEligibleCents,
      personalPaidCents,
      companyDirectPaidCents,
      companyDirectReimbursementCents,
      advanceFundedCents,
      invoiceCoverage: {
        confirmedCents,
        missingCents,
        noInvoiceConfirmedCents,
        unacknowledgedMissingCents,
      },
    },
    issues,
  };
}

export function createAssistantSettlementSnapshotAdapter({
  db,
  clock = () => new Date(),
  resolveBusinessOwner = (owner) => owner,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db must be a synchronous SQLite connection");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof resolveBusinessOwner !== "function") throw new TypeError("resolveBusinessOwner must be a function");
  const businessDateFormatter = createBusinessDateFormatter(BUSINESS_TIME_ZONE);

  function advanceSettlementSummary({ owner, weekStart } = {}) {
    const requestedOwner = requiredText(owner, "owner");
    const resolvedOwner = resolveBusinessOwner(requestedOwner);
    const normalizedOwner = typeof resolvedOwner === "string" ? resolvedOwner.trim() : "";
    const normalizedWeekStart = normalizeWeekStart(weekStart, clock, businessDateFormatter);
    const asOf = isoNow(validClockDate(clock));
    if (!normalizedOwner) {
      return emptySnapshot(normalizedWeekStart, asOf);
    }

    const expenseRows = db.prepare(`
      SELECT id, reference_code, version, occurred_on, category, purpose, invoice_status
      FROM travel_expenses
      WHERE owner = $owner AND deleted_at IS NULL
        AND occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
      ORDER BY occurred_on, created_at, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeekStart });
    const advanceRows = db.prepare(`
      SELECT id, version, week_start, status, requested_cents, received_cents,
             requested_on, received_on, purpose
      FROM travel_expense_advances
      WHERE owner = $owner AND deleted_at IS NULL AND week_start = $weekStart
      ORDER BY created_at, id
      LIMIT ${MAX_ITEMS + 1}
    `).all({ $owner: normalizedOwner, $weekStart: normalizedWeekStart });

    const truncated = {
      expenses: expenseRows.length > MAX_ITEMS,
      advances: advanceRows.length > MAX_ITEMS,
    };
    const advanceResults = advanceRows.slice(0, MAX_ITEMS).map(normalizeAdvance);
    const advances = advanceResults.map((result) => result.item);
    const advanceIssues = advanceResults.flatMap((result) => result.issues);
    const expenseResults = expenseRows.slice(0, MAX_ITEMS).map((row) => {
      const payments = db.prepare(`
        SELECT id, amount_cents, reimbursement_cents, funding_source, paid_at
        FROM travel_expense_payments
        WHERE expense_id = $expenseId
        ORDER BY sequence, id
        LIMIT ${MAX_PAYMENTS_PER_EXPENSE + 1}
      `).all({ $expenseId: row.id });
      const paymentTruncated = payments.length > MAX_PAYMENTS_PER_EXPENSE;
      const coverage = db.prepare(`
        SELECT
          COALESCE((
            SELECT SUM(match.allocated_cents)
            FROM invoice_matches match
            JOIN invoice_documents invoice
              ON invoice.id = match.invoice_id
             AND invoice.owner = match.owner
             AND invoice.deleted_at IS NULL
            WHERE match.owner = $owner
              AND match.expense_id = expense.id
              AND match.state = 'confirmed'
          ), 0) AS confirmed_cents,
          COALESCE((
            SELECT SUM(confirmation.amount_snapshot_cents)
            FROM travel_expense_no_invoice_confirmations confirmation
            WHERE confirmation.owner = $owner
              AND confirmation.expense_id = expense.id
              AND confirmation.revoked_at IS NULL
          ), 0) AS no_invoice_confirmed_cents
        FROM travel_expenses expense
        WHERE expense.id = $expenseId AND expense.owner = $owner AND expense.deleted_at IS NULL
      `).get({ $owner: normalizedOwner, $expenseId: row.id }) ?? { confirmed_cents: 0, no_invoice_confirmed_cents: 0 };
      const normalized = normalizeExpense(row, payments.slice(0, MAX_PAYMENTS_PER_EXPENSE), {
        confirmedCents: asSafeInteger(coverage.confirmed_cents) ?? -1,
        noInvoiceConfirmedCents: asSafeInteger(coverage.no_invoice_confirmed_cents) ?? -1,
      });
      if (paymentTruncated) normalized.issues.push("payment_truncated");
      return normalized;
    });
    const expenses = expenseResults.map((result) => result.item);
    const expenseIssues = expenseResults.flatMap((result) => result.issues);
    const issues = [...new Set([...advanceIssues, ...expenseIssues])];
    const allFactsComplete = !truncated.expenses && !truncated.advances && issues.length === 0;

    let summary = {
      expenseCount: expenses.length,
      paymentCount: expenses.reduce((sum, item) => sum + item.payments.length, 0),
      actualPaidCents: 0,
      reimbursementCents: 0,
      personalPaidCents: 0,
      companyDirectPaidCents: 0,
      companyDirectReimbursementCents: 0,
      advanceFundedCents: 0,
      settlementEligibleCents: 0,
      advanceReceivedCents: 0,
      personalSettlementCents: null,
      settlementDirection: null,
    };
    for (const item of expenses) {
      for (const key of [
        "actualPaidCents", "reimbursementCents", "personalPaidCents", "companyDirectPaidCents",
        "companyDirectReimbursementCents", "advanceFundedCents", "settlementEligibleCents",
      ]) {
        summary[key] = safeAdd(summary[key], item[key] ?? 0);
      }
    }
    for (const item of advances) summary.advanceReceivedCents = safeAdd(summary.advanceReceivedCents, item.receivedCents ?? 0);
    const arithmeticKeys = [
      "actualPaidCents", "reimbursementCents", "personalPaidCents", "companyDirectPaidCents",
      "companyDirectReimbursementCents", "advanceFundedCents", "settlementEligibleCents", "advanceReceivedCents",
    ];
    if (allFactsComplete && arithmeticKeys.every((key) => summary[key] !== null)) {
      summary.personalSettlementCents = safeAdd(summary.settlementEligibleCents, -summary.advanceReceivedCents);
      if (summary.personalSettlementCents !== null) {
        summary.settlementDirection = summary.personalSettlementCents > 0
          ? "company_reimburses"
          : summary.personalSettlementCents < 0
            ? "individual_returns"
            : "balanced";
      }
    }

    const invoiceCoverage = expenses.reduce((acc, item) => ({
      reimbursementCents: safeAdd(acc.reimbursementCents, item.reimbursementCents ?? 0),
      confirmedCents: safeAdd(acc.confirmedCents, item.invoiceCoverage.confirmedCents),
      missingCents: safeAdd(acc.missingCents, item.invoiceCoverage.missingCents),
      noInvoiceConfirmedCents: safeAdd(acc.noInvoiceConfirmedCents, item.invoiceCoverage.noInvoiceConfirmedCents),
      unacknowledgedMissingCents: safeAdd(acc.unacknowledgedMissingCents, item.invoiceCoverage.unacknowledgedMissingCents),
    }), {
      reimbursementCents: 0,
      confirmedCents: 0,
      missingCents: 0,
      noInvoiceConfirmedCents: 0,
      unacknowledgedMissingCents: 0,
    });
    const sourceRefs = [...refsForExpenses(expenses), ...refsForAdvances(advances)].slice(0, MAX_ITEMS);
    return {
      asOf,
      weekStart: normalizedWeekStart,
      expenses,
      advances,
      summary,
      invoiceCoverage: {
        ...invoiceCoverage,
        complete: allFactsComplete && invoiceCoverage.unacknowledgedMissingCents === 0,
      },
      evidence: {
        advances: { count: advances.length, complete: !truncated.advances && advanceIssues.length === 0 },
        expenses: { count: expenses.length, complete: !truncated.expenses && expenseIssues.length === 0 },
        fundingSources: {
          complete: !expenseIssues.some((issue) => issue === "invalid_funding_source"),
          unknownCount: expenseIssues.filter((issue) => issue === "invalid_funding_source").length,
        },
        invoiceCoverage: {
          complete: allFactsComplete && invoiceCoverage.unacknowledgedMissingCents === 0,
          unacknowledgedMissingCents: invoiceCoverage.unacknowledgedMissingCents,
        },
        settlement: {
          arithmeticComplete: allFactsComplete && summary.personalSettlementCents !== null,
          transactionRecorded: false,
        },
      },
      issues,
      truncated,
      sourceRefs,
    };
  }

  function emptySnapshot(weekStart, asOf) {
    return {
      asOf,
      weekStart,
      expenses: [],
      advances: [],
      summary: {
        expenseCount: 0,
        paymentCount: 0,
        actualPaidCents: 0,
        reimbursementCents: 0,
        personalPaidCents: 0,
        companyDirectPaidCents: 0,
        companyDirectReimbursementCents: 0,
        advanceFundedCents: 0,
        settlementEligibleCents: 0,
        advanceReceivedCents: 0,
        personalSettlementCents: null,
        settlementDirection: null,
      },
      invoiceCoverage: {
        reimbursementCents: 0,
        confirmedCents: 0,
        missingCents: 0,
        noInvoiceConfirmedCents: 0,
        unacknowledgedMissingCents: 0,
        complete: false,
      },
      evidence: {
        advances: { count: 0, complete: true },
        expenses: { count: 0, complete: true },
        fundingSources: { complete: true, unknownCount: 0 },
        invoiceCoverage: { complete: false, unacknowledgedMissingCents: 0 },
        settlement: { arithmeticComplete: false, transactionRecorded: false },
      },
      issues: ["owner_scope_empty"],
      truncated: { expenses: false, advances: false },
      sourceRefs: [],
    };
  }

  return Object.freeze({ advanceSettlementSummary });
}
