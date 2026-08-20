import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createReimbursementReportAssistantAdapter } from "../src/assistant/reimbursementReportAssistantAdapter.js";

function snapshotAdapter() {
  return {
    travelExpenseSummary({ owner, weekStart }) {
      return owner === "owner-1"
        ? { weekStart: weekStart ?? "2026-08-17", summary: { count: 2, actualPaidCents: 18800, reimbursementCents: 16000, invalidAmountCount: 0 }, items: [
          { id: "expense-1", occurredOn: "2026-08-17", category: "transport", purpose: "拜访医院", invoiceStatus: "received", actualPaidCents: 8800, reimbursementCents: 7000 },
          { id: "expense-2", occurredOn: "2026-08-18", category: "lodging", purpose: "出差住宿", invoiceStatus: "pending", actualPaidCents: 10000, reimbursementCents: 9000 },
        ], truncated: false }
        : { weekStart: weekStart ?? "2026-08-17", summary: { count: 0, actualPaidCents: 0, reimbursementCents: 0, invalidAmountCount: 0 }, items: [], truncated: false };
    },
  };
}

describe("reimbursement-report assistant adapter", () => {
  it("keeps a source-backed reimbursement preview separate from travel-expense-v1", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "reimbursement-run-1" });
    const adapter = createReimbursementReportAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({ owner: "owner-1", channel: "desktop", conversationId: "c", eventId: "e", taskType: "weekly_summary", weekStart: "2026-08-17" });
    assert.equal(result.schemaVersion, "reimbursement-report-v1");
    assert.equal(result.status, "preview");
    assert.deepEqual(result.invoiceCoverage.counts, { received: 1, pending: 1 });
    assert.equal(result.printReadiness.ready, null);
    assert.match(result.printReadiness.blockers[0], /人工确认/);
    assert.deepEqual(result.sourceRefs, [
      { type: "travel_expense", id: "expense-1" },
      { type: "travel_expense", id: "expense-2" },
    ]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.contractVersion, "reimbursement-report-v1");
    db.close();
  });

  it("preserves amount blockers and never claims the report was printed or submitted", async () => {
    const source = snapshotAdapter();
    const adapter = createReimbursementReportAssistantAdapter({
      snapshotAdapter: { travelExpenseSummary(input) {
        return { ...source.travelExpenseSummary(input), summary: { count: 1, actualPaidCents: null, reimbursementCents: null, invalidAmountCount: 1 } };
      } },
    });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "invoice_coverage", weekStart: "2026-08-17" });
    assert.ok(result.unknowns.some((item) => item.key === "invalid_amounts"));
    assert.equal(result.printReadiness.ready, null);
    assert.doesNotMatch(JSON.stringify(result), /报告已(?:打印|提交)|已完成打印|已提交报销/u);
  });

  it("replays the same report without querying the expense snapshot twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "reimbursement-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createReimbursementReportAssistantAdapter({
      snapshotAdapter: { travelExpenseSummary(input) { calls += 1; return source.travelExpenseSummary(input); } },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "replay", eventId: "replay", taskType: "weekly_summary", weekStart: "2026-08-17" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
