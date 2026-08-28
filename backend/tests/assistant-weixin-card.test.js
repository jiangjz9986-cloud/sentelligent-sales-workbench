import assert from "node:assert/strict";
import test from "node:test";

import { weixinCard, weixinClip, weixinShortId, weixinValue } from "../src/assistant/weixinCard.js";

test("weixinCard matches the bookkeeping layout", () => {
  assert.equal(
    weixinCard("小小提醒！新增一条拜访记录", [
      ["时间", "2026-08-28"],
      ["客户", "莒县人民医院"],
      ["诉求", "补齐材料"],
    ], "请回复“确认”或“取消”。"),
    [
      "【小小提醒！新增一条拜访记录】",
      "时间：2026-08-28",
      "客户：莒县人民医院",
      "诉求：补齐材料",
      "",
      "请回复“确认”或“取消”。",
    ].join("\n"),
  );
});

test("weixinCard skips blank labels and undefined values, keeps explicit empty placeholders", () => {
  assert.equal(
    weixinCard("客户画像", [
      ["名称", "日照市中医医院"],
      ["摘要", undefined],
      [null, "x"],
      ["别名", []],
    ]),
    [
      "【客户画像】",
      "名称：日照市中医医院",
      "别名：待确认",
    ].join("\n"),
  );
});

test("weixin helpers clip long copy and shorten ids like bookkeeping numbers", () => {
  assert.equal(weixinValue(""), "待确认");
  assert.equal(weixinValue(["甲", "乙"]), "甲、乙");
  assert.equal(weixinClip("一二三四五六七八九十", 4), "一二三四…");
  assert.equal(weixinShortId("quick-record-ture-1"), "…ture-1");
  assert.equal(weixinShortId("abc"), "abc");
});
