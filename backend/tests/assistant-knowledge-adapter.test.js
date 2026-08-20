import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";
import { createKnowledgeAssistantAdapter } from "../src/assistant/knowledgeAssistantAdapter.js";

function snapshotAdapter() {
  return {
    knowledgeSearch({ query }) {
      if (query.includes("采购")) return {
        items: [{ id: "knowledge-1", title: "医院采购流程", category: "销售", summary: "采购阶段摘要", source: "内部知识库", updatedAt: "2026-08-20T01:00:00Z" }],
      };
      return { items: [] };
    },
  };
}

describe("knowledge assistant adapter", () => {
  it("returns bounded source-backed knowledge facts and a durable knowledge-v1 run", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "knowledge-run-1" });
    const adapter = createKnowledgeAssistantAdapter({ snapshotAdapter: snapshotAdapter(), runRepository: runs });
    const result = await adapter.analyze({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      eventId: "event-1",
      taskType: "search",
      query: "医院采购",
    });
    assert.equal(result.schemaVersion, "knowledge-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.items[0].title, "医院采购流程");
    assert.ok(result.facts.some((item) => item.key === "knowledge-1.summary"));
    assert.deepEqual(result.sourceRefs, [{ type: "knowledge", id: "knowledge-1" }]);
    assert.equal(result.writebackAllowed, false);
    assert.equal(JSON.stringify(result).includes("完整正文"), false);
    const stored = runs.get(result.runId, { owner: "owner-1" }).item;
    assert.equal(stored.contractVersion, "knowledge-v1");
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.input.owner, undefined);
    db.close();
  });

  it("does not invent an answer or comparison conclusion without a model/source contract", async () => {
    const adapter = createKnowledgeAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const answer = await adapter.analyze({ owner: "owner-1", taskType: "answer_with_sources", query: "采购" });
    const compare = await adapter.analyze({ owner: "owner-1", taskType: "compare", query: "采购" });
    assert.equal(answer.answer.text, null);
    assert.equal(answer.answer.requiresHumanReview, true);
    assert.equal(compare.comparison.conclusion, null);
    assert.equal(compare.inferences.length, 0);
  });

  it("previews knowledge maintenance without writing and rejects an unapproved field", async () => {
    const adapter = createKnowledgeAssistantAdapter({ snapshotAdapter: snapshotAdapter() });
    const result = await adapter.analyze({
      owner: "owner-1",
      taskType: "maintenance_preview",
      query: "采购",
      knowledgeId: "knowledge-1",
      changes: { summary: "更新后的摘要", content: "不应写入正文", owner: "forged-owner" },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.changePreview.changedFields, ["summary"]);
    assert.deepEqual(result.changePreview.rejectedFields, ["content", "owner"]);
    assert.equal(result.changePreview.expectedVersion, null);
    assert.equal(result.writebackPreview.allowed, false);
  });

  it("replays the same search without querying the shared catalog twice", async () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const runs = createAssistantAgentRunRepository(db, { idFactory: () => "knowledge-run-replay" });
    const source = snapshotAdapter();
    let calls = 0;
    const adapter = createKnowledgeAssistantAdapter({
      snapshotAdapter: {
        knowledgeSearch(input) { calls += 1; return source.knowledgeSearch(input); },
      },
      runRepository: runs,
    });
    const input = {
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-replay",
      eventId: "event-replay",
      taskType: "search",
      query: "采购",
    };
    const first = await adapter.analyze(input);
    const replay = await adapter.analyze(input);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    db.close();
  });
});
