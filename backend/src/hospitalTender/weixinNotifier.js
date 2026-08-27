import { createHash } from "node:crypto";

const MAX_BATCH_NOTICES = 500;
const MAX_NOTICES_PER_MESSAGE = 20;
const MAX_MESSAGE_CHARS = 3500;
const HEADER_RESERVE = 160;

function safeText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
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

/** Plain-text WeChat line for one high-relevance notice (no markdown). */
export function hospitalTenderNoticeLine(notice) {
  const title = safeText(notice?.title, 240) || "未命名公告";
  const source = safeText(notice?.sourceName, 120) || "公开来源";
  const published = safeText(notice?.publishedAt, 64) || "待确认时间";
  const url = safeHttpUrl(notice?.url);
  return `· ${title}\n  ${source} · ${published}${url ? `\n  ${url}` : ""}`;
}

function chunkNoticeLines(lines) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const line of lines) {
    if (line.length > MAX_MESSAGE_CHARS - HEADER_RESERVE) {
      throw new Error("notification content too large");
    }
    if (
      current.length > 0
      && (current.length >= MAX_NOTICES_PER_MESSAGE
        || currentLength + line.length + 1 > MAX_MESSAGE_CHARS - HEADER_RESERVE)
    ) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Deterministic WeChat message body for a queued hospital-tender outbox
 * payload. Fails closed on malformed payloads so the delivery worker never
 * sends an empty or unbounded message.
 */
export function renderHospitalTenderNoticeMessage(payload) {
  if (!payload || typeof payload !== "object" || payload.kind !== "hospital_tender_notice") {
    throw new TypeError("hospital tender notice payload is invalid");
  }
  const cycleNumber = Number.isSafeInteger(payload.cycleNumber) && payload.cycleNumber > 0 ? payload.cycleNumber : 0;
  const chunkIndex = Number.isSafeInteger(payload.chunkIndex) && payload.chunkIndex >= 0 ? payload.chunkIndex : 0;
  const chunkCount = Number.isSafeInteger(payload.chunkCount) && payload.chunkCount > 0 ? payload.chunkCount : 1;
  const totalCount = Number.isSafeInteger(payload.totalCount) && payload.totalCount >= 0 ? payload.totalCount : 0;
  const batchCustomerCount = Number.isSafeInteger(payload.batchCustomerCount) && payload.batchCustomerCount >= 0
    ? payload.batchCustomerCount
    : 0;
  const lines = Array.isArray(payload.lines)
    ? payload.lines
      .filter((line) => typeof line === "string" && line.trim())
      .slice(0, MAX_NOTICES_PER_MESSAGE)
      .map((line) => line.slice(0, MAX_MESSAGE_CHARS - HEADER_RESERVE))
    : [];
  if (lines.length === 0) throw new Error("hospital tender notice payload is empty");
  const message = [
    `【小小监测】医院招标新公告（第 ${cycleNumber} 轮 ${chunkIndex + 1}/${chunkCount}）`,
    `本批 ${batchCustomerCount} 家客户新增 ${totalCount} 条高相关公告，本条消息 ${lines.length} 条：`,
    "",
    ...lines,
  ].join("\n");
  if (message.length > MAX_MESSAGE_CHARS + HEADER_RESERVE) {
    throw new Error("notification content too large");
  }
  return message;
}

/**
 * WeChat notifier for aggregated high-relevance hospital-tender batches. It
 * enqueues plain-text chunks into the existing WeChat confirmation outbox so
 * the single delivery worker pushes them to the bound private chat. Chunk
 * idempotency keys are stable per cycle/content, so scheduler retries after a
 * partial failure replay instead of duplicating messages.
 */
export function createHospitalTenderWeixinNotifier({
  outboxRepository,
  resolveOwner,
  resolveConversationId,
  onSuccess = null,
  onFailure = null,
} = {}) {
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository with enqueue is required");
  }
  if (typeof resolveOwner !== "function") throw new TypeError("resolveOwner must be a function");
  if (typeof resolveConversationId !== "function") throw new TypeError("resolveConversationId must be a function");
  if (onSuccess !== null && typeof onSuccess !== "function") throw new TypeError("onSuccess must be a function");
  if (onFailure !== null && typeof onFailure !== "function") throw new TypeError("onFailure must be a function");

  return async function notify({ cycleNumber = 0, batchCustomerIds = [], notices = [] } = {}) {
    if (!Array.isArray(notices) || notices.length === 0) return 0;
    if (notices.length > MAX_BATCH_NOTICES) throw new Error("notification batch too large");
    let owner = "";
    let conversationId = "";
    try {
      owner = safeText(resolveOwner(), 200);
      conversationId = safeText(resolveConversationId(), 300);
    } catch {
      owner = "";
      conversationId = "";
    }
    const chunks = chunkNoticeLines(notices.map(hospitalTenderNoticeLine));
    if (!owner || !conversationId) {
      const error = new Error("notification unavailable");
      try { onFailure?.({ errorCode: error.message, count: notices.length, chunkCount: chunks.length }); } catch {}
      throw error;
    }
    const safeCycleNumber = Number.isSafeInteger(cycleNumber) && cycleNumber > 0 ? cycleNumber : 0;
    const batchCustomerCount = Array.isArray(batchCustomerIds) ? batchCustomerIds.length : 0;
    try {
      for (const [chunkIndex, lines] of chunks.entries()) {
        const payload = {
          kind: "hospital_tender_notice",
          cycleNumber: safeCycleNumber,
          chunkIndex,
          chunkCount: chunks.length,
          totalCount: notices.length,
          batchCustomerCount,
          lines,
        };
        renderHospitalTenderNoticeMessage(payload);
        const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
        outboxRepository.enqueue({
          owner,
          conversationId,
          idempotencyKey: `hospital-tender:cycle:${safeCycleNumber}:chunk:${chunkIndex}:${digest}`,
          payload,
        });
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
    try { onSuccess?.({ count: notices.length, chunkCount: chunks.length }); } catch {}
    return notices.length;
  };
}

export { MAX_NOTICES_PER_MESSAGE, MAX_MESSAGE_CHARS };
