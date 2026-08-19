import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createItineraryAssistantAdapter } from "../src/assistant/itineraryAssistantAdapter.js";

function snapshotAdapter() {
  return {
    itinerarySummary({ owner }) {
      return owner === "owner-1"
        ? { items: [{ id: "itinerary-1", title: "拜访示例医院", visitDate: "2026-08-22", status: "planned", createdAt: "2026-08-20T01:00:00Z", updatedAt: "2026-08-20T01:00:00Z" }], truncated: false }
        : { items: [], truncated: false };
    },
  };
}

describe("itinerary assistant adapter", () => {
  it("returns owner-scoped itinerary facts and a durable itinerary-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "itinerary-run-1" });
    const adapter = createItineraryAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({ owner: "owner-1", channel: "desktop", conversationId: "c", eventId: "e", taskType: "summary" });
    assert.equal(result.schemaVersion, "itinerary-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.items[0].title, "拜访示例医院");
    assert.ok(result.facts.some((item) => item.key === "itinerary-1.visitDate"));
    assert.deepEqual(result.sourceRefs, [{ type: "itinerary", id: "itinerary-1" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(runs.get(result.runId, { owner: "owner-1" }).item.contractVersion, "itinerary-v1");
    db.close();
  });

  it("keeps planning and optimization as empty previews without inventing route facts", async () => {
    const adapter = createItineraryAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({ owner: "owner-1", taskType: "optimize_order" });
    assert.equal(result.planPreview.recommendation, null);
    assert.deepEqual(result.planPreview.items, []);
    assert.equal(result.inferences.length, 0);
  });

  it("previews only title/date changes and never writes status or version", async () => {
    const adapter = createItineraryAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "change_preview",
      itineraryId: "itinerary-1",
      changes: { title: "改名行程", visitDate: "2026-08-23", status: "done", version: 2 },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["title", "visitDate"]);
    assert.deepEqual(result.changePreview.rejectedFields, ["status", "version"]);
    assert.equal(result.changePreview.expectedVersion, null);
    assert.equal(result.writebackPreview.allowed, false);
  });

  it("replays the same summary without querying itineraries twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "itinerary-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createItineraryAssistantAdapter({
      snapshotAdapter: { itinerarySummary(input) { calls += 1; return source.itinerarySummary(input); } },
      runRepository: runs,
    });
    const input = { owner: "owner-1", channel: "desktop", conversationId: "replay", eventId: "replay", taskType: "summary" };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
