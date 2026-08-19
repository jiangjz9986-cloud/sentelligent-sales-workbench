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
  it("returns owner-scoped advance facts while keeping settlement direction blocked", async () => {
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
    assert.equal(result.lifecycle, "draft");
    assert.equal(result.status, "review_required");
    assert.equal(result.advances.length, 2);
    assert.equal(result.advances[0].requestedCents, 100000);
    assert.equal(result.advances[0].receivedCents, 80000);
    assert.equal(result.advances[0].owner, undefined);
    assert.equal(result.settlementPreview, null);
    assert.equal(result.writebackAllowed, false);
    assert.equal(result.writebackPreview.allowed, false);
    assert.ok(result.unknowns.some((item) => item.key === "settlement_direction"));
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
    assert.equal(result.truncated, true);
    assert.equal(result.advances[0].status, null);
    assert.equal(result.advances[0].requestedCents, null);
    assert.equal(result.advances[0].notes, null);
    assert.ok(result.unknowns.some((item) => item.key === "truncated"));
    assert.deepEqual(source.calls, [{ owner: "owner-1", weekStart: "2026-08-17" }]);
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
    assert.deepEqual(source.calls, []);
  });
});
