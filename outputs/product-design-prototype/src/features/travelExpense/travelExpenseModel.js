import { getCurrentWeekRange } from "../../weekRange.js";

export const EXPENSE_CATEGORIES = Object.freeze([
  Object.freeze({ id: "breakfast", label: "早餐" }),
  Object.freeze({ id: "lunch", label: "午餐" }),
  Object.freeze({ id: "dinner", label: "晚餐" }),
  Object.freeze({ id: "lodging", label: "住宿" }),
  Object.freeze({ id: "transport", label: "交通" }),
  Object.freeze({ id: "hospitality", label: "招待" }),
  Object.freeze({ id: "other", label: "其他" }),
]);

export const FUNDING_SOURCES = Object.freeze([
  Object.freeze({ id: "personal", label: "个人垫付" }),
  Object.freeze({ id: "company", label: "公司直付" }),
  Object.freeze({ id: "advance", label: "请款资金" }),
]);

export const INVOICE_STATUSES = Object.freeze([
  Object.freeze({ id: "pending", label: "待人工确认" }),
  Object.freeze({ id: "covered", label: "已覆盖" }),
  Object.freeze({ id: "partial", label: "部分覆盖" }),
  Object.freeze({ id: "missing", label: "缺少票据" }),
]);

const CATEGORY_IDS = new Set(EXPENSE_CATEGORIES.map((item) => item.id));
const FUNDING_IDS = new Set(FUNDING_SOURCES.map((item) => item.id));
const INVOICE_STATUS_IDS = new Set(INVOICE_STATUSES.map((item) => item.id));
const CNY_FORMATTER = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const BUSINESS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== "string" || !value.trim()) throw new TypeError("A valid date is required");
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("A valid date is required");
  if (dateOnly && dateKey(parsed) !== value) throw new TypeError("A real calendar date is required");
  return parsed;
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function assertCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of cents`);
  }
  return value;
}

function safeItems(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function categoryLabel(category) {
  return EXPENSE_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

function fundingLabel(fundingSource) {
  return FUNDING_SOURCES.find((item) => item.id === fundingSource)?.label ?? fundingSource;
}

function safeAdd(left, right, name) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the safe integer range`);
  return result;
}

function attachmentPaymentIds(attachment) {
  if (Array.isArray(attachment?.paymentIds)) return attachment.paymentIds;
  if (attachment?.paymentId) return [attachment.paymentId];
  return [];
}

export function naturalWeekFor(value) {
  const current = toDate(value);
  const range = getCurrentWeekRange(current);
  return {
    start: range.periodStart,
    end: range.periodEnd,
  };
}

export function formatTravelExpenseDateTime(value) {
  if (!value) return "待补充";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return BUSINESS_DATE_TIME_FORMATTER.format(date);
}

export function flattenPaymentRows(expenses = []) {
  const rows = [];
  for (const expense of safeItems(expenses, "expenses")) {
    if (!CATEGORY_IDS.has(expense?.category)) throw new TypeError("category is invalid");
    if (!INVOICE_STATUS_IDS.has(expense?.invoiceStatus ?? "pending")) throw new TypeError("invoiceStatus is invalid");
    const attachments = safeItems(expense.attachments ?? [], "attachments");
    safeItems(expense.payments ?? [], "payments").forEach((payment, paymentIndex) => {
      const amountCents = assertCents(payment?.amountCents, "amountCents");
      const reimbursementCents = assertCents(payment?.reimbursementCents, "reimbursementCents");
      if (reimbursementCents > amountCents) {
        throw new TypeError("reimbursementCents cannot exceed amountCents");
      }
      if (!FUNDING_IDS.has(payment?.fundingSource)) throw new TypeError("fundingSource is invalid");
      const proofAttachments = attachments.filter((attachment) => (
        attachment.kind === "payment_proof" &&
        (attachmentPaymentIds(attachment).includes(payment.id) ||
          (attachmentPaymentIds(attachment).length === 0 && expense.payments.length === 1))
      ));
      const invoiceAttachments = attachments.filter((attachment) => (
        attachment.kind !== "payment_proof" &&
        (attachmentPaymentIds(attachment).includes(payment.id) || attachmentPaymentIds(attachment).length === 0)
      ));
      rows.push({
        expenseId: expense.id,
        expenseReferenceCode: expense.referenceCode,
        expenseVersion: expense.version,
        paymentId: payment.id ?? `${expense.id ?? "expense"}-payment-${paymentIndex + 1}`,
        occurredOn: expense.occurredOn,
        paidAt: payment.paidAt,
        category: expense.category,
        categoryLabel: categoryLabel(expense.category),
        purpose: expense.purpose ?? "",
        merchant: payment.merchant ?? expense.merchant ?? "",
        amountCents,
        reimbursementCents,
        differenceCents: amountCents - reimbursementCents,
        differenceReason: payment.differenceReason ?? "",
        fundingSource: payment.fundingSource,
        fundingLabel: fundingLabel(payment.fundingSource),
        paymentMethod: payment.paymentMethod ?? "other",
        accountLast4: payment.accountLast4 ?? "",
        invoiceStatus: expense.invoiceStatus ?? "pending",
        notes: expense.notes ?? "",
        proofAttachments,
        invoiceAttachments,
        paymentIndex,
      });
    });
  }

  return rows.sort((left, right) => (
    String(left.occurredOn).localeCompare(String(right.occurredOn)) ||
    String(left.paidAt).localeCompare(String(right.paidAt)) ||
    left.paymentIndex - right.paymentIndex ||
    String(left.paymentId).localeCompare(String(right.paymentId))
  ));
}

export function summarizeTravelExpenses(expenses = [], advances = []) {
  const rows = flattenPaymentRows(expenses);
  const summary = {
    expenseCount: expenses.length,
    paymentCount: rows.length,
    actualPaidCents: 0,
    reimbursementCents: 0,
    personalPaidCents: 0,
    companyDirectCents: 0,
    companyDirectPaidCents: 0,
    companyDirectReimbursementCents: 0,
    advanceFundedCents: 0,
    settlementEligibleCents: 0,
    advanceReceivedCents: 0,
    personalSettlementCents: 0,
    settlementDirection: "balanced",
    advanceRecorded: advances.length > 0,
    attachmentCount: 0,
    paymentProofCount: 0,
    categoryTotals: Object.fromEntries(EXPENSE_CATEGORIES.map((item) => [item.id, {
      id: item.id,
      label: item.label,
      expenseCount: 0,
      paymentCount: 0,
      actualPaidCents: 0,
      reimbursementCents: 0,
    }])),
    invoiceStatusCounts: { pending: 0, covered: 0, partial: 0, missing: 0 },
  };

  for (const expense of expenses) {
    const category = summary.categoryTotals[expense.category];
    if (category) category.expenseCount += 1;
    summary.attachmentCount = safeAdd(
      summary.attachmentCount,
      safeItems(expense.attachments ?? [], "attachments").length,
      "attachmentCount",
    );
    summary.paymentProofCount = safeAdd(
      summary.paymentProofCount,
      (expense.attachments ?? []).filter((item) => item.kind === "payment_proof").length,
      "paymentProofCount",
    );
    const invoiceStatus = expense.invoiceStatus ?? "pending";
    if (!Object.hasOwn(summary.invoiceStatusCounts, invoiceStatus)) throw new TypeError("invoiceStatus is invalid");
    summary.invoiceStatusCounts[invoiceStatus] += 1;
  }

  for (const row of rows) {
    summary.actualPaidCents = safeAdd(summary.actualPaidCents, row.amountCents, "actualPaidCents");
    summary.reimbursementCents = safeAdd(summary.reimbursementCents, row.reimbursementCents, "reimbursementCents");
    const category = summary.categoryTotals[row.category];
    category.paymentCount += 1;
    category.actualPaidCents = safeAdd(category.actualPaidCents, row.amountCents, `${row.category}.actualPaidCents`);
    category.reimbursementCents = safeAdd(category.reimbursementCents, row.reimbursementCents, `${row.category}.reimbursementCents`);

    if (row.fundingSource === "company") {
      summary.companyDirectPaidCents = safeAdd(summary.companyDirectPaidCents, row.amountCents, "companyDirectPaidCents");
      summary.companyDirectReimbursementCents = safeAdd(
        summary.companyDirectReimbursementCents,
        row.reimbursementCents,
        "companyDirectReimbursementCents",
      );
      summary.companyDirectCents = summary.companyDirectReimbursementCents;
      continue;
    }
    summary.settlementEligibleCents = safeAdd(
      summary.settlementEligibleCents,
      row.reimbursementCents,
      "settlementEligibleCents",
    );
    if (row.fundingSource === "personal") {
      summary.personalPaidCents = safeAdd(summary.personalPaidCents, row.amountCents, "personalPaidCents");
    }
    if (row.fundingSource === "advance") {
      summary.advanceFundedCents = safeAdd(summary.advanceFundedCents, row.amountCents, "advanceFundedCents");
    }
  }

  for (const advance of safeItems(advances, "advances")) {
    summary.advanceReceivedCents = safeAdd(
      summary.advanceReceivedCents,
      assertCents(advance?.receivedCents ?? 0, "receivedCents"),
      "advanceReceivedCents",
    );
  }
  summary.personalSettlementCents = safeAdd(
    summary.settlementEligibleCents,
    -summary.advanceReceivedCents,
    "personalSettlementCents",
  );
  summary.settlementDirection = summary.personalSettlementCents > 0
    ? "company_reimburses"
    : summary.personalSettlementCents < 0
      ? "individual_returns"
      : "balanced";
  return summary;
}

export function formatCny(cents) {
  return CNY_FORMATTER.format(assertCents(cents, "cents") / 100);
}

export function formatSignedCny(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError("cents must be a safe integer");
  if (cents === 0) return formatCny(0);
  return `${cents > 0 ? "+" : "-"}${formatCny(Math.abs(cents))}`;
}
