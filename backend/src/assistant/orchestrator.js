import { createHash, randomInt } from "node:crypto";

import { createAssistantRouter } from "./router.js";
import { createAgentRegistry } from "./agentRegistry.js";
import { validateToolInvocation } from "./contracts.js";
import { getToolPolicy } from "./policy.js";

const SAFE_FAILURE = "处理失败，请稍后重试。";
const SAFE_CONFIRMATION_FAILURE = "确认信息无效或已过期，请重新发起操作。";
const VALID_CONTEXT = ["owner", "channel", "conversation", "event", "requestId"];

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
  clock = () => new Date(),
  pendingTtlMs = 10 * 60 * 1000,
} = {}) {
  if (!eventRepository || typeof eventRepository.receive !== "function" || typeof eventRepository.claim !== "function") {
    throw new TypeError("eventRepository must support receive and claim");
  }

  async function handle({ context: rawContext, input: rawInput = {}, serverData: rawServerData } = {}) {
    const context = makeContext(rawContext);
    const serverData = makeServerData(rawServerData);
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
    const text = typeof input.text === "string" ? input.text : "";
    const confidence = input.confidence === undefined ? undefined : Number(input.confidence);
    const pendingActionId = input.pendingActionId === undefined ? null : requiredText(input.pendingActionId, "pendingActionId", 300);
    const requestHash = requestDigest({
      text,
      confidence,
      pendingActionId,
      confirmationCode: input.confirmationCode,
      mediaSha256: serverData.media?.sha256,
    });
    const received = eventRepository.receive({
      owner: context.owner,
      channel: context.channel,
      eventId: context.event,
      requestHash,
      auditMetadata: serverData.auditMetadata,
      payload: {
        text,
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
    append("user", text || "(empty)");

    const finish = (status, body, storedBody = body) => {
      append("assistant", body.message || body.status || "completed");
      eventRepository.complete(eventId, { leaseToken, responseStatus: status, response: storedBody });
      return response(status, body);
    };
    const fail = (error, status = 500) => {
      const body = genericFailure(status).body;
      try {
        if (typeof eventRepository.fail === "function") eventRepository.fail(eventId, { leaseToken, responseStatus: status, response: body, errorCode: "ASSISTANT_INTERNAL_ERROR" });
        else eventRepository.complete(eventId, { leaseToken, responseStatus: status, response: body });
      } catch { /* preserve the safe outward response */ }
      return response(status, body);
    };

    let actionLease = null;
    try {
      let pendingPlan;
      let pendingAction;
      if (pendingActionId) {
        pendingAction = pendingActionRepository?.get?.(pendingActionId, {
          owner: context.owner,
          channel: context.channel,
          conversationId: conversation?.id,
        });
        if (!pendingAction) return finish(404, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
        if (pendingAction.status === "executed") return finish(200, { status: "ok", actionId: pendingActionId, result: pendingAction.result ?? null });
        if (["expired", "cancelled", "failed"].includes(pendingAction.status)) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
        pendingPlan = pendingAction.payload?.plan || pendingAction.payload;
        if (input.confirmationCode === undefined && typeof pendingActionRepository?.renewConfirmation === "function") {
          try {
            const replacementCode = requiredText(String(confirmationCodeFactory()), "confirmationCode", 100);
            const renewed = pendingActionRepository.renewConfirmation(pendingActionId, {
              owner: context.owner,
              channel: context.channel,
              conversationId: conversation?.id,
              confirmationCode: replacementCode,
            });
            const replacementBody = {
              status: "confirmation_required",
              actionId: pendingActionId,
              toolName: pendingAction.actionType,
              risk: pendingPlan.risk,
              confirmationCode: renewed.confirmationCode,
              message: "Confirmation code reissued; send it with the action id to continue.",
            };
            const storedReplacement = { ...replacementBody };
            delete storedReplacement.confirmationCode;
            return finish(200, replacementBody, storedReplacement);
          } catch {
            return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
          }
        }
        if (!pendingPlan || typeof pendingPlan !== "object" || Array.isArray(pendingPlan)) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
        if (input.confirmationCode === undefined) return finish(409, { status: "confirmation_required", actionId: pendingActionId, message: "请提供确认码后再执行。" });
        try {
          const confirmed = pendingActionRepository?.confirm?.(pendingActionId, {
            owner: context.owner,
            channel: context.channel,
            conversationId: conversation?.id,
            confirmationCode: String(input.confirmationCode),
          });
          if (confirmed?.expired) return finish(410, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
          if (confirmed?.inProgress) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
          pendingAction = confirmed?.item ?? pendingAction;
          pendingPlan = pendingAction.payload?.plan || pendingAction.payload;
        } catch {
          return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
        }
      }

      const plan = pendingActionId
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
      if (pendingActionId && pendingAction?.actionType !== tool.name) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
      const invocation = validateToolInvocation({ agentId: tool.agentId, toolName: tool.name, arguments: plan.arguments || {} });

      if (isRisky(plan) && !plan.confirmed && !pendingActionId) {
        if (!pendingActionRepository?.create) return finish(500, { status: "error", message: SAFE_FAILURE });
        const code = requiredText(String(confirmationCodeFactory()), "confirmationCode", 100);
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
          message: "该操作需要确认，请回复确认码。",
        };
        const storedBody = { ...publicBody };
        delete storedBody.confirmationCode;
        return finish(200, publicBody, storedBody);
      }

      const handler = toolHandlers[tool.name];
      if (typeof handler !== "function") return finish(400, { status: "error", message: "该功能暂不可用。" });
      if (pendingActionId) {
        if (typeof pendingActionRepository?.claimExecution !== "function") return finish(500, { status: "error", message: SAFE_FAILURE });
        const claimedAction = pendingActionRepository.claimExecution(pendingActionId, {
          owner: context.owner,
          channel: context.channel,
          conversationId: conversation?.id,
        });
        if (claimedAction.replayed) return finish(200, { status: "ok", actionId: pendingActionId, result: claimedAction.item.result ?? null });
        if (claimedAction.inProgress) return finish(409, { status: "error", message: SAFE_CONFIRMATION_FAILURE });
        actionLease = { leaseToken: claimedAction.leaseToken };
      }
      let toolRun = null;
      if (
        typeof eventRepository.createToolRun === "function"
        && typeof eventRepository.claimToolRun === "function"
        && typeof eventRepository.completeToolRun === "function"
      ) {
        const finishToolReplay = (output) => {
          if (pendingActionId && actionLease) {
            pendingActionRepository.completeExecution(pendingActionId, {
              owner: context.owner,
              channel: context.channel,
              conversationId: conversation?.id,
              leaseToken: actionLease.leaseToken,
              result: output,
            });
          }
          return finish(200, { status: "ok", toolName: tool.name, result: output });
        };
        const createdRun = eventRepository.createToolRun({
          owner: context.owner,
          channel: context.channel,
          eventId: pendingActionId ? `assistant-action:${pendingActionId}` : context.event,
          toolName: tool.name,
          requestHash: pendingActionId
            ? actionToolRunDigest({ actionId: pendingActionId, toolName: tool.name, arguments: invocation.arguments })
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
      const handlerContext = pendingActionId
        ? Object.freeze({ ...context, actionId: pendingActionId })
        : context;
      const result = await handler(Object.freeze({ ...invocation.arguments }), handlerContext, serverData);
      if (toolRun) {
        eventRepository.completeToolRun(toolRun.id, { leaseToken: toolRun.leaseToken, output: result });
      }
      if (pendingActionId && actionLease) {
        pendingActionRepository.completeExecution(pendingActionId, {
          owner: context.owner,
          channel: context.channel,
          conversationId: conversation?.id,
          leaseToken: actionLease.leaseToken,
          result,
        });
      }
      return finish(200, { status: "ok", toolName: tool.name, result });
    } catch (error) {
      if (pendingActionId && actionLease && typeof pendingActionRepository?.releaseExecution === "function") {
        try {
          pendingActionRepository.releaseExecution(pendingActionId, {
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
