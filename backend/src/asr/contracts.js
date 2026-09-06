const PURPOSE_DEFINITIONS = {
  quick_record: Object.freeze({
    maxDurationMs: 120_000,
    maxTranscriptLength: 10_000,
  }),
  assistant_chat: Object.freeze({
    maxDurationMs: 60_000,
    maxTranscriptLength: 2_000,
  }),
};

export const ASR_PURPOSES = Object.freeze(PURPOSE_DEFINITIONS);

export const ASR_SUPPORTED_MEDIA_TYPES = Object.freeze([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
]);

export const ASR_LIMITS = Object.freeze({
  uploadMaxBytes: 8_388_608,
  aggregateTempMaxBytes: 33_554_432,
  magicMaxBytes: 64,
  mp4FtypSearchBytes: 32,
  minDurationMs: 300,
  audioChannelsMin: 1,
  audioChannelsMax: 2,
  sampleRateMinHz: 8_000,
  sampleRateMaxHz: 96_000,
  uploadWallTimeoutMs: 60_000,
  uploadIdleTimeoutMs: 15_000,
  probeTimeoutMs: 3_000,
  probeOutputMaxBytes: 65_536,
  transcodeTimeoutMs: 15_000,
  providerTimeoutMs: 45_000,
  processingTimeoutMs: 60_000,
  childKillGraceMs: 500,
  normalizedPcmMaxBytes: 3_840_000,
  providerResponseMaxBytes: 262_144,
  idempotencyTtlMs: 300_000,
  idempotencyCompletedCapacity: 256,
  activeUploadsMax: 4,
  ownerProcessingMax: 1,
  globalProcessingMax: 2,
  accountIpRequestLimit: 12,
  accountIpWindowMs: 900_000,
  metricsRingCapacity: 512,
});

export const ASR_CONFIG_DEFAULTS = Object.freeze({
  mode: "disabled",
  provider: "openai-compatible",
  baseUrl: "",
  model: "",
  timeoutMs: ASR_LIMITS.providerTimeoutMs,
  uploadMaxBytes: ASR_LIMITS.uploadMaxBytes,
  quickMaxDurationMs: ASR_PURPOSES.quick_record.maxDurationMs,
  assistantMaxDurationMs: ASR_PURPOSES.assistant_chat.maxDurationMs,
  ffprobeCommand: "/usr/bin/ffprobe",
  ffmpegCommand: "/usr/bin/ffmpeg",
  tempRoot: "/run/sentelligent-asr",
  reuseModelCredential: false,
  language: "zh-CN",
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;
const DISALLOWED_TRANSCRIPT_CONTROLS = /[\u0000-\u0008\u000b-\u001f]/u;

/**
 * A bounded, sanitized validation result for error codes explicitly frozen by
 * the v0.10.4 HTTP contract. Parser failures without a published HTTP code use
 * TypeError instead, leaving their HTTP mapping to the route layer.
 */
export class AsrContractError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "AsrContractError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function contractError(code, status, message) {
  throw new AsrContractError(code, status, message);
}

function requestTypeError(field) {
  throw new TypeError(`${field} does not satisfy the ASR request contract`);
}

function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    requestTypeError("headers");
  }
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

export function parseAsrPurpose(value) {
  if (typeof value !== "string" || !Object.hasOwn(ASR_PURPOSES, value)) {
    requestTypeError("purpose");
  }
  return value;
}

export function parseAsrQuery(searchParams) {
  if (!searchParams || typeof searchParams.getAll !== "function") {
    requestTypeError("query");
  }
  const purposes = searchParams.getAll("purpose");
  if (purposes.length !== 1) requestTypeError("query");
  return { purpose: parseAsrPurpose(purposes[0]) };
}

export function canonicalizeAsrMediaType(value) {
  if (typeof value !== "string") {
    contractError(
      "AUDIO_MEDIA_TYPE_UNSUPPORTED",
      415,
      "Audio media type is unsupported",
    );
  }
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  if (!ASR_SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    contractError(
      "AUDIO_MEDIA_TYPE_UNSUPPORTED",
      415,
      "Audio media type is unsupported",
    );
  }
  return mediaType;
}

export function parseAsrContentEncoding(value) {
  if (value === undefined || value === null) return "identity";
  if (value !== "identity") {
    requestTypeError("Content-Encoding");
  }
  return "identity";
}

function parsePositiveDecimal(value, field) {
  if (typeof value !== "string") requestTypeError(field);
  const normalized = value.trim();
  if (!POSITIVE_DECIMAL_PATTERN.test(normalized)) requestTypeError(field);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) requestTypeError(field);
  return parsed;
}

export function parseAsrContentLength(value, maxBytes = ASR_LIMITS.uploadMaxBytes) {
  if (value === undefined || value === null) return null;
  const parsed = parsePositiveDecimal(value, "Content-Length");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (parsed > maxBytes) {
    contractError("AUDIO_TOO_LARGE", 413, "Audio exceeds the upload limit");
  }
  return parsed;
}

export function parseAsrIdempotencyKey(value) {
  if (typeof value !== "string") {
    contractError("INVALID_IDEMPOTENCY_KEY", 400, "Idempotency key is invalid");
  }
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    contractError("INVALID_IDEMPOTENCY_KEY", 400, "Idempotency key is invalid");
  }
  return normalized;
}

export function parseAsrDurationHeader(value) {
  if (value === undefined || value === null) return null;
  return parsePositiveDecimal(value, "X-Audio-Duration-Ms");
}

export function parseAsrLanguage(value) {
  if (value === undefined || value === null) {
    return ASR_CONFIG_DEFAULTS.language;
  }
  if (value !== ASR_CONFIG_DEFAULTS.language) {
    requestTypeError("X-ASR-Language");
  }
  return ASR_CONFIG_DEFAULTS.language;
}

export function parseAsrRequestHeaders(headers) {
  return {
    mediaType: canonicalizeAsrMediaType(headerValue(headers, "content-type")),
    contentEncoding: parseAsrContentEncoding(headerValue(headers, "content-encoding")),
    contentLength: parseAsrContentLength(headerValue(headers, "content-length")),
    idempotencyKey: parseAsrIdempotencyKey(headerValue(headers, "idempotency-key")),
    clientDurationMs: parseAsrDurationHeader(headerValue(headers, "x-audio-duration-ms")),
    language: parseAsrLanguage(headerValue(headers, "x-asr-language")),
  };
}

export function transcriptLimitForPurpose(purpose) {
  return ASR_PURPOSES[parseAsrPurpose(purpose)].maxTranscriptLength;
}

export function durationLimitForPurpose(purpose) {
  return ASR_PURPOSES[parseAsrPurpose(purpose)].maxDurationMs;
}

export function normalizeAsrTranscript(value, purpose) {
  if (typeof value !== "string") {
    contractError(
      "ASR_PROVIDER_BAD_RESPONSE",
      502,
      "ASR provider returned an invalid transcript",
    );
  }
  const canonical = value.replaceAll("\r\n", "\n").normalize("NFC");
  if (DISALLOWED_TRANSCRIPT_CONTROLS.test(canonical)) {
    contractError(
      "ASR_PROVIDER_BAD_RESPONSE",
      502,
      "ASR provider returned an invalid transcript",
    );
  }
  const normalized = canonical.trim();
  if (!normalized) {
    contractError("ASR_TRANSCRIPT_EMPTY", 422, "ASR transcript is empty");
  }
  if (normalized.length > transcriptLimitForPurpose(purpose)) {
    contractError("ASR_TRANSCRIPT_TOO_LONG", 422, "ASR transcript is too long");
  }
  return normalized;
}
