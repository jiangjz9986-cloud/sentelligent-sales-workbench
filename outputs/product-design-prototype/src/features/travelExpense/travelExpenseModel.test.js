import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPENSE_CATEGORIES,
  flattenPaymentRows,
  formatCny,
  formatSignedCny,
  naturalWeekFor,
  summarizeTravelExpenses,
} from "./travelExpenseModel.js";
import * as travelExpenseModel from "./travelExpenseModel.js";

function expenseWithPayments(payments, overrides = {}) {
  return {
    id: overrides.id ?? "expense-1",
    occurredOn: overrides.occurredOn ?? "2026-08-04",
    category: overrides.category ?? "lunch",
    purpose: overrides.purpose ?? "出差午餐",
    merchant: overrides.merchant ?? "示例商户",
    invoiceStatus: overrides.invoiceStatus ?? "pending",
    attachments: overrides.attachments ?? [],
    payments,
    ...overrides,
  };
}

describe("travel expense natural week", () => {
  it("uses Monday through Sunday for the natural week", () => {
    assert.deepEqual(naturalWeekFor("2026-08-04T10:00:00+08:00"), {
      start: "2026-08-03",
      end: "2026-08-09",
    });
  });

  it("keeps Sunday in the week that started six days earlier", () => {
    assert.deepEqual(naturalWeekFor("2026-08-09"), {
      start: "2026-08-03",
      end: "2026-08-09",
    });
  });

  it("rejects calendar dates that JavaScript would otherwise roll forward", () => {
    assert.throws(() => naturalWeekFor("2026-02-31"), /real calendar date/);
  });
});

describe("travel expense categories and settlement", () => {
  it("keeps breakfast, lunch, and dinner as independent categories", () => {
    assert.deepEqual(
      EXPENSE_CATEGORIES.map((item) => item.id),
      ["breakfast", "lunch", "dinner", "lodging", "transport", "hospitality", "other"],
    );
  });

  it("excludes company-direct payments from personal settlement", () => {
    const summary = summarizeTravelExpenses([
      expenseWithPayments([
        {
          id: "payment-1",
          paidAt: "2026-08-04T12:00:00+08:00",
          amountCents: 12000,
          reimbursementCents: 12000,
          fundingSource: "personal",
        },
        {
          id: "payment-2",
          paidAt: "2026-08-04T12:02:00+08:00",
          amountCents: 8000,
          reimbursementCents: 8000,
          fundingSource: "company",
        },
        {
          id: "payment-3",
          paidAt: "2026-08-04T12:03:00+08:00",
          amountCents: 3000,
          reimbursementCents: 2500,
          fundingSource: "advance",
        },
      ]),
    ], [{ id: "advance-1", receivedCents: 5000 }]);

    assert.equal(summary.actualPaidCents, 23000);
    assert.equal(summary.reimbursementCents, 22500);
    assert.equal(summary.companyDirectCents, 8000);
    assert.equal(summary.settlementEligibleCents, 14500);
    assert.equal(summary.advanceReceivedCents, 5000);
    assert.equal(summary.personalSettlementCents, 9500);
  });

  it("distinguishes no advance record from a recorded zero advance", () => {
    const expense = expenseWithPayments([
      {
        id: "payment-1",
        paidAt: "2026-08-04T12:00:00+08:00",
        amountCents: 1000,
        reimbursementCents: 1000,
        fundingSource: "personal",
      },
    ]);

    assert.equal(summarizeTravelExpenses([expense], []).advanceRecorded, false);
    assert.equal(summarizeTravelExpenses([expense], [{ receivedCents: 0 }]).advanceRecorded, true);
  });

  it("reports a negative settlement as money the individual should return", () => {
    const summary = summarizeTravelExpenses([
      expenseWithPayments([
        {
          id: "payment-1",
          paidAt: "2026-08-04T12:00:00+08:00",
          amountCents: 4000,
          reimbursementCents: 4000,
          fundingSource: "advance",
        },
      ]),
    ], [{ receivedCents: 10000 }]);

    assert.equal(summary.personalSettlementCents, -6000);
    assert.equal(summary.settlementDirection, "individual_returns");
  });

  it("rejects negative or non-integer monetary values", () => {
    const invalid = expenseWithPayments([
      {
        id: "payment-1",
        paidAt: "2026-08-04T12:00:00+08:00",
        amountCents: 10.5,
        reimbursementCents: -1,
        fundingSource: "personal",
      },
    ]);

    assert.throws(() => summarizeTravelExpenses([invalid], []), /amountCents|reimbursementCents/);
  });

  it("rejects unsafe integer overflow while accumulating totals", () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const expenses = [
      expenseWithPayments([{ id: "one", paidAt: "2026-08-04T12:00:00+08:00", amountCents: huge, reimbursementCents: huge, fundingSource: "personal" }]),
      expenseWithPayments([{ id: "two", paidAt: "2026-08-04T13:00:00+08:00", amountCents: 1, reimbursementCents: 1, fundingSource: "personal" }], { id: "expense-2" }),
    ];
    assert.throws(() => summarizeTravelExpenses(expenses, []), /safe integer/);
  });

  it("rejects unknown invoice states instead of silently relabeling them", () => {
    const invalid = expenseWithPayments([
      { id: "payment-1", paidAt: "2026-08-04T12:00:00+08:00", amountCents: 100, reimbursementCents: 100, fundingSource: "personal" },
    ], { invoiceStatus: "approved" });
    assert.throws(() => summarizeTravelExpenses([invalid], []), /invoiceStatus/);
  });
});

describe("payment rows", () => {
  it("formats stored UTC payment instants in the China business timezone", () => {
    assert.equal(
      travelExpenseModel.formatTravelExpenseDateTime?.("2026-06-16T09:06:00.000Z"),
      "2026/06/16 17:06",
    );
  });

  it("creates one stable row per actual payment", () => {
    const rows = flattenPaymentRows([
      expenseWithPayments([
        { id: "later", paidAt: "2026-08-04T12:02:00+08:00", amountCents: 2000, reimbursementCents: 1800, fundingSource: "personal" },
        { id: "earlier", paidAt: "2026-08-04T12:01:00+08:00", amountCents: 1000, reimbursementCents: 1000, fundingSource: "personal" },
      ], { id: "expense-b" }),
    ]);

    assert.deepEqual(rows.map((row) => row.paymentId), ["earlier", "later"]);
    assert.equal(rows[1].differenceCents, 200);
  });

  it("copies one stable expense reference code into every flattened payment row", () => {
    const rows = flattenPaymentRows([
      expenseWithPayments([
        { id: "payment-1", paidAt: "2026-08-04T12:01:00+08:00", amountCents: 1000, reimbursementCents: 1000, fundingSource: "personal" },
        { id: "payment-2", paidAt: "2026-08-04T12:02:00+08:00", amountCents: 2000, reimbursementCents: 2000, fundingSource: "personal" },
      ], { referenceCode: "EXP-20260804-ABC12345" }),
    ]);

    assert.deepEqual(rows.map((row) => row.expenseReferenceCode), [
      "EXP-20260804-ABC12345",
      "EXP-20260804-ABC12345",
    ]);
  });

  it("formats cents as Chinese yuan with two decimal places", () => {
    assert.equal(formatCny(272210), "¥2,722.10");
  });

  it("formats a signed settlement without rejecting money to return", () => {
    assert.equal(formatSignedCny(-6000), "-¥60.00");
    assert.equal(formatSignedCny(9500), "+¥95.00");
  });

  it("associates one proof attachment with multiple payment events", () => {
    const rows = flattenPaymentRows([
      expenseWithPayments([
        { id: "payment-1", paidAt: "2026-08-04T12:00:00+08:00", amountCents: 100, reimbursementCents: 100, fundingSource: "personal" },
        { id: "payment-2", paidAt: "2026-08-04T12:01:00+08:00", amountCents: 200, reimbursementCents: 200, fundingSource: "personal" },
      ], {
        attachments: [{ id: "shared-proof", kind: "payment_proof", paymentIds: ["payment-1", "payment-2"] }],
      }),
    ]);
    assert.deepEqual(rows.map((row) => row.proofAttachments.map((item) => item.id)), [
      ["shared-proof"],
      ["shared-proof"],
    ]);
  });
});
