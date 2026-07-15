import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatWeekRangeLabel, getCurrentWeekRange } from "./weekRange.js";

describe("current week range", () => {
  it("uses Monday through Sunday for the active business week", () => {
    assert.deepEqual(getCurrentWeekRange(new Date("2026-06-06T10:30:00+08:00")), {
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
    });
  });

  it("keeps Sunday inside the week that started six days earlier", () => {
    assert.deepEqual(getCurrentWeekRange(new Date("2026-06-07T22:00:00+08:00")), {
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
    });
  });

  it("handles week ranges that cross a calendar year", () => {
    assert.deepEqual(getCurrentWeekRange(new Date("2025-12-31T09:00:00+08:00")), {
      periodStart: "2025-12-29",
      periodEnd: "2026-01-04",
    });
  });
});

describe("week range label", () => {
  it("formats a same-month week as a compact business label", () => {
    assert.equal(formatWeekRangeLabel({ periodStart: "2026-06-01", periodEnd: "2026-06-07" }), "06.01-06.07");
  });

  it("keeps the year visible when the week crosses into another year", () => {
    assert.equal(formatWeekRangeLabel({ periodStart: "2025-12-29", periodEnd: "2026-01-04" }), "2025.12.29-2026.01.04");
  });
});
