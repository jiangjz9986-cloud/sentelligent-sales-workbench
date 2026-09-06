import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addResponsibleCity,
  buildResponsibleRegionPayload,
  createResponsibleRegionDraft,
  hasResponsibleCity,
  removeResponsibleCity,
  resolveResponsibleRegionDates,
  responsibleRegionWeekDates,
  setResponsibleRegionWeekDefault,
  upsertResponsibleRegionDateOverride,
} from "./responsibleRegionModel.js";

function profile(overrides = {}) {
  return {
    version: 0,
    cities: [],
    weekStart: "2026-08-24",
    weekEnd: "2026-08-30",
    defaultCity: null,
    dateOverrides: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("responsible region profile model", () => {
  it("accepts the empty first-write projection and resolves seven unset dates", () => {
    const draft = createResponsibleRegionDraft(profile());
    assert.equal(draft.version, 0);
    assert.equal(draft.effectiveDates.length, 7);
    assert.deepEqual(draft.effectiveDates[0], { date: "2026-08-24", city: null, source: "unresolved" });
  });

  it("deduplicates aliases and applies date override before the default city", () => {
    const first = addResponsibleCity([], "济南市");
    const duplicate = addResponsibleCity(first.cities, "济南");
    const second = addResponsibleCity(duplicate.cities, "济宁");
    let draft = createResponsibleRegionDraft(profile({ cities: second.cities }));
    draft = setResponsibleRegionWeekDefault(draft, "济南");
    draft = upsertResponsibleRegionDateOverride(draft, { date: "2026-08-26", city: "济宁" });
    assert.equal(resolveResponsibleRegionDates(draft)[2].city, "济宁");
    assert.equal(resolveResponsibleRegionDates(draft)[1].city, "济南市");
  });

  it("prevents removing an in-use city and emits the exact API payload", () => {
    const draft = createResponsibleRegionDraft(profile({
      version: 3,
      cities: ["济南", "济宁"],
      defaultCity: "济南",
      dateOverrides: [{ date: "2026-08-26", city: "济宁" }],
    }));
    assert.throws(() => removeResponsibleCity(draft, "济南市"), /本周默认/u);
    assert.throws(() => removeResponsibleCity(draft, "济宁"), /日期覆盖/u);
    assert.deepEqual(buildResponsibleRegionPayload({ ...draft, owner: "ignored" }), {
      weekStart: "2026-08-24",
      cities: ["济南", "济宁"],
      defaultCity: "济南",
      dateOverrides: [{ date: "2026-08-26", city: "济宁" }],
    });
  });

  it("requires a real Monday-to-Sunday natural week", () => {
    assert.deepEqual(responsibleRegionWeekDates("2026-08-24").at(-1), "2026-08-30");
    assert.throws(() => responsibleRegionWeekDates("2026-08-25"), /Monday/u);
  });

  it("probes city membership through suffix normalization without throwing on junk", () => {
    assert.equal(hasResponsibleCity(["济宁市", "东营"], "济宁"), true);
    assert.equal(hasResponsibleCity(["济宁", "东营"], "济宁市"), true);
    assert.equal(hasResponsibleCity(["济宁"], "日照"), false);
    assert.equal(hasResponsibleCity([], "济宁"), false);
    assert.equal(hasResponsibleCity(null, "济宁"), false);
    assert.equal(hasResponsibleCity(["济宁"], ""), false);
    assert.equal(hasResponsibleCity(["济宁"], null), false);
    assert.equal(hasResponsibleCity(["济宁"], "x".repeat(500)), false);
  });
});
