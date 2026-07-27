import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planVisitItinerary } from "../src/itinerary/planner.js";

function point(lng, lat) {
  return { lng, lat };
}

function request(overrides = {}) {
  return {
    title: "济宁客户拜访",
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
      },
      {
        id: "customer-b",
        customerId: "customer-b",
        customerName: "济宁第二人民医院",
        address: "济宁市任城区济宁市第二人民医院",
        city: "济宁",
        priority: "normal",
        visitMinutes: 60,
      },
    ],
    ...overrides,
  };
}

function createAmapFixture() {
  const geocodes = new Map([
    ["青岛市黄岛区秀兰禧悦山", { formattedAddress: "山东省青岛市黄岛区秀兰禧悦山", location: point(120.149201, 35.987754) }],
    ["济南市历下区经十路", { formattedAddress: "山东省济南市历下区经十路", location: point(117.120128, 36.652069) }],
    ["济宁市任城区济宁市第二人民医院", { formattedAddress: "山东省济宁市任城区济宁市第二人民医院", location: point(116.608817, 35.415405) }],
  ]);
  const calls = { geocode: [], reverseGeocode: [], matrix: [], route: [] };
  const client = {
    async geocode(input) {
      calls.geocode.push(input);
      return geocodes.get(input.address);
    },
    async reverseGeocode(input) {
      calls.reverseGeocode.push(input);
      return [...geocodes.values()].find((item) => (
        item.location.lng === input.location.lng && item.location.lat === input.location.lat
      ));
    },
    async drivingMatrix(input) {
      calls.matrix.push(input);
      return {
        distances: [[0, 10000, 20000], [10000, 0, 15000], [20000, 15000, 0]],
        durations: [[0, 600, 1200], [600, 0, 900], [1200, 900, 0]],
      };
    },
    async drivingRoute(input) {
      calls.route.push(input);
      return {
        distanceMeters: 390000,
        durationSeconds: 16000,
        tollsCny: 150,
        trafficLights: 28,
        polyline: [input.origin, ...input.waypoints, input.destination],
        steps: [],
      };
    },
  };
  return { client, calls };
}

describe("visit itinerary planner", () => {
  it("orchestrates geocoding, matrix planning, guarded AI ordering, and the final route", async () => {
    const amap = createAmapFixture();
    const modelCalls = [];
    const plan = await planVisitItinerary(request(), {
      amapClient: amap.client,
      modelConfig: { aiAnalysisMode: "model", modelApiKey: "model-secret" },
      clock: () => new Date("2026-07-27T12:00:00.000Z"),
      enhanceOrder: async (fallback, context) => {
        modelCalls.push({ fallback, context });
        return {
          orderedStopIds: ["customer-b", "customer-a"],
          summary: "先拜访济宁，再返回济南确认方案。",
          advice: ["出发前确认医院停车入口。"],
          source: "deepseek",
        };
      },
    });

    assert.equal(amap.calls.geocode.length, 3);
    assert.equal(amap.calls.matrix.length, 1);
    assert.equal(modelCalls.length, 1);
    assert.deepEqual(amap.calls.route[0], {
      origin: point(120.149201, 35.987754),
      waypoints: [point(116.608817, 35.415405)],
      destination: point(117.120128, 36.652069),
    });
    assert.equal(plan.generatedAt, "2026-07-27T12:00:00.000Z");
    assert.deepEqual(plan.orderedStopIds, ["customer-b", "customer-a"]);
    assert.equal(plan.optimization.source, "deepseek");
    assert.deepEqual(plan.optimization.baselineOrderedStopIds, ["customer-a", "customer-b"]);
    assert.equal(plan.summary, "先拜访济宁，再返回济南确认方案。");
    assert.equal(plan.stops[1].formattedAddress, "山东省济宁市任城区济宁市第二人民医院");
    assert.equal(plan.schedule[0].stopId, "customer-b");
    assert.equal(plan.route.distanceMeters, 390000);
    assert.doesNotMatch(JSON.stringify(plan), /model-secret/);
  });

  it("reverse verifies browser-resolved locations instead of repeating forward geocoding", async () => {
    const amap = createAmapFixture();
    const base = request();
    const plan = await planVisitItinerary(request({
      departureLocation: point(120.149201, 35.987754),
      stops: base.stops.map((stop, index) => ({
        ...stop,
        location: index === 0
          ? point(117.120128, 36.652069)
          : point(116.608817, 35.415405),
      })),
    }), {
      amapClient: amap.client,
      enhanceOrder: async (fallback) => fallback,
    });

    assert.equal(amap.calls.geocode.length, 0);
    assert.equal(amap.calls.reverseGeocode.length, 3);
    assert.equal(amap.calls.matrix.length, 1);
    assert.deepEqual(plan.departure.location, point(120.149201, 35.987754));
    assert.deepEqual(plan.stops.map((stop) => stop.location), [
      point(117.120128, 36.652069),
      point(116.608817, 35.415405),
    ]);
  });

  it("rejects a browser-resolved location outside the requested city before route work", async () => {
    const amap = createAmapFixture();
    amap.client.reverseGeocode = async ({ location }) => ({
      formattedAddress: "上海市浦东新区测试地址",
      province: "上海市",
      city: "上海市",
      district: "浦东新区",
      location,
    });

    await assert.rejects(
      () => planVisitItinerary(request({
        departureLocation: point(121.5, 31.2),
      }), { amapClient: amap.client }),
      (error) => error?.code === "AMAP_LOCATION_MISMATCH",
    );
    assert.equal(amap.calls.matrix.length, 0);
    assert.equal(amap.calls.route.length, 0);
  });

  it("rejects an AI order that increases appointment lateness", async () => {
    const amap = createAmapFixture();
    const input = request({
      stops: [
        { ...request().stops[0], visitMinutes: 60 },
        { ...request().stops[1], priority: "high", visitMinutes: 45, appointmentAt: "2026-07-28T00:20:00.000Z" },
      ],
    });
    const plan = await planVisitItinerary(input, {
      amapClient: amap.client,
      enhanceOrder: async () => ({
        orderedStopIds: ["customer-a", "customer-b"],
        summary: "This order is late",
        advice: [],
        source: "deepseek",
      }),
    });

    assert.deepEqual(plan.orderedStopIds, ["customer-b", "customer-a"]);
    assert.equal(plan.optimization.source, "deterministic");
    assert.equal(plan.totals.lateMinutes, 0);
    assert.notEqual(plan.summary, "This order is late");
  });

  it("rejects clearly excessive AI detours even when no appointment is late", async () => {
    const amap = createAmapFixture();
    amap.client.drivingMatrix = async () => ({
      distances: [[0, 10000, 90000], [10000, 0, 10000], [90000, 10000, 0]],
      durations: [[0, 600, 7200], [600, 0, 600], [7200, 600, 0]],
    });
    const plan = await planVisitItinerary(request(), {
      amapClient: amap.client,
      enhanceOrder: async () => ({
        orderedStopIds: ["customer-b", "customer-a"],
        summary: "Long detour",
        advice: [],
        source: "deepseek",
      }),
    });

    assert.deepEqual(plan.orderedStopIds, ["customer-a", "customer-b"]);
    assert.equal(plan.optimization.source, "deterministic");
  });

  it("validates the complete request before calling external services", async () => {
    let externalCalls = 0;
    const amapClient = {
      geocode: async () => { externalCalls += 1; },
      drivingMatrix: async () => { externalCalls += 1; },
      drivingRoute: async () => { externalCalls += 1; },
    };

    await assert.rejects(
      () => planVisitItinerary(request({ departureAddress: "" }), { amapClient }),
      /departureAddress/,
    );
    await assert.rejects(
      () => planVisitItinerary(request({ stops: Array.from({ length: 9 }, (_, index) => ({
        id: `customer-${index}`,
        customerName: `客户 ${index}`,
        address: `测试地址 ${index}`,
        priority: "normal",
        visitMinutes: 30,
      })) }), { amapClient }),
      /at most 8/,
    );
    assert.equal(externalCalls, 0);
  });
});
