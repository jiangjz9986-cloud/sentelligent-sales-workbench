import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAYMENT_PROOF_THUMBNAIL,
  PaymentProofThumbnailError,
  calculatePaymentProofContain,
  createPaymentProofThumbnail,
} from "./paymentProofThumbnail.js";

function sourceBlob(type, payload = [1, 2, 3, 4]) {
  const headers = {
    "image/jpeg": [0xff, 0xd8, 0xff, 0xe1],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/webp": [0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
    "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  };
  return new Blob([new Uint8Array(headers[type]), new Uint8Array(payload)], { type });
}

function jpegBlob(width = 360, height = 240, payload = [1, 2, 3]) {
  return new Blob([new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    ...payload,
    0xff, 0xd9,
  ])], { type: "image/jpeg" });
}

function canvasHarness(encoded = jpegBlob()) {
  const calls = [];
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect(...args) {
      calls.push(["fillRect", this.fillStyle, ...args]);
    },
    drawImage(...args) {
      calls.push(["drawImage", ...args]);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(type, options) {
      calls.push(["getContext", type, options]);
      return context;
    },
    async convertToBlob(options) {
      calls.push(["convertToBlob", options]);
      return encoded;
    },
  };
  return { canvas, context, calls };
}

function bitmapFactoryForSource({ width, height, onClose = () => {} }) {
  return async (_blob, { stage }) => {
    if (stage === "source") return { width, height, close: onClose };
    return { width: 360, height: 240, close() {} };
  };
}

describe("payment proof output thumbnails", () => {
  it("calculates a centred contain placement without cropping or upscaling", () => {
    assert.deepEqual(calculatePaymentProofContain({ sourceWidth: 720, sourceHeight: 1280 }), {
      x: 112,
      y: 0,
      width: 135,
      height: 240,
      scale: 0.1875,
    });
    assert.deepEqual(calculatePaymentProofContain({ sourceWidth: 120, sourceHeight: 80 }), {
      x: 120,
      y: 80,
      width: 120,
      height: 80,
      scale: 1,
    });
  });

  it("re-encodes a PNG onto a 360x240 white JPEG canvas at quality 0.72", async () => {
    const source = sourceBlob("image/png");
    const drawable = { width: 720, height: 1280, close() {} };
    const { canvas, context, calls } = canvasHarness();
    const result = await createPaymentProofThumbnail(source, {
      bitmapFactory: async (_blob, { stage }) => (
        stage === "source" ? drawable : { width: 360, height: 240, close() {} }
      ),
      canvasFactory: () => canvas,
    });

    assert.ok(result instanceof Blob);
    assert.equal(result.type, "image/jpeg");
    assert.notEqual(result, source);
    assert.equal(canvas.width, 0, "the ephemeral output canvas is released");
    assert.deepEqual(calls.find(([name]) => name === "fillRect"), [
      "fillRect", "#ffffff", 0, 0, 360, 240,
    ]);
    assert.deepEqual(calls.find(([name]) => name === "drawImage"), [
      "drawImage", drawable, 112, 0, 135, 240,
    ]);
    assert.deepEqual(calls.find(([name]) => name === "convertToBlob"), [
      "convertToBlob",
      { type: "image/jpeg", quality: 0.72 },
    ]);
    assert.equal(context.imageSmoothingEnabled, true);
    assert.equal(context.imageSmoothingQuality, "high");
    assert.deepEqual(PAYMENT_PROOF_THUMBNAIL, {
      width: 360,
      height: 240,
      quality: 0.72,
      mediaType: "image/jpeg",
    });
  });

  it("renders only the first PDF page and then re-encodes it as JPEG", async () => {
    const source = sourceBlob("application/pdf");
    const rendered = { width: 612, height: 792, source: { kind: "page-one" }, close() {} };
    const { canvas, calls } = canvasHarness();
    let request;
    const result = await createPaymentProofThumbnail(source, {
      bitmapFactory: async (_blob, { stage }) => {
        assert.equal(stage, "output-validation");
        return { width: 360, height: 240, close() {} };
      },
      canvasFactory: () => canvas,
      pdfRenderer: async (blob, options) => {
        request = { blob, options };
        return rendered;
      },
    });

    assert.equal(result.type, "image/jpeg");
    assert.equal(request.blob, source);
    assert.equal(request.options.pageNumber, 1);
    assert.equal(request.options.maxWidth, 360);
    assert.equal(request.options.maxHeight, 240);
    assert.deepEqual(calls.find(([name]) => name === "drawImage"), [
      "drawImage", rendered.source, 87, 0, 185, 240,
    ]);
  });

  it("can return verified JPEG bytes for spreadsheet embedding", async () => {
    const source = sourceBlob("image/webp");
    const encoded = jpegBlob(360, 240, [7, 8, 9]);
    const { canvas } = canvasHarness(encoded);
    const result = await createPaymentProofThumbnail(source, {
      output: "uint8array",
      bitmapFactory: bitmapFactoryForSource({ width: 800, height: 600 }),
      canvasFactory: () => canvas,
    });
    assert.ok(result instanceof Uint8Array);
    assert.deepEqual(result, new Uint8Array(await encoded.arrayBuffer()));
  });

  it("fails closed for unsupported or signature-mismatched input", async () => {
    await assert.rejects(
      () => createPaymentProofThumbnail(new Blob(["text"], { type: "text/plain" })),
      (error) => error instanceof PaymentProofThumbnailError
        && error.code === "source-media-type-unsupported",
    );
    await assert.rejects(
      () => createPaymentProofThumbnail(new Blob(["not-a-png"], { type: "image/png" })),
      (error) => error instanceof PaymentProofThumbnailError
        && error.code === "source-signature-invalid",
    );
  });

  it("rejects invalid source dimensions and closes the decoded resource", async () => {
    let closed = false;
    await assert.rejects(
      () => createPaymentProofThumbnail(sourceBlob("image/jpeg"), {
        bitmapFactory: async () => ({ width: 0, height: 100, close() { closed = true; } }),
        canvasFactory: () => {
          throw new Error("canvas must not be reached");
        },
      }),
      (error) => error instanceof PaymentProofThumbnailError
        && error.code === "image-dimensions-invalid",
    );
    assert.equal(closed, true);
  });

  it("rejects an encoder fallback that returns the original JPEG bytes", async () => {
    const source = jpegBlob(360, 240, [4, 5, 6]);
    const { canvas } = canvasHarness(source);
    await assert.rejects(
      () => createPaymentProofThumbnail(source, {
        bitmapFactory: bitmapFactoryForSource({ width: 100, height: 100 }),
        canvasFactory: () => canvas,
      }),
      (error) => error instanceof PaymentProofThumbnailError
        && error.code === "original-bytes-rejected",
    );
  });

  it("rejects encoded output with the wrong MIME type or dimensions", async () => {
    const source = sourceBlob("image/png");
    const wrongType = new Blob([await jpegBlob().arrayBuffer()], { type: "image/png" });
    const wrongDimensions = jpegBlob(359, 240);
    for (const [encoded, expectedCode] of [
      [wrongType, "jpeg-output-invalid"],
      [wrongDimensions, "jpeg-dimensions-invalid"],
    ]) {
      const { canvas } = canvasHarness(encoded);
      await assert.rejects(
        () => createPaymentProofThumbnail(source, {
          bitmapFactory: bitmapFactoryForSource({ width: 400, height: 300 }),
          canvasFactory: () => canvas,
        }),
        (error) => error instanceof PaymentProofThumbnailError
          && error.code === expectedCode,
      );
    }
  });

  it("rejects output that claims valid headers but cannot be decoded", async () => {
    const source = sourceBlob("image/png");
    const { canvas } = canvasHarness();
    await assert.rejects(
      () => createPaymentProofThumbnail(source, {
        bitmapFactory: async (_blob, { stage }) => {
          if (stage === "source") return { width: 400, height: 300, close() {} };
          throw new Error("corrupt JPEG payload");
        },
        canvasFactory: () => canvas,
      }),
      (error) => error instanceof PaymentProofThumbnailError
        && error.code === "jpeg-decode-invalid",
    );
  });
});
