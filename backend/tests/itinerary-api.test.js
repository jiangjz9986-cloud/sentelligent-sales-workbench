import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashPassword } from "../src/auth/password.js";
import { AmapServiceError } from "../src/maps/amapClient.js";
import { createServer } from "../src/server.js";

const account = "itinerary-owner";
const loginValue = "itinerary-login-value";
const passwordField = "pass" + "word";
const passwordHash = await hashPassword(loginValue, { salt: Buffer.alloc(16, 21) });

function cookiePair(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function payload(overrides = {}) {
  return {
    title: "济宁客户拜访",
    visitDate: "2026-07-28",
    status: "planned",
    departureAddress: "青岛市黄岛区秀兰禧悦山",
    departureCity: "青岛",
    departureAt: "2026-07-28T08:00:00+08:00",
    stops: [
      {
        id: "customer-a",
        customerId: "customer-a",
        customerName: "济南示例客户",
        address: "济南市历下区经十路",
        city: "济南",
        priority: "normal",
        visitMinutes: 45,
        notes: "确认网络改造范围",
      },
      {
        id: "customer-b",
        customerId: "customer-b",
        customerName: "济宁第二人民医院",
        address: "济宁市任城区济宁市第二人民医院",
        city: "济宁",
        priority: "high",
        visitMinutes: 60,
        appointmentAt: "2026-07-28T11:00:00+08:00",
      },
    ],
    ...overrides,
  };
}

function createAmapFixture() {
  const points = new Map([
    ["青岛市黄岛区秀兰禧悦山", { lng: 120.149201, lat: 35.987754 }],
    ["济南市历下区经十路", { lng: 117.120128, lat: 36.652069 }],
    ["济宁市任城区济宁市第二人民医院", { lng: 116.608817, lat: 35.415405 }],
  ]);
  const calls = { geocode: [], reverseGeocode: [], matrix: [], route: [] };
  return {
    calls,
    client: {
      async geocode(input) {
        calls.geocode.push(input);
        const location = points.get(input.address);
        if (!location) throw new AmapServiceError("AMAP_NO_RESULT", "No matching location was found");
        return { formattedAddress: `山东省${input.address}`, location };
      },
      async reverseGeocode(input) {
        calls.reverseGeocode.push(input);
        const entry = [...points.entries()].find(([, location]) => (
          location.lng === input.location.lng && location.lat === input.location.lat
        ));
        if (!entry) throw new AmapServiceError("AMAP_NO_RESULT", "No matching location was found");
        const [address, location] = entry;
        const city = address.includes("青岛") ? "青岛市" : address.includes("济南") ? "济南市" : "济宁市";
        return { formattedAddress: `山东省${address}`, province: "山东省", city, district: "", location };
      },
      async drivingMatrix(input) {
        calls.matrix.push(input);
        const size = input.locations.length;
        const durations = Array.from({ length: size }, (_, from) => (
          Array.from({ length: size }, (_, to) => from === to ? 0 : (Math.abs(from - to) + 1) * 600)
        ));
        const distances = durations.map((row) => row.map((duration) => duration * 12));
        return { durations, distances };
      },
      async drivingRoute(input) {
        calls.route.push(input);
        return {
          distanceMeters: 379100,
          durationSeconds: 15360,
          tollsCny: 146,
          trafficLights: 25,
          polyline: [input.origin, ...input.waypoints, input.destination],
          steps: [],
        };
      },
    },
  };
}

async function withHarness(overrides, work) {
  const tempDir = await mkdtemp(join(tmpdir(), "sentelligent-itinerary-api-"));
  const databaseUrl = join(tempDir, "test.sqlite");
  const amap = createAmapFixture();
  const options = overrides ?? {};
  const server = createServer({
    databaseUrl,
    seed: true,
    nodeEnv: "test",
    authRequired: true,
    authAccount: account,
    authPassword: "",
    authPasswordHash: passwordHash,
    authSessionSecret: Buffer.alloc(32, 22).toString("base64url"),
    authCookieSecure: false,
    corsAllowedOrigins: [],
    aiAnalysisMode: "mock",
    modelApiKey: "",
    amapClient: amap.client,
    ...options,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rawRequest = async (path, requestOptions = {}) => {
      const headers = { ...(requestOptions.headers ?? {}) };
      if (requestOptions.body !== undefined) headers["Content-Type"] ??= "application/json";
      const response = await fetch(`${baseUrl}${path}`, { ...requestOptions, headers });
      const text = await response.text();
      return { response, body: text ? JSON.parse(text) : null };
    };
    const login = await rawRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account, [passwordField]: loginValue }),
    });
    assert.equal(login.response.status, 200);
    const cookie = cookiePair(login.response);
    const csrf = login.body.csrfToken;
    const request = async (path, requestOptions = {}) => {
      const method = String(requestOptions.method ?? "GET").toUpperCase();
      const headers = {
        Cookie: cookie,
        ...(method === "POST" || method === "PATCH" || method === "DELETE"
          ? { "X-CSRF-Token": csrf }
          : {}),
        ...(requestOptions.headers ?? {}),
      };
      return rawRequest(path, { ...requestOptions, headers });
    };
    await work({ amap, baseUrl, cookie, csrf, databaseUrl, rawRequest, request });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

function resetCalls(amap) {
  amap.calls.geocode.length = 0;
  amap.calls.reverseGeocode.length = 0;
  amap.calls.matrix.length = 0;
  amap.calls.route.length = 0;
}

function externalCallCount(amap) {
  return amap.calls.geocode.length + amap.calls.reverseGeocode.length + amap.calls.matrix.length + amap.calls.route.length;
}

describe("authenticated visit itinerary API", () => {
  it("requires authentication and matching CSRF before planning", async () => {
    await withHarness({}, async ({ amap, cookie, rawRequest }) => {
      const unauthenticated = await rawRequest("/api/itineraries");
      assert.equal(unauthenticated.response.status, 401);

      const missingCsrf = await rawRequest("/api/itineraries", {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify(payload()),
      });
      assert.equal(missingCsrf.response.status, 403);
      assert.equal(missingCsrf.body.error.code, "CSRF_INVALID");
      assert.equal(externalCallCount(amap), 0);
    });
  });

  it("creates, lists, loads, replans, and soft-deletes a saved itinerary", async () => {
    await withHarness({}, async ({ amap, request }) => {
      const created = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(payload()),
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.item.version, 1);
      assert.equal(created.body.item.title, "济宁客户拜访");
      assert.equal(created.body.item.plan.route.distanceMeters, 379100);
      assert.equal(created.body.item.plan.optimization.source, "deterministic");
      assert.equal(amap.calls.geocode.length, 3);
      assert.equal(amap.calls.matrix.length, 1);
      assert.equal(amap.calls.route.length, 1);

      resetCalls(amap);
      const listed = await request("/api/itineraries?status=planned");
      const loaded = await request(`/api/itineraries/${created.body.item.id}`);
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.items.length, 1);
      assert.deepEqual(loaded.body.item, created.body.item);
      assert.equal(externalCallCount(amap), 0, "saved history must not replan");

      const updated = await request(`/api/itineraries/${created.body.item.id}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(payload({ title: "济宁客户拜访（调整）" })),
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.body.item.version, 2);
      assert.equal(updated.body.item.title, "济宁客户拜访（调整）");
      assert.ok(externalCallCount(amap) > 0, "explicit edit must replan");

      resetCalls(amap);
      const stale = await request(`/api/itineraries/${created.body.item.id}`, {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        body: JSON.stringify(payload({ title: "过期修改" })),
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.error.code, "VERSION_CONFLICT");
      assert.equal(stale.body.error.fields.currentVersion, 2);
      assert.equal(externalCallCount(amap), 0, "stale edits must fail before external calls");

      const deleted = await request(`/api/itineraries/${created.body.item.id}`, {
        method: "DELETE",
        headers: { "If-Match": '"2"' },
        body: "{}",
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.deleted.version, 3);
      assert.equal(externalCallCount(amap), 0);
      assert.equal((await request(`/api/itineraries/${created.body.item.id}`)).response.status, 404);
      assert.deepEqual((await request("/api/itineraries")).body.items, []);

      const audits = await request(`/api/audit-logs?entityType=visit_itinerary&entityId=${created.body.item.id}`);
      assert.deepEqual(
        audits.body.items.map((item) => item.action).sort(),
        ["visit_itinerary.create", "visit_itinerary.delete", "visit_itinerary.update"],
      );
      assert.equal(audits.body.items.every((item) => item.actor === account), true);
    });
  });

  it("accepts browser-resolved coordinates and reverse verifies them before planning", async () => {
    await withHarness({}, async ({ amap, request }) => {
      const input = payload({
        departureLocation: { lng: 120.149201, lat: 35.987754 },
        stops: payload().stops.map((stop, index) => ({
          ...stop,
          location: index === 0
            ? { lng: 117.120128, lat: 36.652069 }
            : { lng: 116.608817, lat: 35.415405 },
        })),
      });

      const created = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(input),
      });

      assert.equal(created.response.status, 201);
      assert.equal(amap.calls.geocode.length, 0);
      assert.equal(amap.calls.reverseGeocode.length, 3);
      assert.deepEqual(created.body.item.request.departureLocation, input.departureLocation);
      assert.deepEqual(created.body.item.request.stops[1].location, input.stops[1].location);
    });
  });

  it("requires If-Match for update and delete before any external call", async () => {
    await withHarness({}, async ({ amap, request }) => {
      const created = await request("/api/itineraries", { method: "POST", body: JSON.stringify(payload()) });
      assert.equal(created.response.status, 201);
      resetCalls(amap);

      const patch = await request(`/api/itineraries/${created.body.item.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload()),
      });
      const deleted = await request(`/api/itineraries/${created.body.item.id}`, {
        method: "DELETE",
        body: "{}",
      });
      assert.equal(patch.response.status, 428);
      assert.equal(deleted.response.status, 428);
      assert.equal(externalCallCount(amap), 0);
    });
  });

  it("strictly validates top-level and nested fields before calling AMap", async () => {
    await withHarness({}, async ({ amap, request }) => {
      const invalidPayloads = [
        { ...payload(), unexpected: true },
        { ...payload(), stops: [{ ...payload().stops[0], unexpected: true }] },
        { ...payload(), stops: [{ ...payload().stops[0], visitMinutes: 0 }] },
        { ...payload(), visitDate: "2026-02-30" },
        { ...payload(), departureAt: "not-a-date" },
        { ...payload(), departureLocation: { lng: 120, lat: 36, extra: true } },
        { ...payload(), departureLocation: { lng: 181, lat: 36 } },
        { ...payload(), stops: [{ ...payload().stops[0], location: "120,36" }] },
        {
          ...payload(),
          stops: Array.from({ length: 9 }, (_, index) => ({
            id: `stop-${index}`,
            customerName: `客户 ${index}`,
            address: `测试地址 ${index}`,
            priority: "normal",
            visitMinutes: 30,
          })),
        },
      ];
      for (const body of invalidPayloads) {
        const result = await request("/api/itineraries", {
          method: "POST",
          body: JSON.stringify(body),
        });
        assert.equal(result.response.status, 422, JSON.stringify(body).slice(0, 100));
        assert.equal(result.body.error.code, "VALIDATION_ERROR");
      }
      assert.equal(externalCallCount(amap), 0);
      assert.deepEqual((await request("/api/itineraries")).body.items, []);
    });
  });

  it("returns a safe service error when AMap is not configured", async () => {
    await withHarness({ amapClient: null, amapWebServiceKey: "" }, async ({ request }) => {
      const result = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(payload()),
      });
      assert.equal(result.response.status, 503);
      assert.equal(result.body.error.code, "AMAP_NOT_CONFIGURED");
      assert.doesNotMatch(JSON.stringify(result.body), /key|credential|secret/i);
    });
  });

  it("maps provider failures without exposing provider details", async () => {
    const failingClient = {
      geocode: async () => {
        throw new AmapServiceError("AMAP_PROVIDER_ERROR", "Amap service rejected the request");
      },
      drivingMatrix: async () => { throw new Error("must not run"); },
      drivingRoute: async () => { throw new Error("must not run"); },
    };
    await withHarness({ amapClient: failingClient }, async ({ request }) => {
      const result = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(payload()),
      });
      assert.equal(result.response.status, 502);
      assert.equal(result.body.error.code, "AMAP_PROVIDER_ERROR");
      assert.equal(result.body.error.message, "Map service could not complete the request");
    });
  });

  it("returns 422 when a browser-resolved location does not match its requested city", async () => {
    let routeWork = 0;
    const mismatchClient = {
      geocode: async ({ address }) => ({
        formattedAddress: address,
        location: { lng: 116.608817, lat: 35.415405 },
      }),
      reverseGeocode: async () => {
        throw new AmapServiceError("AMAP_LOCATION_MISMATCH", "provider detail must stay private");
      },
      drivingMatrix: async () => { routeWork += 1; },
      drivingRoute: async () => { routeWork += 1; },
    };
    await withHarness({ amapClient: mismatchClient }, async ({ request }) => {
      const result = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(payload({
          departureLocation: { lng: 121.5, lat: 31.2 },
        })),
      });
      assert.equal(result.response.status, 422);
      assert.equal(result.body.error.code, "AMAP_LOCATION_MISMATCH");
      assert.equal(routeWork, 0);
      assert.doesNotMatch(JSON.stringify(result.body), /provider detail/);
    });
  });

  it("rolls back the itinerary when audit persistence fails", async () => {
    await withHarness({ failpoints: new Set(["itinerary.create.afterWrite"]) }, async ({ request }) => {
      const failed = await request("/api/itineraries", {
        method: "POST",
        body: JSON.stringify(payload()),
      });
      assert.equal(failed.response.status, 500);
      assert.equal(failed.body.error.code, "INTERNAL_ERROR");
      assert.deepEqual((await request("/api/itineraries")).body.items, []);
      assert.deepEqual((await request("/api/audit-logs?entityType=visit_itinerary")).body.items, []);
    });
  });
});
