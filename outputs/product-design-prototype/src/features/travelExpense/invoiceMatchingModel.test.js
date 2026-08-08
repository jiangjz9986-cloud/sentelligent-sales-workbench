import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateInvoiceMatchAllocation,
  resolveExpenseReferenceCode,
} from "./invoiceMatchingModel.js";

describe("invoice match allocation", () => {
  it("uses the smaller remaining balance across the invoice and payment", () => {
    const amount = calculateInvoiceMatchAllocation({
      invoice: { id: "invoice-1", totalCents: 10_000 },
      payment: { id: "payment-1", reimbursementCents: 8_000 },
      matches: [
        { id: "match-1", invoiceId: "invoice-1", paymentId: "payment-2", allocatedCents: 4_000, state: "confirmed" },
        { id: "match-2", invoiceId: "invoice-2", paymentId: "payment-1", allocatedCents: 3_000, state: "confirmed" },
      ],
    });

    assert.equal(amount, 5_000);
  });

  it("ignores revoked matches when calculating remaining balances", () => {
    const amount = calculateInvoiceMatchAllocation({
      invoice: { id: "invoice-1", totalCents: 10_000 },
      payment: { id: "payment-1", reimbursementCents: 8_000 },
      matches: [
        { id: "match-1", invoiceId: "invoice-1", paymentId: "payment-1", allocatedCents: 8_000, state: "revoked" },
      ],
    });

    assert.equal(amount, 8_000);
  });

  it("returns zero when either side has no unmatched amount left", () => {
    assert.equal(calculateInvoiceMatchAllocation({
      invoice: { id: "invoice-1", totalCents: 5_000 },
      payment: { id: "payment-1", reimbursementCents: 8_000 },
      matches: [
        { id: "match-1", invoiceId: "invoice-1", paymentId: "payment-2", allocatedCents: 5_000, state: "confirmed" },
      ],
    }), 0);
  });

  it("resolves an expense by a trimmed case-normalized reference code", () => {
    const expense = resolveExpenseReferenceCode([
      { id: "expense-1", referenceCode: "EXP-20260804-ABC12345" },
    ], " exp-20260804-abc12345 ");

    assert.equal(expense.id, "expense-1");
  });

  it("rejects an unknown expense reference code with an explicit error", () => {
    assert.throws(
      () => resolveExpenseReferenceCode([], "EXP-20260804-NOTFOUND"),
      /未找到该账单编号/,
    );
  });
});
