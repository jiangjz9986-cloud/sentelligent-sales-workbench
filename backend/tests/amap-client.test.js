import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AmapServiceError,
  createAmapClient,
} from "../src/maps/amapClient.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function location(lng, lat) {
  return { lng, lat };
}

describe("AMap Web Service client", () => {
  it("returns normalized geocoding without exposing provider credentials", async () => {
    const calls = [];
    const client = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({
          status: "1",
          geocodes: [{
            formatted_address: "山东省青岛市黄岛区秀兰禧悦山",
            province: "山东省",
            city: "青岛市",
            district: "黄岛区",
            adcode: "370211",
            location: "120.149201,35.987754",
          }],
        });
      },
    });

    const result = await client.geocode({ address: "秀兰禧悦山", city: "青岛" });

    assert.equal(calls.length, 1);
    const requestUrl = new URL(calls[0].url);
    assert.equal(requestUrl.origin, "https://restapi.amap.com");
    assert.equal(requestUrl.pathname, "/v3/geocode/geo");
    assert.equal(requestUrl.searchParams.get("address"), "秀兰禧悦山");
    assert.equal(requestUrl.searchParams.get("city"), "青岛");
    assert.equal(requestUrl.searchParams.get("key"), "fixture");
    assert.equal(calls[0].options.method, "GET");
    assert.deepEqual(result, {
      formattedAddress: "山东省青岛市黄岛区秀兰禧悦山",
      province: "山东省",
      city: "青岛市",
      district: "黄岛区",
      adcode: "370211",
      location: location(120.149201, 35.987754),
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture/);
  });

  it("reverse geocodes a browser-resolved location without exposing provider credentials", async () => {
    const calls = [];
    const client = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async (url) => {
        calls.push(new URL(url));
        return jsonResponse({
          status: "1",
          regeocode: {
            formatted_address: "山东省青岛市黄岛区秀兰禧悦山",
            addressComponent: {
              province: "山东省",
              city: "青岛市",
              district: "黄岛区",
              adcode: "370211",
            },
          },
        });
      },
    });

    const result = await client.reverseGeocode({ location: location(120.149201, 35.987754) });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/v3/geocode/regeo");
    assert.equal(calls[0].searchParams.get("location"), "120.149201,35.987754");
    assert.equal(calls[0].searchParams.get("extensions"), "base");
    assert.deepEqual(result, {
      formattedAddress: "山东省青岛市黄岛区秀兰禧悦山",
      province: "山东省",
      city: "青岛市",
      district: "黄岛区",
      adcode: "370211",
      location: location(120.149201, 35.987754),
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture/);
  });

  it("distinguishes an empty geocode result from a provider failure", async () => {
    const noResultClient = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async () => jsonResponse({ status: "1", geocodes: [] }),
    });
    await assert.rejects(
      () => noResultClient.geocode({ address: "不存在的地址" }),
      (error) => error instanceof AmapServiceError && error.code === "AMAP_NO_RESULT",
    );

    const providerClient = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async () => jsonResponse({
        status: "0",
        info: "INVALID_USER_KEY fixture",
        infocode: "10001",
      }),
    });
    await assert.rejects(
      () => providerClient.geocode({ address: "秀兰禧悦山" }),
      (error) => {
        assert.equal(error instanceof AmapServiceError, true);
        assert.equal(error.code, "AMAP_PROVIDER_ERROR");
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /fixture|INVALID_USER_KEY/);
        return true;
      },
    );
  });

  it("builds a complete driving matrix in the original location order", async () => {
    const calls = [];
    const matrixRows = [
      [
        { origin_id: "1", dest_id: "1", distance: "0", duration: "0" },
        { origin_id: "2", dest_id: "1", distance: "12000", duration: "1500" },
        { origin_id: "3", dest_id: "1", distance: "22000", duration: "2700" },
      ],
      [
        { origin_id: "1", dest_id: "1", distance: "11000", duration: "1400" },
        { origin_id: "2", dest_id: "1", distance: "0", duration: "0" },
        { origin_id: "3", dest_id: "1", distance: "13000", duration: "1600" },
      ],
      [
        { origin_id: "1", dest_id: "1", distance: "21000", duration: "2600" },
        { origin_id: "2", dest_id: "1", distance: "12500", duration: "1550" },
        { origin_id: "3", dest_id: "1", distance: "0", duration: "0" },
      ],
    ];
    const client = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        calls.push(requestUrl);
        return jsonResponse({ status: "1", results: matrixRows[calls.length - 1] });
      },
    });
    const locations = [
      location(120.149201, 35.987754),
      location(117.120128, 36.652069),
      location(116.608817, 35.415405),
    ];

    const result = await client.drivingMatrix({ locations });

    assert.equal(calls.length, 3);
    assert.equal(calls[0].pathname, "/v3/distance");
    assert.equal(calls[0].searchParams.get("origins"), locations.map((item) => `${item.lng},${item.lat}`).join("|"));
    assert.equal(calls[0].searchParams.get("destination"), "120.149201,35.987754");
    assert.equal(calls[0].searchParams.get("type"), "1");
    assert.deepEqual(result, {
      distances: [
        [0, 11000, 21000],
        [12000, 0, 12500],
        [22000, 13000, 0],
      ],
      durations: [
        [0, 1400, 2600],
        [1500, 0, 1550],
        [2700, 1600, 0],
      ],
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture/);
  });

  it("rejects driving matrices outside the supported location range", async () => {
    const client = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async () => {
        throw new Error("validation must happen before fetch");
      },
    });

    await assert.rejects(() => client.drivingMatrix({ locations: [location(120, 36)] }), /between 2 and 9/);
    await assert.rejects(
      () => client.drivingMatrix({ locations: Array.from({ length: 10 }, (_, index) => location(120 + index / 100, 36)) }),
      /between 2 and 9/,
    );
  });

  it("normalizes a driving route, its cost, steps, and polyline", async () => {
    const calls = [];
    const client = createAmapClient({
      apiKey: "fixture",
      fetchImpl: async (url) => {
        calls.push(new URL(url));
        return jsonResponse({
          status: "1",
          route: {
            paths: [{
              distance: "379100",
              cost: { duration: "15360", tolls: "146", traffic_lights: "25" },
              steps: [
                {
                  instruction: "沿疏港高速向西行驶",
                  road_name: "疏港高速",
                  distance: "12600",
                  cost: { duration: "720" },
                  polyline: "120.149201,35.987754;119.987654,35.900000",
                },
                {
                  instruction: "继续沿日兰高速行驶",
                  road_name: "日兰高速",
                  distance: "366500",
                  cost: { duration: "14640" },
                  polyline: "119.987654,35.900000;116.608817,35.415405",
                },
              ],
            }],
          },
        });
      },
    });

    const result = await client.drivingRoute({
      origin: location(120.149201, 35.987754),
      destination: location(116.608817, 35.415405),
      waypoints: [location(117.120128, 36.652069)],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/v5/direction/driving");
    assert.equal(calls[0].searchParams.get("origin"), "120.149201,35.987754");
    assert.equal(calls[0].searchParams.get("destination"), "116.608817,35.415405");
    assert.equal(calls[0].searchParams.get("waypoints"), "117.120128,36.652069");
    assert.match(calls[0].searchParams.get("show_fields"), /polyline/);
    assert.deepEqual(result, {
      distanceMeters: 379100,
      durationSeconds: 15360,
      tollsCny: 146,
      trafficLights: 25,
      polyline: [
        location(120.149201, 35.987754),
        location(119.987654, 35.9),
        location(116.608817, 35.415405),
      ],
      steps: [
        {
          instruction: "沿疏港高速向西行驶",
          roadName: "疏港高速",
          distanceMeters: 12600,
          durationSeconds: 720,
        },
        {
          instruction: "继续沿日兰高速行驶",
          roadName: "日兰高速",
          distanceMeters: 366500,
          durationSeconds: 14640,
        },
      ],
    });
  });

  it("converts transport, HTTP, and malformed responses into safe errors", async () => {
    const scenarios = [
      {
        expectedCode: "AMAP_TIMEOUT",
        fetchImpl: async () => { throw new DOMException("timeout", "AbortError"); },
      },
      {
        expectedCode: "AMAP_HTTP_ERROR",
        fetchImpl: async () => jsonResponse({ detail: "timeout" }, 503),
      },
      {
        expectedCode: "AMAP_INVALID_RESPONSE",
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not-json timeout" }),
      },
    ];

    for (const scenario of scenarios) {
      const client = createAmapClient({ apiKey: "fixture", fetchImpl: scenario.fetchImpl });
      await assert.rejects(
        () => client.geocode({ address: "测试地址" }),
        (error) => {
          assert.equal(error instanceof AmapServiceError, true);
          assert.equal(error.code, scenario.expectedCode);
          assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /timeout|not-json/);
          return true;
        },
      );
    }
  });
});
