import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { joinDatetimeLocal, splitDatetimeLocal } from "../src/features/salesWorkbench/datetimeLocal.js";
import { resetInputCapabilityCacheForTests, supportsInputType } from "../src/app/inputCapabilities.js";

describe("input capabilities", () => {
  it("exports supportsInputType for week and datetime-local probes", () => {
    const source = readFileSync(resolve("src/app/inputCapabilities.js"), "utf8");
    assert.match(source, /export function supportsInputType\(type\)/);
    assert.match(source, /validity\.typeMismatch/);
  });

  it("defaults to supported types when document is unavailable", () => {
    assert.equal(supportsInputType("week"), true);
    assert.equal(supportsInputType("datetime-local"), true);
  });
});

describe("datetime local split helpers", () => {
  it("splits and joins datetime-local control values", () => {
    assert.deepEqual(splitDatetimeLocal("2026-09-01T09:05"), { date: "2026-09-01", time: "09:05" });
    assert.equal(joinDatetimeLocal("2026-09-01", "09:05"), "2026-09-01T09:05");
    assert.equal(joinDatetimeLocal("", ""), "");
  });

  it("keeps empty halves stable for partial edits", () => {
    assert.deepEqual(splitDatetimeLocal(""), { date: "", time: "" });
    assert.equal(joinDatetimeLocal("2026-09-01", ""), "2026-09-01T00:00");
  });
});

describe("travel week fallback", () => {
  it("renders the fallback test id and week label", () => {
    const source = readFileSync(resolve("src/features/travelExpense/IsoWeekFallback.jsx"), "utf8");
    assert.match(source, /data-testid="travel-week-fallback"/);
    assert.match(source, /第 \{weekNumber\} 周/);
  });

  it("switches travel expense week input based on capability detection", () => {
    const page = readFileSync(resolve("src/features/travelExpense/TravelExpensePage.jsx"), "utf8");
    assert.match(page, /supportsInputType\("week"\)/);
    assert.match(page, /<IsoWeekFallback value=\{week\.start\} onChange=\{setWeek\} \/>/);
  });
});

resetInputCapabilityCacheForTests();
