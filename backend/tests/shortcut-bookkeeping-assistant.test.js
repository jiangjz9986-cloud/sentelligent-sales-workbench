import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS,
  BOOKKEEPING_ASSISTANT_PROTECTED_FIELDS,
  applyShortcutBookkeepingCorrection,
  buildBookkeepingAssistantDraft,
  parseShortcutBookkeepingCorrection,
  projectShortcutBookkeepingDraft,
} from "../src/integrations/shortcutBookkeepingAssistant.js";

const valid = {
  occurredOn: "2026-08-18T09:30:00+08:00",
  amountCents: 12800,
  merchant: "上海虹桥站",
  purpose: "出差交通",
  note: "客户拜访",
  category: "交通",
  subcategory: "火车",
};

describe("快捷记账→小小助手纯能力层", () => {
  it("projects only the documented bookkeeping fields and never identity fields", () => {
    const result = projectShortcutBookkeepingDraft({
      fields: {
        ...valid,
        owner: "alice",
        targetSystem: "other-system",
        idempotencyKey: "request-1",
        expenseId: "expense-1",
        paymentId: "payment-1",
        confirmationCode: "123456",
      },
    });

    assert.equal(result.status, "review_required");
    assert.deepEqual(result.fields, valid);
    assert.ok(result.warnings.some((item) => item.startsWith("protected_field:")));
    for (const key of ["owner", "targetSystem", "idempotencyKey", "expenseId", "paymentId", "confirmationCode"]) {
      assert.equal(Object.hasOwn(result.fields, key), false);
      assert.equal(Object.hasOwn(result, key), false);
    }
  });

  it("accepts an analysis expense envelope while keeping a stable canonical shape", () => {
    const result = buildBookkeepingAssistantDraft({
      status: "review_required",
      analysis: { expense: valid },
      category: valid.category,
      subcategory: valid.subcategory,
      id: "internal-id",
      owner: "not-forwarded",
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.fields, valid);
    assert.equal(result.schemaVersion, "shortcut-bookkeeping-assistant/v1");
  });

  it("accepts the existing webhook { item } envelope without forwarding its metadata", () => {
    const result = projectShortcutBookkeepingDraft({
      item: {
        status: "review_required",
        targetSystem: "sentelligent",
        expenseId: "expense-1",
        category: valid.category,
        subcategory: valid.subcategory,
        analysis: { expense: valid },
      },
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.fields, valid);
    assert.deepEqual(Object.keys(result.fields).sort(), [...BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS].sort());
  });

  it("marks missing, negative, unsafe, overlong, and timezone-less values for review", () => {
    const result = projectShortcutBookkeepingDraft({
      fields: {
        occurredOn: "2026-08-18 09:30:00",
        amountCents: -1,
        merchant: "x".repeat(501),
      },
    });

    assert.equal(result.status, "review_required");
    assert.equal(Object.hasOwn(result.fields, "occurredOn"), false);
    assert.equal(Object.hasOwn(result.fields, "amountCents"), false);
    assert.equal(Object.hasOwn(result.fields, "merchant"), false);
    assert.ok(result.warnings.includes("invalid_occurredOn"));
    assert.ok(result.warnings.includes("invalid_amountCents"));
    assert.ok(result.warnings.includes("overlong_merchant"));
    assert.ok(result.missingFields.includes("occurredOn"));
    assert.ok(result.missingFields.includes("amountCents"));
  });

  it("does not silently pass unknown input fields", () => {
    const result = projectShortcutBookkeepingDraft({
      fields: { ...valid, bankAccount: "1234", payment: { id: "p" } },
    });
    assert.equal(result.status, "review_required");
    assert.ok(result.warnings.includes("unknown_field:bankAccount"));
    assert.ok(result.warnings.includes("unknown_field:payment"));
    assert.deepEqual(result.fields, valid);
  });

  it("parses one safe natural-language correction", () => {
    const correction = parseShortcutBookkeepingCorrection("金额改为 135.50 元");
    assert.deepEqual(correction, {
      status: "accepted",
      changes: { amountCents: 13550 },
      warnings: [],
    });
  });

  it("parses date, merchant, purpose, note, category and subcategory corrections", () => {
    const correction = parseShortcutBookkeepingCorrection(
      "时间改为 2026-08-19T10:20:00+08:00；商户改为 济南客户；用途改为 客户拜访；备注改为 需要发票；分类改为 交通；子分类改为 打车",
    );
    assert.equal(correction.status, "accepted");
    assert.deepEqual(correction.changes, {
      occurredOn: "2026-08-19T10:20:00+08:00",
      merchant: "济南客户",
      purpose: "客户拜访",
      note: "需要发票",
      category: "交通",
      subcategory: "打车",
    });
  });

  it("fails closed on ambiguous, unknown, protected, duplicate, negative, and timezone-less corrections", () => {
    for (const text of [
      "金额改为 -5 元",
      "时间改为 2026-08-19",
      "账号改为 other-user",
      "随便改一下",
      "金额改为 1 元；金额改为 2 元",
    ]) {
      const correction = parseShortcutBookkeepingCorrection(text);
      assert.equal(correction.status, "review_required", text);
      assert.deepEqual(correction.changes, {}, text);
      assert.ok(correction.warnings.length > 0, text);
    }
  });

  it("never applies an unaccepted correction and revalidates accepted changes", () => {
    const draft = projectShortcutBookkeepingDraft({ fields: valid });
    const rejected = applyShortcutBookkeepingCorrection(
      draft,
      parseShortcutBookkeepingCorrection("金额改为 -1 元"),
    );
    assert.equal(rejected.status, "review_required");
    assert.deepEqual(rejected.fields, valid);

    const accepted = applyShortcutBookkeepingCorrection(
      draft,
      parseShortcutBookkeepingCorrection("金额改为 99.99 元；备注改为 已核对"),
    );
    assert.equal(accepted.status, "ready");
    assert.equal(accepted.fields.amountCents, 9999);
    assert.equal(accepted.fields.note, "已核对");
    for (const key of BOOKKEEPING_ASSISTANT_PROTECTED_FIELDS) {
      assert.equal(Object.hasOwn(accepted.fields, key), false);
    }
  });

  it("exports a narrow, immutable allowlist for the future runtime adapter", () => {
    assert.deepEqual(BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS, [
      "occurredOn", "amountCents", "merchant", "purpose", "note", "category", "subcategory",
    ]);
    assert.ok(Object.isFrozen(BOOKKEEPING_ASSISTANT_ALLOWED_FIELDS));
    assert.ok(Object.isFrozen(BOOKKEEPING_ASSISTANT_PROTECTED_FIELDS));
  });
});
