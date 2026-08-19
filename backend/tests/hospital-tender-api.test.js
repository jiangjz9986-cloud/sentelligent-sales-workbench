import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { assertApiCollection, assertApiEntity } from "../../shared/salesWorkbenchApiContract.mjs";
import { createConnection } from "../src/db/connection.js";
import { createServer } from "../src/server.js";

let tempDir;
let server;
let baseUrl;
const fixtureBearer = "fixture-hospital-sync";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function payload(overrides = {}) {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-08-16T10:00:00.000Z",
    notices: [{
      identityKey: "source-a:item-1",
      sourceId: "source-a",
      sourceName: "示例采购平台",
      city: "日照市",
      title: "日照中医医院 PACS 存储扩容中标公告",
      url: "https://example.com/notices/1",
      publishedAt: "2026-08-16T08:00:00.000Z",
      noticeType: "result",
      purchaser: "日照中医医院",
      projectCode: "RZ-2026-01",
      budgetText: "500 万元",
      deadlineText: "2026-09-01",
      contentText: "采购 PACS 双活存储和灾备服务。",
      hospitalNames: ["日照中医医院"],
      sourceItemId: "item-1",
      contentSha256: "a".repeat(64),
      relevance: "high",
    }],
    sources: [{
      sourceId: "source-a",
      sourceName: "示例采购平台",
      status: "healthy",
      lastRunAt: "2026-08-16T09:00:00.000Z",
      lastSuccessAt: "2026-08-16T09:00:00.000Z",
      lastItemCount: 1,
      lastUpsertedCount: 1,
      lastRejectedCount: 0,
    }],
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sentelligent-hospital-tender-api-"));
  server = createServer({
    databaseUrl: join(tempDir, "test.sqlite"),
    seed: true,
    authRequired: false,
    authAccount: "",
    authPassword: "",
    authPasswordHash: "",
    authSessionSecret: "",
    hospitalTenderSyncToken: fixtureBearer,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  server = null;
  tempDir = null;
});

describe("hospital tender monitor API", () => {
  it("accepts a machine snapshot, matches seeded customers, and exposes read-only views", async () => {
    const synced = await request("/api/integrations/hospital-tenders/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtureBearer}` },
      body: JSON.stringify(payload()),
    });
    assert.equal(synced.response.status, 200);
    assert.equal(synced.body.item.acceptedCount, 1);
    assert.equal(synced.body.item.rejectedCount, 0);
    assert.deepEqual(synced.body.item.notices[0].matchedCustomerIds, ["rizhao"]);

    const replayed = await request("/api/integrations/hospital-tenders/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtureBearer}` },
      body: JSON.stringify(payload()),
    });
    assert.equal(replayed.response.status, 200);
    assert.equal(replayed.body.item.summary.totalNotices, 1);

    const list = await request("/api/hospital-tenders?customerId=rizhao");
    assert.equal(list.response.status, 200);
    assertApiCollection("hospitalTenderNotice", list.body.items);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.limit, 50);
    assert.equal(list.body.offset, 0);
    assert.equal(list.body.hasMore, false);
    assert.equal(list.body.items[0].noticeType, "bid_result");
    assert.deepEqual(list.body.items[0].matchedCustomerIds, ["rizhao"]);

    const detail = await request(`/api/hospital-tenders/${encodeURIComponent(list.body.items[0].id)}`);
    assert.equal(detail.response.status, 200);
    assertApiEntity("hospitalTenderNotice", detail.body.item);

    const summary = await request("/api/hospital-tenders/summary");
    assert.equal(summary.response.status, 200);
    assertApiEntity("hospitalTenderSummary", summary.body.item);
    assert.equal(summary.body.item.totalNotices, 1);
    assert.equal(summary.body.item.highRelevanceCount, 1);
    assert.equal(Number.isSafeInteger(summary.body.item.deadlineSoonCount), true);
    assert.equal(Number.isSafeInteger(summary.body.item.todayNewCount), true);

    const sources = await request("/api/hospital-tenders/sources");
    assert.equal(sources.response.status, 200);
    assertApiCollection("hospitalTenderSource", sources.body.items);
    assert.equal(sources.body.items[0].status, "healthy");

    const health = await request("/api/hospital-tenders/health");
    assert.equal(health.response.status, 200);
    assertApiEntity("hospitalTenderHealth", health.body.item);
  });

  it("keeps the tender machine identity write-only and rejects raw payload fields", async () => {
    const customers = await request("/api/customers", {
      headers: { Authorization: `Bearer ${fixtureBearer}` },
    });
    assert.equal(customers.response.status, 403);
    assert.equal(customers.body.error.code, "MACHINE_SCOPE_DENIED");

    const invalid = await request("/api/integrations/hospital-tenders/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtureBearer}` },
      body: JSON.stringify(payload({ notices: [{ ...payload().notices[0], rawContent: "must not cross boundary" }] })),
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  });

  it("rolls back the snapshot when the sync audit write fails", async () => {
    const db = createConnection({ databaseUrl: join(tempDir, "test.sqlite") });
    db.exec(`
      CREATE TRIGGER reject_hospital_tender_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'hospital_tender.sync'
      BEGIN
        SELECT RAISE(ABORT, 'deterministic hospital tender audit failure');
      END;
    `);
    try {
      const failed = await request("/api/integrations/hospital-tenders/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${fixtureBearer}` },
        body: JSON.stringify(payload()),
      });
      assert.equal(failed.response.status, 500);
      assert.equal(failed.body.error.code, "INTERNAL_ERROR");
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_notices").get().count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_runs").get().count,
        0,
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_hospital_tender_audit");
      db.close();
    }
  });
});
