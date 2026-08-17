const DEFAULT_ENDPOINT = "https://www.pushplus.plus/send";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const MAX_CONTENT_CHARS = 20_000;

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

/** Backend-only PushPlus notifier for aggregated high-relevance batches. */
export function createHospitalTenderNotifier({
  token = "",
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedToken = safeText(token, 500);
  if (!normalizedToken) return null;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof endpoint !== "string" || !/^https:\/\//u.test(endpoint)) {
    throw new TypeError("notifier endpoint must use HTTPS");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 1 and 60000");
  }

  return async function notify({ cycleNumber = 0, batchCustomerIds = [], notices = [] } = {}) {
    if (!Array.isArray(notices) || notices.length === 0) return 0;
    if (notices.length > 100) throw new Error("notification content too large");
    const lines = [];
    for (const notice of notices) {
      const title = safeMarkdown(notice.title, 240) || "未命名公告";
      const source = safeMarkdown(notice.sourceName, 120) || "公开来源";
      const published = safeMarkdown(notice.publishedAt, 64) || "待确认时间";
      const url = safeHttpUrl(notice.url);
      const line = `- **${title}**\n  来源：${source} · 发布：${published}${url ? ` · [查看原文](<${url}>)` : ""}`;
      if (lines.length > 0 && [...lines, line].join("\n").length > MAX_CONTENT_CHARS) break;
      lines.push(line);
    }
    if (lines.length !== notices.length) throw new Error("notification content too large");
    const content = [
      `第 ${Number.isSafeInteger(cycleNumber) ? cycleNumber : 0} 轮医院招标监测`,
      `本批 ${Array.isArray(batchCustomerIds) ? batchCustomerIds.length : 0} 家客户新增 ${lines.length} 条高相关公告。`,
      "",
      ...lines,
    ].join("\n");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            token: normalizedToken,
            title: `医院招标监测：新增 ${lines.length} 条高相关公告`,
            content,
            template: "markdown",
          }),
          signal: controller.signal,
        });
      } catch {
        throw new Error("notification unavailable");
      }
      if (!response?.ok) throw new Error("notification rejected");
      let rawBody;
      try {
        rawBody = await response.text();
      } catch {
        throw new Error("notification response invalid");
      }
      if (typeof rawBody !== "string" || rawBody.length > MAX_RESPONSE_CHARS) {
        throw new Error("notification response invalid");
      }
      let body;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        throw new Error("notification response invalid");
      }
      if (body?.code !== undefined && String(body.code) !== "200") {
        throw new Error("notification rejected");
      }
      return lines.length;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_CHARS };
