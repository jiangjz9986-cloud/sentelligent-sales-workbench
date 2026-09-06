// Backend-only PushPlus notifier for single ops alerts. It mirrors the
// hospitalTender notifier's HTTPS-only endpoint validation, request timeout,
// bounded response reading, and onSuccess/onFailure hooks, but sends exactly
// one plain-text message per call (no batch/chunk semantics).

import { TextDecoder } from "node:util";

const DEFAULT_ENDPOINT = "https://www.pushplus.plus/send";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 4_000;

function safeText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

async function readBoundedResponseText(response) {
  const rawLength = response?.headers?.get?.("content-length");
  if (rawLength !== null && rawLength !== undefined && rawLength !== "") {
    if (!/^\d+$/u.test(rawLength) || Number(rawLength) > MAX_RESPONSE_BYTES) {
      await response?.body?.cancel?.().catch(() => {});
      throw new Error("notification response invalid");
    }
  }
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error("notification response invalid");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("notification response invalid");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("notification response invalid");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error?.message === "notification response invalid") throw error;
    throw new Error("notification response invalid");
  }
}

export function createOpsAlertPushplusNotifier({
  tokenProvider,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onSuccess = null,
  onFailure = null,
} = {}) {
  if (typeof tokenProvider !== "function") throw new TypeError("tokenProvider must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof endpoint !== "string" || !/^https:\/\//u.test(endpoint)) {
    throw new TypeError("notifier endpoint must use HTTPS");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 1 and 60000");
  }
  if (onSuccess !== null && typeof onSuccess !== "function") {
    throw new TypeError("onSuccess must be a function");
  }
  if (onFailure !== null && typeof onFailure !== "function") {
    throw new TypeError("onFailure must be a function");
  }

  return async function notify({ title, content } = {}) {
    const normalizedTitle = safeText(title, MAX_TITLE_CHARS);
    const normalizedContent = safeText(content, MAX_CONTENT_CHARS);
    if (!normalizedTitle || !normalizedContent) throw new TypeError("ops alert notification content is required");
    let currentToken;
    try {
      currentToken = safeText(tokenProvider(), 512);
    } catch {
      currentToken = "";
    }
    if (!currentToken) {
      const error = new Error("notification unavailable");
      try { onFailure?.({ errorCode: error.message }); } catch {}
      throw error;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response;
      try {
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              token: currentToken,
              title: normalizedTitle,
              content: normalizedContent,
              template: "txt",
            }),
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          throw new Error("notification unavailable");
        }
        if (!response?.ok || response.redirected === true) throw new Error("notification rejected");
        const rawBody = await readBoundedResponseText(response);
        let body;
        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          throw new Error("notification response invalid");
        }
        if (body?.code !== undefined && String(body.code) !== "200") {
          throw new Error("notification rejected");
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      try { onFailure?.({ errorCode: error?.message || "notification_failed" }); } catch {}
      throw error;
    }
    try { onSuccess?.({ count: 1, chunkCount: 1 }); } catch {}
    return 1;
  };
}

export { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES };
