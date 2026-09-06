import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import { parseShortcutBookkeepingIntent } from "../src/integrations/shortcutBookkeepingIntent.js";
import {
  TravelExpenseRegionProfileVersionConflictError,
  createTravelExpenseRegionRepository,
} from "../src/travelExpense/regionRepository.js";

const temporaryDirectories = [];

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "travel-expense-region-profile-"));
  temporaryDirectories.push(directory);
  return openDatabase({ databaseUrl: join(directory, "test.sqlite") });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("travel expense natural-week region profile", () => {
  it("returns a version-zero empty projection and creates one owner-scoped profile", async () => {
    const db = await database();
    try {
      const repository = createTravelExpenseRegionRepository(db, {
        clock: () => new Date("2026-08-26T06:00:00.000Z"),
      });
      assert.deepEqual(repository.getProfile({ owner: "owner-a", weekStart: "2026-08-24" }), {
        weekStart: "2026-08-24",
        weekEnd: "2026-08-30",
        version: 0,
        cities: [],
        defaultCity: null,
        dateOverrides: [],
        createdAt: null,
        updatedAt: null,
      });

      const saved = repository.putProfile({
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 0,
        weekStart: "2026-08-24",
        cities: [" 济南 ", "青岛", "济南"],
        defaultCity: "济南",
        dateOverrides: [{ date: "2026-08-27", city: "青岛" }],
      });
      assert.equal(saved.version, 1);
      assert.deepEqual(saved.cities, ["济南", "青岛"]);
      assert.deepEqual(saved.dateOverrides, [{ date: "2026-08-27", city: "青岛" }]);
      assert.equal(repository.resolveRegion({ owner: "owner-a", occurredOn: "2026-08-25" }).city, "济南");
      assert.equal(repository.resolveRegion({ owner: "owner-a", occurredOn: "2026-08-25" }).source, "week_default");
      assert.equal(repository.resolveRegion({ owner: "owner-a", occurredOn: "2026-08-27" }).city, "青岛");
      assert.equal(repository.resolveRegion({ owner: "owner-a", occurredOn: "2026-08-27" }).source, "date_override");
      assert.equal(repository.getProfile({ owner: "owner-b", weekStart: "2026-08-24" }).version, 0);
    } finally {
      db.close();
    }
  });

  it("keeps compatibility-equivalent owner and actor identities strictly isolated", async () => {
    const db = await database();
    try {
      const repository = createTravelExpenseRegionRepository(db, {
        clock: () => new Date("2026-08-26T06:00:00.000Z"),
      });
      repository.putProfile({
        owner: "Ａ",
        actor: "Ａ",
        expectedVersion: 0,
        weekStart: "2026-08-24",
        cities: ["济南"],
        defaultCity: "济南",
        dateOverrides: [],
      });

      const stored = db.prepare(`
        SELECT owner, created_by, updated_by
        FROM travel_expense_region_profiles
        WHERE week_start = '2026-08-24'
      `).get();
      assert.deepEqual({ ...stored }, {
        owner: "Ａ",
        created_by: "Ａ",
        updated_by: "Ａ",
      });
      assert.equal(repository.getProfile({ owner: "Ａ", weekStart: "2026-08-24" }).version, 1);
      assert.equal(repository.getProfile({ owner: "A", weekStart: "2026-08-24" }).version, 0);

      repository.putProfile({
        owner: "A",
        actor: "A",
        expectedVersion: 0,
        weekStart: "2026-08-24",
        cities: ["青岛"],
        defaultCity: "青岛",
        dateOverrides: [],
      });
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM travel_expense_region_profiles WHERE week_start = '2026-08-24'").get().count,
        2,
      );
    } finally {
      db.close();
    }
  });

  it("uses optimistic locking, keeps no-op writes idempotent, and validates week boundaries", async () => {
    const db = await database();
    try {
      const repository = createTravelExpenseRegionRepository(db);
      const input = {
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 0,
        weekStart: "2026-08-24",
        cities: ["济南", "青岛"],
        defaultCity: null,
        dateOverrides: [
          { date: "2026-08-24", city: "济南" },
          { date: "2026-08-25", city: "济南" },
          { date: "2026-08-26", city: "济南" },
          { date: "2026-08-27", city: "青岛" },
          { date: "2026-08-28", city: "青岛" },
          { date: "2026-08-29", city: "青岛" },
          { date: "2026-08-30", city: "青岛" },
        ],
      };
      const first = repository.putProfile(input);
      const replay = repository.putProfile({ ...input, expectedVersion: first.version });
      assert.equal(replay.version, first.version);

      assert.throws(
        () => repository.putProfile({ ...input, expectedVersion: 0, cities: ["济宁"], defaultCity: "济宁", dateOverrides: [] }),
        (error) => error instanceof TravelExpenseRegionProfileVersionConflictError
          && error.currentVersion === 1,
      );
      assert.throws(
        () => repository.putProfile({ ...input, expectedVersion: 1, dateOverrides: [{ date: "2026-08-31", city: "济南" }] }),
        /dateOverrides/u,
      );
      assert.throws(
        () => repository.putProfile({ ...input, expectedVersion: 1, defaultCity: "上海" }),
        /defaultCity/u,
      );
    } finally {
      db.close();
    }
  });

  it("inherits only the owner's latest responsible-city pool into an unconfigured week", async () => {
    const db = await database();
    try {
      const repository = createTravelExpenseRegionRepository(db, {
        clock: () => new Date("2026-08-26T06:00:00.000Z"),
      });
      repository.putProfile({
        owner: "owner-a",
        actor: "owner-a",
        expectedVersion: 0,
        weekStart: "2026-08-17",
        cities: ["济南", "青岛"],
        defaultCity: "济南",
        dateOverrides: [{ date: "2026-08-20", city: "青岛" }],
      });

      assert.deepEqual(repository.getProfile({ owner: "owner-a", weekStart: "2026-08-24" }), {
        weekStart: "2026-08-24",
        weekEnd: "2026-08-30",
        version: 0,
        cities: ["济南", "青岛"],
        defaultCity: null,
        dateOverrides: [],
        createdAt: null,
        updatedAt: null,
      });
      assert.deepEqual(repository.getProfile({ owner: "owner-b", weekStart: "2026-08-24" }).cities, []);
      assert.equal(repository.resolveRegion({ owner: "owner-a", occurredOn: "2026-08-25" }), null);
    } finally {
      db.close();
    }
  });

  it("parses relative-week single and multi-city assignments without treating them as loan allocation", () => {
    const now = new Date("2026-08-26T06:00:00.000Z");
    assert.deepEqual(parseShortcutBookkeepingIntent("上周区域是济南", { now }).regionAssignment, {
      weekStart: "2026-08-17",
      cities: ["济南"],
      defaultCity: "济南",
      dateOverrides: [],
    });
    assert.deepEqual(parseShortcutBookkeepingIntent("上周的区域是济南", { now }).regionAssignment, {
      weekStart: "2026-08-17",
      cities: ["济南"],
      defaultCity: "济南",
      dateOverrides: [],
    });
    const explicitWeek = parseShortcutBookkeepingIntent("20260817-20260823区域是济南", { now });
    assert.equal(explicitWeek.status, "accepted");
    assert.equal(explicitWeek.intent, "region_assignment");
    assert.deepEqual(explicitWeek.regionAssignment, {
      weekStart: "2026-08-17",
      cities: ["济南"],
      defaultCity: "济南",
      dateOverrides: [],
    });
    for (const regionText of [
      "设置本周区域为济南",
      "把本周区域设为济南",
      "将上周区域改为济南",
      "修改上周出差区域为济南",
    ]) {
      const parsed = parseShortcutBookkeepingIntent(regionText, { now });
      assert.equal(parsed.status, "accepted", `常见区域设置说法应可直接识别：${regionText}`);
      assert.equal(parsed.intent, "region_assignment");
      assert.deepEqual(parsed.regionAssignment.cities, ["济南"]);
    }

    const multi = parseShortcutBookkeepingIntent(
      "本周区域是济南、青岛，8月24日至8月26日济南，8月27日至8月30日青岛",
      { now },
    );
    assert.equal(multi.status, "accepted");
    assert.equal(multi.intent, "region_assignment");
    assert.deepEqual(multi.regionAssignment, {
      weekStart: "2026-08-24",
      cities: ["济南", "青岛"],
      defaultCity: null,
      dateOverrides: [
        { date: "2026-08-24", city: "济南" },
        { date: "2026-08-25", city: "济南" },
        { date: "2026-08-26", city: "济南" },
        { date: "2026-08-27", city: "青岛" },
        { date: "2026-08-28", city: "青岛" },
        { date: "2026-08-29", city: "青岛" },
        { date: "2026-08-30", city: "青岛" },
      ],
    });
    const weekdayOnly = parseShortcutBookkeepingIntent(
      "本周区域是周一至周三济南，周四至周日青岛",
      { now },
    );
    assert.equal(weekdayOnly.status, "accepted");
    assert.deepEqual(weekdayOnly.regionAssignment.cities, ["济南", "青岛"]);
    assert.deepEqual(weekdayOnly.regionAssignment.dateOverrides, multi.regionAssignment.dateOverrides);
    for (const suffix of ["金额20元", "备注是早餐", "请帮我确认"]) {
      const parsed = parseShortcutBookkeepingIntent(`本周区域是济南，${suffix}`, { now });
      assert.equal(parsed.status, "accepted", `单城市区域应保持可识别：${suffix}`);
      assert.equal(parsed.intent, "region_assignment");
      assert.deepEqual(parsed.regionAssignment.cities, ["济南"], `普通后缀不应成为城市：${suffix}`);
      assert.equal(parsed.regionAssignment.defaultCity, "济南");
    }
    const ambiguous = parseShortcutBookkeepingIntent("本周区域是济南、青岛", { now });
    assert.equal(ambiguous.status, "review_required");
    assert.equal(ambiguous.intent, "unknown");
    assert.ok(ambiguous.warnings.includes("ambiguous_region_assignment"));
    for (const incomplete of ["本周区域", "本周出差区域"]) {
      const parsed = parseShortcutBookkeepingIntent(incomplete, { now });
      assert.equal(parsed.status, "review_required", `区域短语不得跌落为借款分配：${incomplete}`);
      assert.equal(parsed.intent, "unknown");
      assert.ok(parsed.warnings.includes("ambiguous_region_assignment"));
    }
    assert.equal(parseShortcutBookkeepingIntent("修改备注为区域早餐", { now }).intent, "correction");
    for (const correctionText of [
      "修改备注为本周区域早餐",
      "备注改为上周区域拜访",
      "修改费用类别为本周区域交通",
    ]) {
      const parsed = parseShortcutBookkeepingIntent(correctionText, { now });
      assert.equal(parsed.intent, "correction", `明确修改前缀不得写入区域配置：${correctionText}`);
      assert.notEqual(parsed.intent, "region_assignment");
    }
    for (const unsafeTail of [
      "上周区域是济南帮我记账",
      "上周区域是济南早餐",
      "上周出差区域是济南啊",
    ]) {
      const parsed = parseShortcutBookkeepingIntent(unsafeTail, { now });
      assert.equal(parsed.status, "review_required", `含非城市尾部的区域表达必须人工复核：${unsafeTail}`);
      assert.equal(parsed.intent, "unknown");
      assert.ok(parsed.warnings.includes("ambiguous_region_assignment"));
    }
    assert.equal(parseShortcutBookkeepingIntent("上周区域是不是济南？", { now }).status, "review_required");
  });
});
