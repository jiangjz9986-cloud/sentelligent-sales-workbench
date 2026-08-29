import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getCurrentWeekRange } from "../../weekRange.js";
import {
  formatRecordTime,
  groupRecordsByWeekday,
  weeklyRecordStatusView,
} from "./weeklyDaily.js";

const weekRange = { periodStart: "2026-08-24", periodEnd: "2026-08-30" }; // 周一到周日

function isoAtLocal(dateText, hour = 10, minute = 0) {
  return new Date(`${dateText}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`).toISOString();
}

describe("weekly daily record grouping", () => {
  it("returns exactly seven weekday buckets including empty days", () => {
    const days = groupRecordsByWeekday([], weekRange);
    assert.equal(days.length, 7);
    assert.deepEqual(days.map((day) => day.weekday), ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
    assert.deepEqual(days.map((day) => day.records.length), [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(days[0].dateKey, "2026-08-24");
    assert.equal(days[6].dateKey, "2026-08-30");
    assert.equal(days[0].dateLabel, "8月24日");
  });

  it("buckets records into their weekday and excludes records outside the week", () => {
    const days = groupRecordsByWeekday([
      { id: "mon", occurredAt: isoAtLocal("2026-08-24", 9) },
      { id: "wed-late", occurredAt: isoAtLocal("2026-08-26", 18) },
      { id: "wed-early", occurredAt: isoAtLocal("2026-08-26", 8) },
      { id: "sun", occurredAt: isoAtLocal("2026-08-30", 23, 30) },
      { id: "prev-week", occurredAt: isoAtLocal("2026-08-23", 12) },
      { id: "next-week", occurredAt: isoAtLocal("2026-08-31", 0) },
    ], weekRange);

    assert.deepEqual(days[0].records.map((record) => record.id), ["mon"]);
    assert.deepEqual(days[2].records.map((record) => record.id), ["wed-early", "wed-late"], "records sort by time inside a day");
    assert.deepEqual(days[6].records.map((record) => record.id), ["sun"]);
    const bucketed = days.flatMap((day) => day.records.map((record) => record.id));
    assert.equal(bucketed.includes("prev-week"), false);
    assert.equal(bucketed.includes("next-week"), false);
  });

  it("falls back to createdAt when occurredAt is missing and skips unparseable records", () => {
    const days = groupRecordsByWeekday([
      { id: "created-only", createdAt: isoAtLocal("2026-08-25", 14) },
      { id: "broken", occurredAt: "not-a-date" },
      { id: "empty" },
    ], weekRange);
    assert.deepEqual(days[1].records.map((record) => record.id), ["created-only"]);
    assert.equal(days.flatMap((day) => day.records).length, 1);
  });

  it("accepts the live getCurrentWeekRange shape", () => {
    const range = getCurrentWeekRange(new Date(2026, 7, 26));
    const days = groupRecordsByWeekday([
      { id: "in-week", occurredAt: new Date(2026, 7, 26, 10, 0).toISOString() },
    ], range);
    assert.equal(days.length, 7);
    assert.equal(days.flatMap((day) => day.records).length, 1);
  });

  it("maps record status to the quick-record history vocabulary", () => {
    assert.deepEqual(weeklyRecordStatusView({ status: "confirmed" }), { status: "已确认", tone: "green" });
    assert.deepEqual(weeklyRecordStatusView({ status: "analyzed" }), { status: "待同步", tone: "amber" });
    assert.deepEqual(weeklyRecordStatusView({ status: "captured" }), { status: "已记录", tone: "blue" });
    assert.deepEqual(weeklyRecordStatusView(null), { status: "已记录", tone: "blue" });
  });

  it("formats record time defensively", () => {
    assert.match(formatRecordTime({ occurredAt: isoAtLocal("2026-08-24", 9, 5) }), /09:05/);
    assert.equal(formatRecordTime({}), "时间待确认");
  });
});
