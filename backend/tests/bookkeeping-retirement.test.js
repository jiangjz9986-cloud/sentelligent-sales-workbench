import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createServer, isRetiredBookkeepingPath } from "../src/server.js";
import { openDatabase } from "../src/db.js";

describe("旧快捷指令/iCost 入口退役边界", () => {
  it("marks only the legacy write/settings paths as retired", () => {
    for (const path of [
      "/api/integrations/icost/expenses",
      "/api/integrations/shortcut/bookkeeping",
      "/api/integrations/shortcut/tokens",
      "/api/settings/icost-token/rotate",
    ]) assert.equal(isRetiredBookkeepingPath(path), true, path);
    assert.equal(isRetiredBookkeepingPath("/api/integrations/weixin-agent/events"), false);
    assert.equal(isRetiredBookkeepingPath("/api/integrations/weixin/bookkeeping/review"), false);
    assert.equal(isRetiredBookkeepingPath("/api/travel-expenses"), false);
  });

  it("returns 410 for retired interfaces in every normal environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookkeeping-retirement-"));
    const server = createServer({
      databaseUrl: join(dir, "retirement.sqlite"),
      seed: false,
      nodeEnv: "test",
      authRequired: false,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const path of [
        "/api/integrations/icost/expenses",
        "/api/integrations/shortcut/bookkeeping",
        "/api/integrations/shortcut/tokens",
        "/api/settings/icost-token/rotate",
      ]) {
        const response = await fetch(`${origin}${path}`, { method: "POST" });
        assert.equal(response.status, 410, path);
        const body = await response.json();
        assert.equal(body.error.code, "LEGACY_BOOKKEEPING_RETIRED");
      }
      const db = openDatabase({ databaseUrl: join(dir, "retirement.sqlite") });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_webhook_tokens").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shortcut_bookkeeping_entries").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM travel_expenses").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_documents").get().count, 0);
      db.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
