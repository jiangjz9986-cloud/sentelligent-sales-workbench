import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzePaymentProofText,
  recognizePaymentProofDocument,
} from "../src/travelExpense/paymentProofRecognition.js";
import { MAX_MODEL_TEXT_CHARS } from "../src/travelExpense/modelTextBound.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

const file = {
  fileName: "payment-proof.png",
  mediaType: "image/png",
  buffer: VALID_PNG,
};

describe("payment-proof recognition", () => {
  it("extracts locally and sends only the extracted text to DeepSeek", async () => {
    let extractorInput;
    let analyzerInput;
    const result = await recognizePaymentProofDocument(file, {
      typedEvidence: {
        amountCents: 4850,
        occurredOn: "2026-08-04",
        paidTime: null,
      },
      textExtractor: {
        async extract(mediaType, buffer) {
          extractorInput = { mediaType, buffer };
          return "支付时间 2026-08-04 18:23 金额 48.50 元";
        },
      },
      async analyzeText(text) {
        analyzerInput = text;
        return {
          amountCents: 4850,
          occurredOn: "2026-08-04",
          paidTime: "18:23",
          merchant: "示例餐厅",
          paymentMethod: "wechat",
          confidence: 0.94,
        };
      },
    });

    assert.equal(extractorInput.mediaType, "image/png");
    assert.deepEqual(extractorInput.buffer, VALID_PNG);
    assert.equal(analyzerInput, "支付时间 2026-08-04 18:23 金额 48.50 元");
    assert.equal(Buffer.isBuffer(analyzerInput), false);
    assert.doesNotMatch(JSON.stringify(analyzerInput), /payment-proof|base64|89504e47/i);
    assert.deepEqual(result.evidence, {
      amountCents: 4850,
      occurredOn: "2026-08-04",
      paidTime: "18:23",
      merchant: "示例餐厅",
      paymentMethod: "wechat",
    });
    assert.deepEqual(result.typedEvidence, {
      amountCents: 4850,
      occurredOn: "2026-08-04",
      paidTime: null,
    });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.confidence, 0.94);
    assert.deepEqual(result.source, { provider: "deepseek", model: "deepseek-v4-flash" });
    assert.deepEqual(result.warnings, []);
  });

  it("normalizes strict JSON, money strings, dates, and times while rejecting unsupported fields", async () => {
    const result = await analyzePaymentProofText("2026-08-04 18:23 48.50", {
      modelClient: async ({ messages }) => {
        assert.equal(messages[1].role, "user");
        assert.equal(messages[1].content, "2026-08-04 18:23 48.50");
        assert.equal(Buffer.isBuffer(messages[1].content), false);
        return {
          choices: [{
            message: {
              content: "```json\n{\"amountCents\":\"48.50\",\"occurredOn\":\"2026-08-04\",\"paidTime\":\"18:23\",\"merchant\":\"示例餐厅\",\"paymentMethod\":\"wechat\",\"confidence\":0.91,\"warnings\":[\"MODEL_LOW_CONFIDENCE\",\"MODEL_LOW_CONFIDENCE\"]}\n```",
            },
          }],
        };
      },
      modelName: "deepseek-v4-flash",
    });

    assert.deepEqual(result, {
      amountCents: 4850,
      occurredOn: "2026-08-04",
      paidTime: "18:23",
      merchant: "示例餐厅",
      paymentMethod: "wechat",
      confidence: 0.91,
      warnings: ["MODEL_LOW_CONFIDENCE"],
    });

    await assert.rejects(
      analyzePaymentProofText("2026-08-04 18:23 48.50", {
        modelClient: async () => ({
          choices: [{ message: { content: JSON.stringify({ amountCents: 4850, unexpected: "drop-me" }) } }],
        }),
      }),
      (error) => error?.code === "MODEL_INVALID_RESPONSE",
    );
  });

  it("marks typed-versus-recognized disagreements for manual review and de-duplicates warnings", async () => {
    const result = await recognizePaymentProofDocument(file, {
      typedEvidence: {
        amountCents: 5000,
        occurredOn: "2026-08-04",
        paidTime: "18:23",
      },
      textExtractor: { async extract() { return "支付时间 2026-08-04 18:23 金额 48.50 元"; } },
      async analyzeText() {
        return {
          amountCents: 4850,
          occurredOn: "2026-08-04",
          paidTime: "18:23",
          confidence: 0.7,
          warnings: ["MODEL_LOW_CONFIDENCE", "MODEL_LOW_CONFIDENCE"],
        };
      },
    });

    assert.deepEqual(result.conflicts, [{
      field: "amountCents",
      typedValue: 5000,
      recognizedValue: 4850,
    }]);
    assert.deepEqual(result.warnings, ["MODEL_LOW_CONFIDENCE", "EVIDENCE_CONFLICT"]);
    assert.equal(result.evidence.amountCents, 4850);
    assert.equal(result.typedEvidence.amountCents, 5000);
  });

  it("returns a stable review result when OCR/PDF extraction fails and never calls the model", async () => {
    let modelCalled = false;
    const result = await recognizePaymentProofDocument(file, {
      typedEvidence: { amountCents: 4850, occurredOn: null, paidTime: null },
      textExtractor: {
        async extract() {
          throw Object.assign(new Error("C:\\Tools\\tesseract.exe secret path"), { code: "OCR_UNAVAILABLE" });
        },
      },
      async analyzeText() {
        modelCalled = true;
        return {};
      },
    });

    assert.equal(modelCalled, false);
    assert.equal(result.extractedText, null);
    assert.equal(result.evidence, null);
    assert.deepEqual(result.warnings, ["OCR_UNAVAILABLE"]);
    assert.doesNotMatch(JSON.stringify(result), /tesseract|secret path/i);
  });

  it("maps model timeout and provider failures to stable warnings", async () => {
    const timeout = await recognizePaymentProofDocument(file, {
      textExtractor: { async extract() { return "48.50"; } },
      analyzeText: () => new Promise(() => {}),
      modelTimeoutMs: 5,
    });
    assert.deepEqual(timeout.warnings, ["MODEL_TIMEOUT"]);

    const providerFailure = await recognizePaymentProofDocument(file, {
      textExtractor: { async extract() { return "48.50"; } },
      async analyzeText() {
        throw Object.assign(new Error("provider secret"), { code: "MODEL_PROVIDER_ERROR" });
      },
    });
    assert.deepEqual(providerFailure.warnings, ["MODEL_PROVIDER_ERROR"]);
    assert.doesNotMatch(JSON.stringify(providerFailure), /provider secret/i);
  });

  it("caps oversized OCR text before sending it to the model", async () => {
    let captured;
    const result = await analyzePaymentProofText(`${"x".repeat(MAX_MODEL_TEXT_CHARS)} suffix`, {
      modelClient: async (request) => {
        captured = request;
        return {
          choices: [{ message: { content: JSON.stringify({ amountCents: 100 }) } }],
        };
      },
    });

    assert.equal(captured.messages[1].content.length, MAX_MODEL_TEXT_CHARS);
    assert.equal(captured.messages[1].content.endsWith("x"), true);
    assert.equal(result.amountCents, 100);
  });
});
