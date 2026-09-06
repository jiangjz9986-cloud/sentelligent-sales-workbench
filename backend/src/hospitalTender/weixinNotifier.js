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
 * the single delivery worker pushes them to each bound private chat. Chunk
 * idempotency keys are stable per owner/cycle/content, so scheduler retries
 * after a partial failure replay instead of duplicating messages.
 *
 * v0.9.3 多播：公告按匹配客户的 owner 分组（一公告可入多组，组内去重）；
 * 无路由组（客户 owner 无 active∧digest 绑定）→ 全部投 digest-enabled 的 admin
 * 绑定 → 再无 → PushPlus 兜底 → 再无 → 审计 unrouted 计数后视为已处理，保持
 * `notified === newHighNotices.length` 的调度器重试契约。
 */
export function createHospitalTenderWeixinNotifier({
  outboxRepository,
  resolveDigestDeliveries,
  resolveAdminDeliveries,
  resolveCustomerOwners,
  pushplusNotify = null,
  recordUnrouted = null,
  onSuccess = null,
  onFailure = null,
} = {}) {
  if (!outboxRepository || typeof outboxRepository.enqueue !== "function") {
    throw new TypeError("outboxRepository with enqueue is required");
  }
  if (typeof resolveDigestDeliveries !== "function") throw new TypeError("resolveDigestDeliveries must be a function");
  if (typeof resolveAdminDeliveries !== "function") throw new TypeError("resolveAdminDeliveries must be a function");
  if (typeof resolveCustomerOwners !== "function") throw new TypeError("resolveCustomerOwners must be a function");
  if (pushplusNotify !== null && typeof pushplusNotify !== "function") throw new TypeError("pushplusNotify must be a function");
  if (recordUnrouted !== null && typeof recordUnrouted !== "function") throw new TypeError("recordUnrouted must be a function");
  if (onSuccess !== null && typeof onSuccess !== "function") throw new TypeError("onSuccess must be a function");
  if (onFailure !== null && typeof onFailure !== "function") throw new TypeError("onFailure must be a function");

  function normalizeDeliveries(targets) {
    const byOwner = new Map();
    for (const target of targets ?? []) {
      const owner = safeText(target?.account ?? target?.owner, 200);
      const conversationId = safeText(target?.conversationId, 300);
      if (owner && conversationId && !byOwner.has(owner)) {
        byOwner.set(owner, { owner, conversationId });
      }
    }
    return byOwner;
  }

  return async function notify({ cycleNumber = 0, batchCustomerIds = [], notices = [] } = {}) {
    if (!Array.isArray(notices) || notices.length === 0) return 0;
    if (notices.length > MAX_BATCH_NOTICES) throw new Error("notification batch too large");
    const safeCycleNumber = Number.isSafeInteger(cycleNumber) && cycleNumber > 0 ? cycleNumber : 0;
    const batchCustomerCount = Array.isArray(batchCustomerIds) ? batchCustomerIds.length : 0;

    let digestTargets;
    let ownersByCustomer;
    try {
      digestTargets = normalizeDeliveries(resolveDigestDeliveries());
      const matchedIds = [...new Set(notices.flatMap((notice) => (
        Array.isArray(notice?.match?.matchedCustomerIds) ? notice.match.matchedCustomerIds : []
      )))];
      ownersByCustomer = resolveCustomerOwners(matchedIds) ?? new Map();
    } catch (error) {
      try { onFailure?.({ errorCode: error?.message || "notification_failed", count: notices.length, chunkCount: 0 }); } catch {}
      throw error;
    }

    // 按 owner 分组：一公告可入多组，组内以公告对象身份去重（Set 语义）。
    const groups = new Map();
    const unrouted = [];
    for (const notice of notices) {
      const matchedOwners = new Set(
        (Array.isArray(notice?.match?.matchedCustomerIds) ? notice.match.matchedCustomerIds : [])
          .map((customerId) => ownersByCustomer.get(customerId))
          .filter(Boolean),
      );
      const routableOwners = [...matchedOwners].filter((owner) => digestTargets.has(owner));
      if (routableOwners.length === 0) {
        unrouted.push(notice);
        continue;
      }
      for (const owner of routableOwners) {
        if (!groups.has(owner)) groups.set(owner, new Set());
        groups.get(owner).add(notice);
      }
    }

    if (unrouted.length > 0) {
      const adminTargets = normalizeDeliveries(resolveAdminDeliveries());
      if (adminTargets.size > 0) {
        for (const [owner, delivery] of adminTargets) {
          if (!groups.has(owner)) groups.set(owner, new Set());
          for (const notice of unrouted) groups.get(owner).add(notice);
          if (!digestTargets.has(owner)) digestTargets.set(owner, delivery);
        }
      } else if (pushplusNotify) {
        try {
          await pushplusNotify({ cycleNumber: safeCycleNumber, batchCustomerIds, notices: unrouted });
        } catch {
          // PushPlus 兜底失败：审计计数后视为已处理（公告数据仍在库，Web 可见）。
          try { recordUnrouted?.({ count: unrouted.length, cycleNumber: safeCycleNumber }); } catch {}
        }
      } else {
        try { recordUnrouted?.({ count: unrouted.length, cycleNumber: safeCycleNumber }); } catch {}
      }
    }

    let chunkTotal = 0;
    try {
      for (const [owner, groupNotices] of groups) {
        const delivery = digestTargets.get(owner);
        if (!delivery) continue;
        const groupList = [...groupNotices];
        const chunks = chunkNoticeLines(groupList.map(hospitalTenderNoticeLine));
        for (const [chunkIndex, lines] of chunks.entries()) {
          const payload = {
            kind: "hospital_tender_notice",
            cycleNumber: safeCycleNumber,
            chunkIndex,
            chunkCount: chunks.length,
            totalCount: groupList.length,
            batchCustomerCount,
            lines,
          };
          renderHospitalTenderNoticeMessage(payload);
          const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
          outboxRepository.enqueue({
            owner: delivery.owner,
            conversationId: delivery.conversationId,
            idempotencyKey: `hospital-tender:${delivery.owner}:cycle:${safeCycleNumber}:chunk:${chunkIndex}:${digest}`,
            payload,
          });
          chunkTotal += 1;
        }
      }
    } catch (error) {
      try {
        onFailure?.({
          errorCode: error?.message || "notification_failed",
          count: notices.length,
          chunkCount: chunkTotal,
        });
      } catch {}
      throw error;
    }
    try { onSuccess?.({ count: notices.length, chunkCount: chunkTotal }); } catch {}
    // 全部公告要么已入队、要么经 PushPlus/审计视为已处理 → 返回全量计数。
    return notices.length;
  };
}

export { MAX_NOTICES_PER_MESSAGE, MAX_MESSAGE_CHARS };
