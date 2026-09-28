import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import { normalizeInvoiceQrUrl } from "../../../shared/invoiceQrUrl.mjs";

export const MAX_INVOICE_QR_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_INVOICE_QR_IMAGE_PIXELS = 24_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function declaredImageType(mediaType) {
  const value = String(mediaType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (value === "image/jpeg" || value === "image/jpg") return "jpeg";
  if (value === "image/png") return "png";
  return null;
}

function decodePng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!validDimensions(width, height)) return null;
  return PNG.sync.read(buffer);
}

function decodeJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  return jpeg.decode(buffer, {
    formatAsRGBA: true,
    maxMemoryUsageInMB: 96,
    maxResolutionInMP: MAX_INVOICE_QR_IMAGE_PIXELS / 1_000_000,
    useTArray: true,
  });
}

function validDimensions(width, height) {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width > 0
    && height > 0
    && width * height <= MAX_INVOICE_QR_IMAGE_PIXELS;
}

function decodeRaster(buffer, type) {
  if (type === "png") return decodePng(buffer);
  if (type === "jpeg") return decodeJpeg(buffer);
  return null;
}

export function decodeInvoiceQrUrlFromImage(content, mediaType, {
  qrDecoder = jsQR,
  rasterDecoder = decodeRaster,
} = {}) {
  const type = declaredImageType(mediaType);
  if (!type || !Buffer.isBuffer(content) || content.length < 1 || content.length > MAX_INVOICE_QR_IMAGE_BYTES) {
    return null;
  }

  try {
    const raster = rasterDecoder(content, type);
    if (!raster || !validDimensions(raster.width, raster.height)) return null;
    const data = raster.data;
    if (!data || data.byteLength !== raster.width * raster.height * 4) return null;
    const pixels = data instanceof Uint8ClampedArray
      ? data
      : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const decoded = qrDecoder(pixels, raster.width, raster.height, { inversionAttempts: "attemptBoth" });
    if (typeof decoded?.data !== "string" || !decoded.data) return null;
    try {
      return normalizeInvoiceQrUrl(decoded.data);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
