import { createHash } from "node:crypto";

import {
  readWeixinDocument,
  WeixinDocumentError,
  weixinDocumentSourceRef,
} from "../travelExpense/documentInboxMedia.js";

const EVENT_PATH = "/api/integrations/weixin-agent/events";
const SAFE_FAILURE_MESSAGE = "远程助手暂时不可用，请稍后重试";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RemoteAgentError extends Error {
  constructor(code, message = SAFE_FAILURE_MESSAGE) {
    super(message);
    this.name = "RemoteAgentError";
    this.code = code;
  }
}

function requiredText(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", `${name} is required`);
  }
  return value.trim();
}

function optionalIdentifier(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, max);
}

function normalizeBackendUrl(value) {
  const url = String(value ?? "").trim().replace(/\/+$/u, "");
  if (!url) throw new RemoteAgentError("REMOTE_AGENT_NOT_CONFIGURED");
  return url;
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

  return Object.freeze({
    async chat(request = {}) {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "请求格式无效");
      }
      const conversationId = requiredText(request.conversationId, "conversationId", 500);
      const text = requiredText(request.text, "text", 20000);
      const media = await normalizeMedia(request);
      const digest = digestFor({ conversationId, text, mediaSha256: media?.sha256 });
      const sourceMessageId = optionalIdentifier(request.messageId, "messageId") ?? `weixin:${digest}`;
      const body = {
        conversationId,
        text,
        sourceMessageId,
      };
      const senderId = optionalIdentifier(request.senderId ?? options.senderId, "senderId");
      const chatType = request.chatType === undefined ? undefined : request.chatType;
      if (senderId) body.senderId = senderId;
      if (chatType !== undefined) {
        if (!["direct", "group"].includes(chatType)) throw new RemoteAgentError("REMOTE_AGENT_INVALID_REQUEST", "chatType is invalid");
        body.chatType = chatType;
      }
      const groupId = optionalIdentifier(request.groupId, "groupId");
      if (groupId) body.groupId = groupId;
      const pendingActionId = optionalIdentifier(request.pendingActionId, "pendingActionId", 300);
      const confirmationCode = optionalIdentifier(request.confirmationCode, "confirmationCode", 100);
      if (pendingActionId) body.pendingActionId = pendingActionId;
      if (confirmationCode) body.confirmationCode = confirmationCode;
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
        responseText = await response.text();
      } catch {
        throw new RemoteAgentError("REMOTE_AGENT_INVALID_RESPONSE");
      }
      if (!response.ok) throw new RemoteAgentError("REMOTE_AGENT_REQUEST_FAILED");
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
