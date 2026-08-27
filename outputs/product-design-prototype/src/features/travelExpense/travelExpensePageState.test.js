import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canSaveRegionProfileForWeek } from "./travelExpensePageState.js";

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
});
