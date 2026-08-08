import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeInvoiceText } from "../src/travelExpense/invoiceTextAnalysis.js";
import { MAX_MODEL_TEXT_CHARS } from "../src/travelExpense/modelTextBound.js";

describe("invoice text model analysis", () => {
  it("sends only extracted text to an OpenAI-compatible model and parses fenced JSON", async () => {
    let captured;
    const result = await analyzeInvoiceText("发票日期 2026-08-04 合计 100.00 元", {
      modelName: "deepseek-chat",
      modelClient: async (request) => {
        captured = request;
        return {
          choices: [{
            message: {
              content: "```json\n{\"issuedOn\":\"2026-08-04\",\"totalCents\":10000,\"suggestedCategory\":\"lodging\"}\n```",
            },
          }],
        };
      },
    });

    assert.deepEqual(result, {
      issuedOn: "2026-08-04",
      totalCents: 10000,
      suggestedCategory: "lodging",
    });
    assert.equal(captured.model, "deepseek-chat");
    assert.equal(captured.response_format.type, "json_object");
    assert.equal(captured.messages[1].content, "发票日期 2026-08-04 合计 100.00 元");
    assert.equal(Buffer.isBuffer(captured.messages[1].content), false);
  });

  it("uses stable errors for provider failures, invalid JSON, and timeouts", async () => {
    await assert.rejects(
      analyzeInvoiceText("invoice text", {
        modelClient: async () => ({ ok: false, async text() { return "provider-secret-body"; } }),
      }),
      (error) => error?.code === "MODEL_PROVIDER_ERROR" && !String(error.message).includes("provider-secret-body"),
    );
    await assert.rejects(
      analyzeInvoiceText("invoice text", {
        modelClient: async () => ({ choices: [{ message: { content: "not-json" } }] }),
      }),
      (error) => error?.code === "MODEL_INVALID_RESPONSE",
    );
    await assert.rejects(
      analyzeInvoiceText("invoice text", {
        modelTimeoutMs: 10,
        modelClient: async () => new Promise(() => {}),
      }),
      (error) => error?.code === "MODEL_TIMEOUT",
    );
  });

  it("caps oversized OCR text before sending it to the model", async () => {
    let captured;
    const result = await analyzeInvoiceText(`prefix ${"x".repeat(MAX_MODEL_TEXT_CHARS)} suffix`, {
      modelClient: async (request) => {
        captured = request;
        return { choices: [{ message: { content: JSON.stringify({ totalCents: 100 }) } }] };
      },
    });

    assert.equal(captured.messages[1].content.length, MAX_MODEL_TEXT_CHARS);
    assert.equal(captured.messages[1].content.endsWith("x"), true);
    assert.equal(result.totalCents, 100);
  });
});
