import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBookkeepingAnalysis,
  classifyBookkeepingEntry,
  extractBookkeepingRows,
  mapBookkeepingCategory,
} from "../src/assistant/bookkeepingCapture.js";

describe("微信小小记账识别", () => {
  it("extracts a text-only expense amount and natural week fields without OCR", () => {
    const analysis = buildBookkeepingAnalysis({
      text: "2026年8月24日 支出 18.50元 打车",
      entryType: "expense",
      now: new Date("2026-08-25T02:00:00.000Z"),
    });
    assert.equal(analysis.expense.amountCents, 1850);
    assert.equal(analysis.expense.occurredOn, "2026-08-24");
    assert.equal(analysis.expense.reimbursementCents, 1850);
    assert.equal(analysis.expense.fundingSource, "personal");
  });

  it("treats a loan arrival as income and supplies a confirmable purpose", () => {
    const text = "2026-08-26 收到出差借款 2000 元";
    assert.equal(classifyBookkeepingEntry({ text }), "income");
    assert.deepEqual(mapBookkeepingCategory({ text, entryType: "income" }), { category: "出差", subcategory: "借款" });
    const analysis = buildBookkeepingAnalysis({ text, entryType: "income" });
    assert.equal(analysis.expense.amountCents, 200000);
    assert.equal(analysis.expense.purpose, "出差借款");
    assert.equal(analysis.expense.fundingSource, "other");
  });

  it("keeps a recognized merchant and purpose separate while defaulting note to empty", () => {
    const analysis = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 1850,
          occurredOn: "2026-08-24",
          paidTime: "18:20",
          merchant: "合成商户",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: {
        expense: { purpose: "客户晚餐" },
      },
      entryType: "expense",
    });

    assert.equal(analysis.note, null);
    assert.equal(analysis.expense.merchant, "合成商户");
    assert.equal(analysis.expense.purpose, "客户晚餐");
  });

  it("splits a two-row payment list by the shared right amount column", () => {
    const token = (text, left, top, width, line, word) => ({
      page: 1,
      block: 1,
      paragraph: 1,
      line,
      word,
      left,
      top,
      width,
      height: 34,
      confidence: 95,
      text,
    });
    const layout = {
      pageWidth: 1280,
      pageHeight: 520,
      tokens: [
        token("合成商户甲", 240, 45, 220, 1, 1),
        token("-12.34", 1120, 45, 120, 1, 2),
        token("8月18日", 240, 105, 140, 2, 1),
        token("09:10", 400, 105, 100, 2, 2),
        token("支付平台", 30, 290, 100, 3, 1),
        token("合成商户乙…", 240, 290, 260, 3, 2),
        token("-56.78", 1120, 290, 120, 3, 3),
        token("8月18日", 240, 355, 140, 4, 1),
        token("18:20", 400, 355, 100, 4, 2),
      ],
    };
    const rows = extractBookkeepingRows("fallback", { layout });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.amountCents), [1234, 5678]);
    assert.deepEqual(rows.map((row) => row.entryType), ["expense", "expense"]);
    assert.equal(rows[0].merchant, "合成商户甲");
    assert.equal(rows[1].merchant, "合成商户乙");
    assert.deepEqual(rows[1].warnings, ["merchant_partial"]);
    assert.match(rows[0].text, /09:10/u);
    assert.doesNotMatch(rows[0].text, /18:20/u);
  });

  it("keeps one detail row with several prices as one confirmable item", () => {
    assert.deepEqual(extractBookkeepingRows("原价 20.00 优惠 2.00 实付 ¥18.00"), []);
  });

  it("preserves an already-normalized Chinese meal category", () => {
    assert.deepEqual(mapBookkeepingCategory({
      category: "餐饮",
      subcategory: "早餐",
      text: "合成商户",
      entryType: "expense",
    }), { category: "餐饮", subcategory: "早餐" });
  });
});
