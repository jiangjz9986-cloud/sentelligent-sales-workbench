import { createHash } from "node:crypto";

const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: "iso8601",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const DEFAULT_INVOICE_ESCALATION_LEVELS = Object.freeze([
  Object.freeze({ level: 1, days: 3 }),
  Object.freeze({ level: 2, days: 7 }),
  Object.freeze({ level: 3, days: 14 }),
]);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function optionalText(value, name, max = 500) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, name, max);
}

function validDate(value, name = "now") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid Date`);
  return date;
}

function dateOnlyParts(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be YYYY-MM-DD`);
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) throw new TypeError(`${name} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${name} is invalid`);
  }
  return { year, month, day };
}

function epochDay(value, name) {
  const { year, month, day } = dateOnlyParts(value, name);
  return Math.trunc(Date.UTC(year, month - 1, day) / 86_400_000);
}

function normalizeRevision(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("revision is invalid");
    return value;
  }
  if (typeof value === "string" && value.trim() && value.trim().length <= 200
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.trim())) {
    return value.trim();
  }
  throw new TypeError("revision is invalid");
}

function normalizeGap(gap) {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) throw new TypeError("gap is required");
  if (gap.serverConfirmed !== true) throw new TypeError("gap.serverConfirmed must be true");
  if (!Number.isSafeInteger(gap.missingCents) || gap.missingCents < 0) {
    throw new TypeError("gap.missingCents must be a non-negative integer");
  }
  if (typeof gap.noInvoiceConfirmed !== "boolean") {
    throw new TypeError("gap.noInvoiceConfirmed must be a boolean");
  }
  const startedOn = requiredText(gap.startedOn, "gap.startedOn", 10);
  dateOnlyParts(startedOn, "gap.startedOn");
  return Object.freeze({
    owner: requiredText(gap.owner, "gap.owner", 200),
    expenseId: requiredText(gap.expenseId, "gap.expenseId", 200),
    expenseReference: optionalText(gap.expenseReference, "gap.expenseReference", 200),
    revision: normalizeRevision(gap.revision),
    missingCents: gap.missingCents,
    startedOn,
    serverConfirmed: true,
    noInvoiceConfirmed: gap.noInvoiceConfirmed,
  });
}

export function normalizeInvoiceEscalationLevels(levels = DEFAULT_INVOICE_ESCALATION_LEVELS) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 20) {
    throw new TypeError("levels must be a non-empty bounded array");
  }
  const normalized = levels.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !Number.isSafeInteger(entry.level) || entry.level <= 0
      || !Number.isSafeInteger(entry.days) || entry.days <= 0) {
      throw new TypeError(`levels[${index}] is invalid`);
    }
    return Object.freeze({ level: entry.level, days: entry.days });
  });
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].level <= normalized[index - 1].level
      || normalized[index].days <= normalized[index - 1].days) {
      throw new TypeError("levels must increase strictly by level and days");
    }
  }
  return Object.freeze(normalized);
}

export function shanghaiDateOnly(value = new Date()) {
  const date = validDate(value);
  const parts = shanghaiDateFormatter.formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function revisionIdentity(gap) {
  const normalized = normalizeGap(gap);
  return {
    gap: normalized,
    hash: sha256(JSON.stringify([
      normalized.owner,
      normalized.expenseId,
      typeof normalized.revision,
      normalized.revision,
    ])),
  };
}

export function invoiceEscalationIdempotencyKey({ gap, level } = {}) {
  const { hash } = revisionIdentity(gap);
  if (!level || typeof level !== "object" || !Number.isSafeInteger(level.level) || level.level <= 0
    || !Number.isSafeInteger(level.days) || level.days <= 0) {
    throw new TypeError("level is invalid");
  }
  return `invoice-gap-escalation:v1:${hash}:level-${level.level}`;
}

export function evaluateInvoiceEscalationGap({
  gap,
  now = new Date(),
  levels = DEFAULT_INVOICE_ESCALATION_LEVELS,
} = {}) {
  const nowDate = validDate(now);
  const asOfDate = shanghaiDateOnly(nowDate);
  const normalizedLevels = normalizeInvoiceEscalationLevels(levels);
  const { gap: normalizedGap, hash: gapRevisionHash } = revisionIdentity(gap);

  if (normalizedGap.missingCents === 0) {
    return { status: "resolved", reason: "fully_invoiced", asOfDate };
  }
  if (normalizedGap.noInvoiceConfirmed) {
    return { status: "resolved", reason: "no_invoice_confirmed", asOfDate };
  }

  const daysOpen = epochDay(asOfDate, "asOfDate") - epochDay(normalizedGap.startedOn, "gap.startedOn");
  let dueLevel = null;
  for (const level of normalizedLevels) {
    if (daysOpen >= level.days) dueLevel = level;
  }
  if (!dueLevel) return { status: "not_due", asOfDate, daysOpen };

  const payload = Object.freeze({
    kind: "invoice_gap_escalation",
    expenseId: normalizedGap.expenseId,
    expenseReference: normalizedGap.expenseReference,
    gapRevisionHash,
    level: dueLevel.level,
    thresholdDays: dueLevel.days,
    daysOpen,
    missingCents: normalizedGap.missingCents,
    startedOn: normalizedGap.startedOn,
    asOfDate,
    humanActionRequired: true,
    automaticFinancialAction: false,
  });
  return { status: "due", asOfDate, daysOpen, level: dueLevel, payload };
}

export function renderInvoiceEscalationMessage(payload) {
  if (!payload || typeof payload !== "object" || payload.kind !== "invoice_gap_escalation") {
    throw new TypeError("invoice escalation payload is invalid");
  }
  if (!Number.isSafeInteger(payload.level) || payload.level <= 0
    || !Number.isSafeInteger(payload.thresholdDays) || payload.thresholdDays <= 0
    || !Number.isSafeInteger(payload.daysOpen)
    || !Number.isSafeInteger(payload.missingCents) || payload.missingCents <= 0
    || payload.humanActionRequired !== true || payload.automaticFinancialAction !== false) {
    throw new TypeError("invoice escalation payload is invalid");
  }
  const expenseId = requiredText(payload.expenseId, "payload.expenseId", 200);
  const expenseReference = optionalText(payload.expenseReference, "payload.expenseReference", 200) ?? expenseId;
  const startedOn = requiredText(payload.startedOn, "payload.startedOn", 10);
  const asOfDate = requiredText(payload.asOfDate, "payload.asOfDate", 10);
  dateOnlyParts(startedOn, "payload.startedOn");
  dateOnlyParts(asOfDate, "payload.asOfDate");
  return [
    `【发票缺口提醒｜第 ${payload.level} 级】`,
    `费用：${expenseReference}`,
    `当前发票缺口：¥${(payload.missingCents / 100).toFixed(2)}`,
    `缺口起始日：${startedOn}；截至 ${asOfDate} 已持续 ${payload.daysOpen} 天（本级阈值 ${payload.thresholdDays} 天）。`,
    "请人工补充并匹配发票，或由本人确认无票。",
    "本功能只负责提醒，不会自动接收发票、确认无票或修改财务账。",
  ].join("\n");
}

function staleError() {
  const error = new Error("The queued invoice gap reminder is stale");
  error.code = "WEIXIN_OUTBOX_STALE";
  return error;
}

export function createInvoiceEscalationOutboxRenderer({
  getInvoiceGap,
  clock = () => new Date(),
  levels = DEFAULT_INVOICE_ESCALATION_LEVELS,
} = {}) {
  if (typeof getInvoiceGap !== "function") throw new TypeError("getInvoiceGap must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const normalizedLevels = normalizeInvoiceEscalationLevels(levels);
  return function renderOutboxItem(item = {}) {
    const owner = typeof item.owner === "string" ? item.owner.trim() : "";
    const payload = item.payload;
    if (!owner || !payload || typeof payload !== "object" || payload.kind !== "invoice_gap_escalation"
      || typeof payload.expenseId !== "string" || !payload.expenseId.trim()
      || typeof payload.gapRevisionHash !== "string" || !/^[a-f0-9]{64}$/u.test(payload.gapRevisionHash)) {
      throw staleError();
    }

    let current;
    try {
      current = getInvoiceGap({ owner, expenseId: payload.expenseId });
      if (current && typeof current.then === "function") throw new TypeError("getInvoiceGap must be synchronous");
      const identity = revisionIdentity(current);
      const currentGap = identity.gap;
      const stale = currentGap.owner !== owner
        || currentGap.expenseId !== payload.expenseId
        || identity.hash !== payload.gapRevisionHash
        || currentGap.missingCents <= 0
        || currentGap.noInvoiceConfirmed
        || currentGap.missingCents !== payload.missingCents
        || currentGap.startedOn !== payload.startedOn
        || currentGap.expenseReference !== (payload.expenseReference ?? null);
      if (stale) throw staleError();
      // A backed-up level-1 reminder must not be delivered after the gap has
      // already crossed level 2 or 3. Re-evaluate against the current business
      // date and render current days-open text while retaining the durable
      // envelope only when its level is still the single highest due level.
      const currentDecision = evaluateInvoiceEscalationGap({
        gap: currentGap,
        now: validDate(clock(), "clock"),
        levels: normalizedLevels,
      });
      if (currentDecision.status !== "due"
        || currentDecision.level.level !== payload.level
        || currentDecision.level.days !== payload.thresholdDays) {
        throw staleError();
      }
      return renderInvoiceEscalationMessage(currentDecision.payload);
    } catch (error) {
      if (error?.code === "WEIXIN_OUTBOX_STALE") throw error;
      throw staleError();
    }
  };
}
