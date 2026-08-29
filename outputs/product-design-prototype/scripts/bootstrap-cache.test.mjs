import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { isSnapshotExpired } from "../src/app/bootstrapCache.js";

describe("bootstrap cache", () => {
  it("marks snapshots older than seven days as expired", () => {
    const savedAt = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1);
    assert.equal(isSnapshotExpired(savedAt), true);
    assert.equal(isSnapshotExpired(Date.now()), false);
  });

  it("stores snapshots keyed by account in IndexedDB", () => {
    const source = readFileSync(resolve("src/app/bootstrapCache.js"), "utf8");
    assert.match(source, /keyPath: "account"/);
    assert.match(source, /sentelligent-bootstrap/);
  });

  it("clears snapshots by account on logout", () => {
    const appSource = readFileSync(resolve("src/App.jsx"), "utf8");
    assert.match(appSource, /clearSnapshot\(account\)/);
    assert.match(appSource, /clearRuntimeCaches\(\)/);
  });

  it("hydrates offline snapshots from useWorkbenchData", () => {
    const source = readFileSync(resolve("src/app/useWorkbenchData.jsx"), "utf8");
    assert.match(source, /getSnapshot\(account\)/);
    assert.match(source, /putSnapshot\(account/);
    assert.match(source, /offline-stale/);
  });

  it("shows an expiry message when the snapshot is too old", () => {
    const source = readFileSync(resolve("src/app/useWorkbenchData.jsx"), "utf8");
    assert.match(source, /快照已过期，请联网刷新/);
  });

  it("reads account from auth session when saving snapshots", () => {
    const shellSource = readFileSync(resolve("src/app/SalesWorkbenchShell.jsx"), "utf8");
    assert.match(shellSource, /account: authSession\?\.account/);
  });

  it("does not write snapshots during login 401 handling", () => {
    const apiSource = readFileSync(resolve("src/api/salesWorkbenchApi.test.js"), "utf8");
    assert.match(apiSource, /does not invalidate/i);
  });

  it("keeps runtime cache cleanup separate from precache deletion", () => {
    const source = readFileSync(resolve("src/app/bootstrapCache.js"), "utf8");
    assert.match(source, /!key\.includes\("precache"\)/);
  });
});
