// Deterministic in-process stand-in for the Amap web-service client, used by
// isolated test stacks via AMAP_MODE=mock (production config rejects it).
// Same input always yields the same output so tests can assert exact values:
// geocode hashes the address into a Qingdao-area bounding box, distances are
// great-circle meters × 1.4, and durations assume ≈40 km/h (distance / 11).

import { createHash } from "node:crypto";

const MAX_ROUTE_LOCATIONS = 9;
const BBOX = Object.freeze({ lngMin: 120.1, lngMax: 120.6, latMin: 35.9, latMax: 36.4 });
const EARTH_RADIUS_METERS = 6_371_000;
const MOCK_REGION = Object.freeze({
  province: "山东省",
  city: "青岛市",
  district: "黄岛区",
  adcode: "370211",
});

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function normalizeLocation(value, name = "location") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must contain numeric lng and lat values`);
  }
  const lng = Number(value.lng);
  const lat = Number(value.lat);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new TypeError(`${name} must contain numeric lng and lat values`);
  }
  return { lng, lat };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function hashFraction(text, salt) {
  const digest = createHash("sha256").update(`${salt}:${text}`, "utf8").digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function greatCircleMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function mockDistanceMeters(a, b) {
  return Math.round(greatCircleMeters(a, b) * 1.4);
}

function mockDurationSeconds(distanceMeters) {
  return Math.round(distanceMeters / 11);
}

export function createMockAmapClient() {
  async function geocode({ address } = {}) {
    const normalized = requiredText(address, "address");
    const lng = round6(BBOX.lngMin + hashFraction(normalized, "lng") * (BBOX.lngMax - BBOX.lngMin));
    const lat = round6(BBOX.latMin + hashFraction(normalized, "lat") * (BBOX.latMax - BBOX.latMin));
    return {
      formattedAddress: normalized,
      ...MOCK_REGION,
      location: { lng, lat },
    };
  }

  async function reverseGeocode({ location } = {}) {
    const normalized = normalizeLocation(location);
    return {
      formattedAddress: `${MOCK_REGION.city}${MOCK_REGION.district}演示地址`,
      ...MOCK_REGION,
      location: normalized,
    };
  }

  async function drivingMatrix({ locations } = {}) {
    if (!Array.isArray(locations) || locations.length < 2 || locations.length > MAX_ROUTE_LOCATIONS) {
      throw new TypeError(`locations must contain between 2 and ${MAX_ROUTE_LOCATIONS} items`);
    }
    const normalized = locations.map((item, index) => normalizeLocation(item, `locations[${index}]`));
    const distances = normalized.map((origin) => normalized.map((destination) => (
      mockDistanceMeters(origin, destination)
    )));
    const durations = distances.map((row) => row.map(mockDurationSeconds));
    return { distances, durations };
  }

  async function drivingRoute({ origin, destination, waypoints = [] } = {}) {
    const normalizedOrigin = normalizeLocation(origin, "origin");
    const normalizedDestination = normalizeLocation(destination, "destination");
    if (!Array.isArray(waypoints) || waypoints.length + 2 > MAX_ROUTE_LOCATIONS) {
      throw new TypeError(`route must contain between 2 and ${MAX_ROUTE_LOCATIONS} locations`);
    }
    const points = [
      normalizedOrigin,
      ...waypoints.map((item, index) => normalizeLocation(item, `waypoints[${index}]`)),
      normalizedDestination,
    ];
    let distanceMeters = 0;
    for (let index = 1; index < points.length; index += 1) {
      distanceMeters += mockDistanceMeters(points[index - 1], points[index]);
    }
    const durationSeconds = mockDurationSeconds(distanceMeters);
    return {
      distanceMeters,
      durationSeconds,
      tollsCny: 0,
      trafficLights: 2,
      polyline: points,
      steps: [{
        instruction: "沿演示路线行驶",
        roadName: "演示路线",
        distanceMeters,
        durationSeconds,
      }],
    };
  }

  return { geocode, reverseGeocode, drivingMatrix, drivingRoute };
}
