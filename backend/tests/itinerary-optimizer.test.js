import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildVisitSchedule,
  optimizeVisitOrder,
} from "../src/itinerary/optimizer.js";

describe("deterministic visit itinerary optimizer", () => {
  it("honors fixed appointment times before minimizing drive time", () => {
    const plan = optimizeVisitOrder({
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [
        { id: "normal", priority: "normal", visitMinutes: 60 },
        { id: "appointed", priority: "high", visitMinutes: 45, appointmentAt: "2026-07-28T01:00:00.000Z" },
      ],
      durationMatrix: [
        [0, 1800, 1200],
        [1800, 0, 2400],
        [1200, 2400, 0],
      ],
    });

    assert.deepEqual(plan.orderedStopIds, ["appointed", "normal"]);
    assert.equal(plan.totals.lateMinutes, 0);
    assert.equal(plan.schedule[0].waitMinutes, 40);
    assert.equal(plan.schedule[0].serviceStartAt, "2026-07-28T01:00:00.000Z");
  });

  it("uses priority before distance and keeps the input order for exact ties", () => {
    const prioritized = optimizeVisitOrder({
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [
        { id: "nearby", priority: "normal", visitMinutes: 30 },
        { id: "important", priority: "high", visitMinutes: 30 },
      ],
      durationMatrix: [
        [0, 300, 900],
        [300, 0, 300],
        [900, 300, 0],
      ],
    });
    assert.deepEqual(prioritized.orderedStopIds, ["important", "nearby"]);

    const tied = optimizeVisitOrder({
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [
        { id: "first", priority: "normal", visitMinutes: 30 },
        { id: "second", priority: "normal", visitMinutes: 30 },
      ],
      durationMatrix: [
        [0, 600, 600],
        [600, 0, 600],
        [600, 600, 0],
      ],
    });
    assert.deepEqual(tied.orderedStopIds, ["first", "second"]);
  });

  it("builds arrival, wait, late, and departure times for an explicit order", () => {
    const plan = buildVisitSchedule({
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [
        { id: "first", priority: "normal", visitMinutes: 30, appointmentAt: "2026-07-28T00:20:00.000Z" },
        { id: "second", priority: "normal", visitMinutes: 45, appointmentAt: "2026-07-28T01:00:00.000Z" },
      ],
      durationMatrix: [
        [0, 600, 300],
        [600, 0, 1800],
        [300, 1800, 0],
      ],
      orderedStopIds: ["first", "second"],
    });

    assert.deepEqual(plan.schedule, [
      {
        stopId: "first",
        sequence: 1,
        driveSeconds: 600,
        arrivalAt: "2026-07-28T00:10:00.000Z",
        serviceStartAt: "2026-07-28T00:20:00.000Z",
        departureAt: "2026-07-28T00:50:00.000Z",
        waitMinutes: 10,
        lateMinutes: 0,
      },
      {
        stopId: "second",
        sequence: 2,
        driveSeconds: 1800,
        arrivalAt: "2026-07-28T01:20:00.000Z",
        serviceStartAt: "2026-07-28T01:20:00.000Z",
        departureAt: "2026-07-28T02:05:00.000Z",
        waitMinutes: 0,
        lateMinutes: 20,
      },
    ]);
    assert.deepEqual(plan.totals, {
      driveSeconds: 2400,
      visitMinutes: 75,
      waitMinutes: 10,
      lateMinutes: 20,
      endAt: "2026-07-28T02:05:00.000Z",
    });
  });

  it("rejects duplicate stops, invalid matrices, invalid orderings, and more than eight visits", () => {
    const base = {
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [{ id: "a", priority: "normal", visitMinutes: 30 }],
      durationMatrix: [[0, 600], [600, 0]],
    };

    assert.throws(
      () => optimizeVisitOrder({ ...base, stops: [...base.stops, ...base.stops], durationMatrix: [[0, 1, 1], [1, 0, 1], [1, 1, 0]] }),
      /unique/,
    );
    assert.throws(() => optimizeVisitOrder({ ...base, durationMatrix: [[0]] }), /dimension/);
    assert.throws(
      () => optimizeVisitOrder({
        ...base,
        stops: Array.from({ length: 9 }, (_, index) => ({ id: `stop-${index}`, priority: "normal", visitMinutes: 30 })),
        durationMatrix: Array.from({ length: 10 }, () => Array(10).fill(0)),
      }),
      /at most 8/,
    );
    assert.throws(() => buildVisitSchedule({ ...base, orderedStopIds: ["unknown"] }), /complete permutation/);
  });
});
