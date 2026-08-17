import { createHash } from "node:crypto";

import { QINGYANG_BOOKKEEPING_BRIDGE_URL } from "../config.js";
import { HttpError } from "../http/errors.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REMOTE_STATUSES = new Set([
  "pending",
  "processing",
  "review",
  "failed",
  "confirmed",
  "rejected",
  "voided",
]);

function unavailable() {
  return new HttpError(
    503,
    "QINGYANG_BRIDGE_UNAVAILABLE",
    "轻氧记账服务暂时不可用，请稍后重试",
  );
}

function requiredText(value, name, max = 12_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long`);
  return normalized;
}

async function readBoundedJson(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw unavailable();
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw unavailable();
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeRemoteResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const id = String(value.id ?? "").trim();
  const reference = String(value.doc_no ?? "").trim();
  const status = String(value.status ?? "").trim();
  if (
    !id
    || id.length > 200
    || !reference
    || reference.length > 200
    || !REMOTE_STATUSES.has(status)
    || typeof value.replayed !== "boolean"
  ) {
    throw unavailable();
  }
  return { id, reference, status, replayed: value.replayed };
}

export function createQingyangBookkeepingBridge({
  url = "",
  token = "",
  timeoutMs = 10_000,
  fetchImpl = fetch,
} = {}) {
  const endpoint = String(url ?? "").trim();
  const credential = String(token ?? "").trim();
  if (endpoint && endpoint !== QINGYANG_BOOKKEEPING_BRIDGE_URL) {
    throw new TypeError("Qingyang bridge URL must use the exact approved loopback endpoint");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError("Qingyang bridge timeout must be a positive safe integer no greater than 30000");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("Qingyang bridge fetch implementation is required");

  const isConfigured = () => Boolean(endpoint && credential);

  async function forward(input = {}) {
    if (!isConfigured()) throw unavailable();
    const owner = requiredText(input.owner, "owner", 200);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
    const bridgeKey = `sentelligent-shortcut:${createHash("sha256")
      .update(`${owner}\u0000${idempotencyKey}`, "utf8")
      .digest("hex")}`;
    const body = {
      text: requiredText(input.text, "text"),
      captured_at: input.capturedAt ? requiredText(input.capturedAt, "capturedAt", 64) : "",
      ledger_name: "biubiu",
      idempotency_key: bridgeKey,
      source: "sentelligent-shortcut",
      entry_type: requiredText(input.entryType, "entryType", 20),
      category: requiredText(input.category, "category", 100),
      subcategory: input.subcategory ? requiredText(input.subcategory, "subcategory", 100) : "",
      note: typeof input.note === "string" ? input.note.trim().slice(0, 500) : "",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": bridgeKey,
          "X-Qingyang-Sentelligent-Bridge-Token": credential,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (![200, 202].includes(response.status)) throw unavailable();
      return normalizeRemoteResponse(await readBoundedJson(response));
    } catch (error) {
      if (error instanceof HttpError && error.code === "QINGYANG_BRIDGE_UNAVAILABLE") throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return { isConfigured, forward };
}
