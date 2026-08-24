import { parseShortcutBookkeepingCorrection } from "./shortcutBookkeepingAssistant.js";

export const SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION = "shortcut-bookkeeping-intent/v1";

const QUESTION = /[?？]|(?:吗|么|呢|是否|是不是|能否|可以不可以|可不可以)\s*$/u;
const CONFIRM = /^(?:(?:好的?|行|可以)[，,\s]+)?(?:确认|确定|同意|批准|记账|记下|入账|就这样|没问题|无误|正确|确认入账)(?:(?:这笔|该笔|本笔)?(?:记账|入账)?|一下|吧|了|并入账|并记账)?[。！!，,\s]*$/u;
const CANCEL = /^(?:(?:好的?|行|可以)[，,\s]+)?(?:取消|撤销|作废|不要了|不记了|不入账|拒绝|放弃)(?:(?:这笔|该笔|本笔)?(?:记账|入账)?|一下|吧|了)?[。！!，,\s]*$/u;
const WEAK = /^(?:嗯+|哦+|啊+|好+|行+|可以|好的|收到|知道了|谢谢|ok|OK|yes|是的)[。！!！\s]*$/u;
const LOAN = /借款|预借|借支/u;
const ASSIGN = /(?:归属|算作|算我|记我|分配|归我|由|给|记在|属于)/u;
const SCOPE = /(?:用于|对应|覆盖|绑定|分配到|归到)/u;

function result(intent, extra = {}) {
  return { schemaVersion: SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION, status: "accepted", intent, ...extra, warnings: [] };
}

function review(warnings = ["unrecognized_intent"], extra = {}) {
  return { schemaVersion: SHORTCUT_BOOKKEEPING_INTENT_SCHEMA_VERSION, status: "review_required", intent: "unknown", ...extra, warnings: [...new Set(warnings)] };
}

function parseAssignment(text) {
  if (!LOAN.test(text) || !ASSIGN.test(text)) return null;
  // Keep the assignee as user-provided text; this module must not resolve identities.
  const match = text.match(/(?:归属|分配给|给|由|算作|记在|属于)\s*([^，。；;！？?]+?)(?:的)?(?:借款|预借|借支)?(?:[，。；;！？?]|$)/u);
  const assignee = match?.[1]?.trim();
  if (!assignee || /^(?:我|本人)$/u.test(assignee)) return { owner: "self" };
  if (assignee.length > 100 || QUESTION.test(text)) return null;
  return { owner: assignee };
}

function currentWeekStart(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const business = new Date(`${valueOf("year")}-${valueOf("month")}-${valueOf("day")}T00:00:00Z`);
  if (Number.isNaN(business.getTime())) return null;
  business.setUTCDate(business.getUTCDate() - ((business.getUTCDay() + 6) % 7));
  return business.toISOString().slice(0, 10);
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseScope(text, options = {}) {
  if (!SCOPE.test(text) && !/^(?:本周|这周|本星期|当前周)/u.test(text)) return null;
  if (/(?:本周|这周|本星期|当前周)/u.test(text)) {
    return { scope: "week", weekStart: currentWeekStart(options.now) };
  }
  const range = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})\s*(?:至|到|-|~|～)\s*(\d{4})[-/]?(\d{2})[-/]?(\d{2})/u);
  if (range) {
    const weekStart = `${range[1]}-${range[2]}-${range[3]}`;
    const weekEnd = `${range[4]}-${range[5]}-${range[6]}`;
    if (!validDateOnly(weekStart) || !validDateOnly(weekEnd)) return null;
    const start = new Date(`${weekStart}T00:00:00Z`);
    const end = new Date(`${weekEnd}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
      && start.getUTCDay() === 1 && end.getTime() - start.getTime() === 6 * 24 * 60 * 60 * 1000) {
      return { scope: "week", weekStart };
    }
    return null;
  }
  const reference = text.match(/(?:BK-[0-9A-F]{12}|编号\s*[：:]?\s*[0-9]{12})/iu)?.[0] ?? null;
  if (reference) return { scope: "expense", reference };
  if (/(?:这笔|该笔|本笔)(?:费用|支出|记账)?/u.test(text)) return { scope: "expense", reference: null };
  return null;
}

/** Parse explicit human intent at the Shortcut bookkeeping confirmation boundary. */
export function parseShortcutBookkeepingIntent(input, options = {}) {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 1_000) return review(["invalid_intent"]);
  const text = input.trim().replace(/[\u0000-\u001f\u007f]/gu, "");
  if (QUESTION.test(text) || WEAK.test(text)) return review(["ambiguous_intent"]);
  if (CANCEL.test(text)) return result("cancel");
  if (CONFIRM.test(text)) return result("confirm");
  const scope = parseScope(text, options);
  if (scope && (LOAN.test(text) || scope.scope === "week" || scope.scope === "expense")) {
    return result("loan_assignment", { assignment: { ...scope, owner: "self" } });
  }
  const assignment = parseAssignment(text);
  if (assignment) return result("loan_assignment", { assignment });
  if (/^(?:修改|更改|调整|设置|把|将|备注|说明|金额|日期|时间|商户|商家|用途|分类|子分类|费用类别)/u.test(text)) {
    const correction = parseShortcutBookkeepingCorrection(text, { friendlyDates: options.friendlyDates ?? true, now: options.now });
    if (correction.status !== "accepted") return review(correction.warnings, { intent: "correction", correction });
    return result("correction", { correction, changes: correction.changes });
  }
  return review();
}

export const parseBookkeepingIntent = parseShortcutBookkeepingIntent;
export const classifyShortcutBookkeepingIntent = parseShortcutBookkeepingIntent;
