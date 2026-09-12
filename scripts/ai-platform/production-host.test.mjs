import assert from "node:assert/strict";
import { test } from "node:test";
import { postflightHealthMatchesRollout } from "./production-host.mjs";

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

test("postflight requires platform readiness after P1", () => {
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: true, executionMode: "external-provider" },
  }, "P3"), true);
  assert.equal(postflightHealthMatchesRollout({
    aiPlatform: { mode: "required", ready: false, executionMode: "external-provider" },
  }, "P3"), false);
});
