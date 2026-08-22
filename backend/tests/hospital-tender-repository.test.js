import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createConnection } from "../src/db/connection.js";
import {
  NOTICE_TYPES,
  RELEVANCE_LEVELS,
  createHospitalTenderRepository,
} from "../src/hospitalTender/repository.js";

let db;
let repository;
let idCounter;
let now;

function createTables() {
  db.exec(`
    CREATE TABLE hospital_tender_notices (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      city TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      published_at TEXT NOT NULL,
      notice_type TEXT NOT NULL,
      purchaser TEXT,
      project_code TEXT,
      budget_text TEXT,
      deadline_text TEXT,
      content_text TEXT,
      hospital_names_json TEXT NOT NULL,
      source_item_id TEXT,
      content_sha256 TEXT,
      relevance TEXT NOT NULL,
      match_customer_ids_json TEXT NOT NULL DEFAULT '[]',
      match_reasons_json TEXT NOT NULL DEFAULT '{}',
      matched_needs_json TEXT NOT NULL DEFAULT '{}',
      match_score INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE hospital_tender_sources (
      source_id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      status TEXT NOT NULL,
      last_run_at TEXT,
      last_success_at TEXT,
      last_item_count INTEGER NOT NULL DEFAULT 0,
      last_upserted_count INTEGER NOT NULL DEFAULT 0,
      last_rejected_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE hospital_tender_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      upserted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function notice(overrides = {}) {
  return {
    id: "notice-1",
    identityKey: "source-a:item-1",
    sourceId: "source-a",
    sourceName: "示例采购平台",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目",
    url: "https://example.com/notices/1",
    publishedAt: "2026-08-16T08:00:00.000Z",
    noticeType: NOTICE_TYPES[0],
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-2026-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-01",
    contentText: "采购 PACS 双活存储。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-1",
    contentSha256: "a".repeat(64),
    relevance: RELEVANCE_LEVELS[0],
    ...overrides,
  };
}

beforeEach(() => {
  db = createConnection({ databaseUrl: ":memory:" });
  createTables();
  idCounter = 0;
  now = "2026-08-16T10:00:00.000Z";
  repository = createHospitalTenderRepository(db, {
    idFactory: () => `notice-${++idCounter}`,
    clock: () => new Date(now),
  });
});

afterEach(() => db.close());

describe("hospital tender repository", () => {
  it("upserts by identity key without duplicating a notice", () => {
    const first = repository.upsertNotice(notice(), {
      matchedCustomerIds: ["customer-1"],
      matchReasons: { "customer-1": ["hospital_name"] },
      matchedNeeds: { "customer-1": ["PACS 双活"] },
      matchScore: 80,
    });
    now = "2026-08-16T11:00:00.000Z";
    const replay = repository.upsertNotice(notice({ id: "different-id", title: "更新后的公告" }), {
      matchedCustomerIds: [],
      matchReasons: {},
      matchedNeeds: {},
      matchScore: 0,
    });

    assert.equal(first.id, "notice-1");
    assert.equal(replay.id, first.id);
    assert.equal(replay.title, "更新后的公告");
    assert.equal(replay.firstSeenAt, "2026-08-16T10:00:00.000Z");
    assert.equal(replay.lastSeenAt, "2026-08-16T11:00:00.000Z");
    assert.equal(repository.listNotices().length, 1);
    assert.deepEqual(replay.match.matchedCustomerIds, []);
  });

  it("lists read-only notices with bounded filters and summarizes counts", () => {
    repository.upsertNotice(notice());
    repository.upsertNotice(notice({
      id: "notice-2",
      identityKey: "source-b:item-2",
      sourceId: "source-b",
      sourceName: "另一个采购平台",
      city: "济南市",
      title: "济南市人民医院服务器采购",
      url: "https://example.com/notices/2",
      publishedAt: "2026-08-15T08:00:00.000Z",
      relevance: RELEVANCE_LEVELS.at(-1),
    }));

    assert.equal(repository.listNotices({ sourceId: "source-a" }).length, 1);
    assert.equal(repository.countNotices({ sourceId: "source-a", limit: 1 }), 1);
    assert.equal(repository.countNotices({ limit: 1 }), 2);
    assert.equal(repository.listNotices({ city: "济南市" })[0].identityKey, "source-b:item-2");
    assert.equal(repository.listNotices({ limit: 1 }).length, 1);
    assert.throws(() => repository.listNotices({ limit: 201 }), /limit/i);

    const summary = repository.summary();
    assert.equal(summary.totalNotices, 2);
    assert.equal(summary.matchedNotices, 0);
    assert.equal(summary.byNoticeType[NOTICE_TYPES[0]], 2);
    assert.equal(summary.byRelevance[RELEVANCE_LEVELS[0]], 1);
    assert.equal(summary.highRelevanceCount, 1);
    assert.equal(summary.deadlineSoonCount, 0);
    assert.equal(summary.todayNewCount, 1);
    assert.equal(summary.latestPublishedAt, "2026-08-16T08:00:00.000Z");
  });

  it("applies customer and keyword filters before pagination", () => {
    repository.upsertNotice(notice({
      identityKey: "source-a:item-1",
      title: "无关公告",
    }), { matchedCustomerIds: ["customer-a"] });
    repository.upsertNotice(notice({
      id: "notice-2",
      identityKey: "source-a:item-2",
      url: "https://example.com/notices/2",
      publishedAt: "2026-08-15T08:00:00.000Z",
      title: "目标医院 PACS 招标公告",
    }), { matchedCustomerIds: ["customer-b"] });

    const customerMatches = repository.listNotices({ customerId: "customer-b", limit: 1 });
    assert.equal(customerMatches.length, 1);
    assert.equal(customerMatches[0].identityKey, "source-a:item-2");
    assert.equal(
      repository.listNotices({ query: "目标医院", limit: 1 })[0].identityKey,
      "source-a:item-2",
    );
  });

  it("records source health and run summaries without touching customer or opportunity tables", () => {
    const crmTablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('customers', 'opportunities') ORDER BY name").all();
    repository.upsertSourceHealth({
      sourceId: "source-a",
      sourceName: "示例采购平台",
      status: "healthy",
      lastRunAt: "2026-08-16T09:00:00.000Z",
      lastSuccessAt: "2026-08-16T09:00:00.000Z",
      lastItemCount: 10,
      lastUpsertedCount: 2,
      lastRejectedCount: 1,
    });
    const run = repository.recordRun({
      sourceId: "source-a",
      startedAt: "2026-08-16T09:00:00.000Z",
      finishedAt: "2026-08-16T09:01:00.000Z",
      status: "success",
      fetchedCount: 10,
      upsertedCount: 2,
      rejectedCount: 1,
    });

    assert.equal(run.id, "notice-1");
    assert.equal(repository.listSources()[0].status, "healthy");
    assert.equal(repository.health().status, "healthy");
    assert.equal(repository.health().sourceCount, 1);
    assert.equal(repository.summary().latestRun.id, run.id);
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('customers', 'opportunities') ORDER BY name").all(),
      crmTablesBefore,
    );
  });

  it("replays the same run idempotently", () => {
    const first = repository.recordRun({
      id: "run-1",
      sourceId: "source-a",
      startedAt: now,
      finishedAt: now,
      status: "success",
      fetchedCount: 1,
      upsertedCount: 1,
      rejectedCount: 0,
    });
    const replay = repository.recordRun({
      id: "run-1",
      sourceId: "source-a",
      startedAt: now,
      finishedAt: now,
      status: "success",
      fetchedCount: 1,
      upsertedCount: 1,
      rejectedCount: 0,
    });
    assert.equal(replay.id, first.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hospital_tender_runs").get().count, 1);
  });
});
