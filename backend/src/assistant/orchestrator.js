import { createHash, createHmac, randomInt } from "node:crypto";

import { createAssistantRouter } from "./router.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { validateToolInvocation } from "./contracts.js";
import { getToolPolicy } from "./policy.js";
import { classifyWeixinConfirmationText } from "./weixinEvent.js";

const SAFE_FAILURE = "处理失败，请稍后重试。";
const SAFE_CONFIRMATION_FAILURE = "确认信息无效或已过期，请重新发起操作。";
const VALID_CONTEXT = ["owner", "channel", "conversation", "event", "requestId"];
const STORED_CONFIRMATION_TEXT = "确认码不会重复展示，请在同一会话回复“重发确认码”或“取消”。";

function requiredText(value, name, max = 5000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requestDigest(input) {
  const canonical = JSON.stringify({
    text: typeof input.text === "string" ? input.text : "",
    confidence: input.confidence === undefined ? null : input.confidence,
    pendingActionId: input.pendingActionId === undefined ? null : input.pendingActionId,
    confirmationCode: input.confirmationCode === undefined ? null : String(input.confirmationCode),
    mediaSha256: input.mediaSha256 ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function confirmationKey(value) {
  const key = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("confirmationSecret must contain at least 32 bytes");
  }
  return Buffer.from(key);
}

function encodeLengthPrefixed(parts) {
  return Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    return Buffer.concat([length, value]);
  }));
}

export function confirmationRequestDigest({
  owner,
  channel,
  conversation,
  code,
  mediaSha256,
  confirmationSecret,
}) {
  return createHmac("sha256", confirmationKey(confirmationSecret)).update(encodeLengthPrefixed([
    "sentelligent/assistant-confirmation-request/v1",
    requiredText(owner, "owner", 500),
    requiredText(channel, "channel", 500),
    requiredText(conversation, "conversation", 500),
    code,
    mediaSha256 ?? "",
  ])).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function actionToolRunDigest({ actionId, toolName, arguments: argumentsValue }) {
  return createHash("sha256").update(JSON.stringify(canonicalValue({
    actionId,
    toolName,
    arguments: argumentsValue,
  })), "utf8").digest("hex");
}

function makeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("context is required");
  for (const key of VALID_CONTEXT) requiredText(value[key], `context.${key}`, 500);
  return Object.freeze(Object.fromEntries(VALID_CONTEXT.map((key) => [key, value[key].trim()])));
}

function makeServerData(value) {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("serverData must be an object");
  if (Object.keys(value).some((key) => !["media", "auditMetadata"].includes(key))) throw new TypeError("serverData contains an unsupported field");
  const result = {};
  if (value.auditMetadata !== undefined && value.auditMetadata !== null) {
    const metadata = value.auditMetadata;
    if (typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("serverData.auditMetadata must be an object");
    const allowedMetadata = new Set(["senderHash", "groupHash", "chatType"]);
    if (Object.keys(metadata).some((key) => !allowedMetadata.has(key))) throw new TypeError("serverData.auditMetadata contains an unsupported field");
    const normalizedMetadata = {};
    for (const key of allowedMetadata) {
      if (metadata[key] === undefined || metadata[key] === null) continue;
      if (typeof metadata[key] !== "string" || !metadata[key].trim()) throw new TypeError(`serverData.auditMetadata.${key} is invalid`);
      normalizedMetadata[key] = metadata[key];
    }
    result.auditMetadata = Object.freeze(normalizedMetadata);
  }
  if (value.media === undefined || value.media === null) return Object.freeze(result);
  const media = value.media;
  if (typeof media !== "object" || Array.isArray(media)) throw new TypeError("serverData.media must be an object");
  const allowed = new Set(["fileName", "mediaType", "contentBase64", "sha256", "sourceRef"]);
  if (Object.keys(media).some((key) => !allowed.has(key))) throw new TypeError("serverData.media contains an unsupported field");
  const normalized = {};
  for (const key of allowed) {
    if (media[key] === undefined || media[key] === null) continue;
    if (typeof media[key] !== "string" || !media[key].trim()) throw new TypeError(`serverData.media.${key} is invalid`);
    normalized[key] = media[key];
  }
  if (!normalized.contentBase64 || !normalized.sha256 || !normalized.sourceRef) {
    throw new TypeError("serverData.media is incomplete");
  }
  result.media = Object.freeze(normalized);
  return Object.freeze(result);
}

function response(status, body) {
  return { status, statusCode: status, body };
}

function safeText(plan) {
  if (plan.status === "help") return plan.message || "可用功能请查看帮助。";
  if (plan.status === "clarify") return plan.question || "请补充必要信息。";
  if (plan.status === "cancelled" || plan.status === "cancel") return "已取消当前操作。";
  return "暂时无法识别这个请求，请换一种说法。";
}

function isRisky(plan) {
  return plan.risk === "R2" || plan.risk === "R3" || plan.requiresConfirmation === true || plan.status === "confirmation_required";
}

function genericFailure(status = 500, message = SAFE_FAILURE) {
  return response(status, { status: "error", message });
}

function defaultCode() {
  return String(randomInt(100000, 1000000));
}

function exactConfirmationCode(value) {
  return typeof value === "string" && /^[0-9]{6}$/u.test(value) ? value : null;
}

export function safePendingResponse(tool, { code }) {
  return {
    text: [
      `待确认操作：${tool.description}`,
      `确认码：${code}`,
      "有效期：10 分钟",
      "请在同一微信会话中直接回复这六位数字；不要转发给其他会话。",
      "回复“取消”可放弃本次操作，回复“重发确认码”可轮换确认码。",
    ].join("\n"),
  };
}

/**
 * Deterministic assistant execution boundary. The HTTP layer supplies context;
 * model text can select only a registered tool and validated JSON arguments.
 */
export function createAssistantOrchestrator({
  router = createAssistantRouter(),
  registry = createAgentRegistry(),
  eventRepository,
  sessionRepository,
  pendingActionRepository,
  toolHandlers = {},
  confirmationCodeFactory = defaultCode,
  confirmationSecret,
  clock = () => new Date(),
  pendingTtlMs = 10 * 60 * 1000,
} = {}) {
  if (!eventRepository || typeof eventRepository.receive !== "function" || typeof eventRepository.claim !== "function") {
    throw new TypeError("eventRepository must support receive and claim");
  }
  const confirmationDigestKey = confirmationKey(confirmationSecret);

  async function handle({ context: rawContext, input: rawInput = {}, serverData: rawServerData } = {}) {
    const context = makeContext(rawContext);
    const serverData = makeServerData(rawServerData);
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
    const text = typeof input.text === "string" ? input.text : "";
    const confidence = input.confidence === undefined ? undefined : Number(input.confidence);
    const pendingActionId = input.pendingActionId === undefined ? null : requiredText(input.pendingActionId, "pendingActionId", 300);
    const textClassification = classifyWeixinConfirmationText(text);
    const structuredCodePresent = input.confirmationCode !== undefined && input.confirmationCode !== null;
    const structuredCode = structuredCodePresent ? exactConfirmationCode(input.confirmationCode) : null;
    const confirmationContext = textClassification.kind === "code" || structuredCodePresent;
    const code = textClassification.kind === "code" ? textClassification.code : structuredCode;
    const persistedText = confirmationContext ? "<confirmation-code>" : text;
    const requestHash = confirmationContext && code
      ? confirmationRequestDigest({
        owner: context.owner,
        channel: context.channel,
        conversation: context.conversation,
        code,
        mediaSha256: serverData.media?.sha256 ?? null,
        confirmationSecret: confirmationDigestKey,
      })
      : requestDigest({
        text: persistedText,
        confidence,
        pendingActionId,
        confirmationCode: structuredCodePresent ? "<confirmation-code>" : undefined,
        mediaSha256: serverData.media?.sha256,
      });
    const received = eventRepository.receive({
      owner: context.owner,
      channel: context.channel,
      eventId: context.event,
      requestHash,
      auditMetadata: serverData.auditMetadata,
      payload: {
        text: persistedText,
        confidence: Number.isFinite(confidence) ? confidence : null,
        pendingActionId,
        ...(serverData.auditMetadata ? { auditMetadata: serverData.auditMetadata } : {}),
      },
    });
    if (received.replayed && received.item?.response) return response(received.item.responseStatus || 200, received.item.response);

    const claimed = eventRepository.claim(received.item.id);
    if (claimed.replayed && claimed.item?.response) return response(claimed.item.responseStatus || 200, claimed.item.response);
    const leaseToken = claimed.leaseToken;
    const eventId = received.item.id;
    const conversation = sessionRepository?.getOrCreate?.({ owner: context.owner, channel: context.channel, conversationId: context.conversation });
    const append = (role, value) => sessionRepository?.appendDraftPart?.(conversation?.id, { role, text: String(value), metadata: { requestId: context.requestId, event: context.event } });
    append("user", persistedText || "(empty)");

    const finish = (status, liveBody, {
      storedBody = liveBody,
      draftText = storedBody.message ?? storedBody.text ?? storedBody.status,
    } = {}) => {
      append("assistant", draftText);
      eventRepository.complete(eventId, { leaseToken, responseStatus: status, response: storedBody });
      return response(status, liveBody);
    };
    const fail = (error, status = 500) => {
      const body = genericFailure(status).body;
      try {
        append("assistant", confirmationContext ? "确认信息已处理。" : body.message);
        if (typeof eventRepository.fail === "function") eventRepository.fail(eventId, { leaseToken, responseStatus: status, response: body, errorCode: "ASSISTANT_INTERNAL_ERROR" });
        else eventRepository.complete(eventId, { leaseToken, responseStatus: status, response: body });
      } catch { /* preserve the safe outward response */ }
      return response(status, body);
    };

    let actionLease = null;
    let resolvedActionId = pendingActionId;
    try {
      let pendingPlan;
      let pendingAction;
      const scope = { owner: context.owner, channel: context.channel, conversationId: conversation?.id };
      const scopedCommand = ["code", "cancel", "resend"].includes(textClassification.kind) || structuredCodePresent;
      if (scopedCommand) {
        if (structuredCodePresent && !structuredCode) {
          return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
        }
        if (textClassification.kind === "code" && structuredCodePresent && structuredCode !== textClassification.code) {
          return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
        }
        try {
          pendingAction = pendingActionRepository?.findActiveByConversation?.(scope) ?? null;
        } catch {
          return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
        }
        if (!pendingAction && pendingActionId) {
          const completed = pendingActionRepository?.get?.(pendingActionId, scope);
          if (completed?.status === "executed" && code && textClassification.kind !== "cancel" && textClassification.kind !== "resend") {
            try {
              pendingActionRepository.confirm(pendingActionId, { ...scope, confirmationCode: code });
              return finish(200, { status: "ok", actionId: pendingActionId, result: completed.result ?? null }, { draftText: "确认信息已处理。" });
            } catch {
              return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
            }
          }
        }
        if (pendingActionId && pendingAction?.id !== pendingActionId) {
          return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
        }
        resolvedActionId = pendingAction?.id ?? null;

        if (textClassification.kind === "cancel") {
          if (pendingAction) {
            try {
              pendingActionRepository.cancel(resolvedActionId, scope);
              return finish(200, { status: "cancel", message: "已取消当前操作。" }, { draftText: "确认信息已处理。" });
            } catch {
              return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
            }
          }
        } else if (textClassification.kind === "resend") {
          if (!pendingAction) {
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
          }
          try {
            const replacementCode = exactConfirmationCode(String(confirmationCodeFactory()));
            if (!replacementCode) throw new TypeError("confirmationCode must contain exactly six digits");
            const renewed = pendingActionRepository.renewConfirmation(resolvedActionId, { ...scope, confirmationCode: replacementCode });
            const tool = registry.getTool(pendingAction.actionType);
            if (!tool) throw new TypeError("pending action tool is unavailable");
            const liveBody = {
              status: "confirmation_required",
              actionId: resolvedActionId,
              toolName: tool.name,
              risk: (pendingAction.payload?.plan || pendingAction.payload)?.risk,
              confirmationCode: renewed.confirmationCode,
              ...safePendingResponse(tool, { code: renewed.confirmationCode }),
            };
            const storedBody = { ...liveBody, text: STORED_CONFIRMATION_TEXT };
            delete storedBody.confirmationCode;
            return finish(200, liveBody, { storedBody, draftText: "等待用户确认。" });
          } catch {
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
          }
        } else {
          if (!pendingAction || !code) {
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
          }
          try {
            const confirmed = pendingActionRepository.confirm(resolvedActionId, { ...scope, confirmationCode: code });
            if (confirmed?.expired || confirmed?.inProgress) {
              return finish(confirmed?.expired ? 410 : 409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
            }
            pendingAction = confirmed?.item ?? pendingAction;
          } catch (error) {
            if (error?.code === "ASSISTANT_CONFIRMATION_INVALID") {
              try {
                pendingActionRepository.recordConfirmationFailure(resolvedActionId, { ...scope, eventId: context.event });
              } catch { /* preserve the uniform confirmation failure */ }
            }
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
          }
          pendingPlan = pendingAction.payload?.plan || pendingAction.payload;
          if (!pendingPlan || typeof pendingPlan !== "object" || Array.isArray(pendingPlan)) {
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
          }
        }
      }

      const plan = resolvedActionId
        ? { ...pendingPlan, status: "planned", confirmed: true }
        : router.route({
          text,
          confidence,
          mediaRef: serverData.media?.sourceRef,
        });
      if (["help", "clarify", "unknown", "cancelled", "cancel"].includes(plan.status)) {
        return finish(200, { status: plan.status === "cancelled" || plan.status === "cancel" ? "cancel" : plan.status, message: safeText(plan), question: plan.question });
      }
      if (plan.status === "denied") return finish(403, { status: "error", message: "该操作不在允许范围内。" });
      const tool = registry.getTool(plan.toolName);
      if (!tool) return finish(400, { status: "error", message: "该功能暂不可用。" });
      if (tool.policy?.denied || getToolPolicy(tool.name).denied) return finish(403, { status: "error", message: "该操作不在允许范围内。" });
      if (resolvedActionId && pendingAction?.actionType !== tool.name) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
      const invocation = validateToolInvocation({ agentId: tool.agentId, toolName: tool.name, arguments: plan.arguments || {} });

      if (isRisky(plan) && !plan.confirmed && !resolvedActionId) {
        if (!pendingActionRepository?.create) return finish(500, { status: "error", message: SAFE_FAILURE });
        const code = exactConfirmationCode(String(confirmationCodeFactory()));
        if (!code) return finish(500, { status: "error", message: SAFE_FAILURE });
        const expiresAt = new Date(clock().getTime() + pendingTtlMs).toISOString();
        let action;
        try {
          action = pendingActionRepository.create({
            owner: context.owner,
            channel: context.channel,
            conversationId: conversation?.id,
            actionType: tool.name,
            payload: { plan: { ...plan, arguments: invocation.arguments } },
            confirmationCode: code,
            expiresAt,
          });
        } catch (error) {
          if (error?.status === 409 || error?.code === "ASSISTANT_ACTION_PENDING") {
            return finish(409, { status: "confirmation_required", message: "当前会话已有待确认操作，请先确认或取消。" });
          }
          throw error;
        }
        const publicBody = {
          status: "confirmation_required",
          actionId: action.id,
          toolName: tool.name,
          risk: plan.risk,
          confirmationCode: code,
          ...safePendingResponse(tool, { code }),
        };
        const storedBody = { ...publicBody, text: STORED_CONFIRMATION_TEXT };
        delete storedBody.confirmationCode;
        return finish(200, publicBody, { storedBody, draftText: "等待用户确认。" });
      }

      const handler = toolHandlers[tool.name];
      if (typeof handler !== "function") return finish(400, { status: "error", message: "该功能暂不可用。" });
      if (resolvedActionId) {
        if (typeof pendingActionRepository?.claimExecution !== "function") return finish(500, { status: "error", message: SAFE_FAILURE });
        const claimedAction = pendingActionRepository.claimExecution(resolvedActionId, {
          owner: context.owner,
          channel: context.channel,
          conversationId: conversation?.id,
        });
        if (claimedAction.replayed) return finish(200, { status: "ok", actionId: resolvedActionId, result: claimedAction.item.result ?? null });
        if (claimedAction.inProgress) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE }, { draftText: "确认信息已处理。" });
        actionLease = { leaseToken: claimedAction.leaseToken };
      }
      let toolRun = null;
      if (
        typeof eventRepository.createToolRun === "function"
        && typeof eventRepository.claimToolRun === "function"
        && typeof eventRepository.completeToolRun === "function"
      ) {
        const finishToolReplay = (output) => {
          if (resolvedActionId && actionLease) {
            pendingActionRepository.completeExecution(resolvedActionId, {
              owner: context.owner,
              channel: context.channel,
              conversationId: conversation?.id,
              leaseToken: actionLease.leaseToken,
              result: output,
            });
          }
          return finish(200, { status: "ok", toolName: tool.name, result: output }, {
            draftText: confirmationContext ? "确认信息已处理。" : "ok",
          });
        };
        const createdRun = eventRepository.createToolRun({
          owner: context.owner,
          channel: context.channel,
          eventId: resolvedActionId ? `assistant-action:${resolvedActionId}` : context.event,
          toolName: tool.name,
          requestHash: resolvedActionId
            ? actionToolRunDigest({ actionId: resolvedActionId, toolName: tool.name, arguments: invocation.arguments })
            : requestHash,
          input: invocation.arguments,
        });
        if (createdRun.replayed && createdRun.item?.output) {
          return finishToolReplay(createdRun.item.output);
        }
        const claimedRun = eventRepository.claimToolRun(createdRun.item.id);
        if (claimedRun.replayed && claimedRun.item?.output) {
          return finishToolReplay(claimedRun.item.output);
        }
        toolRun = { id: createdRun.item.id, leaseToken: claimedRun.leaseToken };
      }
      const handlerContext = resolvedActionId
        ? Object.freeze({ ...context, actionId: resolvedActionId })
        : context;
      const result = await handler(Object.freeze({ ...invocation.arguments }), handlerContext, serverData);
      if (toolRun) {
        eventRepository.completeToolRun(toolRun.id, { leaseToken: toolRun.leaseToken, output: result });
      }
      if (resolvedActionId && actionLease) {
        pendingActionRepository.completeExecution(resolvedActionId, {
          owner: context.owner,
          channel: context.channel,
          conversationId: conversation?.id,
          leaseToken: actionLease.leaseToken,
          result,
        });
      }
      return finish(200, { status: "ok", toolName: tool.name, result }, {
        draftText: confirmationContext ? "确认信息已处理。" : "ok",
      });
    } catch (error) {
      if (resolvedActionId && actionLease && typeof pendingActionRepository?.releaseExecution === "function") {
        try {
          pendingActionRepository.releaseExecution(resolvedActionId, {
            owner: context.owner,
            channel: context.channel,
            conversationId: conversation?.id,
            leaseToken: actionLease.leaseToken,
            errorCode: "ASSISTANT_ACTION_EXECUTION_FAILED",
          });
        } catch { /* preserve the safe outward response */ }
      }
      return fail(error);
    }
  }

  return Object.freeze({ handle });
}
