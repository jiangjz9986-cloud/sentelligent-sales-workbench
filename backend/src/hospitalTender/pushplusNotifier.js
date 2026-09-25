import { createHash } from "node:crypto";
import { hospitalTenderNoticeLine, renderHospitalTenderNoticeMessage } from "./weixinNotifier.js";

const PUSHPLUS_SEND_URL = "https://www.pushplus.plus/send";
const PUSHPLUS_RESULT_URL = "https://www.pushplus.plus/api/open/message/sendMessageResult";
const MAX_CONTENT_CHARS = 3_500;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function chunksOf(lines) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    if (line.length > MAX_CONTENT_CHARS - 220) throw new Error("PUSHPLUS_NOTICE_LINE_TOO_LARGE");
    if (current.length && (current.length >= 20 || length + line.length + 1 > MAX_CONTENT_CHARS - 220)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function safeShortCode(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,200}$/u.test(candidate) ? candidate : null;
}

function validJsonResponse(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function createHospitalTenderPushplusNotifier({
  token,
  accessKey = "",
  tokenProvider = null,
  accessKeyProvider = null,
  deliveryRepository,
  fetchImpl = fetch,
  clock = () => new Date(),
  timeoutMs = 10_000,
} = {}) {
  if (tokenProvider !== null && typeof tokenProvider !== "function") throw new TypeError("tokenProvider must be a function");
  if (accessKeyProvider !== null && typeof accessKeyProvider !== "function") throw new TypeError("accessKeyProvider must be a function");
  const resolveToken = () => String((tokenProvider ? tokenProvider() : token) ?? "").trim();
  const resolveAccessKey = () => String((accessKeyProvider ? accessKeyProvider() : accessKey) ?? "").trim();
  if (!deliveryRepository?.enqueue || !deliveryRepository?.beginAttempt || !deliveryRepository?.setState) {
    throw new TypeError("PushPlus delivery repository is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new TypeError("timeoutMs is invalid");

  const timestamp = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
    return date.toISOString();
  };

  async function requestJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" });
      let body;
      try { body = await response.json(); } catch { body = null; }
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollPending() {
    const normalizedAccessKey = resolveAccessKey();
    if (!normalizedAccessKey || typeof deliveryRepository.dueResultChecks !== "function") return { checked: 0, sent: 0, failed: 0 };
    let checked = 0;
    let sent = 0;
    let failed = 0;
    for (const item of deliveryRepository.dueResultChecks({ limit: 30 })) {
      checked += 1;
      try {
        const url = new URL(PUSHPLUS_RESULT_URL);
        url.searchParams.set("shortCode", item.providerShortCode);
        const { response, body } = await requestJson(url, { method: "GET", headers: { "access-key": normalizedAccessKey } });
        if (!response.ok || !validJsonResponse(body) || body.code !== 200 || !validJsonResponse(body.data)) {
          deliveryRepository.deferResultCheck(item.id, { delayMs: 5 * 60_000, errorCode: "PUSHPLUS_RESULT_QUERY_FAILED" });
          continue;
        }
        const status = Number(body.data.status);
        if (status === 2) {
          deliveryRepository.setState(item.id, { status: "sent", shortCode: item.providerShortCode });
          sent += 1;
        } else if (status === 3) {
          deliveryRepository.setState(item.id, { status: "failed", shortCode: item.providerShortCode, errorCode: "PUSHPLUS_DELIVERY_FAILED" });
          failed += 1;
        } else {
          deliveryRepository.deferResultCheck(item.id, { delayMs: 60_000 });
        }
      } catch {
        deliveryRepository.deferResultCheck(item.id, { delayMs: 5 * 60_000, errorCode: "PUSHPLUS_RESULT_QUERY_FAILED" });
      }
    }
    return { checked, sent, failed };
  }

  async function notify({ cycleNumber = 0, batchCustomerIds = [], notices = [] } = {}) {
    const normalizedToken = resolveToken();
    const normalizedAccessKey = resolveAccessKey();
    if (!normalizedToken) throw new Error("PUSHPLUS_TOKEN_NOT_CONFIGURED");
    if (!Array.isArray(notices) || notices.length === 0) return 0;
    if (notices.length > 500) throw new Error("PUSHPLUS_NOTICE_BATCH_TOO_LARGE");
    await pollPending();
    const lines = notices.map(hospitalTenderNoticeLine);
    const chunks = chunksOf(lines);
    let acknowledged = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const content = renderHospitalTenderNoticeMessage({
        kind: "hospital_tender_notice",
        cycleNumber,
        chunkIndex: index,
        chunkCount: chunks.length,
        totalCount: notices.length,
        batchCustomerCount: Array.isArray(batchCustomerIds) ? batchCustomerIds.length : 0,
        lines: chunks[index],
      });
      const title = `医院招标监测新增 ${notices.length} 条公告`;
      const deliveryKey = sha256(`${cycleNumber}\n${index}\n${content}`);
      const { item } = deliveryRepository.enqueue({ deliveryKey, cycleNumber, title, content });
      if (item.status === "accepted" || item.status === "sent" || item.status === "uncertain") {
        acknowledged += chunks[index].length;
        continue;
      }
      if (item.status === "failed" && item.lastErrorCode === "PUSHPLUS_DELIVERY_FAILED") {
        throw new Error("PUSHPLUS_DELIVERY_FAILED");
      }

      const attempt = deliveryRepository.beginAttempt(item.id);
      if (attempt.status !== "submitting") {
        throw new Error("PUSHPLUS_DELIVERY_STATE_CONFLICT");
      }
      let result;
      try {
        result = await requestJson(PUSHPLUS_SEND_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: normalizedToken, title, content, template: "markdown", channel: "wechat" }),
        });
      } catch {
        deliveryRepository.setState(item.id, { status: "uncertain", errorCode: "PUSHPLUS_SUBMISSION_OUTCOME_UNKNOWN" });
        // Do not resubmit an ambiguous request: PushPlus may already have accepted it.
        acknowledged += chunks[index].length;
        continue;
      }
      const shortCode = safeShortCode(result.body?.data);
      if (!result.response.ok || !validJsonResponse(result.body) || result.body.code !== 200 || !shortCode) {
        const code = Number.isSafeInteger(result.body?.code) ? `PUSHPLUS_REJECTED_${result.body.code}` : "PUSHPLUS_REQUEST_REJECTED";
        deliveryRepository.setState(item.id, { status: "failed", errorCode: code });
        throw new Error("PUSHPLUS_REQUEST_REJECTED");
      }
      const nextCheckAt = new Date(Date.parse(timestamp()) + (normalizedAccessKey ? 30_000 : 86_400_000)).toISOString();
      deliveryRepository.setState(item.id, { status: "accepted", shortCode, nextCheckAt });
      acknowledged += chunks[index].length;
    }
    return acknowledged;
  }

  return Object.freeze({ notify, pollPending, statusCounts: () => deliveryRepository.statusCounts?.() ?? null });
}
