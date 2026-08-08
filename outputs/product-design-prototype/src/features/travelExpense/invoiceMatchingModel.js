function nonNegativeCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function allocatedTotal(matches, predicate) {
  return matches.reduce((total, match) => {
    if (match?.state === "revoked" || !predicate(match)) return total;
    const allocatedCents = nonNegativeCents(match?.allocatedCents ?? 0, "allocatedCents");
    const next = total + allocatedCents;
    if (!Number.isSafeInteger(next)) throw new RangeError("allocated total exceeds the safe integer range");
    return next;
  }, 0);
}

export function resolveExpenseReferenceCode(expenses, value) {
  if (!Array.isArray(expenses)) throw new TypeError("expenses must be an array");
  const referenceCode = String(value ?? "").trim().toUpperCase();
  const expense = expenses.find((item) => String(item?.referenceCode ?? "").toUpperCase() === referenceCode);
  if (!referenceCode || !expense) {
    throw new Error(`未找到该账单编号${referenceCode ? ` ${referenceCode}` : ""}，请检查后重试`);
  }
  return expense;
}

export function calculateInvoiceMatchAllocation({ invoice, payment, matches = [] } = {}) {
  if (!invoice?.id) throw new TypeError("invoice id is required");
  if (!payment?.id) throw new TypeError("payment id is required");
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  if (!Number.isSafeInteger(invoice.totalCents) || invoice.totalCents <= 0) return 0;

  const invoiceTotalCents = nonNegativeCents(invoice.totalCents, "invoice totalCents");
  const paymentTotalCents = nonNegativeCents(payment.reimbursementCents, "payment reimbursementCents");
  const invoiceAllocatedCents = allocatedTotal(matches, (match) => match.invoiceId === invoice.id);
  const paymentAllocatedCents = allocatedTotal(matches, (match) => match.paymentId === payment.id);
  const invoiceRemainingCents = Math.max(0, invoiceTotalCents - invoiceAllocatedCents);
  const paymentRemainingCents = Math.max(0, paymentTotalCents - paymentAllocatedCents);
  return Math.min(invoiceRemainingCents, paymentRemainingCents);
}
