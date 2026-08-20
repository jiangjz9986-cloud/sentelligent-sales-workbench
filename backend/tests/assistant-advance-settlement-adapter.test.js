import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createAdvanceSettlementAssistantAdapter } from "../src/assistant/advanceSettlementAssistantAdapter.js";
import { createTravelExpenseRepository } from "../src/travelExpense/repository.js";

function advance(overrides = {}) {
  return {
    id: "advance-1",
    owner: "owner-secret-must-not-leak",
    version: 2,
    weekStart: "2026-08-17",
    status: "received",
    requestedCents: 100000,
    receivedCents: 80000,
    requestedOn: "2026-08-15",
    receivedOn: "2026-08-16",
    purpose: "济宁出差请款",
    notes: "人工录入",
    ...overrides,
  };
}

function sourceFor(records = [advance()]) {
  const calls = [];
  return {
    calls,
    listAdvances({ owner, weekStart }) {
      calls.push({ owner, weekStart });
      return owner === "owner-1" ? records : [];
    },
  };
}

describe("advance-settlement assistant adapter", () => {
  it("returns owner-scoped advance facts and a blocked settlement preview when evidence is unavailable", async () => {
    const source = sourceFor([
      advance(),
      advance({
        id: "advance-2",
        status: "requested",
        requestedCents: 50000,
        receivedCents: 0,
        purpose: "临时补充请款",
      }),
    ]);
    const adapter = createAdvanceSettlementAssistantAdapter({ advanceRepository: source });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "settlement_preview",
      weekStart: "2026-08-17",
    });

    assert.equal(result.schemaVersion, "advance-settlement-v1");
    assert.equal(result.lifecycle, "active");
    assert.equal(result.status, "review_required");
    assert.equal(result.advances.length, 2);
    assert.equal(result.advances[0].requestedCents, 100000);
    assert.equal(result.advances[0].receivedCents, 80000);
    assert.equal(result.advances[0].owner, undefined);
    assert.equal(result.settlementPreview.status, "review_required");
    assert.equal(result.settlementPreview.direction, null);
    assert.equal(result.settlementPreview.amountCents, null);
    assert.equal(result.settlementPreview.formula.personalSettlementCents, null);
    assert.ok(result.settlementPreview.blockers.some((item) => item.key === "settlement_evidence"));
    assert.ok(result.settlementPreview.blockers.some((item) => item.key === "settlement_transaction"));
    assert.equal(result.settlementPreview.transaction.recorded, false);
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.writebackPreview.allowed, false);
    assert.ok(result.unknowns.some((item) => item.key === "settlement_evidence"));
    assert.deepEqual(result.sourceRefs, [
      { type: "travel_expense_advance", id: "advance-1" },
      { type: "travel_expense_advance", id: "advance-2" },
    ]);
    assert.equal(result.facts.some((item) => item.key.endsWith(".requestedCents")), true);
    assert.equal(Object.hasOwn(result, "settlementDirection"), false);
    assert.equal(Object.hasOwn(result, "differenceCents"), false);
    assert.deepEqual(source.calls, [{ owner: "owner-1", weekStart: "2026-08-17" }]);
  });

  it("filters an advance by its server-returned id and never reads another owner", async () => {
    const source = sourceFor([advance(), advance({ id: "advance-2" })]);
    const adapter = createAdvanceSettlementAssistantAdapter({ snapshotAdapter: source });
    const result = await adapter.analyze({
      owner: "owner-2",
      taskType: "advance_summary",
      weekStart: "2026-08-17",
      advanceId: "advance-1",
    });

    assert.deepEqual(result.advances, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.ok(result.unknowns.some((item) => item.key === "advance_not_found"));
    assert.deepEqual(source.calls, [{ owner: "owner-2", weekStart: "2026-08-17" }]);
  });

  it("redacts malformed fields, marks a bounded snapshot, and preserves a current-week default", async () => {
    const source = sourceFor([
      advance({ status: "forged-status", requestedCents: -1, notes: "bad\u0000note" }),
      ...Array.from({ length: 100 }, (_, index) => advance({ id: `advance-${index + 2}` })),
    ]);
    const adapter = createAdvanceSettlementAssistantAdapter({
      advanceSnapshotAdapter: source,
      clock: () => new Date("2026-08-20T01:00:00.000Z"),
    });
    const result = await adapter.analyze({ owner: "owner-1" });

    assert.equal(result.weekStart, "2026-08-17");
    assert.equal(result.advances.length, 100);
    assert.deepEqual(result.truncated, { expenses: false, advances: true });
    assert.equal(result.advances[0].status, null);
    assert.equal(result.advances[0].requestedCents, null);
    assert.equal(Object.hasOwn(result.advances[0], "owner"), false);
    assert.ok(result.unknowns.some((item) => item.key === "truncated"));
    assert.deepEqual(source.calls, [{ owner: "owner-1", weekStart: "2026-08-17" }]);
  });

  it("returns a source-backed direction preview without recording a refund or top-up transaction", async () => {
    const source = {
      settlementSummary({ owner, weekStart }) {
        assert.equal(owner, "owner-1");
        assert.equal(weekStart, "2026-08-17");
        return {
          asOf: "2026-08-20T01:00:00.000Z",
          weekStart,
          expenses: [{
            id: "expense-1",
            version: 3,
            occurredOn: weekStart,
            category: "transport",
            purpose: "客户拜访交通",
            invoiceStatus: "covered",
            payments: [{
              id: "payment-1",
              amountCents: 12000,
              reimbursementCents: 10000,
              fundingSource: "personal",
              paidAt: "2026-08-18T10:00:00+08:00",
            }],
            actualPaidCents: 12000,
            reimbursementCents: 10000,
            settlementEligibleCents: 10000,
            personalPaidCents: 12000,
            companyDirectPaidCents: 0,
            companyDirectReimbursementCents: 0,
            advanceFundedCents: 0,
            invoiceCoverage: {
              confirmedCents: 10000,
              missingCents: 0,
              noInvoiceConfirmedCents: 0,
              unacknowledgedMissingCents: 0,
            },
          }],
          advances: [{
            id: "advance-1",
            version: 2,
            weekStart,
            status: "received",
            requestedCents: 5000,
            receivedCents: 5000,
            requestedOn: weekStart,
            receivedOn: weekStart,
            purpose: "本周备用金",
          }],
          summary: {
            expenseCount: 1,
            paymentCount: 1,
            actualPaidCents: 12000,
            reimbursementCents: 10000,
            personalPaidCents: 12000,
            companyDirectPaidCents: 0,
            companyDirectReimbursementCents: 0,
            advanceFundedCents: 0,
            settlementEligibleCents: 10000,
            advanceReceivedCents: 5000,
            personalSettlementCents: 5000,
            settlementDirection: "company_reimburses",
          },
          invoiceCoverage: {
            reimbursementCents: 10000,
            confirmedCents: 10000,
            missingCents: 0,
            noInvoiceConfirmedCents: 0,
            unacknowledgedMissingCents: 0,
            complete: true,
          },
          evidence: {
            advances: { count: 1, complete: true },
            expenses: { count: 1, complete: true },
            fundingSources: { complete: true, unknownCount: 0 },
            invoiceCoverage: { complete: true, unacknowledgedMissingCents: 0 },
            settlement: { arithmeticComplete: true, transactionRecorded: false },
          },
          issues: [],
          truncated: { expenses: false, advances: false },
          sourceRefs: [
            { type: "travel_expense", id: "expense-1" },
            { type: "travel_expense_advance", id: "advance-1" },
          ],
        };
      },
    };
    const adapter = createAdvanceSettlementAssistantAdapter({ settlementSnapshotAdapter: source });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "settlement_preview", weekStart: "2026-08-17" });

    assert.equal(result.status, "review_required");
    assert.equal(result.settlementPreview.direction, "company_reimburses");
    assert.equal(result.settlementPreview.amountCents, 5000);
    assert.equal(result.settlementPreview.signedAmountCents, 5000);
    assert.deepEqual(result.settlementPreview.formula, {
      settlementEligibleCents: 10000,
      advanceReceivedCents: 5000,
      personalSettlementCents: 5000,
      expression: "非公司直付的可报销金额 - 已收到请款金额",
    });
    assert.ok(result.settlementPreview.blockers.some((item) => item.key === "settlement_transaction"));
    assert.equal(result.settlementPreview.transaction.recorded, false);
    assert.equal(result.settlementPreview.transaction.type, null);
    assert.equal(result.writebackPreview.allowed, false);
    assert.equal(result.writebackAllowed, false);
  });

  it("replays a deterministic read without querying the advance source twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "advance-run-1" });
    const source = sourceFor();
    const adapter = createAdvanceSettlementAssistantAdapter({
      advanceRepository: source,
      runRepository: runs,
    });
    const input = {
      owner: "owner-1",
      channel: "desktop",
      conversationId: "advance-replay",
      eventId: "advance-event",
      taskType: "direction_explanation",
      weekStart: "2026-08-17",
    };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);

    assert.equal(source.calls.length, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.equal(runs.get(first.runId, { owner: "owner-1" }).item.input.owner, undefined);
    assert.equal(runs.get(first.runId, { owner: "owner-1" }).item.contractVersion, "advance-settlement-v1");
    db.close();
  });

  it("reads the real owner-scoped advance repository without exposing its owner field", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const repository = createTravelExpenseRepository(db, {
      idFactory: (() => {
        let index = 0;
        return () => `advance-repository-${++index}`;
      })(),
      clock: () => new Date("2026-08-20T01:00:00.000Z"),
    });
    const first = repository.createAdvance({
      actor: "owner-a",
      weekStart: "2026-08-17",
      status: "received",
      requestedCents: 120000,
      receivedCents: 100000,
      requestedOn: "2026-08-16",
      receivedOn: "2026-08-17",
      purpose: "真实仓储测试",
      notes: "只读适配器",
    });
    repository.createAdvance({
      actor: "owner-b",
      weekStart: "2026-08-17",
      status: "requested",
      requestedCents: 80000,
      receivedCents: 0,
      purpose: "另一账号",
    });

    const adapter = createAdvanceSettlementAssistantAdapter({ advanceRepository: repository });
    const result = await adapter.analyze({ owner: "owner-a", weekStart: "2026-08-17" });

    assert.deepEqual(result.advances.map((item) => item.id), [first.id]);
    assert.equal(result.advances[0].receivedCents, 100000);
    assert.equal(result.advances[0].owner, undefined);
    assert.deepEqual(result.sourceRefs, [{ type: "travel_expense_advance", id: first.id }]);
    db.close();
  });

  it("rejects non-Monday weeks and invalid task types before reading data", async () => {
    const source = sourceFor();
    const adapter = createAdvanceSettlementAssistantAdapter({ advanceRepository: source });
    await assert.rejects(
      () => adapter.analyze({ owner: "owner-1", weekStart: "2026-08-18" }),
      (error) => error.code === "invalid_advance_settlement_input",
    );
    await assert.rejects(
      () => adapter.analyze({ owner: "owner-1", taskType: "write_money", weekStart: "2026-08-17" }),
      (error) => error.code === "invalid_advance_settlement_input",
    );
    await assert.rejects(
      () => adapter.analyze({ owner: "owner-1", advanceId: "/all", weekStart: "2026-08-17" }),
      (error) => error.code === "invalid_advance_settlement_input",
    );
    assert.deepEqual(source.calls, []);
  });
});
