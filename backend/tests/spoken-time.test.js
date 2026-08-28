import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractSpokenInstant, parseSpokenInstant } from "../src/assistant/spokenTime.js";

// 2026-08-28 is a Friday; 10:00 Asia/Shanghai = 02:00 UTC.
const FRIDAY_MORNING = new Date("2026-08-28T02:00:00.000Z");
const FRIDAY_NIGHT = new Date("2026-08-28T13:30:00.000Z"); // 21:30 Shanghai

function isoOf(date, hh, mm = 0) {
  return new Date(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`).toISOString();
}

describe("parseSpokenInstant dates", () => {
  it("resolves relative day words to future dates with the 09:00 default", () => {
    for (const [word, date] of [
      ["明天", "2026-08-29"],
      ["后天", "2026-08-30"],
      ["大后天", "2026-08-31"],
      ["今天", "2026-08-28"],
    ]) {
      const parsed = parseSpokenInstant(word, FRIDAY_MORNING);
      assert.equal(parsed.matched, true, word);
      assert.equal(parsed.iso, isoOf(date, 9), word);
      assert.equal(parsed.hasTime, false, word);
    }
  });

  it("keeps the same weekday today before evening and rolls a week after 20:00", () => {
    assert.equal(parseSpokenInstant("周五", FRIDAY_MORNING).iso, isoOf("2026-08-28", 9));
    assert.equal(parseSpokenInstant("周五", FRIDAY_NIGHT).iso, isoOf("2026-09-04", 9));
    assert.equal(parseSpokenInstant("周一", FRIDAY_MORNING).iso, isoOf("2026-08-31", 9));
    assert.equal(parseSpokenInstant("下周一", FRIDAY_MORNING).iso, isoOf("2026-08-31", 9));
    assert.equal(parseSpokenInstant("下周五", FRIDAY_MORNING).iso, isoOf("2026-09-04", 9));
    assert.equal(parseSpokenInstant("本周日", FRIDAY_MORNING).iso, isoOf("2026-08-30", 9));
  });

  it("resolves calendar words across month and year boundaries", () => {
    assert.equal(parseSpokenInstant("9月2日", FRIDAY_MORNING).iso, isoOf("2026-09-02", 9));
    assert.equal(parseSpokenInstant("月底", FRIDAY_MORNING).iso, isoOf("2026-08-31", 9));
    assert.equal(parseSpokenInstant("3天后", FRIDAY_MORNING).iso, isoOf("2026-08-31", 9));
    // Bare 号 in the past rolls to next month.
    assert.equal(parseSpokenInstant("5号", FRIDAY_MORNING).iso, isoOf("2026-09-05", 9));
    assert.equal(parseSpokenInstant("30号", FRIDAY_MORNING).iso, isoOf("2026-08-30", 9));
  });
});

describe("parseSpokenInstant clocks", () => {
  it("parses Chinese and numeric clock forms", () => {
    assert.equal(parseSpokenInstant("明天上午十点", FRIDAY_MORNING).iso, isoOf("2026-08-29", 10));
    assert.equal(parseSpokenInstant("明天下午3点半", FRIDAY_MORNING).iso, isoOf("2026-08-29", 15, 30));
    assert.equal(parseSpokenInstant("明天14:30", FRIDAY_MORNING).iso, isoOf("2026-08-29", 14, 30));
    assert.equal(parseSpokenInstant("明天中午", FRIDAY_MORNING).iso, isoOf("2026-08-29", 12));
    assert.equal(parseSpokenInstant("明天晚上八点", FRIDAY_MORNING).iso, isoOf("2026-08-29", 20));
    assert.equal(parseSpokenInstant("周一十点一刻", FRIDAY_MORNING).iso, isoOf("2026-08-31", 10, 15));
    const withTime = parseSpokenInstant("明天上午十点", FRIDAY_MORNING);
    assert.equal(withTime.hasTime, true);
  });

  it("gives composite evening/morning words their built-in defaults", () => {
    assert.equal(parseSpokenInstant("今晚", FRIDAY_MORNING).iso, isoOf("2026-08-28", 20));
    assert.equal(parseSpokenInstant("明早", FRIDAY_MORNING).iso, isoOf("2026-08-29", 9));
    assert.equal(parseSpokenInstant("明晚", FRIDAY_MORNING).iso, isoOf("2026-08-29", 20));
  });

  it("maps a bare clock to today when ahead and tomorrow when passed", () => {
    assert.equal(parseSpokenInstant("下午三点", FRIDAY_MORNING).iso, isoOf("2026-08-28", 15));
    assert.equal(parseSpokenInstant("上午九点", FRIDAY_MORNING).iso, isoOf("2026-08-29", 9));
  });
});

describe("deadline and extraction", () => {
  it("marks 前/内 phrases as deadlines", () => {
    const deadline = parseSpokenInstant("周五前", FRIDAY_MORNING);
    assert.equal(deadline.deadline, true);
    assert.equal(deadline.iso, isoOf("2026-08-28", 9));
    const within = parseSpokenInstant("三天内", FRIDAY_MORNING);
    assert.equal(within.matched, false); // Chinese numerals not used for 天内 counts.
    const withinDigits = parseSpokenInstant("3天内", FRIDAY_MORNING);
    assert.equal(withinDigits.deadline, true);
    assert.equal(withinDigits.iso, isoOf("2026-08-31", 9));
  });

  it("excises the matched phrase for title extraction", () => {
    const { instant, remainder } = extractSpokenInstant("周五前给王工送方案", FRIDAY_MORNING);
    assert.equal(instant.deadline, true);
    assert.equal(remainder, "给王工送方案");
    const none = extractSpokenInstant("给王工送方案", FRIDAY_MORNING);
    assert.equal(none.instant, null);
    assert.equal(none.remainder, "给王工送方案");
  });

  it("only joins a clock that directly follows the date word", () => {
    const parsed = parseSpokenInstant("明天提交，会议在下午三点开始", FRIDAY_MORNING);
    assert.equal(parsed.iso, isoOf("2026-08-29", 9));
    assert.equal(parsed.token, "明天");
  });

  it("rejects nonsense and invalid calendar values", () => {
    assert.equal(parseSpokenInstant("尽快处理", FRIDAY_MORNING).matched, false);
    assert.equal(parseSpokenInstant("2月30日", FRIDAY_MORNING).matched, false);
    assert.equal(parseSpokenInstant("", FRIDAY_MORNING).matched, false);
  });
});
