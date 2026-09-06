import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createActionRiskAssistantAdapter } from "../src/assistant/actionRiskAssistantAdapter.js";

function snapshotAdapter() {
  return {
    actionRiskSummary({ owner, customerId, opportunityId }) {
      if (owner !== "owner-1") return { actions: [], risks: [], truncated: { actions: false, risks: false } };
      if (customerId === "customer-1" && !opportunityId) return {
        actions: [{ id: "action-1", customerId: "customer-1", title: "补充资料", status: "pending", due: "2026-08-22", priority: "high", updatedAt: "2026-08-20T01:00:00Z" }],
        risks: [{ id: "risk-1", customerId: "customer-1", title: "预算未确认", status: "open", severity: "high", score: 80, due: "2026-08-25", updatedAt: "2026-08-20T01:00:00Z" }],
        truncated: { actions: false, risks: false },
      };
      return { actions: [], risks: [], truncated: { actions: false, risks: false } };
    },
  };
}

describe("action-risk assistant adapter", () => {
  it("returns owner-scoped facts, source refs, and a durable action-risk-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "action-risk-run-1" });
    const adapter = createActionRiskAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "summary",
      customerId: "customer-1",
    });
    assert.equal(result.schemaVersion, "action-risk-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.actions[0].title, "补充资料");
    assert.equal(result.risks[0].score, 80);
    assert.ok(result.facts.some((item) => item.key === "action.action-1.title"));
    assert.equal(result.prioritization.recommendations.length, 0);
    assert.equal(result.writebackAllowed, false);
    assert.deepEqual(result.sourceRefs, [
      { type: "customer", id: "customer-1" },
      { type: "action", id: "action-1" },
      { type: "risk", id: "risk-1" },
    ]);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.contractVersion, "action-risk-v1");
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("creates a bounded status preview without writing or inventing an assignee", async () => {
    const adapter = createActionRiskAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "status_change_preview",
      customerId: "customer-1",
      actionId: "action-1",
      changes: { status: "in_progress", due: "2026-08-24", priority: "urgent", assignee: "forged" },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["status", "due", "priority"]);
    assert.deepEqual(result.changePreview.rejectedFields, ["assignee"]);
    assert.equal(result.changePreview.expectedVersion, null);
    assert.equal(result.writebackPreview.allowed, false);
  });

  it("replays a summary without querying the source again", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "action-risk-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createActionRiskAssistantAdapter({
      snapshotAdapter: {
        actionRiskSummary(input) { calls += 1; return source.actionRiskSummary(input); },
      },
      runRepository: runs,
    });
    const input = {
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-replay",
      eventId: "event-replay",
      taskType: "summary",
      customerId: "customer-1",
    };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });

  it("keeps an empty owner scope bounded and source-free", async () => {
    const adapter = createActionRiskAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "other-owner", taskType: "summary" });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.risks, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.ok(result.unknowns.some((item) => item.key === "actions_risks"));
  });
});
