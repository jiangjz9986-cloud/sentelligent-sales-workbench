import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const CATEGORY_VALUES = new Set([
  "breakfast",
  "lunch",
  "dinner",
  "lodging",
  "transport",
  "hospitality",
  "other",
]);
const RECOGNITION_FIELDS = [
  "invoiceCode",
  "invoiceNumber",
  "issuedOn",
  "sellerName",
  "buyerName",
  "amountExTaxCents",
  "taxCents",
  "totalCents",
  "suggestedCategory",
];
const MONEY_FIELDS = new Set(["amountExTaxCents", "taxCents", "totalCents"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = new Uint32Array(256);
const MAX_DECODED_IMAGE_BYTES = 256 * 1024 * 1024;
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const PDF_EOF_MARKER = Buffer.from("%%EOF", "ascii");
const PDF_STARTXREF_MARKER = Buffer.from("startxref", "ascii");

for (let index = 0; index < PNG_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  PNG_CRC_TABLE[index] = value >>> 0;
}

function requiredBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("document buffer is required");
}

export function validateDocumentFileName(value, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError("fileName must be a non-empty string of at most 500 characters");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError("fileName contains control characters");
  }
  return value;
}

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngBitsPerPixel(bitDepth, colorType) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const allowedDepths = {
    0: new Set([1, 2, 4, 8, 16]),
    2: new Set([8, 16]),
    3: new Set([1, 2, 4, 8]),
    4: new Set([8, 16]),
    6: new Set([8, 16]),
  }[colorType];
  if (!channels || !allowedDepths?.has(bitDepth)) return null;
  return channels * bitDepth;
}

function pngPasses(width, height, interlace) {
  if (interlace === 0) return [{ width, height }];
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  return passes.map(([startX, startY, stepX, stepY]) => ({
    width: width <= startX ? 0 : Math.ceil((width - startX) / stepX),
    height: height <= startY ? 0 : Math.ceil((height - startY) / stepY),
  }));
}

function validPngScanlines(decoded, width, height, bitsPerPixel, interlace) {
  let expectedBytes = 0;
  const rows = [];
  for (const pass of pngPasses(width, height, interlace)) {
    if (pass.width === 0 || pass.height === 0) continue;
    const rowBytes = Math.ceil((pass.width * bitsPerPixel) / 8);
    const passBytes = (rowBytes + 1) * pass.height;
    if (!Number.isSafeInteger(passBytes) || expectedBytes + passBytes > MAX_DECODED_IMAGE_BYTES) return false;
    rows.push({ rowBytes, height: pass.height });
    expectedBytes += passBytes;
  }
  if (decoded.length !== expectedBytes) return false;
  let offset = 0;
  for (const row of rows) {
    for (let index = 0; index < row.height; index += 1) {
      if (decoded[offset] > 4) return false;
      offset += row.rowBytes + 1;
    }
  }
  return offset === decoded.length;
}

function isValidPng(buffer) {
  if (!startsWith(buffer, PNG_SIGNATURE) || buffer.length < 45) return false;
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  const imageData = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) return false;
    const typeBytes = buffer.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (pngCrc32(buffer.subarray(typeStart, dataEnd)) !== buffer.readUInt32BE(dataEnd)) return false;
    const data = buffer.subarray(dataStart, dataEnd);

    if (!header && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (header || offset !== PNG_SIGNATURE.length || length !== 13) return false;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const bitsPerPixel = pngBitsPerPixel(bitDepth, colorType);
      if (
        width === 0
        || height === 0
        || !bitsPerPixel
        || data[10] !== 0
        || data[11] !== 0
        || ![0, 1].includes(data[12])
      ) return false;
      header = { width, height, bitsPerPixel, colorType, interlace: data[12] };
    } else if (type === "PLTE") {
      if (sawImageData || sawPalette || length < 3 || length > 768 || length % 3 !== 0) return false;
      if ([0, 4].includes(header.colorType)) return false;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (header.colorType === 3 && !sawPalette)) return false;
      sawImageData = true;
      imageData.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== buffer.length) return false;
      let decoded;
      try {
        decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: MAX_DECODED_IMAGE_BYTES });
      } catch {
        return false;
      }
      return validPngScanlines(
        decoded,
        header.width,
        header.height,
        header.bitsPerPixel,
        header.interlace,
      );
    } else {
      if (sawImageData) imageDataEnded = true;
      if ((typeBytes[0] & 0x20) === 0) return false;
    }
    offset = chunkEnd;
  }
  return false;
}

function isValidJpeg(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEntropyData = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return false;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && sawEntropyData && offset === buffer.length;
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > buffer.length) return false;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return false;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) return false;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      const components = buffer[offset + 7];
      if (width === 0 || height === 0 || components < 1 || segmentLength !== 8 + (3 * components)) return false;
      sawFrame = true;
    }

    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }
    if (!sawFrame || segmentLength < 8) return false;
    sawScan = true;
    offset += segmentLength;
    let scanBytes = 0;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        scanBytes += 1;
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return false;
      const scanMarker = buffer[offset];
      offset += 1;
      if (scanMarker === 0x00) {
        scanBytes += 1;
        continue;
      }
      if (scanMarker >= 0xd0 && scanMarker <= 0xd7) continue;
      sawEntropyData ||= scanBytes > 0;
      if (scanMarker === 0xd9) {
        return sawFrame && sawScan && sawEntropyData && offset === buffer.length;
      }
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function validVp8Chunk(buffer, offset, length) {
  if (length <= 10 || (buffer[offset] & 1) !== 0) return false;
  if (!buffer.subarray(offset + 3, offset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return false;
  return (buffer.readUInt16LE(offset + 6) & 0x3fff) > 0
    && (buffer.readUInt16LE(offset + 8) & 0x3fff) > 0;
}

function validVp8LosslessChunk(buffer, offset, length) {
  if (length <= 5 || buffer[offset] !== 0x2f) return false;
  const dimensions = buffer.readUInt32LE(offset + 1);
  return (dimensions >>> 29) === 0;
}

function isValidWebp(buffer) {
  if (
    buffer.length < 20
    || buffer.subarray(0, 4).toString("ascii") !== "RIFF"
    || buffer.subarray(8, 12).toString("ascii") !== "WEBP"
    || buffer.readUInt32LE(4) !== buffer.length - 8
  ) return false;

  let offset = 12;
  let imageChunks = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return false;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > buffer.length) return false;
    if ((length & 1) && buffer[dataEnd] !== 0) return false;

    if (type === "VP8 ") {
      if (!validVp8Chunk(buffer, dataStart, length)) return false;
      imageChunks += 1;
    } else if (type === "VP8L") {
      if (!validVp8LosslessChunk(buffer, dataStart, length)) return false;
      imageChunks += 1;
    } else if (type === "VP8X") {
      if (length !== 10) return false;
      const width = 1 + buffer.readUIntLE(dataStart + 4, 3);
      const height = 1 + buffer.readUIntLE(dataStart + 7, 3);
      if (width <= 0 || height <= 0) return false;
    }
    if (imageChunks > 1) return false;
    offset = chunkEnd;
  }
  return offset === buffer.length && imageChunks === 1;
}

function isPdfWhitespace(byte) {
  return byte === 0x00
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0c
    || byte === 0x0d
    || byte === 0x20;
}

function containsCompletePdfObject(buffer, endOffset) {
  const text = buffer.subarray(0, endOffset).toString("latin1");
  const objectPattern = /(?:^|[\x00\x09\x0a\x0c\x0d\x20])(\d{1,10})[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,5})[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/g;
  let match;
  while ((match = objectPattern.exec(text))) {
    const endObject = text.indexOf("endobj", objectPattern.lastIndex);
    if (endObject < 0) continue;
    const following = text.charCodeAt(endObject + 6);
    if (Number.isNaN(following) || isPdfWhitespace(following)) return true;
  }
  return false;
}

function hasPdfRootReference(buffer, endOffset) {
  const text = buffer.subarray(0, endOffset).toString("latin1");
  return /\/Root[\x00\x09\x0a\x0c\x0d\x20]+\d{1,10}[\x00\x09\x0a\x0c\x0d\x20]+\d{1,5}[\x00\x09\x0a\x0c\x0d\x20]+R(?:[\x00\x09\x0a\x0c\x0d\x20>\/\[\]() ]|$)/.test(text);
}

function validClassicPdfXref(buffer, xrefOffset, startxrefOffset) {
  const text = buffer.subarray(xrefOffset, startxrefOffset).toString("latin1");
  if (!/^xref(?:\r\n|\r|\n)/.test(text)) return false;
  const trailerOffset = text.lastIndexOf("trailer");
  if (trailerOffset < 0) return false;
  const entries = text.slice(0, trailerOffset);
  if (!/(?:^|\r\n|\r|\n)[\x09\x20]*\d+[\x09\x20]+\d+[\x09\x20]*(?:\r\n|\r|\n)[\x09\x20]*\d{10}[\x09\x20]+\d{5}[\x09\x20]+[fn](?:[\x09\x20]*(?:\r\n|\r|\n)|$)/.test(entries)) {
    return false;
  }
  return /\/Size[\x00\x09\x0a\x0c\x0d\x20]+\d+/.test(text.slice(trailerOffset + 7));
}

function validPdfXrefStream(buffer, xrefOffset, startxrefOffset) {
  const text = buffer.subarray(xrefOffset, startxrefOffset).toString("latin1");
  const objectHeader = /^\d{1,10}[\x00\x09\x0a\x0c\x0d\x20]+\d{1,5}[\x00\x09\x0a\x0c\x0d\x20]+obj(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.exec(text);
  if (!objectHeader) return false;
  const dictionaryStart = text.indexOf("<<", objectHeader[0].length);
  if (dictionaryStart < 0) return false;
  const streamMatch = />>[\x00\x09\x0c\x20]*stream(?:\r\n|\r|\n)/.exec(text.slice(dictionaryStart));
  if (!streamMatch) return false;
  const streamMarkerOffset = dictionaryStart + streamMatch.index;
  const dictionary = text.slice(dictionaryStart, streamMarkerOffset + 2);
  if (!/\/Type[\x00\x09\x0a\x0c\x0d\x20]*\/XRef\b/.test(dictionary)) return false;

  const sizeMatch = /\/Size[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})\b/.exec(dictionary);
  const lengthMatches = [...dictionary.matchAll(/\/Length[\x00\x09\x0a\x0c\x0d\x20]+(\d{1,10})\b/g)];
  const widthMatch = /\/W[\x00\x09\x0a\x0c\x0d\x20]*\[[\x00\x09\x0a\x0c\x0d\x20]*(\d+)[\x00\x09\x0a\x0c\x0d\x20]+(\d+)[\x00\x09\x0a\x0c\x0d\x20]+(\d+)[\x00\x09\x0a\x0c\x0d\x20]*\]/.exec(dictionary);
  if (!sizeMatch || lengthMatches.length !== 1 || !widthMatch) return false;

  const size = Number(sizeMatch[1]);
  const streamLength = Number(lengthMatches[0][1]);
  const widths = widthMatch.slice(1).map(Number);
  const entryWidth = widths.reduce((sum, value) => sum + value, 0);
  if (
    !Number.isSafeInteger(size)
    || size <= 0
    || !Number.isSafeInteger(streamLength)
    || streamLength <= 0
    || widths.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 8)
    || entryWidth <= 0
  ) return false;

  const indexMatch = /\/Index[\x00\x09\x0a\x0c\x0d\x20]*\[([^\]]*)\]/.exec(dictionary);
  let entryCount = size;
  if (indexMatch) {
    const values = indexMatch[1].trim().split(/[\x00\x09\x0a\x0c\x0d\x20]+/).filter(Boolean);
    if (values.length === 0 || values.length % 2 !== 0 || values.some((value) => !/^\d+$/.test(value))) {
      return false;
    }
    entryCount = 0;
    for (let index = 0; index < values.length; index += 2) {
      const firstObject = Number(values[index]);
      const count = Number(values[index + 1]);
      if (
        !Number.isSafeInteger(firstObject)
        || !Number.isSafeInteger(count)
        || count <= 0
        || firstObject < 0
        || firstObject + count > size
      ) return false;
      entryCount += count;
    }
  }

  const streamDataStart = streamMarkerOffset + streamMatch[0].length;
  const streamDataEnd = streamDataStart + streamLength;
  if (streamDataEnd > text.length) return false;
  const tail = text.slice(streamDataEnd);
  if (!/^(?:\r\n|\r|\n)endstream[\x00\x09\x0a\x0c\x0d\x20]+endobj[\x00\x09\x0a\x0c\x0d\x20]*$/.test(tail)) {
    return false;
  }

  let decoded = buffer.subarray(xrefOffset + streamDataStart, xrefOffset + streamDataEnd);
  const filterMatch = /\/Filter[\x00\x09\x0a\x0c\x0d\x20]+\/([A-Za-z0-9]+)\b/.exec(dictionary);
  if (/\/Filter\b/.test(dictionary) && !filterMatch) return false;
  if (filterMatch) {
    if (filterMatch[1] !== "FlateDecode") return false;
    try {
      decoded = inflateSync(decoded, { maxOutputLength: MAX_DOCUMENT_BYTES });
    } catch {
      return false;
    }
  }
  if (decoded.length !== entryCount * entryWidth) return false;

  if (widths[0] > 0) {
    for (let offset = 0; offset < decoded.length; offset += entryWidth) {
      let type = 0n;
      for (let index = 0; index < widths[0]; index += 1) {
        type = (type << 8n) | BigInt(decoded[offset + index]);
      }
      if (type > 2n) return false;
    }
  }
  return true;
}

function isValidPdf(buffer) {
  if (buffer.length < 64) return false;
  const header = buffer.subarray(0, Math.min(buffer.length, 16)).toString("ascii");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(header)) return false;

  const eofOffset = buffer.lastIndexOf(PDF_EOF_MARKER);
  if (eofOffset < 1 || !isPdfWhitespace(buffer[eofOffset - 1])) return false;
  if (buffer.length - eofOffset - PDF_EOF_MARKER.length > 1024) return false;
  for (let offset = eofOffset + PDF_EOF_MARKER.length; offset < buffer.length; offset += 1) {
    if (!isPdfWhitespace(buffer[offset])) return false;
  }

  const startxrefOffset = buffer.lastIndexOf(PDF_STARTXREF_MARKER, eofOffset - 1);
  if (startxrefOffset < 0) return false;
  let cursor = startxrefOffset + PDF_STARTXREF_MARKER.length;
  if (cursor >= eofOffset || !isPdfWhitespace(buffer[cursor])) return false;
  while (cursor < eofOffset && isPdfWhitespace(buffer[cursor])) cursor += 1;
  const numberStart = cursor;
  while (cursor < eofOffset && buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) cursor += 1;
  if (cursor === numberStart) return false;
  const xrefOffset = Number(buffer.subarray(numberStart, cursor).toString("ascii"));
  while (cursor < eofOffset && isPdfWhitespace(buffer[cursor])) cursor += 1;
  if (cursor !== eofOffset || !Number.isSafeInteger(xrefOffset) || xrefOffset <= 0 || xrefOffset >= startxrefOffset) {
    return false;
  }

  if (
    !validClassicPdfXref(buffer, xrefOffset, startxrefOffset)
    && !validPdfXrefStream(buffer, xrefOffset, startxrefOffset)
  ) return false;
  return containsCompletePdfObject(buffer, startxrefOffset)
    && hasPdfRootReference(buffer, startxrefOffset);
}

export function detectDocumentType(value) {
  let buffer;
  try {
    buffer = requiredBuffer(value);
  } catch {
    return null;
  }
  if (isValidPng(buffer)) return "image/png";
  if (isValidJpeg(buffer)) return "image/jpeg";
  if (isValidWebp(buffer)) return "image/webp";
  if (isValidPdf(buffer)) return "application/pdf";
  return null;
}

export function inspectInvoiceFile(file = {}) {
  const fileName = validateDocumentFileName(file.fileName);
  const mediaType = typeof file.mediaType === "string" ? file.mediaType : "";
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) throw new TypeError("unsupported document type");
  const buffer = requiredBuffer(file.buffer);
  if (buffer.length < 1 || buffer.length > MAX_DOCUMENT_BYTES) {
    throw new TypeError("document must contain between 1 byte and 12 MiB");
  }
  const detectedMediaType = detectDocumentType(buffer);
  if (!detectedMediaType) throw new TypeError("unsupported document type");
  if (detectedMediaType !== mediaType) throw new TypeError("document signature does not match mediaType");
  return {
    fileName,
    mediaType,
    sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    buffer,
  };
}

function optionalText(value, field, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function dateOnly(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must be a date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a date`);
  }
  return value;
}

function moneyCents(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) {
    const [whole, fraction = ""] = value.trim().split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (Number.isSafeInteger(cents)) return cents;
  }
  throw new TypeError(`${field} must be a non-negative money amount`);
}

function category(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!CATEGORY_VALUES.has(value)) throw new TypeError("suggestedCategory is invalid");
  return value;
}

function normalizeFields(value, source) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${source} fields must be an object`);
  return {
    invoiceCode: optionalText(value.invoiceCode, "invoiceCode", 100),
    invoiceNumber: optionalText(value.invoiceNumber, "invoiceNumber", 100),
    issuedOn: dateOnly(value.issuedOn, "issuedOn"),
    sellerName: optionalText(value.sellerName, "sellerName", 500),
    buyerName: optionalText(value.buyerName, "buyerName", 500),
    amountExTaxCents: moneyCents(value.amountExTaxCents, "amountExTaxCents"),
    taxCents: moneyCents(value.taxCents, "taxCents"),
    totalCents: moneyCents(value.totalCents, "totalCents"),
    suggestedCategory: category(value.suggestedCategory),
  };
}

export function compareRecognitionSources({ extractedText = "", ocr = null, model = null } = {}) {
  const normalizedOcr = normalizeFields(ocr, "ocr");
  const normalizedModel = normalizeFields(model, "model");
  if (!normalizedOcr && !normalizedModel) {
    return {
      status: "review_required",
      extractedText: String(extractedText ?? ""),
      fields: null,
      ocr: null,
      model: null,
      conflicts: [],
      warnings: ["NO_RECOGNITION_FIELDS"],
    };
  }

  const fields = {};
  const conflicts = [];
  for (const field of RECOGNITION_FIELDS) {
    const ocrValue = normalizedOcr?.[field] ?? null;
    const modelValue = normalizedModel?.[field] ?? null;
    if (ocrValue !== null && modelValue !== null && ocrValue !== modelValue) {
      fields[field] = null;
      conflicts.push({ field, ocrValue, modelValue });
    } else {
      fields[field] = modelValue ?? ocrValue;
    }
  }

  return {
    status: conflicts.length > 0 ? "review_required" : "unmatched",
    extractedText: String(extractedText ?? ""),
    fields,
    ocr: normalizedOcr,
    model: normalizedModel,
    conflicts,
    warnings: [],
  };
}

function stripJsonFence(value) {
  const text = String(value ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function parseModelResult(value) {
  if (typeof value === "string") return JSON.parse(stripJsonFence(value));
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new TypeError("model response must be an object");
}

function warningCode(error, fallback) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : fallback;
  return code;
}

export async function recognizeInvoiceDocument(file, options = {}) {
  const inspected = inspectInvoiceFile(file);
  if (!options.textExtractor || typeof options.textExtractor.extract !== "function") {
    throw new TypeError("textExtractor.extract is required");
  }
  if (typeof options.analyzeText !== "function") throw new TypeError("analyzeText is required");

  let extractedText;
  try {
    const extracted = await options.textExtractor.extract(inspected.mediaType, inspected.buffer);
    extractedText = typeof extracted === "string" ? extracted.trim() : "";
    if (!extractedText) throw Object.assign(new Error("No text was extracted"), { code: "TEXT_EMPTY" });
  } catch (error) {
    return {
      document: {
        fileName: inspected.fileName,
        mediaType: inspected.mediaType,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
      },
      status: "review_required",
      extractedText: null,
      fields: null,
      ocr: null,
      model: null,
      conflicts: [],
      warnings: [warningCode(error, "TEXT_EXTRACTION_FAILED")],
    };
  }

  let model;
  try {
    model = parseModelResult(await options.analyzeText(extractedText));
  } catch (error) {
    return {
      document: {
        fileName: inspected.fileName,
        mediaType: inspected.mediaType,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
      },
      status: "review_required",
      extractedText,
      fields: null,
      ocr: null,
      model: null,
      conflicts: [],
      warnings: [error instanceof SyntaxError ? "MODEL_INVALID_RESPONSE" : "MODEL_UNAVAILABLE"],
    };
  }

  let ocr = null;
  if (typeof options.parseExtractedText === "function") {
    try {
      ocr = await options.parseExtractedText(extractedText);
    } catch {
      ocr = null;
    }
  }
  const compared = compareRecognitionSources({ extractedText, ocr, model });
  return {
    document: {
      fileName: inspected.fileName,
      mediaType: inspected.mediaType,
      sizeBytes: inspected.sizeBytes,
      sha256: inspected.sha256,
    },
    ...compared,
  };
}

export const MAX_INVOICE_DOCUMENT_BYTES = MAX_DOCUMENT_BYTES;
