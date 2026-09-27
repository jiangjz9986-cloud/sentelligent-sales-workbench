import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeInvoiceQrUrl } from "../../../../../shared/invoiceQrUrl.mjs";
import { decodeInvoiceQrImage } from "./invoiceQr.js";
import { assertInvoiceQrPdfResponse } from "./invoiceQrResponse.js";

describe("invoice QR import", () => {
  it("accepts only HTTPS URLs under the official tax domain", () => {
    assert.equal(
      normalizeInvoiceQrUrl("https://einvoice.chinatax.gov.cn/download?id=secret"),
      "https://einvoice.chinatax.gov.cn/download?id=secret",
    );
    assert.equal(
      normalizeInvoiceQrUrl("https://dppt.shandong.chinatax.gov.cn:8443/download?id=fixture"),
      "https://dppt.shandong.chinatax.gov.cn:8443/download?id=fixture",
    );
    for (const value of [
      "http://einvoice.chinatax.gov.cn/a.pdf",
      "https://chinatax.gov.cn.attacker.example/a.pdf",
      "https://attacker.example/?next=chinatax.gov.cn",
      "https://user@einvoice.chinatax.gov.cn/a.pdf",
      "https://einvoice.chinatax.gov.cn:8444/a.pdf",
      "https://einvoice.chinatax.gov.cn/a.pdf#fragment",
      "not-a-url",
    ]) {
      assert.throws(() => normalizeInvoiceQrUrl(value));
    }
  });

  it("decodes locally, validates the tax URL, and releases bitmap resources", async () => {
    const pixelData = new Uint8ClampedArray(4);
    let closed = false;
    const decoded = await decodeInvoiceQrImage(
      { type: "image/png", size: 4 },
      {
        bitmapFactory: async () => ({ width: 1, height: 1, close() { closed = true; } }),
        canvasFactory: () => ({
          getContext() {
            return {
              drawImage() {},
              getImageData() { return { data: pixelData }; },
            };
          },
        }),
        decodeQr(data, width, height, options) {
          assert.equal(data, pixelData);
          assert.equal(width, 1);
          assert.equal(height, 1);
          assert.equal(options.inversionAttempts, "attemptBoth");
          return { data: "https://einvoice.chinatax.gov.cn/download?token=fixture" };
        },
      },
    );

    assert.equal(decoded, "https://einvoice.chinatax.gov.cn/download?token=fixture");
    assert.equal(closed, true);
  });

  it("rejects unclear, malformed, non-tax, and oversized QR input", async () => {
    const file = { type: "image/png", size: 10 };
    const factories = {
      bitmapFactory: async () => ({ width: 1, height: 1, close() {} }),
      canvasFactory: () => ({
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
      }),
    };
    await assert.rejects(decodeInvoiceQrImage(file, { ...factories, decodeQr: () => null }), /没有识别到二维码/u);
    await assert.rejects(
      decodeInvoiceQrImage(file, { ...factories, decodeQr: () => ({ data: "https://example.com/invoice" }) }),
      /仅支持国家税务总局/u,
    );
    await assert.rejects(
      decodeInvoiceQrImage({ ...file, size: 12 * 1024 * 1024 + 1 }, factories),
      /不能超过 12 MiB/u,
    );
  });

  it("validates QR-fetched PDF responses before invoice upload", () => {
    const valid = {
      fileName: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: 8,
      contentBase64: "JVBERi0xLjQ=",
    };
    assert.equal(assertInvoiceQrPdfResponse(valid), valid);
    for (const patch of [
      { fileName: "page.html" },
      { mediaType: "text/html" },
      { contentBase64: "<html>" },
      { sizeBytes: 7 },
      { sizeBytes: 12 * 1024 * 1024 + 1 },
    ]) {
      assert.throws(() => assertInvoiceQrPdfResponse({ ...valid, ...patch }), /invalid PDF response/u);
    }
  });
});
