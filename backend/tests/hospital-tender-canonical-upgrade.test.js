import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { apply as applyCanonicalBridgeMigration } from "../src/db/migrations/0043_hospital_tender_canonical_bridge.mjs";
import {
  contentDigest,
  createHospitalTenderRepository,
} from "../src/hospitalTender/repository.js";

function createPre0043Database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE hospital_tender_notices (
      id TEXT PRIMARY KEY NOT NULL,
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
      hospital_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hospital_names_json)),
      source_item_id TEXT,
      content_sha256 TEXT,
      relevance TEXT NOT NULL,
      match_customer_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(match_customer_ids_json)),
      match_reasons_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(match_reasons_json)),
      matched_needs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(matched_needs_json)),
      match_score INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertLegacyNotice(db, {
  id,
  identityKey,
  sourceId,
  sourceName,
  url,
  sourceItemId,
}) {
  const contentText = "采购 PACS 双活存储。";
  db.prepare(`
    INSERT INTO hospital_tender_notices (
      id, identity_key, source_id, source_name, city, title, url,
      published_at, notice_type, purchaser, project_code, budget_text,
      deadline_text, content_text, hospital_names_json, source_item_id,
      content_sha256, relevance, first_seen_at, last_seen_at
    ) VALUES (
      $id, $identityKey, $sourceId, $sourceName, '青岛市',
      '青岛市中心医院 PACS 存储扩容项目', $url,
      '2026-08-30T08:00:00.000Z', 'tender', '青岛市中心医院',
      'QDSZX-2026-01', '人民币 500 万元', '2026-09-10', $contentText,
      '["青岛市中心医院"]', $sourceItemId, $contentSha256, 'high',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z'
    )
  `).run({
    $id: id,
    $identityKey: identityKey,
    $sourceId: sourceId,
    $sourceName: sourceName,
    $url: url,
    $sourceItemId: sourceItemId,
    $contentText: contentText,
    $contentSha256: contentDigest(contentText),
  });
}

function incomingDuplicate() {
  return {
    id: "source-c-row",
    identityKey: "source-c:item-777",
    sourceId: "source-c",
    sourceName: "公开采购平台 C",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目",
    url: "https://source-c.example/notices/777",
    publishedAt: "2026-08-30T08:00:00.000Z",
    noticeType: "tender",
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-2026-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-10",
    contentText: "采购 PACS 双活存储。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-777",
    contentSha256: contentDigest("采购 PACS 双活存储。"),
    relevance: "high",
  };
}

describe("hospital tender canonical bridge upgrade", () => {
  it("fails closed deterministically for pre-0043 cross-source duplicates", () => {
    const db = createPre0043Database();
    try {
      insertLegacyNotice(db, {
        id: "legacy-source-a",
        identityKey: "source-a:item-1",
        sourceId: "source-a",
        sourceName: "公开采购平台 A",
        url: "https://source-a.example/notices/1",
        sourceItemId: "item-1",
      });
      insertLegacyNotice(db, {
        id: "legacy-source-b",
        identityKey: "source-b:item-99",
        sourceId: "source-b",
        sourceName: "公开采购平台 B",
        url: "https://source-b.example/notices/99",
        sourceItemId: "item-99",
      });

      applyCanonicalBridgeMigration(db);
      const repository = createHospitalTenderRepository(db, {
        clock: () => new Date("2026-09-06T00:00:00.000Z"),
      });
      const before = db.prepare(`
        SELECT id, identity_key, canonical_notice_id, canonical_revision,
               canonical_digest, last_seen_at
          FROM hospital_tender_notices
         ORDER BY id
      `).all();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
          () => repository.upsertNotice(incomingDuplicate(), {}),
          (error) => error?.status === 409
            && error?.code === "NOTICE_CANONICAL_AMBIGUITY"
            && error?.fields?.noticeIds?.length === 2,
        );
      }

      const after = db.prepare(`
        SELECT id, identity_key, canonical_notice_id, canonical_revision,
               canonical_digest, last_seen_at
          FROM hospital_tender_notices
         ORDER BY id
      `).all();
      assert.deepEqual(after, before);
      assert.equal(after.length, 2);
    } finally {
      db.close();
    }
  });
});
