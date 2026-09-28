import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { decodeInvoiceQrUrlFromImage, MAX_INVOICE_QR_IMAGE_BYTES } from "../src/travelExpense/invoiceQrImage.js";
import { VALID_JPEG, VALID_PNG } from "./helpers/image-fixtures.js";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

function qrFixture(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.H);
  qr.addData(value);
  qr.make();
  const scale = 6;
  const quietZone = 4;
  const modules = qr.getModuleCount();
  const size = (modules + quietZone * 2) * scale;
  const data = Buffer.alloc(size * size * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = 255;
  }
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!qr.isDark(row, column)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const offset = (((row + quietZone) * scale + y) * size + (column + quietZone) * scale + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }
  return { width: size, height: size, data };
}

describe("invoice QR image decoding", () => {
  it("decodes a real generated tax QR from PNG and JPEG bytes", () => {
    const url = "https://einvoice.chinatax.gov.cn/download?token=generated-fixture";
    const raster = qrFixture(url);
    const png = PNG.sync.write(raster);
    const jpegBytes = jpeg.encode(raster, 95).data;

    assert.equal(decodeInvoiceQrUrlFromImage(png, "image/png"), url);
    assert.equal(decodeInvoiceQrUrlFromImage(jpegBytes, "image/jpeg"), url);
  });

  it("decodes PNG and JPEG images and normalizes official tax links", () => {
    const url = "https://einvoice.chinatax.gov.cn/download?token=fixture";
    const qrDecoder = () => ({ data: url });

    assert.equal(decodeInvoiceQrUrlFromImage(VALID_PNG, "image/png", { qrDecoder }), url);
    assert.equal(decodeInvoiceQrUrlFromImage(VALID_JPEG, "image/jpeg; charset=binary", { qrDecoder }), url);
  });

  it("rejects invalid images, unsupported types, unsafe QR links, and oversized input", () => {
    assert.equal(decodeInvoiceQrUrlFromImage(VALID_PNG, "image/webp", { qrDecoder: () => null }), null);
    assert.equal(decodeInvoiceQrUrlFromImage(Buffer.from("not an image"), "image/png"), null);
    assert.equal(decodeInvoiceQrUrlFromImage(VALID_PNG, "image/png", { qrDecoder: () => null }), null);
    assert.equal(
      decodeInvoiceQrUrlFromImage(VALID_PNG, "image/png", {
        qrDecoder: () => ({ data: "https://attacker.example/invoice.pdf" }),
      }),
      null,
    );
    assert.equal(
      decodeInvoiceQrUrlFromImage(Buffer.alloc(MAX_INVOICE_QR_IMAGE_BYTES + 1), "image/png"),
      null,
    );
  });
});
