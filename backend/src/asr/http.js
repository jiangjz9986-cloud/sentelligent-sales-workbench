import { loginRateLimitKey } from "../auth/loginRateLimit.js";
import { HttpError } from "../http/errors.js";
import {
  ASR_LIMITS,
  AsrContractError,
  parseAsrQuery,
  parseAsrRequestHeaders,
} from "./contracts.js";

/**
 * HTTP boundary for the server-side ASR runtime.
 *
 * This module deliberately contains no business writes.  The only persistent
 * state it touches is the existing HMAC-keyed request-rate bucket.  Audio
 * ownership is handed to the ASR service only after authentication, query and
 * header validation, credential readiness and the request-count gate pass.
 */

export const ASR_ROUTE = "/api/asr/transcriptions";
export const ASR_STATUS_ROUTE = "/api/admin/asr/status";

const ALLOWED_QUERY_KEYS = new Set(["purpose"]);
const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
});
const AI_PLATFORM_MODES = new Set(["disabled", "optional", "required"]);

function boundedNow(now) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(now)) {
    throw new TypeError("now must be a safe integer timestamp");
  }
  return now;
}

function boundedIdentity(value, label) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded identity`);
  }
  return value.trim();
}

function retryAfterSeconds(windowStartedAt, now) {
  const startedAt = Date.parse(windowStartedAt);
  const remainingMs = Number.isFinite(startedAt)
    ? Math.max(1, startedAt + ASR_LIMITS.accountIpWindowMs - now)
    : ASR_LIMITS.accountIpWindowMs;
  return Math.max(1, Math.min(300, Math.ceil(remainingMs / 1_000)));
}

function rateLimitedError(retryAfter) {
  const error = new HttpError(429, "ASR_RATE_LIMITED", "ASR request rate limit exceeded");
  error.retryAfterSeconds = retryAfter;
  return error;
}

/**
 * Return the HMAC namespace used by browser ASR requests.  The resulting key
 * is indistinguishable from a login limiter key and therefore never exposes an
 * account name or address in SQLite.
 */
export function asrRateLimitKey(secret, account, remoteAddress) {
  const owner = boundedIdentity(account, "account").toLowerCase();
  const address = boundedIdentity(remoteAddress, "remoteAddress").toLowerCase();
  return loginRateLimitKey(secret, `asr-web:${owner}`, address);
}

function rateLimitRow(db, key) {
  return db.prepare(`
    SELECT failures, window_started_at AS windowStartedAt
    FROM login_rate_limits
    WHERE key = ?
  `).get(key);
}

/**
 * Consume one account+IP request slot.
 *
 * The increment itself is a conditional SQL UPDATE, not a SELECT followed by
 * a JavaScript decision and an unconditional UPDATE.  SQLite serializes the
 * write; concurrent workers therefore cannot turn the twelfth slot into a
 * thirteenth slot.  A missing row is inserted once, and an expired row is
 * reset atomically by the same conditional statement.  The read after a
 * rejected UPDATE is only for constructing a bounded Retry-After hint.
 */
export function consumeAsrRateLimit(db, key, now = Date.now()) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(key)) {
    throw new TypeError("ASR rate limit key is invalid");
  }
  const currentTime = boundedNow(now);
  const windowStartedAt = new Date(currentTime).toISOString();
  const cutoff = new Date(currentTime - ASR_LIMITS.accountIpWindowMs).toISOString();

  // The INSERT is intentionally conflict-do-nothing.  It establishes a row
  // without a read/branch race; the conditional UPDATE below consumes the
  // first slot for an existing row and all subsequent slots.
  const inserted = db.prepare(`
    INSERT INTO login_rate_limits (key, failures, window_started_at, blocked_until)
    VALUES (:key, 1, :windowStartedAt, NULL)
    ON CONFLICT(key) DO NOTHING
  `).run({ key, windowStartedAt });
  if (Number(inserted?.changes ?? 0) === 1) {
    return Object.freeze({
      count: 1,
      remaining: ASR_LIMITS.accountIpRequestLimit - 1,
    });
  }

  const updated = db.prepare(`
    UPDATE login_rate_limits
    SET failures = CASE
          WHEN julianday(window_started_at) IS NULL
            OR window_started_at <= :cutoff
            THEN 1
          ELSE failures + 1
        END,
        window_started_at = CASE
          WHEN julianday(window_started_at) IS NULL
            OR window_started_at <= :cutoff
            THEN :windowStartedAt
          ELSE window_started_at
        END,
        blocked_until = NULL
    WHERE key = :key
      AND (
        julianday(window_started_at) IS NULL
        OR window_started_at <= :cutoff
        OR (typeof(failures) = 'integer' AND failures >= 0 AND failures < :limit)
      )
  `).run({
    key,
    cutoff,
    windowStartedAt,
    limit: ASR_LIMITS.accountIpRequestLimit,
  });

  if (Number(updated?.changes ?? 0) !== 1) {
    const row = rateLimitRow(db, key);
    throw rateLimitedError(retryAfterSeconds(row?.windowStartedAt, currentTime));
  }

  const row = rateLimitRow(db, key);
  const count = Number(row?.failures);
  if (!Number.isSafeInteger(count) || count <= 0 || count > ASR_LIMITS.accountIpRequestLimit) {
    // A corrupt row must fail closed rather than grant an unbounded slot.
    throw rateLimitedError(retryAfterSeconds(row?.windowStartedAt, currentTime));
  }
  return Object.freeze({
    count,
    remaining: ASR_LIMITS.accountIpRequestLimit - count,
  });
}

/**
 * Register destruction of an unread request body after the response has been
 * fully emitted.  Destroying before `finish` can truncate the JSON error body;
 * `close` is retained as a fallback when a response can no longer finish.
 */
export function createDeferredUnreadBodyFinalizer(response) {
  if (!response || typeof response.once !== "function" || typeof response.removeListener !== "function") {
    throw new TypeError("response must be an event emitter");
  }
  let terminate = null;
  let registered = false;
  let finalized = false;

  const removeListeners = () => {
    response.removeListener("finish", onFinish);
    response.removeListener("close", onClose);
  };
  const finalize = () => {
    if (finalized) return false;
    finalized = true;
    removeListeners();
    try {
      return terminate?.() !== false;
    } catch {
      return false;
    }
  };
  const onFinish = () => finalize();
  const onClose = () => {
    // A normal response emits `close` after `finish`; the listener was already
    // removed in that case.  If close is the first event, terminate unread data.
    finalize();
  };

  const defer = (callback) => {
    if (typeof callback !== "function") throw new TypeError("terminate callback is required");
    if (registered) return true;
    registered = true;
    terminate = callback;
    if (response.writableFinished === true || response.destroyed === true) {
      finalize();
      return true;
    }
    response.once("finish", onFinish);
    response.once("close", onClose);
    return true;
  };

  return Object.freeze({
    defer,
    isRegistered: () => registered,
    isFinalized: () => finalized,
  });
}

function terminateUnreadRequest(request) {
  if (!request || request.destroyed === true) return false;
  try {
    if (typeof request.destroy === "function") {
      request.destroy();
      return true;
    }
    if (typeof request.cancel === "function") {
      Promise.resolve(request.cancel()).catch(() => {});
      return true;
    }
  } catch {
    // The fixed HTTP error remains authoritative.
  }
  return false;
}

function validationError() {
  return new HttpError(422, "VALIDATION_ERROR", "ASR request validation failed");
}

/** Map internal ASR contract failures to the fixed public HTTP vocabulary. */
export function mapAsrHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof AsrContractError) {
    return new HttpError(error.status, error.code, error.message);
  }
  return new HttpError(500, "INTERNAL_ERROR", "Internal server error");
}

function parseAsrHttpRequest(request, url) {
  try {
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_QUERY_KEYS.has(key)) throw new TypeError("query key is invalid");
    }
    const query = parseAsrQuery(url.searchParams);
    const headers = parseAsrRequestHeaders(request.headers);
    return Object.freeze({ ...query, ...headers });
  } catch (error) {
    if (error instanceof AsrContractError) throw error;
    if (error instanceof TypeError) throw validationError();
    throw error;
  }
}

function credentialIsActive(metadata) {
  return Boolean(
    metadata
    && typeof metadata === "object"
    && metadata.configured === true
    && metadata.status === "active",
  );
}

function normalizeAiPlatformMode(value) {
  const mode = value === undefined || value === null || value === ""
    ? "disabled"
    : String(value).trim().toLowerCase();
  if (!AI_PLATFORM_MODES.has(mode)) throw new TypeError("AI platform mode is invalid");
  return mode;
}

function aiPlatformIsConfigured(aiPlatformRuntime) {
  if (!aiPlatformRuntime) return false;
  try {
    if (typeof aiPlatformRuntime.configured === "function") {
      return aiPlatformRuntime.configured() === true;
    }
    return aiPlatformRuntime.configured === true;
  } catch {
    return false;
  }
}

function aiPlatformPreflightState(config, aiPlatformRuntime) {
  const mode = normalizeAiPlatformMode(config?.aiPlatformMode ?? aiPlatformRuntime?.mode);
  const configured = aiPlatformIsConfigured(aiPlatformRuntime);
  return Object.freeze({
    mode,
    configured,
    bypassLegacyCredential: mode === "required"
      || (mode === "optional" && configured),
  });
}

function requestAbortLifecycle(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("ASR client connection closed", "AbortError"));
    }
  };
  const onRequestAborted = () => abort();
  const onResponseClose = () => {
    // `close` after a successfully finished response is normal and must not
    // turn a successful transcription into a spurious 500/abort.
    if (response.writableFinished !== true) abort();
  };
  request.once?.("aborted", onRequestAborted);
  request.once?.("error", onRequestAborted);
  response.once("close", onResponseClose);
  // Node can mark a peer gone before route-specific listeners are installed
  // (for example while authentication is still running).  Close that race so
  // no credential/readiness/provider work starts for an already-dead request.
  if (request.aborted === true || request.destroyed === true || response.destroyed === true) {
    abort();
  }
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      request.removeListener?.("aborted", onRequestAborted);
      request.removeListener?.("error", onRequestAborted);
      response.removeListener("close", onResponseClose);
    },
  });
}

function requestDisconnected(request, response, signal) {
  return request.aborted === true
    || response.destroyed === true
    || signal?.aborted === true;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("ASR client connection closed", "AbortError");
}

function awaitRequestPreflight(operation, {
  signal,
  timeoutMs,
  timeoutMessage,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (typeof operation !== "function") throw new TypeError("ASR preflight operation is required");
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const operationController = new AbortController();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const cancelOperation = (reason) => {
      if (!operationController.signal.aborted) operationController.abort(reason);
    };
    const onAbort = () => {
      const reason = abortReason(signal);
      cancelOperation(reason);
      finish(reject, reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeoutImpl(() => {
      const error = new AsrContractError(
        "ASR_TIMEOUT",
        504,
        timeoutMessage ?? "ASR request preflight timed out",
      );
      cancelOperation(error);
      finish(reject, error);
    }, timeoutMs);
    Promise.resolve().then(() => operation(operationController.signal)).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function retryHeaders(error) {
  if (error?.code === "ASR_IN_PROGRESS") return { "Retry-After": "1" };
  if (error?.code === "ASR_CAPACITY_EXCEEDED") return { "Retry-After": "2" };
  if (
    error?.code === "ASR_RATE_LIMITED"
    && Number.isSafeInteger(error.retryAfterSeconds)
    && error.retryAfterSeconds >= 1
    && error.retryAfterSeconds <= 300
  ) {
    return { "Retry-After": String(error.retryAfterSeconds) };
  }
  return {};
}

function sanitizedStatus(service, config, credentialConfigured, readiness) {
  const metrics = service.metrics.snapshot();
  const capacity = service.capacitySnapshot();
  return Object.freeze({
    mode: config.asrMode,
    provider: config.asrProvider,
    credentialConfigured,
    readiness: Object.freeze({
      ready: readiness.ready === true,
      code: String(readiness.code ?? "UNKNOWN").slice(0, 64),
    }),
    window: metrics.window,
    requests: metrics.counters.requestsTotal,
    providerCalls: metrics.counters.providerCallsTotal,
    outcomes: metrics.counters.outcomes,
    cleanupFailures: metrics.counters.cleanupFailuresTotal,
    inflight: metrics.gauges.inflight,
    activeUploads: metrics.gauges.activeUploads,
    tempBytes: metrics.gauges.tempBytes,
    staleTempDirectories: metrics.gauges.staleTempDirectories,
    p95: metrics.p95,
    capacity,
  });
}

export function createAsrHttpHandlers({
  db,
  config,
  service,
  credentialMetadataProvider,
  aiPlatformRuntime = null,
  now = Date.now,
  preflightTimeoutMs = Math.min(5_000, config?.asrTimeoutMs ?? 5_000),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("db is required");
  if (!service || typeof service.transcribe !== "function") throw new TypeError("ASR service is required");
  const platformRuntime = aiPlatformRuntime ?? config?.aiPlatformRuntime ?? null;
  const initialPlatformState = aiPlatformPreflightState(config, platformRuntime);
  if (
    typeof credentialMetadataProvider !== "function"
    && !initialPlatformState.bypassLegacyCredential
  ) {
    throw new TypeError("ASR credential metadata provider is required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(preflightTimeoutMs) || preflightTimeoutMs <= 0 || preflightTimeoutMs > 60_000) {
    throw new TypeError("ASR HTTP preflight timeout must be a bounded positive integer");
  }
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("ASR HTTP timer dependencies must be functions");
  }
  const rateLimitSecret = boundedIdentity(config?.authSessionSecret, "rate limit secret");

  async function activeCredential(signal, { skip = false } = {}) {
    if (skip) {
      if (signal?.aborted) throw abortReason(signal);
      return true;
    }
    try {
      const metadata = await awaitRequestPreflight(
        (operationSignal) => credentialMetadataProvider({ signal: operationSignal }),
        {
          signal,
          timeoutMs: preflightTimeoutMs,
          timeoutMessage: "ASR credential metadata lookup timed out",
          setTimeoutImpl,
          clearTimeoutImpl,
        },
      );
      return credentialIsActive(metadata);
    } catch (error) {
      if (error instanceof AsrContractError || error?.name === "AbortError") throw error;
      return false;
    }
  }

  async function handleTranscription({
    request,
    response,
    url,
    owner,
    requestId,
    remoteAddress,
    unreadBodyFinalizer,
  }) {
    const finalizer = unreadBodyFinalizer ?? createDeferredUnreadBodyFinalizer(response);
    if (
      !finalizer
      || typeof finalizer.defer !== "function"
      || typeof finalizer.isFinalized !== "function"
    ) {
      throw new TypeError("ASR unread-body finalizer is invalid");
    }
    const deferOwnTermination = () => finalizer.defer(() => terminateUnreadRequest(request));
    const abortLifecycle = requestAbortLifecycle(request, response);
    let parsed;
    try {
      if (request.method !== "POST") {
        const error = new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed for ASR transcription");
        error.headers = Object.freeze({ Allow: "POST" });
        throw error;
      }
      parsed = parseAsrHttpRequest(request, url);
      if (config.asrMode !== "live") {
        throw new HttpError(503, "ASR_NOT_CONFIGURED", "ASR is not configured");
      }
      const platformState = aiPlatformPreflightState(config, platformRuntime);
      // Legacy secure_settings readiness remains a compatibility gate only
      // when this request is not required to pass through the AI platform.
      if (!await activeCredential(abortLifecycle.signal, {
        skip: platformState.bypassLegacyCredential,
      })) {
        throw new HttpError(503, "ASR_NOT_CONFIGURED", "ASR is not configured");
      }
      consumeAsrRateLimit(
        db,
        asrRateLimitKey(rateLimitSecret, owner, remoteAddress),
        boundedNow(now()),
      );
      await awaitRequestPreflight((operationSignal) => service.initialize({
        signal: operationSignal,
      }), {
        signal: abortLifecycle.signal,
        timeoutMs: preflightTimeoutMs,
        timeoutMessage: "ASR initialization timed out",
        setTimeoutImpl,
        clearTimeoutImpl,
      });
      const readiness = await awaitRequestPreflight((operationSignal) => service.readiness({
        signal: operationSignal,
      }), {
        signal: abortLifecycle.signal,
        timeoutMs: preflightTimeoutMs,
        timeoutMessage: "ASR readiness check timed out",
        setTimeoutImpl,
        clearTimeoutImpl,
      });
      if (readiness?.ready !== true) {
        throw new HttpError(503, "ASR_NOT_CONFIGURED", "ASR is not configured");
      }
    } catch (error) {
      if (requestDisconnected(request, response, abortLifecycle.signal)) {
        abortLifecycle.cleanup();
        return null;
      }
      deferOwnTermination();
      const mapped = mapAsrHttpError(error);
      mapped.headers = Object.freeze({
        ...NO_STORE_HEADERS,
        ...(mapped.headers ?? {}),
        ...retryHeaders(mapped),
      });
      abortLifecycle.cleanup();
      throw mapped;
    }

    try {
      const item = await service.transcribe({
        body: request,
        owner,
        requestId,
        purpose: parsed.purpose,
        mediaType: parsed.mediaType,
        contentLength: parsed.contentLength,
        idempotencyKey: parsed.idempotencyKey,
        clientDurationMs: parsed.clientDurationMs,
        language: parsed.language,
        signal: abortLifecycle.signal,
        deferUnreadBodyTermination: finalizer.defer,
      });
      return Object.freeze({
        status: 200,
        body: Object.freeze({ requestId, item }),
        headers: NO_STORE_HEADERS,
      });
    } catch (error) {
      // Once the peer has gone away there is no response to write.  In
      // particular, do not let the outer server error handler turn this into a
      // misleading 500 or attempt a second JSON write.
      if (requestDisconnected(request, response, abortLifecycle.signal)) return null;
      const mapped = mapAsrHttpError(error);
      mapped.headers = Object.freeze({
        ...NO_STORE_HEADERS,
        ...(mapped.headers ?? {}),
        ...retryHeaders(mapped),
      });
      throw mapped;
    } finally {
      abortLifecycle.cleanup();
    }
  }

  async function statusSnapshot({ request, response } = {}) {
    const abortLifecycle = request && response
      ? requestAbortLifecycle(request, response)
    : Object.freeze({ signal: undefined, cleanup() {} });
    try {
      const platformState = aiPlatformPreflightState(config, platformRuntime);
      const configured = platformState.bypassLegacyCredential
        ? platformState.configured
        : await activeCredential(abortLifecycle.signal);
      const readiness = await awaitRequestPreflight((operationSignal) => service.readiness({
        signal: operationSignal,
      }), {
        signal: abortLifecycle.signal,
        timeoutMs: preflightTimeoutMs,
        timeoutMessage: "ASR readiness check timed out",
        setTimeoutImpl,
        clearTimeoutImpl,
      });
      if (request && response && requestDisconnected(request, response, abortLifecycle.signal)) {
        return null;
      }
      return sanitizedStatus(service, config, configured, readiness);
    } catch (error) {
      if (request && response && requestDisconnected(request, response, abortLifecycle.signal)) {
        return null;
      }
      const mapped = mapAsrHttpError(error);
      mapped.headers = Object.freeze({
        ...NO_STORE_HEADERS,
        ...(mapped.headers ?? {}),
      });
      throw mapped;
    } finally {
      abortLifecycle.cleanup();
    }
  }

  return Object.freeze({
    routes: Object.freeze({ transcription: ASR_ROUTE, status: ASR_STATUS_ROUTE }),
    handleTranscription,
    statusSnapshot,
  });
}

export const ASR_HTTP_NO_STORE_HEADERS = NO_STORE_HEADERS;
