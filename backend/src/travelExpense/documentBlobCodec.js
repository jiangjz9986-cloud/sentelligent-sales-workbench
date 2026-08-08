import { createHash } from "node:crypto";
import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ENCODINGS = new Set(["identity", "br"]);

export class DocumentBlobIntegrityError extends Error {
  constructor(message = "Stored document blob failed integrity validation", options) {
    super(message, options);
    this.name = "DocumentBlobIntegrityError";
    this.code = "DOCUMENT_BLOB_INTEGRITY";
  }
}

function requiredBytes(value, message) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function documentBlobId(ownerValue, sha256Value) {
  if (typeof ownerValue !== "string" || !ownerValue.trim() || ownerValue.length > 200) {
    throw new TypeError("document blob owner is required");
  }
  if (typeof sha256Value !== "string" || !SHA256_PATTERN.test(sha256Value)) {
    throw new TypeError("document blob SHA-256 is invalid");
  }
  return createHash("sha256")
    .update(ownerValue.trim(), "utf8")
    .update("\0", "utf8")
    .update(sha256Value, "ascii")
    .digest("hex");
}

function integrityFailure(message, cause) {
  throw new DocumentBlobIntegrityError(message, cause ? { cause } : undefined);
}

function compressionOptions(original) {
  return {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: original.length,
    },
  };
}

function encodedDocumentBlob(original, compressed) {
  const useCompressed = compressed.length < original.length;
  const content = useCompressed ? compressed : original;

  return {
    encoding: useCompressed ? "br" : "identity",
    originalSizeBytes: original.length,
    storedSizeBytes: content.length,
    sha256: sha256(original),
    content: Buffer.from(content),
  };
}

export function encodeDocumentBlob(value) {
  const original = requiredBytes(value, "document blob must be a Buffer or Uint8Array");
  if (original.length < 1) throw new TypeError("document blob must contain at least one byte");
  return encodedDocumentBlob(
    original,
    brotliCompressSync(original, compressionOptions(original)),
  );
}

export async function encodeDocumentBlobAsync(value) {
  const original = requiredBytes(value, "document blob must be a Buffer or Uint8Array");
  if (original.length < 1) throw new TypeError("document blob must contain at least one byte");
  const compressed = await new Promise((resolve, reject) => {
    brotliCompress(original, compressionOptions(original), (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  return encodedDocumentBlob(original, compressed);
}

export function decodeDocumentBlob(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    integrityFailure("Stored document blob metadata is invalid");
  }

  const encoding = record.encoding;
  const originalSizeBytes = record.originalSizeBytes;
  const storedSizeBytes = record.storedSizeBytes;
  const expectedSha256 = record.sha256;
  let stored;
  try {
    stored = requiredBytes(record.content, "stored document content is invalid");
  } catch (error) {
    integrityFailure("Stored document content is invalid", error);
  }

  if (!ENCODINGS.has(encoding)) integrityFailure("Stored document encoding is invalid");
  if (!Number.isSafeInteger(originalSizeBytes) || originalSizeBytes < 1) {
    integrityFailure("Stored document original length is invalid");
  }
  if (!Number.isSafeInteger(storedSizeBytes) || storedSizeBytes < 1) {
    integrityFailure("Stored document encoded length is invalid");
  }
  if (stored.length !== storedSizeBytes) integrityFailure("Stored document encoded length does not match content");
  if (typeof expectedSha256 !== "string" || !SHA256_PATTERN.test(expectedSha256)) {
    integrityFailure("Stored document SHA-256 is invalid");
  }
  if (encoding === "identity" && storedSizeBytes !== originalSizeBytes) {
    integrityFailure("Identity document length does not match original length");
  }
  if (encoding === "br" && storedSizeBytes >= originalSizeBytes) {
    integrityFailure("Compressed document does not reduce stored length");
  }

  let original;
  if (encoding === "identity") {
    original = stored;
  } else {
    try {
      original = brotliDecompressSync(stored, { maxOutputLength: originalSizeBytes });
    } catch (error) {
      integrityFailure("Stored document cannot be decompressed", error);
    }
  }

  if (original.length !== originalSizeBytes) integrityFailure("Restored document length is invalid");
  if (sha256(original) !== expectedSha256) integrityFailure("Restored document SHA-256 does not match");
  return Buffer.from(original);
}
