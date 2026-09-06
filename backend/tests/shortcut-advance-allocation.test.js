import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { buildShortcutAdvanceAllocation } from "../src/integrations/shortcutAdvanceAllocation.js";
import { createShortcutAdvanceAllocationRepository } from "../src/integrations/shortcutAdvanceAllocationRepository.js";

const expense = (id, date, cents, extra = {}) => ({
  id,
  occurredOn: date,
  payments: [{ id: `${id}-p1`, sequence: 1, amountCents: cents, reimbursementCents: cents, fundingSource: extra.fundingSource ?? "personal" }],
  ...extra,
});

test("allocates a received Wednesday loan retroactively to same-week FIFO expenses", () => {
  const plan = buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedOn: "2026-08-26", receivedCents: 200000, status: "received" }],
    expenses: [expense("e-before", "2026-08-24", 50000), expense("e-after", "2026-08-27", 30000)],
  });
  assert.equal(plan.proposedAllocations.length, 2);
  assert.equal(plan.allocatedCents, 80000);
  assert.equal(plan.remainingCents, 120000);
  assert.equal(plan.expenseSummaries[0].personalPaidCents, 0);
  assert.equal(plan.warnings.length, 0);
});

test("excludes company-direct payments and supports explicit single-expense binding", () => {
  const plan = buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    expenseId: "target",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedCents: 10000, status: "received" }],
    expenses: [
      expense("company", "2026-08-24", 5000, { fundingSource: "company" }),
      expense("target", "2026-08-25", 20000),
    ],
  });
  assert.deepEqual(plan.proposedAllocations.map((item) => item.expenseId), ["target"]);
  assert.equal(plan.allocatedCents, 10000);
  assert.equal(plan.expenseSummaries[0].overageCents, 10000);
});

test("does not silently cross weeks and plan hash changes when spillover is explicit", () => {
  const input = {
    weekStart: "2026-08-24",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedCents: 10000, status: "received" }],
    expenses: [expense("other-week", "2026-08-31", 5000)],
  };
  const sameWeek = buildShortcutAdvanceAllocation(input);
  const spillover = buildShortcutAdvanceAllocation({ ...input, includeSpillover: true });
  assert.equal(sameWeek.proposedAllocations.length, 0);
  assert.equal(spillover.proposedAllocations.length, 1, "cross-week allocation requires the explicit spillover flag");
  assert.notEqual(sameWeek.planHash, spillover.planHash);
  assert.ok(spillover.warnings.includes("spillover_requires_explicit_confirmation"));
});

test("honors active historical allocations and never proposes negative balances", () => {
  const plan = buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedCents: 10000, status: "received" }],
    expenses: [expense("e1", "2026-08-24", 10000)],
    existingAllocations: [{ advanceId: "loan-1", paymentId: "e1-p1", allocatedCents: 7000, status: "active" }],
  });
  assert.equal(plan.proposedAllocations[0].allocatedCents, 3000);
  assert.equal(plan.advanceSummaries[0].remainingCents, 0);
});

test("filters a multi-loan proposal to the quoted advance instead of consuming a sibling loan", () => {
  const plan = buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    advanceId: "loan-2",
    advances: [
      { id: "loan-1", weekStart: "2026-08-24", receivedOn: "2026-08-25", receivedCents: 10000, status: "received" },
      { id: "loan-2", weekStart: "2026-08-24", receivedOn: "2026-08-27", receivedCents: 20000, status: "received" },
    ],
    expenses: [expense("e1", "2026-08-24", 25000)],
  });
  assert.deepEqual([...new Set(plan.proposedAllocations.map((item) => item.advanceId))], ["loan-2"]);
  assert.equal(plan.allocatedCents, 20000);
  assert.equal(plan.remainingCents, 0);
  assert.equal(plan.uncoveredCents, 5000);
});

test("does not include a standard reimbursement-session expense in shortcut loan allocation facts", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    db.exec(`
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, invoice_status,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'reimbursement-session-expense', 'EXP-REIMBURSEMENT-SESSION', 'owner-a', '2026-08-25',
        'lunch', '整理报销会话费用', 'pending', 'owner-a', 'owner-a',
        '2026-08-25T12:00:00.000Z', '2026-08-25T12:00:00.000Z'
      );
      INSERT INTO travel_expense_payments (
        id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
        funding_source, payment_method
      ) VALUES (
        'reimbursement-session-payment', 'reimbursement-session-expense', 1,
        '2026-08-25T12:00:00+08:00', 5000, 5000, 'personal', 'wechat'
      );
      INSERT INTO shortcut_bookkeeping_entries (
        id, owner, actor, target_system, ledger_name, entry_type, category,
        subcategory, idempotency_key_hash, request_hash, raw_text, status,
        created_at, updated_at
      ) VALUES (
        'loan-source-for-boundary', 'owner-a', 'owner-a', 'sentelligent', '出差报销',
        'income', '出差', '借款', '${"c".repeat(64)}', '${"d".repeat(64)}',
        '已到账借款', 'accepted', '2026-08-25T12:00:00.000Z', '2026-08-25T12:00:00.000Z'
      );
      INSERT INTO travel_expense_advances (
        id, version, owner, week_start, status, requested_cents, received_cents,
        received_on, purpose, created_by, updated_by
      ) VALUES (
        'loan-boundary', 1, 'owner-a', '2026-08-24', 'received', 10000, 10000,
        '2026-08-25', '出差借款', 'owner-a', 'owner-a'
      );
      INSERT INTO travel_expense_advance_sources (
        id, owner, entry_id, advance_id, amount_cents, received_on, week_start,
        created_by, created_at
      ) VALUES (
        'loan-boundary-source', 'owner-a', 'loan-source-for-boundary', 'loan-boundary',
        10000, '2026-08-25', '2026-08-24', 'owner-a', '2026-08-25T12:00:00.000Z'
      );
    `);
    const repository = createShortcutAdvanceAllocationRepository(db);
    const proposal = repository.propose({ owner: "owner-a", weekStart: "2026-08-24", advanceId: "loan-boundary" });
    assert.equal(proposal.requestedCents, 0);
    assert.equal(proposal.proposedAllocations.length, 0);
  } finally {
    db.close();
  }
});

test("accepts flat expense rows and rejects invalid calendar dates before planning", () => {
  const plan = buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedCents: 1000, status: "received" }],
    expenses: [{ id: "flat", occurredOn: "2026-08-24", amountCents: 1000 }],
  });
  assert.equal(plan.allocatedCents, 1000);
  assert.throws(() => buildShortcutAdvanceAllocation({
    weekStart: "2026-08-24",
    advances: [{ id: "loan-1", weekStart: "2026-08-24", receivedCents: 1000, status: "received" }],
    expenses: [{ id: "bad", occurredOn: "2026-02-30", amountCents: 1000 }],
  }), /occurredOn/u);
});

test("rejects an invalid requested week before reading repository facts", () => {
  assert.throws(() => buildShortcutAdvanceAllocation({
    weekStart: "2026-02-30",
    advances: [],
    expenses: [],
  }), /date is invalid/u);
});

test("replays a confirmed repository plan without inserting a second allocation", () => {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    db.exec(`
      INSERT INTO shortcut_bookkeeping_entries (
        id, owner, actor, target_system, ledger_name, entry_type, category,
        subcategory, idempotency_key_hash, request_hash, raw_text, status,
        created_at, updated_at
      ) VALUES (
        'loan-source-entry', 'owner-a', 'owner-a', 'sentelligent', '出差报销',
        'income', '出差', '借款', '${"a".repeat(64)}', '${"b".repeat(64)}',
        '已到账借款', 'accepted', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
      );
      INSERT INTO travel_expenses (
        id, reference_code, owner, occurred_on, category, purpose, invoice_status,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'expense-replay', 'EXP-20260824-REPLAY', 'owner-a', '2026-08-24', 'other', '餐饮', 'pending',
        'owner-a', 'owner-a', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
      );
      INSERT INTO travel_expense_payments (
        id, expense_id, sequence, paid_at, amount_cents, reimbursement_cents,
        funding_source, payment_method
      ) VALUES (
        'payment-replay', 'expense-replay', 1, '2026-08-24T12:00:00+08:00',
        1000, 1000, 'personal', 'wechat'
      );
      INSERT INTO shortcut_bookkeeping_entries (
        id, owner, actor, target_system, ledger_name, entry_type, category,
        subcategory, idempotency_key_hash, request_hash, raw_text, status,
        expense_id, payment_id, created_at, updated_at
      ) VALUES (
        'expense-replay-shortcut-entry', 'owner-a', 'owner-a', 'sentelligent', '出差报销',
        'expense', '餐饮', '午餐', '${"e".repeat(64)}', '${"f".repeat(64)}',
        '快捷截图餐饮', 'accepted', 'expense-replay', 'payment-replay',
        '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
      );
      INSERT INTO travel_expense_advances (
        id, version, owner, week_start, status, requested_cents, received_cents,
        received_on, purpose, created_by, updated_by
      ) VALUES (
        'loan-replay', 1, 'owner-a', '2026-08-24', 'received', 2000, 2000,
        '2026-08-27', '出差借款', 'owner-a', 'owner-a'
      );
      INSERT INTO travel_expense_advance_sources (
        id, owner, entry_id, advance_id, amount_cents, received_on, week_start,
        created_by, created_at
      ) VALUES (
        'source-replay', 'owner-a', 'loan-source-entry', 'loan-replay', 2000,
        '2026-08-27', '2026-08-24', 'owner-a', '2026-08-27T00:00:00.000Z'
      );
    `);
    let sequence = 0;
    const repository = createShortcutAdvanceAllocationRepository(db, {
      idFactory: () => `allocation-generated-${++sequence}`,
      clock: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    const proposal = repository.propose({ owner: "owner-a", weekStart: "2026-08-24", advanceId: "loan-replay" });
    const first = repository.confirm({
      owner: "owner-a", actor: "owner-a", weekStart: "2026-08-24", advanceId: "loan-replay",
      planHash: proposal.planHash, requestId: "replay-test-1",
    });
    const second = repository.confirm({
      owner: "owner-a", actor: "owner-a", weekStart: "2026-08-24", advanceId: "loan-replay",
      planHash: proposal.planHash, requestId: "replay-test-2",
    });
    assert.equal(first.replayed, undefined);
    assert.equal(second.replayed, true);
    assert.equal(second.planId, first.planId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_advance_allocation_plans").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expense_advance_allocations").get().count, 1);
  } finally {
    db.close();
  }
});
