import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { geocodeVisitItineraryPayload } from "./amapGeocoder.js";

function payload() {
  return {
    title: "济宁客户拜访",
    departureAddress: "黄岛区秀兰禧悦山",
    departureCity: "青岛",
    departureAt: "2026-07-28T00:00:00.000Z",
    stops: [
      { id: "a", customerName: "济南客户", address: "济南市历下区经十路", city: "济南" },
      { id: "b", customerName: "济宁第二人民医院", address: "济宁市第二人民医院", city: "济宁" },
    ],
  };
}

function createAmapFixture() {
  const points = new Map([
    ["黄岛区秀兰禧悦山", { lng: 120.149201, lat: 35.987754 }],
    ["济南市历下区经十路", { lng: 117.120128, lat: 36.652069 }],
    ["济宁市第二人民医院", { lng: 116.608817, lat: 35.415405 }],
  ]);
  const calls = { load: [], plugin: [], geocode: [] };
  class Geocoder {
    constructor(options) {
      this.city = options.city;
    }

    getLocation(address, callback) {
      calls.geocode.push({ address, city: this.city });
      const point = points.get(address);
      callback("complete", {
        info: "OK",
        geocodes: point ? [{
          formattedAddress: address,
          location: {
            getLng: () => point.lng,
            getLat: () => point.lat,
          },
        }] : [],
      });
    }
  }
  const AMap = {
    Geocoder,
    plugin(name, ready) {
      calls.plugin.push(name);
      ready();
    },
  };
  return {
    calls,
    loadAmapImpl: async (config) => {
      calls.load.push(config);
      return AMap;
    },
  };
}

describe("AMap browser geocoding for visit itineraries", () => {
  it("adds verified coordinate hints without mutating the form payload", async () => {
    const fixture = createAmapFixture();
    const input = payload();
    const result = await geocodeVisitItineraryPayload(input, {
      config: { key: "fixture", securityCode: "browser" },
      loadAmapImpl: fixture.loadAmapImpl,
    });

    assert.equal(fixture.calls.load.length, 1);
    assert.deepEqual(fixture.calls.plugin, ["AMap.Geocoder"]);
    assert.equal(fixture.calls.geocode.length, 3);
    assert.deepEqual(result.departureLocation, { lng: 120.149201, lat: 35.987754 });
    assert.deepEqual(result.stops.map((stop) => stop.location), [
      { lng: 117.120128, lat: 36.652069 },
      { lng: 116.608817, lat: 35.415405 },
    ]);
    assert.equal(Object.hasOwn(input, "departureLocation"), false);
    assert.equal(input.stops.every((stop) => !Object.hasOwn(stop, "location")), true);
    assert.doesNotMatch(JSON.stringify(result), /fixture|browser/);
  });

  it("keeps the server geocoding path when browser map configuration is unavailable", async () => {
    let loadCalls = 0;
    const input = payload();
    const result = await geocodeVisitItineraryPayload(input, {
      config: { key: "", securityCode: "" },
      loadAmapImpl: async () => { loadCalls += 1; },
    });

    assert.strictEqual(result, input);
    assert.equal(loadCalls, 0);
  });

  it("reports the failed business address without leaking browser credentials", async () => {
    const fixture = createAmapFixture();
    await assert.rejects(
      () => geocodeVisitItineraryPayload({
        ...payload(),
        stops: [{ ...payload().stops[0], address: "无法识别的地址" }],
      }, {
        config: { key: "fixture", securityCode: "browser" },
        loadAmapImpl: fixture.loadAmapImpl,
      }),
      (error) => /无法定位客户地址/.test(error.message) && !/fixture|browser/.test(error.message),
    );
  });
});
