import { createHmac, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import {
  applyShortcutBookkeepingCorrection,
  parseShortcutBookkeepingCorrection,
  projectShortcutBookkeepingDraft,
} from "../integrations/shortcutBookkeepingAssistant.js";
import { shortcutBookkeepingConversationId } from "../weixin/bookkeepingDeliveryScope.js";

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

function formatBookkeepingTime(value) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "待确认";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueOf("year")}年${valueOf("month")}月${valueOf("day")}日 ${valueOf("hour")}:${valueOf("minute")}`;
}

function fieldText(value, fallback = "待确认") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function deriveShortcutStateCredential(actionId, version, confirmationSecret) {
  const id = requiredText(actionId, "actionId", 200);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("version must be a positive safe integer");
  const digest = createHmac("sha256", secretBuffer(confirmationSecret))
    .update(`sentelligent/shortcut-weixin-confirmation/v1\u0000${id}\u0000${version}`, "utf8")
    .digest();
  // The shared pending-action repository still stores a six-digit hash. This
  // credential is an internal state-transition fence only: it is never shown
  // to the user and user-supplied six-digit values are never accepted here.
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
      occurredOn: assistantDateTime(
        expense.paidAt
          ?? entry.capturedAt
          ?? entry.createdAt
          ?? expense.occurredOn
          ?? entry.occurredOn,
      ),
      amountCents: expense.amountCents ?? entry.amountCents,
      merchant: expense.merchant ?? entry.merchant,
      purpose: expense.purpose ?? entry.purpose,
      note: entry.note,
      category: entry.category,
      subcategory: entry.subcategory,
    },
  });
}

function renderDraftMessage(entry, { prefix = "检测到一笔新记账，请确认！" } = {}) {
  const draft = draftFromEntry(entry);
  const fields = draft.fields;
  const entryType = entry.entryType === "income" ? "收入" : "支出";
  const category = [entryType, fields.category, fields.subcategory].filter(Boolean).join(" / ");
  const note = fields.note || fields.purpose;
  const lines = [
    prefix,
    `时间：${formatBookkeepingTime(fields.occurredOn)}`,
    `金额：${formatMoney(fields.amountCents)}`,
    `费用类别：${fieldText(category)}`,
    `备注：${fieldText(note, "无")}`,
  ];
  if (draft.warnings.length) lines.push(`待补充：${draft.warnings.slice(0, 4).join("、")}`);
  lines.push(
    "确认无误请回复“确认”。",
    "需要修改请以“修改”开头，例如：修改金额为 18.50 元；修改时间为 2026-08-19T10:20:00+08:00；修改费用类别为交通；修改备注为客户拜访。修改后我会重新发送最新信息。",
    "回复“取消”放弃本次记账。",
  );
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function resultMessage(entry) {
  return `已确认并录入森特智行：${entry.expenseReferenceCode ?? entry.expenseId ?? entry.id}，金额 ${formatMoney(entry.amountCents)}。`;
}

function explicitModification(value) {
  const match = /^修改(?:[：:\s]+)?(.+)$/su.exec(String(value ?? ""));
  return match?.[1]?.trim() || null;
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
      ...(typeof nextFields.occurredOn === "string" ? { paidAt: nextFields.occurredOn } : {}),
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
  return "请以“修改”开头并明确字段，例如“修改金额为 18.50 元”“修改时间为 2026-08-19T10:20:00+08:00”“修改费用类别为交通”“修改备注为客户拜访”。账号、账本、幂等键和系统身份不能修改。";
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
  const senderAllowed = Array.isArray(config?.weixinAllowedSenderIds)
    && config.weixinAllowedSenderIds.includes(senderId);
  const ready = enabled && Boolean(senderId) && Boolean(owner) && senderAllowed;

  function isReadyFor(account) {
    return ready && account === owner;
  }

  function assertReadyFor(account) {
    if (!enabled) throw new HttpError(503, "SHORTCUT_WEIXIN_CONFIRMATION_DISABLED", "快捷记账微信复核尚未启用");
    if (!isReadyFor(account)) {
      throw new HttpError(503, "SHORTCUT_WEIXIN_CONFIRMATION_NOT_READY", "快捷记账微信复核尚未完成绑定");
    }
  }

  function conversationFor(account, requestedSender = senderId) {
    assertReadyFor(account);
    if (requestedSender !== senderId) throw new HttpError(403, "WEIXIN_SENDER_NOT_ALLOWED", "This WeChat sender is not allowed for Shortcut confirmation");
    return shortcutBookkeepingConversationId(account, senderId);
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

  function findLatestActionForEntry(account, entryId) {
    const row = db.prepare(`
      SELECT id, conversation_id FROM assistant_pending_actions
      WHERE owner = $owner AND channel = $channel AND action_type = $actionType
        AND json_extract(payload_json, '$.entryId') = $entryId
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({
      $owner: account,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $entryId: entryId,
    });
    if (!row) return null;
    return pendingActionRepository.get(row.id, {
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: row.conversation_id,
    });
  }

  function enqueue(account, conversationId, action, entryId, kind = "confirmation") {
    const accepted = kind === "accepted";
    const version = accepted ? 1 : Number(action?.version ?? 1);
    return outboxRepository.enqueue({
      owner: account,
      conversationId,
      idempotencyKey: `shortcut-bookkeeping:${entryId}:${kind}:v${version}`,
      payload: { actionId: action.id, entryId, version, kind },
    });
  }

  function closePendingOutbox({ account, conversationId, actionId, entryId, errorCode }) {
    if (typeof outboxRepository.closePending !== "function") return;
    try {
      outboxRepository.closePending({
        owner: account,
        conversationId,
        actionId,
        entryId,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Outbox cleanup is best effort. The pending action and bookkeeping
      // state remain authoritative; a worker lease fence still prevents an
      // old message from being acknowledged after a newer decision.
    }
  }

  function settleFromWeb({ account, entry, decision = entry?.status } = {}) {
    const normalizedAccount = requiredText(account, "account", 200);
    const entryId = requiredText(entry?.id, "entryId", 200);
    if (!["accepted", "rejected"].includes(decision) || entry?.status !== decision) {
      throw new TypeError("Web review settlement requires the matching terminal entry status");
    }
    const action = findLatestActionForEntry(normalizedAccount, entryId);
    if (!action) return { action: null, outbox: null, replayed: true };
    const targetStatus = decision === "accepted" ? "executed" : "cancelled";
    const terminalKind = decision === "accepted" ? "accepted" : "cancelled";
    const result = decision === "accepted"
      ? { status: "accepted", ...acceptedResult(entry) }
      : null;
    const resultJson = result ? JSON.stringify(result) : null;
    const now = iso(clock);
    const settled = withImmediateTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM assistant_pending_actions
        WHERE id = $id AND owner = $owner AND channel = $channel
          AND conversation_id = $conversationId AND action_type = $actionType
          AND json_extract(payload_json, '$.entryId') = $entryId
      `).get({
        $id: action.id,
        $owner: normalizedAccount,
        $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
        $conversationId: action.conversationId,
        $actionType: SHORTCUT_BOOKKEEPING_ACTION,
        $entryId: entryId,
      });
      if (!current) {
        throw new HttpError(409, "ASSISTANT_ACTION_STATE_CONFLICT", "Shortcut review action changed during Web settlement");
      }
      const replayed = current.status === targetStatus;
      if (!replayed) {
        const updated = db.prepare(`
          UPDATE assistant_pending_actions
          SET status = $targetStatus, version = version + 1,
              lease_token_hash = NULL, lease_expires_at = NULL,
              result_json = $resultJson,
              error_code = CASE WHEN $targetStatus = 'executed' THEN NULL ELSE error_code END,
              updated_at = $now
          WHERE id = $id AND owner = $owner AND channel = $channel
            AND conversation_id = $conversationId AND action_type = $actionType
            AND json_extract(payload_json, '$.entryId') = $entryId
        `).run({
          $id: action.id,
          $owner: normalizedAccount,
          $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
          $conversationId: action.conversationId,
          $actionType: SHORTCUT_BOOKKEEPING_ACTION,
          $entryId: entryId,
          $targetStatus: targetStatus,
          $resultJson: resultJson,
          $now: now,
        });
        if (updated.changes !== 1) {
          throw new HttpError(409, "ASSISTANT_ACTION_STATE_CONFLICT", "Shortcut review action changed during Web settlement");
        }
        insertAudit(db, {
          action: decision === "accepted"
            ? "assistant.action.execute.external"
            : "assistant.action.cancel.external",
          entityType: "assistant_pending_action",
          entityId: action.id,
          actor: normalizedAccount,
          requestId: action.id,
          before: { status: current.status, version: Number(current.version) },
          after: { status: targetStatus, version: Number(current.version) + 1 },
          metadata: {
            owner: normalizedAccount,
            channel: SHORTCUT_BOOKKEEPING_CHANNEL,
            source: "shortcut-web-review",
          },
        });
      }
      const closed = db.prepare(`
        UPDATE weixin_confirmation_outbox
        SET status = 'failed', lease_proof_hash = NULL, lease_until = NULL,
            last_error_code = $errorCode, updated_at = $now
        WHERE owner = $owner AND conversation_id = $conversationId
          AND status IN ('queued', 'processing')
          AND json_extract(payload_json, '$.actionId') = $actionId
          AND json_extract(payload_json, '$.entryId') = $entryId
          AND COALESCE(json_extract(payload_json, '$.kind'), 'confirmation')
            NOT IN ('accepted', 'cancelled')
      `).run({
        $owner: normalizedAccount,
        $conversationId: action.conversationId,
        $actionId: action.id,
        $entryId: entryId,
        $errorCode: decision === "accepted"
          ? "WEIXIN_OUTBOX_WEB_CONFIRMED"
          : "WEIXIN_OUTBOX_WEB_REJECTED",
        $now: now,
      });
      return { replayed, closedCount: Number(closed.changes ?? 0) };
    });
    const settledAction = pendingActionRepository.get(action.id, {
      owner: normalizedAccount,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: action.conversationId,
    });
    let outbox = null;
    try {
      outbox = enqueue(
        normalizedAccount,
        action.conversationId,
        settledAction ?? action,
        entryId,
        terminalKind,
      );
    } catch {
      // Accepted receipts are reconciled before every worker lease. Rejected
      // decisions are likewise retried by the terminal-review reconciliation.
    }
    return { action: settledAction, outbox, ...settled };
  }

  function startReview({ account, entry }) {
    const conversationId = conversationFor(account);
    const conversation = sessionRepository.getOrCreate({
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId,
    });
    const existing = findActionForEntry(account, entry.id);
    if (existing) {
      const outbox = enqueue(account, existing.conversationId, existing, entry.id, "confirmation");
      return { action: existing, conversationId, outbox, replayed: true };
    }
    const active = pendingActionRepository.findActiveByConversation?.({
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: conversation.id,
    });
    if (active) {
      try {
        shortcutBookkeepingRepository.rejectReview(entry.id, {
          owner: account,
          actor: account,
          reason: "已有快捷记账草稿待确认",
          purge: true,
        });
      } catch { /* preserve the explicit conflict response */ }
      throw new HttpError(409, "ASSISTANT_ACTION_PENDING", "已有一笔快捷记账草稿待确认，请先确认、修改或取消后再提交下一笔。");
    }
    const actionId = requiredText(idFactory(), "actionId", 200);
    const stateCredential = deriveShortcutStateCredential(actionId, 1, secret);
    const expiresAt = new Date(Date.parse(iso(clock)) + 10 * 60 * 1000).toISOString();
    const action = pendingActionRepository.create({
      id: actionId,
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: conversation.id,
      actionType: SHORTCUT_BOOKKEEPING_ACTION,
      payload: { entryId: entry.id },
      confirmationCode: stateCredential,
      expiresAt,
    });
    const outbox = enqueue(account, conversation.id, action, entry.id, "confirmation");
    return { action, conversationId, outbox, replayed: false };
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
        entryType: row.entry_type,
        amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
      });
    }
    const entry = shortcutBookkeepingRepository.getReview(payload.entryId, { owner: outboxItem.owner });
    if (!entry) throw new Error("entry_not_found");
    if (!["accepted", "cancelled"].includes(payload.kind)
      && entry.status !== "review_required") {
      const stale = new Error("stale_outbox");
      stale.code = "WEIXIN_OUTBOX_STALE";
      throw stale;
    }
    const action = pendingActionRepository.get(payload.actionId, {
      owner: outboxItem.owner,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: outboxItem.conversationId,
    });
    if (!action) throw new Error("action_not_found");
    if (payload.kind !== "cancelled" && payload.kind !== "accepted"
      && Number(payload.version) !== Number(action.version)) {
      const stale = new Error("stale_outbox");
      stale.code = "WEIXIN_OUTBOX_STALE";
      throw stale;
    }
    if (payload.kind !== "cancelled" && payload.kind !== "accepted"
      && ["cancelled", "executed"].includes(action.status)) {
      const stale = new Error("stale_outbox");
      stale.code = "WEIXIN_OUTBOX_STALE";
      throw stale;
    }
    if (payload.kind === "cancelled") return `已取消快捷记账 ${entry.id}，未写入费用和付款凭证。`;
    return renderDraftMessage(entry, {
      prefix: payload.kind === "confirmation"
        ? "检测到一笔新记账，请确认！"
        : "记账信息已修改，请重新确认！",
    });
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

  function reconcileAcceptedReceipts({ limit = 20 } = {}) {
    if (!ready) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("limit must be a positive safe integer no greater than 100");
    }
    const rows = db.prepare(`
      SELECT action.id AS action_id, action.owner, action.conversation_id,
             action.version, action.status AS action_status,
             entry.id AS entry_id, entry.status AS entry_status
      FROM assistant_pending_actions action
      JOIN shortcut_bookkeeping_entries entry
        ON entry.id = json_extract(action.payload_json, '$.entryId')
       AND entry.owner = action.owner
      WHERE action.owner = $owner
        AND action.channel = $channel
        AND action.action_type = $actionType
        AND entry.status IN ('accepted', 'rejected')
        AND NOT EXISTS (
          SELECT 1 FROM weixin_confirmation_outbox outbox
          WHERE outbox.owner = action.owner
            AND json_extract(outbox.payload_json, '$.entryId') = entry.id
            AND json_extract(outbox.payload_json, '$.kind') = CASE entry.status
              WHEN 'accepted' THEN 'accepted'
              ELSE 'cancelled'
            END
        )
      ORDER BY action.updated_at ASC, action.id ASC
      LIMIT $limit
    `).all({
      $owner: owner,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $limit: limit,
    });
    return rows.map((row) => {
      const entry = shortcutBookkeepingRepository.getReview(row.entry_id, { owner: row.owner });
      if (!entry || entry.status !== row.entry_status) return null;
      const targetActionStatus = entry.status === "accepted" ? "executed" : "cancelled";
      if (row.action_status === targetActionStatus) {
        return enqueue(
          row.owner,
          row.conversation_id,
          { id: row.action_id, version: Number(row.version) },
          row.entry_id,
          entry.status === "accepted" ? "accepted" : "cancelled",
        );
      }
      return settleFromWeb({ account: row.owner, entry, decision: row.entry_status }).outbox;
    }).filter(Boolean);
  }

  function reconcileAcceptedEntry({ action, account, scope, entry }) {
    let claimed;
    try {
      claimed = pendingActionRepository.claimExecution(action.id, scope);
    } catch (error) {
      if (error?.code === "ASSISTANT_ACTION_NOT_CONFIRMED") {
        return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后再试。" }, draftText: "确认信息已处理。" };
      }
      throw error;
    }
    if (claimed.replayed) {
      enqueueAcceptedReceipt({ account, scope, action: claimed.item ?? action, entry });
      return acceptedResponse(entry);
    }
    if (claimed.inProgress) {
      return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    }
    try {
      pendingActionRepository.completeExecution(action.id, {
        ...scope,
        leaseToken: claimed.leaseToken,
        result: { status: "accepted", ...acceptedResult(entry) },
      });
      enqueueAcceptedReceipt({ account, scope, action, entry });
      return acceptedResponse(entry);
    } catch (error) {
      try {
        pendingActionRepository.releaseExecution(action.id, {
          ...scope,
          leaseToken: claimed.leaseToken,
          errorCode: "WEIXIN_BOOKKEEPING_RECOVERY_FAILED",
        });
      } catch { /* preserve the original failure for the next retry */ }
      throw error;
    }
  }

  function deliveredCurrentDraft({ account, action, entryId }) {
    if (typeof outboxRepository.latestForEntry !== "function") {
      return { payload: { version: Number(action.version) } };
    }
    const latest = outboxRepository.latestForEntry({ owner: account, entryId });
    const payload = latest?.payload;
    const version = Number(payload?.version);
    const delivered = latest?.status === "sent"
      && payload?.actionId === action.id
      && payload?.entryId === entryId
      && Number.isSafeInteger(version)
      && version > 0
      && version <= Number(action.version)
      && !["accepted", "cancelled"].includes(payload?.kind);
    if (!delivered) return null;
    // While pending, a version gap means the internal state fence rotated but
    // the corresponding corrected draft was never delivered. Confirmed or
    // processing actions may legitimately have newer execution-state versions
    // after a transient write failure; their delivered draft remains valid.
    if (action.status === "pending" && version !== Number(action.version)) return null;
    return latest;
  }

  async function confirm({ action, account, scope }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认记账草稿无效或已过期。" }, draftText: "确认信息已处理。" };
    const entry = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account });
    if (!entry) return { status: 200, body: { status: "ok", text: "这笔记账已经完成。" }, draftText: "确认信息已处理。" };
    if (entry.status === "rejected") {
      settleFromWeb({ account, entry, decision: "rejected" });
      return { status: 410, body: { status: "cancel", text: "这笔记账已经取消。" }, draftText: "确认信息已处理。" };
    }
    if (entry.status === "accepted") {
      return reconcileAcceptedEntry({ action, account, scope, entry });
    }
    if (entry.status !== "review_required") {
      return { status: 409, body: { status: "error", text: "这笔记账当前不能确认。" }, draftText: "确认信息已处理。" };
    }
    const deliveredDraft = deliveredCurrentDraft({ account, action, entryId: target.entryId });
    if (!deliveredDraft) {
      return { status: 409, body: { status: "review_required", text: "请先查看小小发送的最新记账草稿，再回复“确认”。" }, draftText: "等待当前版本草稿送达。" };
    }
    if (!isFinalizable(entry)) return { status: 409, body: { status: "review_required", text: `当前草稿还有待确认字段。${correctionHelp()}` }, draftText: "仍需补充记账字段。" };
    let confirmed;
    try {
      confirmed = pendingActionRepository.confirm(action.id, {
        ...scope,
        confirmationCode: deriveShortcutStateCredential(action.id, Number(deliveredDraft.payload.version), secret),
      });
    } catch (error) {
      if (error?.code === "ASSISTANT_ACTION_EXPIRED") {
        return { status: 410, body: { status: "error", text: "这笔记账草稿已过期，请重新发起快捷记账。" }, draftText: "确认信息已处理。" };
      }
      return { status: 409, body: { status: "error", text: "当前草稿确认状态已变化，请重新发起快捷记账。" }, draftText: "确认信息已处理。" };
    }
    if (confirmed?.expired) return { status: 410, body: { status: "error", text: "这笔记账草稿已过期，请重新发起快捷记账。" }, draftText: "确认信息已处理。" };
    if (confirmed?.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    if (entry.status === "accepted") return reconcileAcceptedEntry({ action: confirmed.item ?? action, account, scope, entry });
    const currentAction = confirmed.item ?? action;
    if (currentAction.status === "executed") return acceptedResponse(entry);
    const claimedAction = pendingActionRepository.claimExecution(action.id, scope);
    if (claimedAction.replayed) return acceptedResponse(entry);
    if (claimedAction.inProgress) return { status: 409, body: { status: "error", text: "这笔记账正在处理中，请稍后查看。" }, draftText: "确认信息已处理。" };
    closePendingOutbox({
      account,
      conversationId: outboxScopeConversation(scope),
      actionId: action.id,
      entryId: target.entryId,
      errorCode: "WEIXIN_OUTBOX_CONFIRMED",
    });
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
        result: { status: "accepted", entryId: target.entryId, expenseId: completed.item.expenseId, paymentId: completed.item.paymentId },
      });
      const accepted = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account }) ?? completed.item;
      try { enqueue(account, outboxScopeConversation(scope), { ...action, version: Number(action.version) + 1 }, target.entryId, "accepted"); } catch { /* financial write remains durable; replay can enqueue again */ }
      return {
        status: 200,
        body: { status: "ok", text: resultMessage(accepted), result: { entryId: target.entryId, expenseId: completed.item.expenseId, paymentId: completed.item.paymentId } },
        draftText: "已确认并完成记账。",
      };
    } catch (error) {
      if (claimedEntry?.leaseToken) {
        try { shortcutBookkeepingRepository.release(target.entryId, { leaseToken: claimedEntry.leaseToken, errorCode: "WEIXIN_CONFIRMATION_WRITE_FAILED" }); } catch { /* preserve safe response */ }
      }
      try { pendingActionRepository.releaseExecution(action.id, { ...scope, leaseToken: claimedAction.leaseToken, errorCode: "WEIXIN_BOOKKEEPING_WRITE_FAILED" }); } catch { /* preserve safe response */ }
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
      closePendingOutbox({
        account,
        conversationId: outboxScopeConversation(scope),
        actionId: action.id,
        entryId: target.entryId,
        errorCode: "WEIXIN_OUTBOX_CANCELLED",
      });
      try {
        shortcutBookkeepingRepository.rejectReview(target.entryId, {
          owner: account,
          actor: account,
          reason: "微信用户取消",
          purge: true,
        });
      } catch { /* already terminal is idempotent */ }
      try { enqueue(account, outboxScopeConversation(scope), action, target.entryId, "cancelled"); } catch { /* best effort */ }
    }
    return { status: 200, body: { status: "cancel", text: "已取消当前快捷记账，未写入费用。" }, draftText: "已取消快捷记账。" };
  }

  async function revise({ action, account, scope, text }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const correction = parseShortcutBookkeepingCorrection(text, {
      friendlyDates: true,
      now: clock(),
    });
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
      const nextStateCredential = deriveShortcutStateCredential(action.id, Number(action.version) + 1, secret);
      const renewed = pendingActionRepository.renewConfirmation(action.id, {
        ...scope,
        confirmationCode: nextStateCredential,
      });
      const updated = shortcutBookkeepingRepository.completeLocal(target.entryId, {
        analysis,
        leaseToken: claimed.leaseToken,
        reviewPatch,
      });
      closePendingOutbox({
        account,
        conversationId: outboxScopeConversation(scope),
        actionId: action.id,
        entryId: target.entryId,
        errorCode: "WEIXIN_OUTBOX_CORRECTED",
      });
      enqueue(account, outboxScopeConversation(scope), renewed.item, target.entryId, "correction");
      return { status: 200, body: { status: "review_required", text: "已按你的修改更新草稿，请查看微信中的最新识别结果并回复“确认”。", item: { id: updated.item.id, status: updated.item.status } }, draftText: "已更新快捷记账草稿。" };
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
    if ((confirmationCode !== undefined && confirmationCode !== null)
      || textClassification.kind === "code"
      || textClassification.kind === "resend") {
      return { status: 200, body: { status: "clarify", text: "快捷记账不使用六位确认码，请回复“确认”、以“修改”开头说明修改内容，或回复“取消”。" }, draftText: "等待明确的自然语言指令。" };
    }
    if (textClassification.kind === "cancel") return cancel({ action, account, scope });
    if (text === "确认") return confirm({ action, account, scope });
    const modification = explicitModification(text);
    if (modification) return revise({ action, account, scope, text: modification });
    return { status: 200, body: { status: "clarify", text: `快捷记账只接受“确认”、“修改…”或“取消”。${correctionHelp()}` }, draftText: "等待明确的自然语言指令。" };
  }

  return Object.freeze({
    enabled,
    ready,
    senderId,
    owner,
    isReadyFor,
    assertReadyFor,
    conversationFor,
    startReview,
    settleFromWeb,
    renderOutboxMessage,
    reconcileAcceptedReceipts,
    handlePending,
  });
}
