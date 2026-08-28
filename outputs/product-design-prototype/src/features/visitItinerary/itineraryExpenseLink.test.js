import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expenseDraftFiltersFromItinerary,
  expenseDraftFromFilters,
} from "./itineraryExpenseLink.js";

function itinerary(overrides = {}) {
  return {
    id: "itn-1",
    title: "济宁两院拜访",
    visitDate: "2026-08-28",
    plan: {
      stops: [
        { id: "stop-2", customerId: null, customerName: "济宁医学院附属医院", city: "" },
        { id: "stop-1", customerId: "cus-1", customerName: "济宁市第一人民医院", city: "济宁" },
      ],
      orderedStopIds: ["stop-1", "stop-2"],
    },
    ...overrides,
  };
}

describe("itinerary→expense draft filters", () => {
  it("maps an itinerary into single-element draft filters in stop order", () => {
    assert.deepEqual(expenseDraftFiltersFromItinerary(itinerary()), {
      draftDate: ["2026-08-28"],
      draftItinerary: ["itn-1"],
      draftCustomer: ["cus-1"],
      draftPurpose: ["拜访 济宁市第一人民医院、济宁医学院附属医院"],
      draftRegion: ["济宁"],
    });
  });

  it("appends 等 beyond two stops and falls back through stop cities", () => {
    const filters = expenseDraftFiltersFromItinerary(itinerary({
      plan: {
        stops: [
          { id: "s1", customerId: null, customerName: "甲医院", city: "" },
          { id: "s2", customerId: null, customerName: "乙医院", city: "" },
          { id: "s3", customerId: "cus-3", customerName: "丙医院", city: "东营" },
        ],
        orderedStopIds: ["s1", "s2", "s3"],
      },
    }));
    assert.deepEqual(filters.draftPurpose, ["拜访 甲医院、乙医院等"]);
    assert.deepEqual(filters.draftRegion, ["东营"]);
    assert.deepEqual(filters.draftCustomer, ["cus-3"]);
  });

  it("uses the itinerary title when no stop has a customer name and omits empty region/customer", () => {
    const filters = expenseDraftFiltersFromItinerary(itinerary({
      plan: { stops: [], orderedStopIds: [] },
      request: { stops: [] },
    }));
    assert.deepEqual(filters.draftPurpose, ["济宁两院拜访"]);
    assert.equal("draftRegion" in filters, false);
    assert.equal("draftCustomer" in filters, false);
  });

  it("truncates an overlong purpose to 100 characters", () => {
    const filters = expenseDraftFiltersFromItinerary(itinerary({
      plan: {
        stops: [
          { id: "s1", customerId: null, customerName: "医".repeat(90), city: "" },
          { id: "s2", customerId: null, customerName: "院".repeat(90), city: "" },
        ],
        orderedStopIds: ["s1", "s2"],
      },
    }));
    assert.equal(filters.draftPurpose[0].length, 100);
    assert.ok(filters.draftPurpose[0].startsWith("拜访 "));
  });

  it("fails closed when the visit date is missing or not a real calendar date", () => {
    assert.equal(expenseDraftFiltersFromItinerary(itinerary({ visitDate: "" })), null);
    assert.equal(expenseDraftFiltersFromItinerary(itinerary({ visitDate: "2026-02-31" })), null);
    assert.equal(expenseDraftFiltersFromItinerary(itinerary({ visitDate: "today" })), null);
    assert.equal(expenseDraftFiltersFromItinerary(null), null);
  });
});

describe("expense draft from URL filters", () => {
  it("round-trips the filters produced from an itinerary", () => {
    assert.deepEqual(expenseDraftFromFilters(expenseDraftFiltersFromItinerary(itinerary())), {
      occurredOn: "2026-08-28",
      itineraryId: "itn-1",
      customerId: "cus-1",
      purpose: "拜访 济宁市第一人民医院、济宁医学院附属医院",
      region: "济宁",
    });
  });

  it("fails closed on a missing, malformed, or impossible draftDate", () => {
    assert.equal(expenseDraftFromFilters({}), null);
    assert.equal(expenseDraftFromFilters(undefined), null);
    assert.equal(expenseDraftFromFilters({ draftDate: [] }), null);
    assert.equal(expenseDraftFromFilters({ draftDate: ["2026-2-3"] }), null);
    assert.equal(expenseDraftFromFilters({ draftDate: ["2026-02-31"] }), null);
    assert.equal(expenseDraftFromFilters({ draftDate: ["<script>"] }), null);
  });

  it("normalizes missing optional keys to null and caps lengths", () => {
    assert.deepEqual(expenseDraftFromFilters({ draftDate: ["2026-08-28"] }), {
      occurredOn: "2026-08-28",
      itineraryId: null,
      customerId: null,
      purpose: "",
      region: null,
    });
    const long = expenseDraftFromFilters({
      draftDate: ["2026-08-28"],
      draftPurpose: ["长".repeat(300)],
      draftRegion: ["市".repeat(300)],
    });
    assert.equal(long.purpose.length, 100);
    assert.equal(long.region.length, 100);
  });
});
