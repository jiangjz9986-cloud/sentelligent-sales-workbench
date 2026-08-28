import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockAmapClient } from "../src/maps/amapMockClient.js";

const client = createMockAmapClient();

describe("deterministic mock Amap client", () => {
  it("geocodes into the Qingdao bounding box with fixed administrative fields", async () => {
    const first = await client.geocode({ address: "济宁市任城区济宁市第二人民医院" });
    assert.equal(first.formattedAddress, "济宁市任城区济宁市第二人民医院");
    assert.equal(first.city, "青岛市");
    assert.equal(first.district, "黄岛区");
    assert.equal(first.adcode, "370211");
    assert.ok(first.location.lng >= 120.1 && first.location.lng <= 120.6);
    assert.ok(first.location.lat >= 35.9 && first.location.lat <= 36.4);
    assert.equal(first.location.lng, Math.round(first.location.lng * 1e6) / 1e6);

    const replay = await client.geocode({ address: "济宁市任城区济宁市第二人民医院" });
    assert.deepEqual(replay, first);
    const different = await client.geocode({ address: "青岛市市南区香港中路" });
    assert.notDeepEqual(different.location, first.location);
    await assert.rejects(client.geocode({ address: "" }), TypeError);
  });

  it("reverse geocodes any valid location into the fixed mock region", async () => {
    const resolved = await client.reverseGeocode({ location: { lng: 120.3, lat: 36.1 } });
    assert.equal(resolved.city, "青岛市");
    assert.equal(resolved.adcode, "370211");
    assert.deepEqual(resolved.location, { lng: 120.3, lat: 36.1 });
    await assert.rejects(client.reverseGeocode({ location: { lng: 999, lat: 0 } }), TypeError);
  });

  it("builds a symmetric distance matrix at 1.4x great-circle and ~40 km/h durations", async () => {
    const a = { lng: 120.2, lat: 36.0 };
    const b = { lng: 120.4, lat: 36.2 };
    const c = { lng: 120.5, lat: 35.95 };
    const { distances, durations } = await client.drivingMatrix({ locations: [a, b, c] });
    assert.equal(distances.length, 3);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(distances[i][i], 0);
      assert.equal(durations[i][i], 0);
      for (let j = 0; j < 3; j += 1) {
        assert.equal(distances[i][j], distances[j][i], `symmetry ${i},${j}`);
        assert.equal(durations[i][j], Math.round(distances[i][j] / 11), `duration ${i},${j}`);
        assert.equal(Number.isInteger(distances[i][j]), true);
      }
    }
    assert.ok(distances[0][1] > 20_000 && distances[0][1] < 60_000, String(distances[0][1]));
    await assert.rejects(client.drivingMatrix({ locations: [a] }), TypeError);
    await assert.rejects(
      client.drivingMatrix({ locations: Array.from({ length: 10 }, () => a) }),
      TypeError,
    );
  });

  it("routes deterministically through waypoints with zero tolls and a stub step", async () => {
    const origin = { lng: 120.15, lat: 35.98 };
    const waypoint = { lng: 120.3, lat: 36.1 };
    const destination = { lng: 120.5, lat: 36.3 };
    const route = await client.drivingRoute({ origin, destination, waypoints: [waypoint] });
    const matrix = await client.drivingMatrix({ locations: [origin, waypoint, destination] });
    assert.equal(route.distanceMeters, matrix.distances[0][1] + matrix.distances[1][2]);
    assert.equal(route.durationSeconds, Math.round(route.distanceMeters / 11));
    assert.equal(route.tollsCny, 0);
    assert.equal(route.trafficLights, 2);
    assert.deepEqual(route.polyline, [origin, waypoint, destination]);
    assert.equal(route.steps.length, 1);
    assert.equal(route.steps[0].instruction, "沿演示路线行驶");
    const replay = await client.drivingRoute({ origin, destination, waypoints: [waypoint] });
    assert.deepEqual(replay, route);
    await assert.rejects(
      client.drivingRoute({ origin, destination, waypoints: Array.from({ length: 8 }, () => waypoint) }),
      TypeError,
    );
  });
});
