import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pollPostflightHealth,
  postflightHealthMatchesRollout,
  postflightHealthResponseMatchesRollout,
} from "./production-host.mjs";

test("P1 postflight accepts a disabled, local-simulated platform that is healthy", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "disabled", ready: true, executionMode: "local-simulated" },
  }, "P1"), true);
});

test("P1 postflight rejects an open or externally executing platform", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P1"), false);
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "disabled", ready: false, executionMode: "local-simulated" },
  }, "P1"), false);
});

test("postflight health accepts a ready response only after transient startup failures settle", async () => {
  let calls = 0;
  const result = await pollPostflightHealth("P1", {
    attempts: 3,
    retryMs: 0,
    sleepFn: async () => {},
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      if (calls === 2) return { status: 503, json: async () => ({ database: "starting" }) };
      return {
        status: 200,
        json: async () => ({
          database: "ready",
          aiPlatform: { mode: "disabled", ready: true, executionMode: "local-simulated" },
        }),
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(postflightHealthResponseMatchesRollout(result.status, result.health, "P1"), true);
});

test("postflight health response keeps the database and rollout checks strict", () => {
  assert.equal(postflightHealthResponseMatchesRollout(503, { database: "starting" }, "P1"), false);
  assert.equal(postflightHealthResponseMatchesRollout(200, {
    database: "ready",
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P1"), false);
});

test("postflight requires platform readiness after P1", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P3"), true);
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: false, executionMode: "external-provider" },
  }, "P3"), false);
});
