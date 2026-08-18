import { createHmac, randomUUID, createHash } from "node:crypto";

import { HttpError } from "../http/errors.js";
import {
  applyShortcutBookkeepingCorrection,
  parseShortcutBookkeepingCorrection,
  projectShortcutBookkeepingDraft,
} from "../integrations/shortcutBookkeepingAssistant.js";

export const SHORTCUT_BOOKKEEPING_ACTION = "shortcut-bookkeeping.confirm";
export const SHORTCUT_BOOKKEEPING_CHANNEL = "weixin";

const CONFIRMATION_WARNING = "WEIXIN_CONFIRMATION_REQUIRED";
const MAX_MESSAGE_LENGTH = 20_000;

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function secretBuffer(value) {
  const key = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Buffer.isBuffer(key) || key.length < 32) throw new TypeError("confirmationSecret must contain at least 32 bytes");
  return key;
}

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid Date");
  return date.toISOString();
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return null;
  return value;
}

function assistantDateTime(value) {
  const day = dateOnly(value);
  if (day) return `${day}T12:00:00+08:00`;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatMoney(cents) {
  return Number.isSafeInteger(cents) && cents >= 0 ? `${(cents / 100).toFixed(2)} 元` : "待确认";
}

function fieldText(value, fallback = "待确认") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stableConversationScope(owner, senderId) {
  return `weixin:shortcut:v1:${sha256(`${owner}\u0000${senderId}`)}`;
}

export function deriveShortcutConfirmationCode(actionId, version, confirmationSecret) {
  const id = requiredText(actionId, "actionId", 200);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("version must be a positive safe integer");
  const digest = createHmac("sha256", secretBuffer(confirmationSecret))
    .update(`sentelligent/shortcut-weixin-confirmation/v1\u0000${id}\u0000${version}`, "utf8")
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function actionPayload(action) {
  const payload = action?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  if (!entryId || entryId.length > 200) return null;
  return { entryId };
}

function entryAnalysis(entry) {
  const analysis = entry?.analysis && typeof entry.analysis === "object" && !Array.isArray(entry.analysis)
    ? entry.analysis
    : {};
  const expense = analysis.expense && typeof analysis.expense === "object" && !Array.isArray(analysis.expense)
    ? analysis.expense
    : {};
  return { analysis, expense };
}

function draftFromEntry(entry) {
  const { expense } = entryAnalysis(entry);
  return projectShortcutBookkeepingDraft({
    fields: {
      occurredOn: assistantDateTime(expense.occurredOn ?? entry.occurredOn),
      amountCents: expense.amountCents ?? entry.amountCents,
      merchant: expense.merchant ?? entry.merchant,
      purpose: expense.purpose ?? entry.purpose,
      note: entry.note,
      category: entry.category,
      subcategory: entry.subcategory,
    },
  });
}

function renderDraftMessage(entry, action, code, { prefix = "待确认快捷记账" } = {}) {
  const draft = draftFromEntry(entry);
  const fields = draft.fields;
  const lines = [
    `${prefix}（小小 AI 识别）`,
    `日期：${fieldText(fields.occurredOn)}`,
    `金额：${formatMoney(fields.amountCents)}`,
    `商户：${fieldText(fields.merchant)}`,
    `用途：${fieldText(fields.purpose)}`,
    `分类：${fieldText(fields.category)}${fields.subcategory ? ` / ${fields.subcategory}` : ""}`,
    `备注：${fieldText(fields.note, "无")}`,
  ];
  if (draft.warnings.length) lines.push(`待补充：${draft.warnings.slice(0, 4).join("、")}`);
  lines.push(
    "确认无误后，请在同一微信会话回复下面六位确认码：",
    code,
    "修改示例：金额改为 18.50 元；时间改为 2026-08-19T10:20:00+08:00；商户改为济南客户。",
    "回复“取消”放弃本笔，回复“重发确认码”重新发送。",
  );
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function resultMessage(entry) {
  return `已确认并录入森特智行：${entry.expenseReferenceCode ?? entry.expenseId ?? entry.id}，金额 ${formatMoney(entry.amountCents)}。`;
}

function acceptedResult(entry) {
  return {
    entryId: entry.id,
    expenseId: entry.expenseId ?? null,
    paymentId: entry.paymentId ?? null,
  };
}

function isFinalizable(entry) {
  const { analysis, expense } = entryAnalysis(entry);
  const occurredOn = dateOnly(expense.occurredOn ?? entry.occurredOn);
  const amountCents = expense.amountCents ?? entry.amountCents;
  const purpose = expense.purpose ?? entry.purpose;
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings.filter((item) => item !== CONFIRMATION_WARNING) : [];
  return Boolean(occurredOn && Number.isSafeInteger(amountCents) && amountCents > 0 && typeof purpose === "string" && purpose.trim() && warnings.length === 0);
}

function reviewAnalysis(entry, nextFields) {
  const { analysis, expense } = entryAnalysis(entry);
  const occurredOn = typeof nextFields.occurredOn === "string" ? nextFields.occurredOn.slice(0, 10) : expense.occurredOn ?? entry.occurredOn ?? null;
  const nextExpense = {
      ...expense,
      ...(occurredOn ? { occurredOn } : {}),
      ...(Object.hasOwn(nextFields, "amountCents") ? { amountCents: nextFields.amountCents, reimbursementCents: nextFields.amountCents } : {}),
      ...(Object.hasOwn(nextFields, "merchant") ? { merchant: nextFields.merchant } : {}),
    ...(Object.hasOwn(nextFields, "purpose") ? { purpose: nextFields.purpose } : {}),
  };
  const warnings = Array.isArray(analysis.warnings)
    ? analysis.warnings.filter((item) => item !== CONFIRMATION_WARNING)
    : [];
  return {
    ...analysis,
    status: "review_required",
    expense: nextExpense,
    warnings: [...new Set([...warnings, CONFIRMATION_WARNING])],
  };
}

function correctionHelp() {
  return "我只接受明确字段修改，例如“金额改为 18.50 元”“时间改为 2026-08-19T10:20:00+08:00”“商户改为济南客户”“用途改为客户拜访”。账号、账本、幂等键和确认码不能修改。";
}

export function createShortcutBookkeepingAssistantRuntime({
  db,
  config,
  shortcutBookkeepingRepository,
  pendingActionRepository,
  sessionRepository,
  outboxRepository,
  idFactory = randomUUID,
  clock = () => new Date(),
  confirmationSecret,
} = {}) {
  if (!db || !shortcutBookkeepingRepository || !pendingActionRepository || !sessionRepository || !outboxRepository) {
    throw new TypeError("Shortcut WeChat assistant runtime dependencies are required");
  }
  const secret = secretBuffer(confirmationSecret);
  const enabled = config?.shortcutWeixinConfirmationEnabled === true;
  const senderId = String(config?.weixinBookkeepingSenderId ?? "").trim()
    || (Array.isArray(config?.weixinAllowedSenderIds) && config.weixinAllowedSenderIds.length === 1 ? config.weixinAllowedSenderIds[0] : "");
  const owner = String(config?.weixinBookkeepingOwner ?? config?.weixinAgentOwner ?? "").trim();

  function assertEnabledFor(account) {
    if (!enabled) throw new HttpError(503, "SHORTCUT_WEIXIN_CONFIRMATION_DISABLED", "快捷记账微信复核尚未启用");
    if (!senderId || !owner || account !== owner) {
      throw new HttpError(503, "SHORTCUT_WEIXIN_CONFIRMATION_NOT_READY", "快捷记账微信复核尚未完成绑定");
    }
  }

  function conversationFor(account, requestedSender = senderId) {
    assertEnabledFor(account);
    if (requestedSender !== senderId) throw new HttpError(403, "WEIXIN_SENDER_NOT_ALLOWED", "This WeChat sender is not allowed for Shortcut confirmation");
    return stableConversationScope(account, senderId);
  }

  function findActionForEntry(account, entryId) {
    const row = db.prepare(`
      SELECT * FROM assistant_pending_actions
      WHERE owner = $owner AND channel = $channel AND action_type = $actionType
        AND json_extract(payload_json, '$.entryId') = $entryId
        AND status IN ('pending', 'confirmed', 'processing')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({ $owner: account, $channel: SHORTCUT_BOOKKEEPING_CHANNEL, $actionType: SHORTCUT_BOOKKEEPING_ACTION, $entryId: entryId });
    if (!row) return null;
    return pendingActionRepository.get(row.id, {
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: row.conversation_id,
    });
  }

  function enqueue(account, conversationId, action, entryId, kind = "confirmation") {
    const version = Number(action?.version ?? 1);
    return outboxRepository.enqueue({
      owner: account,
      conversationId,
      idempotencyKey: `shortcut-bookkeeping:${entryId}:${kind}:v${version}`,
      payload: { actionId: action.id, entryId, version, kind },
    });
  }

  function startReview({ account, entry }) {
    const conversationId = conversationFor(account);
    const existing = findActionForEntry(account, entry.id);
    if (existing) {
      enqueue(account, existing.conversationId, existing, entry.id, "confirmation");
      return { action: existing, conversationId, replayed: true };
    }
    const actionId = requiredText(idFactory(), "actionId", 200);
    const code = deriveShortcutConfirmationCode(actionId, 1, secret);
    const conversation = sessionRepository.getOrCreate({
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId,
    });
    const expiresAt = new Date(Date.parse(iso(clock)) + 10 * 60 * 1000).toISOString();
    const action = pendingActionRepository.create({
      id: actionId,
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: conversation.id,
      actionType: SHORTCUT_BOOKKEEPING_ACTION,
      payload: { entryId: entry.id },
      confirmationCode: code,
      expiresAt,
    });
    enqueue(account, conversation.id, action, entry.id, "confirmation");
    return { action, conversationId, replayed: false };
  }

  function renderOutboxMessage(outboxItem) {
    const payload = outboxItem?.payload;
    if (!payload || typeof payload !== "object") throw new TypeError("outbox payload is invalid");
    if (payload.kind === "accepted") {
      const row = db.prepare(`
        SELECT entry.*, expense.reference_code AS expense_reference_code
        FROM shortcut_bookkeeping_entries entry
        LEFT JOIN travel_expenses expense ON expense.id = entry.expense_id
        WHERE entry.id = $id AND entry.owner = $owner
      `).get({ $id: payload.entryId, $owner: outboxItem.owner });
      if (!row) throw new Error("entry_not_found");
      return resultMessage({
        expenseReferenceCode: row.expense_reference_code,
        expenseId: row.expense_id,
        id: row.id,
        amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
      });
    }
    const entry = shortcutBookkeepingRepository.getReview(payload.entryId, { owner: outboxItem.owner });
    if (!entry) throw new Error("entry_not_found");
    const action = pendingActionRepository.get(payload.actionId, {
      owner: outboxItem.owner,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: outboxItem.conversationId,
    });
    if (!action) throw new Error("action_not_found");
    if (payload.kind === "cancelled") return `已取消快捷记账 ${entry.id}，未写入费用和付款凭证。`;
    const code = deriveShortcutConfirmationCode(action.id, action.version, secret);
    return renderDraftMessage(entry, action, code, { prefix: payload.kind === "confirmation" ? "待确认快捷记账" : "已更新快捷记账草稿" });
  }

  function acceptedResponse(entry) {
    return {
      status: 200,
      body: { status: "ok", text: "这笔记账已经完成。", result: acceptedResult(entry) },
      draftText: "确认信息已处理。",
    };
  }

  function enqueueAcceptedReceipt({ account, scope, action, entry }) {
    try {
      enqueue(
        account,
        outboxScopeConversation(scope),
        { ...action, version: Number(action.version) + 1 },
        entry.id,
        "accepted",
      );
    } catch {
      // The idempotent outbox can be retried by the next reconciliation pass.
    }
  }

  function reconcileAcceptedEntry({ action, account, scope, code, entry }) {
    const result = acceptedResult(entry);
    let confirmed;
    try {
      confirmed = pendingActionRepository.confirm(action.id, { ...scope, confirmationCode: code });
    } catch (error) {
      if (error?.code === "ASSISTANT_CONFIRMATION_INVALID") {
        try {
          pendingActionRepository.recordConfirmationFailure(action.id, {
            ...scope,
            eventId: `shortcut:${entry.id}:${code}`,
          });
        } catch { /* preserve the bounded response */ }
      }
      return { status: 409, body: { status: "error", text: "确认码无效或已过期，请使用最新消息中的确认码。" }, draftText: "确认信息已处理。" };
    }
    if (confirmed?.expired) return { status: 410, body: { status: "error", text: "确认码已过期，请重新发起快捷记账。" }, draftText: "确认信息已处理。" };
    if (confirmed?.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    const currentAction = confirmed?.item ?? action;
    if (currentAction.status === "executed") {
      enqueueAcceptedReceipt({ account, scope, action: currentAction, entry });
      return acceptedResponse(entry);
    }
    const claimedAction = pendingActionRepository.claimExecution(action.id, scope);
    if (claimedAction.replayed) {
      enqueueAcceptedReceipt({ account, scope, action: claimedAction.item ?? action, entry });
      return acceptedResponse(entry);
    }
    if (claimedAction.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    try {
      pendingActionRepository.completeExecution(action.id, {
        ...scope,
        leaseToken: claimedAction.leaseToken,
        result: { status: "accepted", ...result },
      });
      enqueueAcceptedReceipt({ account, scope, action, entry });
      return acceptedResponse(entry);
    } catch (error) {
      try {
        pendingActionRepository.releaseExecution(action.id, {
          ...scope,
          leaseToken: claimedAction.leaseToken,
          errorCode: "WEIXIN_CONFIRMATION_RECOVERY_FAILED",
        });
      } catch { /* preserve the original failure for the next retry */ }
      throw error;
    }
  }

  async function confirm({ action, account, scope, code }) {
    const target = actionPayload(action);
    if (!target || !code) return { status: 409, body: { status: "error", text: "确认码无效或草稿已过期。" }, draftText: "确认信息已处理。" };
    const entry = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account });
    if (!entry) return { status: 200, body: { status: "ok", text: "这笔记账已经完成。" }, draftText: "确认信息已处理。" };
    if (entry.status === "accepted") return reconcileAcceptedEntry({ action, account, scope, code, entry });
    if (!isFinalizable(entry)) return { status: 409, body: { status: "review_required", text: `当前草稿还有待确认字段。${correctionHelp()}` }, draftText: "仍需补充记账字段。" };
    let confirmed;
    try {
      confirmed = pendingActionRepository.confirm(action.id, { ...scope, confirmationCode: code });
    } catch (error) {
      if (error?.code === "ASSISTANT_CONFIRMATION_INVALID") {
        try { pendingActionRepository.recordConfirmationFailure(action.id, { ...scope, eventId: `shortcut:${target.entryId}:${code}` }); } catch { /* bounded failure path */ }
      }
      return { status: 409, body: { status: "error", text: "确认码无效或已过期，请使用最新消息中的确认码。" }, draftText: "确认信息已处理。" };
    }
    if (confirmed?.expired) return { status: 410, body: { status: "error", text: "确认码已过期，请重新发起快捷记账。" }, draftText: "确认信息已处理。" };
    if (confirmed?.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    const currentAction = confirmed.item ?? action;
    if (currentAction.status === "executed") return { status: 200, body: { status: "ok", text: "这笔记账已经完成。" }, draftText: "确认信息已处理。" };
    const claimedAction = pendingActionRepository.claimExecution(action.id, scope);
    if (claimedAction.replayed) return { status: 200, body: { status: "ok", text: "这笔记账已经完成。" }, draftText: "确认信息已处理。" };
    if (claimedAction.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    let claimedEntry;
    try {
      claimedEntry = shortcutBookkeepingRepository.claimReview(target.entryId, { owner: account });
      if (claimedEntry.replayed) {
        pendingActionRepository.completeExecution(action.id, { ...scope, leaseToken: claimedAction.leaseToken, result: { status: "accepted", entryId: target.entryId } });
        return { status: 200, body: { status: "ok", text: "这笔记账已经完成。" }, draftText: "确认信息已处理。" };
      }
      const { analysis } = entryAnalysis(entry);
      const finalAnalysis = { ...analysis, status: "ready", warnings: [] };
      const completed = shortcutBookkeepingRepository.completeLocal(target.entryId, {
        analysis: finalAnalysis,
        leaseToken: claimedEntry.leaseToken,
      });
      pendingActionRepository.completeExecution(action.id, {
        ...scope,
        leaseToken: claimedAction.leaseToken,
        result: { status: "accepted", ...acceptedResult(completed.item) },
      });
      const accepted = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account }) ?? completed.item;
      enqueueAcceptedReceipt({ account, scope, action, entry: accepted });
      return {
        status: 200,
        body: { status: "ok", text: resultMessage(accepted), result: { entryId: target.entryId, expenseId: completed.item.expenseId, paymentId: completed.item.paymentId } },
        draftText: "已确认并完成记账。",
      };
    } catch (error) {
      if (claimedEntry?.leaseToken) {
        try { shortcutBookkeepingRepository.release(target.entryId, { leaseToken: claimedEntry.leaseToken, errorCode: "WEIXIN_CONFIRMATION_WRITE_FAILED" }); } catch { /* preserve safe response */ }
      }
      try { pendingActionRepository.releaseExecution(action.id, { ...scope, leaseToken: claimedAction.leaseToken, errorCode: "WEIXIN_CONFIRMATION_WRITE_FAILED" }); } catch { /* preserve safe response */ }
      throw error;
    }
  }

  function outboxScopeConversation(scope) {
    return requiredText(scope.conversationId, "conversationId", 200);
  }

  async function cancel({ action, account, scope }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const cancelled = pendingActionRepository.cancel(action.id, scope);
    if (!cancelled.replayed) {
      try { shortcutBookkeepingRepository.rejectReview(target.entryId, { owner: account, actor: account, reason: "微信用户取消" }); } catch { /* already terminal is idempotent */ }
      try { enqueue(account, outboxScopeConversation(scope), action, target.entryId, "cancelled"); } catch { /* best effort */ }
    }
    return { status: 200, body: { status: "cancel", text: "已取消当前快捷记账，未写入费用。" }, draftText: "已取消快捷记账。" };
  }

  async function resend({ action, account, scope }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const nextCode = deriveShortcutConfirmationCode(action.id, Number(action.version) + 1, secret);
    const renewed = pendingActionRepository.renewConfirmation(action.id, { ...scope, confirmationCode: nextCode });
    enqueue(account, outboxScopeConversation(scope), renewed.item, target.entryId, "resend");
    return { status: 200, body: { status: "confirmation_required", text: "已重新生成确认码，请查看微信中的最新草稿消息。" }, draftText: "已重新发送确认码。" };
  }

  async function revise({ action, account, scope, text }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const correction = parseShortcutBookkeepingCorrection(text);
    if (correction.status !== "accepted") {
      return { status: 200, body: { status: "clarify", text: correctionHelp() }, draftText: "等待明确的字段修改。" };
    }
    const entry = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account });
    if (!entry || entry.status !== "review_required") return { status: 409, body: { status: "error", text: "这笔草稿已结束，不能再修改。" }, draftText: "草稿状态已变化。" };
    const currentDraft = draftFromEntry(entry);
    const nextDraft = applyShortcutBookkeepingCorrection(currentDraft, correction);
    if (nextDraft.status !== "ready" && nextDraft.status !== "review_required") {
      return { status: 200, body: { status: "clarify", text: correctionHelp() }, draftText: "修改未通过字段校验。" };
    }
    const analysis = reviewAnalysis(entry, nextDraft.fields);
    const claimed = shortcutBookkeepingRepository.claimReview(target.entryId, { owner: account });
    if (claimed.replayed) return { status: 409, body: { status: "error", text: "这笔草稿已结束，不能再修改。" }, draftText: "草稿状态已变化。" };
    try {
      const reviewPatch = Object.fromEntries(
        ["category", "subcategory", "note"]
          .filter((field) => Object.hasOwn(nextDraft.fields, field))
          .map((field) => [field, nextDraft.fields[field]]),
      );
      const updated = shortcutBookkeepingRepository.completeLocal(target.entryId, {
        analysis,
        leaseToken: claimed.leaseToken,
        reviewPatch,
      });
      const nextCode = deriveShortcutConfirmationCode(action.id, Number(action.version) + 1, secret);
      const renewed = pendingActionRepository.renewConfirmation(action.id, { ...scope, confirmationCode: nextCode });
      enqueue(account, outboxScopeConversation(scope), renewed.item, target.entryId, "correction");
      return { status: 200, body: { status: "review_required", text: "已按你的修改更新草稿，请查看微信中的最新识别结果并回复确认码。", item: { id: updated.item.id, status: updated.item.status } }, draftText: "已更新快捷记账草稿。" };
    } catch (error) {
      try { shortcutBookkeepingRepository.release(target.entryId, { leaseToken: claimed.leaseToken, errorCode: "WEIXIN_CORRECTION_FAILED" }); } catch { /* preserve safe response */ }
      throw error;
    }
  }

  async function handlePending({ action, scope, context, text, textClassification, confirmationCode, pendingActionId }) {
    if (!action || action.actionType !== SHORTCUT_BOOKKEEPING_ACTION) return null;
    if (pendingActionId && pendingActionId !== action.id) {
      return { status: 409, body: { status: "error", text: "当前会话的待确认操作已变化，请查看最新微信消息。" }, draftText: "确认信息已处理。" };
    }
    const account = context.owner;
    if (textClassification.kind === "code" || confirmationCode) return confirm({ action, account, scope, code: confirmationCode ?? text });
    if (textClassification.kind === "cancel") return cancel({ action, account, scope });
    if (textClassification.kind === "resend") return resend({ action, account, scope });
    if (/^(?:确认|confirm|确认入账)$/iu.test(String(text).trim())) {
      return { status: 200, body: { status: "confirmation_required", text: "请回复最新消息中的六位确认码，确认后才会写入费用和付款凭证。" }, draftText: "等待六位确认码。" };
    }
    return revise({ action, account, scope, text });
  }

  return Object.freeze({
    enabled,
    senderId,
    owner,
    conversationFor,
    startReview,
    renderOutboxMessage,
    handlePending,
  });
}
