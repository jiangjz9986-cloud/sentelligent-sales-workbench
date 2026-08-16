import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NOTICE_TYPES,
  RELEVANCE_LEVELS,
  normalizeNoticeSnapshot,
} from "../src/hospitalTender/repository.js";
import { matchNoticeToCustomers } from "../src/hospitalTender/matching.js";

function notice(overrides = {}) {
  return {
    id: "notice-1",
    identityKey: "source-a:item-1",
    sourceId: "source-a",
    sourceName: "示例采购平台",
    city: "青岛市",
    title: "青岛市中心医院 PACS 存储扩容项目招标公告",
    url: "https://example.com/notices/1",
    publishedAt: "2026-08-16T08:00:00.000Z",
    noticeType: NOTICE_TYPES[0],
    purchaser: "青岛市中心医院",
    projectCode: "QDSZX-2026-01",
    budgetText: "人民币 500 万元",
    deadlineText: "2026-09-01",
    contentText: "采购 PACS 双活存储、备份和运维服务。",
    hospitalNames: ["青岛市中心医院"],
    sourceItemId: "item-1",
    contentSha256: "a".repeat(64),
    relevance: RELEVANCE_LEVELS[0],
    ...overrides,
  };
}

describe("hospital tender notice normalization", () => {
  it("returns a bounded canonical snapshot without retaining caller arrays", () => {
    const input = notice({ hospitalNames: ["  青岛市中心医院  "] });
    const normalized = normalizeNoticeSnapshot(input);

    assert.equal(normalized.title, input.title);
    assert.deepEqual(normalized.hospitalNames, ["青岛市中心医院"]);
    input.hospitalNames.push("另一个医院");
    assert.deepEqual(normalized.hospitalNames, ["青岛市中心医院"]);
  });

  it("fails closed for URL protocols, enums, lengths, and array bounds", () => {
    assert.throws(() => normalizeNoticeSnapshot(notice({ url: "javascript:alert(1)" })), /url/i);
    assert.throws(() => normalizeNoticeSnapshot(notice({ url: "ftp://example.com/a" })), /url/i);
    assert.throws(() => normalizeNoticeSnapshot(notice({ noticeType: "unknown" })), /noticeType/i);
    assert.throws(() => normalizeNoticeSnapshot(notice({ relevance: "unknown" })), /relevance/i);
    assert.throws(() => normalizeNoticeSnapshot(notice({ title: "x".repeat(2001) })), /title/i);
    assert.throws(
      () => normalizeNoticeSnapshot(notice({ hospitalNames: Array.from({ length: 51 }, () => "医院") })),
      /hospitalNames/i,
    );
  });
});

describe("hospital tender customer matching", () => {
  it("matches only against supplied customer snapshots and reports evidence", () => {
    const customer = {
      id: "customer-1",
      name: "青岛市中心医院",
      city: "青岛市",
      needs: ["PACS 双活", "灾备存储"],
      aliases: ["青岛中心医院"],
    };
    const result = matchNoticeToCustomers(notice(), [customer]);

    assert.deepEqual(result.matchedCustomerIds, ["customer-1"]);
    assert.deepEqual(result.matchReasons["customer-1"], ["hospital_name", "city", "need"]);
    assert.deepEqual(result.matchedNeeds["customer-1"], ["PACS 双活"]);
    assert.equal(result.matchScore, 100);
    assert.deepEqual(customer.needs, ["PACS 双活", "灾备存储"]);
  });

  it("does not infer or write a customer when the snapshot has no evidence", () => {
    const result = matchNoticeToCustomers(notice({
      city: "济南市",
      title: "办公家具采购",
      purchaser: null,
      projectCode: null,
      contentText: null,
      hospitalNames: [],
    }), [
      { id: "customer-1", name: "青岛市中心医院", city: "青岛市", needs: ["PACS 双活"] },
    ]);

    assert.deepEqual(result, {
      matchedCustomerIds: [],
      matchReasons: {},
      matchedNeeds: {},
      matchScore: 0,
    });
  });

  it("rejects malformed customer snapshots instead of guessing", () => {
    assert.throws(() => matchNoticeToCustomers(notice(), [{ name: "没有脱敏 id" }]), /customer.*id/i);
    assert.throws(() => matchNoticeToCustomers(notice(), [{ id: "customer-1", needs: ["x".repeat(2001)] }]), /needs/i);
  });
});
