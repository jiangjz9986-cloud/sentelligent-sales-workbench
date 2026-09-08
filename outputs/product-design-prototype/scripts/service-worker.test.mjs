import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  isServiceWorkerDisabled,
  registerServiceWorker,
} from "../src/app/registerServiceWorker.js";

describe("service worker registration", () => {
  it("skips registration in development builds", () => {
    const source = readFileSync(resolve("src/app/registerServiceWorker.js"), "utf8");
    assert.match(source, /import\.meta\.env\.DEV/);
  });

  it("honors the disable switch before registering", () => {
    const source = readFileSync(resolve("src/app/registerServiceWorker.js"), "utf8");
    assert.match(source, /sentelligent_disable_sw/);
    assert.match(source, /unregisterServiceWorkers/);
  });

  it("registers from the normalized workbench base path", () => {
    const source = readFileSync(resolve("src/app/registerServiceWorker.js"), "utf8");
    assert.match(source, /navigator\.serviceWorker\.register\(serviceWorkerUrl\(\)/);
    assert.match(source, /scope: serviceWorkerScope\(\)/);
  });

  it("reloads once per page when a new worker takes control", () => {
    const source = readFileSync(resolve("src/app/useServiceWorkerUpdate.js"), "utf8");
    assert.match(source, /let reloadRequested = false/);
    assert.match(source, /if \(reloadRequested\) return/);
    assert.doesNotMatch(source, /sw_reload_guard/);
  });

  it("configures generated workers to activate and claim clients automatically", () => {
    const configSource = readFileSync(resolve("vite.config.mjs"), "utf8");
    assert.match(configSource, /strategies:\s*"generateSW"/);
    assert.match(configSource, /registerType:\s*"autoUpdate"/);
    assert.match(configSource, /skipWaiting:\s*true/);
    assert.match(configSource, /clientsClaim:\s*true/);
  });

  it("builds a sw.js asset that skips waiting and claims clients", () => {
    const distSw = resolve("dist/sw.js");
    assert.equal(existsSync(distSw), true, "dist/sw.js is missing; run the production build first");
    const sw = readFileSync(distSw, "utf8");
    assert.match(sw, /precache/);
    assert.match(sw, /startsWith\("\/api\/"\)/);
    assert.match(sw, /self\.skipWaiting\(\)/);
    assert.match(sw, /clientsClaim\(\)/);
    assert.doesNotMatch(sw, /SKIP_WAITING/);
  });

  it("exports a safe disabled check for tests", () => {
    assert.equal(typeof isServiceWorkerDisabled(), "boolean");
    assert.equal(typeof registerServiceWorker, "function");
  });
});
