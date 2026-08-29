import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWeixinCardText } from "../src/components/assistant/weixinCardParse.js";

describe("weixinCardParse", () => {
  it("parses title, fields, and footer", () => {
    const parsed = parseWeixinCardText("【客户画像】\n名称：协和\n区域：北京\n\n请确认。");
    assert.equal(parsed.title, "客户画像");
    assert.deepEqual(parsed.fields, [["名称", "协和"], ["区域", "北京"]]);
    assert.equal(parsed.footer, "请确认。");
  });

  it("returns null for plain text", () => {
    assert.equal(parseWeixinCardText("普通回复"), null);
  });

  it("tolerates missing footer", () => {
    const parsed = parseWeixinCardText("【待确认】\n操作：删除客户");
    assert.equal(parsed.footer, null);
    assert.equal(parsed.fields.length, 1);
  });

  it("keeps empty field values", () => {
    const parsed = parseWeixinCardText("【卡片】\n摘要：");
    assert.deepEqual(parsed.fields, [["摘要", ""]]);
  });
});
