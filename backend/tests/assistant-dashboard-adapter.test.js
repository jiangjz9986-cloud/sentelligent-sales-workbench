import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createDashboardAssistantAdapter } from "../src/assistant/dashboardAssistantAdapter.js";

function snapshotAdapter() {
  return {
    dashboardSummary({ owner }) {
      return owner === "owner-1"
        ? { asOf: "2026-08-20T02:00:00Z", weekStart: "2026-08-17", counts: { customers: 2, opportunities: 1, openActions: 3, activeRisks: 1, upcomingItineraries: 2, currentWeekExpenses: 1 } }
        : { asOf: "2026-08-20T02:00:00Z", weekStart: "2026-08-17", counts: { customers: 0, opportunities: 0, openActions: 0, activeRisks: 0, upcomingItineraries: 0, currentWeekExpenses: 0 } };
    },
  };
}

describe("dashboard assistant adapter", () => {
  it("returns bounded counts and a durable dashboard-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "dashboard-run-1" });
    const adapter = createDashboardAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({ owner: "owner-1", channel: "desktop", conversationId: "c", eventId: "e", taskType: "daily_overview" });
    assert.equal(result.schemaVersion, "dashboard-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.counts.openActions, 3);
    assert.ok(result.facts.some((item) => item.key === "counts.activeRisks"));
    assert.deepEqual(result.sourceRefs, [{ type: "dashboard", id: "2026-08-17" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.contractVersion, "dashboard-v1");
    db.close();
  });

  it("keeps an empty owner scope bounded and does not invent a summary", async () => {
    const adapter = createDashboardAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "other-owner", taskType: "focus_summary" });
    assert.deepEqual(result.counts, { customers: 0, opportunities: 0, openActions: 0, activeRisks: 0, upcomingItineraries: 0, currentWeekExpenses: 0 });
    assert.equal(result.inferences.length, 0);
  });

  it("replays the same overview without querying the dashboard twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "dashboard-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createDashboardAssistantAdapter({
      snapshotAdapter: { dashboardSummary(input) { calls += 1; return source.dashboardSummary(input); } },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "replay", eventId: "replay", taskType: "daily_overview" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
