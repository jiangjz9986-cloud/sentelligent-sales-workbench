import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildExpenseLedgerWorkbenchModel } from "./expenseLedgerWorkbenchModel.js";

const WEEK = Object.freeze({ start: "2026-08-24", end: "2026-08-30" });

function payment(overrides = {}) {
  return {
    id: "payment-1",
    paidAt: "2026-08-25T00:12:00.000Z",
    amountCents: 3200,
    reimbursementCents: 3200,
    fundingSource: "personal",
    paymentMethod: "wechat",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    id: "expense-1",
    referenceCode: "EXP-20260825-ABC12345",
    occurredOn: "2026-08-25",
    category: "lunch",
    purpose: "8.25 济南午餐",
    merchant: "不应成为默认备注的商户",
    invoiceStatus: "pending",
    payments: [payment()],
    attachments: [],
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: "review-1",
    status: "review_required",
    createdAt: "2026-08-25T00:05:00.000Z",
    category: "lunch",
    warnings: [],
    analysis: {
      expense: {
        occurredOn: "2026-08-25",
        amountCents: 2800,
        purpose: "8.25 济南午餐",
        category: "lunch",
      },
    },
    ...overrides,
  };
}

function advance(overrides = {}) {
  return {
    id: "advance-1",
    status: "received",
    receivedOn: "2026-08-26",
    receivedCents: 200000,
    purpose: "本周出差借款",
    notes: "",
    updatedAt: "2026-08-26T13:30:00.000Z",
    ...overrides,
  };
}

describe("expense ledger workbench week model", () => {
  it("always exposes Monday through Sunday in calendar order", () => {
    const model = buildExpenseLedgerWorkbenchModel({ week: WEEK, today: "2026-08-25" });

    assert.deepEqual(model.days.map((day) => day.date), [
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);
    assert.deepEqual(model.days.map((day) => day.weekdayShort), [
      "周一", "周二", "周三", "周四", "周五", "周六", "周日",
    ]);
    assert.equal(model.selectedDate, "2026-08-25");
    assert.equal(model.selectedDay.isToday, true);
  });

  it("rejects a range that does not begin Monday and end Sunday", () => {
    assert.throws(
      () => buildExpenseLedgerWorkbenchModel({ week: { start: "2026-08-25", end: "2026-08-31" } }),
      /Monday/,
    );
    assert.throws(
      () => buildExpenseLedgerWorkbenchModel({ week: { start: "2026-08-24", end: "2026-08-29" } }),
      /Sunday/,
    );
  });
});

describe("formal entries and pending reviews", () => {
  it("keeps a pending Xiaoxiao review visible without counting it in formal totals", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense()],
      reviews: [review()],
      selectedDate: "2026-08-25",
      today: "2026-08-26",
    });

    assert.equal(model.selectedDay.formalExpenseCount, 1);
    assert.equal(model.selectedDay.pendingCount, 1);
    assert.deepEqual(model.selectedDay.items.map((item) => item.kind), ["review", "expense"]);
    assert.equal(model.selectedDay.items[0].formal, false);
    assert.equal(model.selectedDay.items[0].sourceLabel, "微信小小");
    assert.equal(model.summary.pendingCount, 1);
    assert.equal(model.summary.formalExpenseCents, 3200);
    assert.equal(model.summary.reimbursableCents, 3200);
  });

  it("uses notes or purpose for the row and never defaults the note to merchant", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense({ purpose: "", notes: "" })],
      today: "2026-08-25",
    });

    const [item] = model.selectedDay.items;
    assert.equal(item.notes, "—");
    assert.notEqual(item.notes, "不应成为默认备注的商户");
  });

  it("localizes user-corrected region sources", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense({ tripRegion: "济南", tripRegionSource: "user_correction" })],
      selectedDate: "2026-08-25",
      today: "2026-08-25",
    });
    assert.equal(model.selectedDay.items[0].regionSourceLabel, "用户修正");
  });

  it("keeps reviews with no valid date outside all seven day totals", () => {
    const undated = review({
      id: "review-undated",
      analysis: { expense: { amountCents: 4100, category: "dinner" } },
    });
    const model = buildExpenseLedgerWorkbenchModel({ week: WEEK, reviews: [undated], today: "2026-08-25" });

    assert.equal(model.summary.pendingCount, 0);
    assert.equal(model.summary.unresolvedPendingCount, 1);
    assert.equal(model.unassignedPending[0].sourceId, "review-undated");
    assert.equal(model.days.every((day) => day.pendingCount === 0), true);
  });

  it("does not include records from another natural week", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense(), expense({ id: "outside", occurredOn: "2026-08-31" })],
      advances: [advance(), advance({ id: "outside-advance", receivedOn: "2026-08-31" })],
      reviews: [review({
        id: "outside-review",
        analysis: {
          expense: {
            occurredOn: "2026-08-31",
            amountCents: 2800,
            purpose: "下周午餐",
            category: "lunch",
          },
        },
      })],
      today: "2026-08-25",
    });

    assert.equal(model.summary.formalExpenseCount, 1);
    assert.equal(model.summary.formalIncomeCount, 1);
    assert.equal(model.summary.pendingCount, 0);
    assert.equal(model.summary.unresolvedPendingCount, 0);
    assert.deepEqual(model.unassignedPending, []);
  });
});

describe("loan income and evidence states", () => {
  it("shows an arrived travel loan as formal income without adding it to spend or reimbursement", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense()],
      advances: [advance()],
      selectedDate: "2026-08-26",
      today: "2026-08-25",
    });

    assert.equal(model.selectedDay.formalIncomeCount, 1);
    assert.equal(model.selectedDay.items[0].transactionType, "income");
    assert.equal(model.selectedDay.items[0].categoryText, "借款 / 出差借款");
    assert.equal(model.summary.advanceIncomeCents, 200000);
    assert.equal(model.summary.formalExpenseCents, 3200);
    assert.equal(model.summary.reimbursableCents, 3200);
    assert.equal(model.summary.advanceBalanceCents, 196800);
    assert.equal(model.summary.advanceBalanceState, "remaining");
  });

  it("ignores requested or zero-value advances that have not actually arrived", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      advances: [
        advance({ id: "zero", receivedCents: 0 }),
        advance({ id: "undated", receivedOn: null }),
      ],
      today: "2026-08-25",
    });

    assert.equal(model.summary.formalIncomeCount, 0);
    assert.equal(model.summary.advanceIncomeCents, 0);
  });

  it("derives missing proof and invoice counts only from formal expenses", () => {
    const complete = expense({
      id: "complete",
      occurredOn: "2026-08-26",
      invoiceStatus: "covered",
      payments: [payment({ id: "payment-complete", paidAt: "2026-08-26T02:00:00.000Z" })],
      attachments: [{ id: "proof-complete", kind: "payment_proof", paymentIds: ["payment-complete"] }],
    });
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense(), complete],
      reviews: [review()],
      today: "2026-08-25",
    });

    assert.equal(model.summary.missingProofCount, 1);
    assert.equal(model.summary.missingInvoiceCount, 1);
  });
});

describe("responsible region projection", () => {
  it("uses date override before weekly default and reports the rule summary", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense()],
      regionProfile: {
        weeklyDefaultCity: "济南",
        dateOverrides: [{ date: "2026-08-25", city: "济宁" }],
      },
      today: "2026-08-25",
    });

    assert.equal(model.selectedDay.region, "济宁");
    assert.equal(model.selectedDay.regionSource, "date_override");
    assert.equal(model.selectedDay.items[0].region, "济宁");
    assert.equal(model.days[0].region, "济南");
    assert.equal(model.regionRuleSummary, "周默认 济南 · 1 个日期覆盖");
  });

  it("keeps a formal entry override above the date and weekly defaults", () => {
    const model = buildExpenseLedgerWorkbenchModel({
      week: WEEK,
      expenses: [expense({ tripRegion: "青岛", tripRegionSource: "entry_override" })],
      regionProfile: {
        weeklyDefaultCity: "济南",
        dateOverrides: { "2026-08-25": "济宁" },
      },
      today: "2026-08-25",
    });

    assert.equal(model.selectedDay.region, "青岛");
    assert.equal(model.selectedDay.items[0].region, "青岛");
    assert.equal(model.selectedDay.items[0].regionSourceLabel, "单笔指定");
  });
});
