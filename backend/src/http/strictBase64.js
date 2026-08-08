export class Base64DecodingError extends Error {
  constructor(reason = "base64") {
    super(reason === "maxDecodedBytes" ? "Decoded Base64 content is too large" : "Base64 content is invalid");
    this.name = "Base64DecodingError";
    this.code = "INVALID_BASE64";
    this.reason = reason;
  }
}

function hasBase64AlphabetAndTerminalPadding(value) {
  let contentLength = value.length;
  if (value.endsWith("==")) contentLength -= 2;
  else if (value.endsWith("=")) contentLength -= 1;

  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!allowed) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

export function decodeCanonicalBase64(value, { maxDecodedBytes } = {}) {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1) {
    throw new TypeError("maxDecodedBytes must be a positive safe integer");
  }
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new Base64DecodingError("base64");
  }
  const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4;
  if (value.length > maxEncodedLength) throw new Base64DecodingError("maxDecodedBytes");
  if (!hasBase64AlphabetAndTerminalPadding(value)) throw new Base64DecodingError("base64");

  const content = Buffer.from(value, "base64");
  if (content.length > maxDecodedBytes) throw new Base64DecodingError("maxDecodedBytes");
  if (content.toString("base64") !== value) throw new Base64DecodingError("base64");
  return content;
}
