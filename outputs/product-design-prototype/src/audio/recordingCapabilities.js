export const RECORDING_MIME_CANDIDATES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
]);

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MIN_RECORDING_DURATION_MS = 300;

export const PURPOSE_LIMITS = Object.freeze({
  quick_record: Object.freeze({
    maxDurationMs: 120_000,
    maxTranscriptCharacters: 10_000,
  }),
  assistant_chat: Object.freeze({
    maxDurationMs: 60_000,
    maxTranscriptCharacters: 2_000,
  }),
});

const ALLOWED_MEDIA_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]);

export function normalizeRecorderMimeType(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s*;\s*/gu, ";")
    .replace(/\s*=\s*/gu, "=");
  const [baseType, ...parameters] = normalized.split(";");
  if (!ALLOWED_MEDIA_TYPES.has(baseType)) return null;
  if (parameters.some((parameter) => !/^[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+$/u.test(parameter))) {
    return null;
  }
  return normalized;
}

export function selectRecordingMimeType(MediaRecorderImpl = globalThis.MediaRecorder) {
  if (typeof MediaRecorderImpl !== "function") return null;
  if (typeof MediaRecorderImpl.isTypeSupported !== "function") return "";
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (MediaRecorderImpl.isTypeSupported(candidate)) return candidate;
    } catch {
      // A capability probe is advisory. A throwing probe falls through to the
      // browser default rather than inventing support for a candidate.
      return "";
    }
  }
  return "";
}

export function getRecordingCapability(
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
) {
  if (typeof mediaDevices?.getUserMedia !== "function") {
    return {
      supported: false,
      mimeType: null,
      usesBrowserDefault: false,
      reason: "get_user_media_unavailable",
    };
  }
  const mimeType = selectRecordingMimeType(MediaRecorderImpl);
  if (mimeType === null) {
    return {
      supported: false,
      mimeType: null,
      usesBrowserDefault: false,
      reason: "media_recorder_unavailable",
    };
  }
  return {
    supported: true,
    mimeType,
    usesBrowserDefault: mimeType === "",
  };
}

export function getTranscriptionPurposeLimits(purpose) {
  const limits = PURPOSE_LIMITS[purpose];
  if (!limits) throw new TypeError("Transcription purpose must be quick_record or assistant_chat");
  return limits;
}
