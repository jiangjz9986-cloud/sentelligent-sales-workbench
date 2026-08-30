import {
  MAX_AUDIO_BYTES,
  MIN_RECORDING_DURATION_MS,
  getTranscriptionPurposeLimits,
  normalizeRecorderMimeType,
} from "./recordingCapabilities.js";

const SAME_BLOB_RETRYABLE_CODES = new Set([
  "ASR_NETWORK_ERROR",
  "ASR_IN_PROGRESS",
  "ASR_CAPACITY_EXCEEDED",
  "ASR_PROVIDER_BAD_RESPONSE",
  "ASR_TIMEOUT",
]);

export const TRANSCRIPTION_COPY = Object.freeze({
  NETWORK: "网络连接中断，可人工重试一次或改用文本。",
  IN_PROGRESS: "当前录音仍在处理中，可稍后人工重试一次。",
  CAPACITY: "转写服务繁忙，可稍后人工重试一次或改用文本。",
  PROVIDER: "转写服务暂未完成，可人工重试一次或改用文本。",
  TIMEOUT: "本次转写超时，可人工重试一次或改用文本。",
  RATE_LIMITED: "请求过于频繁，请等待后重新录音。",
  EMPTY: "没有识别到有效文字，请重新录音或改用文本。",
  TOO_SHORT: "录音时间过短，请至少录制 0.3 秒。",
  TOO_LONG: "录音时间过长，请缩短后重新录音。",
  TOO_LARGE: "录音内容过大，请缩短后重新录音。",
  UNSUPPORTED: "当前录音格式不受支持，请更换浏览器或改用文本。",
  PERMISSION: "麦克风访问未获允许，请检查浏览器权限或改用文本。",
  NOT_CONFIGURED: "服务端转写尚未就绪，请改用文本。",
  EXPIRED: "录音已超过 5 分钟，请重新录音。",
  ABORTED: "本次录音已取消。",
  UNKNOWN_ERROR: "转写未完成，请重新录音或改用文本。",
});

const ERROR_COPY_BY_CODE = Object.freeze({
  ASR_NETWORK_ERROR: TRANSCRIPTION_COPY.NETWORK,
  ASR_IN_PROGRESS: TRANSCRIPTION_COPY.IN_PROGRESS,
  ASR_CAPACITY_EXCEEDED: TRANSCRIPTION_COPY.CAPACITY,
  ASR_PROVIDER_BAD_RESPONSE: TRANSCRIPTION_COPY.PROVIDER,
  ASR_TIMEOUT: TRANSCRIPTION_COPY.TIMEOUT,
  ASR_RATE_LIMITED: TRANSCRIPTION_COPY.RATE_LIMITED,
  ASR_TRANSCRIPT_EMPTY: TRANSCRIPTION_COPY.EMPTY,
  AUDIO_BODY_REQUIRED: "未生成有效录音，请重新录音或改用文本。",
  INVALID_IDEMPOTENCY_KEY: "本次录音请求无效，请重新录音。",
  UNAUTHORIZED: "登录状态已失效，请重新登录后录音。",
  CSRF_INVALID: "当前会话校验失败，请刷新后重新录音。",
  ORIGIN_NOT_ALLOWED: "当前页面不能提交录音，请改用受支持入口。",
  MACHINE_SCOPE_DENIED: "当前身份不能提交录音，请使用用户会话。",
  AUDIO_TOO_SHORT: TRANSCRIPTION_COPY.TOO_SHORT,
  AUDIO_TOO_LONG: TRANSCRIPTION_COPY.TOO_LONG,
  AUDIO_TOO_LARGE: TRANSCRIPTION_COPY.TOO_LARGE,
  AUDIO_MEDIA_TYPE_UNSUPPORTED: TRANSCRIPTION_COPY.UNSUPPORTED,
  AUDIO_SIGNATURE_MISMATCH: TRANSCRIPTION_COPY.UNSUPPORTED,
  AUDIO_INVALID: "录音内容无效，请重新录音或改用文本。",
  ASR_TRANSCRIPT_TOO_LONG: "录音内容过长，请缩短后重新录音。",
  IDEMPOTENCY_CONFLICT: "录音请求已失效，请重新录音。",
  ASR_TRANSCODE_FAILED: "录音处理未完成，请重新录音或改用文本。",
  ASR_NOT_CONFIGURED: TRANSCRIPTION_COPY.NOT_CONFIGURED,
  ASR_CLEANUP_FAILED: "录音临时数据清理未确认，请重新录音或改用文本。",
  ASR_ABORTED: TRANSCRIPTION_COPY.ABORTED,
  BLOB_TTL_EXPIRED: TRANSCRIPTION_COPY.EXPIRED,
});

function boundedRetryAfter(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300 ? value : null;
}

function safeErrorCode(error) {
  if (error?.name === "AbortError") return "ASR_ABORTED";
  if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)) {
    return error.code;
  }
  if (error instanceof TypeError || error?.name === "TypeError") return "ASR_NETWORK_ERROR";
  return "ASR_UNKNOWN_ERROR";
}

export class TranscriptionCapabilityError extends Error {
  constructor({ code, status, lifecycle, retryAfterSeconds, requestId, userMessage }) {
    super(userMessage);
    this.name = code === "ASR_ABORTED" ? "AbortError" : "TranscriptionCapabilityError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : undefined;
    this.lifecycle = lifecycle;
    this.retryAfterSeconds = retryAfterSeconds;
    this.requestId = typeof requestId === "string" ? requestId : undefined;
    this.userMessage = userMessage;
  }
}

export function adaptTranscriptionError(error) {
  const code = safeErrorCode(error);
  const lifecycle = code === "ASR_RATE_LIMITED"
    ? "rate_limited"
    : SAME_BLOB_RETRYABLE_CODES.has(code)
      ? "same_blob_retryable"
      : "release_and_rerecord";
  return new TranscriptionCapabilityError({
    code,
    status: error?.status,
    lifecycle,
    retryAfterSeconds: boundedRetryAfter(error?.retryAfterSeconds),
    requestId: error?.requestId,
    userMessage: ERROR_COPY_BY_CODE[code] ?? TRANSCRIPTION_COPY.UNKNOWN_ERROR,
  });
}

export function createTranscriptionIdempotencyKey(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID() is required for ASR idempotency keys");
  }
  return `asr:${cryptoImpl.randomUUID()}`;
}

function assertTranscriptionInput({ blob, purpose, durationMs, key }) {
  const limits = getTranscriptionPurposeLimits(purpose);
  if (!blob || typeof blob.size !== "number" || typeof blob.slice !== "function") {
    throw new TypeError("A raw audio Blob is required");
  }
  if (blob.size <= 0 || blob.size > MAX_AUDIO_BYTES) throw new TypeError("Audio Blob size is invalid");
  if (!normalizeRecorderMimeType(blob.type)) throw new TypeError("Audio Blob media type is invalid");
  if (!Number.isInteger(durationMs) || durationMs < MIN_RECORDING_DURATION_MS || durationMs > limits.maxDurationMs) {
    throw new TypeError("durationMs is outside the transcription purpose limit");
  }
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(key)) {
    throw new TypeError("A valid transcription idempotency key is required");
  }
}

export async function transcribeAudio(apiClient, input) {
  if (typeof apiClient?.transcribeAudio !== "function") {
    throw adaptTranscriptionError({ code: "ASR_NOT_CONFIGURED" });
  }
  assertTranscriptionInput(input);
  let response;
  try {
    response = await apiClient.transcribeAudio({
      blob: input.blob,
      purpose: input.purpose,
      durationMs: input.durationMs,
      idempotencyKey: input.key,
      language: "zh-CN",
      signal: input.signal,
    });
  } catch (error) {
    throw adaptTranscriptionError(error);
  }
  const item = response?.item;
  const limits = getTranscriptionPurposeLimits(input.purpose);
  if (
    !item
    || typeof item.transcript !== "string"
    || !item.transcript
    || item.transcript.length > limits.maxTranscriptCharacters
    || item.transcript !== item.transcript.normalize("NFC")
    || item.transcript.trim() !== item.transcript
    || /[\u0000-\u0008\u000B-\u001F]/u.test(item.transcript)
    || item.language !== "zh-CN"
    || !Number.isInteger(item.durationMs)
    || item.durationMs < MIN_RECORDING_DURATION_MS
    || item.durationMs > limits.maxDurationMs
    || item.source !== "server_asr"
    || typeof item.replayed !== "boolean"
  ) {
    throw adaptTranscriptionError({ code: "ASR_PROVIDER_BAD_RESPONSE" });
  }
  return {
    transcript: item.transcript,
    language: item.language,
    durationMs: item.durationMs,
    source: item.source,
    replayed: item.replayed,
  };
}
