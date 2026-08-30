import { useEffect, useMemo, useRef, useState } from "react";

import {
  MAX_AUDIO_BYTES,
  MIN_RECORDING_DURATION_MS,
  getRecordingCapability,
  getTranscriptionPurposeLimits,
  normalizeRecorderMimeType,
} from "./recordingCapabilities.js";
import {
  TRANSCRIPTION_COPY,
  adaptTranscriptionError,
  createTranscriptionIdempotencyKey,
  transcribeAudio,
} from "./serverTranscription.js";

export const BLOB_TTL_MS = 300_000;
export const RATE_LIMIT_FALLBACK_SECONDS = 300;
export const FINALIZATION_FALLBACK_MS = 1_000;

const STATUS_COPY = Object.freeze({
  idle: Object.freeze({
    statusText: "可以开始录音",
    secondaryText: "录音完成后先回填文字草稿",
  }),
  requesting_permission: Object.freeze({
    statusText: "正在请求麦克风",
    secondaryText: "请在浏览器中允许访问",
  }),
  recording: Object.freeze({
    statusText: "正在录音",
    secondaryText: "松开结束",
  }),
  preparing: Object.freeze({
    statusText: "正在准备录音",
    secondaryText: "即将上传并转成文字",
  }),
  processing: Object.freeze({
    statusText: "正在上传并转成文字",
    secondaryText: "音频只用于本次转写；完成后先回填草稿",
  }),
  succeeded: Object.freeze({
    statusText: "已转成文字",
    secondaryText: "请确认或修改后继续",
  }),
  retryable_error: Object.freeze({
    statusText: "转写未完成",
    secondaryText: "可人工重试一次或改用文本",
  }),
  rate_limited: Object.freeze({
    statusText: "请求过于频繁",
    secondaryText: "等待倒计时结束后重新录音",
  }),
  error: Object.freeze({
    statusText: "转写未完成",
    secondaryText: "请重新录音或改用文本",
  }),
  cancelled: Object.freeze({
    statusText: "已取消录音",
    secondaryText: "可以重新录音或改用文本",
  }),
});

function recordingSecondaryText(purpose) {
  return purpose === "assistant_chat" ? "松开结束；最长 1 分钟" : "松开结束；最长 2 分钟";
}

function initialSnapshot(capability, purpose, browserInterimAvailable) {
  return Object.freeze({
    status: "idle",
    ...STATUS_COPY.idle,
    supported: capability.supported,
    capabilityReason: capability.reason ?? null,
    browserInterimAvailable,
    browserInterimActive: false,
    purpose,
    recordingGeneration: 0,
    sameBlobRetryCount: 0,
    retryCountdownSeconds: 0,
    rateLimitCountdownSeconds: 0,
    expiresAt: null,
    hasRetainedBlob: false,
    errorCode: null,
    errorMessage: null,
    interimText: "",
  });
}

function microphoneErrorCode(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "MICROPHONE_PERMISSION_DENIED";
  }
  if (error?.name === "NotFoundError") return "MICROPHONE_UNAVAILABLE";
  return "MICROPHONE_CAPTURE_FAILED";
}

function microphoneErrorMessage(code) {
  if (code === "MICROPHONE_PERMISSION_DENIED") return TRANSCRIPTION_COPY.PERMISSION;
  if (code === "MICROPHONE_UNAVAILABLE") return "未找到可用麦克风，请改用文本。";
  return "麦克风启动失败，请重新录音或改用文本。";
}

function stopDetachedStream(stream) {
  try {
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* best-effort cleanup of a stale permission result */ }
    }
  } catch {
    // A stale stream is never attached to state; cleanup failure must not revive it.
  }
}

export function createServerTranscriptionController(configuration = {}) {
  let options = {
    purpose: "quick_record",
    mediaDevices: globalThis.navigator?.mediaDevices,
    MediaRecorderImpl: globalThis.MediaRecorder,
    SpeechRecognitionImpl: globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
    cryptoImpl: globalThis.crypto,
    BlobImpl: globalThis.Blob,
    AbortControllerImpl: globalThis.AbortController,
    now: () => Date.now(),
    setTimeoutImpl: globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl: globalThis.clearTimeout?.bind(globalThis),
    onTranscript: undefined,
    onInterimText: undefined,
    ...configuration,
    purpose: configuration.purpose ?? "quick_record",
  };
  // A controller owns exactly one purpose. Callers that change purpose must
  // replace the controller so an in-flight quick-record request can never be
  // delivered into an assistant-chat context (or vice versa).
  const controllerPurpose = options.purpose;
  const limits = getTranscriptionPurposeLimits(controllerPurpose);
  options.purpose = controllerPurpose;
  let capability = getRecordingCapability(options.mediaDevices, options.MediaRecorderImpl);
  let snapshot = initialSnapshot(
    capability,
    controllerPurpose,
    typeof options.SpeechRecognitionImpl === "function",
  );
  let generationCounter = 0;
  let logoutEpoch = 0;
  let currentGeneration = null;
  let rateLimitTimer = null;
  let rateLimitDeadline = 0;
  let standaloneRecognition = null;
  let standaloneRecognitionEpoch = 0;
  let destroyed = false;
  let lastReleasedResourceDiagnostics = null;
  const listeners = new Set();

  function publish(status, patch = {}) {
    const copy = STATUS_COPY[status] ?? STATUS_COPY.error;
    snapshot = Object.freeze({
      ...snapshot,
      ...copy,
      ...(status === "recording" ? { secondaryText: recordingSecondaryText(controllerPurpose) } : {}),
      ...patch,
      status,
    });
    for (const listener of listeners) listener(snapshot);
  }

  function isCurrent(generation) {
    return Boolean(
      generation
      && currentGeneration === generation
      && !generation.invalidated
      && !generation.expired,
    );
  }

  function inactiveReason(generation) {
    if (options.disabled === true) return "disabled";
    if (options.active === false) return "panel_closed";
    if (generation && generation.logoutEpoch !== logoutEpoch) return "logout";
    return null;
  }

  function cancelIfInactive(generation) {
    const reason = inactiveReason(generation);
    if (!reason) return false;
    if (isCurrent(generation)) cancelCapture(reason);
    return true;
  }

  function clearGenerationTimer(generation, name) {
    const timer = generation?.[name];
    if (timer !== null && timer !== undefined) {
      options.clearTimeoutImpl?.(timer);
      generation[name] = null;
    }
  }

  function stopSpeech(generation) {
    if (!generation?.speechRecognition || generation.speechStopped) return;
    generation.speechStopped = true;
    generation.speechRecognition.onresult = null;
    generation.speechRecognition.onerror = null;
    try { generation.speechRecognition.abort?.(); } catch { /* idempotent release */ }
  }

  function stopTracks(generation) {
    if (!generation?.stream || generation.tracksStopped) return;
    generation.tracksStopped = true;
    try {
      for (const track of generation.stream.getTracks?.() ?? []) {
        try { track.stop(); } catch { /* continue stopping all remaining tracks */ }
      }
    } catch {
      // Stream cleanup is bounded and must not overwrite the state transition.
    }
  }

  function abortRequest(generation, reason) {
    const controller = generation?.requestController;
    if (!controller || controller.signal.aborted) return;
    try { controller.abort(reason); } catch { controller.abort(); }
  }

  function detachAndStopRecorder(generation) {
    const recorder = generation?.recorder;
    if (!recorder || generation.recorderDisposed) return;
    generation.recorderDisposed = true;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* recorder already stopped */ }
    }
  }

  function clearGenerationTimers(generation) {
    clearGenerationTimer(generation, "maxDurationTimer");
    clearGenerationTimer(generation, "finalizationFallbackTimer");
    clearGenerationTimer(generation, "blobTtlTimer");
    clearGenerationTimer(generation, "retryCountdownTimer");
  }

  function releaseBlobAndKey(generation) {
    clearGenerationTimer(generation, "blobTtlTimer");
    clearGenerationTimer(generation, "retryCountdownTimer");
    generation.blob = null;
    generation.idempotencyKey = null;
    if (Array.isArray(generation.chunks)) generation.chunks.length = 0;
  }

  function resourceDiagnostics(generation) {
    if (!generation) return null;
    return Object.freeze({
      chunkCount: Array.isArray(generation.chunks) ? generation.chunks.length : 0,
      hasBlob: Boolean(generation.blob),
      hasKey: Boolean(generation.idempotencyKey),
      hasRecorder: Boolean(generation.recorder),
      hasStream: Boolean(generation.stream),
      hasSpeechRecognition: Boolean(generation.speechRecognition),
      hasRequestController: Boolean(generation.requestController),
    });
  }

  function releaseOwnedResourceReferences(generation) {
    generation.recorder = null;
    generation.stream = null;
    generation.speechRecognition = null;
    generation.requestController = null;
    generation.blobCreatedAt = null;
    generation.expiresAt = null;
    lastReleasedResourceDiagnostics = resourceDiagnostics(generation);
  }

  function releaseCaptureResourceReferences(generation) {
    generation.recorder = null;
    generation.stream = null;
    generation.speechRecognition = null;
  }

  function invalidateGeneration(generation, reason) {
    if (!generation || generation.invalidated) return false;
    generation.invalidated = true;
    clearGenerationTimers(generation);
    stopSpeech(generation);
    detachAndStopRecorder(generation);
    stopTracks(generation);
    abortRequest(generation, reason);
    releaseBlobAndKey(generation);
    releaseOwnedResourceReferences(generation);
    if (currentGeneration === generation) currentGeneration = null;
    return true;
  }

  function finishAndRelease(generation) {
    clearGenerationTimers(generation);
    stopSpeech(generation);
    detachAndStopRecorder(generation);
    stopTracks(generation);
    releaseBlobAndKey(generation);
    releaseOwnedResourceReferences(generation);
    generation.completed = true;
    if (currentGeneration === generation) currentGeneration = null;
  }

  function publishErrorAndRelease(generation, code, message) {
    finishAndRelease(generation);
    publish("error", {
      recordingGeneration: generation?.id ?? snapshot.recordingGeneration,
      sameBlobRetryCount: generation?.sameBlobRetryCount ?? 0,
      retryCountdownSeconds: 0,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: code,
      errorMessage: message,
      secondaryText: message || STATUS_COPY.error.secondaryText,
      interimText: "",
    });
  }

  function clearRateLimitTimer() {
    if (rateLimitTimer !== null) {
      options.clearTimeoutImpl?.(rateLimitTimer);
      rateLimitTimer = null;
    }
    rateLimitDeadline = 0;
  }

  function stopBrowserInterim({ publishState = true } = {}) {
    const active = standaloneRecognition;
    if (!active) return false;
    standaloneRecognition = null;
    standaloneRecognitionEpoch += 1;
    active.onresult = null;
    active.onerror = null;
    active.onend = null;
    try { active.abort?.(); } catch { /* idempotent optional enhancement cleanup */ }
    if (publishState && !destroyed) {
      publish(snapshot.status, {
        browserInterimActive: false,
        interimText: "",
      });
    }
    return true;
  }

  function startBrowserInterim() {
    if (destroyed || typeof options.SpeechRecognitionImpl !== "function") return false;
    if (options.active === false || options.disabled === true) return false;
    if (currentGeneration || capability.supported) return false;
    stopBrowserInterim({ publishState: false });
    let recognition;
    try {
      recognition = new options.SpeechRecognitionImpl();
    } catch {
      return false;
    }
    const epoch = ++standaloneRecognitionEpoch;
    const recognitionLogoutEpoch = logoutEpoch;
    standaloneRecognition = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (standaloneRecognition !== recognition || epoch !== standaloneRecognitionEpoch) return;
      const reason = options.disabled === true
        ? "disabled"
        : options.active === false
          ? "panel_closed"
          : recognitionLogoutEpoch !== logoutEpoch
            ? "logout"
            : null;
      if (reason) {
        cancelCapture(reason);
        return;
      }
      let text = "";
      const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
      for (let index = startIndex; index < (event?.results?.length ?? 0); index += 1) {
        text += String(event.results[index]?.[0]?.transcript ?? "");
      }
      const normalized = text.trim();
      if (!normalized) return;
      options.onInterimText?.(normalized);
      publish(snapshot.status, {
        statusText: "浏览器临时识别",
        secondaryText: "仅供临时参考；服务端最终转写当前不可用",
        browserInterimActive: true,
        interimText: normalized,
      });
    };
    const finish = () => {
      if (standaloneRecognition !== recognition || epoch !== standaloneRecognitionEpoch) return;
      standaloneRecognition = null;
      publish(snapshot.status, { browserInterimActive: false });
    };
    recognition.onerror = finish;
    recognition.onend = finish;
    try {
      recognition.start();
    } catch {
      standaloneRecognition = null;
      return false;
    }
    publish(snapshot.status, {
      statusText: "浏览器临时识别",
      secondaryText: "仅供临时参考；服务端最终转写当前不可用",
      browserInterimActive: true,
      interimText: "",
    });
    return true;
  }

  function updateRateLimitCountdown() {
    rateLimitTimer = null;
    if (destroyed || snapshot.status !== "rate_limited") return;
    const remaining = Math.max(0, Math.ceil((rateLimitDeadline - options.now()) / 1_000));
    if (remaining === 0) {
      rateLimitDeadline = 0;
      publish("idle", {
        sameBlobRetryCount: 0,
        retryCountdownSeconds: 0,
        rateLimitCountdownSeconds: 0,
        expiresAt: null,
        hasRetainedBlob: false,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }
    publish("rate_limited", { rateLimitCountdownSeconds: remaining });
    rateLimitTimer = options.setTimeoutImpl?.(updateRateLimitCountdown, Math.min(1_000, remaining * 1_000));
  }

  function enterRateLimit(generation, error) {
    const seconds = Number.isInteger(error.retryAfterSeconds)
      ? error.retryAfterSeconds
      : RATE_LIMIT_FALLBACK_SECONDS;
    finishAndRelease(generation);
    clearRateLimitTimer();
    rateLimitDeadline = options.now() + seconds * 1_000;
    publish("rate_limited", {
      recordingGeneration: generation.id,
      sameBlobRetryCount: generation.sameBlobRetryCount,
      retryCountdownSeconds: 0,
      rateLimitCountdownSeconds: seconds,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: error.code,
      errorMessage: error.userMessage,
      secondaryText: `${error.userMessage} ${seconds} 秒后可重新录音。`,
      interimText: "",
    });
    rateLimitTimer = options.setTimeoutImpl?.(updateRateLimitCountdown, 1_000);
  }

  function updateRetryCountdown(generation) {
    generation.retryCountdownTimer = null;
    if (!isCurrent(generation) || snapshot.status !== "retryable_error") return;
    const remaining = Math.max(0, Math.ceil((generation.retryAvailableAt - options.now()) / 1_000));
    publish("retryable_error", { retryCountdownSeconds: remaining });
    if (remaining > 0) {
      generation.retryCountdownTimer = options.setTimeoutImpl?.(
        () => updateRetryCountdown(generation),
        Math.min(1_000, remaining * 1_000),
      );
    }
  }

  function enterRetryableError(generation, error) {
    generation.retryAvailableAt = options.now() + (error.retryAfterSeconds ?? 0) * 1_000;
    const remaining = Math.max(0, Math.ceil((generation.retryAvailableAt - options.now()) / 1_000));
    publish("retryable_error", {
      recordingGeneration: generation.id,
      sameBlobRetryCount: generation.sameBlobRetryCount,
      retryCountdownSeconds: remaining,
      rateLimitCountdownSeconds: 0,
      expiresAt: generation.expiresAt,
      hasRetainedBlob: true,
      errorCode: error.code,
      errorMessage: error.userMessage,
      interimText: "",
    });
    if (remaining > 0) {
      generation.retryCountdownTimer = options.setTimeoutImpl?.(
        () => updateRetryCountdown(generation),
        1_000,
      );
    }
  }

  function expireGeneration(generation) {
    if (!isCurrent(generation)) return;
    generation.expired = true;
    abortRequest(generation, "blob_ttl_expired");
    finishAndRelease(generation);
    publish("error", {
      recordingGeneration: generation.id,
      sameBlobRetryCount: generation.sameBlobRetryCount,
      retryCountdownSeconds: 0,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: "BLOB_TTL_EXPIRED",
      errorMessage: TRANSCRIPTION_COPY.EXPIRED,
      secondaryText: TRANSCRIPTION_COPY.EXPIRED,
      interimText: "",
    });
  }

  async function processGeneration(generation) {
    if (!isCurrent(generation) || !generation.blob || !generation.idempotencyKey) return;
    if (cancelIfInactive(generation)) return;
    if (options.now() >= generation.expiresAt) {
      expireGeneration(generation);
      return;
    }
    const RequestAbortController = options.AbortControllerImpl;
    const requestController = new RequestAbortController();
    generation.requestController = requestController;
    publish("processing", {
      recordingGeneration: generation.id,
      sameBlobRetryCount: generation.sameBlobRetryCount,
      retryCountdownSeconds: 0,
      rateLimitCountdownSeconds: 0,
      expiresAt: generation.expiresAt,
      hasRetainedBlob: true,
      errorCode: null,
      errorMessage: null,
      interimText: "",
    });

    try {
      const result = await transcribeAudio(generation.apiClient, {
        blob: generation.blob,
        purpose: generation.purpose,
        durationMs: generation.durationMs,
        key: generation.idempotencyKey,
        signal: requestController.signal,
      });
      if (!isCurrent(generation) || requestController.signal.aborted) return;
      if (cancelIfInactive(generation)) return;
      if (options.now() >= generation.expiresAt) {
        expireGeneration(generation);
        return;
      }
      generation.requestController = null;
      try {
        generation.onTranscript?.(result.transcript, result);
      } catch {
        publishErrorAndRelease(
          generation,
          "TRANSCRIPT_APPLY_FAILED",
          "文字回填未完成，请保留现有内容并重新录音。",
        );
        return;
      }
      // A consumer may synchronously close/cancel the control while applying
      // the draft. Preserve that newer lifecycle instead of publishing stale
      // success for a generation the callback already invalidated.
      if (!isCurrent(generation)) return;
      finishAndRelease(generation);
      publish("succeeded", {
        recordingGeneration: generation.id,
        sameBlobRetryCount: generation.sameBlobRetryCount,
        retryCountdownSeconds: 0,
        rateLimitCountdownSeconds: 0,
        expiresAt: null,
        hasRetainedBlob: false,
        errorCode: null,
        errorMessage: null,
        interimText: "",
      });
    } catch (caught) {
      if (!isCurrent(generation) || generation.expired || requestController.signal.aborted) return;
      if (cancelIfInactive(generation)) return;
      if (options.now() >= generation.expiresAt) {
        expireGeneration(generation);
        return;
      }
      generation.requestController = null;
      const error = adaptTranscriptionError(caught);
      if (error.lifecycle === "rate_limited") {
        enterRateLimit(generation, error);
        return;
      }
      if (
        error.lifecycle === "same_blob_retryable"
        && generation.sameBlobRetryCount === 0
        && options.now() < generation.expiresAt
      ) {
        enterRetryableError(generation, error);
        return;
      }
      publishErrorAndRelease(generation, error.code, error.userMessage);
    } finally {
      if (generation.requestController === requestController) generation.requestController = null;
    }
  }

  async function finalizeRecording(generation) {
    if (!isCurrent(generation)) return;
    if (cancelIfInactive(generation)) return;
    if (generation.finalizationStarted) return;
    generation.finalizationStarted = true;
    clearGenerationTimer(generation, "maxDurationTimer");
    clearGenerationTimer(generation, "finalizationFallbackTimer");
    stopSpeech(generation);
    stopTracks(generation);
    // MediaRecorder queues final dataavailable/onstop events. Do not count
    // that event-loop delay as speech duration after the user already stopped.
    const recordingEndedAt = generation.stopRequestedAt ?? options.now();
    const measuredDurationMs = Math.max(0, Math.round(recordingEndedAt - generation.startedAt));
    generation.durationMs = measuredDurationMs;
    if (generation.durationMs < MIN_RECORDING_DURATION_MS) {
      publishErrorAndRelease(generation, "AUDIO_TOO_SHORT", TRANSCRIPTION_COPY.TOO_SHORT);
      return;
    }
    if (generation.durationMs > limits.maxDurationMs) {
      publishErrorAndRelease(generation, "AUDIO_TOO_LONG", TRANSCRIPTION_COPY.TOO_LONG);
      return;
    }
    const chunks = generation.chunks.filter((chunk) => chunk && chunk.size > 0);
    if (chunks.length === 0) {
      publishErrorAndRelease(generation, "AUDIO_BODY_REQUIRED", TRANSCRIPTION_COPY.UNKNOWN_ERROR);
      return;
    }
    const recordedBytes = chunks.reduce((total, chunk) => total + chunk.size, 0);
    if (!Number.isSafeInteger(recordedBytes) || recordedBytes > MAX_AUDIO_BYTES) {
      publishErrorAndRelease(generation, "AUDIO_TOO_LARGE", TRANSCRIPTION_COPY.TOO_LARGE);
      return;
    }
    const mediaType = normalizeRecorderMimeType(
      generation.recorder?.mimeType
      || chunks.find((chunk) => chunk.type)?.type
      || generation.selectedMimeType,
    );
    if (!mediaType) {
      publishErrorAndRelease(generation, "AUDIO_MEDIA_TYPE_UNSUPPORTED", TRANSCRIPTION_COPY.UNSUPPORTED);
      return;
    }
    let blob;
    try {
      blob = new options.BlobImpl(chunks, { type: mediaType });
    } catch {
      publishErrorAndRelease(generation, "AUDIO_INVALID", TRANSCRIPTION_COPY.UNKNOWN_ERROR);
      return;
    }
    if (blob.size <= 0) {
      publishErrorAndRelease(generation, "AUDIO_BODY_REQUIRED", TRANSCRIPTION_COPY.UNKNOWN_ERROR);
      return;
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      publishErrorAndRelease(generation, "AUDIO_TOO_LARGE", TRANSCRIPTION_COPY.TOO_LARGE);
      return;
    }
    // Blob owns the immutable upload bytes now; retaining MediaRecorder chunks
    // would keep a second set of references alive for the five-minute retry TTL.
    generation.chunks.length = 0;
    let key;
    try {
      key = createTranscriptionIdempotencyKey(options.cryptoImpl);
    } catch {
      publishErrorAndRelease(generation, "INVALID_IDEMPOTENCY_KEY", TRANSCRIPTION_COPY.UNKNOWN_ERROR);
      return;
    }
    generation.blob = blob;
    generation.idempotencyKey = key;
    generation.blobCreatedAt = options.now();
    generation.expiresAt = generation.blobCreatedAt + BLOB_TTL_MS;
    generation.sameBlobRetryCount = 0;
    // Once a Blob exists, raw capture devices and recorder callbacks are no
    // longer needed. Only the Blob/key remain for the one manual retry.
    detachAndStopRecorder(generation);
    releaseCaptureResourceReferences(generation);
    generation.blobTtlTimer = options.setTimeoutImpl?.(
      () => expireGeneration(generation),
      BLOB_TTL_MS,
    );
    await processGeneration(generation);
  }

  function startSpeechEnhancement(generation) {
    const SpeechRecognitionImpl = options.SpeechRecognitionImpl;
    if (typeof SpeechRecognitionImpl !== "function") return;
    try {
      const recognition = new SpeechRecognitionImpl();
      generation.speechRecognition = recognition;
      recognition.lang = "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        if (!isCurrent(generation)) return;
        if (cancelIfInactive(generation)) return;
        let text = "";
        const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
        for (let index = startIndex; index < (event?.results?.length ?? 0); index += 1) {
          text += String(event.results[index]?.[0]?.transcript ?? "");
        }
        const normalized = text.trim();
        if (!normalized) return;
        generation.onInterimText?.(normalized);
        publish(snapshot.status, { interimText: normalized });
      };
      recognition.onerror = () => {
        // Browser speech is explicitly an interim enhancement and never gates
        // MediaRecorder or the server result.
      };
      recognition.start();
    } catch {
      generation.speechRecognition = null;
    }
  }

  async function startCapture() {
    if (destroyed) return false;
    if (options.active === false || options.disabled === true) return false;
    if (snapshot.status === "rate_limited" && snapshot.rateLimitCountdownSeconds > 0) return false;
    stopBrowserInterim({ publishState: false });
    clearRateLimitTimer();
    if (currentGeneration) invalidateGeneration(currentGeneration, "rerecord");
    capability = getRecordingCapability(options.mediaDevices, options.MediaRecorderImpl);
    if (!capability.supported) {
      publish("error", {
        supported: false,
        capabilityReason: capability.reason,
        errorCode: "RECORDING_UNSUPPORTED",
        errorMessage: TRANSCRIPTION_COPY.UNSUPPORTED,
        secondaryText: TRANSCRIPTION_COPY.UNSUPPORTED,
      });
      return false;
    }

    const generation = {
      id: ++generationCounter,
      invalidated: false,
      expired: false,
      completed: false,
      chunks: [],
      stream: null,
      tracksStopped: false,
      recorder: null,
      recorderDisposed: false,
      selectedMimeType: capability.mimeType,
      purpose: controllerPurpose,
      logoutEpoch,
      apiClient: options.apiClient,
      onTranscript: options.onTranscript,
      onInterimText: options.onInterimText,
      startedAt: 0,
      stopRequestedAt: null,
      durationMs: 0,
      blob: null,
      idempotencyKey: null,
      blobCreatedAt: null,
      expiresAt: null,
      sameBlobRetryCount: 0,
      requestController: null,
      maxDurationTimer: null,
      finalizationFallbackTimer: null,
      blobTtlTimer: null,
      retryCountdownTimer: null,
      retryAvailableAt: 0,
      finalizationStarted: false,
      speechRecognition: null,
      speechStopped: false,
    };
    currentGeneration = generation;
    publish("requesting_permission", {
      supported: true,
      capabilityReason: null,
      recordingGeneration: generation.id,
      sameBlobRetryCount: 0,
      retryCountdownSeconds: 0,
      rateLimitCountdownSeconds: 0,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: null,
      errorMessage: null,
      interimText: "",
    });

    let stream;
    try {
      stream = await options.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!isCurrent(generation)) return false;
      if (cancelIfInactive(generation)) return false;
      const code = microphoneErrorCode(error);
      publishErrorAndRelease(generation, code, microphoneErrorMessage(code));
      return false;
    }
    if (!isCurrent(generation)) {
      stopDetachedStream(stream);
      return false;
    }
    if (cancelIfInactive(generation)) {
      stopDetachedStream(stream);
      return false;
    }
    generation.stream = stream;

    let recorder;
    try {
      recorder = generation.selectedMimeType
        ? new options.MediaRecorderImpl(stream, { mimeType: generation.selectedMimeType })
        : new options.MediaRecorderImpl(stream);
    } catch {
      publishErrorAndRelease(generation, "MEDIA_RECORDER_START_FAILED", TRANSCRIPTION_COPY.UNSUPPORTED);
      return false;
    }
    generation.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (!isCurrent(generation)) return;
      if (cancelIfInactive(generation)) return;
      if (event?.data?.size > 0) generation.chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (!isCurrent(generation)) return;
      if (cancelIfInactive(generation)) return;
      void finalizeRecording(generation);
    };
    recorder.onerror = () => {
      if (!isCurrent(generation)) return;
      if (cancelIfInactive(generation)) return;
      publishErrorAndRelease(generation, "MEDIA_RECORDER_FAILED", "录音采集失败，请重新录音或改用文本。");
    };

    try {
      generation.startedAt = options.now();
      recorder.start();
      startSpeechEnhancement(generation);
      generation.maxDurationTimer = options.setTimeoutImpl?.(
        () => {
          if (!isCurrent(generation)) return;
          if (cancelIfInactive(generation)) return;
          stopCapture("max_duration");
        },
        limits.maxDurationMs,
      );
      publish("recording", {
        recordingGeneration: generation.id,
        interimText: "",
      });
      return true;
    } catch {
      publishErrorAndRelease(generation, "MEDIA_RECORDER_START_FAILED", "录音采集失败，请重新录音或改用文本。");
      return false;
    }
  }

  function stopCapture(reason = "manual") {
    const generation = currentGeneration;
    if (!isCurrent(generation) || snapshot.status !== "recording") return false;
    // Capture this once, before any recorder side effect. A delayed onstop must
    // reuse the user's stop instant rather than the later callback time.
    if (generation.stopRequestedAt === null) generation.stopRequestedAt = options.now();
    clearGenerationTimer(generation, "maxDurationTimer");
    stopSpeech(generation);
    publish("preparing", {
      recordingGeneration: generation.id,
      interimText: "",
    });
    try {
      // If the recorder is already inactive, final dataavailable/onstop may be
      // queued but not delivered yet. Wait for authoritative onstop instead of
      // finalizing an empty chunk list. This bounded fallback handles a browser
      // that loses onstop, and the one-shot guard prevents duplicate requests.
      generation.finalizationFallbackTimer = options.setTimeoutImpl?.(
        () => void finalizeRecording(generation),
        FINALIZATION_FALLBACK_MS,
      );
      // Install the fallback before stop(): test doubles (and unusual recorder
      // implementations) may dispatch onstop synchronously, in which case
      // finalizeRecording must be able to clear the already-owned timer.
      if (generation.recorder.state !== "inactive") generation.recorder.stop();
      return true;
    } catch {
      publishErrorAndRelease(generation, "MEDIA_RECORDER_FAILED", "录音采集失败，请重新录音或改用文本。");
      return false;
    } finally {
      stopTracks(generation);
    }
  }

  function retry() {
    const generation = currentGeneration;
    if (options.active === false || options.disabled === true) return false;
    if (!isCurrent(generation) || snapshot.status !== "retryable_error") return false;
    if (options.now() >= generation.expiresAt) {
      expireGeneration(generation);
      return false;
    }
    if (
      !generation.blob
      || !generation.idempotencyKey
      || generation.sameBlobRetryCount >= 1
    ) {
      publishErrorAndRelease(generation, "SAME_BLOB_RETRY_EXHAUSTED", TRANSCRIPTION_COPY.UNKNOWN_ERROR);
      return false;
    }
    if (options.now() < generation.retryAvailableAt) {
      updateRetryCountdown(generation);
      return false;
    }
    clearGenerationTimer(generation, "retryCountdownTimer");
    generation.sameBlobRetryCount = 1;
    void processGeneration(generation);
    return true;
  }

  function cancelCapture(reason = "user_cancel") {
    const wasRateLimited = snapshot.status === "rate_limited";
    const stoppedBrowserInterim = stopBrowserInterim({ publishState: false });
    clearRateLimitTimer();
    const generation = currentGeneration;
    if (!generation) {
      if (!wasRateLimited && !stoppedBrowserInterim) return false;
      publish("cancelled", {
        sameBlobRetryCount: 0,
        retryCountdownSeconds: 0,
        rateLimitCountdownSeconds: 0,
        expiresAt: null,
        hasRetainedBlob: false,
        errorCode: null,
        errorMessage: null,
        interimText: "",
      });
      return true;
    }
    const id = generation.id;
    const changed = invalidateGeneration(generation, reason);
    if (!changed) return false;
    publish("cancelled", {
      recordingGeneration: id,
      sameBlobRetryCount: 0,
      retryCountdownSeconds: 0,
      rateLimitCountdownSeconds: 0,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: null,
      errorMessage: null,
      interimText: "",
    });
    return true;
  }

  function reset() {
    stopBrowserInterim({ publishState: false });
    clearRateLimitTimer();
    if (currentGeneration) invalidateGeneration(currentGeneration, "discard");
    publish("idle", {
      sameBlobRetryCount: 0,
      retryCountdownSeconds: 0,
      rateLimitCountdownSeconds: 0,
      expiresAt: null,
      hasRetainedBlob: false,
      errorCode: null,
      errorMessage: null,
      interimText: "",
    });
  }

  function destroy(reason = "unmount") {
    if (destroyed) return;
    const shouldPublishCancelled = Boolean(
      currentGeneration
      || standaloneRecognition
      || snapshot.status === "rate_limited"
      || ["requesting_permission", "recording", "preparing", "processing", "retryable_error"].includes(snapshot.status),
    );
    stopBrowserInterim({ publishState: false });
    clearRateLimitTimer();
    if (currentGeneration) invalidateGeneration(currentGeneration, reason);
    if (shouldPublishCancelled) {
      publish("cancelled", {
        sameBlobRetryCount: 0,
        retryCountdownSeconds: 0,
        rateLimitCountdownSeconds: 0,
        expiresAt: null,
        hasRetainedBlob: false,
        errorCode: null,
        errorMessage: null,
        interimText: "",
        browserInterimActive: false,
      });
    }
    destroyed = true;
    listeners.clear();
  }

  function activate() {
    destroyed = false;
  }

  function updateOptions(nextOptions = {}) {
    // Purpose is immutable for this controller. React creates a new controller
    // for a new purpose, while mutable dependencies may update in place.
    const { purpose: _ignoredPurpose, ...mutableOptions } = nextOptions;
    if (
      Object.hasOwn(mutableOptions, "sessionEpoch")
      && !Object.is(mutableOptions.sessionEpoch, options.sessionEpoch)
    ) {
      logoutEpoch += 1;
    }
    options = { ...options, ...mutableOptions, purpose: controllerPurpose };
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startCapture,
    stopCapture,
    retry,
    startBrowserInterim,
    stopBrowserInterim,
    cancelCapture,
    reset,
    destroy,
    activate,
    updateOptions,
    getResourceDiagnosticsForTests() {
      return Object.freeze({
        current: resourceDiagnostics(currentGeneration),
        lastReleased: lastReleasedResourceDiagnostics,
      });
    },
  });
}

export function useServerTranscription(configuration = {}) {
  const latestConfiguration = useRef(configuration);
  latestConfiguration.current = configuration;
  const purpose = configuration.purpose ?? "quick_record";
  const callbackPurpose = purpose;
  const callbackSessionEpoch = configuration.sessionEpoch;
  const purposeScopedTranscript = (...args) => {
    if ((latestConfiguration.current.purpose ?? "quick_record") !== callbackPurpose) return;
    if (latestConfiguration.current.active === false || latestConfiguration.current.disabled === true) return;
    if (!Object.is(latestConfiguration.current.sessionEpoch, callbackSessionEpoch)) return;
    latestConfiguration.current.onTranscript?.(...args);
  };
  const purposeScopedInterim = (...args) => {
    if ((latestConfiguration.current.purpose ?? "quick_record") !== callbackPurpose) return;
    if (latestConfiguration.current.active === false || latestConfiguration.current.disabled === true) return;
    if (!Object.is(latestConfiguration.current.sessionEpoch, callbackSessionEpoch)) return;
    latestConfiguration.current.onInterimText?.(...args);
  };
  const controller = useMemo(() => createServerTranscriptionController({
    ...configuration,
    purpose,
    onTranscript: purposeScopedTranscript,
    onInterimText: purposeScopedInterim,
  }), [purpose]);
  controller.updateOptions({
    apiClient: configuration.apiClient,
    active: configuration.active,
    disabled: configuration.disabled,
    sessionEpoch: configuration.sessionEpoch,
    onTranscript: purposeScopedTranscript,
    onInterimText: purposeScopedInterim,
  });
  const [snapshotState, setSnapshotState] = useState(() => ({
    controller,
    snapshot: controller.getSnapshot(),
  }));
  const snapshot = snapshotState.controller === controller
    ? snapshotState.snapshot
    : controller.getSnapshot();

  useEffect(() => {
    controller.activate();
    setSnapshotState({ controller, snapshot: controller.getSnapshot() });
    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshotState({ controller, snapshot: nextSnapshot });
    });
    const onPageHide = () => controller.cancelCapture("pagehide");
    const onVisibilityChange = () => {
      if (globalThis.document?.visibilityState === "hidden") {
        controller.cancelCapture("visibility_hidden");
      }
    };
    globalThis.addEventListener?.("pagehide", onPageHide);
    globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);
    return () => {
      globalThis.removeEventListener?.("pagehide", onPageHide);
      globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
      unsubscribe();
      controller.destroy("unmount");
    };
  }, [controller]);

  const previousSessionEpoch = useRef(configuration.sessionEpoch);
  useEffect(() => {
    if (previousSessionEpoch.current !== configuration.sessionEpoch) {
      previousSessionEpoch.current = configuration.sessionEpoch;
      controller.cancelCapture("logout");
    }
  }, [configuration.sessionEpoch, controller]);

  useEffect(() => {
    if (configuration.disabled === true) {
      controller.cancelCapture("disabled");
    } else if (configuration.active === false) {
      controller.cancelCapture("panel_closed");
    }
  }, [configuration.active, configuration.disabled, controller]);

  const actions = useMemo(() => ({
    startCapture: () => controller.startCapture(),
    stopCapture: () => controller.stopCapture(),
    cancelCapture: (reason) => controller.cancelCapture(reason),
    retry: () => controller.retry(),
    startBrowserInterim: () => controller.startBrowserInterim(),
    stopBrowserInterim: () => controller.stopBrowserInterim(),
    reset: () => controller.reset(),
  }), [controller]);

  return { ...snapshot, ...actions };
}
