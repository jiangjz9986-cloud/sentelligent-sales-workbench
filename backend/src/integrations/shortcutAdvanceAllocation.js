import { createHash } from "node:crypto";

export const SHORTCUT_ADVANCE_ALLOCATION_SCHEMA_VERSION = "shortcut-advance-allocation/v1";

const ACTIVE_ADVANCE_STATUSES = new Set(["received", "active"]);
const ACTIVE_ALLOCATION_STATUSES = new Set(["active", "confirmed"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return value.trim();
}

function cents(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw new TypeError(`${name} must be an integer number of cents`);
  }
  return value;
}

function dateOnly(value, name) {
  const normalized = text(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function monday(value) {
  const date = new Date(`${dateOnly(value, "date")}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function weekRange(weekStart) {
  const start = new Date(`${dateOnly(weekStart, "weekStart")}T00:00:00.000Z`);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function first(value, ...keys) {
  for (const key of keys) if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  return undefined;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function planHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function normalizeAdvance(row, index) {
  if (!plainObject(row)) throw new TypeError(`advances[${index}] must be an object`);
  const id = text(first(row, "id"), `advances[${index}].id`);
  const receivedCents = cents(Number(first(row, "receivedCents", "received_cents")), `advances[${index}].receivedCents`);
  const receivedOnRaw = first(row, "receivedOn", "received_on");
  const weekStartRaw = first(row, "weekStart", "week_start") ?? receivedOnRaw;
  const weekStart = monday(weekStartRaw);
  const receivedOn = receivedOnRaw ? dateOnly(receivedOnRaw, `advances[${index}].receivedOn`) : weekStart;
  const status = String(first(row, "status") ?? "received").toLowerCase();
  return {
    id,
    weekStart,
    receivedOn,
    receivedCents,
    status,
    createdAt: String(first(row, "createdAt", "created_at") ?? ""),
  };
}

function normalizePayment(row, expense, index) {
  if (!plainObject(row)) throw new TypeError(`payments[${index}] must be an object`);
  const id = text(first(row, "id"), `payments[${index}].id`);
  const expenseId = text(first(row, "expenseId", "expense_id") ?? expense?.id, `payments[${index}].expenseId`);
  const reimbursementCents = cents(Number(first(row, "reimbursementCents", "reimbursement_cents", "amountCents", "amount_cents")), `payments[${index}].reimbursementCents`);
  const amountCents = cents(Number(first(row, "amountCents", "amount_cents")) || reimbursementCents, `payments[${index}].amountCents`);
  const fundingSource = String(first(row, "fundingSource", "funding_source") ?? "personal");
  const sequence = Number(first(row, "sequence") ?? 1);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError(`payments[${index}].sequence is invalid`);
  return { id, expenseId, reimbursementCents, amountCents, fundingSource, sequence };
}

function normalizeExpense(row, index) {
  if (!plainObject(row)) throw new TypeError(`expenses[${index}] must be an object`);
  const id = text(first(row, "id"), `expenses[${index}].id`);
  const occurredOn = dateOnly(first(row, "occurredOn", "occurred_on"), `expenses[${index}].occurredOn`);
  const suppliedReimbursement = first(row, "reimbursementCents", "reimbursement_cents", "amountCents", "amount_cents");
  const suppliedAmount = suppliedReimbursement === undefined || suppliedReimbursement === null
    ? null
    : cents(Number(suppliedReimbursement), `expenses[${index}].reimbursementCents`);
  const nestedPayments = Array.isArray(row.payments) ? row.payments : null;
  const payments = nestedPayments
    ? nestedPayments.map((payment, paymentIndex) => normalizePayment(payment, { id }, paymentIndex))
    : [normalizePayment({
        id: first(row, "paymentId", "payment_id") ?? `${id}:payment:1`,
        expenseId: id,
        amountCents: suppliedAmount ?? 0,
        reimbursementCents: suppliedAmount ?? 0,
        fundingSource: first(row, "fundingSource", "funding_source") ?? "personal",
        sequence: 1,
      }, { id }, 0)];
  const reimbursementCents = cents(
    suppliedAmount ?? payments.reduce((sum, payment) => sum + payment.reimbursementCents, 0),
    `expenses[${index}].reimbursementCents`,
  );
  return {
    id,
    occurredOn,
    weekStart: monday(occurredOn),
    reimbursementCents,
    payments: payments.filter((payment) => payment.fundingSource !== "company"),
  };
}

function normalizeExisting(row, index) {
  if (!plainObject(row)) throw new TypeError(`existingAllocations[${index}] must be an object`);
  return {
    advanceId: text(first(row, "advanceId", "advance_id"), `existingAllocations[${index}].advanceId`),
    paymentId: text(first(row, "paymentId", "payment_id"), `existingAllocations[${index}].paymentId`),
    allocatedCents: cents(Number(first(row, "allocatedCents", "allocated_cents")), `existingAllocations[${index}].allocatedCents`, { positive: true }),
    status: String(first(row, "status") ?? "active").toLowerCase(),
  };
}

/**
 * Build a deterministic, side-effect-free allocation proposal. It never
 * changes an expense/payment. Callers must persist the returned plan only
 * after the user explicitly confirms the scope and plan hash.
 */
export function buildShortcutAdvanceAllocation(input = {}) {
  if (!plainObject(input)) throw new TypeError("input must be an object");
  const advances = (Array.isArray(input.advances) ? input.advances : []).map(normalizeAdvance);
  const expenses = (Array.isArray(input.expenses) ? input.expenses : []).map(normalizeExpense);
  const existing = (Array.isArray(input.existingAllocations) ? input.existingAllocations : []).map(normalizeExisting);
  const requestedWeek = input.weekStart ?? input.week_start;
  const weekStart = requestedWeek ? monday(requestedWeek) : null;
  const requestedAdvanceId = input.advanceId ?? input.advance_id ?? null;
  if (requestedAdvanceId !== null) text(requestedAdvanceId, "advanceId");
  const explicitExpenseId = input.expenseId ?? input.expense_id ?? null;
  if (explicitExpenseId !== null) text(explicitExpenseId, "expenseId");
  const includeSpillover = input.includeSpillover === true;
  const activeExisting = existing.filter((item) => ACTIVE_ALLOCATION_STATUSES.has(item.status));
  const usedByAdvance = new Map();
  const usedByPayment = new Map();
  for (const item of activeExisting) {
    usedByAdvance.set(item.advanceId, (usedByAdvance.get(item.advanceId) ?? 0) + item.allocatedCents);
    usedByPayment.set(item.paymentId, (usedByPayment.get(item.paymentId) ?? 0) + item.allocatedCents);
  }
  const usableAdvances = advances
    .filter((advance) => ACTIVE_ADVANCE_STATUSES.has(advance.status) && advance.receivedCents > 0)
    .filter((advance) => !weekStart || advance.weekStart === weekStart)
    .filter((advance) => !requestedAdvanceId || advance.id === requestedAdvanceId)
    .sort((left, right) => left.receivedOn.localeCompare(right.receivedOn) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const eligibleExpenses = expenses
    .filter((expense) => !weekStart || includeSpillover || expense.weekStart === weekStart)
    .filter((expense) => !explicitExpenseId || expense.id === explicitExpenseId)
    .sort((left, right) => left.occurredOn.localeCompare(right.occurredOn) || left.id.localeCompare(right.id));
  const availableByAdvance = new Map(usableAdvances.map((advance) => [advance.id, Math.max(0, advance.receivedCents - (usedByAdvance.get(advance.id) ?? 0))]));
  const paymentRemaining = new Map();
  for (const expense of eligibleExpenses) {
    for (const payment of expense.payments) {
      paymentRemaining.set(payment.id, Math.max(0, payment.reimbursementCents - (usedByPayment.get(payment.id) ?? 0)));
    }
  }
  const proposed = [];
  for (const expense of eligibleExpenses) {
    if (!includeSpillover && weekStart && expense.weekStart !== weekStart) continue;
    for (const payment of expense.payments.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
      let need = paymentRemaining.get(payment.id) ?? 0;
      if (need <= 0) continue;
      for (const advance of usableAdvances) {
        if (!includeSpillover && weekStart && advance.weekStart !== expense.weekStart) continue;
        const available = availableByAdvance.get(advance.id) ?? 0;
        if (available <= 0) continue;
        const allocation = Math.min(need, available);
        if (allocation <= 0) continue;
        proposed.push({
          advanceId: advance.id,
          expenseId: expense.id,
          paymentId: payment.id,
          weekStart: expense.weekStart,
          allocatedCents: allocation,
          allocationKind: explicitExpenseId ? "explicit" : (advance.weekStart === expense.weekStart ? "fifo" : "retroactive"),
        });
        need -= allocation;
        availableByAdvance.set(advance.id, available - allocation);
        paymentRemaining.set(payment.id, need);
        if (need === 0) break;
      }
    }
  }
  const requestedCents = eligibleExpenses.reduce((sum, expense) => (
    sum + expense.payments.reduce((inner, payment) => inner + payment.reimbursementCents, 0)
  ), 0);
  const allocatedCents = proposed.reduce((sum, item) => sum + item.allocatedCents, 0);
  const existingCoveredCents = eligibleExpenses.reduce((sum, expense) => (
    sum + expense.payments.reduce((inner, payment) => inner + Math.min(
      payment.reimbursementCents,
      usedByPayment.get(payment.id) ?? 0,
    ), 0)
  ), 0);
  const uncoveredCents = Math.max(0, requestedCents - existingCoveredCents - allocatedCents);
  const overageCents = uncoveredCents;
  const advanceSummaries = usableAdvances.map((advance) => {
    const existingCents = usedByAdvance.get(advance.id) ?? 0;
    const proposedCents = proposed.filter((item) => item.advanceId === advance.id).reduce((sum, item) => sum + item.allocatedCents, 0);
    return {
      advanceId: advance.id,
      weekStart: advance.weekStart,
      receivedCents: advance.receivedCents,
      existingAllocatedCents: existingCents,
      proposedAllocatedCents: proposedCents,
      remainingCents: Math.max(0, advance.receivedCents - existingCents - proposedCents),
    };
  });
  const expenseSummaries = eligibleExpenses.map((expense) => {
    const requested = expense.payments.reduce((sum, payment) => sum + payment.reimbursementCents, 0);
    const allocated = proposed.filter((item) => item.expenseId === expense.id).reduce((sum, item) => sum + item.allocatedCents, 0);
    const existingAllocated = expense.payments.reduce((sum, payment) => sum + Math.min(
      payment.reimbursementCents,
      usedByPayment.get(payment.id) ?? 0,
    ), 0);
    return {
      expenseId: expense.id,
      weekStart: expense.weekStart,
      requestedCents: requested,
      allocatedCents: existingAllocated + allocated,
      proposedAllocatedCents: allocated,
      personalPaidCents: Math.max(0, requested - existingAllocated - allocated),
      overageCents: Math.max(0, requested - existingAllocated - allocated),
    };
  });
  const hashInput = {
    schemaVersion: SHORTCUT_ADVANCE_ALLOCATION_SCHEMA_VERSION,
    weekStart,
    requestedAdvanceId,
    explicitExpenseId,
    includeSpillover,
    advances: usableAdvances.map(({ id, weekStart: advanceWeek, receivedOn, receivedCents }) => ({ id, weekStart: advanceWeek, receivedOn, receivedCents })),
    existing: activeExisting,
    proposed,
  };
  return {
    schemaVersion: SHORTCUT_ADVANCE_ALLOCATION_SCHEMA_VERSION,
    planHash: planHash(hashInput),
    weekStart,
    weekRange: weekStart ? weekRange(weekStart) : null,
    advanceId: requestedAdvanceId,
    scope: explicitExpenseId ? "expense" : "week",
    explicitExpenseId,
    includeSpillover,
    proposedAllocations: proposed,
    advanceSummaries,
    expenseSummaries,
    requestedCents,
    allocatedCents,
    remainingCents: advanceSummaries.reduce((sum, item) => sum + item.remainingCents, 0),
    uncoveredCents,
    overageCents,
    warnings: [
      ...(includeSpillover ? ["spillover_requires_explicit_confirmation"] : []),
      ...(proposed.length === 0 && requestedCents > 0 ? ["no_advance_coverage"] : []),
    ],
  };
}

export const proposeShortcutAdvanceAllocation = buildShortcutAdvanceAllocation;
