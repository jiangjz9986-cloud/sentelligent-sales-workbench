import {
  ASR_LIMITS,
  AsrContractError,
  canonicalizeAsrMediaType,
  durationLimitForPurpose,
  parseAsrPurpose,
} from "./contracts.js";

const FORMAT_NAMES_BY_MEDIA_TYPE = Object.freeze({
  "audio/webm": Object.freeze(["webm", "matroska"]),
  "audio/ogg": Object.freeze(["ogg"]),
  "audio/mp4": Object.freeze(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]),
  "audio/wav": Object.freeze(["wav"]),
});

function contractError(code, status, message) {
  throw new AsrContractError(code, status, message);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("magicBytes must be an ArrayBuffer or byte view");
}

function matches(bytes, offset, expected) {
  if (bytes.length < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function asciiBytes(value) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

const EBML = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
const OGG = asciiBytes("OggS");
const RIFF = asciiBytes("RIFF");
const WAVE = asciiBytes("WAVE");
const FTYP = asciiBytes("ftyp");

function readUint32(bytes, offset) {
  if (offset < 0 || bytes.length < offset + 4) return null;
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

function hasValidFtypBox(bytes) {
  let offset = 0;
  while (offset + 8 <= bytes.length && offset + 4 < ASR_LIMITS.mp4FtypSearchBytes) {
    const size32 = readUint32(bytes, offset);
    if (size32 === null) return false;
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (bytes.length < offset + 16) return false;
      const high = readUint32(bytes, offset + 8);
      const low = readUint32(bytes, offset + 12);
      if (high === null || low === null || high > 0x1fffff) return false;
      boxSize = high * 0x100000000 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = bytes.length - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) return false;
    if (matches(bytes, offset + 4, FTYP)) {
      return boxSize >= headerSize + 8 && bytes.length >= offset + headerSize + 8;
    }
    if (boxSize === 0 || offset + boxSize <= offset) return false;
    offset += boxSize;
  }
  return false;
}

export function detectAudioMediaType(magicBytes) {
  const bytes = asBytes(magicBytes);
  if (matches(bytes, 0, EBML)) return "audio/webm";
  if (matches(bytes, 0, OGG)) return "audio/ogg";
  if (matches(bytes, 0, RIFF) && matches(bytes, 8, WAVE)) return "audio/wav";
  if (hasValidFtypBox(bytes)) return "audio/mp4";
  return null;
}

export function assertAudioMagic(mediaType, magicBytes) {
  const canonicalMediaType = canonicalizeAsrMediaType(mediaType);
  if (detectAudioMediaType(magicBytes) !== canonicalMediaType) {
    contractError(
      "AUDIO_SIGNATURE_MISMATCH",
      415,
      "Audio signature does not match its media type",
    );
  }
  return canonicalMediaType;
}

export function assertAudioByteLength(byteLength, maxBytes = ASR_LIMITS.uploadMaxBytes) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    contractError("AUDIO_INVALID", 422, "Audio byte length is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (byteLength === 0) {
    contractError("AUDIO_BODY_REQUIRED", 400, "Audio body is required");
  }
  if (byteLength > maxBytes) {
    contractError("AUDIO_TOO_LARGE", 413, "Audio exceeds the upload limit");
  }
  return byteLength;
}

export function assertAudioDuration(
  durationMs,
  purpose,
  effectiveMaxDurationMs = durationLimitForPurpose(purpose),
) {
  const normalizedPurpose = parseAsrPurpose(purpose);
  const hardPurposeMax = durationLimitForPurpose(normalizedPurpose);
  if (
    !Number.isSafeInteger(effectiveMaxDurationMs)
    || effectiveMaxDurationMs < ASR_LIMITS.minDurationMs
    || effectiveMaxDurationMs > hardPurposeMax
  ) {
    throw new TypeError("effectiveMaxDurationMs must be a safe integer within the purpose limits");
  }
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    contractError("AUDIO_INVALID", 422, "Audio duration is invalid");
  }
  if (durationMs < ASR_LIMITS.minDurationMs) {
    contractError("AUDIO_TOO_SHORT", 422, "Audio is too short");
  }
  if (durationMs > effectiveMaxDurationMs) {
    contractError("AUDIO_TOO_LONG", 422, "Audio is too long");
  }
  return durationMs;
}

function invalidProbe() {
  contractError("AUDIO_INVALID", 422, "Audio metadata is invalid");
}

function formatNames(value) {
  if (typeof value !== "string") invalidProbe();
  const result = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (result.length === 0) invalidProbe();
  return [...new Set(result)];
}

function positiveIntegerMetadata(value) {
  const normalized = typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) invalidProbe();
  return normalized;
}

export function validateAudioProbe(probe, { mediaType, purpose, effectiveMaxDurationMs } = {}) {
  const canonicalMediaType = canonicalizeAsrMediaType(mediaType);
  const normalizedPurpose = parseAsrPurpose(purpose);
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) invalidProbe();
  if (!probe.format || typeof probe.format !== "object" || Array.isArray(probe.format)) invalidProbe();
  if (!Array.isArray(probe.streams)) invalidProbe();

  const names = formatNames(probe.format.format_name);
  if (!names.some((name) => FORMAT_NAMES_BY_MEDIA_TYPE[canonicalMediaType].includes(name))) {
    invalidProbe();
  }

  const durationSeconds = typeof probe.format.duration === "number"
    ? probe.format.duration
    : Number(probe.format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) invalidProbe();
  const exactDurationMs = durationSeconds * 1_000;
  if (!Number.isFinite(exactDurationMs) || !Number.isSafeInteger(Math.ceil(exactDurationMs)) || exactDurationMs <= 0) {
    invalidProbe();
  }
  assertAudioDuration(exactDurationMs, normalizedPurpose, effectiveMaxDurationMs);
  const durationMs = Math.round(exactDurationMs);

  const audioStreams = probe.streams.filter((stream) => stream?.codec_type === "audio");
  const videoStreams = probe.streams.filter((stream) => stream?.codec_type === "video");
  if (audioStreams.length !== 1 || videoStreams.length !== 0) invalidProbe();

  const stream = audioStreams[0];
  const channels = positiveIntegerMetadata(stream.channels);
  const sampleRate = positiveIntegerMetadata(stream.sample_rate);
  if (
    channels < ASR_LIMITS.audioChannelsMin
    || channels > ASR_LIMITS.audioChannelsMax
    || sampleRate < ASR_LIMITS.sampleRateMinHz
    || sampleRate > ASR_LIMITS.sampleRateMaxHz
  ) {
    invalidProbe();
  }

  return {
    durationMs,
    formatNames: names,
    audioStream: {
      index: Number.isSafeInteger(stream.index) ? stream.index : null,
      codecName: typeof stream.codec_name === "string" ? stream.codec_name : "",
      channels,
      sampleRate,
    },
  };
}
