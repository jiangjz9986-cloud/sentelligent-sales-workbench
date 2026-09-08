const OUTBOX_PATH = "/api/integrations/weixin-agent/confirmation-outbox";
// v0.9.3 协议 v2：多绑定就绪哨兵 multi:v1 与既有单绑定哈希 scope 并存（升级窗口）。
const DELIVERY_SCOPE_RE = /^weixin:(?:shortcut:v1:[0-9a-f]{64}|multi:v1)$/u;

function normalizeBackendUrl(value) {
  const normalized = String(value ?? "").trim().replace(/\/+$/u, "");
  if (!normalized) throw new TypeError("backendUrl is required");
  const url = new URL(normalized);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TypeError("backendUrl is invalid");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/gu, ""))) throw new TypeError("HTTPS is required for a non-loopback backend");
  return normalized;
}
function boundedText(value, name, max = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${name} is invalid`);
  return value;
}

async function jsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error("invalid_json"); }
}

export function createWeixinOutboxHttpClient({ backendUrl, apiToken, fetchImpl = fetch, workerId = "weixin-worker" } = {}) {
  const base = normalizeBackendUrl(backendUrl);
  const token = boundedText(String(apiToken ?? "").trim(), "apiToken", 500);
  const id = boundedText(String(workerId ?? "weixin-worker").trim(), "workerId", 200);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const headers = (delivery = null) => {
    const values = {
      Authorization: `Bearer ${token}`,
      "X-Weixin-Worker-Id": id,
    };
    if (delivery?.status === "ready" || delivery?.status === "not_ready") {
      values["X-Weixin-Delivery-Status"] = delivery.status;
      const reason = typeof delivery.reason === "string"
        ? delivery.reason.trim().toLowerCase()
        : "";
      if (/^[a-z0-9_]{1,64}$/u.test(reason)) values["X-Weixin-Delivery-Reason"] = reason;
      const deliveryScope = typeof delivery.deliveryScope === "string"
        ? delivery.deliveryScope.trim()
        : "";
      if (DELIVERY_SCOPE_RE.test(deliveryScope)) {
        values["X-Weixin-Delivery-Scope"] = deliveryScope;
      }
      const expiresAt = safeExpiresAt(delivery.expiresAt);
      if (expiresAt) values["X-Weixin-Delivery-Expires-At"] = expiresAt;
    }
    return values;
  };

  return Object.freeze({
    async lease(delivery = null) {
      const response = await fetchImpl(`${base}${OUTBOX_PATH}`, { method: "GET", headers: headers(delivery) });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error("outbox_lease_failed");
      const body = await jsonResponse(response);
      const item = body?.item;
      if (!item || typeof body.leaseToken !== "string") throw new Error("outbox_lease_invalid");
      try {
        return {
          item: {
            id: boundedText(item.id, "outbox id", 200),
            owner: boundedText(item.owner, "outbox owner", 200),
            conversationId: boundedText(item.conversationId, "outbox conversation", 300),
            deliveryScope: boundedText(item.deliveryScope, "outbox delivery scope", 300),
            // v0.9.3 additive：多目标投递的明文目标；缺失时由 authorizeDelivery
            // fail-closed（旧后端不发该字段 → 二次校验不通过 → 终态判废）。
            ...(typeof item.targetSenderId === "string" && item.targetSenderId.trim()
              ? { targetSenderId: boundedText(item.targetSenderId, "outbox target sender", 200) }
              : {}),
            message: boundedText(item.message, "outbox message", 20_000),
          },
          leaseToken: boundedText(body.leaseToken, "leaseToken", 200),
        };
      } catch {
        throw new Error("outbox_lease_invalid");
      }
    },
    async ack({ id: itemId, leaseToken, ok, providerMessageId = null, errorCode = null, terminal = false } = {}) {
      const response = await fetchImpl(`${base}${OUTBOX_PATH}`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, leaseToken, ok, ...(terminal === true ? { terminal: true } : {}), ...(providerMessageId ? { providerMessageId } : {}), ...(errorCode ? { errorCode } : {}) }),
      });
      if (!response.ok) throw new Error("outbox_ack_failed");
      return jsonResponse(response);
    },
    async isCurrent({ id: itemId, leaseToken } = {}) {
      const response = await fetchImpl(`${base}${OUTBOX_PATH}`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, leaseToken, check: true }),
      });
      if (!response.ok) throw new Error("outbox_lease_check_failed");
      const body = await jsonResponse(response);
      if (typeof body?.current !== "boolean") throw new Error("outbox_lease_check_invalid");
      return body.current;
    },
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function safeExpiresAt(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === normalized ? canonical : null;
}

export async function runWeixinOutboxPump({
  client,
  bot,
  authorizeDelivery,
  pollMs = 5_000,
  sendDelayMs = 1_000,
  abortSignal,
  log = () => {},
  sleepImpl = sleep,
} = {}) {
  if (!client || typeof client.lease !== "function" || typeof client.ack !== "function" || typeof client.isCurrent !== "function") {
    throw new TypeError("client is required");
  }
  if (!bot || typeof bot.sendMessage !== "function") throw new TypeError("bot is required");
  if (authorizeDelivery !== undefined && typeof authorizeDelivery !== "function") throw new TypeError("authorizeDelivery must be a function");
  if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60_000) throw new TypeError("pollMs is invalid");
  if (!Number.isSafeInteger(sendDelayMs) || sendDelayMs < 0 || sendDelayMs > 60_000) throw new TypeError("sendDelayMs is invalid");
  if (typeof sleepImpl !== "function") throw new TypeError("sleepImpl must be a function");
  let lastReadiness = "";
  while (!abortSignal?.aborted) {
    let lease = null;
    try {
      let delivery = { ready: false, status: "not_ready", reason: "sdk_status_unavailable" };
      if (typeof bot.getDeliveryStatus === "function") {
        try {
          const candidate = bot.getDeliveryStatus();
          const deliveryScope = DELIVERY_SCOPE_RE.test(String(candidate?.deliveryScope ?? ""))
            ? String(candidate.deliveryScope)
            : null;
          const expiresAt = safeExpiresAt(candidate?.expiresAt);
          delivery = candidate?.ready === true && candidate?.status === "ready"
            ? { ready: true, status: "ready", ...(deliveryScope ? { deliveryScope } : {}), ...(expiresAt ? { expiresAt } : {}) }
            : {
                ready: false,
                status: "not_ready",
                reason: /^[a-z0-9_]{1,64}$/u.test(String(candidate?.reason ?? ""))
                  ? String(candidate.reason)
                  : "sdk_status_unavailable",
                ...(deliveryScope ? { deliveryScope } : {}),
                ...(expiresAt ? { expiresAt } : {}),
              };
        } catch {
          delivery = { ready: false, status: "not_ready", reason: "sdk_status_unavailable" };
        }
      }
      const readinessKey = `${delivery.status}:${delivery.reason ?? ""}:${delivery.expiresAt ?? ""}`;
      if (readinessKey !== lastReadiness) {
        log(`[weixin] category=outbox status=${delivery.status} reason=${delivery.reason ?? "available"}${delivery.expiresAt ? ` expiresAt=${delivery.expiresAt}` : ""}`);
        lastReadiness = readinessKey;
      }
      lease = await client.lease(delivery);
      if (!lease) {
        await sleep(pollMs, abortSignal);
        continue;
      }
      if (!delivery.ready) {
        // A rolling-upgrade peer may ignore the readiness header and still
        // return a lease. Do not acknowledge it: letting the lease expire
        // preserves attempt_count until a delivery-capable worker is ready.
        log("[weixin] category=outbox status=unexpected_lease_while_not_ready");
        await sleep(pollMs, abortSignal);
        continue;
      }
      if (authorizeDelivery && authorizeDelivery(lease.item) !== true) {
        await client.ack({
          id: lease.item.id,
          leaseToken: lease.leaseToken,
          ok: false,
          terminal: true,
          errorCode: "WEIXIN_DELIVERY_SCOPE_MISMATCH",
        });
        continue;
      }
      if (!await client.isCurrent({ id: lease.item.id, leaseToken: lease.leaseToken })) {
        log("[weixin] category=outbox status=superseded_before_send");
        continue;
      }
      try {
        // 协议 v2：目标 sender 随租约明文下发，authorizeDelivery 已重算哈希核验。
        const sent = await bot.sendMessage(lease.item.message, lease.item.id, {
          targetSenderId: lease.item.targetSenderId,
        });
        const providerMessageId = typeof sent?.messageId === "string" && sent.messageId.trim()
          ? sent.messageId.trim().slice(0, 200)
          : null;
        await client.ack({
          id: lease.item.id,
          leaseToken: lease.leaseToken,
          ok: true,
          ...(providerMessageId ? { providerMessageId } : {}),
        });
        // A recovered context can release a backlog in one tight loop.  Keep a
        // small provider-facing gap so queued messages do not become a burst or
        // trip short-window throttles after the first inbound activation.
        if (sendDelayMs > 0 && !abortSignal?.aborted) await sleepImpl(sendDelayMs, abortSignal);
      } catch (error) {
        const terminalScopeFailure = [
          "WEIXIN_DELIVERY_SCOPE_MISMATCH",
          "WEIXIN_DELIVERY_TARGET_MISMATCH",
        ].includes(error?.code);
        const errorCode = terminalScopeFailure
          ? "WEIXIN_DELIVERY_SCOPE_MISMATCH"
          : error?.code === "WEIXIN_CONTEXT_NOT_READY"
            ? "WEIXIN_CONTEXT_NOT_READY"
            : "WEIXIN_SEND_FAILED";
        try {
          await client.ack({
            id: lease.item.id,
            leaseToken: lease.leaseToken,
            ok: false,
            ...(terminalScopeFailure ? { terminal: true } : {}),
            errorCode,
          });
        } catch { /* retry on next lease */ }
      }
    } catch {
      log("[weixin] category=outbox status=retryable_error");
      await sleep(pollMs, abortSignal);
    }
  }
}
