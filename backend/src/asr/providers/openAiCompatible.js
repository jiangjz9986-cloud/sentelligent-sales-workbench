import { openAsBlob } from "node:fs";

import {
  ASR_LIMITS,
  AsrContractError,
  canonicalizeAsrMediaType,
  normalizeAsrTranscript,
  parseAsrPurpose,
} from "../contracts.js";

const PROVIDER_ID = "openai-compatible";
export const ASR_PROVIDER_RESOURCE_LIFECYCLE = Symbol("asr.providerResourceLifecycle");
const ASYNC_BODY_READ_CANCELLED = Symbol("asr.asyncBodyReadCancelled");
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function contractError(code, status, message) {
  return new AsrContractError(code, status, message);
}

function validateModel(model) {
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    throw new TypeError("ASR provider model must be a bounded identifier");
  }
  return model;
}

function validateTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > ASR_LIMITS.providerTimeoutMs
  ) {
    throw new TypeError("ASR provider timeout must be a bounded positive integer");
  }
  return timeoutMs;
}

export function normalizeOpenAiCompatibleBaseUrl(
  baseUrl,
  { allowLoopbackHttpForTests = false } = {},
) {
  if (
    typeof baseUrl !== "string"
    || baseUrl.length === 0
    || baseUrl.length > 2_048
    || baseUrl.isWellFormed() !== true
    || baseUrl !== baseUrl.trim()
    || /[\p{Cc}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(baseUrl)
    || baseUrl.includes("?")
    || baseUrl.includes("#")
    || baseUrl.includes("\\")
  ) {
    throw new TypeError("ASR provider base URL is invalid");
  }
  const rawScheme = /^(?:https|http):\/\//iu.exec(baseUrl)?.[0] ?? null;
  const rawAfterScheme = rawScheme === null ? "" : baseUrl.slice(rawScheme.length);
  const rawPathOffset = rawAfterScheme.indexOf("/");
  const rawAuthority = rawPathOffset === -1
    ? rawAfterScheme
    : rawAfterScheme.slice(0, rawPathOffset);
  if (
    rawScheme === null
    || rawAuthority.length === 0
    || rawAuthority.includes("@")
    || rawAuthority.includes("%")
    || rawAuthority.endsWith(":")
  ) {
    throw new TypeError("ASR provider base URL is invalid");
  }
  let normalized;
  try {
    normalized = new URL(baseUrl);
  } catch {
    throw new TypeError("ASR provider base URL is invalid");
  }
  if (
    !normalized.hostname
    || normalized.username
    || normalized.password
    || normalized.search
    || normalized.hash
    || !["https:", "http:"].includes(normalized.protocol)
  ) {
    throw new TypeError("ASR provider base URL is invalid");
  }
  if (
    normalized.protocol !== "https:"
    && !(allowLoopbackHttpForTests === true && LOOPBACK_HOSTS.has(normalized.hostname))
  ) {
    throw new TypeError("ASR provider base URL must use HTTPS");
  }
  normalized.pathname = `${normalized.pathname.replace(/\/+$/u, "")}/`;
  const endpoint = new URL("audio/transcriptions", normalized);
  return Object.freeze({ normalizedBaseUrl: normalized, endpoint });
}

async function discardBody(body) {
  try {
    const cancel = body?.cancel;
    if (typeof cancel === "function") await cancel.call(body);
    else {
      const destroy = body?.destroy;
      if (typeof destroy === "function") destroy.call(body);
    }
  } catch {
    // A provider error body is never promoted over the fixed public error.
  }
}

async function destroyBodyAndWaitForClose(body, destroy) {
  if (body.closed === true) return;
  const once = body.once;
  if (typeof once !== "function") {
    destroy.call(body);
    if (body.destroyed !== true && body.closed !== true) {
      throw new Error("ASR provider response body destruction was not observable");
    }
    return;
  }
  const on = body.on;
  const removeListener = body.removeListener;
  let settled = false;
  let resolveClose;
  let closeError = null;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const cleanupListeners = () => {
    if (typeof removeListener !== "function") return;
    removeListener.call(body, "close", onClose);
    removeListener.call(body, "error", onError);
  };
  const onClose = () => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    resolveClose();
  };
  const onError = (error) => {
    closeError ??= error;
  };
  once.call(body, "close", onClose);
  if (typeof on === "function") on.call(body, "error", onError);
  else once.call(body, "error", onError);
  try {
    if (body.destroyed !== true) destroy.call(body);
  } catch (error) {
    settled = true;
    cleanupListeners();
    throw error;
  }
  await Promise.race([
    closed,
    new Promise((resolve) => setImmediate(resolve)),
  ]);
  if (!settled && body.closed === true) onClose();
  await closed;
  if (closeError) throw closeError;
}

async function discardBodyStrict(
  body,
  iterator = null,
  { iteratorAcquisitionAttempted = false } = {},
) {
  if (!body) return;
  const cancel = body.cancel;
  if (typeof cancel === "function") {
    const iteratorReturn = iterator?.return;
    const cancellation = Promise.resolve().then(() => cancel.call(body));
    const iteratorClosure = typeof iteratorReturn === "function"
      ? Promise.resolve().then(() => iteratorReturn.call(iterator))
      : Promise.resolve();
    const settlements = await Promise.allSettled([cancellation, iteratorClosure]);
    const rejected = settlements.find((settlement) => settlement.status === "rejected");
    if (rejected) throw rejected.reason;
    return;
  }
  const destroy = body.destroy;
  if (typeof destroy === "function") {
    await destroyBodyAndWaitForClose(body, destroy);
    return;
  }
  const iteratorReturn = iterator?.return;
  if (typeof iteratorReturn === "function") {
    await iteratorReturn.call(iterator);
    return;
  }
  if (!iteratorAcquisitionAttempted) {
    const asyncIteratorFactory = body[Symbol.asyncIterator];
    if (typeof asyncIteratorFactory === "function") {
      const bodyIterator = asyncIteratorFactory.call(body);
      const bodyIteratorReturn = bodyIterator?.return;
      if (typeof bodyIteratorReturn === "function") {
        await bodyIteratorReturn.call(bodyIterator);
        return;
      }
    }
  }
  throw new TypeError("ASR provider response body cannot be cancelled");
}

function settleWithin(promise, timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(value);
    };
    const timer = setTimeoutImpl(() => finish(false), timeoutMs);
    Promise.resolve(promise).then(() => finish(true), () => finish(false));
  });
}

function releaseResponseReader(state) {
  if (!state.reader || state.released) return true;
  const releaseLock = state.reader.releaseLock;
  if (typeof releaseLock !== "function") return false;
  try {
    releaseLock.call(state.reader);
    state.released = true;
    return true;
  } catch {
    return false;
  }
}

function startResponseReaderCleanup(state) {
  if (!state.reader) return Promise.resolve();
  if (state.cleanupLifecycle) return state.cleanupLifecycle;
  let cancellation;
  try {
    const cancel = state.reader.cancel;
    if (typeof cancel !== "function") {
      throw new TypeError("provider response reader cannot be cancelled");
    }
    cancellation = Promise.resolve(cancel.call(state.reader));
  } catch (error) {
    cancellation = Promise.reject(error);
  }
  cancellation.catch(() => {
    // The lifecycle below owns the fixed cleanup failure mapping.
  });
  releaseResponseReader(state);
  state.cleanupLifecycle = cancellation.then(() => {
    if (!releaseResponseReader(state)) {
      throw new Error("ASR provider response reader lock was not released");
    }
  });
  state.cleanupLifecycle.catch(() => {
    // The caller waits this lifecycle with a bounded cleanup deadline.
  });
  return state.cleanupLifecycle;
}

function startAsyncBodyCleanup(state) {
  if (!state.body) return Promise.resolve();
  if (state.cleanupLifecycle) return state.cleanupLifecycle;
  state.cancelRead?.();
  const bodyCleanup = discardBodyStrict(state.body, state.iterator, {
    iteratorAcquisitionAttempted: state.iteratorAcquisitionAttempted,
  });
  const readLifecycle = state.readLifecycle ?? Promise.resolve();
  state.cleanupLifecycle = Promise.allSettled([bodyCleanup, readLifecycle]).then((settlements) => {
    const rejected = settlements.find((settlement) => settlement.status === "rejected");
    if (rejected) throw rejected.reason;
  });
  state.cleanupLifecycle.catch(() => {
    // The caller waits this lifecycle with a bounded cleanup deadline.
  });
  return state.cleanupLifecycle;
}

async function readBoundedJsonBody(
  body,
  maxBytes,
  onOverflow,
  readerState,
  asyncBodyState,
) {
  if (!body) throw contractError(
    "ASR_PROVIDER_BAD_RESPONSE",
    502,
    "ASR provider returned an invalid response",
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  function acceptChunk(value) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      throw contractError(
        "ASR_PROVIDER_BAD_RESPONSE",
        502,
        "ASR provider returned an invalid response",
      );
    }
    text += decoder.decode(chunk, { stream: true });
  }

  try {
    const getReader = body.getReader;
    if (typeof getReader === "function") {
      const reader = getReader.call(body);
      readerState.reader = reader;
      readerState.onAcquired?.();
      try {
        const read = reader?.read;
        if (typeof read !== "function") {
          throw new TypeError("provider response body has an invalid reader");
        }
        while (true) {
          readerState.readStarted = true;
          let readPromise;
          try {
            readPromise = read.call(reader);
          } catch (error) {
            throw error;
          }
          let readResult;
          try {
            readResult = await readPromise;
          } catch (error) {
            readerState.erroredTerminal = true;
            throw error;
          }
          const { value, done } = readResult;
          if (done) {
            readerState.completed = true;
            break;
          }
          try {
            acceptChunk(value);
          } catch (error) {
            await onOverflow(reader);
            throw error;
          }
        }
      } finally {
        if (
          (readerState.completed || readerState.erroredTerminal)
          && !releaseResponseReader(readerState)
        ) {
          throw new Error("ASR provider response reader lock was not released");
        }
      }
    } else {
      let asyncIteratorFactory;
      try {
        asyncIteratorFactory = body[Symbol.asyncIterator];
      } catch (error) {
        asyncBodyState.body = body;
        asyncBodyState.iteratorAcquisitionAttempted = true;
        throw error;
      }
      if (typeof asyncIteratorFactory !== "function") {
        throw new TypeError("provider response body is not a readable stream");
      }
      asyncBodyState.body = body;
      asyncBodyState.iteratorAcquisitionAttempted = true;
      const iterator = asyncIteratorFactory.call(body);
      asyncBodyState.iterator = iterator;
      const iteratorNext = iterator?.next;
      if (typeof iteratorNext !== "function") {
        throw new TypeError("provider response body has an invalid async iterator");
      }
      asyncBodyState.readLifecycle = new Promise((resolve) => {
        asyncBodyState.resolveReadLifecycle = resolve;
      });
      asyncBodyState.readCancellation = new Promise((resolve) => {
        asyncBodyState.resolveReadCancellation = resolve;
      });
      asyncBodyState.cancelRead = () => {
        if (asyncBodyState.readCancelled) return;
        asyncBodyState.readCancelled = true;
        asyncBodyState.resolveReadCancellation?.(ASYNC_BODY_READ_CANCELLED);
      };
      try {
        asyncBodyState.onAcquired?.();
        while (true) {
          const next = Promise.resolve().then(() => iteratorNext.call(iterator));
          next.catch(() => {
            // The read-cancel gate may win; retain a rejection observer on late next().
          });
          const nextResult = await Promise.race([next, asyncBodyState.readCancellation]);
          if (nextResult === ASYNC_BODY_READ_CANCELLED) {
            throw new DOMException("ASR provider response read was cancelled", "AbortError");
          }
          const { value: chunk, done } = nextResult;
          if (done) {
            asyncBodyState.completed = true;
            break;
          }
          try {
            acceptChunk(chunk);
          } catch (error) {
            await onOverflow(null);
            throw error;
          }
        }
      } finally {
        asyncBodyState.readSettled = true;
        asyncBodyState.resolveReadLifecycle?.();
      }
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AsrContractError) throw error;
    throw contractError(
      "ASR_PROVIDER_BAD_RESPONSE",
      502,
      "ASR provider returned an invalid response",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw contractError(
      "ASR_PROVIDER_BAD_RESPONSE",
      502,
      "ASR provider returned an invalid response",
    );
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1
    || typeof parsed.text !== "string"
  ) {
    throw contractError(
      "ASR_PROVIDER_BAD_RESPONSE",
      502,
      "ASR provider returned an invalid response",
    );
  }
  return parsed;
}

function externalAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function createProviderOperationGuard({
  signal,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const controller = new AbortController();
  let timedOut = false;
  let rejectGuard;
  const guard = new Promise((_, reject) => {
    rejectGuard = reject;
  });
  guard.catch(() => {
    // Each guarded stage observes the original promise; keep an early deadline
    // from being reported as unhandled before the first stage race attaches.
  });
  const onExternalAbort = () => {
    const reason = externalAbortError(signal);
    controller.abort(reason);
    rejectGuard(reason);
  };
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeoutImpl(() => {
    timedOut = true;
    const reason = new DOMException("ASR provider timed out", "TimeoutError");
    controller.abort(reason);
    rejectGuard(reason);
  }, timeoutMs);

  return Object.freeze({
    controller,
    timedOut: () => timedOut,
    race(promise) {
      return Promise.race([Promise.resolve(promise), guard]);
    },
    cleanup() {
      clearTimeoutImpl(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    },
  });
}

export function createOpenAiCompatibleProvider(config = {}, dependencies = {}) {
  const {
    endpoint,
  } = normalizeOpenAiCompatibleBaseUrl(config.baseUrl, {
    allowLoopbackHttpForTests: dependencies.allowLoopbackHttpForTests === true,
  });
  const model = validateModel(config.model);
  const timeoutMs = validateTimeout(config.timeoutMs ?? ASR_LIMITS.providerTimeoutMs);
  if (typeof config.asrApiKeyProvider !== "function") {
    throw new TypeError("asrApiKeyProvider must be a function");
  }

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const openAsBlobImpl = dependencies.openAsBlobImpl ?? openAsBlob;
  const FormDataImpl = dependencies.FormDataImpl ?? globalThis.FormData;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? globalThis.clearTimeout;
  const readerCleanupTimeoutMs = validateTimeout(
    dependencies.readerCleanupTimeoutMs ?? ASR_LIMITS.childKillGraceMs,
  );
  if (
    typeof fetchImpl !== "function"
    || typeof openAsBlobImpl !== "function"
    || typeof FormDataImpl !== "function"
  ) {
    throw new TypeError("ASR provider runtime dependencies are unavailable");
  }

  return Object.freeze({
    id: PROVIDER_ID,
    credentialCompatibility: "independent",
    readiness() {
      return Object.freeze({ ready: true, code: "READY" });
    },
    async transcribe(input = {}) {
      if (canonicalizeAsrMediaType(input.mediaType) !== "audio/wav") {
        throw new TypeError("provider accepts only normalized audio/wav");
      }
      const purpose = parseAsrPurpose(input.purpose);
      if (input.language !== "zh-CN") {
        throw new TypeError("provider accepts only zh-CN input");
      }
      if (typeof input.audioPath !== "string" || input.audioPath.length === 0) {
        throw new TypeError("provider audioPath must be a server-generated path");
      }
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
        throw new TypeError("provider durationMs must be a positive safe integer");
      }
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
        throw new TypeError("provider signal must be an AbortSignal");
      }
      const onResourceLifecycle = input[ASR_PROVIDER_RESOURCE_LIFECYCLE];
      if (
        onResourceLifecycle !== undefined
        && typeof onResourceLifecycle !== "function"
      ) {
        throw new TypeError("onLateResourceLifecycle must be a function");
      }
      if (input.signal?.aborted) throw externalAbortError(input.signal);

      const operation = createProviderOperationGuard({
        signal: input.signal,
        timeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      });

      let key = null;
      let audioBlob = null;
      let form = null;
      let response = null;
      let responseBody = null;
      let fetchPromise = null;
      let lateFetchCleanupLifecycle = null;
      let responseCleanupLifecycle = null;
      let responseCleanupVerificationPromise = null;
      let responseCleanupFailed = false;
      let responseCleanupRegistrationFailed = false;
      const responseReaderState = {
        reader: null,
        readStarted: false,
        completed: false,
        erroredTerminal: false,
        released: false,
        cleanupLifecycle: null,
        cleanupRegistered: false,
        cleanupRegistrationAttempted: false,
        cleanupRegistrationFailed: false,
        onAcquired: null,
      };
      const responseAsyncBodyState = {
        body: null,
        iterator: null,
        iteratorAcquisitionAttempted: false,
        completed: false,
        readLifecycle: null,
        resolveReadLifecycle: null,
        readCancellation: null,
        resolveReadCancellation: null,
        cancelRead: null,
        readCancelled: false,
        readSettled: false,
        cleanupLifecycle: null,
        cleanupRegistered: false,
        cleanupRegistrationAttempted: false,
        cleanupRegistrationFailed: false,
        onAcquired: null,
      };
      let onProviderAbort = null;
      function registerResponseReaderCleanup() {
        const lifecycle = startResponseReaderCleanup(responseReaderState);
        if (!responseReaderState.cleanupRegistrationAttempted) {
          responseReaderState.cleanupRegistrationAttempted = true;
          try {
            onResourceLifecycle?.(lifecycle);
            responseReaderState.cleanupRegistered = true;
          } catch (error) {
            responseReaderState.cleanupRegistrationFailed = true;
            throw error;
          }
        }
        return lifecycle;
      }
      function registerResponseAsyncBodyCleanup() {
        const lifecycle = startAsyncBodyCleanup(responseAsyncBodyState);
        if (!responseAsyncBodyState.cleanupRegistrationAttempted) {
          responseAsyncBodyState.cleanupRegistrationAttempted = true;
          try {
            onResourceLifecycle?.(lifecycle);
            responseAsyncBodyState.cleanupRegistered = true;
          } catch (error) {
            responseAsyncBodyState.cleanupRegistrationFailed = true;
            throw error;
          }
        }
        return lifecycle;
      }
      function registerActiveResponseCleanup() {
        if (
          responseReaderState.reader
          && (
            responseReaderState.cleanupLifecycle
            || !responseReaderState.released
            || (!responseReaderState.completed && !responseReaderState.erroredTerminal)
          )
        ) {
          return registerResponseReaderCleanup();
        }
        if (
          responseAsyncBodyState.body
          && (responseAsyncBodyState.cleanupLifecycle || !responseAsyncBodyState.completed)
        ) {
          return registerResponseAsyncBodyCleanup();
        }
        return Promise.resolve();
      }
      function registerResponseBodyCleanup(body) {
        if (responseCleanupLifecycle) return responseCleanupLifecycle;
        responseCleanupLifecycle = discardBodyStrict(body);
        responseCleanupLifecycle.catch(() => {
          responseCleanupFailed = true;
          // The caller waits this lifecycle with a bounded cleanup deadline.
        });
        try {
          onResourceLifecycle?.(responseCleanupLifecycle);
        } catch {
          responseCleanupRegistrationFailed = true;
        }
        return responseCleanupLifecycle;
      }
      function verifyResponseBodyCleanup(body) {
        if (responseCleanupVerificationPromise) return responseCleanupVerificationPromise;
        responseCleanupVerificationPromise = (async () => {
          let lifecycle;
          try {
            lifecycle = registerResponseBodyCleanup(body);
          } catch {
            responseCleanupFailed = true;
            return false;
          }
          const settled = await settleWithin(
            lifecycle,
            readerCleanupTimeoutMs,
            setTimeoutImpl,
            clearTimeoutImpl,
          );
          if (!settled || responseCleanupRegistrationFailed) {
            responseCleanupFailed = true;
          }
          return !responseCleanupFailed;
        })().catch(() => {
          responseCleanupFailed = true;
          return false;
        });
        return responseCleanupVerificationPromise;
      }
      function registerLateFetchCleanup() {
        if (lateFetchCleanupLifecycle) return lateFetchCleanupLifecycle;
        lateFetchCleanupLifecycle = fetchPromise.then(
          (lateResponse) => discardBodyStrict(lateResponse?.body),
          () => undefined,
        );
        lateFetchCleanupLifecycle.catch(() => {
          // The service lifecycle ledger owns late body cleanup failures.
        });
        try {
          onResourceLifecycle?.(lateFetchCleanupLifecycle);
        } catch {
          responseCleanupRegistrationFailed = true;
        }
        return lateFetchCleanupLifecycle;
      }
      const onResponseStreamAcquired = () => {
        onProviderAbort = () => {
          queueMicrotask(() => {
            try {
              registerActiveResponseCleanup();
            } catch {
              // The bounded catch cleanup below converts integration failure to 503.
            }
          });
        };
        operation.controller.signal.addEventListener("abort", onProviderAbort, { once: true });
        if (operation.controller.signal.aborted) onProviderAbort();
      };
      responseReaderState.onAcquired = onResponseStreamAcquired;
      responseAsyncBodyState.onAcquired = onResponseStreamAcquired;
      try {
        try {
          key = await operation.race(
            Promise.resolve().then(() => config.asrApiKeyProvider()),
          );
        } catch (error) {
          if (input.signal?.aborted) throw externalAbortError(input.signal);
          if (operation.timedOut()) {
            throw contractError("ASR_TIMEOUT", 504, "ASR provider timed out");
          }
          throw contractError("ASR_NOT_CONFIGURED", 503, "ASR provider is not configured");
        }
        if (
          typeof key !== "string"
          || key.length === 0
          || key.length > 4_096
          || key !== key.trim()
          || /[\u0000-\u001f\u007f-\u009f]/u.test(key)
        ) {
          throw contractError("ASR_NOT_CONFIGURED", 503, "ASR provider is not configured");
        }
        if (input.signal?.aborted) throw externalAbortError(input.signal);

        audioBlob = await operation.race(
          Promise.resolve().then(() => openAsBlobImpl(input.audioPath, { type: "audio/wav" })),
        );
        if (input.signal?.aborted) throw externalAbortError(input.signal);
        form = new FormDataImpl();
        form.append("file", audioBlob, "audio.wav");
        form.append("model", model);
        form.append("language", "zh");
        form.append("response_format", "json");
        fetchPromise = Promise.resolve().then(() => fetchImpl(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            redirect: "error",
            signal: operation.controller.signal,
          }));
        response = await operation.race(fetchPromise);
        responseBody = response?.body ?? null;
        if (!response || response.ok !== true) {
          operation.controller.abort(
            new DOMException("ASR provider rejected the transcription request", "AbortError"),
          );
          if (!await verifyResponseBodyCleanup(responseBody)) {
            throw contractError(
              "ASR_CLEANUP_FAILED",
              503,
              "ASR provider response cleanup failed",
            );
          }
          throw contractError(
            "ASR_PROVIDER_BAD_RESPONSE",
            502,
            "ASR provider rejected the transcription request",
          );
        }
        const responseReadPromise = readBoundedJsonBody(
            responseBody,
            ASR_LIMITS.providerResponseMaxBytes,
            () => {
              operation.controller.abort(
                new DOMException("ASR provider response exceeded its limit", "AbortError"),
              );
              registerActiveResponseCleanup();
            },
            responseReaderState,
            responseAsyncBodyState,
          );
        responseReadPromise.catch(() => {
          // A service-level processing deadline may win while reader cleanup continues.
        });
        const parsed = await operation.race(responseReadPromise);
        if (input.signal?.aborted) throw externalAbortError(input.signal);
        return Object.freeze({ text: normalizeAsrTranscript(parsed.text, purpose) });
      } catch (error) {
        if (
          fetchPromise
          && response === null
          && (operation.timedOut() || operation.controller.signal.aborted)
        ) {
          registerLateFetchCleanup();
        }
        let responseCleanupVerified = !responseReaderState.cleanupRegistrationFailed
          && !responseAsyncBodyState.cleanupRegistrationFailed
          && !responseCleanupFailed
          && !responseCleanupRegistrationFailed;
        /*
          A captured body with no published reader/iterator owner must still be
          cancelled exactly once. This includes 2xx acquisition failure and an
          exception while inspecting response.ok. The cached verifier bounds the
          same generic lifecycle once before preserving a fixed provider error.
        */
        if (
          responseBody
          && !responseReaderState.reader
          && !responseAsyncBodyState.body
        ) {
          if (!await verifyResponseBodyCleanup(responseBody)) {
            responseCleanupVerified = false;
          }
        }
        if (
          responseReaderState.reader
          && (
            responseReaderState.cleanupLifecycle
            || !responseReaderState.released
            || (!responseReaderState.completed && !responseReaderState.erroredTerminal)
          )
        ) {
          let cleanupLifecycle;
          try {
            cleanupLifecycle = registerResponseReaderCleanup();
          } catch {
            responseCleanupVerified = false;
          }
          if (
            cleanupLifecycle
            && !await settleWithin(
              cleanupLifecycle,
              readerCleanupTimeoutMs,
              setTimeoutImpl,
              clearTimeoutImpl,
            )
          ) {
            responseCleanupVerified = false;
          }
        }
        if (
          responseAsyncBodyState.body
          && (responseAsyncBodyState.cleanupLifecycle || !responseAsyncBodyState.completed)
        ) {
          let cleanupLifecycle;
          try {
            cleanupLifecycle = registerResponseAsyncBodyCleanup();
          } catch {
            responseCleanupVerified = false;
          }
          if (
            cleanupLifecycle
            && !await settleWithin(
              cleanupLifecycle,
              readerCleanupTimeoutMs,
              setTimeoutImpl,
              clearTimeoutImpl,
            )
          ) {
            responseCleanupVerified = false;
          }
        }
        if (!responseCleanupVerified) {
          throw contractError(
            "ASR_CLEANUP_FAILED",
            503,
            "ASR provider response cleanup failed",
          );
        }
        if (input.signal?.aborted) throw externalAbortError(input.signal);
        if (operation.timedOut()) {
          throw contractError("ASR_TIMEOUT", 504, "ASR provider timed out");
        }
        if (error instanceof AsrContractError) throw error;
        throw contractError(
          "ASR_PROVIDER_BAD_RESPONSE",
          502,
          "ASR provider request failed",
        );
      } finally {
        if (onProviderAbort) {
          operation.controller.signal.removeEventListener("abort", onProviderAbort);
        }
        operation.cleanup();
        responseBody = null;
        response = null;
        form = null;
        audioBlob = null;
        key = null;
      }
    },
  });
}

export function createAsrProvider(config, dependencies) {
  if (config?.provider !== undefined && config.provider !== PROVIDER_ID) {
    throw new TypeError("ASR provider must be openai-compatible");
  }
  return createOpenAiCompatibleProvider(config, dependencies);
}
