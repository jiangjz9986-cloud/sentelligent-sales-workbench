import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addVisitStop,
  applyCustomerToVisitStop,
  buildAmapNavigationUrl,
  createEmptyVisitItineraryDraft,
  draftFromVisitItinerary,
  localDateTimeInput,
  orderedVisitStops,
  visitItineraryMatches,
  visitItineraryPayload,
} from "./visitItineraryModel.js";

function createIdSequence(...ids) {
  let index = 0;
  return () => ids[index++];
}

function savedItinerary(overrides = {}) {
  return {
    id: "itinerary-1",
    version: 3,
    title: "济宁客户拜访",
    visitDate: "2026-07-28",
    status: "planned",
    request: {
      title: "济宁客户拜访",
      visitDate: "2026-07-28",
      status: "planned",
      departureAddress: "青岛市黄岛区秀兰禧悦山",
      departureCity: "青岛",
      departureAt: "2026-07-28T00:00:00.000Z",
      stops: [
        {
          id: "customer-a",
          customerId: "customer-a",
          customerName: "济南示例客户",
          address: "济南市历下区经十路",
          city: "济南",
          priority: "normal",
          visitMinutes: 45,
          appointmentAt: null,
          notes: "确认范围",
        },
        {
          id: "customer-b",
          customerId: "customer-b",
          customerName: "济宁第二人民医院",
          address: "济宁市任城区济宁市第二人民医院",
          city: "济宁",
          priority: "high",
          visitMinutes: 60,
          appointmentAt: "2026-07-28T03:00:00.000Z",
          notes: null,
        },
      ],
    },
    plan: {
      orderedStopIds: ["customer-b", "customer-a"],
      stops: [
        { id: "customer-a", customerName: "济南示例客户", location: { lng: 117.120128, lat: 36.652069 } },
        { id: "customer-b", customerName: "济宁第二人民医院", location: { lng: 116.608817, lat: 35.415405 } },
      ],
      schedule: [
        { stopId: "customer-b", sequence: 1 },
        { stopId: "customer-a", sequence: 2 },
      ],
      route: { distanceMeters: 379100, durationSeconds: 15360 },
      summary: "先拜访济宁，再返回济南。",
      advice: [],
      optimization: { source: "deepseek" },
    },
    createdBy: "jiangjz",
    updatedBy: "jiangjz",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T13:00:00.000Z",
    ...overrides,
  };
}

describe("visit itinerary form model", () => {
  it("opens a genuinely blank new itinerary with one empty stop", () => {
    const draft = createEmptyVisitItineraryDraft({ createId: () => "stop-new-1" });

    assert.deepEqual(draft, {
      id: null,
      version: null,
      title: "",
      visitDate: "",
      status: "planned",
      departureAddress: "",
      departureCity: "",
      departureAt: "",
      stops: [{
        id: "stop-new-1",
        customerId: null,
        customerName: "",
        address: "",
        city: "",
        priority: "normal",
        visitMinutes: 60,
        appointmentAt: "",
        notes: "",
      }],
    });
  });

  it("applies a selected customer only to the chosen stop", () => {
    let draft = createEmptyVisitItineraryDraft({ createId: createIdSequence("stop-a") });
    draft = addVisitStop(draft, { createId: createIdSequence("stop-b") });
    draft.stops[1] = { ...draft.stops[1], address: "保留手工地址" };

    const updated = applyCustomerToVisitStop(draft, "stop-b", {
      id: "customer-b",
      name: "济宁第二人民医院",
      address: "济宁市任城区红星东路",
    });

    assert.equal(updated.stops[0].customerId, null);
    assert.equal(updated.stops[0].customerName, "");
    assert.equal(updated.stops[1].customerId, "customer-b");
    assert.equal(updated.stops[1].customerName, "济宁第二人民医院");
    assert.equal(updated.stops[1].address, "济宁市任城区红星东路");
    assert.equal(draft.stops[1].address, "保留手工地址");
  });

  it("limits a plan to eight stops", () => {
    const createId = createIdSequence(...Array.from({ length: 9 }, (_, index) => `stop-${index + 1}`));
    let draft = createEmptyVisitItineraryDraft({ createId });
    for (let index = 1; index < 8; index += 1) draft = addVisitStop(draft, { createId });

    assert.equal(draft.stops.length, 8);
    assert.throws(() => addVisitStop(draft, { createId }), /at most 8/);
  });

  it("maps a saved snapshot to editable local fields and serializes date-times back to ISO", () => {
    const saved = savedItinerary();
    const draft = draftFromVisitItinerary(saved);

    assert.equal(draft.id, saved.id);
    assert.equal(draft.version, 3);
    assert.equal(draft.departureAt, localDateTimeInput("2026-07-28T00:00:00.000Z"));
    assert.equal(draft.stops[1].appointmentAt, localDateTimeInput("2026-07-28T03:00:00.000Z"));
    const serialized = visitItineraryPayload(draft);
    assert.equal(serialized.departureAt, "2026-07-28T00:00:00.000Z");
    assert.equal(serialized.stops[1].appointmentAt, "2026-07-28T03:00:00.000Z");
    assert.equal(serialized.stops[0].appointmentAt, null);
    assert.equal(Object.hasOwn(serialized, "id"), false);
    assert.equal(Object.hasOwn(serialized, "version"), false);
    assert.throws(() => visitItineraryPayload({ ...draft, status: "unknown" }), /status/);
  });

  it("orders saved geocoded stops and creates a key-free AMap navigation URL", () => {
    const item = savedItinerary();
    const ordered = orderedVisitStops(item);
    assert.deepEqual(ordered.map((stop) => stop.id), ["customer-b", "customer-a"]);

    const url = new URL(buildAmapNavigationUrl(ordered[0]));
    assert.equal(url.origin, "https://uri.amap.com");
    assert.equal(url.pathname, "/navigation");
    assert.equal(url.searchParams.get("to"), "116.608817,35.415405,济宁第二人民医院");
    assert.equal(url.searchParams.get("mode"), "car");
    assert.equal(url.searchParams.has("key"), false);
  });

  it("searches only itinerary-owned fields", () => {
    const item = savedItinerary();
    assert.equal(visitItineraryMatches(item, "济宁"), true);
    assert.equal(visitItineraryMatches(item, "2026-07-28"), true);
    assert.equal(visitItineraryMatches(item, "第二人民医院"), true);
    assert.equal(visitItineraryMatches(item, "完全无关"), false);
  });
});
