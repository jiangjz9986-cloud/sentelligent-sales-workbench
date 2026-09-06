import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { datetimeLocalFromIso, isoFromDatetimeLocal, joinDatetimeLocal, splitDatetimeLocal } from "./datetimeLocal.js";

describe("remind-at datetime-local conversion", () => {
  it("round-trips an ISO instant through the local control value", () => {
    const iso = "2026-09-01T02:30:00.000Z";
    const local = datetimeLocalFromIso(iso);
    assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(isoFromDatetimeLocal(local), new Date(iso).toISOString());
  });

  it("renders the control value in the local timezone", () => {
    const now = new Date(2026, 8, 1, 9, 5);
    const local = datetimeLocalFromIso(now.toISOString());
    assert.equal(local, "2026-09-01T09:05");
  });

  it("returns an empty control value for null, empty, or invalid input", () => {
    assert.equal(datetimeLocalFromIso(null), "");
    assert.equal(datetimeLocalFromIso(""), "");
    assert.equal(datetimeLocalFromIso("not-a-date"), "");
  });

  it("maps an empty or blank control value to null so saving clears the reminder", () => {
    assert.equal(isoFromDatetimeLocal(""), null);
    assert.equal(isoFromDatetimeLocal("   "), null);
    assert.equal(isoFromDatetimeLocal(null), null);
    assert.equal(isoFromDatetimeLocal(undefined), null);
  });

  it("maps an invalid control value to null instead of throwing", () => {
    assert.equal(isoFromDatetimeLocal("9999-99-99T99:99"), null);
    assert.equal(isoFromDatetimeLocal("随手输入"), null);
  });

  it("splits and joins datetime-local values for fallback inputs", () => {
    assert.deepEqual(splitDatetimeLocal("2026-09-01T09:05"), { date: "2026-09-01", time: "09:05" });
    assert.equal(joinDatetimeLocal("2026-09-01", "09:05"), "2026-09-01T09:05");
  });
});
