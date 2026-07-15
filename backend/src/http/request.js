import { HttpError } from "./errors.js";

const DEFAULT_MAX_BYTES = 1_048_576;

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
