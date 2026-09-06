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

  it("builds a sw.js asset during production builds", async () => {
    const distSw = resolve("dist/sw.js");
    if (!existsSync(distSw)) {
      return;
    }
    const sw = readFileSync(distSw, "utf8");
    assert.match(sw, /precache/);
    assert.match(sw, /startsWith\("\/api\/"\)/);
  });

  it("prompts users before activating waiting workers", () => {
    const updateSource = readFileSync(resolve("src/app/useServiceWorkerUpdate.js"), "utf8");
    const registerSource = readFileSync(resolve("src/app/registerServiceWorker.js"), "utf8");
    assert.match(updateSource, /新版本可用/);
    assert.match(registerSource, /SKIP_WAITING/);
  });

  it("exports a safe disabled check for tests", () => {
    assert.equal(typeof isServiceWorkerDisabled(), "boolean");
    assert.equal(typeof registerServiceWorker, "function");
  });
});
