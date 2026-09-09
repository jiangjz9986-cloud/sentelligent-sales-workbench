import { randomUUID } from "node:crypto";
import { createRequestBinding } from "../../../shared/aiPlatformRequestAuth.mjs";

const DEFAULT_RESPONSE_LIMIT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_PATH_LENGTH = 2_048;
const MAX_API_PREFIX_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4_000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_QUERY_VALUE_LENGTH = 512;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;
const MAX_POLL_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const API_PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]{1,100}$/u;
const CONTROL_OR_SPACE_PATTERN = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);

export class AiPlatformClientError extends Error {
  constructor(message, {
    code = "ai_platform_error",
    status = 502,
    requestId = null,
    details = null,
    retryable = false,
    aborted = false,
    cause = undefined,
  } = {}) {
    super(message, { cause });
    this.name = "AiPlatformClientError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
    this.retryable = retryable;
    this.aborted = aborted;
  }
}

function invalidArgument(message, kind = null) {
  const error = new TypeError(message);
  if (kind) error.aiPlatformKind = kind;
  return error;
}

function assertAbortSignal(signal, name = "signal") {
  if (signal === null || signal === undefined) return;
  if (
    typeof signal !== "object"
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw invalidArgument(`${name} must be an AbortSignal`);
  }
}

function safeHeaderValue(value, name, max) {
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim() || CONTROL_OR_SPACE_PATTERN.test(value)) {
    throw invalidArgument(`${name} is invalid`);
  }
  return value;
}

function optionalHeaderToken(value, name = "token") {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalidArgument(`${name} is invalid`, "invalid_token");
  if (!value) return null;
  try {
    return safeHeaderValue(value, name, MAX_TOKEN_LENGTH);
  } catch {
    throw invalidArgument(`${name} is invalid`, "invalid_token");
  }
}

function boundedId(value, name) {
  const normalized = String(value ?? "");
  if (!normalized || normalized !== normalized.trim() || !ID_PATTERN.test(normalized)) {
    throw invalidArgument(`${name} is invalid`);
  }
  return normalized;
}

function idempotencyKeyValue(value) {
  const normalized = String(value ?? "");
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) throw invalidArgument("idempotencyKey is invalid");
  return normalized;
}

function normalizeBaseUrl(value) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_BASE_URL_LENGTH
    || CONTROL_OR_SPACE_PATTERN.test(value)
    || value.includes("\\")
  ) {
    throw invalidArgument("AI platform baseUrl must be a bounded URL");
  }

  const schemeEnd = value.indexOf("://");
  const authorityPathStart = schemeEnd >= 0 ? value.indexOf("/", schemeEnd + 3) : -1;
  const rawPath = authorityPathStart >= 0 ? value.slice(authorityPathStart).split(/[?#]/u, 1)[0] : "";
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath) || /%2e/iu.test(rawPath)) {
    throw invalidArgument("AI platform baseUrl path is invalid");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgument("AI platform baseUrl must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw invalidArgument("AI platform baseUrl must be an HTTP(S) URL without credentials or query parameters");
  }
  validatePath(parsed.pathname, "baseUrl");
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${basePath}`;
}

function normalizeApiPrefix(value) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_API_PREFIX_LENGTH
    || CONTROL_OR_SPACE_PATTERN.test(value)
    || value.includes("\\")
    || value.includes("?")
    || value.includes("#")
  ) {
    throw invalidArgument("apiPrefix is invalid");
  }
  const segments = value.split("/").filter(Boolean);
  if (!segments.length) throw invalidArgument("apiPrefix is invalid");
  for (const segment of segments) {
    if (!API_PREFIX_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      throw invalidArgument("apiPrefix is invalid");
    }
  }
  return `/${segments.join("/")}`;
}

function validatePath(path, name = "path") {
  if (typeof path !== "string" || !path || path.length > MAX_PATH_LENGTH || !path.startsWith("/")) {
    throw invalidArgument(`${name} is invalid`);
  }
  if (CONTROL_OR_SPACE_PATTERN.test(path) || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw invalidArgument(`${name} is invalid`);
  }
  for (const segment of path.split("/")) {
    if (!segment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidArgument(`${name} is invalid`);
    }
    if (
      decoded === "."
      || decoded === ".."
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded.includes("?")
      || decoded.includes("#")
      || CONTROL_OR_SPACE_PATTERN.test(decoded)
    ) {
      throw invalidArgument(`${name} is invalid`);
    }
  }
  return path;
}

function encodeIdPath(value, name) {
  return encodeURIComponent(boundedId(value, name));
}

function normalizeInteger(value, name, { defaultValue, min, max }) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "number" && typeof value !== "string") throw invalidArgument(`${name} is invalid`);
  if (typeof value === "string" && !/^\d+$/u.test(value)) throw invalidArgument(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalidArgument(`${name} is invalid`);
  return parsed;
}

function normalizeQueryValue(value, name, max = MAX_QUERY_VALUE_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim() || CONTROL_OR_SPACE_PATTERN.test(value)) {
    throw invalidArgument(`${name} is invalid`);
  }
  return value;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return String(headers[key]);
  }
  return null;
}

function responseRequestId(response, fallback) {
  const candidate = getHeader(response?.headers, "x-request-id")
    || getHeader(response?.headers, "x-correlation-id");
  return typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate) ? candidate : fallback;
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("AI platform request was aborted");
  error.name = "AbortError";
  return error;
}

function timeoutReason() {
  const error = new Error("AI platform request timed out");
  error.name = "TimeoutError";
  return error;
}

function combineSignals(externalSignal, timeoutMs) {
  assertAbortSignal(externalSignal);
  const controller = new AbortController();
  let reasonKind = "none";
  let finished = false;
  let timeoutHandle = null;

  const onExternalAbort = () => {
    if (finished || controller.signal.aborted) return;
    reasonKind = "external";
    controller.abort(abortReason(externalSignal));
  };
  const onTimeout = () => {
    if (finished || controller.signal.aborted) return;
    reasonKind = "timeout";
    controller.abort(timeoutReason());
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  timeoutHandle = setTimeout(onTimeout, timeoutMs);

  return {
    signal: controller.signal,
    get reasonKind() { return reasonKind; },
    cleanup() {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function awaitWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Preserve the size/protocol error that caused cancellation.
  }
}

function responseTooLargeError(requestId) {
  return new AiPlatformClientError("AI platform response is too large", {
    code: "response_too_large",
    status: 502,
    requestId,
    retryable: false,
  });
}

async function readBoundedText(response, maxBytes, { signal = null, requestId = null } = {}) {
  const declaredRaw = getHeader(response?.headers, "content-length");
  if (declaredRaw !== null && declaredRaw !== "") {
    if (!/^\d+$/u.test(declaredRaw) || !Number.isSafeInteger(Number(declaredRaw))) {
      await cancelBody(response);
      throw new AiPlatformClientError("AI platform response has an invalid content length", {
        code: "invalid_response",
        status: 502,
        requestId,
        retryable: false,
      });
    }
    if (Number(declaredRaw) > maxBytes) {
      await cancelBody(response);
      throw responseTooLargeError(requestId);
    }
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    if (typeof response?.text === "function") {
      const text = await awaitWithSignal(response.text(), signal);
      if (typeof text !== "string") {
        throw new AiPlatformClientError("AI platform response body is invalid", {
          code: "invalid_response",
          status: 502,
          requestId,
          retryable: false,
        });
      }
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw responseTooLargeError(requestId);
      return text;
    }
    if (typeof response?.arrayBuffer === "function") {
      const raw = await awaitWithSignal(response.arrayBuffer(), signal);
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      if (!(bytes instanceof Uint8Array)) {
        throw new AiPlatformClientError("AI platform response body is invalid", {
          code: "invalid_response",
          status: 502,
          requestId,
          retryable: false,
        });
      }
      if (bytes.byteLength > maxBytes) throw responseTooLargeError(requestId);
      return Buffer.from(bytes).toString("utf8");
    }
    return "";
  }

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await awaitWithSignal(reader.read(), signal);
      if (!part || typeof part !== "object" || typeof part.done !== "boolean") {
        throw new AiPlatformClientError("AI platform response stream is invalid", {
          code: "invalid_response",
          status: 502,
          requestId,
          retryable: false,
        });
      }
      if (part.done) break;
      const value = part.value instanceof ArrayBuffer ? new Uint8Array(part.value) : part.value;
      if (!(value instanceof Uint8Array)) {
        throw new AiPlatformClientError("AI platform response stream is invalid", {
          code: "invalid_response",
          status: 502,
          requestId,
          retryable: false,
        });
      }
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw responseTooLargeError(requestId);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AiPlatformClientError) throw error;
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text, { strict = false, requestId = null } = {}) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!strict) return null;
    throw new AiPlatformClientError("AI platform returned invalid JSON", {
      code: "invalid_response",
      status: 502,
      requestId,
      retryable: false,
      cause: error,
    });
  }
}

function responseStatus(response, requestId = null) {
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new AiPlatformClientError("AI platform returned an invalid response", {
      code: "invalid_response",
      status: 502,
      requestId,
      retryable: false,
    });
  }
  return status;
}

function redirectedResponseError(requestId) {
  return new AiPlatformClientError("AI platform redirected the request", {
    code: "redirect_not_allowed",
    status: 502,
    requestId,
    retryable: false,
  });
}

function errorFromResponse(response, payload, requestId) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) && payload.error && typeof payload.error === "object"
    ? payload.error
    : null;
  const status = responseStatus(response, requestId);
  const code = typeof source?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/u.test(source.code)
    ? source.code
    : `http_${status}`;
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return new AiPlatformClientError(
    status >= 500
      ? "AI platform is unavailable"
      : (typeof source?.message === "string" && source.message ? source.message : "AI platform request rejected"),
    {
      code,
      status,
      requestId,
      details: source?.details ?? null,
      retryable,
    },
  );
}

function unwrapItem(payload) {
  if (payload && typeof payload === "object" && Object.hasOwn(payload, "item")) return payload.item;
  return payload;
}

function isTimeoutLike(error) {
  return error?.name === "TimeoutError" || error?.code === "ETIMEDOUT" || error?.code === "UND_ERR_CONNECT_TIMEOUT";
}

function isAbortLike(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function timeoutClientError(requestId, cause) {
  return new AiPlatformClientError("AI platform request timed out", {
    code: "ai_platform_timeout",
    status: 504,
    requestId,
    retryable: true,
    cause,
  });
}

function abortedClientError(requestId, cause) {
  return new AiPlatformClientError("AI platform request was aborted", {
    code: "ai_platform_aborted",
    status: 499,
    requestId,
    retryable: false,
    aborted: true,
    cause,
  });
}

function networkClientError(requestId, cause) {
  return new AiPlatformClientError("AI platform network request failed", {
    code: "ai_platform_network_error",
    status: 502,
    requestId,
    retryable: true,
    cause,
  });
}

function tokenProviderClientError(requestId, cause) {
  return new AiPlatformClientError("AI platform token provider failed", {
    code: "token_provider_error",
    status: 502,
    requestId,
    retryable: true,
    cause,
  });
}

function buildUrl(root, prefix, path, query = null) {
  validatePath(path);
  const url = new URL(`${root}${prefix}${path}`);
  if (query) {
    const queryString = query.toString();
    url.search = queryString ? `?${queryString}` : "";
  }
  url.hash = "";
  return url.href;
}

function sleepWithSignal(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  assertAbortSignal(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(onTimer, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    function onTimer() {
      finish(resolve);
    }
    function onAbort() {
      finish(reject, abortReason(signal));
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function createAiPlatformClient({
  baseUrl,
  token,
  tokenProvider = null,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseLimitBytes = DEFAULT_RESPONSE_LIMIT,
  apiPrefix = "/internal/ai/v1",
  requestIdFactory = () => randomUUID(),
} = {}) {
  const root = normalizeBaseUrl(baseUrl);
  const prefix = normalizeApiPrefix(apiPrefix);
  const timeout = normalizeInteger(timeoutMs, "timeoutMs", { defaultValue: DEFAULT_TIMEOUT_MS, min: 1, max: MAX_TIMEOUT_MS });
  const responseLimit = normalizeInteger(responseLimitBytes, "responseLimitBytes", { defaultValue: DEFAULT_RESPONSE_LIMIT, min: 1, max: MAX_RESPONSE_BYTES });
  if (typeof fetchImpl !== "function") throw invalidArgument("fetchImpl is required");
  if (token !== undefined && token !== null) optionalHeaderToken(token);
  if (tokenProvider !== null && typeof tokenProvider !== "function") throw invalidArgument("tokenProvider must be a function");
  if (typeof requestIdFactory !== "function") throw invalidArgument("requestIdFactory must be a function");

  function requestId() {
    return safeHeaderValue(requestIdFactory(), "requestId", MAX_REQUEST_ID_LENGTH);
  }

  async function performRequest(method, path, {
    body = undefined,
    binaryBody = undefined,
    idempotencyKey = null,
    signal = null,
    query = null,
    authenticate = true,
    includeApiPrefix = true,
    timeoutOverride = timeout,
  } = {}) {
    assertAbortSignal(signal);
    const normalizedPath = validatePath(path);
    const url = includeApiPrefix
      ? buildUrl(root, prefix, normalizedPath, query)
      : buildUrl(root, "", normalizedPath, query);
    const requestIdentifier = requestId();
    let bodyText = binaryBody;
    if (binaryBody !== undefined && (!Buffer.isBuffer(binaryBody) || body !== undefined)) throw invalidArgument("invalid binary media body");
    if (body !== undefined) {
      try {
        bodyText = JSON.stringify(body);
      } catch (error) {
        throw invalidArgument(`AI platform request body is not JSON serializable: ${error.message}`);
      }
      if (bodyText === undefined) throw invalidArgument("AI platform request body is not JSON serializable");
    }
    let normalizedIdempotencyKey = null;
    if (idempotencyKey !== null && idempotencyKey !== undefined) {
      normalizedIdempotencyKey = idempotencyKeyValue(idempotencyKey);
    }
    const requestTimeout = normalizeInteger(timeoutOverride, "timeoutMs", { defaultValue: timeout, min: 1, max: MAX_TIMEOUT_MS });
    const abortContext = combineSignals(signal, requestTimeout);
    let tokenPhase = false;
    try {
      let providedToken = token;
      if (authenticate && tokenProvider) {
        tokenPhase = true;
        const providerResult = tokenProvider({
          method,
          path: `${normalizedPath}${query && query.toString() ? `?${query.toString()}` : ""}`,
          requestId: requestIdentifier,
          requestBinding: createRequestBinding({
            method,
            path: new URL(url).pathname + new URL(url).search,
            body: bodyText ?? "",
            idempotencyKey: normalizedIdempotencyKey,
          }),
          signal: abortContext.signal,
        });
        providedToken = optionalHeaderToken(await awaitWithSignal(providerResult, abortContext.signal));
        tokenPhase = false;
      }
      if (abortContext.signal.aborted) throw abortReason(abortContext.signal);

      const headers = {
        Accept: "application/json",
        "X-Request-Id": requestIdentifier,
      };
      if (bodyText !== undefined) headers["Content-Type"] = binaryBody === undefined ? "application/json" : "application/octet-stream";
      if (normalizedIdempotencyKey !== null) headers["Idempotency-Key"] = normalizedIdempotencyKey;
      if (authenticate) {
        const normalizedToken = tokenProvider ? providedToken : optionalHeaderToken(providedToken);
        if (normalizedToken) headers.Authorization = `Bearer ${normalizedToken}`;
      }

      const response = await awaitWithSignal(fetchImpl(url, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
        redirect: "error",
        signal: abortContext.signal,
      }), abortContext.signal);
      if (!response || typeof response !== "object") {
        throw new AiPlatformClientError("AI platform returned an invalid response", {
          code: "invalid_response",
          status: 502,
          requestId: requestIdentifier,
          retryable: false,
        });
      }
      const responseId = responseRequestId(response, requestIdentifier);
      const status = responseStatus(response, responseId);
      if (response.redirected === true) throw redirectedResponseError(responseId);
      const text = await readBoundedText(response, responseLimit, {
        signal: abortContext.signal,
        requestId: responseId,
      });
      const payload = parseJson(text, { strict: status >= 200 && status < 300, requestId: responseId });
      const ok = status >= 200 && status < 300 && (response.ok === undefined || response.ok === true);
      if (!ok) throw errorFromResponse(response, payload, responseId);
      return { payload, requestId: responseId, status };
    } catch (error) {
      if (error instanceof AiPlatformClientError) throw error;
      if (abortContext.reasonKind === "timeout" || (!signal?.aborted && isTimeoutLike(error))) {
        throw timeoutClientError(requestIdentifier, error);
      }
      if (abortContext.reasonKind === "external" || signal?.aborted || isAbortLike(error)) {
        throw abortedClientError(requestIdentifier, error);
      }
      if (tokenPhase) {
        if (error?.aiPlatformKind === "invalid_token") throw error;
        throw tokenProviderClientError(requestIdentifier, error);
      }
      throw networkClientError(requestIdentifier, error);
    } finally {
      abortContext.cleanup();
    }
  }

  async function createTask({ request = {}, idempotencyKey, signal = null } = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw invalidArgument("request must be an object");
    }
    const response = await performRequest("POST", "/tasks", {
      body: request,
      idempotencyKey,
      signal,
    });
    return unwrapItem(response.payload);
  }

  async function uploadMedia({ bytes, mediaType, sha256, signal = null }) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32 * 1024 * 1024
      || !["image/png", "image/jpeg", "image/webp", "application/pdf", "audio/wav"].includes(mediaType)
      || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw invalidArgument("invalid media upload");
    const query = new URLSearchParams({ mediaType, sha256 });
    const response = await performRequest("POST", "/media", { binaryBody: bytes, query, signal });
    return unwrapItem(response.payload);
  }

  async function discardMedia(id, { signal = null } = {}) {
    const response = await performRequest("DELETE", `/media/${encodeIdPath(id, "mediaId")}`, { signal });
    return unwrapItem(response.payload);
  }

  async function getTask(taskId, { signal = null } = {}) {
    const response = await performRequest("GET", `/tasks/${encodeIdPath(taskId, "taskId")}`, { signal });
    return unwrapItem(response.payload);
  }

  async function getResult(taskId, { signal = null } = {}) {
    const response = await performRequest("GET", `/tasks/${encodeIdPath(taskId, "taskId")}/result`, { signal });
    return unwrapItem(response.payload);
  }

  async function cancelTask(taskId, { signal = null } = {}) {
    const response = await performRequest("POST", `/tasks/${encodeIdPath(taskId, "taskId")}/cancel`, { signal });
    return unwrapItem(response.payload);
  }

  async function listTasks({ limit = 50, offset = 0, status = null, feature = null, signal = null } = {}) {
    const query = new URLSearchParams();
    query.set("limit", String(normalizeInteger(limit, "limit", { defaultValue: 50, min: 1, max: 200 })));
    query.set("offset", String(normalizeInteger(offset, "offset", { defaultValue: 0, min: 0, max: 100_000 })));
    const normalizedStatus = normalizeQueryValue(status, "status", 40);
    const normalizedFeature = normalizeQueryValue(feature, "feature", 128);
    if (normalizedStatus !== null) query.set("status", normalizedStatus);
    if (normalizedFeature !== null) query.set("feature", normalizedFeature);
    const response = await performRequest("GET", "/tasks", { signal, query });
    return response.payload;
  }

  async function waitForTask(taskId, { maxWaitMs = timeout, pollMs = 250, signal = null } = {}) {
    const normalizedTaskId = boundedId(taskId, "taskId");
    const maxWait = normalizeInteger(maxWaitMs, "maxWaitMs", { defaultValue: timeout, min: 0, max: MAX_WAIT_MS });
    const poll = normalizeInteger(pollMs, "pollMs", { defaultValue: 250, min: 1, max: MAX_POLL_MS });
    assertAbortSignal(signal);
    const startedAt = Date.now();
    const deadline = startedAt + maxWait;
    let lastTask = null;

    while (true) {
      if (signal?.aborted) throw abortedClientError(null, abortReason(signal));
      const remainingBeforeRequest = Math.max(0, deadline - Date.now());
      const requestTimeout = maxWait === 0 ? timeout : Math.max(1, Math.min(timeout, remainingBeforeRequest));
      try {
        lastTask = await performRequest("GET", `/tasks/${encodeIdPath(normalizedTaskId, "taskId")}`, {
          signal,
          timeoutOverride: requestTimeout,
        }).then((response) => unwrapItem(response.payload));
      } catch (error) {
        if (lastTask && error instanceof AiPlatformClientError && error.code === "ai_platform_timeout" && Date.now() >= deadline) {
          return lastTask;
        }
        throw error;
      }
      if (TERMINAL_STATUSES.has(lastTask?.status) || maxWait === 0 || Date.now() >= deadline) return lastTask;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return lastTask;
      try {
        await sleepWithSignal(Math.min(poll, remaining), signal);
      } catch (error) {
        if (signal?.aborted) throw abortedClientError(null, error);
        throw error;
      }
    }
  }

  async function runTask({ request: taskRequest = {}, idempotencyKey, maxWaitMs = 0, pollMs = 250, signal = null } = {}) {
    const normalizedMaxWait = normalizeInteger(maxWaitMs, "maxWaitMs", { defaultValue: 0, min: 0, max: MAX_WAIT_MS });
    if (normalizedMaxWait > 0) normalizeInteger(pollMs, "pollMs", { defaultValue: 250, min: 1, max: MAX_POLL_MS });
    const created = await createTask({ request: taskRequest, idempotencyKey, signal });
    if (!created?.taskId || normalizedMaxWait === 0) return created;
    const task = await waitForTask(created.taskId, { maxWaitMs: normalizedMaxWait, pollMs, signal });
    if (TERMINAL_STATUSES.has(task?.status)) {
      try {
        return {
          ...created,
          task,
          result: task.status === "succeeded" ? await getResult(created.taskId, { signal }) : null,
        };
      } catch (error) {
        if (error instanceof AiPlatformClientError && error.code === "result_not_ready") return { ...created, task };
        throw error;
      }
    }
    return { ...created, task };
  }

  async function health({ signal = null } = {}) {
    const response = await performRequest("GET", "/healthz", {
      signal,
      authenticate: false,
      includeApiPrefix: false,
    });
    return response.payload;
  }

  return Object.freeze({
    createTask,
    uploadMedia,
    discardMedia,
    getTask,
    getResult,
    cancelTask,
    listTasks,
    waitForTask,
    runTask,
    health,
  });
}
