import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readWeixinDocument } from "../src/travelExpense/documentInboxMedia.js";
import { PDF_XREF_STREAM_PREDICTOR, VALID_PNG } from "./helpers/image-fixtures.js";

describe("WeChat remote media normalization", () => {
  it("accepts canonical Base64 bytes and preserves the original hash", async () => {
    const document = await readWeixinDocument({
      type: "image",
      fileName: "receipt.png",
      mimeType: "image/png",
      contentBase64: VALID_PNG.toString("base64"),
    });

    assert.equal(document.fileName, "receipt.png");
    assert.equal(document.mediaType, "image/png");
    assert.equal(document.contentBase64, VALID_PNG.toString("base64"));
    assert.match(document.sha256, /^[0-9a-f]{64}$/);
  });

  it("rejects non-canonical Base64 and keeps file-path input behavior intact", async () => {
    await assert.rejects(
      readWeixinDocument({
        type: "image",
        fileName: "receipt.png",
        mimeType: "image/png",
        contentBase64: `${VALID_PNG.toString("base64")}\n`,
      }),
      (error) => error.code === "file_unavailable",
    );
  });

  it("accepts a real-world style PDF XRef stream with PNG predictor rows", async () => {
    const document = await readWeixinDocument({
      type: "file",
      fileName: "发票金额 26.50元.pdf",
      mimeType: "application/pdf",
      contentBase64: PDF_XREF_STREAM_PREDICTOR.toString("base64"),
    });

    assert.equal(document.fileName, "发票金额 26.50元.pdf");
    assert.equal(document.mediaType, "application/pdf");
    assert.equal(document.sha256.length, 64);
    assert.deepEqual(Buffer.from(document.contentBase64, "base64"), PDF_XREF_STREAM_PREDICTOR);
  });
});
