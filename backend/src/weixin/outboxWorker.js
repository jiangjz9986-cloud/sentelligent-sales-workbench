const OUTBOX_PATH = "/api/integrations/weixin-agent/confirmation-outbox";

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
  const headers = () => ({
    Authorization: `Bearer ${token}`,
    "X-Weixin-Worker-Id": id,
  });

  return Object.freeze({
    async lease() {
      const response = await fetchImpl(`${base}${OUTBOX_PATH}`, { method: "GET", headers: headers() });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error("outbox_lease_failed");
      const body = await jsonResponse(response);
      const item = body?.item;
      if (!item || typeof item.id !== "string" || typeof item.message !== "string" || typeof body.leaseToken !== "string") throw new Error("outbox_lease_invalid");
      return { item: { id: item.id, owner: item.owner, conversationId: item.conversationId, message: item.message }, leaseToken: body.leaseToken };
    },
    async ack({ id: itemId, leaseToken, ok, providerMessageId = null, errorCode = null } = {}) {
      const response = await fetchImpl(`${base}${OUTBOX_PATH}`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, leaseToken, ok, ...(providerMessageId ? { providerMessageId } : {}), ...(errorCode ? { errorCode } : {}) }),
      });
      if (!response.ok) throw new Error("outbox_ack_failed");
      return jsonResponse(response);
    },
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function runWeixinOutboxPump({
  client,
  bot,
  pollMs = 5_000,
  abortSignal,
  log = () => {},
} = {}) {
  if (!client || typeof client.lease !== "function" || typeof client.ack !== "function") throw new TypeError("client is required");
  if (!bot || typeof bot.sendMessage !== "function") throw new TypeError("bot is required");
  if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60_000) throw new TypeError("pollMs is invalid");
  while (!abortSignal?.aborted) {
    let lease = null;
    try {
      lease = await client.lease();
      if (!lease) {
        await sleep(pollMs, abortSignal);
        continue;
      }
      try {
        await bot.sendMessage(lease.item.message);
        await client.ack({ id: lease.item.id, leaseToken: lease.leaseToken, ok: true });
      } catch {
        try { await client.ack({ id: lease.item.id, leaseToken: lease.leaseToken, ok: false, errorCode: "WEIXIN_SEND_FAILED" }); } catch { /* retry on next lease */ }
      }
    } catch {
      log("[weixin] category=outbox status=retryable_error");
      await sleep(pollMs, abortSignal);
    }
  }
}
