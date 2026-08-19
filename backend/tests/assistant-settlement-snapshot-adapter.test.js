import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantSettlementSnapshotAdapter } from "../src/assistant/settlementSnapshotAdapter.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";
import { createInvoiceRepository } from "../src/travelExpense/invoiceRepository.js";

function createRepositories(db) {
  let id = 0;
  const clock = () => new Date("2026-08-20T01:00:00.000Z");
  const travel = createTravelExpenseRepository(db, {
    clock,
    idFactory: () => `settlement-${++id}`,
  });
  const invoices = createInvoiceRepository(db, {
    clock,
    confirmationIdFactory: () => `no-invoice-${++id}`,
  });
  return { travel, invoices, clock };
}

function expense(owner, overrides = {}) {
  return {
    actor: owner,
    occurredOn: "2026-08-18",
    category: "transport",
    purpose: "拜访客户交通",
    payments: [{
      paidAt: "2026-08-18T10:00:00+08:00",
      merchant: "示例交通",
      amountCents: 8800,
      reimbursementCents: 7000,
      fundingSource: "personal",
      paymentMethod: "wechat",
      differenceReason: "个人部分不计入报销",
    }],
    ...overrides,
  };
}

describe("assistant settlement snapshot adapter", () => {
  it("rebuilds the four evidence categories from owner-scoped server facts", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { travel, clock } = createRepositories(db);
    const createdExpense = travel.createExpense(expense("owner-a"));
    travel.createExpense(expense("owner-b", { purpose: "另一账号费用" }));
    const advance = travel.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-17",
      status: "received",
      requestedCents: 5000,
      receivedCents: 5000,
      requestedOn: "2026-08-17",
      receivedOn: "2026-08-17",
      purpose: "本周备用金",
    });
    const adapter = createAssistantSettlementSnapshotAdapter({ db, clock });
    const result = adapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(result.weekStart, "2026-08-17");
    assert.equal(result.expenses.length, 1);
    assert.equal(result.expenses[0].id, createdExpense.id);
    assert.equal(result.expenses[0].payments[0].fundingSource, "personal");
    assert.deepEqual(result.advances.map((item) => item.id), [advance.id]);
    assert.equal(result.summary.settlementEligibleCents, 7000);
    assert.equal(result.summary.advanceReceivedCents, 5000);
    assert.equal(result.summary.personalSettlementCents, 2000);
    assert.equal(result.summary.settlementDirection, "company_reimburses");
    assert.equal(result.evidence.settlement.arithmeticComplete, true);
    assert.equal(result.evidence.settlement.transactionRecorded, false);
    assert.equal(result.invoiceCoverage.unacknowledgedMissingCents, 7000);
    assert.equal(result.invoiceCoverage.complete, false);
    assert.deepEqual(result.sourceRefs, [
      { type: "travel_expense", id: createdExpense.id },
      { type: "travel_expense_advance", id: advance.id },
    ]);
    assert.equal(result.expenses[0].owner, undefined);
    assert.equal(result.advances[0].owner, undefined);
    db.close();
  });

  it("recognizes an explicit no-invoice confirmation as evidence without writing anything", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { travel, invoices, clock } = createRepositories(db);
    const created = travel.createExpense(expense("owner-a"));
    invoices.confirmNoInvoice({
      owner: "owner-a",
      actor: "owner-a",
      expenseId: created.id,
      paymentId: created.payments[0].id,
      reason: "供应商无法开具发票",
    });
    const adapter = createAssistantSettlementSnapshotAdapter({ db, clock });
    const result = adapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(result.invoiceCoverage.noInvoiceConfirmedCents, 7000);
    assert.equal(result.invoiceCoverage.unacknowledgedMissingCents, 0);
    assert.equal(result.invoiceCoverage.complete, true);
    assert.equal(result.expenses[0].invoiceStatus, "missing");
    assert.equal(result.summary.personalSettlementCents, 7000);
    db.close();
  });

  it("fails closed for a mapped-empty owner and marks missing transaction history", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { clock } = createRepositories(db);
    const adapter = createAssistantSettlementSnapshotAdapter({
      db,
      clock,
      resolveBusinessOwner: () => null,
    });
    const result = adapter.advanceSettlementSummary({ owner: "machine-account", weekStart: "2026-08-17" });
    assert.deepEqual(result.expenses, []);
    assert.deepEqual(result.advances, []);
    assert.equal(result.summary.personalSettlementCents, null);
    assert.equal(result.evidence.settlement.transactionRecorded, false);
    assert.deepEqual(result.issues, ["owner_scope_empty"]);
    db.close();
  });
});
