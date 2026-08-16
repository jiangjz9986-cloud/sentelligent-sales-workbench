import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ingestHospitalTenderSnapshot,
  normalizeHospitalTenderSyncPayload,
  serializeHospitalTenderNotice,
} from "../src/hospitalTender/sync.js";

function notice(overrides = {}) {
  return {
    identityKey: "source-a:item-1",
    sourceId: "source-a",
    sourceName: "公开采购平台",
    city: "日照市",
    title: "日照中医医院信息化采购",
    url: "https://example.test/notices/1",
    publishedAt: "2026-08-16T08:00:00.000Z",
    noticeType: "procurement",
    purchaser: "日照中医医院",
    contentText: "采购 HIS 和 PACS 系统",
    hospitalNames: ["日照中医医院"],
    contentSha256: "a".repeat(64),
    relevance: "high",
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    schemaVersion: "hospital-tender-snapshot-v1",
    generatedAt: "2026-08-16T10:00:00.000Z",
    notices: [notice()],
    sources: [],
    runs: [],
    ...overrides,
  };
}

describe("hospital tender sync contract", () => {
  it("maps collector vocabulary to the main-system enum and rejects raw fields", () => {
    const normalized = normalizeHospitalTenderSyncPayload(payload());
    assert.equal(normalized.notices[0].noticeType, "tender");
    assert.equal(normalized.notices[0].relevance, "high");
    assert.equal(
      normalizeHospitalTenderSyncPayload(payload({ notices: [notice({ noticeType: "terminated" })] }))
        .notices[0].noticeType,
      "bid_cancelled",
    );
    assert.throws(
      () => normalizeHospitalTenderSyncPayload(payload({ notices: [{ ...notice(), rawContent: "private" }] })),
      /not allowed/i,
    );
  });

  it("fails closed for invalid schema, URL and oversized arrays", () => {
    assert.throws(() => normalizeHospitalTenderSyncPayload(payload({ schemaVersion: "v2" })), /schemaVersion/i);
    assert.throws(() => normalizeHospitalTenderSyncPayload(payload({ notices: [notice({ url: "javascript:alert(1)" })] })), /url/i);
    assert.throws(() => normalizeHospitalTenderSyncPayload(payload({ notices: [notice({ hospitalNames: Array.from({ length: 51 }, () => "医院") })] })), /hospitalNames/i);
    assert.throws(() => normalizeHospitalTenderSyncPayload(payload({ sources: [{ sourceId: "s", sourceName: "S", status: "surprise" }] })), /status/i);
  });

  it("serializes match sidecars without exposing nested implementation details", () => {
    const item = {
      ...normalizeHospitalTenderSyncPayload(payload()).notices[0],
      id: "notice-1",
      firstSeenAt: "2026-08-16T10:00:00.000Z",
      lastSeenAt: "2026-08-16T10:00:00.000Z",
      match: {
        matchedCustomerIds: ["customer-1"],
        matchReasons: { "customer-1": ["hospital_name"] },
        matchedNeeds: { "customer-1": ["PACS"] },
        matchScore: 85,
      },
    };
    const serialized = serializeHospitalTenderNotice(item, new Map([["customer-1", "日照中医医院"]]));
    assert.deepEqual(serialized.matchedCustomerIds, ["customer-1"]);
    assert.deepEqual(serialized.matchedCustomerNames, ["日照中医医院"]);
    assert.equal("rawContent" in serialized, false);
  });

  it("matches only caller-provided customer snapshots and never mutates them", () => {
    const repository = {
      notices: [],
      upsertNotice(item, match) {
        this.notices.push({ item, match });
        return { ...item, id: "notice-1", firstSeenAt: item.publishedAt, lastSeenAt: item.publishedAt, match };
      },
      upsertSourceHealth() {},
      recordRun() {},
    };
    const customers = [{ id: "customer-1", name: "日照中医医院", city: "日照市", needs: ["PACS"], summary: "灾备平台建设" }];
    ingestHospitalTenderSnapshot({ repository, payload: payload(), customers });
    assert.deepEqual(repository.notices[0].match.matchedCustomerIds, ["customer-1"]);
    assert.deepEqual(customers[0].needs, ["PACS"]);
  });
});
