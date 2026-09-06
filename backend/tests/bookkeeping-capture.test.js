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

  it("classifies the exact Shanghai meal windows at or below 40 yuan", () => {
    const cases = [
      ["03:59", 3_000, "其他", null, null],
      ["04:00", 1, "餐饮", "早餐", "8.25济南早餐"],
      ["10:59", 4_000, "餐饮", "早餐", "8.25济南早餐"],
      ["11:00", 3_000, "餐饮", "午餐", "8.25济南午餐"],
      ["15:59", 4_000, "餐饮", "午餐", "8.25济南午餐"],
      ["16:00", 3_000, "其他", null, null],
      ["16:59", 3_000, "其他", null, null],
      ["17:00", 3_000, "餐饮", "晚餐", "8.25济南晚餐"],
      ["23:59", 4_000, "餐饮", "晚餐", "8.25济南晚餐"],
      ["00:00", 3_000, "其他", null, null],
    ];
    for (const [paidTime, amountCents, category, subcategory, note] of cases) {
      const result = buildBookkeepingAnalysis({
        recognition: {
          evidence: {
            amountCents,
            occurredOn: "2026-08-25",
            paidTime,
            merchant: "合成商户",
            paymentMethod: "wechat",
          },
        },
        expenseAnalysis: { expense: { purpose: "出差用餐" }, warnings: [] },
        entryType: "expense",
        tripRegionResolver: () => "济南",
      });
      assert.equal(result.category, category, paidTime);
      assert.equal(result.subcategory, subcategory, paidTime);
      assert.equal(result.note, note, paidTime);
    }
  });

  it("keeps 40.01 yuan ambiguous unless merchant or travel-party evidence supports a meal", () => {
    const unknown = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 4_001,
          occurredOn: "2026-08-25",
          paidTime: "10:59",
          merchant: "合成商贸",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "出差消费" }, warnings: [] },
      tripRegionResolver: () => "济南",
    });
    assert.equal(unknown.category, "其他");
    assert.equal(unknown.subcategory, null);
    assert.equal(unknown.note, null);
    assert.deepEqual(mapBookkeepingCategory({
      category: "lunch",
      text: "合成商贸",
      entryType: "expense",
      amountCents: 4_001,
      paidTime: "12:00",
    }), { category: "其他", subcategory: null });

    const restaurant = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 12_800,
          occurredOn: "2026-08-25",
          paidTime: "18:30",
          merchant: "济南合成烧烤店",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "多人同行出差用餐" }, warnings: [] },
      tripRegionResolver: () => "济南",
    });
    assert.deepEqual(
      { category: restaurant.category, subcategory: restaurant.subcategory, note: restaurant.note },
      { category: "餐饮", subcategory: "晚餐", note: "8.25济南晚餐" },
    );
    assert.doesNotMatch(restaurant.warnings.join(","), /large_meal_context_unknown/u);

    const singleLargeRestaurant = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 8_800,
          occurredOn: "2026-08-25",
          paidTime: "18:45",
          merchant: "济南合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "出差用餐" }, warnings: [] },
      tripRegionResolver: () => "济南",
    });
    assert.equal(singleLargeRestaurant.subcategory, "晚餐");
    assert.match(singleLargeRestaurant.warnings.join(","), /large_meal_context_unknown/u);
  });

  it("prioritizes explicit hospitality, lodging, and transport over the low-value meal clock", () => {
    const cases = [
      ["客户宴请午餐", "招待/礼品", null],
      ["酒店房费", "住宿费", null],
      ["火车交通", "交通", "火车"],
      ["汽车维修服务", "汽车维保", "维修"],
    ];
    for (const [purpose, category, subcategory] of cases) {
      const result = buildBookkeepingAnalysis({
        recognition: {
          evidence: {
            amountCents: 3_000,
            occurredOn: "2026-08-25",
            paidTime: "12:00",
            merchant: purpose,
            paymentMethod: "wechat",
          },
        },
        expenseAnalysis: { expense: { purpose }, warnings: [] },
        tripRegionResolver: () => "济南",
      });
      assert.equal(result.category, category, purpose);
      assert.equal(result.subcategory, subcategory, purpose);
      assert.equal(result.note, null, purpose);
    }
  });

  it("overrides an analyzer meal token with stronger merchant or purpose evidence", () => {
    const cases = [
      ["客户宴请午餐 30元", "招待/礼品", null],
      ["酒店早餐 30元", "住宿费", null],
      ["火车午餐 30元", "交通", "火车"],
    ];
    for (const [text, category, subcategory] of cases) {
      const result = buildBookkeepingAnalysis({
        text: `2026年8月25日 12:00 ${text}`,
        recognition: {
          evidence: {
            amountCents: 3_000,
            occurredOn: "2026-08-25",
            paidTime: "12:00",
            merchant: text,
            paymentMethod: "wechat",
          },
        },
        expenseAnalysis: {
          expense: { category: "lunch", purpose: text },
          warnings: [],
        },
        tripRegionResolver: () => "济南",
      });
      assert.equal(result.category, category, text);
      assert.equal(result.subcategory, subcategory, text);
      assert.equal(result.note, null, text);
    }
  });

  it("prefers the labeled payment clock over an earlier phone status-bar clock", () => {
    const result = buildBookkeepingAnalysis({
      text: "14:24 合成餐厅 支付时间：22:51",
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "14:24",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: {
        expense: { purpose: "出差用餐" },
        warnings: ["missing_date", "missing_amount", "missing_category"],
      },
      tripRegionResolver: () => "济南",
    });
    assert.equal(result.subcategory, "晚餐");
    assert.equal(result.expense.paidAt, "2026-08-25T22:51:00+08:00");
    assert.equal(result.note, "8.25济南晚餐");
    assert.doesNotMatch(result.warnings.join(","), /missing_(?:date|amount|category)/u);
  });

  it("uses an explicit or owner-scoped region only and flags a missing meal region", () => {
    const explicit = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "11:30",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "到济宁出差用餐" }, warnings: [] },
    });
    assert.equal(explicit.note, "8.25济宁午餐");
    assert.doesNotMatch(explicit.warnings.join(","), /missing_trip_region/u);

    const missing = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "11:30",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "出差用餐" }, warnings: [] },
    });
    assert.equal(missing.note, "8.25午餐");
    assert.match(missing.warnings.join(","), /missing_trip_region/u);

    const missingDate = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: null,
          paidTime: "11:30",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "出差用餐" }, warnings: [] },
      tripRegionResolver: ({ occurredOn }) => occurredOn ? "济南" : null,
    });
    assert.equal(missingDate.note, null);
    assert.deepEqual(missingDate.noteAutomation, {
      kind: "meal",
      tripRegion: null,
      tripRegionSource: "itinerary",
      paidTime: "11:30",
    });
    assert.match(missingDate.warnings.join(","), /missing_date/u);
  });

  it("does not derive a trip region from a merchant address and normalizes 到/去某地出差", () => {
    const merchantRegion = buildBookkeepingAnalysis({
      text: "北京市合成餐厅 支付时间 12:10",
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "12:10",
          merchant: "北京市合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "出差用餐" }, warnings: [] },
      tripRegionResolver: () => "济南",
    });
    assert.equal(merchantRegion.note, "8.25济南午餐");
    assert.equal(merchantRegion.noteAutomation.tripRegionSource, "itinerary");

    const explicitTrip = buildBookkeepingAnalysis({
      text: "到济宁出差 午餐 30元 12:10",
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "12:10",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "到济宁出差" }, warnings: [] },
    });
    assert.equal(explicitTrip.note, "8.25济宁午餐");
    assert.equal(explicitTrip.noteAutomation.tripRegionSource, "text");

    const colloquialTrip = buildBookkeepingAnalysis({
      text: "去济南出差 午餐 30元 12:10",
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: "12:10",
          merchant: "合成餐厅",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: { expense: { purpose: "去济南出差" }, warnings: [] },
    });
    assert.equal(colloquialTrip.note, "8.25济南午餐");
    assert.equal(colloquialTrip.noteAutomation.tripRegionSource, "text");

    for (const narrative of [
      "计划去济南出差 午餐",
      "明天前往青岛出差 午餐",
      "我去济南出差 午餐",
      "客户拜访到济宁出差 午餐",
    ]) {
      const failClosed = buildBookkeepingAnalysis({
        text: narrative,
        recognition: {
          evidence: {
            amountCents: 3_000,
            occurredOn: "2026-08-25",
            paidTime: "12:10",
            merchant: "合成餐厅",
            paymentMethod: "wechat",
          },
        },
        expenseAnalysis: { expense: { purpose: narrative }, warnings: [] },
        tripRegionResolver: () => "潍坊",
      });
      assert.equal(failClosed.note, "8.25潍坊午餐", narrative);
      assert.equal(failClosed.noteAutomation.tripRegionSource, "itinerary", narrative);
    }
  });

  it("converts an ISO model timestamp to the Shanghai meal window", () => {
    const result = buildBookkeepingAnalysis({
      recognition: {
        evidence: {
          amountCents: 3_000,
          occurredOn: "2026-08-25",
          paidTime: null,
          merchant: "合成商户",
          paymentMethod: "wechat",
        },
      },
      expenseAnalysis: {
        expense: {
          purpose: "出差消费",
          paidAt: "2026-08-25T03:00:00Z",
        },
        warnings: [],
      },
      tripRegionResolver: () => "济南",
    });
    assert.equal(result.category, "餐饮");
    assert.equal(result.subcategory, "午餐");
    assert.equal(result.note, "8.25济南午餐");
  });
});
