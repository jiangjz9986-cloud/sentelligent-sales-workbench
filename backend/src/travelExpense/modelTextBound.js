export const MAX_MODEL_TEXT_CHARS = 200_000;
export const MAX_MODEL_RESPONSE_BYTES = 512 * 1024;

export async function readBoundedModelResponseText(response) {
  const contentLength = response?.headers?.get?.("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_MODEL_RESPONSE_BYTES)) {
    try { await response?.body?.cancel?.(); } catch {}
    throw new Error("model response too large");
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    if (typeof response?.text !== "function") throw new Error("invalid model response");
    const text = await response.text();
    if (Buffer.byteLength(String(text ?? ""), "utf8") > MAX_MODEL_RESPONSE_BYTES) throw new Error("model response too large");
    return String(text ?? "");
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid model response");
      total += value.byteLength;
      if (total > MAX_MODEL_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("model response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function boundModelText(value, max = MAX_MODEL_TEXT_CHARS) {
  const text = String(value ?? "").trim();
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new TypeError("max must be a positive safe integer");
  }
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
