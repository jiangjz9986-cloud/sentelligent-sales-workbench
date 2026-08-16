import { HttpError } from "../http/errors.js";
import { readWeixinDocument } from "../travelExpense/documentInboxMedia.js";

const MAX_TEXT_LENGTH = 20_000;
const MAX_IDENTIFIER_LENGTH = 500;
const EVENT_KEYS = new Set([
  "conversationId",
  "text",
  "sourceMessageId",
  "senderId",
  "chatType",
  "groupId",
  "media",
  "pendingActionId",
  "confirmationCode",
]);
const MEDIA_KEYS = new Set([
  "type",
  "fileName",
  "mimeType",
  "mediaType",
  "contentBase64",
  "sha256",
  "sourceRef",
]);

function validation(fields) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
}

function requiredText(value, field, max = MAX_IDENTIFIER_LENGTH) {
  if (typeof value !== "string" || !value.trim()) validation({ [field]: "required" });
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    validation({ [field]: "format" });
  }
  return normalized;
}

function requiredEventText(value) {
  if (typeof value !== "string" || !value.trim()) validation({ text: "required" });
  if (value.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    validation({ text: "format" });
  }
  return value;
}

function optionalText(value, field, max = MAX_IDENTIFIER_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
}

function optionalExactText(value, field, max = MAX_IDENTIFIER_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) validation({ [field]: "format" });
  return value;
}

function plainObject(value, field) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) validation({ [field]: "object" });
  return value;
}

function checkKeys(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) validation({ [`${field}.${unknown}`]: "unknown" });
}

function normalizeChatType(value) {
  const chatType = value === undefined || value === null || value === "" ? "direct" : value;
  if (!["direct", "group"].includes(chatType)) validation({ chatType: "enum" });
  return chatType;
}

function validateAllowlistId(value, field) {
  return requiredText(value, field, MAX_IDENTIFIER_LENGTH);
}

export function assertWeixinSenderAllowed(config, event) {
  const senderIds = Array.isArray(config?.weixinAllowedSenderIds)
    ? config.weixinAllowedSenderIds
    : [];
  if (!senderIds.includes(event.senderId)) {
    throw new HttpError(403, "WEIXIN_SENDER_NOT_ALLOWED", "This WeChat sender is not allowed");
  }
  if (event.chatType === "group") {
    if (config?.weixinAllowGroups !== true) {
      throw new HttpError(403, "WEIXIN_GROUP_NOT_ALLOWED", "WeChat group messages are not allowed");
    }
    const groupIds = Array.isArray(config?.weixinAllowedGroupIds) ? config.weixinAllowedGroupIds : [];
    if (groupIds.length > 0 && !groupIds.includes(event.groupId)) {
      throw new HttpError(403, "WEIXIN_GROUP_NOT_ALLOWED", "This WeChat group is not allowed");
    }
  }
}

export function classifyWeixinConfirmationText(rawText) {
  if (/^[0-9]{6}$/u.test(rawText)) return { kind: "code", code: rawText };
  if (rawText === "取消") return { kind: "cancel" };
  if (rawText === "重发确认码") return { kind: "resend" };
  return { kind: "ordinary" };
}

export async function validateWeixinAssistantEvent(value) {
  const body = plainObject(value, "body");
  checkKeys(body, EVENT_KEYS, "body");
  const conversationId = requiredText(body.conversationId, "conversationId");
  const text = requiredEventText(body.text);
  const sourceMessageId = requiredText(body.sourceMessageId, "sourceMessageId");
  const senderId = validateAllowlistId(body.senderId, "senderId");
  const chatType = normalizeChatType(body.chatType);
  const groupId = optionalText(body.groupId, "groupId");
  if (chatType === "group" && !groupId) validation({ groupId: "required" });
  if (chatType === "direct" && groupId) validation({ groupId: "forbidden" });
  const pendingActionId = optionalText(body.pendingActionId, "pendingActionId", 300);
  const confirmationCode = optionalExactText(body.confirmationCode, "confirmationCode", 100);
  if (confirmationCode && !/^[0-9]{6}$/u.test(confirmationCode)) validation({ confirmationCode: "format" });

  let media = null;
  if (body.media !== undefined && body.media !== null) {
    const mediaBody = plainObject(body.media, "media");
    checkKeys(mediaBody, MEDIA_KEYS, "media");
    if (Object.hasOwn(mediaBody, "filePath")) validation({ "media.filePath": "forbidden" });
    const normalized = await readWeixinDocument({
      ...mediaBody,
      // The remote boundary never reads a path. Force the content-only branch.
      filePath: undefined,
    });
    if (mediaBody.sha256 !== undefined && mediaBody.sha256 !== normalized.sha256) {
      validation({ "media.sha256": "mismatch" });
    }
    media = {
      fileName: normalized.fileName,
      mediaType: normalized.mediaType,
      contentBase64: normalized.contentBase64,
      sha256: normalized.sha256,
      sourceRef: optionalText(mediaBody.sourceRef, "media.sourceRef") ?? `weixin:${normalized.sha256}`,
    };
  }

  return {
    conversationId,
    text,
    sourceMessageId,
    senderId,
    chatType,
    ...(groupId ? { groupId } : {}),
    ...(pendingActionId ? { pendingActionId } : {}),
    ...(confirmationCode ? { confirmationCode } : {}),
    ...(media ? { media } : {}),
  };
}
