import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchNoticeToCustomers } from "../src/hospitalTender/matching.js";

function notice(overrides = {}) {
  return {
    identityKey: "test:notice", sourceId: "fixture", sourceName: "测试来源", city: "济宁市",
    title: "济宁市第一人民医院信息化采购", purchaser: "济宁市第一人民医院",
    url: "https://fixture.example/notice", publishedAt: "2026-10-20", noticeType: "procurement_notice",
    contentText: "采购信息化系统。", hospitalNames: ["济宁市第一人民医院"], relevance: "high",
    ...overrides,
  };
}

const customer = { id: "tcm", name: "济宁市中医院", city: "济宁市", needs: ["信息化"], aliases: ["济宁中医院"] };

describe("hospital tender formal hospital matching reliability", () => {
  it("keeps city plus need evidence out of formal associations", () => {
    const result = matchNoticeToCustomers(notice(), [customer]);
    assert.deepEqual(result, { matchedCustomerIds: [], matchReasons: {}, matchedNeeds: {}, matchScore: 0 });
  });

  it("blocks another hospital purchaser despite source array or body mentions", () => {
    const result = matchNoticeToCustomers(notice({
      hospitalNames: [customer.name], contentText: `${customer.name}也采购过信息化系统。`,
    }), [customer]);
    assert.deepEqual(result.matchedCustomerIds, []);
  });

  it("does not accept a hospital name that is merely a prefix of another hospital", () => {
    const result = matchNoticeToCustomers(notice({
      title: "济宁市中医院附属医院信息化采购", purchaser: "济宁市中医院附属医院",
      hospitalNames: ["济宁市中医院附属医院"],
    }), [customer]);
    assert.deepEqual(result.matchedCustomerIds, []);
  });

  it("accepts exact members of an explicit joint hospital purchaser list", () => {
    const first = { id: "first", name: "济宁市第一人民医院", city: "济宁市", needs: ["信息化"] };
    for (const separator of [" ", "、", "，", ";"]) {
      const result = matchNoticeToCustomers(notice({
        purchaser: `${first.name}${separator}${customer.name}`,
        hospitalNames: [first.name, customer.name],
      }), [first, customer, { ...customer, id: "other", name: "济宁市第二人民医院", aliases: [] }]);
      assert.deepEqual(result.matchedCustomerIds, [first.id, customer.id]);
    }
  });

  it("does not infer joint procurement from incidental aliases or a source hospital array", () => {
    for (const purchaser of ["济宁市第一人民医院", "济宁市第一人民医院（曾用名济宁市中医院）"]) {
      const result = matchNoticeToCustomers(notice({ purchaser, hospitalNames: [customer.name] }), [customer]);
      assert.deepEqual(result.matchedCustomerIds, []);
    }
  });

  it("accepts a controlled alias and punctuation-normalized name", () => {
    for (const purchaser of ["济宁中医院", "济宁市中医院（东院区）", "济中医", "济宁市中医院采购办公室"]) {
      const result = matchNoticeToCustomers(notice({ title: `${purchaser}信息化采购`, purchaser,
        hospitalNames: [purchaser] }), [{ ...customer, aliases: ["济宁中医院", "济宁市中医院(东院区)", "济中医"] }]);
      assert.deepEqual(result.matchedCustomerIds, [customer.id]);
      assert.ok(result.matchReasons[customer.id].includes("hospital_name"));
    }
  });

  it("accepts a named hospital with a procurement agent, but not generic hospital tokens or body-only mentions", () => {
    assert.deepEqual(matchNoticeToCustomers(notice({ title: "济宁市中医院信息化采购",
      purchaser: "济宁采购代理有限公司", hospitalNames: [customer.name] }), [customer]).matchedCustomerIds, [customer.id]);
    assert.deepEqual(matchNoticeToCustomers(notice(), [{ ...customer, aliases: ["医院", "信息化"] }]).matchedCustomerIds, []);
    assert.deepEqual(matchNoticeToCustomers(notice({ title: "某项目采购", purchaser: null,
      hospitalNames: [], contentText: `${customer.name}过往采购信息化系统案例` }), [customer]).matchedCustomerIds, []);
  });
});
