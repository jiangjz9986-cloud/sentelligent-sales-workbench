import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { getToolPolicy } from "./policy.js";
import {
  assistantWebRateLimitKey,
  consumeAssistantWebRateLimit,
  deriveWebExplicitCredential,
  filterWebHistoryParts,
  mapAssistantWebResponse,
  validateWebConversationId,
  validateWebMessage,
  webConfirmEventId,
  webConversationScope,
  webEventId,
} from "./webChannel.js";

function confirmationKey(value) {
  const key = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("confirmationSecret must contain at least 32 bytes");
  }
  return Buffer.from(key);
}

export function createAssistantWebHttpHandlers({
  db,
  config,
  assistantOrchestrator,
  assistantSessionRepository,
  assistantPendingActionRepository,
  assistantRegistry,
  confirmationSecret,
}) {
  if (!assistantOrchestrator || typeof assistantOrchestrator.handle !== "function") {
    throw new TypeError("assistantOrchestrator is required");
  }
  const confirmationDigestKey = confirmationKey(confirmationSecret);

  function assertUserSession(requestIdentity) {
    if (!requestIdentity || requestIdentity.kind !== "user" || !requestIdentity.account) {
      throw new HttpError(401, "UNAUTHORIZED", "Authentication is required");
    }
    return requestIdentity;
  }

  function consumeRateLimit(requestIdentity, remoteAddress) {
    const key = assistantWebRateLimitKey(
      config.authSessionSecret,
      requestIdentity.account,
      remoteAddress || "unknown",
    );
    consumeAssistantWebRateLimit(db, key);
  }

  function conversationRecord(owner, conversationScope) {
    return assistantSessionRepository.getOrCreate({
      owner,
      channel: "web",
      conversationId: conversationScope,
    });
  }

  async function handleChat({
    requestIdentity,
    remoteAddress,
    requestId,
    body,
  }) {
    const identity = assertUserSession(requestIdentity);
    consumeRateLimit(identity, remoteAddress);
    const message = validateWebMessage(body?.message);
    const explicitConversationId = validateWebConversationId(body?.conversationId);
    const conversationScope = webConversationScope({
      owner: identity.account,
      sessionId: identity.id,
      conversationId: explicitConversationId,
    });
    const clientMessageId = typeof body?.clientMessageId === "string" && body.clientMessageId.trim()
      ? body.clientMessageId.trim()
      : randomUUID();
    const eventId = webEventId({
      owner: identity.account,
      conversation: conversationScope,
      clientMessageId,
    });
    const result = await assistantOrchestrator.handle({
      context: {
        owner: identity.account,
        channel: "web",
        conversation: conversationScope,
        event: eventId,
        requestId,
      },
      input: { text: message },
      serverData: {},
    });
    const mapped = mapAssistantWebResponse(result);
    return {
      status: mapped.status,
      body: {
        ...mapped.body,
        conversationId: conversationScope,
        clientMessageId,
      },
    };
  }

  async function handleConfirm({
    requestIdentity,
    remoteAddress,
    requestId,
    body,
  }) {
    const identity = assertUserSession(requestIdentity);
    consumeRateLimit(identity, remoteAddress);
    const pendingActionId = typeof body?.pendingActionId === "string" ? body.pendingActionId.trim() : "";
    if (!pendingActionId) {
      throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { pendingActionId: "required" });
    }
    const intent = body?.intent === "cancel" ? "cancel" : "confirm";
    const explicitConversationId = validateWebConversationId(body?.conversationId);
    const conversationScope = webConversationScope({
      owner: identity.account,
      sessionId: identity.id,
      conversationId: explicitConversationId,
    });
    const conversation = conversationRecord(identity.account, conversationScope);
    const scope = {
      owner: identity.account,
      channel: "web",
      conversationId: conversation.id,
    };
    let pendingAction;
    try {
      pendingAction = assistantPendingActionRepository.get(pendingActionId, scope);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(404, "NOT_FOUND", "Pending action was not found");
      }
      throw error;
    }
    if (!pendingAction) {
      throw new HttpError(404, "NOT_FOUND", "Pending action was not found");
    }

    const eventId = webConfirmEventId({ pendingActionId, intent });
    let input;
    if (intent === "cancel") {
      input = { text: "取消", pendingActionId };
    } else {
      const policy = assistantRegistry?.getTool?.(pendingAction.actionType)?.policy
        ?? getToolPolicy(pendingAction.actionType);
      if (policy.confirmation === "affirm_language") {
        input = { text: "确认", pendingActionId };
      } else {
        input = {
          pendingActionId,
          confirmationCode: deriveWebExplicitCredential(confirmationDigestKey, pendingActionId),
        };
      }
    }

    const result = await assistantOrchestrator.handle({
      context: {
        owner: identity.account,
        channel: "web",
        conversation: conversationScope,
        event: eventId,
        requestId,
      },
      input,
      serverData: {},
    });
    const mapped = mapAssistantWebResponse(result);
    return {
      status: mapped.status,
      body: {
        ...mapped.body,
        conversationId: conversationScope,
        pendingActionId,
      },
    };
  }

  function handleHistory({ requestIdentity, conversationId }) {
    const identity = assertUserSession(requestIdentity);
    const conversationScope = validateWebConversationId(conversationId);
    if (!conversationScope) {
      throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { conversationId: "required" });
    }
    const conversation = assistantSessionRepository.getByExternalId?.({
      owner: identity.account,
      channel: "web",
      conversationId: conversationScope,
    });
    if (!conversation) {
      throw new HttpError(404, "NOT_FOUND", "Conversation was not found");
    }
    const parts = filterWebHistoryParts(assistantSessionRepository.listDraftParts(conversation.id));
    return {
      status: 200,
      body: {
        conversationId: conversationScope,
        items: parts.map((part) => ({
          role: part.role,
          text: part.text,
          at: part.createdAt,
          status: part.metadata?.status ?? "ok",
        })),
      },
    };
  }

  return {
    handleChat,
    handleConfirm,
    handleHistory,
  };
}
