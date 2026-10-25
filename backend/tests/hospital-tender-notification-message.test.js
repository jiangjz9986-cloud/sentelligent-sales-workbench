import assert from "node:assert/strict";
import test from "node:test";

import {
  hospitalTenderPushplusNoticeLine,
  prepareHospitalTenderPushplusNotices,
} from "../src/hospitalTender/notificationMessage.js";

test("PushPlus details are tidy, include the project budget, and prefer the public-platform URL", () => {
  const notice = {
    id: "notice-1",
    identityKey: "official:item-1",
    canonicalNoticeId: "canonical-notice-1",
    city: "济宁",
    title: "济宁市第一人民医院网络安全服务采购公告",
    purchaser: "济宁市第一人民医院",
    projectCode: "JN-2026-01",
    hospitalNames: ["济宁市第一人民医院"],
    publishedAt: "2026-09-30T00:00:00.000Z",
    sourceName: "济宁市第一人民医院",
    url: "https://hospital.example.test/notices/1",
    match: { matchedCustomerIds: ["customer-1"] },
  };
  const sourceNotices = [
    {
      identityKey: "official:item-1",
      sourceId: "hospital-jining-first",
      sourceName: "济宁市第一人民医院",
      title: notice.title,
      purchaser: notice.purchaser,
      projectCode: notice.projectCode,
      city: notice.city,
      hospitalNames: notice.hospitalNames,
      publishedAt: notice.publishedAt,
      url: notice.url,
    },
    {
      identityKey: "jining:item-88",
      sourceId: "jining-ggzy",
      sourceName: "济宁市公共资源交易公共服务平台",
      title: "济宁市第一人民医院网络安全服务采购公告",
      purchaser: notice.purchaser,
      projectCode: notice.projectCode,
      city: notice.city,
      hospitalNames: notice.hospitalNames,
      publishedAt: notice.publishedAt,
      contentText: "项目概况\n预算金额：人民币 323 万元",
      url: "https://www.jnsggzy.cn/JiNing/Posts/Detail?id=88",
    },
  ];
  const prepared = prepareHospitalTenderPushplusNotices({
    notices: [notice, { ...notice, id: "notice-duplicate", identityKey: "jining:item-88" }],
    sourceNotices,
    customers: [{ id: "customer-1", name: "济宁市第一人民医院" }],
  });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].url, sourceNotices[1].url);
  assert.equal(prepared[0].budgetText, "323万元");
  const line = hospitalTenderPushplusNoticeLine(prepared[0]);
  assert.match(line, /客户名称：.*济宁市第一人民医院/u);
  assert.match(line, /项目名称：.*网络安全服务采购公告/u);
  assert.match(line, /预算金额：.*323万元/u);
  assert.match(line, /时间：.*2026-09-30 08:00/u);
  assert.match(line, /查看公共资源交易平台公告/u);
  assert.match(line, /https:\/\/www\.jnsggzy\.cn\/JiNing\/Posts\/Detail\?id=88/u);
  assert.doesNotMatch(line, /hospital\.example\.test/u);
});

test("PushPlus budget parsing does not infer amounts from unlabeled project text", () => {
  const line = hospitalTenderPushplusNoticeLine({
    title: "医院采购 20 台服务器",
    contentText: "项目概况：采购 20 台服务器，服务周期 3 年。",
    publishedAt: "2026-09-30T00:00:00.000Z",
  });
  assert.match(line, /预算金额：.*公告未披露/u);
  assert.doesNotMatch(line, /预算金额：.*20/u);
  const missingValue = hospitalTenderPushplusNoticeLine({
    title: "医院采购公告",
    contentText: "预算金额：暂未披露，项目编号 2026-0099。",
    budgetText: "预算金额：暂未披露，项目编号 2026-0099。",
    publishedAt: "2026-09-30T00:00:00.000Z",
  });
  assert.match(missingValue, /预算金额：.*公告未披露/u);
  assert.doesNotMatch(missingValue, /预算金额：.*2026/u);
});
