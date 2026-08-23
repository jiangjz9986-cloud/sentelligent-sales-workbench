import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { createAssistantAgentRunRepository } from "../src/assistant/agentRunRepository.js";

function clockFactory() {
  let value = new Date("2026-08-20T00:00:00.000Z");
  return {
    now: () => new Date(value),
    advance(ms) { value = new Date(value.getTime() + ms); },
  };
}

function runInput(overrides = {}) {
  return {
    owner: "owner-1",
    channel: "desktop",
    conversationId: "conversation-1",
    eventId: "event-1",
    agentId: "sales-decision",
    agentVersion: "1.0.0",
    taskType: "opportunity_diagnosis",
    contractVersion: "sales-decision-v1",
    input: {
      opportunity: { id: "opp-1", stage: "lead" },
      asOf: "2026-08-20T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("assistant agent run repository", () => {
  it("persists a bounded run and completes it with hashes and source refs", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const clock = clockFactory();
    const repository = createAssistantAgentRunRepository(db, { clock: clock.now, idFactory: () => "run-1" });

    const created = repository.create(runInput());
    assert.equal(created.replayed, false);
    assert.equal(created.item.status, "running");
    assert.equal(created.item.agentId, "sales-decision");
    assert.match(created.item.inputSnapshotHash, /^[0-9a-f]{64}$/);
    assert.equal(created.item.outputSnapshotHash, null);

    const completed = repository.complete(created.item.id, {
      owner: "owner-1",
      output: {
        schemaVersion: "sales-decision-v1",
        status: "preview",
        facts: [{ sourceRefs: [{ type: "opportunity", id: "opp-1" }] }],
      },
      source: "fallback",
      fallbackReason: "model_timeout",
      sourceRefs: [{ type: "opportunity", id: "opp-1" }],
      confirmationStatus: "preview",
    });
    assert.equal(completed.replayed, false);
    assert.equal(completed.item.status, "fallback");
    assert.match(completed.item.outputSnapshotHash, /^[0-9a-f]{64}$/);
    assert.equal(completed.item.fallbackReason, "model_timeout");
    assert.deepEqual(completed.item.sourceRefs, [{ type: "opportunity", id: "opp-1" }]);
    assert.equal(repository.get(created.item.id, { owner: "owner-1" }).item.status, "fallback");
    db.close();
  });

  it("deduplicates the same event and rejects a changed payload", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const repository = createAssistantAgentRunRepository(db, {
      idFactory: (() => {
        let count = 0;
        return () => "run-" + (++count);
      })(),
    });

    const first = repository.create(runInput());
    const replay = repository.create(runInput());
    assert.equal(replay.replayed, true);
    assert.equal(replay.item.id, first.item.id);

    assert.throws(
      () => repository.create(runInput({ input: { opportunity: { id: "opp-2" } } })),
      /conflict|event/i,
    );
    db.close();
  });

  it("finds the latest run by hashed conversation scope without exposing the external id", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const repository = createAssistantAgentRunRepository(db, {
      idFactory: (() => {
        let count = 0;
        return () => `run-${++count}`;
      })(),
    });
    repository.create(runInput({ eventId: "event-old", taskType: "opportunity_diagnosis" }));
    repository.complete("run-1", {
      owner: "owner-1",
      output: { status: "preview" },
      source: "mock",
      confirmationStatus: "preview",
    });
    repository.create(runInput({ eventId: "event-new", input: { opportunity: { id: "opp-2" } } }));

    const latest = repository.getLatest({
      owner: "owner-1",
      channel: "desktop",
      conversationId: "conversation-1",
      agentId: "sales-decision",
      taskType: "opportunity_diagnosis",
    });
    assert.equal(latest.item.id, "run-2");
    assert.equal(latest.item.input.opportunity.id, "opp-2");
    assert.equal(latest.item.conversationIdHash.length, 64);
    assert.equal(JSON.stringify(latest.item).includes("conversation-1"), false);
    assert.equal(repository.getLatest({
      owner: "other-owner",
      channel: "desktop",
      conversationId: "conversation-1",
      agentId: "sales-decision",
      taskType: "opportunity_diagnosis",
    }), null);
    db.close();
  });

  it("enforces owner scope and durable failure state", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const repository = createAssistantAgentRunRepository(db, { idFactory: () => "run-1" });
    const created = repository.create(runInput());

    assert.equal(repository.get(created.item.id, { owner: "other-owner" }), null);
    assert.throws(
      () => repository.complete(created.item.id, {
        owner: "other-owner",
        output: { status: "preview" },
      }),
      /owner|not found|scope/i,
    );
    const failed = repository.fail(created.item.id, {
      owner: "owner-1",
      errorCode: "MODEL_INVALID_OUTPUT",
    });
    assert.equal(failed.item.status, "failed");
    assert.equal(failed.item.errorCode, "MODEL_INVALID_OUTPUT");
    assert.equal(repository.list({ owner: "owner-1" }).length, 1);
    db.close();
  });

  it("does not store sensitive manifest input keys", () => {
    const db = openDatabase({ databaseUrl: ":memory:" });
    const repository = createAssistantAgentRunRepository(db);
    assert.throws(
      () => repository.create(runInput({
        input: { opportunity: { id: "opp-1" }, apiKey: "secret" },
      })),
      /sensitive|secret|forbidden/i,
    );
    db.close();
  });
});
