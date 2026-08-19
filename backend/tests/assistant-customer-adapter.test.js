import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createCustomerAssistantAdapter } from "../src/assistant/customerAssistantAdapter.js";

function snapshotAdapter() {
  return {
    customerDetail({ owner, customerId }) {
      if (owner !== "owner-1" || customerId !== "customer-1") return null;
      return { id: "customer-1", name: "示例医院", region: "青岛", type: "医院", level: "重点", updatedAt: "2026-08-20T01:00:00Z" };
    },
    customerSearch({ owner, query }) {
      if (owner !== "owner-1") return { items: [] };
      if (query === "同名") return { items: [
        { id: "customer-a", name: "同名医院", region: "青岛" },
        { id: "customer-b", name: "同名医院", region: "济南" },
      ] };
      if (query.includes("示例医院")) return { items: [{ id: "customer-1", name: "示例医院", region: "青岛", type: "医院", level: "重点" }] };
      return { items: [] };
    },
  };
}

describe("customer assistant adapter", () => {
  it("returns an owner-scoped detail with facts, unknowns, and a durable run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "customer-run-1" });
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "detail",
      customerId: "customer-1",
    });
    assert.equal(result.schemaVersion, "customer-v1");
    assert.equal(result.agentId, "customer");
    assert.equal(result.status, "ok");
    assert.equal(result.customer.name, "示例医院");
    assert.ok(result.facts.some((item) => item.key === "name"));
    assert.ok(result.unknowns.some((item) => item.key === "decision_chain"));
    assert.deepEqual(result.sourceRefs, [{ type: "customer", id: "customer-1" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.writebackPreview.allowed, false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.source, "deterministic");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("clarifies multiple matches and never selects a fuzzy customer", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "search", query: "同名" });
    assert.equal(result.status, "clarify");
    assert.equal(result.customer, null);
    assert.equal(result.matches.length, 2);
    assert.ok(result.unknowns.some((item) => item.key === "ambiguity"));
    assert.equal(result.sourceRefs.length, 2);
  });

  it("creates a bounded change preview but cannot execute it", async () => {
    const adapter = createCustomerAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      customerId: "customer-1",
      changes: { region: "济南", level: "普通", owner: "forged-owner", unknownField: "x" },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["region", "level"]);
    assert.deepEqual(result.changePreview.before, { region: "青岛", level: "重点" });
    assert.deepEqual(result.changePreview.after, { region: "济南", level: "普通" });
    assert.deepEqual(result.changePreview.rejectedFields, ["owner", "unknownField"]);
    assert.equal(result.writebackPreview.requiresHumanConfirmation, true);
    assert.equal(result.writebackAllowed, false);
  });

  it("replays the same event without running the snapshot query twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "customer-run-replay" });
    let details = 0;
    const source = snapshotAdapter();
    const adapter = createCustomerAssistantAdapter({
      snapshotAdapter: {
        ...source,
        customerDetail(input) { details += 1; return source.customerDetail(input); },
      },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "conversation-replay", eventId: "event-replay", customerId: "customer-1" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(details, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
