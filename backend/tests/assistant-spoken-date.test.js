import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractSpokenOccurredAt,
  resolveSpokenDate,
  resolveSpokenRange,
  spokenDateToIso,
} from "../src/assistant/spokenDate.js";

// 2026-08-28 is a Friday in Asia/Shanghai (UTC+8).
const FRIDAY = new Date("2026-08-28T02:00:00.000Z");
// 2026-08-31 04:00 UTC is Monday 12:00 in Asia/Shanghai.
const MONDAY = new Date("2026-08-31T04:00:00.000Z");
// 2026-08-31 22:00 UTC is already Tuesday 06:00 in Asia/Shanghai.
const UTC_MONDAY_SHANGHAI_TUESDAY = new Date("2026-08-31T22:00:00.000Z");
// 2027-01-01 12:00 Shanghai is a Friday right after the year boundary.
const NEW_YEAR = new Date("2027-01-01T04:00:00.000Z");

describe("resolveSpokenDate", () => {
  it("resolves relative day words against the Shanghai business date", () => {
    assert.equal(resolveSpokenDate("今天", FRIDAY), "2026-08-28");
    assert.equal(resolveSpokenDate("昨天", FRIDAY), "2026-08-27");
    assert.equal(resolveSpokenDate("前天", FRIDAY), "2026-08-26");
    assert.equal(resolveSpokenDate("3天前", FRIDAY), "2026-08-25");
  });

  it("uses the Shanghai date even when UTC is still the previous day", () => {
    assert.equal(resolveSpokenDate("今天", UTC_MONDAY_SHANGHAI_TUESDAY), "2026-09-01");
    assert.equal(resolveSpokenDate("昨天", UTC_MONDAY_SHANGHAI_TUESDAY), "2026-08-31");
  });

  it("resolves weekday words with a Monday week start", () => {
    assert.equal(resolveSpokenDate("本周一", FRIDAY), "2026-08-24");
    assert.equal(resolveSpokenDate("这周三", FRIDAY), "2026-08-26");
    assert.equal(resolveSpokenDate("上周五", FRIDAY), "2026-08-21");
    assert.equal(resolveSpokenDate("上周日", FRIDAY), "2026-08-23");
    assert.equal(resolveSpokenDate("上周天", FRIDAY), "2026-08-23");
    assert.equal(resolveSpokenDate("上上周二", FRIDAY), "2026-08-11");
    // From a Monday, 上周 must reach into the previous calendar week.
    assert.equal(resolveSpokenDate("上周一", MONDAY), "2026-08-24");
  });

  it("resolves month-day words within the current Shanghai year", () => {
    assert.equal(resolveSpokenDate("8月20日", FRIDAY), "2026-08-20");
    assert.equal(resolveSpokenDate("8月20号", FRIDAY), "2026-08-20");
    assert.equal(resolveSpokenDate("12月3日", NEW_YEAR), "2027-12-03");
    assert.equal(resolveSpokenDate("2月30日", FRIDAY), null);
    assert.equal(resolveSpokenDate("13月1日", FRIDAY), null);
  });

  it("returns null for unrecognized words", () => {
    assert.equal(resolveSpokenDate("大后天", FRIDAY), null);
    assert.equal(resolveSpokenDate("", FRIDAY), null);
    assert.equal(resolveSpokenDate("上周", FRIDAY), null);
    assert.equal(resolveSpokenDate(null, FRIDAY), null);
  });
});

describe("resolveSpokenRange", () => {
  it("resolves week ranges across week and year boundaries", () => {
    assert.deepEqual(resolveSpokenRange("本周", FRIDAY), { start: "2026-08-24", end: "2026-08-30" });
    assert.deepEqual(resolveSpokenRange("这周", FRIDAY), { start: "2026-08-24", end: "2026-08-30" });
    assert.deepEqual(resolveSpokenRange("上周", FRIDAY), { start: "2026-08-17", end: "2026-08-23" });
    assert.deepEqual(resolveSpokenRange("上上周", FRIDAY), { start: "2026-08-10", end: "2026-08-16" });
    // 2027-01-01 is a Friday; its ISO week and the previous week cross the year boundary.
    assert.deepEqual(resolveSpokenRange("本周", NEW_YEAR), { start: "2026-12-28", end: "2027-01-03" });
    assert.deepEqual(resolveSpokenRange("上周", NEW_YEAR), { start: "2026-12-21", end: "2026-12-27" });
  });

  it("resolves month ranges including the year rollover", () => {
    assert.deepEqual(resolveSpokenRange("本月", FRIDAY), { start: "2026-08-01", end: "2026-08-31" });
    assert.deepEqual(resolveSpokenRange("上月", FRIDAY), { start: "2026-07-01", end: "2026-07-31" });
    assert.deepEqual(resolveSpokenRange("上个月", NEW_YEAR), { start: "2026-12-01", end: "2026-12-31" });
    assert.deepEqual(resolveSpokenRange("本月", NEW_YEAR), { start: "2027-01-01", end: "2027-01-31" });
  });

  it("resolves single days and the recent-14-days window", () => {
    assert.deepEqual(resolveSpokenRange("今天", FRIDAY), { start: "2026-08-28", end: "2026-08-28" });
    assert.deepEqual(resolveSpokenRange("前天", FRIDAY), { start: "2026-08-26", end: "2026-08-26" });
    assert.deepEqual(resolveSpokenRange("最近", FRIDAY), { start: "2026-08-15", end: "2026-08-28" });
    assert.deepEqual(resolveSpokenRange("上周三", FRIDAY), { start: "2026-08-19", end: "2026-08-19" });
  });

  it("returns null for unrecognized period words", () => {
    assert.equal(resolveSpokenRange("最近半年", FRIDAY), null);
    assert.equal(resolveSpokenRange("", FRIDAY), null);
  });
});

describe("spokenDateToIso and capture extraction", () => {
  it("anchors the occurred-at instant to noon Asia/Shanghai", () => {
    assert.equal(spokenDateToIso("2026-08-28"), "2026-08-28T04:00:00.000Z");
    assert.equal(spokenDateToIso("bad"), null);
  });

  it("extracts the first single-day expression from capture text", () => {
    assert.equal(
      extractSpokenOccurredAt("今天拜访了日照中医医院，谈了预算", FRIDAY),
      "2026-08-28T04:00:00.000Z",
    );
    assert.equal(
      extractSpokenOccurredAt("上周三去了莒县人民医院复查机房", FRIDAY),
      "2026-08-19T04:00:00.000Z",
    );
    assert.equal(
      extractSpokenOccurredAt("8月20日的电话会议确认了报价", FRIDAY),
      "2026-08-20T04:00:00.000Z",
    );
    assert.equal(extractSpokenOccurredAt("拜访了日照中医医院", FRIDAY), null);
    // A bare 上周 is a range, not a single day; capture must not guess.
    assert.equal(extractSpokenOccurredAt("上周的拜访很顺利", FRIDAY), null);
  });
});
