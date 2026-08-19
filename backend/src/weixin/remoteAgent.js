import { createHash } from "node:crypto";

import { readBoundedResponseText } from "../http/request.js";
import {
  readWeixinDocument,
  WeixinDocumentError,
  weixinDocumentSourceRef,
} from "../travelExpense/documentInboxMedia.js";

const EVENT_PATH = "/api/integrations/weixin-agent/events";
const SAFE_FAILURE_MESSAGE = "远程助手暂时不可用，请稍后重试";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RemoteAgentError extends Error {
  constructor(code, message = SAFE_FAILURE_MESSAGE, { permanent = false } = {}) {
    super(message);
    this.name = "RemoteAgentError";
    this.code = code;
    this.permanent = permanent || ["REMOTE_AGENT_INVALID_REQUEST", "REMOTE_AGENT_MEDIA_INVALID"].includes(code);
  }
}

function requiredText(value, name, max = 5000) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", `${name} is required`);
  }
  return value;
}

function requiredIdentifier(value, name, max = 500) {
  const identifier = requiredText(value, name, max);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(identifier)) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", `${name} is invalid`);
  }
  return identifier;
}

function requiredDeliveryMetadata(request) {
  const conversationId = requiredIdentifier(request.conversationId, "conversationId");
  const senderId = requiredIdentifier(request.senderId, "senderId");
  if (typeof request.messageId !== "string" || !/^weixin:delivery:v1:[0-9a-f]{64}$/.test(request.messageId)) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "messageId is invalid");
  }
  if (!Number.isSafeInteger(request.deliveryTimestampMs) || request.deliveryTimestampMs <= 0) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "deliveryTimestampMs is invalid");
  }
  if (!['direct', 'group'].includes(request.chatType)) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "chatType is invalid");
  }
  if (request.chatType === "direct") {
    if (request.groupId !== undefined && request.groupId !== null) {
      throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "groupId is invalid");
    }
    return { conversationId, senderId, messageId: request.messageId, chatType: request.chatType, groupId: null };
  }
  return {
    conversationId,
    senderId,
    messageId: request.messageId,
    chatType: request.chatType,
    groupId: requiredIdentifier(request.groupId, "groupId"),
  };
}

function optionalSyntheticMetadata(request) {
  const hasAnyMetadata = [
    request.senderId,
    request.messageId,
    request.chatType,
    request.deliveryTimestampMs,
    request.groupId,
  ].some((value) => value !== undefined && value !== null);
  if (!hasAnyMetadata) return null;
  return requiredDeliveryMetadata(request);
}

function normalizeBackendUrl(value) {
  const url = String(value ?? "").trim().replace(/\/+$/u, "");
  if (!url) throw new RemoteAgentError("REMOTE_AGENT_NOT_CONFIGURED");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_BACKEND", "The remote backend URL is invalid");
  }
  if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_BACKEND", "The remote backend URL is invalid");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && !loopback) {
    throw new RemoteAgentError("REMOTE_AGENT_INSECURE_BACKEND", "HTTPS is required for non-loopback remote backends");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function digestFor({ conversationId, text, mediaSha256 }) {
  const canonical = JSON.stringify({ conversationId, text, mediaSha256: mediaSha256 || null });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseResponseBody(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RESPONSE_BYTES) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
  }
  let body;
  try {
    body = JSON.parse(value);
  } catch {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
  }
  return body;
}

async function normalizeMedia(request) {
  if (!request.media) return null;
  try {
    const document = await readWeixinDocument(request.media);
    // Keep the existing source-reference semantics available to the receiving
    // service while deriving the event identity independently below.
    const sourceRef = weixinDocumentSourceRef({}, document.sha256);
    return {
      fileName: document.fileName,
      mediaType: document.mediaType,
      contentBase64: document.contentBase64,
      sha256: document.sha256,
      sourceRef,
    };
  } catch (error) {
    if (error instanceof WeixinDocumentError) {
      throw new RemoteAgentError("REMOTE_AGENT_MEDIA_INVALID");
    }
    throw new RemoteAgentError("REMOTE_AGENT_MEDIA_INVALID");
  }
}

export function createRemoteClawbotAgent(options = {}) {
  const backendUrl = normalizeBackendUrl(options.backendUrl);
  const apiToken = typeof options.apiToken === "string" ? options.apiToken.trim() : "";
  if (!apiToken) throw new RemoteAgentError("REMOTE_AGENT_NOT_CONFIGURED");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") throw new RemoteAgentError("REMOTE_AGENT_NOT_CONFIGURED");
  const allowSyntheticIdentity = options.allowSyntheticIdentity === true;

  return Object.freeze({
    async chat(request = {}) {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "请求格式无效");
      }
      const metadata = allowSyntheticIdentity
        ? optionalSyntheticMetadata(request)
        : requiredDeliveryMetadata(request);
      const conversationId = metadata?.conversationId ?? requiredIdentifier(request.conversationId, "conversationId");
      const text = requiredText(request.text, "text", 20000);
      const media = await normalizeMedia(request);
      const digest = digestFor({ conversationId, text, mediaSha256: media?.sha256 });
      const sourceMessageId = metadata?.messageId ?? `weixin:${digest}`;
      const body = {
        conversationId,
        text,
        sourceMessageId,
      };
      if (metadata) {
        body.senderId = metadata.senderId;
        body.chatType = metadata.chatType;
        if (metadata.groupId) body.groupId = metadata.groupId;
      }
      if (media) body.media = media;

      let response;
      try {
        response = await fetchImpl(`${backendUrl}${EVENT_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "Idempotency-Key": sourceMessageId,
          },
          body: JSON.stringify(body),
        });
      } catch {
        throw new RemoteAgentError("REMOTE_AGENT_REQUEST_FAILED");
      }

      if (!response || typeof response.text !== "function") {
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
      }
      let responseText;
      try {
        responseText = await readBoundedResponseText(response, {
          maxBytes: MAX_RESPONSE_BYTES,
          errorMessage: "Remote agent response body is too large",
        });
      } catch {
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
      }
      if (!response.ok) {
        const status = Number(response.status);
        const permanent = Number.isInteger(status)
          && status >= 400
          && status < 500
          && ![408, 429].includes(status);
        throw new RemoteAgentError("REMOTE_AGENT_REQUEST_FAILED", SAFE_FAILURE_MESSAGE, { permanent });
      }
      try {
        return parseResponseBody(responseText);
      } catch (error) {
        if (error instanceof RemoteAgentError) throw error;
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
      }
    },
  });
}

export const createRemoteWeixinAgent = createRemoteClawbotAgent;
export const createWeixinRemoteAgent = createRemoteClawbotAgent;
