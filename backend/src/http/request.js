import { HttpError } from "./errors.js";

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_RESPONSE_MAX_BYTES = 512 * 1024;

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

export async function readJsonBody(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  validateMaxBytes(maxBytes);

  const chunks = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (bytesRead > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks, bytesRead).toString("utf8");
  if (!body.trim()) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function validateResponseMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

/**
 * Read an upstream response without allowing an unbounded provider body to
 * accumulate in memory. Real Fetch responses are consumed as a byte stream;
 * small test doubles that only expose text() are checked after reading.
 */
export async function readBoundedResponseText(
  response,
  { maxBytes = DEFAULT_RESPONSE_MAX_BYTES, errorMessage = "Response body is too large" } = {},
) {
  validateResponseMaxBytes(maxBytes);
  const contentLength = response?.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    if (!/^\d+$/u.test(String(contentLength)) || Number(contentLength) > maxBytes) {
      try { await response?.body?.cancel?.(); } catch {}
      throw new Error(errorMessage);
    }
  }

  const reader = response?.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("Response body is invalid");
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(errorMessage);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total).toString("utf8");
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  if (typeof response?.text !== "function") throw new Error("Response body is invalid");
  const text = await response.text();
  if (Buffer.byteLength(String(text ?? ""), "utf8") > maxBytes) throw new Error(errorMessage);
  return String(text ?? "");
}
