import { createHash, createHmac, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import {
  applyShortcutBookkeepingCorrection,
  parseShortcutBookkeepingCorrection,
  projectShortcutBookkeepingDraft,
} from "../integrations/shortcutBookkeepingAssistant.js";
import { parseShortcutBookkeepingIntent } from "../integrations/shortcutBookkeepingIntent.js";
import { shortcutBookkeepingConversationId } from "../weixin/bookkeepingDeliveryScope.js";

export const SHORTCUT_BOOKKEEPING_ACTION = "shortcut-bookkeeping.confirm";
export const SHORTCUT_BOOKKEEPING_CHANNEL = "weixin";
export const SHORTCUT_ADVANCE_ALLOCATION_KIND = "advance_allocation";

const CONFIRMATION_WARNING = "WEIXIN_CONFIRMATION_REQUIRED";
const MAX_MESSAGE_LENGTH = 20_000;
const SHORTCUT_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_REFERENCE_RE = /BK-[0-9A-F]{12}|(?:编号\s*[：:]\s*)([0-9]{12})/u;

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
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
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

function shanghaiParts(value) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const result = {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: valueOf("hour"),
    minute: valueOf("minute"),
  };
  if (Object.values(result).some((item) => !item)) return null;
  return result;
}

function naturalWeek(value) {
  const parts = shanghaiParts(value);
  if (!parts) return null;
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  const start = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { start, end: date.toISOString().slice(0, 10) };
}

function draftNumber(entry) {
  const parts = shanghaiParts(
    entryAnalysis(entry).expense.paidAt
      ?? entry.capturedAt
      ?? entry.createdAt
      ?? entry.occurredOn,
  );
  return parts ? `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}` : "待确认";
}

function draftTimestampReference(entry) {
  const number = draftNumber(entry);
  return /^\d{12}$/u.test(number) ? number : null;
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

function deriveDraftReference(actionId, entryId, version, confirmationSecret) {
  const id = requiredText(actionId, "actionId", 200);
  const entry = requiredText(entryId, "entryId", 200);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("version must be a positive safe integer");
  return `BK-${createHmac("sha256", secretBuffer(confirmationSecret))
    .update(`sentelligent/shortcut-weixin-draft-reference/v1\u0000${id}\u0000${entry}\u0000${version}`, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

function actionPayload(action) {
  const payload = action?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  if (!entryId || entryId.length > 200) return null;
  const advanceId = typeof payload.advanceId === "string" ? payload.advanceId.trim() : "";
  const weekStart = typeof payload.weekStart === "string" ? payload.weekStart.trim() : "";
  const kind = typeof payload.kind === "string" ? payload.kind.trim() : "confirmation";
  return {
    entryId,
    ...(advanceId ? { advanceId } : {}),
    ...(weekStart ? { weekStart } : {}),
    kind,
  };
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

function renderDraftMessage(entry, { prefix = "检测到一笔新记账，请确认！", reference = null } = {}) {
  const draft = draftFromEntry(entry);
  const fields = draft.fields;
  const entryType = entry.entryType === "income" ? "收入" : "支出";
  const category = [fields.category, fields.subcategory].filter(Boolean).join("-");
  const note = fields.note || fields.purpose;
  const week = naturalWeek(fields.occurredOn);
  const number = draftTimestampReference(entry) ?? reference ?? "待确认";
  const aiStatus = draft.warnings.length ? `待补充：${draft.warnings.slice(0, 4).join("、")}` : "已识别，待你确认";
  const lines = [
    "【小小提醒！新增一条待记账信息】",
    `编号：${number}`,
    `类型：${entryType}`,
    `金额：${formatMoney(fields.amountCents)}`,
    `费用类别：${fieldText(category)}`,
    `备注：${fieldText(note, "无")}`,
    `周期：${week ? `${week.start.replaceAll("-", "")}-${week.end.replaceAll("-", "")}` : "待确认"}`,
    `AI 状态：${aiStatus}`,
  ];
  lines.push(
    "",
    "请引用本消息并回复“确认”",
    "需要修改请以“修改”开头并明确字段，例如：修改金额为 18.50 元；修改日期为 2026-08-19；修改费用类别为交通；修改备注为客户拜访。修改后我会重新发送最新信息。",
    "需要取消请引用本消息回复“取消”。",
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
  advanceAllocationRepository = null,
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

  function findAllocationAction(account, advanceId) {
    const row = db.prepare(`
      SELECT * FROM assistant_pending_actions
      WHERE owner = $owner AND channel = $channel AND action_type = $actionType
        AND json_extract(payload_json, '$.kind') = $kind
        AND json_extract(payload_json, '$.advanceId') = $advanceId
        AND status IN ('pending', 'confirmed', 'processing')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({
      $owner: account,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $kind: SHORTCUT_ADVANCE_ALLOCATION_KIND,
      $advanceId: advanceId,
    });
    if (!row) return null;
    return pendingActionRepository.get(row.id, {
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: row.conversation_id,
    });
  }

  function getShortcutAction(account, actionId) {
    const row = db.prepare(`
      SELECT id, conversation_id FROM assistant_pending_actions
      WHERE id = $id AND owner = $owner AND channel = $channel AND action_type = $actionType
    `).get({
      $id: requiredText(actionId, "actionId", 200),
      $owner: requiredText(account, "account", 200),
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
    });
    if (!row) return null;
    return pendingActionRepository.get(row.id, {
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: row.conversation_id,
    });
  }

  function activeShortcutActions(account, { limit = 3 } = {}) {
    const normalizedAccount = requiredText(account, "account", 200);
    const now = iso(clock);
    withImmediateTransaction(db, () => {
      db.prepare(`
        UPDATE assistant_pending_actions
        SET status = 'expired', version = version + 1, updated_at = $now
        WHERE owner = $owner AND channel = $channel AND action_type = $actionType
          AND status IN ('pending', 'confirmed') AND datetime(expires_at) <= datetime($now)
      `).run({
        $owner: normalizedAccount,
        $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
        $actionType: SHORTCUT_BOOKKEEPING_ACTION,
        $now: now,
      });
    });
    return db.prepare(`
      SELECT id FROM assistant_pending_actions
      WHERE owner = $owner AND channel = $channel AND action_type = $actionType
        AND status IN ('pending', 'confirmed', 'processing')
      ORDER BY created_at ASC, id ASC
      LIMIT $limit
    `).all({
      $owner: normalizedAccount,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $limit: limit,
    }).map((row) => getShortcutAction(normalizedAccount, row.id)).filter(Boolean);
  }

  function activeAdvanceAllocationActions(account, { limit = 3 } = {}) {
    const rows = db.prepare(`
      SELECT id FROM assistant_pending_actions
      WHERE owner = $owner AND channel = $channel AND action_type = $actionType
        AND json_extract(payload_json, '$.kind') = $kind
        AND status IN ('pending', 'confirmed', 'processing')
      ORDER BY created_at ASC, id ASC LIMIT $limit
    `).all({
      $owner: account,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $kind: SHORTCUT_ADVANCE_ALLOCATION_KIND,
      $limit: limit,
    });
    return rows.map((row) => getShortcutAction(account, row.id)).filter(Boolean);
  }

  function enqueue(account, conversationId, action, entryId, kind = "confirmation", extraPayload = {}) {
    const accepted = kind === "accepted";
    const version = accepted ? 1 : Number(action?.version ?? 1);
    return outboxRepository.enqueue({
      owner: account,
      conversationId,
      idempotencyKey: `shortcut-bookkeeping:${entryId}:${kind}:v${version}`,
      payload: { actionId: action.id, entryId, version, kind, ...extraPayload },
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
    const deliveryConversationId = conversationFor(normalizedAccount);
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
        $conversationId: deliveryConversationId,
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
        deliveryConversationId,
        settledAction ?? action,
        entryId,
        terminalKind,
      );
    } catch {
      // Accepted receipts are reconciled before every worker lease. Rejected
      // decisions are likewise retried by the terminal-review reconciliation.
    }
    if (decision === "accepted" && entry.advanceId && advanceAllocationRepository) {
      try {
        startAdvanceAllocationReview({
          account: normalizedAccount,
          entry,
          advance: {
            advanceId: entry.advanceId,
            weekStart: entry.advanceWeekStart,
            receivedCents: entry.advanceReceivedCents,
          },
        });
      } catch { /* financial settlement remains durable; prompt is recoverable */ }
    }
    return { action: settledAction, outbox, ...settled };
  }

  function startReview({ account, entry }) {
    const conversationId = conversationFor(account);
    const conversation = sessionRepository.getOrCreate({
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: `${conversationId}:entry:${requiredText(entry?.id, "entryId", 200)}`,
    });
    const existing = findActionForEntry(account, entry.id);
    if (existing) {
      const outbox = enqueue(account, conversationId, existing, entry.id, "confirmation");
      return { action: existing, conversationId, outbox, replayed: true };
    }
    const actionId = requiredText(idFactory(), "actionId", 200);
    const stateCredential = deriveShortcutStateCredential(actionId, 1, secret);
    const expiresAt = new Date(Date.parse(iso(clock)) + SHORTCUT_PENDING_TTL_MS).toISOString();
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
    const outbox = enqueue(account, conversationId, action, entry.id, "confirmation");
    return { action, conversationId, outbox, replayed: false };
  }

  function startAdvanceAllocationReview({ account, entry, advance }) {
    if (!advanceAllocationRepository || !advance?.advanceId) return null;
    const conversationId = conversationFor(account);
    const allocationConversation = sessionRepository.getOrCreate({
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: `${conversationId}:advance:${advance.advanceId}`,
    });
    const existing = findAllocationAction(account, advance.advanceId);
    if (existing) {
      const payload = actionPayload(existing);
      const outbox = enqueue(account, conversationId, existing, entry.id, SHORTCUT_ADVANCE_ALLOCATION_KIND, {
        advanceId: payload?.advanceId ?? advance.advanceId,
        weekStart: payload?.weekStart ?? advance.weekStart,
      });
      return { action: existing, conversationId, outbox, replayed: true };
    }
    const actionId = requiredText(idFactory(), "actionId", 200);
    const stateCredential = deriveShortcutStateCredential(actionId, 1, secret);
    const expiresAt = new Date(Date.parse(iso(clock)) + SHORTCUT_PENDING_TTL_MS).toISOString();
    const action = pendingActionRepository.create({
      id: actionId,
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: allocationConversation.id,
      actionType: SHORTCUT_BOOKKEEPING_ACTION,
      payload: {
        entryId: entry.id,
        kind: SHORTCUT_ADVANCE_ALLOCATION_KIND,
        advanceId: advance.advanceId,
        weekStart: advance.weekStart,
      },
      confirmationCode: stateCredential,
      expiresAt,
    });
    const outbox = enqueue(account, conversationId, action, entry.id, SHORTCUT_ADVANCE_ALLOCATION_KIND, {
      advanceId: advance.advanceId,
      weekStart: advance.weekStart,
    });
    return { action, conversationId, outbox, replayed: false };
  }

  function renderOutboxMessage(outboxItem) {
    const payload = outboxItem?.payload;
    if (!payload || typeof payload !== "object") throw new TypeError("outbox payload is invalid");
    if (payload.kind === SHORTCUT_ADVANCE_ALLOCATION_KIND) {
      const row = db.prepare(`
        SELECT entry.id AS entry_id, entry.captured_at, entry.created_at,
               advance.id AS advance_id, advance.received_cents, advance.received_on,
               advance.week_start, advance.purpose
        FROM travel_expense_advance_sources source
        JOIN travel_expense_advances advance ON advance.id = source.advance_id
        JOIN shortcut_bookkeeping_entries entry ON entry.id = source.entry_id
        WHERE source.owner = $owner AND source.entry_id = $entryId
          AND source.advance_id = $advanceId AND source.status = 'active'
      `).get({
        $owner: outboxItem.owner,
        $entryId: payload.entryId,
        $advanceId: payload.advanceId,
      });
      if (!row) throw new Error("advance_not_found");
      const number = draftTimestampReference({
        capturedAt: row.captured_at,
        createdAt: row.created_at,
        analysis: { expense: { paidAt: `${row.received_on}T12:00:00+08:00` } },
      }) ?? "待确认";
      const end = new Date(`${row.week_start}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      return [
        "【小小提醒！借款到账待归属】",
        `编号：${number}`,
        `借款金额：${formatMoney(Number(row.received_cents))}`,
        `到账日期：${row.received_on}`,
        `建议周期：${row.week_start.replaceAll("-", "")}-${end.toISOString().slice(0, 10).replaceAll("-", "")}`,
        "请引用本消息并回复“本周”或“这笔借款用于 20260824-20260830”；如要绑定某笔费用，请引用对应待记账消息并说明“用于这笔”。",
        "确认后我会按发生日期从周一到周日分配，显示借款已用、剩余和个人垫付超额。",
      ].join("\n");
    }
    if (payload.kind === "allocation_confirmed") {
      return `借款分配已确认：本周使用 ${formatMoney(Number(payload.allocatedCents ?? 0))}，剩余金额请在系统结算预览中查看。`;
    }
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
    const action = getShortcutAction(outboxItem.owner, payload.actionId);
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
      reference: deriveDraftReference(
        action.id,
        payload.entryId,
        Number(payload.version),
        secret,
      ),
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
        conversationFor(account),
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
    const receipts = rows.map((row) => {
      const entry = shortcutBookkeepingRepository.getReview(row.entry_id, { owner: row.owner });
      if (!entry || entry.status !== row.entry_status) return null;
      const targetActionStatus = entry.status === "accepted" ? "executed" : "cancelled";
      if (row.action_status === targetActionStatus) {
          return enqueue(
            row.owner,
            conversationFor(row.owner),
          { id: row.action_id, version: Number(row.version) },
          row.entry_id,
          entry.status === "accepted" ? "accepted" : "cancelled",
        );
      }
      return settleFromWeb({ account: row.owner, entry, decision: row.entry_status }).outbox;
    }).filter(Boolean);
    if (advanceAllocationRepository) {
      const loanRows = db.prepare(`
        SELECT entry.id AS entry_id, entry.owner,
               source.advance_id,
               advance.week_start AS advance_week_start,
               advance.received_cents AS advance_received_cents
        FROM shortcut_bookkeeping_entries entry
        JOIN travel_expense_advance_sources source
          ON source.entry_id = entry.id AND source.owner = entry.owner AND source.status = 'active'
        JOIN travel_expense_advances advance ON advance.id = source.advance_id
        WHERE entry.owner = $owner AND entry.status = 'accepted' AND entry.entry_type = 'income'
          AND source.advance_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM assistant_pending_actions action
            WHERE action.owner = entry.owner AND action.action_type = $actionType
              AND json_extract(action.payload_json, '$.kind') = $kind
              AND json_extract(action.payload_json, '$.advanceId') = source.advance_id
          )
      `).all({
        $owner: owner,
        $actionType: SHORTCUT_BOOKKEEPING_ACTION,
        $kind: SHORTCUT_ADVANCE_ALLOCATION_KIND,
      });
      for (const row of loanRows.slice(0, limit)) {
        const entry = shortcutBookkeepingRepository.getReview(row.entry_id, { owner: row.owner });
        if (!entry) continue;
        try {
          startAdvanceAllocationReview({
            account: row.owner,
            entry,
            advance: {
              advanceId: row.advance_id,
              weekStart: row.advance_week_start,
              receivedCents: Number(row.advance_received_cents),
            },
          });
        } catch { /* next reconciliation pass retries prompt recovery */ }
      }
    }
    return receipts;
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
      conversationId: conversationFor(account),
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
      try { enqueue(account, conversationFor(account), { ...action, version: Number(action.version) + 1 }, target.entryId, "accepted"); } catch { /* financial write remains durable; replay can enqueue again */ }
      if (completed.advance || accepted.advanceId) {
        try {
          startAdvanceAllocationReview({
            account,
            entry: accepted,
            advance: completed.advance ?? {
              advanceId: accepted.advanceId,
              weekStart: accepted.advanceWeekStart,
              receivedCents: accepted.advanceReceivedCents,
            },
          });
        } catch (error) { /* loan source is durable; allocation prompt can be recovered later */
          // Keep the financial write durable; the reconciliation path can
          // recreate this prompt once the outbox worker is available.
          void error;
        }
      }
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

  async function cancel({ action, account, scope }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const cancelled = pendingActionRepository.cancel(action.id, scope);
    if (!cancelled.replayed) {
      closePendingOutbox({
        account,
        conversationId: conversationFor(account),
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
      try { enqueue(account, conversationFor(account), action, target.entryId, "cancelled"); } catch { /* best effort */ }
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
        revisionSource: "weixin_correction",
      });
      closePendingOutbox({
        account,
        conversationId: conversationFor(account),
        actionId: action.id,
        entryId: target.entryId,
        errorCode: "WEIXIN_OUTBOX_CORRECTED",
      });
      enqueue(account, conversationFor(account), renewed.item, target.entryId, "correction");
      return {
        status: 200,
        body: {
          status: "review_required",
          text: "已按你的修改更新草稿，请查看微信中的最新识别结果；如需继续修改请以“修改…”开头，确认请回复“确认”。",
          item: { id: updated.item.id, status: updated.item.status },
        },
        draftText: "已更新快捷记账草稿。",
      };
    } catch (error) {
      try { shortcutBookkeepingRepository.release(target.entryId, { leaseToken: claimed.leaseToken, errorCode: "WEIXIN_CORRECTION_FAILED" }); } catch { /* preserve safe response */ }
      throw error;
    }
  }

  async function allocateAdvance({ action, account, scope, intent, quote }) {
    if (!advanceAllocationRepository) {
      return { status: 503, body: { status: "error", text: "借款分配功能尚未就绪，未修改任何费用。" }, draftText: "借款分配功能未就绪。" };
    }
    const payload = actionPayload(action);
    if (!payload?.advanceId) {
      return { status: 409, body: { status: "error", text: "借款待归属草稿已失效，请重新记录到账信息。" }, draftText: "借款归属草稿已失效。" };
    }
    const assignment = intent?.assignment ?? {};
    if (assignment.owner && assignment.owner !== "self") {
      return {
        status: 409,
        body: { status: "clarify", text: "当前只支持把绑定账号本人的已到账借款分配到本人的费用；如是他人借款，请先由对应账号记录。" },
        draftText: "借款归属人不是当前绑定账号。",
      };
    }
    const weekStart = assignment.weekStart ?? payload.weekStart;
    if (!weekStart) {
      return { status: 200, body: { status: "clarify", text: "请明确借款用于哪一周（例如：本周，或 20260824-20260830）。" }, draftText: "等待借款周期。" };
    }
    let expenseId = null;
    if (assignment.scope === "expense") {
      const quoted = quotedOutbox(account, quote)?.action ?? null;
      const quotedPayload = actionPayload(quoted);
      let quotedEntry = null;
      if (quotedPayload?.entryId && quotedPayload.kind !== SHORTCUT_ADVANCE_ALLOCATION_KIND) {
        quotedEntry = shortcutBookkeepingRepository.getReview(quotedPayload.entryId, { owner: account });
      } else {
        // An expense may already be accepted by the time a later loan arrives;
        // its original sent draft is no longer the latest confirmation row.
        // Allocation is only an overlay, so it may safely bind that authentic
        // historical sent message after rechecking owner and entry type.
        quotedEntry = historicalQuotedExpense(account, quote);
      }
      if (!quotedEntry && assignment.reference) {
        quotedEntry = findExpenseByPublicReference(account, assignment.reference);
      }
      if (!quotedEntry) {
        return { status: 409, body: { status: "clarify", text: "请引用要绑定的那条支出待记账消息，再回复“这笔借款用于这笔”。" }, draftText: "等待引用具体支出。" };
      }
      if (!quotedEntry || quotedEntry.entryType !== "expense") {
        return { status: 409, body: { status: "clarify", text: "引用的消息不是支出待记账草稿，请重新引用费用消息。" }, draftText: "引用费用草稿无效。" };
      }
      expenseId = quotedEntry.id;
    }
    let proposal;
    try {
      proposal = advanceAllocationRepository.propose({
        owner: account,
        weekStart,
        advanceId: payload.advanceId,
        ...(expenseId ? { expenseId } : {}),
      });
    } catch {
      return { status: 409, body: { status: "clarify", text: "借款周期或引用的费用已变化，请重新说明本周或引用最新消息。" }, draftText: "借款分配条件已变化。" };
    }
    if (!proposal.proposedAllocations.length) {
      return {
        status: 409,
        body: {
          status: "review_required",
          text: `本次没有可分配的借款额度。当前借款剩余 ${formatMoney(proposal.remainingCents)}，个人垫付/未覆盖 ${formatMoney(proposal.uncoveredCents)}；请检查周期或引用的费用。`,
        },
        draftText: "借款分配没有可执行项目。",
      };
    }
    let confirmed;
    let claimed = null;
    let allocationCommitted = false;
    try {
      const confirmation = pendingActionRepository.confirm(action.id, {
        ...scope,
        confirmationCode: deriveShortcutStateCredential(action.id, Number(action.version), secret),
      });
      if (confirmation?.expired) {
        return { status: 410, body: { status: "error", text: "借款归属草稿已过期，请重新记录到账信息。" }, draftText: "借款归属草稿已过期。" };
      }
      if (confirmation?.inProgress) {
        return { status: 409, body: { status: "error", text: "借款分配正在处理中，请稍后查看。" }, draftText: "借款分配正在处理中。" };
      }
      claimed = pendingActionRepository.claimExecution(action.id, scope);
      if (claimed.inProgress) {
        return { status: 409, body: { status: "error", text: "借款分配正在处理中，请稍后查看。" }, draftText: "借款分配正在处理中。" };
      }
      confirmed = advanceAllocationRepository.confirm({
        owner: account,
        actor: account,
        weekStart,
        advanceId: payload.advanceId,
        ...(expenseId ? { expenseId } : {}),
        planHash: proposal.planHash,
        requestId: action.id,
      });
      allocationCommitted = true;
      if (!claimed.replayed && !claimed.inProgress) {
        pendingActionRepository.completeExecution(action.id, {
          ...scope,
          leaseToken: claimed.leaseToken,
          result: { status: "allocated", planId: confirmed.planId, planHash: confirmed.planHash },
        });
      }
    } catch (error) {
      if (!allocationCommitted && claimed?.leaseToken) {
        try {
          pendingActionRepository.releaseExecution(action.id, {
            ...scope,
            leaseToken: claimed.leaseToken,
            errorCode: "WEIXIN_ADVANCE_ALLOCATION_FAILED",
          });
        } catch { /* preserve the original failure */ }
      }
      if (error?.code === "SHORTCUT_ADVANCE_PLAN_CHANGED") {
        try {
          const refreshed = pendingActionRepository.get(action.id, scope);
          if (refreshed) {
            enqueue(account, conversationFor(account), refreshed, payload.entryId, SHORTCUT_ADVANCE_ALLOCATION_KIND, {
              advanceId: payload.advanceId,
              weekStart: payload.weekStart,
            });
          }
        } catch { /* next reconciliation pass can recreate the prompt */ }
        return { status: 409, body: { status: "review_required", text: "费用或借款余额刚刚发生变化，请重新引用最新消息后再分配。" }, draftText: "借款分配快照已变化。" };
      }
      throw error;
    }
    closePendingOutbox({
      account,
      conversationId: conversationFor(account),
      actionId: action.id,
      entryId: payload.entryId,
      errorCode: "WEIXIN_OUTBOX_ADVANCE_ALLOCATED",
    });
    try {
      enqueue(account, conversationFor(account), { ...action, version: 1 }, payload.entryId, "allocation_confirmed", {
        advanceId: payload.advanceId,
        weekStart,
        planId: confirmed.planId,
        planHash: confirmed.planHash,
        allocatedCents: confirmed.allocatedCents,
        remainingCents: confirmed.remainingCents,
        uncoveredCents: confirmed.uncoveredCents,
      });
    } catch { /* durable allocation remains authoritative; reconciliation can retry */ }
    return {
      status: 200,
      body: {
        status: "ok",
        text: `借款已入账并完成分配：本次使用 ${formatMoney(confirmed.allocatedCents)}，剩余 ${formatMoney(confirmed.remainingCents)}，个人垫付/未覆盖 ${formatMoney(confirmed.uncoveredCents)}。`,
        result: { planId: confirmed.planId, planHash: confirmed.planHash },
      },
      draftText: "借款分配已确认。",
    };
  }

  function quotedOutbox(account, quote) {
    if (!quote || typeof quote !== "object") return null;
    const deliveryConversationId = conversationFor(account);
    const providerMessageId = typeof quote.providerMessageId === "string"
      ? quote.providerMessageId.trim()
      : "";
    let row = null;
    if (providerMessageId) {
      const rows = db.prepare(`
        SELECT * FROM weixin_confirmation_outbox
        WHERE owner = $owner AND conversation_id = $conversationId
          AND status = 'sent' AND provider_message_id = $providerMessageId
        ORDER BY sent_at DESC, id DESC
        LIMIT 2
      `).all({
        $owner: account,
        $conversationId: deliveryConversationId,
        $providerMessageId: providerMessageId,
      });
      if (rows.length === 1) row = rows[0];
      if (rows.length > 1) return null;
    }
    if (!row) {
      const referenceMatch = typeof quote.text === "string" ? quote.text.match(DRAFT_REFERENCE_RE) : null;
      const reference = referenceMatch?.[0] ?? null;
      const timestampReference = referenceMatch?.[1] ?? null;
      if (!reference) return null;
      const candidates = db.prepare(`
        SELECT * FROM weixin_confirmation_outbox
        WHERE owner = $owner AND conversation_id = $conversationId AND status = 'sent'
        ORDER BY sent_at DESC, id DESC
        LIMIT 200
      `).all({ $owner: account, $conversationId: deliveryConversationId });
      const matches = candidates.filter((candidate) => {
        let payload;
        try { payload = JSON.parse(candidate.payload_json); } catch { return false; }
        if (!payload?.actionId || !payload?.entryId || ["accepted", "cancelled"].includes(payload.kind)) return false;
        const version = Number(payload.version);
        if (!Number.isSafeInteger(version) || version < 1) return false;
        if (deriveDraftReference(payload.actionId, payload.entryId, version, secret) === reference) return true;
        if (!timestampReference) return false;
        const entry = shortcutBookkeepingRepository.getReview(payload.entryId, { owner: account });
        return entry && draftTimestampReference(entry) === timestampReference;
      });
      if (matches.length !== 1) return null;
      [row] = matches;
    }
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { return null; }
    if (!payload?.actionId || !payload?.entryId || ["accepted", "cancelled"].includes(payload.kind)) return null;
    const action = getShortcutAction(account, payload.actionId);
    if (!action || !["pending", "confirmed", "processing"].includes(action.status)) return null;
    const version = Number(payload.version);
    if (!Number.isSafeInteger(version) || version !== Number(action.version)) return null;
    const latest = outboxRepository.latestForEntry?.({ owner: account, entryId: payload.entryId });
    if (!latest || latest.id !== row.id || latest.status !== "sent") return null;
    return { action, outbox: latest };
  }

  function findExpenseByPublicReference(account, value) {
    const match = String(value ?? "").match(/(?:编号\s*[：:]\s*)?(\d{12})/u);
    const reference = match?.[1] ?? null;
    if (!reference) return null;
    const rows = db.prepare(`
      SELECT id
      FROM shortcut_bookkeeping_entries
      WHERE owner = $owner AND target_system = 'sentelligent'
        AND entry_type = 'expense' AND status IN ('review_required', 'accepted')
      ORDER BY updated_at DESC, id DESC
      LIMIT 200
    `).all({ $owner: account });
    const matches = rows
      .map((row) => shortcutBookkeepingRepository.getReview(row.id, { owner: account }))
      .filter((entry) => entry && draftTimestampReference(entry) === reference);
    return matches.length === 1 ? matches[0] : null;
  }

  function historicalQuotedExpense(account, quote) {
    if (!quote || typeof quote !== "object") return null;
    const providerMessageId = typeof quote.providerMessageId === "string"
      ? quote.providerMessageId.trim()
      : "";
    const quotedText = typeof quote.text === "string" ? quote.text : "";
    const referenceMatch = quotedText.match(DRAFT_REFERENCE_RE);
    const reference = referenceMatch?.[0] ?? null;
    const timestampReference = referenceMatch?.[1] ?? null;
    if (!providerMessageId && !reference) return null;
    const deliveryConversationId = conversationFor(account);
    const rows = providerMessageId
      ? db.prepare(`
          SELECT * FROM weixin_confirmation_outbox
          WHERE owner = $owner AND conversation_id = $conversationId
            AND status = 'sent' AND provider_message_id = $providerMessageId
          ORDER BY sent_at DESC, id DESC
          LIMIT 2
        `).all({ $owner: account, $conversationId: deliveryConversationId, $providerMessageId: providerMessageId })
      : db.prepare(`
          SELECT * FROM weixin_confirmation_outbox
          WHERE owner = $owner AND conversation_id = $conversationId AND status = 'sent'
          ORDER BY sent_at DESC, id DESC
          LIMIT 200
        `).all({ $owner: account, $conversationId: deliveryConversationId });
    const entries = [];
    for (const row of rows) {
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      if (!payload?.entryId || payload.kind === SHORTCUT_ADVANCE_ALLOCATION_KIND) continue;
      const version = Number(payload.version);
      if (!Number.isSafeInteger(version) || version < 1) continue;
      const matchesReference = reference
        && (deriveDraftReference(payload.actionId, payload.entryId, version, secret) === reference
          || (timestampReference
            && (() => {
              const entry = shortcutBookkeepingRepository.getReview(payload.entryId, { owner: account });
              return entry && draftTimestampReference(entry) === timestampReference;
            })()));
      if (providerMessageId ? true : matchesReference) {
        const entry = shortcutBookkeepingRepository.getReview(payload.entryId, { owner: account });
        if (entry?.entryType === "expense" && ["review_required", "accepted"].includes(entry.status)) entries.push(entry);
      }
    }
    const unique = new Map(entries.map((entry) => [entry.id, entry]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  function commandTargetsShortcut(text, textClassification, pendingActionId, quote) {
    return Boolean(
      pendingActionId
      || quote
      || text === "确认"
      || textClassification.kind !== "ordinary"
      || explicitModification(text)
      || /^(?:确认|修改|取消)/u.test(String(text ?? "")),
    );
  }

  function financialEventScopeAllowed(context, serverData) {
    if (context?.channel !== SHORTCUT_BOOKKEEPING_CHANNEL) return true;
    const metadata = serverData?.auditMetadata;
    const expectedSenderHash = createHash("sha256").update(senderId, "utf8").digest("hex");
    return context.owner === owner
      && metadata?.financialScope === true
      && metadata?.chatType === "direct"
      && metadata?.senderHash === expectedSenderHash;
  }

  function quoteLikelyTargetsShortcut(account, quote) {
    if (!quote || typeof quote !== "object") return false;
    const quotedText = typeof quote.text === "string" ? quote.text : "";
    if (DRAFT_REFERENCE_RE.test(quotedText)
      || quotedText.includes("【小小提醒！新增一条待记账信息】")
      || quotedText.includes("【小小提醒！借款到账待归属】")) {
      return true;
    }
    const providerMessageId = typeof quote.providerMessageId === "string"
      ? quote.providerMessageId.trim()
      : "";
    if (!providerMessageId || !account || !senderId) return false;
    try {
      const conversationId = shortcutBookkeepingConversationId(account, senderId);
      const row = db.prepare(`
        SELECT 1
        FROM weixin_confirmation_outbox outbox
        JOIN assistant_pending_actions action
          ON action.id = json_extract(outbox.payload_json, '$.actionId')
         AND action.owner = outbox.owner
         AND action.channel = $channel
         AND action.action_type = $actionType
        WHERE outbox.owner = $owner
          AND outbox.conversation_id = $conversationId
          AND outbox.status = 'sent'
          AND outbox.provider_message_id = $providerMessageId
        LIMIT 1
      `).get({
        $owner: account,
        $conversationId: conversationId,
        $providerMessageId: providerMessageId,
        $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
        $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      });
      return Boolean(row);
    } catch {
      return false;
    }
  }

  function quoteRequiredResponse() {
    return {
      status: 409,
      body: {
        status: "clarify",
        text: "为防止确认错账，请引用小小发送的最新记账草稿消息后再回复“确认”“修改…”或“取消”。",
      },
      draftText: "等待用户引用最新记账草稿。",
    };
  }

  async function handlePending({ action, context, text, textClassification, confirmationCode, pendingActionId, serverData }) {
    const account = context.owner;
    const quote = serverData?.quote ?? null;
    const intent = parseShortcutBookkeepingIntent(text, { friendlyDates: true, now: clock() });
    const shortcutQuote = quoteLikelyTargetsShortcut(account, quote);
    // The pending-action hook is shared by every WeChat assistant capability.
    // Only a quote, an explicitly shortcut-owned action, or a loan-allocation
    // request should enter the stricter financial sender/direct gate.  A bare
    // six-digit code/cancel/resend for an unrelated (for example visit)
    // action must continue through the generic confirmation boundary instead
    // of being misclassified as a Shortcut bookkeeping request.
    const shortcutSignal = Boolean(
      action?.actionType === SHORTCUT_BOOKKEEPING_ACTION
      || shortcutQuote
      || (intent.status === "accepted" && intent.intent === "loan_assignment")
      || (pendingActionId && action?.actionType === SHORTCUT_BOOKKEEPING_ACTION),
    );
    if (shortcutSignal && !financialEventScopeAllowed(context, serverData)) {
      return {
        status: 403,
        body: { status: "error", text: "当前微信会话不属于快捷记账绑定的本人私聊，未执行任何财务操作。" },
        draftText: "财务操作访问被拒绝。",
      };
    }
    let targetAction = null;
    const allocationCandidates = intent.intent === "loan_assignment" && !pendingActionId && !action
      ? activeAdvanceAllocationActions(account, { limit: 3 })
      : [];
    // A quoted loan-arrival message is the strongest selector when more than
    // one received loan is awaiting allocation.  A quote of an expense is
    // still allowed when there is exactly one pending loan; allocateAdvance
    // resolves that expense below.
    if (intent.intent === "loan_assignment" && quote) {
      const quotedAction = quotedOutbox(account, quote)?.action ?? null;
      if (actionPayload(quotedAction)?.kind === SHORTCUT_ADVANCE_ALLOCATION_KIND) {
        targetAction = quotedAction;
      } else if (allocationCandidates.length === 1) {
        [targetAction] = allocationCandidates;
      } else if (allocationCandidates.length > 1) {
        return { status: 409, body: { status: "clarify", text: "请引用对应的借款到账消息；如果还要绑定某笔费用，请在文字中写明编号。" }, draftText: "等待引用具体借款。" };
      }
    } else if (allocationCandidates.length === 1) {
      [targetAction] = allocationCandidates;
    } else if (allocationCandidates.length > 1) {
      return { status: 409, body: { status: "clarify", text: "当前有多笔借款待归属，请引用对应的借款到账消息。" }, draftText: "等待引用具体借款。" };
    } else if (quote && shortcutQuote && intent.intent !== "loan_assignment") {
      targetAction = quotedOutbox(account, quote)?.action ?? null;
      if (!targetAction) {
        return { status: 409, body: { status: "error", text: "引用的记账草稿不是当前可确认版本，请引用小小发送的对应最新草稿。" }, draftText: "引用草稿无效或已过期。" };
      }
    } else if (pendingActionId) {
      targetAction = getShortcutAction(account, pendingActionId);
    } else if (action?.actionType === SHORTCUT_BOOKKEEPING_ACTION) {
      targetAction = action;
    } else {
      const active = activeShortcutActions(account, { limit: 3 });
      if (active.length === 1) [targetAction] = active;
      else if (active.length > 1 && commandTargetsShortcut(text, textClassification, pendingActionId, quote)) {
        return { status: 409, body: { status: "clarify", text: "当前有多笔待确认记账，请引用对应的小小草稿后回复“确认”“修改…”或“取消”。" }, draftText: "等待引用具体记账草稿。" };
      }
    }
    if (!targetAction) return null;
    if (pendingActionId && pendingActionId !== targetAction.id) {
      return { status: 409, body: { status: "error", text: "当前会话的待确认操作已变化，请查看最新微信消息。" }, draftText: "确认信息已处理。" };
    }
    const isFinancialCommand = intent.status === "accepted"
      && ["confirm", "cancel", "correction", "loan_assignment"].includes(intent.intent);
    if (context?.channel === SHORTCUT_BOOKKEEPING_CHANNEL
      && targetAction
      && !quote
      && (isFinancialCommand || textClassification.kind === "cancel" || text === "确认")) {
      return quoteRequiredResponse();
    }
    const scope = {
      owner: account,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: targetAction.conversationId,
    };
    if (actionPayload(targetAction)?.kind === SHORTCUT_ADVANCE_ALLOCATION_KIND) {
      if (!quote) return quoteRequiredResponse();
      if (confirmationCode !== undefined && confirmationCode !== null) {
        return { status: 200, body: { status: "clarify", text: "借款分配不使用六位确认码，请引用借款消息并说明用于哪一周或哪笔费用。" }, draftText: "等待借款分配范围。" };
      }
      if (intent.intent === "cancel") {
        // The income has already been explicitly confirmed. Cancelling this
        // follow-up only defers allocation; it must never delete or reverse
        // the received loan pool.
        return {
          status: 200,
          body: {
            status: "clarify",
            text: "已暂不分配这笔借款；借款收入仍已入账，不会删除。之后请再次引用借款到账消息并回复“本周”或说明对应费用。",
          },
          draftText: "借款仍待归属，未修改已入账借款。",
        };
      }
      if (intent.intent === "loan_assignment") {
        return allocateAdvance({ action: targetAction, account, scope, intent, quote });
      }
      return { status: 200, body: { status: "clarify", text: "请引用借款到账消息并回复“本周”或说明对应的费用。" }, draftText: "等待借款分配范围。" };
    }
    if ((confirmationCode !== undefined && confirmationCode !== null)
      || textClassification.kind === "code"
      || textClassification.kind === "resend") {
      return { status: 200, body: { status: "clarify", text: "快捷记账不使用六位确认码，请回复“确认”、以“修改”开头说明修改内容，或回复“取消”。" }, draftText: "等待明确的自然语言指令。" };
    }
    if (textClassification.kind === "cancel" || intent.intent === "cancel") {
      return cancel({ action: targetAction, account, scope });
    }
    if (intent.intent === "confirm") return confirm({ action: targetAction, account, scope });
    if (intent.intent === "correction") {
      return revise({ action: targetAction, account, scope, text: explicitModification(text) ?? text });
    }
    if (intent.intent === "loan_assignment") {
      return {
        status: 200,
        body: {
          status: "clarify",
          text: "已识别为借款归属说明，但还需要明确“本周”或引用具体费用消息；确认后我会按到账金额分配并显示剩余/个人垫付金额。",
        },
        draftText: "等待明确借款归属范围。",
      };
    }
    const modification = explicitModification(text);
    if (modification) return revise({ action: targetAction, account, scope, text: modification });
    return { status: 200, body: { status: "clarify", text: `请使用明确的自然语言回复“确认入账”“修改金额为…”或“取消”。${correctionHelp()}` }, draftText: "等待明确的自然语言指令。" };
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
