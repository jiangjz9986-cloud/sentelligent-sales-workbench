import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSaveRegionProfileForWeek,
  selectCrossWeekLedgerReceipts,
} from "./travelExpensePageState.js";

describe("travel expense page week-scoped state", () => {
  it("keeps multiple different-week receipts and never presents this week's receipt as cross-week", () => {
    const receipts = [
      { expenseId: "EXP-CURRENT", occurredOn: "2026-08-26", weekStart: "2026-08-24" },
      { expenseId: "EXP-CURRENT-MISMATCH", occurredOn: "2026-08-27", weekStart: "2026-08-17" },
      { expenseId: "EXP-OLD-1", occurredOn: "2026-08-19", weekStart: "2026-08-17" },
      { expenseId: "EXP-OLD-2", occurredOn: "2026-08-11", weekStart: "2026-08-10" },
      { expenseId: "EXP-OLD-1", occurredOn: "2026-08-19", weekStart: "2026-08-17" },
      { expenseId: "", occurredOn: "2026-08-04", weekStart: "2026-08-03" },
    ];

    assert.deepEqual(
      selectCrossWeekLedgerReceipts(receipts, "2026-08-24").map((receipt) => receipt.expenseId),
      ["EXP-OLD-1", "EXP-OLD-2"],
    );
  });

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
