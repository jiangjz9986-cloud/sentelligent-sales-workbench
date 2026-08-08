import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTravelExpenseImage,
  isTravelExpensePdf,
  prepareTravelExpenseDocument,
  travelExpenseDocumentLimits,
} from "./travelExpenseDocument.js";

function fileLike({
  bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  name = "付款记录.pdf",
  type = "application/pdf",
  size = bytes.byteLength,
  onRead,
} = {}) {
  return {
    name,
    size,
    type,
    async arrayBuffer() {
      onRead?.();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe("travel expense document preparation", () => {
  it("keeps the original filename, MIME type, size, and bytes", async () => {
    const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0x20, 0x7f, 0x80]);
    const result = await prepareTravelExpenseDocument(fileLike({
      bytes,
      name: "微信支付-原图.png",
      type: "image/png",
    }));

    assert.equal(result.fileName, "微信支付-原图.png");
    assert.equal(result.mediaType, "image/png");
    assert.equal(result.sizeBytes, bytes.byteLength);
    assert.deepEqual(Buffer.from(result.contentBase64, "base64"), Buffer.from(bytes));
  });

  it("accepts PDF alongside JPEG, PNG, and WebP", async () => {
    assert.deepEqual(travelExpenseDocumentLimits.acceptedTypes, [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]);
    assert.equal(travelExpenseDocumentLimits.maxBytes, 12 * 1024 * 1024);

    const result = await prepareTravelExpenseDocument(fileLike());
    assert.equal(result.mediaType, "application/pdf");
    assert.equal(isTravelExpensePdf(result), true);
    assert.equal(isTravelExpenseImage(result), false);
    assert.equal(isTravelExpenseImage({ mediaType: "image/webp" }), true);
  });

  it("prefers a declared supported MIME type over a misleading PDF extension", () => {
    assert.equal(isTravelExpensePdf({
      fileName: "proof.pdf",
      mediaType: "image/png",
    }), false);
    assert.equal(isTravelExpensePdf({
      fileName: "proof.pdf",
    }), true);
  });

  it("rejects an oversized file before reading it", async () => {
    let read = false;
    await assert.rejects(
      prepareTravelExpenseDocument(fileLike({
        size: (12 * 1024 * 1024) + 1,
        onRead: () => { read = true; },
      })),
      /12 MiB/,
    );
    assert.equal(read, false);
  });

  it("rejects empty, unsupported, and inconsistent files", async () => {
    await assert.rejects(
      prepareTravelExpenseDocument(fileLike({ bytes: new Uint8Array(), size: 0 })),
      /不能为空/,
    );
    await assert.rejects(
      prepareTravelExpenseDocument(fileLike({ name: "notes.txt", type: "text/plain" })),
      /JPEG、PNG、WebP.*PDF/,
    );
    await assert.rejects(
      prepareTravelExpenseDocument(fileLike({ size: 8 })),
      /读取不完整/,
    );
  });
});
