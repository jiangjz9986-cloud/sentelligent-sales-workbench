import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { customerMetadataItems, formatCustomerTimestamp } from "./customerRecordMetadata.js";

const timestampCases = [
  ["2026-09-06 00:15:30", "2026-09-06 08:15"],
  ["2026-09-06 16:00:00", "2026-09-07 00:00"],
  ["2026-12-31 23:59:59.999", "2027-01-01 07:59"],
  [" 2026-09-06 00:15:30 ", "2026-09-06 08:15"],
  ["2026-09-06T00:15:30.123Z", "2026-09-06 08:15"],
  ["2026-09-06T08:15:30+08:00", "2026-09-06 08:15"],
  ["2026-09-05T17:15:30-07:00", "2026-09-06 08:15"],
  ["2026-09-06T05:45:30+0530", "2026-09-06 08:15"],
  ["2026-09-05T20:45:30-03:30", "2026-09-06 08:15"],
  ["2026-09-06T08:15+08:00", "2026-09-06 08:15"],
  ["2026-09-06t00:15:30z", "2026-09-06 08:15"],
  ["2024-02-29 16:05:00", "2024-03-01 00:05"],
  ["2000-02-29T00:00:00Z", "2000-02-29 08:00"],
  ["2026-03-08T01:30:00-08:00", "2026-03-08 17:30"],
  ["2026-03-08T03:30:00-07:00", "2026-03-08 18:30"],
];

const invalidTimestamps = [
  null, undefined, "", " \n\t ", 0, 1788653730000, false, {}, [], new Date(),
  "not-a-date", "2026-09-06", "09/06/2026 00:15:30", "2026-09-06T00:15:30",
  "2026-02-29 00:00:00", "1900-02-29T00:00:00Z", "2026-02-30T08:00:00+08:00",
  "2026-04-31T23:00:00-07:00", "2026-00-01 00:00:00", "2026-13-01 00:00:00",
  "2026-09-00 00:00:00", "2026-09-06 24:00:00", "2026-09-06T24:00:00Z",
  "2026-09-06 00:60:00", "2026-09-06 00:00:60", "2026-09-06T00:00:00+24:00",
  "2026-09-06T00:00:00+08:60", "2026-09-06T00:00:00+08", "x".repeat(2048),
];

describe("customer metadata timestamps", () => {
  it("formats SQLite UTC and explicit ISO offsets as Shanghai business time", () => {
    for (const [value, expected] of timestampCases) {
      assert.equal(formatCustomerTimestamp(value), expected, value);
    }
  });

  it("returns a bounded fallback for missing, malformed, ambiguous, and impossible dates", () => {
    for (const value of invalidTimestamps) {
      assert.equal(formatCustomerTimestamp(value), "未记录", String(value));
    }
  });

  it("does not coerce unexpected objects", () => {
    const unexpected = { toString() { throw new Error("must not coerce metadata"); } };
    assert.equal(formatCustomerTimestamp(unexpected), "未记录");
  });

  for (const timezone of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Asia/Kolkata"]) {
    it(`keeps the same output in a fresh process with TZ=${timezone}`, () => {
      const input = [...timestampCases.map(([value]) => value), ...invalidTimestamps.filter((value) => typeof value === "string")];
      const expected = [...timestampCases.map(([, value]) => value), ...invalidTimestamps.filter((value) => typeof value === "string").map(() => "未记录")];
      const moduleUrl = new URL("./customerRecordMetadata.js", import.meta.url).href;
      const script = `import { formatCustomerTimestamp } from ${JSON.stringify(moduleUrl)};
        process.stdout.write(JSON.stringify(${JSON.stringify(input)}.map(formatCustomerTimestamp)));`;
      const actual = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: { ...process.env, TZ: timezone },
        encoding: "utf8",
      });
      assert.deepEqual(JSON.parse(actual), expected);
    });
  }
});

describe("read-only customer metadata lists", () => {
  it("keeps ordered nonblank text, without duplicate React keys or mutating the record", () => {
    const items = Object.freeze([" alias ", null, "", "  ", 1, false, {}, "alias", "tag"]);
    assert.deepEqual(customerMetadataItems(items), ["alias", "tag"]);
    assert.equal(items[0], " alias ");
  });

  it("returns an empty list for missing or non-array fields", () => {
    for (const value of [undefined, null, "alias", {}, 1]) {
      assert.deepEqual(customerMetadataItems(value), []);
    }
  });

  it("preserves long values and treats markup as plain text", () => {
    const items = ["a".repeat(2048), "<script>fixture</script>"];
    assert.deepEqual(customerMetadataItems(items), items);
  });
});
