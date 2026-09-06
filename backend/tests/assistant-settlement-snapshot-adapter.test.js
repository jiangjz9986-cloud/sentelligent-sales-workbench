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
    assert.equal(result.expenses[0].paymentCount, 1);
    assert.equal(Object.hasOwn(result.expenses[0], "payments"), false);
    assert.deepEqual(result.advances.map((item) => item.id), [advance.id]);
    assert.equal(result.summary.settlementEligibleCents, 7000);
    assert.equal(result.summary.advanceReceivedCents, 5000);
    assert.equal(result.summary.personalSettlementCents, 2000);
    assert.equal(result.summary.settlementDirection, "company_reimburses");
    assert.equal(result.evidence.settlement.arithmeticComplete, true);
    assert.equal(result.evidence.settlement.transactionRecorded, false);
    assert.deepEqual(result.evidence.sources, { count: 2, complete: true });
    assert.match(result.settlementSnapshotHash, /^[0-9a-f]{64}$/u);
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
    travel.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-17",
      status: "received",
      requestedCents: 0,
      receivedCents: 0,
      requestedOn: "2026-08-17",
      receivedOn: "2026-08-17",
      purpose: "本周无预支金额",
    });
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

  it("keeps direction and amount unknown when the week has expenses but no advance record", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { travel, clock } = createRepositories(db);
    travel.createExpense(expense("owner-a"));
    const adapter = createAssistantSettlementSnapshotAdapter({ db, clock });
    const result = adapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(result.expenses.length, 1);
    assert.equal(result.advances.length, 0);
    assert.equal(result.summary.personalSettlementCents, null);
    assert.equal(result.summary.settlementDirection, null);
    assert.equal(result.evidence.settlement.arithmeticComplete, false);
    assert.ok(result.issues.includes("missing_advance_record"));
    db.close();
  });

  it("bounds the combined entity payload at 50 and fails closed on truncation", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { travel, clock } = createRepositories(db);
    for (let index = 0; index < 30; index += 1) {
      travel.createAdvance({
        actor: "owner-a",
        weekStart: "2026-08-17",
        status: "received",
        requestedCents: 1000,
        receivedCents: 1000,
        requestedOn: "2026-08-17",
        receivedOn: "2026-08-17",
        purpose: `请款 ${index + 1}`,
      });
      travel.createExpense(expense("owner-a", { purpose: `费用 ${index + 1}` }));
    }
    const adapter = createAssistantSettlementSnapshotAdapter({ db, clock });
    const result = adapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.equal(result.advances.length + result.expenses.length, 50);
    assert.deepEqual(result.truncated, { expenses: true, advances: false });
    assert.equal(result.sourceRefs.length, 50);
    assert.equal(result.sourceRefs.length, result.advances.length + result.expenses.length);
    assert.equal(result.evidence.sources.complete, false);
    assert.equal(result.summary.personalSettlementCents, null);
    assert.equal(result.summary.settlementDirection, null);
    assert.equal(result.evidence.settlement.arithmeticComplete, false);
    db.close();
  });

  it("produces a deterministic hash that binds every selected raw calculation row", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const { travel } = createRepositories(db);
    const created = travel.createExpense(expense("owner-a"));
    travel.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-17",
      status: "received",
      requestedCents: 5000,
      receivedCents: 5000,
      requestedOn: "2026-08-17",
      receivedOn: "2026-08-17",
      purpose: "本周备用金",
    });
    const firstAdapter = createAssistantSettlementSnapshotAdapter({
      db,
      clock: () => new Date("2026-08-20T01:00:00.000Z"),
    });
    const laterAdapter = createAssistantSettlementSnapshotAdapter({
      db,
      clock: () => new Date("2026-08-20T05:00:00.000Z"),
    });
    const first = firstAdapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    const later = laterAdapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    assert.notEqual(first.asOf, later.asOf);
    assert.equal(first.settlementSnapshotHash, later.settlementSnapshotHash);

    db.prepare("UPDATE travel_expense_payments SET merchant = $merchant WHERE id = $id").run({
      $id: created.payments[0].id,
      $merchant: "更正后的交通商户",
    });
    const changed = laterAdapter.advanceSettlementSummary({ owner: "owner-a", weekStart: "2026-08-17" });
    assert.notEqual(changed.settlementSnapshotHash, first.settlementSnapshotHash);
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
    assert.equal(result.evidence.sources.complete, false);
    assert.match(result.settlementSnapshotHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(result.issues, ["owner_scope_empty"]);
    db.close();
  });
});
