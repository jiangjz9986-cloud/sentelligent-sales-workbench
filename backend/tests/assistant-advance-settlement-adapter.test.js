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
    assert.match(result.settlementSnapshotHash, /^[0-9a-f]{64}$/u);
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.acceptsConfirmation, false);
    assert.equal(result.settlementPreview.requiresHumanConfirmation, false);
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

  it("ignores legacy advanceId input and returns the complete owner-scoped week", async () => {
    const source = sourceFor([advance(), advance({ id: "advance-2" })]);
    const adapter = createAdvanceSettlementAssistantAdapter({ snapshotAdapter: source });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "advance_summary",
      weekStart: "2026-08-17",
      advanceId: "advance-1",
    });

    assert.deepEqual(result.advances.map((item) => item.id), ["advance-1", "advance-2"]);
    assert.deepEqual(result.sourceRefs, [
      { type: "travel_expense_advance", id: "advance-1" },
      { type: "travel_expense_advance", id: "advance-2" },
    ]);
    assert.equal(result.unknowns.some((item) => item.key === "advance_not_found"), false);
    assert.deepEqual(source.calls, [{ owner: "owner-1", weekStart: "2026-08-17" }]);
  });

  it("redacts malformed fields, marks a bounded snapshot, and preserves a current-week default", async () => {
    const source = sourceFor([
      advance({ status: "forged-status", requestedCents: -1, notes: "bad\u0000note" }),
      ...Array.from({ length: 55 }, (_, index) => advance({ id: `advance-${index + 2}` })),
    ]);
    const adapter = createAdvanceSettlementAssistantAdapter({
      advanceSnapshotAdapter: source,
      clock: () => new Date("2026-08-20T01:00:00.000Z"),
    });
    const result = await adapter.analyze({ owner: "owner-1" });

    assert.equal(result.weekStart, "2026-08-17");
    assert.equal(result.advances.length, 50);
    assert.deepEqual(result.truncated, { expenses: false, advances: true });
    assert.equal(result.advances[0].status, null);
    assert.equal(result.advances[0].requestedCents, null);
    assert.equal(Object.hasOwn(result.advances[0], "owner"), false);
    assert.ok(result.unknowns.some((item) => item.key === "truncated"));
    assert.equal(result.sourceRefs.length, 50);
    assert.equal(result.settlementPreview.direction, null);
    assert.equal(result.settlementPreview.amountCents, null);
    assert.deepEqual(source.calls, [{ owner: "owner-1", weekStart: "2026-08-17" }]);
  });

  it("persists a complete 50-entity output within the real run repository limits", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "advance-max-run" });
    const weekStart = "2026-08-17";
    const advances = Array.from({ length: 25 }, (_, index) => ({
      id: `advance-max-${index + 1}`,
      version: 1,
      weekStart,
      status: "received",
      requestedCents: 0,
      receivedCents: 0,
      requestedOn: weekStart,
      receivedOn: weekStart,
      purpose: `请款 ${index + 1}`,
    }));
    const expenses = Array.from({ length: 25 }, (_, index) => ({
      id: `expense-max-${index + 1}`,
      referenceCode: `EXP-${index + 1}`,
      version: 1,
      occurredOn: "2026-08-18",
      category: "transport",
      purpose: `费用 ${index + 1}`,
      invoiceStatus: "covered",
      paymentCount: 0,
      actualPaidCents: 0,
      reimbursementCents: 0,
      settlementEligibleCents: 0,
      personalPaidCents: 0,
      companyDirectPaidCents: 0,
      companyDirectReimbursementCents: 0,
      advanceFundedCents: 0,
      invoiceCoverage: {
        confirmedCents: 0,
        missingCents: 0,
        noInvoiceConfirmedCents: 0,
        unacknowledgedMissingCents: 0,
      },
    }));
    const source = {
      advanceSettlementSummary() {
        return {
          asOf: "2026-08-20T01:00:00.000Z",
          weekStart,
          settlementSnapshotHash: "d".repeat(64),
          expenses,
          advances,
          summary: {
            expenseCount: 25,
            paymentCount: 0,
            actualPaidCents: 0,
            reimbursementCents: 0,
            personalPaidCents: 0,
            companyDirectPaidCents: 0,
            companyDirectReimbursementCents: 0,
            advanceFundedCents: 0,
            settlementEligibleCents: 0,
            advanceReceivedCents: 0,
            personalSettlementCents: 0,
            settlementDirection: "balanced",
          },
          invoiceCoverage: {
            reimbursementCents: 0,
            confirmedCents: 0,
            missingCents: 0,
            noInvoiceConfirmedCents: 0,
            unacknowledgedMissingCents: 0,
            complete: true,
          },
          evidence: {
            sources: { count: 50, complete: true },
            advances: { count: 25, complete: true },
            expenses: { count: 25, complete: true },
            fundingSources: { complete: true, unknownCount: 0 },
            invoiceCoverage: { complete: true, unacknowledgedMissingCents: 0 },
            settlement: { arithmeticComplete: true, transactionRecorded: false },
          },
          issues: [],
          truncated: { expenses: false, advances: false },
        };
      },
    };
    const adapter = createAdvanceSettlementAssistantAdapter({ settlementSnapshotAdapter: source, runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "max-output",
      eventId: "max-output-event",
      weekStart,
    });
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;

    assert.equal(stored.status, "succeeded");
    assert.equal(stored.output.advances.length + stored.output.expenses.length, 50);
    assert.equal(stored.output.sourceRefs.length, 50);
    assert.equal(stored.output.settlementSnapshotHash, "d".repeat(64));
    assert.ok(Buffer.byteLength(JSON.stringify(stored.output), "utf8") < 512 * 1024);
    db.close();
  });

  it("returns a source-backed direction preview without recording a refund or top-up transaction", async () => {
    const source = {
      settlementSummary({ owner, weekStart }) {
        assert.equal(owner, "owner-1");
        assert.equal(weekStart, "2026-08-17");
        return {
          asOf: "2026-08-20T01:00:00.000Z",
          weekStart,
          settlementSnapshotHash: "a".repeat(64),
          expenses: [{
            id: "expense-1",
            version: 3,
            occurredOn: weekStart,
            category: "transport",
            purpose: "客户拜访交通",
            invoiceStatus: "covered",
            paymentCount: 1,
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
            sources: { count: 2, complete: true },
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
    assert.equal(result.settlementSnapshotHash, "a".repeat(64));
    assert.equal(result.settlementEvidence.settlementSnapshotHash, "a".repeat(64));
    assert.deepEqual(result.settlementEvidence.sources, { count: 2, complete: true });
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
    assert.match(result.settlementPreview.transaction.note, /仅供核对/u);
    assert.match(result.settlementPreview.transaction.note, /不接受确认写入/u);
    assert.match(result.settlementPreview.transaction.note, /不产生.*交易/u);
    assert.equal(result.settlementPreview.requiresHumanConfirmation, false);
    assert.equal(result.settlementPreview.acceptsConfirmation, false);
    assert.equal(result.writebackPreview.allowed, false);
    assert.equal(result.writebackPreview.requiresHumanConfirmation, false);
    assert.equal(result.writebackPreview.acceptsConfirmation, false);
    assert.match(result.writebackPreview.note, /仅供核对/u);
    assert.match(result.writebackPreview.note, /不接受确认写入/u);
    assert.match(result.writebackPreview.note, /不.*产生.*交易/u);
    assert.equal(result.writebackAllowed, false);
  });

  it("replays a deterministic read without querying the advance source twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "advance-run-1" });
    const records = [advance()];
    const source = sourceFor(records);
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
    const storedFirst = runs.get(first.runId, { owner: "owner-1" }).item.output;
    records[0] = advance({ receivedCents: 1, purpose: "回放后不得读取的变更" });
    records.push(advance({ id: "advance-new" }));
    const replay = await adapter.analyze(input);
    const storedReplay = runs.get(first.runId, { owner: "owner-1" }).item.output;
    const { runId: replayRunId, inputSnapshotHash: replayInputHash, replayed, ...replayedOutput } = replay;

    assert.equal(source.calls.length, 1);
    assert.equal(replayed, true);
    assert.equal(replayRunId, first.runId);
    assert.equal(replayInputHash, first.inputSnapshotHash);
    assert.equal(replay.settlementSnapshotHash, first.settlementSnapshotHash);
    assert.deepEqual(replayedOutput, storedFirst);
    assert.deepEqual(storedReplay, storedFirst);
    assert.equal(runs.get(first.runId, { owner: "owner-1" }).item.input.owner, undefined);
    assert.equal(runs.get(first.runId, { owner: "owner-1" }).item.input.advanceId, undefined);
    assert.equal(runs.get(first.runId, { owner: "owner-1" }).item.contractVersion, "advance-settlement-v1");
    db.close();
  });

  it("rejects failed and running replays without rereading or mutating their prior run", async () => {
    for (const status of ["failed", "running"]) {
      const source = sourceFor();
      const calls = { complete: 0, fail: 0 };
      const runRepository = {
        create() {
          return {
            replayed: true,
            item: {
              id: `prior-${status}`,
              agentId: "advance-settlement",
              status,
              inputSnapshotHash: "b".repeat(64),
              output: status === "failed" ? null : {},
            },
          };
        },
        complete() { calls.complete += 1; },
        fail() { calls.fail += 1; },
      };
      const adapter = createAdvanceSettlementAssistantAdapter({ advanceRepository: source, runRepository });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          () => adapter.analyze({ owner: "owner-1", weekStart: "2026-08-17" }),
          (error) => error.code === "advance_settlement_replay_unavailable",
        );
      }
      assert.equal(source.calls.length, 0);
      assert.deepEqual(calls, { complete: 0, fail: 0 });
    }
  });

  it("suppresses a claimed direction when the source has no advance record", async () => {
    const source = {
      advanceSettlementSummary({ weekStart }) {
        return {
          asOf: "2026-08-20T01:00:00.000Z",
          weekStart,
          settlementSnapshotHash: "c".repeat(64),
          expenses: [{
            id: "expense-1",
            version: 1,
            occurredOn: "2026-08-18",
            category: "transport",
            purpose: "客户拜访交通",
            invoiceStatus: "covered",
            paymentCount: 1,
            actualPaidCents: 1000,
            reimbursementCents: 1000,
            settlementEligibleCents: 1000,
            personalPaidCents: 1000,
            companyDirectPaidCents: 0,
            companyDirectReimbursementCents: 0,
            advanceFundedCents: 0,
            invoiceCoverage: {
              confirmedCents: 1000,
              missingCents: 0,
              noInvoiceConfirmedCents: 0,
              unacknowledgedMissingCents: 0,
            },
          }],
          advances: [],
          summary: {
            expenseCount: 1,
            paymentCount: 1,
            settlementEligibleCents: 1000,
            advanceReceivedCents: 0,
            personalSettlementCents: 1000,
            settlementDirection: "company_reimburses",
          },
          invoiceCoverage: {
            reimbursementCents: 1000,
            confirmedCents: 1000,
            missingCents: 0,
            noInvoiceConfirmedCents: 0,
            unacknowledgedMissingCents: 0,
            complete: true,
          },
          evidence: {
            sources: { count: 1, complete: true },
            advances: { count: 0, complete: true },
            expenses: { count: 1, complete: true },
            fundingSources: { complete: true, unknownCount: 0 },
            invoiceCoverage: { complete: true, unacknowledgedMissingCents: 0 },
            settlement: { arithmeticComplete: true, transactionRecorded: false },
          },
          issues: [],
          truncated: { expenses: false, advances: false },
        };
      },
    };
    const adapter = createAdvanceSettlementAssistantAdapter({ settlementSnapshotAdapter: source });
    const result = await adapter.analyze({ owner: "owner-1", weekStart: "2026-08-17" });

    assert.equal(result.summary.personalSettlementCents, null);
    assert.equal(result.summary.settlementDirection, null);
    assert.equal(result.settlementPreview.direction, null);
    assert.equal(result.settlementPreview.amountCents, null);
    assert.equal(result.settlementPreview.formula.personalSettlementCents, null);
    assert.ok(result.unknowns.some((item) => item.key === "advance_record"));
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
    assert.deepEqual(source.calls, []);
  });
});
