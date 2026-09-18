import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSaveRegionProfileForWeek,
  defaultExpenseOccurredOn,
} from "./travelExpensePageState.js";

describe("travel expense page week-scoped state", () => {
  it("blocks an old-week region draft before and during a new-week load", () => {
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: "2026-08-17",
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-17",
    }), false);
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: null,
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-24",
    }), false);
    assert.equal(canSaveRegionProfileForWeek({
      loadedWeekStart: "2026-08-24",
      selectedWeekStart: "2026-08-24",
      draftWeekStart: "2026-08-24",
    }), true);
  });

  it("uses the selected ledger day for a new manual expense within the week", () => {
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      selectedDate: "2026-09-15",
      today: new Date("2026-09-15T09:00:00+08:00"),
    }), "2026-09-15");
  });

  it("uses local today when no ledger day is selected and falls back to Monday outside the week", () => {
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      today: new Date("2026-09-16T09:00:00+08:00"),
    }), "2026-09-16");
    assert.equal(defaultExpenseOccurredOn({
      weekStart: "2026-09-14",
      weekEnd: "2026-09-20",
      today: new Date("2026-09-28T09:00:00+08:00"),
    }), "2026-09-14");
  });
});
