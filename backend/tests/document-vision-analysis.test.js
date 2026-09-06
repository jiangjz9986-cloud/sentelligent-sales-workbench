import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DOCUMENT_VISION_MODEL,
  analyzeDocumentWithVision,
  createDocumentVisionAnalyzer,
} from "../src/travelExpense/documentVisionAnalysis.js";
import { VALID_JPEG, VALID_PDF, VALID_PNG } from "./helpers/image-fixtures.js";

describe("document vision analysis", () => {
  it("routes image reading to the dedicated DeepSeek vision model", async () => {
    let captured;
    const analyzer = createDocumentVisionAnalyzer({
      async modelClient(request) {
        captured = request;
        return {
          choices: [{ message: { content: JSON.stringify({
            amountCents: 200,
            occurredOn: "2026-08-25",
            occurredOnYearExplicit: true,
            paidTime: "14:23",
            merchant: "测试商户",
            paymentMethod: "wechat",
            confidence: 0.99,
            warnings: [],
          }) } }],
        };
      },
    });

    const result = await analyzer.analyzePaymentProof({
      fileName: "proof.png",
      mediaType: "image/png",
      buffer: VALID_PNG,
    }, { referenceDate: "2026-08-25" });

    assert.equal(captured.model, DEFAULT_DOCUMENT_VISION_MODEL);
    assert.deepEqual(captured.thinking, { type: "disabled" });
    assert.deepEqual(captured.response_format, { type: "json_object" });
    assert.equal(captured.messages[1].content[0].type, "text");
    assert.equal(captured.messages[1].content[1].type, "image_url");
    assert.match(captured.messages[1].content[1].image_url.url, /^data:image\/png;base64,/u);
    assert.equal(captured.messages[1].content[1].image_url.detail, "high");
    assert.doesNotMatch(JSON.stringify(captured.messages[0]), /deepseek-v4-flash(?!-vision)/u);
    assert.match(captured.messages[0].content, /documentKind/u);
    assert.match(captured.messages[0].content, /transactions/u);
    assert.match(captured.messages[0].content, /最多 20 笔/u);
    assert.match(captured.messages[0].content, /occurredOnYearExplicit/u);
    assert.match(captured.messages[0].content, /年份是否在凭证画面中明确出现/u);
    assert.match(captured.messages[0].content, /服务端根据参考日期确定年份/u);
    assert.match(captured.messages[0].content, /手机或系统状态栏时间绝不是支付时间/u);
    assert.match(captured.messages[0].content, /原价、优惠、折扣、合计和实付是同一笔付款/u);
    assert.match(captured.messages[0].content, /参考日期是 2026-08-25/u);
    assert.match(captured.messages[0].content, /不能用参考日期代替/u);
    assert.equal(captured.max_tokens, 1_600);
    assert.equal(result.amountCents, 200);
    assert.equal(result.occurredOnYearExplicit, true);
  });

  it("rejects a malformed reference date before invoking the vision model", async () => {
    let called = false;
    await assert.rejects(
      analyzeDocumentWithVision({
        fileName: "proof.png",
        mediaType: "image/png",
        buffer: VALID_PNG,
      }, {
        documentKind: "payment_proof",
        referenceDate: "2026-02-31",
        async modelClient() {
          called = true;
          return {};
        },
      }),
      (error) => error?.code === "VISION_INPUT_INVALID",
    );
    assert.equal(called, false);
  });

  it("strictly requires boolean year evidence at the top level and in every transaction", async () => {
    for (const modelResult of [
      { amountCents: 200, occurredOn: "08-25", paidTime: "14:23", transactions: [] },
      {
        amountCents: null,
        occurredOn: null,
        occurredOnYearExplicit: false,
        transactions: [{ amountCents: 200, occurredOn: "08-25", paidTime: "14:23" }],
      },
      {
        amountCents: 200,
        occurredOn: null,
        occurredOnYearExplicit: true,
        transactions: [],
      },
    ]) {
      await assert.rejects(
        analyzeDocumentWithVision({
          fileName: "proof.png",
          mediaType: "image/png",
          buffer: VALID_PNG,
        }, {
          documentKind: "payment_proof",
          referenceDate: "2026-08-26",
          async modelClient() {
            return { choices: [{ message: { content: JSON.stringify(modelResult) } }] };
          },
        }),
        (error) => error?.code === "VISION_MODEL_INVALID_RESPONSE",
      );
    }
  });

  it("renders PDF pages to bounded images before calling the vision model", async () => {
    let rendererInput;
    let captured;
    const result = await analyzeDocumentWithVision({
      fileName: "invoice.pdf",
      mediaType: "application/pdf",
      buffer: VALID_PDF,
    }, {
      documentKind: "invoice",
      modelName: "deepseek-v4-flash-vision-exp",
      pdfRenderer: {
        async render(buffer) {
          rendererInput = buffer;
          return [
            { mediaType: "image/jpeg", buffer: VALID_JPEG },
            { mediaType: "image/png", buffer: VALID_PNG },
          ];
        },
      },
      async modelClient(request) {
        captured = request;
        return { choices: [{ message: { content: JSON.stringify({ totalCents: 10000 }) } }] };
      },
    });

    assert.deepEqual(rendererInput, VALID_PDF);
    const attachments = captured.messages[1].content.slice(1);
    assert.equal(attachments.length, 2);
    assert.match(attachments[0].image_url.url, /^data:image\/jpeg;base64,/u);
    assert.match(attachments[1].image_url.url, /^data:image\/png;base64,/u);
    assert.doesNotMatch(JSON.stringify(captured), /data:application\/pdf/u);
    assert.equal(result.totalCents, 10000);
  });

  it("fails closed with stable errors instead of silently using the text model", async () => {
    await assert.rejects(
      analyzeDocumentWithVision({
        fileName: "proof.png",
        mediaType: "image/png",
        buffer: VALID_PNG,
      }, {
        documentKind: "payment_proof",
        modelClient: async () => ({ ok: false, async text() { return "provider-private-body"; } }),
      }),
      (error) => error?.code === "VISION_MODEL_PROVIDER_ERROR"
        && !String(error?.message).includes("provider-private-body"),
    );
  });
});
