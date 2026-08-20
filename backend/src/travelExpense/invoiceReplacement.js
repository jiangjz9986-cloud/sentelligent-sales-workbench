const DEFAULT_MAX_INVOICES = 6;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_SEARCH_NODES = 50_000;

function assertCents(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer number of cents`);
  }
  return value;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function addSafe(left, right, name) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the safe integer range`);
  return result;
}

function normalizedInvoices(invoices, target, isEligible) {
  return assertArray(invoices, "invoices")
    .map((invoice, index) => {
      if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) {
        throw new TypeError(`invoices[${index}] must be an object`);
      }
      const totalCents = assertCents(invoice.totalCents, `invoices[${index}].totalCents`);
      const availableCents = assertCents(
        invoice.availableCents ?? totalCents,
        `invoices[${index}].availableCents`,
        { allowZero: true },
      );
      if (availableCents > totalCents) {
        throw new RangeError(`invoices[${index}].availableCents cannot exceed totalCents`);
      }
      return {
        ...invoice,
        totalCents,
        availableCents,
        _index: index,
      };
    })
    .filter((invoice) => invoice.availableCents > 0)
    .filter((invoice) => (typeof isEligible === "function" ? isEligible(invoice, target) : true))
    .sort((left, right) => (
      left.availableCents - right.availableCents
      || String(left.issuedOn ?? "").localeCompare(String(right.issuedOn ?? ""))
      || String(left.id ?? left._index).localeCompare(String(right.id ?? right._index))
    ));
}

function compareCandidate(left, right) {
  return left.wasteCents - right.wasteCents
    || left.invoiceCount - right.invoiceCount
    || left.largestWasteCents - right.largestWasteCents
    || left.totalCents - right.totalCents
    || left.invoiceIds.join("\u0000").localeCompare(right.invoiceIds.join("\u0000"));
}

function makeCandidate(selected, targetCents) {
  const totalCents = selected.reduce((total, invoice) => addSafe(total, invoice.availableCents, "combination total"), 0);
  const wasteCents = totalCents - targetCents;
  let remaining = targetCents;
  const allocations = selected.map((invoice) => {
    const allocatedCents = Math.min(remaining, invoice.availableCents);
    remaining -= allocatedCents;
    return {
      invoiceId: invoice.id,
      allocatedCents,
      wasteCents: invoice.availableCents - allocatedCents,
    };
  });
  return {
    targetCents,
    totalCents,
    wasteCents,
    exact: wasteCents === 0,
    requiresManualConfirmation: true,
    invoiceCount: selected.length,
    invoiceIds: selected.map((invoice) => invoice.id),
    allocations,
    largestWasteCents: Math.max(...allocations.map((item) => item.wasteCents), 0),
    rationale: wasteCents === 0
      ? selected.length === 1 ? "single_exact_amount" : "multi_invoice_exact_amount"
      : "smallest_overage_then_fewest_invoices",
  };
}

/**
 * Find ranked, non-overlapping-in-the-combination invoice sets for a missing
 * amount. This function only proposes allocations; it never changes storage.
 */
export function rankInvoiceCombinations({
  targetCents,
  invoices,
  target = undefined,
  isEligible,
  maxInvoices = DEFAULT_MAX_INVOICES,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  maxSearchNodes = DEFAULT_MAX_SEARCH_NODES,
} = {}) {
  assertCents(targetCents, "targetCents");
  if (!Number.isSafeInteger(maxInvoices) || maxInvoices < 1 || maxInvoices > 12) {
    throw new RangeError("maxInvoices must be between 1 and 12");
  }
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    throw new RangeError("maxCandidates must be between 1 and 100");
  }
  if (!Number.isSafeInteger(maxSearchNodes) || maxSearchNodes < 100 || maxSearchNodes > 1_000_000) {
    throw new RangeError("maxSearchNodes must be between 100 and 1000000");
  }
  const available = normalizedInvoices(invoices, target ?? { targetCents }, isEligible);
  const results = [];
  const seen = new Set();
  let searchNodes = 0;
  let searchTruncated = false;
  const suffixTotals = new Array(available.length + 1).fill(0);
  for (let index = available.length - 1; index >= 0; index -= 1) {
    suffixTotals[index] = addSafe(suffixTotals[index + 1], available[index].availableCents, "available invoice total");
  }

  function visit(start, selected, sum) {
    searchNodes += 1;
    if (searchNodes > maxSearchNodes) {
      searchTruncated = true;
      return;
    }
    if (sum >= targetCents) {
      const candidate = makeCandidate(selected, targetCents);
      const key = candidate.invoiceIds.join("\u0000");
      if (!seen.has(key)) {
        seen.add(key);
        results.push(candidate);
        results.sort(compareCandidate);
        if (results.length > maxCandidates) results.length = maxCandidates;
      }
      return;
    }
    if (selected.length >= maxInvoices || start >= available.length) return;
    if (addSafe(sum, suffixTotals[start], "combination search total") < targetCents) return;

    for (let index = start; index < available.length; index += 1) {
      const invoice = available[index];
      const nextSum = addSafe(sum, invoice.availableCents, "combination search total");
      selected.push(invoice);
      visit(index + 1, selected, nextSum);
      selected.pop();
    }
  }

  visit(0, [], 0);
  return results.map((candidate) => ({ ...candidate, searchTruncated }));
}

export function chooseBestInvoiceReplacement(input = {}) {
  return rankInvoiceCombinations(input)[0] ?? null;
}
