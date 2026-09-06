import { createHash, createHmac, randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { loginRateLimitKey } from "../auth/loginRateLimit.js";
import { parseWeixinCardText, weixinCard } from "./weixinCard.js";

const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9:_-]{8,200}$/;
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const WEB_OPEN_TOOLS = new Set([
  "dashboard.summary",
  "customer.search",
  "customer.detail",
  "customer.create",
  "customer.update",
  "customer.delete",
  "opportunity.list",
  "opportunity.detail",
  "opportunity.update-stage",
  "opportunity.update-next",
  "opportunity.update",
  "opportunity.create",
  "opportunity.delete",
  "action-risk.summary",
  "action-risk.list",
  "action-risk.create",
  "action-risk.complete",
  "action-risk.defer",
  "action-risk.delete",
  "knowledge.search",
  "hospital-tender.summary",
]);

export function deriveWebExplicitCredential(confirmationSecretKey, actionId) {
  if (!confirmationSecretKey || !actionId) {
    throw new TypeError("confirmationSecretKey and actionId are required");
  }
  const digest = createHmac("sha256", confirmationSecretKey)
    .update(`sentelligent/assistant-web-explicit-confirmation/v1\u0000${actionId}`, "utf8")
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function isWebClosedTool(toolName) {
  if (typeof toolName !== "string" || !toolName.trim()) return true;
  const normalized = toolName.trim();
  return !WEB_OPEN_TOOLS.has(normalized);
}

export function assertWebToolAllowed(toolName) {
  if (isWebClosedTool(toolName)) {
    throw new HttpError(403, "FORBIDDEN", "该操作请使用微信小小。");
  }
}

export function safeWebPendingResponse(tool, { preview }) {
  const previewText = typeof preview === "string" && preview.trim() ? preview.trim() : null;
  const footer = "请点击确认或取消。";
  if (previewText) {
    return {
      text: previewText,
      card: parseWeixinCardText(previewText) ?? { title: "待确认", fields: [], footer },
    };
  }
  const text = weixinCard("待确认", [["操作", tool.description]], footer);
  return {
    text,
    card: parseWeixinCardText(text) ?? { title: "待确认", fields: [["操作", tool.description]], footer },
  };
}

function cardFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  return parseWeixinCardText(text.trim());
}

export function mapAssistantWebResponse(result) {
  const status = result?.status ?? 500;
  const body = result?.body && typeof result.body === "object" ? { ...result.body } : {};
  delete body.confirmationCode;
  const nestedResult = body.result && typeof body.result === "object" && !Array.isArray(body.result)
    ? body.result
    : null;
  if (typeof body.text !== "string" && typeof nestedResult?.text === "string") {
    body.text = nestedResult.text;
  }
  if (
    (!body.card || typeof body.card !== "object" || Array.isArray(body.card))
    && nestedResult?.card
    && typeof nestedResult.card === "object"
    && !Array.isArray(nestedResult.card)
  ) {
    body.card = { ...nestedResult.card };
  }
  if (!body.card && typeof body.text === "string") {
    const parsed = cardFromText(body.text);
    if (parsed) body.card = parsed;
  }
  if (body.status === "confirmation_required" && body.card && !body.text) {
    body.text = body.card.title ?? "待确认";
  }
  return { status, body };
}

export function validateWebConversationId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CONVERSATION_ID_PATTERN.test(value.trim())) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { conversationId: "invalid" });
  }
  return value.trim();
}

export function validateWebMessage(value) {
  if (typeof value !== "string") {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { message: "required" });
  }
  const message = value.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { message: "invalid" });
  }
  return message;
}

export function webConversationScope({ owner, sessionId, conversationId }) {
  if (conversationId) return conversationId;
  const digest = createHash("sha256")
    .update(`${owner}|${sessionId}`, "utf8")
    .digest("hex");
  return `web:conversation:v1:${digest}`;
}

export function webEventId({ owner, conversation, clientMessageId }) {
  const digest = createHash("sha256")
    .update(`${owner}|${conversation}|${clientMessageId}`, "utf8")
    .digest("hex");
  return `web:event:v1:${digest}`;
}

export function webConfirmEventId({ pendingActionId, intent, nonce = randomUUID() }) {
  const digest = createHash("sha256")
    .update(`${pendingActionId}|${intent}|${nonce}`, "utf8")
    .digest("hex");
  return `web:confirm:v1:${digest}`;
}

export function assistantWebRateLimitKey(secret, account, remoteAddress) {
  return loginRateLimitKey(secret, `assistant-web:${account}`, remoteAddress);
}

function rowForKey(db, key) {
  return db.prepare(`
    SELECT failures, window_started_at AS windowStartedAt, blocked_until AS blockedUntil
    FROM login_rate_limits
    WHERE key = ?
  `).get(key);
}

function isWindowExpired(row, now) {
  const startedAt = Date.parse(row.windowStartedAt);
  return !Number.isFinite(startedAt) || now >= startedAt + RATE_LIMIT_WINDOW_MS;
}

export function consumeAssistantWebRateLimit(db, key, now = Date.now()) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("rate limit key is required");
  }
  const row = rowForKey(db, key);
  const windowStartedAt = new Date(now).toISOString();

  if (!row || isWindowExpired(row, now)) {
    db.prepare(`
      INSERT INTO login_rate_limits (key, failures, window_started_at, blocked_until)
      VALUES (:key, 1, :windowStartedAt, NULL)
      ON CONFLICT(key) DO UPDATE SET
        failures = 1,
        window_started_at = excluded.window_started_at,
        blocked_until = NULL
    `).run({ key, windowStartedAt });
    return;
  }

  const failures = Number(row.failures ?? 0) + 1;
  if (failures > RATE_LIMIT_MAX_REQUESTS) {
    throw new HttpError(429, "RATE_LIMITED", "Too many assistant requests");
  }

  db.prepare(`
    UPDATE login_rate_limits
    SET failures = :failures
    WHERE key = :key
  `).run({ key, failures });
}

export const WEB_HISTORY_CONTROL_MESSAGES = new Set([
  "记录", "录入", "确认", "取消", "帮助", "help", "/帮助", "/help", "<confirmation-code>",
]);

export function filterWebHistoryParts(parts) {
  return (parts ?? []).filter((part) => {
    const text = typeof part.text === "string" ? part.text.trim() : "";
    return text && !WEB_HISTORY_CONTROL_MESSAGES.has(text);
  });
}
