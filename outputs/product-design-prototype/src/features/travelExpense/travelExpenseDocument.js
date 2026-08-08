const ACCEPTED_DOCUMENT_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const ACCEPTED_DOCUMENT_TYPE_SET = new Set(ACCEPTED_DOCUMENT_TYPES);
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const EXTENSION_MEDIA_TYPES = Object.freeze({
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
});

function normalizedMediaType(file) {
  const declaredType = String(file?.type ?? "").trim().toLowerCase();
  if (ACCEPTED_DOCUMENT_TYPE_SET.has(declaredType)) return declaredType;
  if (!declaredType) {
    const fileName = String(file?.name ?? "").trim().toLowerCase();
    const extension = Object.keys(EXTENSION_MEDIA_TYPES).find((candidate) => fileName.endsWith(candidate));
    if (extension) return EXTENSION_MEDIA_TYPES[extension];
  }
  throw new TypeError("仅支持 JPEG、PNG、WebP 图片或 PDF 文件");
}

function bytesToBase64(bytes) {
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return globalThis.btoa(chunks.join(""));
}

export function isTravelExpensePdf(document) {
  const mediaType = String(document?.mediaType ?? "").trim().toLowerCase();
  if (mediaType) return mediaType === "application/pdf";
  return String(document?.fileName ?? "").trim().toLowerCase().endsWith(".pdf");
}

export function isTravelExpenseImage(document) {
  return String(document?.mediaType ?? "").toLowerCase().startsWith("image/");
}

export async function prepareTravelExpenseDocument(file, {
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new TypeError("请选择需要上传的凭证附件");
  }
  const fileName = String(file.name ?? "");
  if (!fileName.trim()) throw new TypeError("附件文件名不能为空");
  const mediaType = normalizedMediaType(file);
  const declaredSize = Number(file.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) {
    throw new TypeError("附件不能为空");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("附件大小上限无效");
  }
  if (declaredSize > maxBytes) {
    throw new TypeError("附件不能超过 12 MiB；系统不会缩放、转码或降低原文件清晰度");
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error("无法读取凭证附件，请重新选择文件");
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== declaredSize) {
    throw new Error("凭证附件读取不完整，请重新选择文件");
  }

  return {
    fileName,
    mediaType,
    sizeBytes: bytes.byteLength,
    contentBase64: bytesToBase64(bytes),
  };
}

export const travelExpenseDocumentLimits = Object.freeze({
  acceptedTypes: ACCEPTED_DOCUMENT_TYPES,
  maxBytes: DEFAULT_MAX_BYTES,
});
