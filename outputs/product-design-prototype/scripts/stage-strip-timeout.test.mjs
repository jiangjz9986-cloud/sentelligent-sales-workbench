import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_STAGE_STRIP_BROWSER_TIMEOUT_MS,
  resolveStageStripBrowserTimeoutMs,
} from "./stage-strip-timeout.mjs";

const stageStripDataTestSource = readFileSync(
  new URL("./stage-strip-data.test.mjs", import.meta.url),
  "utf8",
);

test("uses a bounded 60-second default for slow first Chrome startup", () => {
  assert.equal(DEFAULT_STAGE_STRIP_BROWSER_TIMEOUT_MS, 60_000);
  assert.equal(resolveStageStripBrowserTimeoutMs({}), 60_000);
  assert.equal(resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "" }), 60_000);
  assert.equal(resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "1000" }), 1_000);
  assert.equal(resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "120000" }), 120_000);
});

test("rejects unsafe timeout overrides instead of removing the upper bound", () => {
  const expectedError = /integer between 1000 and 120000 milliseconds/;

  assert.throws(
    () => resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "999" }),
    expectedError,
  );
  assert.throws(
    () => resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "1000.5" }),
    expectedError,
  );
  assert.throws(
    () => resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "120001" }),
    expectedError,
  );
  assert.throws(
    () => resolveStageStripBrowserTimeoutMs({ STAGE_STRIP_BROWSER_TIMEOUT_MS: "not-a-number" }),
    expectedError,
  );
});

test("validates the timeout before creating a temp directory or launching Chrome", () => {
  const renderFixtureStart = stageStripDataTestSource.indexOf("async function renderFixture(name)");
  const timeoutResolution = stageStripDataTestSource.indexOf(
    "const browserTimeoutMs = resolveStageStripBrowserTimeoutMs();",
    renderFixtureStart,
  );
  const tempDirectoryCreation = stageStripDataTestSource.indexOf("mkdtempSync(", renderFixtureStart);
  const chromeLaunch = stageStripDataTestSource.indexOf("browser = spawn(", renderFixtureStart);

  assert.ok(renderFixtureStart >= 0, "renderFixture must exist");
  assert.ok(timeoutResolution > renderFixtureStart, "renderFixture must resolve the timeout");
  assert.ok(timeoutResolution < tempDirectoryCreation, "timeout validation must happen before temp directory creation");
  assert.ok(timeoutResolution < chromeLaunch, "timeout validation must happen before Chrome launch");
});
