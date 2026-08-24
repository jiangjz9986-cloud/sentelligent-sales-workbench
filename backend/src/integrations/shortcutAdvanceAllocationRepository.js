import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import {
  buildShortcutAdvanceAllocation,
  SHORTCUT_ADVANCE_ALLOCATION_SCHEMA_VERSION,
} from "./shortcutAdvanceAllocation.js";

function requiredText(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new TypeError(`${name} is invalid`);
  return value.trim();
}

function positiveCents(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} is invalid`);
  return number;
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function monday(value) {
  const normalized = requiredText(value, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) throw new TypeError("date is invalid");
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new TypeError("date is invalid");
  }
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function rowToAdvance(row) {
  return {
    id: row.id,
    weekStart: row.week_start,
    receivedOn: row.received_on,
    receivedCents: Number(row.received_cents),
    status: row.status,
    createdAt: row.created_at,
  };
}

function rowToExpense(row, payments) {
  return {
    id: row.id,
    occurredOn: row.occurred_on,
    payments: payments.map((payment) => ({
      id: payment.id,
      expenseId: payment.expense_id,
      sequence: Number(payment.sequence),
      amountCents: Number(payment.amount_cents),
      reimbursementCents: Number(payment.reimbursement_cents),
      fundingSource: payment.funding_source,
    })),
  };
}

export function createShortcutAdvanceAllocationRepository(db, {
  idFactory = randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  const activeAdvances = db.prepare(`
    SELECT advance.*, source.entry_id AS source_entry_id
    FROM travel_expense_advances advance
    JOIN travel_expense_advance_sources source ON source.advance_id = advance.id
      AND source.owner = advance.owner AND source.status = 'active'
    WHERE advance.owner = $owner AND advance.status = 'received'
      AND advance.deleted_at IS NULL
    ORDER BY advance.received_on, advance.created_at, advance.id
  `);
  const expensesByWeek = db.prepare(`
    SELECT expense.id, expense.occurred_on
    FROM travel_expenses expense
    JOIN shortcut_bookkeeping_entries shortcut_entry
      ON shortcut_entry.expense_id = expense.id
     AND shortcut_entry.owner = expense.owner
     AND shortcut_entry.entry_type = 'expense'
     AND shortcut_entry.status = 'accepted'
    WHERE expense.owner = $owner AND expense.deleted_at IS NULL
      AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
    ORDER BY expense.occurred_on, expense.created_at, expense.id
  `);
  const paymentsByExpense = db.prepare(`
    SELECT id, expense_id, sequence, amount_cents, reimbursement_cents, funding_source
    FROM travel_expense_payments WHERE expense_id = $expenseId ORDER BY sequence, id
  `);
  const activeAllocations = db.prepare(`
    SELECT advance_id, payment_id, allocated_cents, status
    FROM travel_expense_advance_allocations
    WHERE owner = $owner AND status = 'active'
  `);

  function facts(owner, weekStart, advanceId = null) {
    const normalizedOwner = requiredText(owner, "owner");
    const normalizedWeek = monday(weekStart);
    const advances = activeAdvances.all({ $owner: normalizedOwner })
      .filter((row) => row.week_start === normalizedWeek && (!advanceId || row.id === advanceId))
      .map(rowToAdvance);
    const expenseRows = expensesByWeek.all({ $owner: normalizedOwner, $weekStart: normalizedWeek });
    const expenses = expenseRows.map((row) => rowToExpense(row, paymentsByExpense.all({ $expenseId: row.id })));
    const existingAllocations = activeAllocations.all({ $owner: normalizedOwner }).map((row) => ({
      advanceId: row.advance_id,
      paymentId: row.payment_id,
      allocatedCents: Number(row.allocated_cents),
      status: row.status,
    }));
    return { owner: normalizedOwner, weekStart: normalizedWeek, advances, expenses, existingAllocations };
  }

  function propose(input = {}) {
    const normalizedWeek = monday(input.weekStart ?? input.week_start);
    const requestedAdvanceId = input.advanceId ?? input.advance_id ?? null;
    if (requestedAdvanceId !== null) requiredText(requestedAdvanceId, "advanceId");
    const source = facts(input.owner, normalizedWeek, requestedAdvanceId);
    return buildShortcutAdvanceAllocation({
      ...source,
      weekStart: normalizedWeek,
      ...(requestedAdvanceId ? { advanceId: requestedAdvanceId } : {}),
      ...(input.expenseId || input.expense_id ? { expenseId: input.expenseId ?? input.expense_id } : {}),
      ...(input.includeSpillover === true ? { includeSpillover: true } : {}),
    });
  }

  function confirm(input = {}) {
    const owner = requiredText(input.owner, "owner");
    const actor = requiredText(input.actor ?? owner, "actor");
    const expectedPlanHash = requiredText(input.planHash, "planHash", 64).toLowerCase();
    const normalizedWeek = monday(input.weekStart);
    return withImmediateTransaction(db, () => {
      const existingPlan = db.prepare(`
        SELECT * FROM travel_expense_advance_allocation_plans
        WHERE owner = $owner AND plan_hash = $planHash AND status = 'confirmed'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get({ $owner: owner, $planHash: expectedPlanHash });
      if (existingPlan) {
        if (existingPlan.week_start !== normalizedWeek) {
          const error = new Error("allocation plan week changed");
          error.code = "SHORTCUT_ADVANCE_PLAN_CHANGED";
          throw error;
        }
        const allocations = db.prepare(`
          SELECT advance_id, expense_id, payment_id, week_start, allocated_cents, allocation_kind
          FROM travel_expense_advance_allocations
          WHERE owner = $owner AND plan_id = $planId AND status = 'active'
          ORDER BY created_at, id
        `).all({ $owner: owner, $planId: existingPlan.id }).map((row) => ({
          advanceId: row.advance_id,
          expenseId: row.expense_id,
          paymentId: row.payment_id,
          weekStart: row.week_start,
          allocatedCents: Number(row.allocated_cents),
          allocationKind: row.allocation_kind,
        }));
        const replayWeekStart = existingPlan.week_start;
        const replayDate = new Date(`${replayWeekStart}T00:00:00.000Z`);
        const replayEnd = new Date(replayDate.getTime());
        replayEnd.setUTCDate(replayEnd.getUTCDate() + 6);
        return {
          schemaVersion: SHORTCUT_ADVANCE_ALLOCATION_SCHEMA_VERSION,
          planId: existingPlan.id,
          planHash: existingPlan.plan_hash,
          weekStart: replayWeekStart,
          weekRange: { start: replayWeekStart, end: replayEnd.toISOString().slice(0, 10) },
          scope: existingPlan.scope,
          explicitExpenseId: null,
          advanceId: existingPlan.advance_id ?? null,
          includeSpillover: false,
          proposedAllocations: allocations,
          advanceSummaries: [],
          expenseSummaries: [],
          requestedCents: Number(existingPlan.requested_cents),
          allocatedCents: Number(existingPlan.allocated_cents),
          remainingCents: Number(existingPlan.remaining_cents),
          uncoveredCents: Number(existingPlan.uncovered_cents),
          overageCents: Number(existingPlan.overage_cents),
          warnings: [],
          status: "confirmed",
          replayed: true,
        };
      }
      const proposal = propose({
        owner,
        weekStart: normalizedWeek,
        ...(input.advanceId ? { advanceId: input.advanceId } : {}),
        ...(input.expenseId ? { expenseId: input.expenseId } : {}),
        ...(input.includeSpillover === true ? { includeSpillover: true } : {}),
      });
      if (proposal.planHash !== expectedPlanHash) {
        const error = new Error("allocation plan changed");
        error.code = "SHORTCUT_ADVANCE_PLAN_CHANGED";
        throw error;
      }
      if (proposal.proposedAllocations.length === 0) {
        const error = new Error("allocation plan has no allocations");
        error.code = "SHORTCUT_ADVANCE_PLAN_EMPTY";
        throw error;
      }
      const now = nowIso(clock);
      const planId = requiredText(input.planId ?? idFactory(), "planId");
      const distinctAdvanceIds = [...new Set(proposal.proposedAllocations.map((item) => item.advanceId))];
      const advanceId = distinctAdvanceIds.length === 1 ? distinctAdvanceIds[0] : null;
      db.prepare(`
        INSERT INTO travel_expense_advance_allocation_plans (
          id, owner, advance_id, week_start, scope, status, plan_hash,
          requested_cents, allocated_cents, remaining_cents, uncovered_cents,
          overage_cents, created_by, created_at
        ) VALUES ($id, $owner, $advanceId, $weekStart, $scope, 'confirmed', $planHash,
          $requestedCents, $allocatedCents, $remainingCents, $uncoveredCents,
          $overageCents, $actor, $now)
      `).run({
        $id: planId,
        $owner: owner,
        $advanceId: advanceId,
        $weekStart: normalizedWeek,
        $scope: proposal.scope,
        $planHash: proposal.planHash,
        $requestedCents: proposal.requestedCents,
        $allocatedCents: proposal.allocatedCents,
        $remainingCents: proposal.remainingCents,
        $uncoveredCents: proposal.uncoveredCents,
        $overageCents: proposal.overageCents,
        $actor: actor,
        $now: now,
      });
      const insert = db.prepare(`
        INSERT INTO travel_expense_advance_allocations (
          id, owner, plan_id, advance_id, expense_id, payment_id, week_start,
          allocated_cents, allocation_kind, status, created_by, created_at
        ) VALUES ($id, $owner, $planId, $advanceId, $expenseId, $paymentId, $weekStart,
          $allocatedCents, $allocationKind, 'active', $actor, $now)
      `);
      for (const allocation of proposal.proposedAllocations) {
        insert.run({
          $id: requiredText(idFactory(), "allocationId"),
          $owner: owner,
          $planId: planId,
          $advanceId: allocation.advanceId,
          $expenseId: allocation.expenseId,
          $paymentId: allocation.paymentId,
          $weekStart: allocation.weekStart,
          $allocatedCents: positiveCents(allocation.allocatedCents, "allocatedCents"),
          $allocationKind: allocation.allocationKind,
          $actor: actor,
          $now: now,
        });
      }
      insertAudit(db, {
        action: "shortcut_bookkeeping.advance_allocation.confirm",
        entityType: "travel_expense_advance_allocation_plan",
        entityId: planId,
        actor,
        requestId: input.requestId ?? null,
        before: null,
        after: {
          status: "confirmed",
          planHash: proposal.planHash,
          allocatedCents: proposal.allocatedCents,
          remainingCents: proposal.remainingCents,
          uncoveredCents: proposal.uncoveredCents,
          overageCents: proposal.overageCents,
        },
        metadata: { owner, weekStart: normalizedWeek, scope: proposal.scope },
      });
      return { planId, ...proposal, status: "confirmed" };
    });
  }

  function summary({ owner, weekStart } = {}) {
    const proposal = propose({ owner, weekStart });
    const allocations = db.prepare(`
      SELECT allocation.id, allocation.plan_id, allocation.advance_id, allocation.expense_id,
             allocation.payment_id, allocation.allocated_cents, allocation.allocation_kind,
             allocation.created_at
      FROM travel_expense_advance_allocations allocation
      WHERE allocation.owner = $owner AND allocation.week_start = $weekStart
        AND allocation.status = 'active'
      ORDER BY allocation.created_at, allocation.id
    `).all({ $owner: requiredText(owner, "owner"), $weekStart: proposal.weekStart })
      .map((row) => ({
        id: row.id,
        planId: row.plan_id,
        advanceId: row.advance_id,
        expenseId: row.expense_id,
        paymentId: row.payment_id,
        allocatedCents: Number(row.allocated_cents),
        allocationKind: row.allocation_kind,
        createdAt: row.created_at,
      }));
    return { ...proposal, allocations };
  }

  return Object.freeze({ facts, propose, confirm, summary });
}
