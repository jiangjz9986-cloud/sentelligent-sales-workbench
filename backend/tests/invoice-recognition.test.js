import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  compareRecognitionSources,
  detectDocumentType,
  inspectInvoiceFile,
  recognizeInvoiceDocument,
} from "../src/travelExpense/invoiceRecognition.js";
import {
  PDF_PREFIX_SHELL,
  PDF_XREF_STREAM_SHELL,
  PDF_WITHOUT_OBJECTS,
  SHORT_JPEG_ENVELOPE,
  SHORT_PNG_SIGNATURE,
  SHORT_WEBP_CONTAINER,
  VALID_JPEG,
  VALID_PDF,
  VALID_PNG,
  VALID_WEBP,
  TRUNCATED_PDF,
} from "./helpers/image-fixtures.js";

const PDF = VALID_PDF;

function normalizedFields(overrides = {}) {
  return {
    invoiceCode: "044002100111",
    invoiceNumber: "12345678",
    issuedOn: "2026-08-04",
    sellerName: "示例酒店有限公司",
    buyerName: "森特公司",
    amountExTaxCents: 9434,
    taxCents: 566,
    totalCents: 10000,
    suggestedCategory: "lodging",
    ...overrides,
  };
}

describe("invoice recognition", () => {
  it("detects supported image and PDF signatures", () => {
    assert.equal(detectDocumentType(VALID_PNG), "image/png");
    assert.equal(detectDocumentType(VALID_JPEG), "image/jpeg");
    assert.equal(detectDocumentType(VALID_WEBP), "image/webp");
    assert.equal(detectDocumentType(PDF), "application/pdf");
    assert.equal(detectDocumentType(Buffer.from("<html>invoice</html>")), null);
    assert.equal(detectDocumentType(Buffer.from("MZ executable")), null);
  });

  it("rejects image magic bytes that do not contain a complete image structure", () => {
    for (const content of [
      SHORT_PNG_SIGNATURE,
      VALID_PNG.subarray(0, VALID_PNG.length - 5),
      SHORT_JPEG_ENVELOPE,
      Buffer.concat([
        VALID_JPEG.subarray(0, Math.floor(VALID_JPEG.length / 2)),
        Buffer.from([0xff, 0xd9]),
      ]),
      SHORT_WEBP_CONTAINER,
      VALID_WEBP.subarray(0, VALID_WEBP.length - 5),
    ]) {
      assert.equal(detectDocumentType(content), null);
    }
  });

  it("rejects PDF prefix shells, truncation, and documents without indirect objects", () => {
    for (const content of [
      PDF_PREFIX_SHELL,
      TRUNCATED_PDF,
      PDF_WITHOUT_OBJECTS,
      PDF_XREF_STREAM_SHELL,
    ]) {
      assert.equal(detectDocumentType(content), null);
      assert.throws(
        () => inspectInvoiceFile({
          fileName: "invalid.pdf",
          mediaType: "application/pdf",
          buffer: content,
        }),
        /unsupported document type/i,
      );
    }
  });

  it("validates declared type, file size, and computes a content hash", () => {
    const inspected = inspectInvoiceFile({
      fileName: "住宿发票.pdf",
      mediaType: "application/pdf",
      buffer: PDF,
    });

    assert.equal(inspected.fileName, "住宿发票.pdf");
    assert.equal(inspected.mediaType, "application/pdf");
    assert.equal(inspected.sizeBytes, PDF.length);
    assert.equal(inspected.sha256, createHash("sha256").update(PDF).digest("hex"));
    assert.deepEqual(inspected.buffer, PDF);

    assert.throws(
      () => inspectInvoiceFile({ fileName: "fake.pdf", mediaType: "application/pdf", buffer: VALID_PNG }),
      /signature does not match/i,
    );
    assert.throws(
      () => inspectInvoiceFile({ fileName: "invoice.svg", mediaType: "image/svg+xml", buffer: Buffer.from("<svg/>") }),
      /unsupported document type/i,
    );
    assert.throws(
      () => inspectInvoiceFile({
        fileName: "large.pdf",
        mediaType: "application/pdf",
        buffer: Buffer.concat([Buffer.from("%PDF", "ascii"), Buffer.alloc(12 * 1024 * 1024)]),
      }),
      /12 MiB/i,
    );
  });

  it("extracts locally and sends only text to the model adapter", async () => {
    let extractorInput;
    let analyzerInput;
    const result = await recognizeInvoiceDocument({
      fileName: "住宿发票.pdf",
      mediaType: "application/pdf",
      buffer: PDF,
    }, {
      textExtractor: {
        async extract(mediaType, buffer) {
          extractorInput = { mediaType, buffer };
          return "发票日期 2026-08-04 价税合计 100.00元";
        },
      },
      async analyzeText(text) {
        analyzerInput = text;
        return normalizedFields();
      },
    });

    assert.equal(extractorInput.mediaType, "application/pdf");
    assert.deepEqual(extractorInput.buffer, PDF);
    assert.equal(analyzerInput, "发票日期 2026-08-04 价税合计 100.00元");
    assert.equal(Buffer.isBuffer(analyzerInput), false);
    assert.equal(result.status, "unmatched");
    assert.equal(result.fields.totalCents, 10000);
    assert.deepEqual(result.conflicts, []);
  });

  it("retains the original for review when the local extractor is unavailable", async () => {
    let analyzerCalled = false;
    const result = await recognizeInvoiceDocument({
      fileName: "住宿发票.png",
      mediaType: "image/png",
      buffer: VALID_PNG,
    }, {
      textExtractor: {
        async extract() {
          const error = new Error("OCR executable not found");
          error.code = "OCR_UNAVAILABLE";
          throw error;
        },
      },
      async analyzeText() {
        analyzerCalled = true;
        return normalizedFields();
      },
    });

    assert.equal(analyzerCalled, false);
    assert.equal(result.status, "review_required");
    assert.equal(result.extractedText, null);
    assert.deepEqual(result.warnings, ["OCR_UNAVAILABLE"]);
    assert.equal(result.fields, null);
  });

  it("normalizes matching OCR and model fields into integer cents", () => {
    const result = compareRecognitionSources({
      extractedText: "发票文本",
      ocr: normalizedFields({ totalCents: "100.00", taxCents: "5.66", amountExTaxCents: "94.34" }),
      model: normalizedFields(),
    });

    assert.equal(result.status, "unmatched");
    assert.deepEqual(result.fields, normalizedFields());
    assert.deepEqual(result.conflicts, []);
  });

  it("marks date and amount disagreements for human review without choosing a winner", () => {
    const result = compareRecognitionSources({
      extractedText: "发票文本",
      ocr: normalizedFields({ issuedOn: "2026-08-03", totalCents: 9900 }),
      model: normalizedFields({ issuedOn: "2026-08-04", totalCents: 10000 }),
    });

    assert.equal(result.status, "review_required");
    assert.equal(result.fields.issuedOn, null);
    assert.equal(result.fields.totalCents, null);
    assert.deepEqual(result.conflicts.map((item) => item.field), ["issuedOn", "totalCents"]);
    assert.deepEqual(result.conflicts[0], {
      field: "issuedOn",
      ocrValue: "2026-08-03",
      modelValue: "2026-08-04",
    });
  });

  it("turns invalid or failed model output into review instead of fabricated fields", async () => {
    for (const analyzeText of [
      async () => "```json\n{invalid}\n```",
      async () => { throw new Error("model timeout"); },
    ]) {
      const result = await recognizeInvoiceDocument({
        fileName: "住宿发票.pdf",
        mediaType: "application/pdf",
        buffer: PDF,
      }, {
        textExtractor: { async extract() { return "发票日期 2026-08-04"; } },
        analyzeText,
      });

      assert.equal(result.status, "review_required");
      assert.equal(result.fields, null);
      assert.match(result.warnings[0], /^MODEL_/);
    }
  });
});
