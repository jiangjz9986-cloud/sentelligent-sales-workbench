import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeExpenseText } from "../src/travelExpense/ingestionAnalysis.js";

describe("travel expense ingestion analysis", () => {
  it("parses a complete Chinese payment line into integer cents", async () => {
    const result = await analyzeExpenseText("2026-08-04 午餐 招待客户 支付宝 128.50元");

    assert.deepEqual(result, {
      status: "ready",
      confidence: 1,
      expense: {
        occurredOn: "2026-08-04",
        category: "lunch",
        purpose: "招待客户",
        merchant: "支付宝",
        amountCents: 12850,
        reimbursementCents: 12850,
      },
      warnings: [],
      source: { provider: "rules", model: null },
    });
  });

  it("classifies breakfast, dinner, lodging, transport, and hospitality text", async () => {
    const cases = [
      ["2026年8月4日 早餐 出差用餐 微信支付 18元", "breakfast", 1800],
      ["2026/08/04 晚饭 拜访后用餐 86.5元", "dinner", 8650],
      ["2026-08-04 住宿 如家酒店房费 368元", "lodging", 36800],
      ["2026-08-04 滴滴打车 去客户现场 45.60元", "transport", 4560],
      ["2026-08-04 业务招待 王总晚宴 520元", "hospitality", 52000],
    ];

    for (const [text, category, amountCents] of cases) {
      const result = await analyzeExpenseText(text);
      assert.equal(result.status, "ready", text);
      assert.equal(result.expense.occurredOn, "2026-08-04", text);
      assert.equal(result.expense.category, category, text);
      assert.equal(result.expense.amountCents, amountCents, text);
    }
  });

  it("resolves relative and month-day dates with an injected clock", async () => {
    const clock = () => new Date("2026-08-04T12:00:00+08:00");

    const yesterday = await analyzeExpenseText("昨天 午餐 出差用餐 25元", { clock });
    const monthDay = await analyzeExpenseText("8月3日 晚餐 出差用餐 40元", { clock });

    assert.equal(yesterday.expense.occurredOn, "2026-08-03");
    assert.equal(monthDay.expense.occurredOn, "2026-08-03");
  });

  it("sends negative and zero amounts to review without preserving an invalid cent value", async () => {
    for (const text of [
      "2026-08-04 午餐 出差用餐 -12.50元",
      "2026-08-04 午餐 出差用餐 0元",
      "2026-08-04 午餐 出差用餐 12.345元",
    ]) {
      const result = await analyzeExpenseText(text);
      assert.equal(result.status, "review_required", text);
      assert.equal(result.expense.amountCents, null, text);
      assert.equal(result.expense.reimbursementCents, null, text);
      assert.ok(result.warnings.includes("invalid_amount"), text);
    }
  });

  it("sends missing or invalid required fields to review", async () => {
    const cases = [
      ["午餐 出差用餐 25元", "missing_date"],
      ["2026-02-30 午餐 出差用餐 25元", "invalid_date"],
      ["2026-08-04 午餐 出差用餐", "missing_amount"],
      ["2026-08-04 客户现场 支付宝 25元", "missing_category"],
      ["2026-08-04 早餐 支付宝 25元", "missing_purpose"],
    ];

    for (const [text, warning] of cases) {
      const result = await analyzeExpenseText(text);
      assert.equal(result.status, "review_required", text);
      assert.ok(result.warnings.includes(warning), `${text}: ${result.warnings.join(",")}`);
      assert.notEqual(result.source.provider, "mock");
    }
  });

  it("returns a safe empty review result for blank input", async () => {
    const result = await analyzeExpenseText("   ");

    assert.deepEqual(result, {
      status: "review_required",
      confidence: 0,
      expense: null,
      warnings: ["missing_text"],
      source: { provider: "rules", model: null },
    });
  });

  it("normalizes fenced DeepSeek OpenAI-compatible JSON without exposing credentials", async () => {
    let request;
    const secret = "test-expense-analysis-key";
    const result = await analyzeExpenseText("2026-08-04 午餐 招待客户 支付宝 128.50元", {
      modelProvider: "deepseek",
      modelName: "deepseek-chat",
      modelApiKey: secret,
      modelClient: async (value) => {
        request = value;
        return {
          choices: [{
            message: {
              content: `\`\`\`json
${JSON.stringify({
  confidence: 92,
  expense: {
    occurred_on: "2026-08-04",
    category: "午餐",
    purpose: "招待客户",
    merchant: "支付宝",
    amount_cents: 12850,
    reimbursement_cents: 12850,
    paid_at: "2026-08-04T12:30:00+08:00",
    funding_source: "personal",
    payment_method: "alipay",
  },
})}
\`\`\``,
            },
          }],
        };
      },
    });

    assert.equal(request.model, "deepseek-chat");
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.stream, false);
    assert.ok(request.signal instanceof AbortSignal);
    assert.match(JSON.stringify(request.messages), /128\.50/);
    assert.doesNotMatch(JSON.stringify(request), new RegExp(secret));
    assert.deepEqual(result, {
      status: "ready",
      confidence: 0.92,
      expense: {
        occurredOn: "2026-08-04",
        category: "lunch",
        purpose: "招待客户",
        merchant: "支付宝",
        amountCents: 12850,
        reimbursementCents: 12850,
        paidAt: "2026-08-04T12:30:00+08:00",
        fundingSource: "personal",
        paymentMethod: "alipay",
      },
      warnings: [],
      source: { provider: "deepseek", model: "deepseek-chat" },
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });

  it("requires manual review for model exceptions and never returns provider error text", async () => {
    const secret = "test-provider-error-secret";
    const result = await analyzeExpenseText("2026-08-04 午餐 招待客户 支付宝 128.50元", {
      modelProvider: "deepseek",
      modelName: "deepseek-chat",
      modelClient: async () => {
        throw new Error(secret);
      },
    });

    assert.equal(result.status, "review_required");
    assert.ok(result.warnings.includes("model_error"));
    assert.notEqual(result.source.provider, "mock");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });

  it("requires manual review for invalid JSON and low-confidence model output", async () => {
    const invalidJson = await analyzeExpenseText("2026-08-04 午餐 出差用餐 35元", {
      modelClient: async () => ({ choices: [{ message: { content: "```json\nnot-json\n```" } }] }),
    });
    const lowConfidence = await analyzeExpenseText("2026-08-04 午餐 出差用餐 35元", {
      minModelConfidence: 0.8,
      modelClient: async () => ({
        choices: [{ message: { content: JSON.stringify({
          confidence: 0.42,
          expense: {
            occurredOn: "2026-08-04",
            category: "lunch",
            purpose: "出差用餐",
            amountCents: 3500,
            reimbursementCents: 3500,
          },
        }) } }],
      }),
    });

    assert.equal(invalidJson.status, "review_required");
    assert.ok(invalidJson.warnings.includes("invalid_model_json"));
    assert.equal(lowConfidence.status, "review_required");
    assert.equal(lowConfidence.confidence, 0.42);
    assert.ok(lowConfidence.warnings.includes("low_model_confidence"));
  });

  it("requires manual review when the injected model client times out", async () => {
    const result = await analyzeExpenseText("2026-08-04 午餐 出差用餐 35元", {
      modelTimeoutMs: 5,
      modelClient: async () => new Promise(() => {}),
    });

    assert.equal(result.status, "review_required");
    assert.ok(result.warnings.includes("model_timeout"));
    assert.notEqual(result.source.provider, "mock");
  });

  it("does not let the model invent a missing date or rehabilitate a rejected amount", async () => {
    const modelClient = async ({ messages }) => {
      const input = JSON.parse(messages[1].content);
      const invalidAmount = input.text.includes("-12.50");
      return {
        choices: [{ message: { content: JSON.stringify({
          confidence: 0.99,
          expense: {
            occurredOn: "2026-08-04",
            category: "lunch",
            purpose: "出差用餐",
            amountCents: invalidAmount ? 1250 : 2500,
            reimbursementCents: invalidAmount ? 1250 : 2500,
          },
        }) } }],
      };
    };

    const missingDate = await analyzeExpenseText("午餐 出差用餐 25元", { modelClient });
    const negativeAmount = await analyzeExpenseText("2026-08-04 午餐 出差用餐 -12.50元", { modelClient });

    assert.equal(missingDate.status, "review_required");
    assert.equal(missingDate.expense.occurredOn, null);
    assert.ok(missingDate.warnings.includes("missing_date"));
    assert.equal(negativeAmount.status, "review_required");
    assert.equal(negativeAmount.expense.amountCents, null);
    assert.equal(negativeAmount.expense.reimbursementCents, null);
    assert.ok(negativeAmount.warnings.includes("invalid_amount"));
  });
});
