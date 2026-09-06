import { createHash, createHmac, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { resolveBookkeepingCategory } from "../bookkeeping/categoryCatalog.js";
import {
  applyShortcutBookkeepingCorrection,
  BOOKKEEPING_CORRECTION_FIELD_WORDS,
  parseShortcutBookkeepingCorrection,
  projectShortcutBookkeepingDraft,
} from "../integrations/shortcutBookkeepingAssistant.js";
import { parseShortcutBookkeepingIntent } from "../integrations/shortcutBookkeepingIntent.js";
import { shortcutBookkeepingConversationId } from "../weixin/bookkeepingDeliveryScope.js";
import { renderHospitalTenderNoticeMessage } from "../hospitalTender/weixinNotifier.js";
import { renderActionReminderMessage } from "../actionReminders/reminderMessage.js";
import { renderDailyDigestMessage, renderFridayCloseoutMessage } from "../dailyDigest/digestMessage.js";
import { renderOpsAlertMessage } from "../ops/opsAlertMessage.js";
import { buildAutomaticMealNote, buildBookkeepingAnalysis } from "./bookkeepingCapture.js";
import { resolveItineraryTripRegion } from "./bookkeepingTripRegion.js";

export const SHORTCUT_BOOKKEEPING_ACTION = "shortcut-bookkeeping.confirm";
export const SHORTCUT_BOOKKEEPING_CHANNEL = "weixin";
export const SHORTCUT_ADVANCE_ALLOCATION_KIND = "advance_allocation";

const CONFIRMATION_WARNING = "WEIXIN_CONFIRMATION_REQUIRED";
const MAX_MESSAGE_LENGTH = 20_000;
const SHORTCUT_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_REFERENCE_RE = /BK-[0-9A-F]{12}|(?:编号\s*[：:]\s*)([0-9]{12})/u;
const IMPLICIT_CURRENT_WINDOW_MS = 15 * 60 * 1000;
const IMPLICIT_CURRENT_GAP_MS = 60 * 60 * 1000;
const EXPLICIT_TRIP_REGION_SOURCES = new Set(["text", "user_correction"]);

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

function correctedPaidAt(originalPaidAt, correctedValue, {
  explicitDateTime = false,
  fallbackPaidTime = null,
} = {}) {
  if (typeof correctedValue !== "string" || !correctedValue.trim()) return originalPaidAt ?? null;
  if (explicitDateTime) return correctedValue.trim();
  const correctedDate = correctedValue.slice(0, 10);
  if (dateOnly(correctedDate) && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(fallbackPaidTime)) {
    return `${correctedDate}T${fallbackPaidTime}:00+08:00`;
  }
  const original = shanghaiParts(originalPaidAt);
  return original && dateOnly(correctedDate)
    ? `${correctedDate}T${original.hour}:${original.minute}:00+08:00`
    : correctedValue.trim();
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

function warningText(value) {
  const labels = {
    missing_occurredOn: "发生日期待确认",
    invalid_occurredOn: "发生日期待确认",
    missing_amountCents: "金额待确认",
    invalid_amountCents: "金额待确认",
    invalid_merchant: "商户待确认",
    invalid_purpose: "用途待确认",
    invalid_note: "备注待确认",
    merchant_partial: "商户名称可能被截断",
    year_inferred: "年份由发送时间推断",
    missing_date: "发生日期待确认",
    missing_amount: "金额待确认",
    missing_purpose: "用途待确认",
    missing_trip_region: "出差区域待确认",
    large_meal_context_unknown: "大额用餐场景待确认",
    RECOGNITION_FAILED: "图片识别未完成",
    TEXT_EXTRACTION_FAILED: "图片文字提取未完成",
    MODEL_PROVIDER_ERROR: "AI 字段分析未完成",
    MODEL_UNAVAILABLE: "AI 字段分析未完成",
  };
  if (labels[value]) return labels[value];
  if (typeof value === "string" && value.startsWith("missing_")) return "信息待补充";
  return "识别结果需复核";
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
          ?? expense.occurredOn
          ?? entry.occurredOn
          ?? null,
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
  const { analysis } = entryAnalysis(entry);
  const fields = draft.fields;
  const entryType = entry.entryType === "income" ? "收入" : "支出";
  const category = fields.category === "餐饮"
    ? "餐饮"
    : [fields.category, fields.subcategory].filter(Boolean).join("-");
  const note = fields.note;
  const week = naturalWeek(fields.occurredOn);
  const weekReference = week
    ? `${week.start.replaceAll("-", "")}-${week.end.replaceAll("-", "")}`
    : null;
  const number = draftTimestampReference(entry) ?? reference ?? "待确认";
  const reviewWarnings = [...new Set([
    ...draft.warnings,
    ...(Array.isArray(analysis.warnings)
      ? analysis.warnings.filter((warning) => warning !== CONFIRMATION_WARNING)
      : []),
  ])];
  const aiStatus = reviewWarnings.length
    ? `待复核：${[...new Set(reviewWarnings.slice(0, 4).map(warningText))].join("、")}`
    : "已识别，待你确认";
  const lines = [
    "【小小提醒！新增一条待记账信息】",
    `编号：${number}`,
    `类型：${entryType}`,
    `金额：${formatMoney(fields.amountCents)}`,
    `费用类别：${fieldText(category)}`,
    `备注：${fieldText(note, "无")}`,
    `周期：${weekReference ?? "待确认"}`,
    `AI 状态：${aiStatus}`,
  ];
  lines.push(
    "",
    "请引用本消息并回复",
  );
  if (reviewWarnings.includes("missing_trip_region")) {
    lines.push(
      weekReference
        ? `这笔餐饮还没有唯一出差区域，当前不能确认。请先回复“${weekReference}区域是济南”；多城市时请同时说明各日期范围和城市。`
        : "这笔餐饮还没有唯一出差区域，当前不能确认。请先说明对应自然周和出差城市；多城市时请同时说明各日期范围和城市。",
      "区域设置完成后，小小会发送更新后的记账消息；请引用最新消息回复“确认”。",
    );
  }
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function resultMessage(entry) {
  return `已确认并录入森特智行：${entry.expenseReferenceCode ?? entry.expenseId ?? entry.id}，金额 ${formatMoney(entry.amountCents)}。`;
}

// 修改… only counts as bookkeeping language when the remainder opens with a
// bookkeeping correction field (audit C B4): 修改客户/修改商机 must reach the
// deterministic router even while a draft is active. Longest-first keeps the
// alternation deterministic (费用类别 before 费用).
const MODIFICATION_FIELD_RE = new RegExp(
  `^(?:把|将)?\\s*(?:${[...BOOKKEEPING_CORRECTION_FIELD_WORDS]
    .sort((a, b) => b.length - a.length)
    .join("|")})`,
  "u",
);

function explicitModification(value) {
  const match = /^修改(?:[：:\s]+)?(.+)$/su.exec(String(value ?? ""));
  const body = match?.[1]?.trim() || null;
  if (!body) return null;
  return MODIFICATION_FIELD_RE.test(body) ? body : null;
}

function acceptedResult(entry) {
  return {
    entryId: entry.id,
    expenseId: entry.expenseId ?? null,
    paymentId: entry.paymentId ?? null,
  };
}

function isFinalizable(entry, { tripRegionResolver = null } = {}) {
  const { analysis, expense } = entryAnalysis(entry);
  const occurredOn = dateOnly(expense.occurredOn ?? entry.occurredOn);
  const amountCents = expense.amountCents ?? entry.amountCents;
  const purpose = expense.purpose ?? entry.purpose;
  let externallyResolvedRegion = null;
  if (occurredOn && typeof tripRegionResolver === "function") {
    try {
      externallyResolvedRegion = tripRegionResolver(occurredOn);
    } catch {
      externallyResolvedRegion = null;
    }
  }
  const mealNeedsRegion = entry.entryType === "expense"
    && entry.category === "餐饮"
    && ["早餐", "午餐", "晚餐"].includes(entry.subcategory)
    && (!analysis.noteAutomation?.tripRegion && !externallyResolvedRegion
      || (Array.isArray(analysis.warnings) && analysis.warnings.includes("missing_trip_region")));
  const unresolvedMealRegion = mealNeedsRegion && !externallyResolvedRegion;
  return Boolean(!unresolvedMealRegion
    && occurredOn
    && Number.isSafeInteger(amountCents)
    && amountCents > 0
    && typeof purpose === "string"
    && purpose.trim());
}

function reviewAnalysis(entry, nextFields, changedFields = {}, {
  tripRegionResolver = null,
  explicitDateTimeCorrection = false,
} = {}) {
  const { analysis, expense } = entryAnalysis(entry);
  const occurredOn = typeof nextFields.occurredOn === "string" ? nextFields.occurredOn.slice(0, 10) : expense.occurredOn ?? entry.occurredOn ?? null;
  const nextExpense = {
      ...expense,
      ...(occurredOn ? { occurredOn } : {}),
      ...(Object.hasOwn(changedFields, "occurredOn")
        ? {
            paidAt: correctedPaidAt(expense.paidAt ?? entry.capturedAt, nextFields.occurredOn, {
              explicitDateTime: explicitDateTimeCorrection,
              fallbackPaidTime: analysis.noteAutomation?.paidTime,
            }),
          }
        : {}),
      ...(Object.hasOwn(nextFields, "amountCents") ? { amountCents: nextFields.amountCents, reimbursementCents: nextFields.amountCents } : {}),
      ...(Object.hasOwn(nextFields, "merchant") ? { merchant: nextFields.merchant } : {}),
    ...(Object.hasOwn(nextFields, "purpose") ? { purpose: nextFields.purpose } : {}),
  };
  const manualCategoryCorrection = Object.hasOwn(changedFields, "category")
    || Object.hasOwn(changedFields, "subcategory");
  let categoryAutomation = manualCategoryCorrection
    ? null
    : analysis.categoryAutomation?.kind === "contextual"
      ? { ...analysis.categoryAutomation }
      : null;
  let category = nextFields.category ?? analysis.category ?? entry.category;
  const categoryChanged = Object.hasOwn(changedFields, "category")
    && changedFields.category !== (analysis.category ?? entry.category);
  let subcategory = Object.hasOwn(changedFields, "subcategory")
    ? nextFields.subcategory ?? null
    : categoryChanged
      ? null
      : Object.hasOwn(nextFields, "subcategory")
        ? nextFields.subcategory
        : analysis.subcategory ?? entry.subcategory ?? null;
  const contextualFieldChanged = ["occurredOn", "amountCents", "merchant", "purpose"]
    .some((field) => Object.hasOwn(changedFields, field));
  let reclassified = null;
  if (entry.entryType === "expense" && categoryAutomation && contextualFieldChanged) {
    const paidParts = shanghaiParts(nextExpense.paidAt);
    reclassified = buildBookkeepingAnalysis({
      recognition: {
        // Corrections are the newest evidence. Do not re-feed historical OCR
        // text here: an old labeled clock or merchant token must not outrank
        // the user's corrected time, merchant, or purpose.
        extractedText: null,
        evidence: {
          amountCents: nextExpense.amountCents ?? null,
          occurredOn,
          paidTime: paidParts ? `${paidParts.hour}:${paidParts.minute}` : null,
          merchant: nextExpense.merchant ?? null,
          paymentMethod: nextExpense.paymentMethod ?? null,
        },
        warnings: [],
        source: analysis.source ?? { provider: "rules", model: null },
      },
      expenseAnalysis: {
        expense: {
          category: categoryAutomation.sourceCategory,
          subcategory: categoryAutomation.sourceSubcategory,
          purpose: nextExpense.purpose ?? null,
          merchant: nextExpense.merchant ?? null,
          paidAt: nextExpense.paidAt ?? null,
          paymentMethod: nextExpense.paymentMethod ?? null,
        },
        warnings: [],
      },
      text: "",
      entryType: entry.entryType,
      now: entry.capturedAt ?? entry.createdAt ?? new Date(),
      tripRegionResolver: typeof tripRegionResolver === "function"
        ? ({ occurredOn: resolvedDate }) => tripRegionResolver(resolvedDate)
        : null,
    });
    category = reclassified.category;
    subcategory = reclassified.subcategory;
    categoryAutomation = reclassified.categoryAutomation;
  }
  const mealKey = category === "餐饮"
    ? subcategory === "早餐" ? "breakfast"
      : subcategory === "午餐" ? "lunch"
        : subcategory === "晚餐" ? "dinner"
          : null
    : null;
  const manualNote = Object.hasOwn(changedFields, "note");
  const priorNoteAutomation = analysis.noteAutomation?.kind === "meal"
    ? { ...analysis.noteAutomation }
    : null;
  const preserveManualNote = !priorNoteAutomation
    && typeof (entry.note ?? analysis.note) === "string"
    && Boolean((entry.note ?? analysis.note).trim());
  let noteAutomation = reclassified
    ? reclassified.noteAutomation
    : priorNoteAutomation;
  let note = manualNote
    ? nextFields.note ?? null
    : entry.note ?? analysis.note ?? null;
  if (manualNote) {
    noteAutomation = null;
  } else if (preserveManualNote) {
    noteAutomation = null;
  } else if (reclassified) {
    note = reclassified.note;
  } else if (noteAutomation) {
    if (Object.hasOwn(changedFields, "occurredOn") && explicitDateTimeCorrection) {
      const correctedTime = shanghaiParts(nextFields.occurredOn);
      if (correctedTime) noteAutomation.paidTime = `${correctedTime.hour}:${correctedTime.minute}`;
    }
    if (Object.hasOwn(changedFields, "occurredOn")
      && noteAutomation.tripRegionSource === "itinerary"
      && typeof tripRegionResolver === "function") {
      try {
        noteAutomation.tripRegion = tripRegionResolver(occurredOn) ?? null;
      } catch {
        noteAutomation.tripRegion = null;
      }
    }
    note = mealKey
      ? buildAutomaticMealNote({
          occurredOn,
          tripRegion: noteAutomation.tripRegion,
          mealKey,
        })
      : null;
    if (!note) noteAutomation = null;
  }
  const warnings = (Array.isArray(analysis.warnings)
    ? analysis.warnings.filter((item) => item !== CONFIRMATION_WARNING)
    : []).filter((warning) => {
      if (reclassified && ["missing_trip_region", "large_meal_context_unknown"].includes(warning)) return false;
      if (reclassified && category !== "其他"
        && ["missing_category", "invalid_category"].includes(warning)) return false;
      if (Number.isSafeInteger(nextExpense.amountCents) && nextExpense.amountCents > 0
        && /(?:amount|amountCents)/iu.test(warning)) return false;
      if (dateOnly(nextExpense.occurredOn)
        && /(?:date|occurredOn)/iu.test(warning)) return false;
      if (typeof nextExpense.purpose === "string" && nextExpense.purpose.trim()
        && /purpose/iu.test(warning)) return false;
      if (typeof nextExpense.merchant === "string" && nextExpense.merchant.trim()
        && /merchant/iu.test(warning)) return false;
      if (warning === "missing_trip_region" && noteAutomation?.tripRegion) return false;
      if (!mealKey && ["missing_trip_region", "large_meal_context_unknown"].includes(warning)) return false;
      return true;
    });
  if (reclassified) {
    warnings.push(...reclassified.warnings.filter(
      (warning) => ["missing_trip_region", "large_meal_context_unknown"].includes(warning),
    ));
  }
  if (mealKey && noteAutomation && !noteAutomation.tripRegion) warnings.push("missing_trip_region");
  return {
    ...analysis,
    status: "review_required",
    category,
    subcategory,
    note,
    noteAutomation,
    categoryAutomation,
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
  travelExpenseRepository = null,
  travelExpenseRegionRepository = null,
  travelExpenseDocumentInboxRepository = null,
  advanceAllocationRepository = null,
  pendingActionRepository,
  sessionRepository,
  outboxRepository,
  bindingsRepository,
  idFactory = randomUUID,
  clock = () => new Date(),
  confirmationSecret,
} = {}) {
  if (!db || !shortcutBookkeepingRepository || !pendingActionRepository || !sessionRepository || !outboxRepository) {
    throw new TypeError("Shortcut WeChat assistant runtime dependencies are required");
  }
  if (!bindingsRepository || typeof bindingsRepository.activeByAccount !== "function") {
    throw new TypeError("bindingsRepository is required for the shortcut WeChat assistant runtime");
  }
  const secret = secretBuffer(confirmationSecret);
  const enabled = config?.weixinBookkeepingConfirmationEnabled === true;

  // v0.9.3：owner/senderId 闭包常量退役——绑定表是唯一事实源，每次调用现查。
  function isReady() {
    return enabled && bindingsRepository.hasActive();
  }

  function isReadyFor(account) {
    return enabled && Boolean(bindingsRepository.activeByAccount(account));
  }

  function assertReadyFor(account) {
    if (!enabled) throw new HttpError(503, "WEIXIN_BOOKKEEPING_CONFIRMATION_DISABLED", "小小微信记账复核尚未启用");
    if (!isReadyFor(account)) {
      throw new HttpError(503, "WEIXIN_BOOKKEEPING_CONFIRMATION_NOT_READY", "该账号未绑定微信，暂无法投递微信消息");
    }
  }

  function conversationFor(account, requestedSender = null) {
    assertReadyFor(account);
    const binding = bindingsRepository.activeByAccount(account);
    const expectedSender = binding.senderId;
    if (requestedSender !== null && requestedSender !== undefined && requestedSender !== expectedSender) {
      throw new HttpError(403, "WEIXIN_SENDER_NOT_ALLOWED", "This WeChat sender is not allowed for WeChat bookkeeping confirmation");
    }
    return shortcutBookkeepingConversationId(account, expectedSender);
  }

  // 无绑定 → null（供“财务落库照常、回执跳过”的可空路径使用）。
  function conversationForOrNull(account) {
    try {
      return conversationFor(account);
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) return null;
      throw error;
    }
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

  function sourceDocumentFor(entry, account) {
    if (!travelExpenseDocumentInboxRepository || entry?.entryType !== "expense" || !entry?.sourceId) return null;
    const row = db.prepare(`
      SELECT id FROM travel_expense_document_inbox
      WHERE owner = $owner AND document_kind = 'payment_proof'
        AND source_message_id = $sourceRef
        AND status IN ('received', 'review_required', 'matched')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({ $owner: account, $sourceRef: entry.sourceId });
    const item = row
      ? travelExpenseDocumentInboxRepository.getDocument(row.id, { owner: account })
      : null;
    if (!item) return null;
    const content = travelExpenseDocumentInboxRepository.getDocumentContent(item.id, { owner: account });
    if (!content) return null;
    return {
      item,
      inboxId: item.id,
      inboxVersion: item.version,
      fileName: content.fileName,
      mediaType: content.mediaType,
      content: content.content,
    };
  }

  function regionForDate(account, occurredOn) {
    const profile = travelExpenseRegionRepository?.resolveRegion({ owner: account, occurredOn }) ?? null;
    if (profile?.city) return profile;
    const itinerary = resolveItineraryTripRegion(db, { owner: account, occurredOn });
    return itinerary ? { city: itinerary, source: "itinerary" } : null;
  }

  function synchronizeMealRegion(entry, analysisOverride = null) {
    const analysis = analysisOverride ?? entryAnalysis(entry).analysis;
    if (analysis.noteAutomation?.kind !== "meal") return { analysis, changed: false };
    const source = analysis.noteAutomation.tripRegionSource ?? null;
    if (EXPLICIT_TRIP_REGION_SOURCES.has(source) && analysis.noteAutomation.tripRegion) {
      return { analysis, changed: false };
    }
    const occurredOn = dateOnly(analysis.expense?.occurredOn ?? entry.occurredOn);
    const resolved = occurredOn ? regionForDate(entry.owner, occurredOn) : null;
    // A newly inferred meal that never had a resolved region already carries
    // missing_trip_region and a date/meal-only note. Only erase a prior
    // profile/itinerary-derived value when that external resolution went away.
    if (!resolved?.city && (!source || source === "itinerary") && !analysis.noteAutomation.tripRegion) {
      return { analysis, changed: false };
    }
    const subcategory = analysis.subcategory ?? entry.subcategory;
    const mealKey = subcategory === "早餐" ? "breakfast"
      : subcategory === "午餐" ? "lunch"
        : subcategory === "晚餐" ? "dinner"
          : null;
    const nextNoteAutomation = {
      ...analysis.noteAutomation,
      tripRegion: resolved?.city ?? null,
      tripRegionSource: resolved?.source ?? null,
    };
    const nextNote = resolved?.city && mealKey
      ? buildAutomaticMealNote({ occurredOn, tripRegion: resolved.city, mealKey })
      : null;
    const warnings = (analysis.warnings ?? []).filter((warning) => warning !== "missing_trip_region");
    if (!resolved?.city) warnings.push("missing_trip_region");
    const nextAnalysis = {
      ...analysis,
      note: nextNote,
      noteAutomation: nextNoteAutomation,
      warnings: [...new Set(warnings)],
    };
    const changed = JSON.stringify({
      note: analysis.note ?? null,
      noteAutomation: analysis.noteAutomation,
      warnings: analysis.warnings ?? [],
    }) !== JSON.stringify({
      note: nextAnalysis.note,
      noteAutomation: nextAnalysis.noteAutomation,
      warnings: nextAnalysis.warnings,
    });
    return { analysis: nextAnalysis, changed };
  }

  // The bookkeeping state transition and the travel-expense attachment use
  // separate repositories with separate document-blob transaction guards.
  // Complete the financial record first, then attach the already-received
  // proof outside that transaction. This keeps a blob preflight from opening
  // a nested SQLite transaction and leaves the accepted expense durable if a
  // later attachment/match retry is needed.
  function attachSourceDocumentAfterAcceptance({ account, entry, accepted, requestId }) {
    if (!travelExpenseRepository
      || !travelExpenseDocumentInboxRepository
      || entry?.entryType !== "expense"
      || !accepted?.expenseId
      || !accepted?.paymentId) {
      return { status: "not_applicable" };
    }
    const sourceDocument = sourceDocumentFor(entry, account);
    if (!sourceDocument) return { status: "not_available" };
    try {
      let expense = travelExpenseRepository.getExpense(accepted.expenseId, { owner: account });
      if (!expense) return { status: "not_available" };
      const marker = "微信图片记账:" + sourceDocument.inboxId;
      let attachment = expense.attachments.find((candidate) => (
        candidate.kind === "payment_proof"
        && candidate.notes === marker
      ));
      if (!attachment) {
        const updated = travelExpenseRepository.addAttachment(accepted.expenseId, {
          owner: account,
          actor: account,
          expectedVersion: expense.version,
          paymentIds: [accepted.paymentId],
          kind: "payment_proof",
          fileName: sourceDocument.fileName,
          mediaType: sourceDocument.mediaType,
          content: sourceDocument.content,
          coveredCents: expense.payments.find((payment) => payment.id === accepted.paymentId)?.reimbursementCents ?? 0,
          notes: marker,
        });
        const beforeIds = new Set(expense.attachments.map((candidate) => candidate.id));
        attachment = updated.attachments.find((candidate) => !beforeIds.has(candidate.id));
        expense = updated;
      }
      if (!attachment) throw new Error("BOOKKEEPING_PAYMENT_PROOF_ATTACHMENT_MISSING");
      const inbox = travelExpenseDocumentInboxRepository.getDocument(sourceDocument.inboxId, { owner: account });
      if (!inbox) return { status: "not_available" };
      if (inbox.status === "matched") {
        return { status: "matched", attachmentId: attachment.id, inboxId: sourceDocument.inboxId, replayed: true };
      }
      if (inbox.status !== "review_required") return { status: "pending", code: "DOCUMENT_INBOX_STATE_CONFLICT" };
      const matched = withImmediateTransaction(db, () => {
        const result = travelExpenseDocumentInboxRepository.markMatched(sourceDocument.inboxId, {
          owner: account,
          actor: account,
          expectedVersion: inbox.version,
          matchedExpenseId: expense.id,
          matchedPaymentId: accepted.paymentId,
          attachmentId: attachment.id,
        });
        insertAudit(db, {
          action: "travel_expense.attachment_add",
          entityType: "travel_expense_attachment",
          entityId: attachment.id,
          actor: account,
          requestId: requestId ?? entry.id,
          before: null,
          after: {
            id: attachment.id,
            expenseId: expense.id,
            paymentId: accepted.paymentId,
            kind: attachment.kind,
            sizeBytes: attachment.sizeBytes,
            sha256: createHash("sha256").update(sourceDocument.content).digest("hex"),
          },
          entityVersion: expense.version,
          metadata: { source: "weixin_bookkeeping", documentInboxId: sourceDocument.inboxId },
        });
        insertAudit(db, {
          action: "travel_expense_document_inbox.match",
          entityType: "travel_expense_document_inbox",
          entityId: result.id,
          actor: account,
          requestId: requestId ?? entry.id,
          before: { status: inbox.status, version: inbox.version },
          after: { status: result.status, version: result.version },
          entityVersion: result.version,
          metadata: {
            source: "weixin_bookkeeping",
            expenseId: expense.id,
            paymentId: accepted.paymentId,
            attachmentId: attachment.id,
          },
        });
        return result;
      });
      return { status: "matched", attachmentId: attachment.id, inboxId: sourceDocument.inboxId, inbox: matched };
    } catch (error) {
      // The expense acceptance is authoritative. Keep the inbox item for a
      // later reconciliation pass and expose only a bounded status to the
      // caller; never leak provider/SQLite details into WeChat.
      return { status: "pending", code: typeof error?.code === "string" ? error.code : "ATTACHMENT_MATCH_PENDING" };
    }
  }

  function rejectSourceDocumentAfterCancellation({ account, entry, requestId }) {
    if (!travelExpenseDocumentInboxRepository
      || entry?.entryType !== "expense"
      || !entry?.sourceId) return { status: "not_applicable" };
    const activeSibling = db.prepare(`
      SELECT 1
      FROM shortcut_bookkeeping_entries
      WHERE owner = $owner AND source_id = $sourceRef
        AND entry_type = 'expense' AND status <> 'rejected'
      LIMIT 1
    `).get({ $owner: account, $sourceRef: entry.sourceId });
    if (activeSibling) return { status: "shared_active" };
    const row = db.prepare(`
      SELECT id
      FROM travel_expense_document_inbox
      WHERE owner = $owner AND document_kind = 'payment_proof'
        AND source_message_id = $sourceRef AND status = 'review_required'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get({ $owner: account, $sourceRef: entry.sourceId });
    if (!row) return { status: "not_available" };
    try {
      const inbox = travelExpenseDocumentInboxRepository.getDocument(row.id, { owner: account });
      if (!inbox || inbox.status !== "review_required") return { status: "not_available" };
      const rejected = withImmediateTransaction(db, () => {
        const result = travelExpenseDocumentInboxRepository.rejectDocument(row.id, {
          owner: account,
          actor: account,
          expectedVersion: inbox.version,
        });
        insertAudit(db, {
          action: "travel_expense_document_inbox.reject",
          entityType: "travel_expense_document_inbox",
          entityId: result.id,
          actor: account,
          requestId: requestId ?? entry.id,
          before: { status: inbox.status, version: inbox.version },
          after: { status: result.status, version: result.version },
          entityVersion: result.version,
          metadata: { source: "weixin_bookkeeping_cancelled" },
        });
        return result;
      });
      return { status: "rejected", inbox: rejected };
    } catch (error) {
      return { status: "pending", code: typeof error?.code === "string" ? error.code : "DOCUMENT_REJECT_PENDING" };
    }
  }

  function reconcileAcceptedAttachments({ limit = 20 } = {}) {
    if (!isReady() || !travelExpenseRepository || !travelExpenseDocumentInboxRepository) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("limit must be a positive safe integer no greater than 100");
    }
    // 多绑定：跨全部 owner 扫描，逐行以行内 owner 归属处理。
    const rows = db.prepare(`
      SELECT entry.id, entry.owner
      FROM shortcut_bookkeeping_entries entry
      JOIN travel_expense_document_inbox inbox
        ON inbox.owner = entry.owner
       AND inbox.document_kind = 'payment_proof'
       AND inbox.source_message_id = entry.source_id
       AND inbox.status IN ('review_required', 'matched')
      WHERE entry.status = 'accepted'
        AND entry.entry_type = 'expense'
        AND entry.expense_id IS NOT NULL
        AND entry.payment_id IS NOT NULL
        AND (
          inbox.status = 'review_required'
          OR NOT EXISTS (
            SELECT 1
            FROM travel_expense_attachments attachment
            JOIN travel_expense_attachment_payments link
              ON link.attachment_id = attachment.id
            WHERE attachment.expense_id = entry.expense_id
              AND attachment.kind = 'payment_proof'
              AND attachment.notes = '微信图片记账:' || inbox.id
              AND link.payment_id = entry.payment_id
          )
        )
      ORDER BY entry.updated_at ASC, entry.id ASC
      LIMIT $limit
    `).all({ $limit: limit });
    return rows.map((row) => {
      const entry = shortcutBookkeepingRepository.getReview(row.id, { owner: row.owner });
      if (!entry || entry.status !== "accepted") return null;
      return attachSourceDocumentAfterAcceptance({
        account: row.owner,
        entry,
        accepted: acceptedResult(entry),
        requestId: `reconcile:${entry.id}`,
      });
    }).filter(Boolean);
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
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT $limit
    `).all({
      $owner: normalizedAccount,
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $limit: limit,
    }).map((row) => getShortcutAction(normalizedAccount, row.id)).filter(Boolean);
  }

  function implicitCurrentAction(actions, { allowUndelivered = false } = {}) {
    const candidates = actions
      .filter((action) => actionPayload(action)?.kind !== SHORTCUT_ADVANCE_ALLOCATION_KIND)
      .map((action) => ({
        action,
        updatedMs: Date.parse(action.updatedAt ?? action.createdAt ?? ""),
      }))
      .filter((candidate) => Number.isFinite(candidate.updatedMs))
      .sort((left, right) => right.updatedMs - left.updatedMs || right.action.id.localeCompare(left.action.id));
    if (candidates.length === 0) return null;
    let selected = null;
    if (candidates.length === 1) {
      selected = candidates[0].action;
    } else {
      const nowMs = Date.parse(iso(clock));
      const newest = candidates[0];
      const next = candidates[1];
      if (nowMs - newest.updatedMs <= IMPLICIT_CURRENT_WINDOW_MS
        && newest.updatedMs - next.updatedMs >= IMPLICIT_CURRENT_GAP_MS) {
        selected = newest.action;
      }
    }
    if (!selected || allowUndelivered) return selected;
    const payload = actionPayload(selected);
    if (!payload?.entryId || typeof outboxRepository.latestForEntry !== "function") return null;
    const latest = outboxRepository.latestForEntry({ owner: selected.owner, entryId: payload.entryId });
    return latest?.status === "sent" ? selected : null;
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
    // v0.9.3：无 active 绑定不阻断 Web 复核——财务落库照常、微信回执跳过。
    const deliveryConversationId = conversationForOrNull(normalizedAccount);
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
            ...(deliveryConversationId ? {} : { receiptSkipped: true }),
          },
        });
      }
      const closed = deliveryConversationId
        ? db.prepare(`
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
        })
        : { changes: 0 };
      return { replayed, closedCount: Number(closed.changes ?? 0) };
    });
    const settledAction = pendingActionRepository.get(action.id, {
      owner: normalizedAccount,
      channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      conversationId: action.conversationId,
    });
    let outbox = null;
    if (deliveryConversationId) {
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
    if (payload.kind === "hospital_tender_notice") {
      return renderHospitalTenderNoticeMessage(payload);
    }
    if (payload.kind === "action_reminder") {
      return renderActionReminderMessage(payload);
    }
    if (payload.kind === "daily_digest") {
      return renderDailyDigestMessage(payload);
    }
    if (payload.kind === "friday_closeout") {
      return renderFridayCloseoutMessage(payload);
    }
    if (payload.kind === "ops_alert") {
      return renderOpsAlertMessage(payload);
    }
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
    if (payload.kind === "cancelled") return `已取消小小记账 ${entry.id}，未写入费用和付款凭证。`;
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
    if (!isReady()) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("limit must be a positive safe integer no greater than 100");
    }
    reconcileAcceptedAttachments({ limit });
    const rows = db.prepare(`
      SELECT action.id AS action_id, action.owner, action.conversation_id,
             action.version, action.status AS action_status,
             entry.id AS entry_id, entry.status AS entry_status
      FROM assistant_pending_actions action
      JOIN shortcut_bookkeeping_entries entry
        ON entry.id = json_extract(action.payload_json, '$.entryId')
       AND entry.owner = action.owner
      WHERE action.channel = $channel
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
      $channel: SHORTCUT_BOOKKEEPING_CHANNEL,
      $actionType: SHORTCUT_BOOKKEEPING_ACTION,
      $limit: limit,
    });
    const receipts = rows.map((row) => {
      // 多绑定：逐行容错——某 owner 无绑定（解绑窗口）时跳过该行，不中断整轮。
      try {
        const entry = shortcutBookkeepingRepository.getReview(row.entry_id, { owner: row.owner });
        if (!entry || entry.status !== row.entry_status) return null;
        const targetActionStatus = entry.status === "accepted" ? "executed" : "cancelled";
        if (row.action_status === targetActionStatus) {
          const conversationId = conversationForOrNull(row.owner);
          if (!conversationId) return null;
          return enqueue(
            row.owner,
            conversationId,
            { id: row.action_id, version: Number(row.version) },
            row.entry_id,
            entry.status === "accepted" ? "accepted" : "cancelled",
          );
        }
        return settleFromWeb({ account: row.owner, entry, decision: row.entry_status }).outbox;
      } catch {
        return null;
      }
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
        WHERE entry.status = 'accepted' AND entry.entry_type = 'income'
          AND source.advance_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM assistant_pending_actions action
            WHERE action.owner = entry.owner AND action.action_type = $actionType
              AND json_extract(action.payload_json, '$.kind') = $kind
              AND json_extract(action.payload_json, '$.advanceId') = source.advance_id
          )
      `).all({
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
      attachSourceDocumentAfterAcceptance({ account, entry, accepted: acceptedResult(entry), requestId: action.id });
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
      attachSourceDocumentAfterAcceptance({ account, entry, accepted: acceptedResult(entry), requestId: action.id });
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
    const entryWeek = naturalWeek(assistantDateTime(
      entryAnalysis(entry).expense.occurredOn ?? entry.occurredOn,
    ));
    if (entryWeek) {
      const refreshed = refreshRegionDependentDrafts({
        account,
        assignment: { weekStart: entryWeek.start },
      });
      if (refreshed.includes(entry.id)) {
        return {
          status: 409,
          body: {
            status: "review_required",
            text: "出差区域规则已变化，小小已发送更新后的记账草稿。请引用最新草稿后再确认。",
          },
          draftText: "等待确认最新区域版本的记账草稿。",
        };
      }
    }
    const deliveredDraft = deliveredCurrentDraft({ account, action, entryId: target.entryId });
    if (!deliveredDraft) {
      try {
        enqueue(account, conversationFor(account), action, target.entryId, "region_refresh");
      } catch { /* the version fence remains closed; worker recovery may retry */ }
      return { status: 409, body: { status: "review_required", text: "请先查看小小发送的最新记账草稿，再回复“确认”。" }, draftText: "等待当前版本草稿送达。" };
    }
    if (!isFinalizable(entry, {
      tripRegionResolver: (occurredOn) => regionForDate(account, occurredOn)?.city ?? null,
    })) {
      const { analysis } = entryAnalysis(entry);
      const needsRegion = Array.isArray(analysis.warnings)
        && analysis.warnings.includes("missing_trip_region");
      return {
        status: 409,
        body: {
          status: "review_required",
          text: needsRegion
            ? "这笔餐饮草稿还没有唯一出差区域，请先回复例如“本周区域是济南”；多区域时请说明日期范围。区域设置完成后小小会发送更新后的草稿，再由你确认。"
            : `当前草稿还有待确认字段。${correctionHelp()}`,
        },
        draftText: needsRegion ? "等待确认出差区域。" : "仍需补充记账字段。",
      };
    }
    let confirmed;
    try {
      confirmed = pendingActionRepository.confirm(action.id, {
        ...scope,
        confirmationCode: deriveShortcutStateCredential(action.id, Number(deliveredDraft.payload.version), secret),
      });
    } catch (error) {
      if (error?.code === "ASSISTANT_ACTION_EXPIRED") {
        return { status: 410, body: { status: "error", text: "这笔记账草稿已过期，请重新发给小小。" }, draftText: "确认信息已处理。" };
      }
      return { status: 409, body: { status: "error", text: "当前草稿确认状态已变化，请重新发送给小小。" }, draftText: "确认信息已处理。" };
    }
    if (confirmed?.expired) return { status: 410, body: { status: "error", text: "这笔记账草稿已过期，请重新发给小小。" }, draftText: "确认信息已处理。" };
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
      const attachment = attachSourceDocumentAfterAcceptance({
        account,
        entry: accepted,
        accepted: completed.item,
        requestId: action.id,
      });
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
        body: {
          status: "ok",
          text: resultMessage(accepted),
          result: {
            entryId: target.entryId,
            expenseId: completed.item.expenseId,
            paymentId: completed.item.paymentId,
            attachmentStatus: attachment.status,
          },
        },
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
    const entry = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account });
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
      if (entry) {
        rejectSourceDocumentAfterCancellation({
          account,
          entry,
          requestId: action.id,
        });
      }
      try { enqueue(account, conversationFor(account), action, target.entryId, "cancelled"); } catch { /* best effort */ }
    }
    return { status: 200, body: { status: "cancel", text: "已取消当前小小记账，未写入费用。" }, draftText: "已取消小小记账。" };
  }

  async function revise({ action, account, scope, text }) {
    const target = actionPayload(action);
    if (!target) return { status: 409, body: { status: "error", text: "待确认操作无效。" }, draftText: "确认信息已处理。" };
    const entry = shortcutBookkeepingRepository.getReview(target.entryId, { owner: account });
    if (!entry || entry.status !== "review_required") return { status: 409, body: { status: "error", text: "这笔草稿已结束，不能再修改。" }, draftText: "草稿状态已变化。" };
    const currentDraft = draftFromEntry(entry);
    const correction = parseShortcutBookkeepingCorrection(text, {
      friendlyDates: true,
      now: clock(),
      currentOccurredOn: currentDraft.fields.occurredOn,
    });
    if (correction.status !== "accepted") {
      return { status: 200, body: { status: "clarify", text: correctionHelp() }, draftText: "等待明确的字段修改。" };
    }
    const nextDraft = applyShortcutBookkeepingCorrection(currentDraft, correction);
    if (nextDraft.status !== "ready" && nextDraft.status !== "review_required") {
      return { status: 200, body: { status: "clarify", text: correctionHelp() }, draftText: "修改未通过字段校验。" };
    }
    let analysis = reviewAnalysis(entry, nextDraft.fields, correction.changes, {
      tripRegionResolver: (occurredOn) => regionForDate(account, occurredOn)?.city ?? null,
      explicitDateTimeCorrection: /(?:\d{4}-\d{2}-\d{2}T)?(?:[01]\d|2[0-3]):[0-5]\d/u.test(text),
    });
    analysis = synchronizeMealRegion(entry, analysis).analysis;
    try {
      resolveBookkeepingCategory({
        ledgerName: entry.ledgerName,
        entryType: entry.entryType,
        category: analysis.category,
        subcategory: analysis.subcategory,
      });
    } catch {
      return {
        status: 200,
        body: { status: "clarify", text: "费用类别或小类不在当前三级记账菜单中，请重新明确修改。" },
        draftText: "等待有效的费用类别修改。",
      };
    }
    const claimed = shortcutBookkeepingRepository.claimReview(target.entryId, { owner: account });
    if (claimed.replayed) return { status: 409, body: { status: "error", text: "这笔草稿已结束，不能再修改。" }, draftText: "草稿状态已变化。" };
    try {
      const reviewPatch = {
        category: analysis.category,
        subcategory: analysis.subcategory,
        note: analysis.note,
      };
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
        draftText: "已更新小小记账草稿。",
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
      // The 修改 branch is carried by explicitModification's field vocabulary;
      // a bare 修改 (no body) still belongs here to keep the quote guidance.
      || explicitModification(text)
      || /^(?:确认|取消)/u.test(String(text ?? ""))
      || /^修改\s*[:：]?\s*$/u.test(String(text ?? "")),
    );
  }

  function financialEventScopeAllowed(context, serverData) {
    if (context?.channel !== SHORTCUT_BOOKKEEPING_CHANNEL) return true;
    const metadata = serverData?.auditMetadata;
    if (metadata?.financialScope !== true || metadata?.chatType !== "direct") return false;
    // v0.9.3：事件 sender 必须等于草稿 owner 当前绑定的 sender（哈希比对，防
    // 其他会话经隐式选中操作他人财务草稿）。
    const binding = bindingsRepository.activeByAccount(context?.owner);
    if (!binding) return false;
    const expectedSenderHash = createHash("sha256").update(binding.senderId, "utf8").digest("hex");
    return metadata?.senderHash === expectedSenderHash;
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
    if (!providerMessageId || !account) return false;
    try {
      const binding = bindingsRepository.activeByAccount(account);
      if (!binding) return false;
      const conversationId = shortcutBookkeepingConversationId(account, binding.senderId);
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

  function refreshRegionDependentDrafts({ account, assignment }) {
    const profileStart = assignment.weekStart;
    const profileEnd = naturalWeek(`${profileStart}T12:00:00+08:00`)?.end;
    if (!profileEnd) return [];
    const rows = db.prepare(`
      SELECT id FROM shortcut_bookkeeping_entries
      WHERE owner = $owner
        AND target_system = 'sentelligent'
        AND entry_type = 'expense'
        AND status = 'review_required'
        AND occurred_on BETWEEN $weekStart AND $weekEnd
      ORDER BY updated_at ASC, id ASC
      LIMIT 100
    `).all({ $owner: account, $weekStart: profileStart, $weekEnd: profileEnd });
    const refreshed = [];
    for (const row of rows) {
      const entry = shortcutBookkeepingRepository.getReview(row.id, { owner: account });
      if (!entry || entry.status !== "review_required") continue;
      const synchronized = synchronizeMealRegion(entry);
      if (!synchronized.changed) {
        const action = findActionForEntry(account, entry.id);
        const latest = outboxRepository.latestForEntry?.({ owner: account, entryId: entry.id });
        if (latest?.status === "failed" && typeof outboxRepository.requeueFailed === "function") {
          try {
            // A transient delivery failure keeps the same idempotency key. Reopen
            // that row before enqueue/replay so a refresh can actually recover
            // delivery instead of merely returning the terminal failed item.
            outboxRepository.requeueFailed(latest.id);
          } catch { /* terminal/superseded failures stay fenced */ }
        }
        if (action && ["pending", "confirmed"].includes(action.status)
          && !(latest?.status === "sent" && Number(latest?.payload?.version) === Number(action.version))) {
          try { enqueue(account, conversationFor(account), action, entry.id, "region_refresh"); } catch { /* retry later */ }
        }
        continue;
      }
      const nextAnalysis = synchronized.analysis;
      const claimed = shortcutBookkeepingRepository.claimReview(entry.id, { owner: account });
      if (claimed.replayed) continue;
      try {
        const action = findActionForEntry(account, entry.id);
        let renewedAction = null;
        if (action && ["pending", "confirmed"].includes(action.status)) {
          const scope = {
            owner: account,
            channel: SHORTCUT_BOOKKEEPING_CHANNEL,
            conversationId: action.conversationId,
          };
          renewedAction = pendingActionRepository.renewConfirmation(action.id, {
            ...scope,
            confirmationCode: deriveShortcutStateCredential(action.id, Number(action.version) + 1, secret),
          }).item;
          // Fence the previously delivered draft before persisting the refreshed
          // analysis. If persistence or enqueue later fails, no stale quote can
          // cross the renewed action version; confirm() can re-enqueue recovery.
          closePendingOutbox({
            account,
            conversationId: conversationFor(account),
            actionId: action.id,
            entryId: entry.id,
            errorCode: "WEIXIN_OUTBOX_REGION_REFRESHED",
          });
        }
        const updated = shortcutBookkeepingRepository.completeLocal(entry.id, {
          analysis: nextAnalysis,
          leaseToken: claimed.leaseToken,
          reviewPatch: {
            category: nextAnalysis.category,
            subcategory: nextAnalysis.subcategory,
            note: nextAnalysis.note,
          },
          revisionSource: "system",
        });
        if (renewedAction) {
          enqueue(account, conversationFor(account), renewedAction, entry.id, "region_refresh");
        }
        refreshed.push(updated.item.id);
      } catch (error) {
        try {
          shortcutBookkeepingRepository.release(entry.id, {
            leaseToken: claimed.leaseToken,
            errorCode: "WEIXIN_REGION_REFRESH_FAILED",
          });
        } catch {}
        throw error;
      }
    }
    return refreshed;
  }

  function assignRegion({ account, intent }) {
    if (!travelExpenseRegionRepository || intent?.intent !== "region_assignment") {
      return { status: 503, body: { status: "error", text: "出差区域配置暂不可用。" }, draftText: "区域配置不可用。" };
    }
    const assignment = intent.regionAssignment;
    const current = travelExpenseRegionRepository.getProfile({
      owner: account,
      weekStart: assignment.weekStart,
    });
    const saved = withImmediateTransaction(db, () => {
      const item = travelExpenseRegionRepository.putProfile({
        ...assignment,
        owner: account,
        actor: account,
        expectedVersion: current.version,
      });
      if (item.version !== current.version) {
        insertAudit(db, {
          action: "travel_expense.region_profile.save.weixin",
          entityType: "travel_expense_region_profile",
          entityId: `${account}:${assignment.weekStart}`,
          actor: account,
          requestId: `${account}:${assignment.weekStart}:weixin`,
          before: current,
          after: item,
          entityVersion: item.version,
          metadata: {
            source: "weixin",
            cityCount: item.cities.length,
            overrideCount: item.dateOverrides.length,
          },
        });
      }
      return item;
    });
    const refreshed = refreshRegionDependentDrafts({ account, assignment: saved });
    const summary = saved.defaultCity
      ? saved.defaultCity
      : saved.dateOverrides.length > 0
        ? saved.dateOverrides.map((item) => `${item.date.slice(5).replace("-", ".")} ${item.city}`).join("、")
        : saved.cities.join("、");
    return {
      status: 200,
      body: {
        status: "review_required",
        text: `已记录 ${saved.weekStart} 至 ${saved.weekEnd} 的出差区域：${summary}。${refreshed.length > 0 ? `已刷新 ${refreshed.length} 条同周待确认记账，请查看最新草稿后再确认。` : "这只是区域设置，未确认或写入任何费用。"}`,
        item: { regionProfile: saved, refreshedEntryIds: refreshed },
      },
      draftText: "已更新自然周出差区域。",
    };
  }

  async function handlePending({ action, context, text, textClassification, confirmationCode, pendingActionId, serverData }) {
    const account = context.owner;
    const quote = serverData?.quote ?? null;
    const intent = parseShortcutBookkeepingIntent(text, { friendlyDates: true, now: clock() });
    const shortcutQuote = quoteLikelyTargetsShortcut(account, quote);
    // Standalone Shortcut intents (loan allocation scope, weekly trip-region
    // assignment) are owned by this runtime regardless of which pending
    // action is active in the main conversation.
    const standaloneShortcutIntent = intent.status === "accepted"
      && (intent.intent === "loan_assignment" || intent.intent === "region_assignment");
    // Yield-path guard 1: when the main conversation owns a non-bookkeeping
    // pending action (for example a customer profile write awaiting its
    // six-digit code) and the message does not quote a bookkeeping draft,
    // codes/cancel/resend/ordinary text all belong to the generic
    // confirmation boundary. Without this, an active bookkeeping draft could
    // swallow the code for the unrelated action.
    if (action && action.actionType !== SHORTCUT_BOOKKEEPING_ACTION && !shortcutQuote && !standaloneShortcutIntent) {
      return null;
    }
    // Yield-path guard 2: without a quote or an explicit pending action id,
    // only bookkeeping language may bind implicitly to an active draft.
    // Ordinary text (customer questions, profile commands, chit-chat) goes
    // back to the deterministic router instead of being hijacked by the
    // implicit current-draft selector. Media capture still passes through to
    // the newCapture handoff below.
    const bookkeepingLanguage = intent.status === "accepted"
      || Boolean(explicitModification(text))
      || textClassification.kind !== "ordinary"
      || text === "确认";
    if (!quote && !pendingActionId && !bookkeepingLanguage && !serverData?.media) {
      return null;
    }
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
      || (intent.status === "accepted" && intent.intent === "region_assignment")
      || (pendingActionId && action?.actionType === SHORTCUT_BOOKKEEPING_ACTION),
    );
    if (shortcutSignal && !financialEventScopeAllowed(context, serverData)) {
      return {
        status: 403,
        body: { status: "error", text: "当前微信会话不属于小小记账绑定的本人私聊，未执行任何财务操作。" },
        draftText: "财务操作访问被拒绝。",
      };
    }
    if (intent.status === "accepted" && intent.intent === "region_assignment") {
      return assignRegion({ account, intent });
    }
    const newCapture = !quote
      && !pendingActionId
      && (Boolean(serverData?.media)
        || /^(?:记账|支出|收入|借款到账|收到(?:出差)?借款|工资到账|奖金到账)(?:[：:\s]|$)/u.test(text));
    if (newCapture) return null;
    let targetAction = null;
    let implicitTarget = false;
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
      const draftOnlyCorrection = intent.intent === "correction" || Boolean(explicitModification(text));
      const implicit = implicitCurrentAction(active, { allowUndelivered: draftOnlyCorrection });
      if (implicit) {
        targetAction = implicit;
        implicitTarget = true;
      } else if (active.length > 1 && commandTargetsShortcut(text, textClassification, pendingActionId, quote)) {
        return { status: 409, body: { status: "clarify", text: "当前有多笔待确认记账，请引用对应的小小草稿后回复“确认”“修改…”或“取消”。" }, draftText: "等待引用具体记账草稿。" };
      } else if (active.length === 1 && commandTargetsShortcut(text, textClassification, pendingActionId, quote)) {
        return { status: 200, body: { status: "clarify", text: "最新记账草稿尚未确认送达，请等待小小发出草稿后再回复。" }, draftText: "等待最新记账草稿送达。" };
      }
    }
    if (!targetAction) return null;
    // Implicit draft selection is deliberately owner-scoped so it can recover
    // from providers that omit quote metadata. Re-apply the exact sender and
    // direct-chat gate after selection so another allowlisted sender or an
    // allowed group cannot operate the owner's financial draft.
    if (!financialEventScopeAllowed(context, serverData)) {
      return {
        status: 403,
        body: { status: "error", text: "当前微信会话不属于小小记账绑定的本人私聊，未执行任何财务操作。" },
        draftText: "财务操作访问被拒绝。",
      };
    }
    if (pendingActionId && pendingActionId !== targetAction.id) {
      return { status: 409, body: { status: "error", text: "当前会话的待确认操作已变化，请查看最新微信消息。" }, draftText: "确认信息已处理。" };
    }
    const isFinancialCommand = intent.status === "accepted"
      && ["confirm", "cancel", "correction", "loan_assignment"].includes(intent.intent);
    if (context?.channel === SHORTCUT_BOOKKEEPING_CHANNEL
      && targetAction
      && !quote
      && !implicitTarget
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
      return { status: 200, body: { status: "clarify", text: "小小记账不使用六位确认码，请回复“确认”、以“修改”开头说明修改内容，或回复“取消”。" }, draftText: "等待明确的自然语言指令。" };
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
    // 动态就绪：enabled ∧ 存在 active 绑定（绑定表是唯一事实源）。
    get ready() {
      return isReady();
    },
    isReadyFor,
    assertReadyFor,
    conversationFor,
    startReview,
    settleFromWeb,
    attachAcceptedEntryAttachments: ({ account, entry, requestId } = {}) => attachSourceDocumentAfterAcceptance({
      account,
      entry,
      accepted: acceptedResult(entry),
      requestId,
    }),
    renderOutboxMessage,
    reconcileAcceptedAttachments,
    reconcileAcceptedReceipts,
    refreshRegionDependentDrafts: ({ account, weekStart } = {}) => (
      refreshRegionDependentDrafts({ account, assignment: { weekStart } })
    ),
    handlePending,
  });
}
