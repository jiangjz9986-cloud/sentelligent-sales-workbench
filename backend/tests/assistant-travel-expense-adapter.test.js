import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createTravelExpenseAssistantAdapter } from "../src/assistant/travelExpenseAssistantAdapter.js";

function snapshotAdapter() {
  return {
    travelExpenseSummary({ owner, weekStart }) {
      if (owner !== "owner-1") return { weekStart: weekStart ?? "2026-08-17", summary: { count: 0, actualPaidCents: 0, reimbursementCents: 0, invalidAmountCount: 0 }, items: [], truncated: false };
      return {
        weekStart: weekStart ?? "2026-08-17",
        summary: { count: 1, actualPaidCents: 8800, reimbursementCents: 7000, invalidAmountCount: 0 },
        items: [{ id: "expense-1", occurredOn: "2026-08-17", category: "transport", purpose: "拜访医院", invoiceStatus: "pending", actualPaidCents: 8800, reimbursementCents: 7000 }],
        truncated: false,
      };
    },
  };
}

describe("travel-expense assistant adapter", () => {
  it("returns owner-scoped natural-week facts and a durable travel-expense-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "expense-run-1" });
    const adapter = createTravelExpenseAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({ owner: "owner-1", channel: "desktop", conversationId: "c", eventId: "e", taskType: "weekly_summary", weekStart: "2026-08-17" });
    assert.equal(result.schemaVersion, "travel-expense-v1");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.summary, { count: 1, actualPaidCents: 8800, reimbursementCents: 7000, invalidAmountCount: 0 });
    assert.equal(result.items[0].actualPaidCents, 8800);
    assert.ok(result.facts.some((item) => item.key === "summary.actualPaidCents"));
    assert.deepEqual(result.sourceRefs, [{ type: "travel_expense", id: "expense-1" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.contractVersion, "travel-expense-v1");
    db.close();
  });

  it("keeps invalid amount summaries as review blockers instead of repairing money", async () => {
    const source = snapshotAdapter();
    const adapter = createTravelExpenseAssistantAdapter({
      snapshotAdapter: {
        travelExpenseSummary(input) {
          return {
            ...source.travelExpenseSummary(input),
            summary: { count: 1, actualPaidCents: null, reimbursementCents: null, invalidAmountCount: 1 },
            items: [{ id: "expense-1", occurredOn: "2026-08-17", actualPaidCents: null, reimbursementCents: 9000 }],
          };
        },
      },
    });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "expense_review", weekStart: "2026-08-17" });
    assert.equal(result.summary.actualPaidCents, null);
    assert.equal(result.summary.reimbursementCents, null);
    assert.ok(result.unknowns.some((item) => item.key === "invalid_amounts"));
  });

  it("previews only descriptive fields and rejects amount, invoice status, version, and owner", async () => {
    const adapter = createTravelExpenseAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "entry_preview",
      expenseId: "expense-1",
      changes: {
        purpose: "更新事由",
        category: "住宿",
        actualPaidCents: 1,
        reimbursementCents: 1,
        invoiceStatus: "received",
        version: 2,
        owner: "forged-owner",
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["purpose", "category"]);
    assert.deepEqual(result.changePreview.rejectedFields, ["actualPaidCents", "reimbursementCents", "invoiceStatus", "version", "owner"]);
    assert.equal(result.changePreview.expectedVersion, null);
    assert.equal(result.writebackPreview.allowed, false);
  });

  it("replays the same weekly summary without querying expenses twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "expense-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createTravelExpenseAssistantAdapter({
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
