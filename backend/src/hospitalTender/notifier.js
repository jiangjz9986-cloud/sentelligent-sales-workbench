import { TextDecoder } from "node:util";

const DEFAULT_ENDPOINT = "https://www.pushplus.plus/send";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 20_000;
const MAX_NOTICES_PER_REQUEST = 100;
const MAX_BATCH_NOTICES = 500;
const CONTENT_HEADER_RESERVE = 512;

function safeText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function safeMarkdown(value, max) {
  return safeText(value, max).replace(/([\\[\]()*_`~>#|{}.!+<>=-])/gu, "\\$1");
}

function safeHttpUrl(value) {
  const raw = safeText(value, 500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function noticeLine(notice) {
  const title = safeMarkdown(notice.title, 240) || "未命名公告";
  const source = safeMarkdown(notice.sourceName, 120) || "公开来源";
  const published = safeMarkdown(notice.publishedAt, 64) || "待确认时间";
  const url = safeHttpUrl(notice.url);
  return `- **${title}**\n  来源：${source} · 发布：${published}${url ? ` · [查看原文](<${url}>)` : ""}`;
}

function chunkLines(lines) {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    const candidateLength = [...current, line].join("\n").length;
    if (
      current.length > 0
      && (current.length >= MAX_NOTICES_PER_REQUEST
        || candidateLength > MAX_CONTENT_CHARS - CONTENT_HEADER_RESERVE)
    ) {
      chunks.push(current);
      current = [];
    }
    if (line.length > MAX_CONTENT_CHARS - CONTENT_HEADER_RESERVE) {
      throw new Error("notification content too large");
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkContent({ cycleNumber, batchCustomerIds, lines, chunkIndex, chunkCount, totalCount }) {
  const content = [
    `第 ${Number.isSafeInteger(cycleNumber) ? cycleNumber : 0} 轮医院招标监测（${chunkIndex + 1}/${chunkCount}）`,
    `本批 ${Array.isArray(batchCustomerIds) ? batchCustomerIds.length : 0} 家客户新增 ${totalCount} 条高相关公告，本消息 ${lines.length} 条。`,
    "",
    ...lines,
  ].join("\n");
  if (content.length > MAX_CONTENT_CHARS) throw new Error("notification content too large");
  return content;
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

/** Backend-only PushPlus notifier for aggregated high-relevance batches. */
export function createHospitalTenderNotifier({
  token = "",
  tokenProvider = null,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onSuccess = null,
  onFailure = null,
} = {}) {
  const normalizedToken = safeText(token, 512);
  if (tokenProvider !== null && typeof tokenProvider !== "function") {
    throw new TypeError("tokenProvider must be a function");
  }
  if (!normalizedToken && tokenProvider === null) return null;
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

  return async function notify({ cycleNumber = 0, batchCustomerIds = [], notices = [] } = {}) {
    if (!Array.isArray(notices) || notices.length === 0) return 0;
    if (notices.length > MAX_BATCH_NOTICES) throw new Error("notification batch too large");
    const chunks = chunkLines(notices.map(noticeLine));
    let currentToken;
    try {
      currentToken = safeText(
        tokenProvider === null ? normalizedToken : tokenProvider(),
        512,
      );
    } catch {
      currentToken = "";
    }
    if (!currentToken) {
      const error = new Error("notification unavailable");
      try { onFailure?.({ errorCode: error.message, count: notices.length, chunkCount: chunks.length }); } catch {}
      throw error;
    }

    try {
      for (const [chunkIndex, lines] of chunks.entries()) {
        const content = chunkContent({
          cycleNumber,
          batchCustomerIds,
          lines,
          chunkIndex,
          chunkCount: chunks.length,
          totalCount: notices.length,
        });
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
                title: `医院招标监测：新增 ${notices.length} 条（${chunkIndex + 1}/${chunks.length}）`,
                content,
                template: "markdown",
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
      }
    } catch (error) {
      try {
        onFailure?.({
          errorCode: error?.message || "notification_failed",
          count: notices.length,
          chunkCount: chunks.length,
        });
      } catch {}
      throw error;
    }
    try {
      onSuccess?.({ count: notices.length, chunkCount: chunks.length });
    } catch {}
    // Chunks are deliberately at-least-once. If a later chunk fails, the
    // scheduler retains the batch and retries every chunk on the next tick.
    return notices.length;
  };
}

export { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES };
