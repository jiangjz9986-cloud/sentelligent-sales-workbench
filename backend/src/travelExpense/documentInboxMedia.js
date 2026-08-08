import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  detectDocumentType,
  inspectInvoiceFile,
  validateDocumentFileName,
} from "./invoiceRecognition.js";
import { Base64DecodingError, decodeCanonicalBase64 } from "../http/strictBase64.js";

export const MAX_WEIXIN_DOCUMENT_BYTES = 12 * 1024 * 1024;

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const EXTENSION_BY_MEDIA_TYPE = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
]);

export class WeixinDocumentError extends Error {
  constructor(code) {
    super(code);
    this.name = "WeixinDocumentError";
    this.code = code;
  }
}

function fail(code) {
  throw new WeixinDocumentError(code);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validatedFileName(media, fallbackName, mediaType, sha256) {
  const supplied = cleanText(media?.fileName);
  if (supplied && (supplied === "." || supplied === ".." || /[\\/]/u.test(supplied))) {
    fail("invalid_filename");
  }

  let fileName = supplied || cleanText(fallbackName);
  if (!fileName) fileName = `weixin-${sha256.slice(0, 16)}${EXTENSION_BY_MEDIA_TYPE.get(mediaType)}`;
  try {
    fileName = validateDocumentFileName(fileName);
  } catch {
    fail("invalid_filename");
  }

  const extension = extname(fileName).toLowerCase();
  if (!supplied && ![".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(extension)) {
    fileName = `weixin-${sha256.slice(0, 16)}${EXTENSION_BY_MEDIA_TYPE.get(mediaType)}`;
  }
  return fileName;
}

function validateDeclaredMedia(media, detectedMediaType) {
  const mediaKind = cleanText(media?.type);
  const declaredMediaType = cleanText(media?.mimeType ?? media?.mediaType).toLowerCase();

  if (mediaKind !== "image" && mediaKind !== "file") fail("unsupported_media");
  if (mediaKind === "image" && !detectedMediaType.startsWith("image/")) fail("mime_mismatch");

  if (declaredMediaType === "image/*" && mediaKind === "image") return;
  if (!SUPPORTED_MEDIA_TYPES.has(declaredMediaType)) fail("unsupported_media");
  if (declaredMediaType !== detectedMediaType) fail("mime_mismatch");
}

export async function readWeixinDocument(media) {
  if (!media) fail("missing_media");
  if (!["image", "file"].includes(cleanText(media.type))) fail("unsupported_media");

  const filePath = cleanText(media.filePath);
  let content;
  let fallbackName = cleanText(media.fileName);
  const encoded = typeof media.contentBase64 === "string" ? media.contentBase64 : "";
  if (encoded) {
    try {
      content = decodeCanonicalBase64(encoded, { maxDecodedBytes: MAX_WEIXIN_DOCUMENT_BYTES });
    } catch (error) {
      if (error instanceof Base64DecodingError && error.reason === "maxDecodedBytes") fail("too_large");
      fail("file_unavailable");
    }
  } else {
    if (!filePath) fail("file_unavailable");
    let fileStat;
    try {
      fileStat = await lstat(filePath);
    } catch {
      fail("file_unavailable");
    }
    if (!fileStat.isFile()) fail("file_unavailable");
    if (fileStat.size > MAX_WEIXIN_DOCUMENT_BYTES) fail("too_large");
    try {
      content = await readFile(filePath);
    } catch {
      fail("file_unavailable");
    }
    fallbackName ||= basename(filePath);
  }
  if (content.length > MAX_WEIXIN_DOCUMENT_BYTES) fail("too_large");

  const detectedMediaType = detectDocumentType(content);
  if (!detectedMediaType) fail("invalid_magic");
  validateDeclaredMedia(media, detectedMediaType);

  let inspected;
  try {
    inspected = inspectInvoiceFile({
      fileName: fallbackName || "weixin-document",
      mediaType: detectedMediaType,
      buffer: content,
    });
  } catch {
    fail("invalid_magic");
  }

  return {
    fileName: validatedFileName(media, fallbackName, detectedMediaType, inspected.sha256),
    mediaType: detectedMediaType,
    contentBase64: inspected.buffer.toString("base64"),
    sha256: inspected.sha256,
  };
}

function validDateParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractOccurredOn(text, now) {
  const full = text.match(/(?:^|\D)(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})(?:日|\b)/u);
  if (full) return validDateParts(Number(full[1]), Number(full[2]), Number(full[3]));

  const short = text.match(/(?:^|\D)(\d{1,2})月(\d{1,2})日?/u);
  if (!short) return null;
  return validDateParts(now.getFullYear(), Number(short[1]), Number(short[2]));
}

function extractPaidTime(text) {
  const colon = text.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/u);
  if (colon) return `${String(Number(colon[1])).padStart(2, "0")}:${colon[2]}`;

  const chinese = text.match(/(?:^|\D)([01]?\d|2[0-3])点(?:([0-5]?\d)分?)?(?:\D|$)/u);
  if (!chinese) return null;
  return `${String(Number(chinese[1])).padStart(2, "0")}:${String(Number(chinese[2] ?? 0)).padStart(2, "0")}`;
}

function amountStringToCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const decimals = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + decimals;
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function extractAmountCents(text) {
  const currency = text.match(/(?:人民币\s*)?(?:[¥￥]\s*)?(\d{1,9}(?:\.\d{1,2})?)\s*(?:元|块)(?:钱)?/u)
    ?? text.match(/[¥￥]\s*(\d{1,9}(?:\.\d{1,2})?)/u)
    ?? text.match(/金额\s*[:：]?\s*(\d{1,9}(?:\.\d{1,2})?)/u);
  return currency ? amountStringToCents(currency[1]) : null;
}

export function parsePaymentProofCommandArgs(value, now = new Date()) {
  const args = cleanText(value);
  const referenceMatch = args.match(/(?:^|\s)(EXP-[A-Za-z0-9][A-Za-z0-9_-]{0,190})(?=\s|$)/iu);
  const expenseReferenceCode = referenceMatch?.[1] ?? null;
  const textHint = cleanText(referenceMatch
    ? `${args.slice(0, referenceMatch.index)} ${args.slice(referenceMatch.index + referenceMatch[0].length)}`
    : args);

  return {
    expenseReferenceCode,
    textHint: textHint || null,
    amountCents: extractAmountCents(textHint),
    occurredOn: extractOccurredOn(textHint, now),
    paidTime: extractPaidTime(textHint),
    matchMode: expenseReferenceCode ? "expense_reference" : "candidates_only",
  };
}

export function weixinDocumentSourceRef(request, sha256) {
  const supplied = cleanText(request?.messageId ?? request?.sourceMessageId);
  if (supplied && supplied.length <= 500 && !/[\u0000-\u001f\u007f-\u009f]/u.test(supplied)) return supplied;
  return `weixin:${sha256}`;
}
