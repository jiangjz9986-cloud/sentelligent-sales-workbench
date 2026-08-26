import {
  buildExpenseLedgerRows,
  flattenPaymentRows,
  summarizeTravelExpenses,
} from "./travelExpenseModel.js";

const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = Object.freeze([
  Object.freeze({ short: "周一", long: "星期一" }),
  Object.freeze({ short: "周二", long: "星期二" }),
  Object.freeze({ short: "周三", long: "星期三" }),
  Object.freeze({ short: "周四", long: "星期四" }),
  Object.freeze({ short: "周五", long: "星期五" }),
  Object.freeze({ short: "周六", long: "星期六" }),
  Object.freeze({ short: "周日", long: "星期日" }),
]);

const CATEGORY_PRESENTATION = Object.freeze({
  breakfast: Object.freeze({ category: "餐饮", detail: "早餐" }),
  lunch: Object.freeze({ category: "餐饮", detail: "午餐" }),
  dinner: Object.freeze({ category: "餐饮", detail: "晚餐" }),
  meal: Object.freeze({ category: "餐饮", detail: "餐别待确认" }),
  lodging: Object.freeze({ category: "住宿", detail: "酒店" }),
  transport: Object.freeze({ category: "交通", detail: "出行" }),
  hospitality: Object.freeze({ category: "招待", detail: "商务招待" }),
  other: Object.freeze({ category: "其他", detail: "其他费用" }),
});

const REVIEW_CATEGORY_ALIASES = Object.freeze({
  早餐: "breakfast",
  午餐: "lunch",
  晚餐: "dinner",
  餐饮: "meal",
  住宿: "lodging",
  住宿费: "lodging",
  交通: "transport",
  交通费: "transport",
  打车: "transport",
  招待: "hospitality",
  礼品: "hospitality",
  其他: "other",
});

const REGION_SOURCE_LABELS = Object.freeze({
  entry_override: "单笔指定",
  date_override: "日期覆盖",
  week_default: "周默认",
  itinerary: "行程",
  payment_text: "付款凭证",
  ai_candidate: "AI 候选",
  unresolved: "待确认",
});

const PAYMENT_METHOD_LABELS = Object.freeze({
  wechat: "微信支付",
  weixin: "微信支付",
  alipay: "支付宝",
  cash: "现金",
  card: "银行卡",
  bank_card: "银行卡",
  corporate_card: "企业卡",
});

const FUNDING_LABELS = Object.freeze({
  personal: "个人垫付",
  company: "公司直付",
  advance: "出差借款",
});

const SHANGHAI_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
});

function safeArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function parseDateOnly(value, name = "date") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new TypeError(`${name} must use YYYY-MM-DD`);
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(timestamp);
  const normalized = parsed.toISOString().slice(0, 10);
  if (normalized !== value) throw new TypeError(`${name} must be a real calendar date`);
  return parsed;
}

function tryDateOnly(value) {
  try {
    return parseDateOnly(value);
  } catch {
    return null;
  }
}

function addDays(value, count) {
  return new Date(parseDateOnly(value).getTime() + (count * DAY_MS)).toISOString().slice(0, 10);
}

function safeCents(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of cents`);
  }
  return value;
}

function safeAdd(left, right, name) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(`${name} exceeds the safe integer range`);
  return total;
}

function normalizeWeek(week) {
  const start = week?.start ?? week?.periodStart;
  const end = week?.end ?? week?.periodEnd;
  const startDate = parseDateOnly(start, "week.start");
  parseDateOnly(end, "week.end");
  if (startDate.getUTCDay() !== 1) throw new TypeError("week.start must be Monday");
  if (addDays(start, 6) !== end) throw new TypeError("week.end must be the Sunday six days after week.start");
  return { start, end, label: `${start}—${end}` };
}

function dateInWeek(value, week) {
  return typeof value === "string" && value >= week.start && value <= week.end;
}

function monthDay(value) {
  return value.slice(5).replace("-", "/");
}

function shanghaiDateKey(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return SHANGHAI_DATE_FORMATTER.format(parsed);
}

function timeLabel(value, expectedDate) {
  if (!value) return "--:--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  if (expectedDate && shanghaiDateKey(parsed) !== expectedDate) return "--:--";
  return SHANGHAI_TIME_FORMATTER.format(parsed);
}

function reviewExpense(review) {
  return review?.analysis?.expense ?? {};
}

function reviewOccurredOn(review) {
  const expense = reviewExpense(review);
  return expense.occurredOn ?? expense.occurred_on ?? review?.occurredOn ?? review?.occurred_on ?? null;
}

function reviewAmountCents(review) {
  const expense = reviewExpense(review);
  const value = expense.amountCents ?? expense.amount_cents ?? review?.amountCents ?? review?.amount_cents;
  return safeCents(value, "review.amountCents", { nullable: true });
}

function reviewCategoryId(review) {
  const expense = reviewExpense(review);
  const candidates = [
    expense.category,
    expense.subcategory,
    review?.subcategory,
    review?.category,
  ];
  for (const value of candidates) {
    if (Object.hasOwn(CATEGORY_PRESENTATION, value)) return value;
    if (Object.hasOwn(REVIEW_CATEGORY_ALIASES, value)) return REVIEW_CATEGORY_ALIASES[value];
  }
  return "other";
}

function categoryPresentation(categoryId) {
  return CATEGORY_PRESENTATION[categoryId] ?? CATEGORY_PRESENTATION.other;
}

function resolveExpenseRegion(expense) {
  const city = expense?.tripRegion ?? expense?.trip_region ?? expense?.region ?? "";
  const source = expense?.tripRegionSource ?? expense?.trip_region_source ?? (city ? "entry_override" : "unresolved");
  return {
    city: String(city ?? "").trim(),
    source,
    sourceLabel: REGION_SOURCE_LABELS[source] ?? source ?? "待确认",
  };
}

function normalizeRegionOverrides(regionProfile) {
  const raw = regionProfile?.dateOverrides ?? regionProfile?.date_overrides ?? [];
  if (Array.isArray(raw)) {
    return new Map(raw.flatMap((item) => {
      const date = item?.date ?? item?.occurredOn ?? item?.occurred_on;
      const city = String(item?.city ?? item?.region ?? "").trim();
      return tryDateOnly(date) && city ? [[date, city]] : [];
    }));
  }
  if (raw && typeof raw === "object") {
    return new Map(Object.entries(raw).flatMap(([date, cityValue]) => {
      const city = String(cityValue?.city ?? cityValue ?? "").trim();
      return tryDateOnly(date) && city ? [[date, city]] : [];
    }));
  }
  return new Map();
}

function dayRegion(date, expenses, regionProfile, overrides) {
  const explicit = [...new Set(expenses
    .filter((expense) => expense?.occurredOn === date)
    .map((expense) => resolveExpenseRegion(expense).city)
    .filter(Boolean))];
  if (explicit.length === 1) {
    return { city: explicit[0], source: "entry_override", sourceLabel: REGION_SOURCE_LABELS.entry_override };
  }
  if (overrides.has(date)) {
    return { city: overrides.get(date), source: "date_override", sourceLabel: REGION_SOURCE_LABELS.date_override };
  }
  const weeklyDefault = String(
    regionProfile?.weeklyDefaultCity
      ?? regionProfile?.weekDefaultCity
      ?? regionProfile?.weekly_default_city
      ?? "",
  ).trim();
  if (weeklyDefault) {
    return { city: weeklyDefault, source: "week_default", sourceLabel: REGION_SOURCE_LABELS.week_default };
  }
  return { city: "区域待确认", source: "unresolved", sourceLabel: REGION_SOURCE_LABELS.unresolved };
}

function paymentSourceLabel(expense) {
  const payments = safeArray(expense?.payments ?? [], "payments");
  const labels = [...new Set(payments.map((payment) => {
    const method = PAYMENT_METHOD_LABELS[payment?.paymentMethod];
    if (payment?.fundingSource === "company") return method === "企业卡" ? method : "公司直付";
    if (payment?.fundingSource === "personal" && method) return method;
    return FUNDING_LABELS[payment?.fundingSource] ?? method ?? "付款记录";
  }))];
  return labels.length === 0 ? "付款待补" : labels.length === 1 ? labels[0] : "多种资金来源";
}

function firstPaymentTime(expense) {
  const values = safeArray(expense?.payments ?? [], "payments")
    .map((payment) => payment?.paidAt)
    .filter(Boolean)
    .sort();
  return timeLabel(values[0], expense?.occurredOn);
}

function expenseItem(expense, ledgerRow, fallbackRegion) {
  const payments = flattenPaymentRows([expense]);
  const reimbursementCents = payments.reduce((total, payment) => safeAdd(
    total,
    payment.reimbursementCents,
    "expense.reimbursementCents",
  ), 0);
  const category = categoryPresentation(expense.category);
  const region = resolveExpenseRegion(expense);
  const proofAttached = ledgerRow.visible.paymentProofs.length > 0;
  const invoicePending = ledgerRow.visible.invoiceStates.some((state) => state.id === "invoice_pending");
  return {
    id: `expense:${expense.id}`,
    sourceId: expense.id,
    referenceCode: expense.referenceCode ?? "",
    kind: "expense",
    formal: true,
    transactionType: "expense",
    transactionLabel: "支出",
    date: expense.occurredOn,
    time: firstPaymentTime(expense),
    categoryId: expense.category,
    categoryLabel: category.category,
    categoryDetail: category.detail,
    categoryText: `${category.category} / ${category.detail}`,
    notes: String(expense.notes ?? "").trim() || String(expense.purpose ?? "").trim() || "—",
    amountCents: ledgerRow.visible.amountCents,
    reimbursementCents,
    sourceLabel: paymentSourceLabel(expense),
    region: region.city || fallbackRegion.city,
    regionSource: region.city ? region.source : fallbackRegion.source,
    regionSourceLabel: region.city ? region.sourceLabel : fallbackRegion.sourceLabel,
    proofState: proofAttached ? "attached" : "missing",
    proofLabel: proofAttached ? "已附凭证" : "缺付款凭证",
    invoiceState: invoicePending ? "pending" : "ready",
    invoiceLabel: ledgerRow.visible.invoiceStates.map((state) => state.label).join("、"),
    action: invoicePending ? "补票" : "查看",
    needsReview: ledgerRow.needsReview,
    original: expense,
  };
}

function pendingItem(review, fallbackRegion) {
  const expense = reviewExpense(review);
  const category = categoryPresentation(reviewCategoryId(review));
  const region = resolveExpenseRegion(expense);
  const amountCents = reviewAmountCents(review);
  const occurredOn = reviewOccurredOn(review);
  return {
    id: `review:${review.id}`,
    sourceId: review.id,
    referenceCode: review.referenceCode ?? review.reference_code ?? "",
    kind: "review",
    formal: false,
    transactionType: "expense",
    transactionLabel: "支出",
    date: occurredOn,
    time: timeLabel(expense.paidAt ?? expense.paid_at ?? review.createdAt ?? review.created_at, occurredOn),
    categoryId: reviewCategoryId(review),
    categoryLabel: category.category,
    categoryDetail: category.detail,
    categoryText: `${category.category} / ${category.detail}`,
    notes: String(expense.notes ?? expense.purpose ?? review?.note ?? review?.notes ?? "").trim() || "待确认记账",
    amountCents,
    reimbursementCents: amountCents,
    sourceLabel: "微信小小",
    region: region.city || fallbackRegion.city,
    regionSource: region.city ? region.source : fallbackRegion.source,
    regionSourceLabel: region.city ? region.sourceLabel : fallbackRegion.sourceLabel,
    proofState: "pending",
    proofLabel: "待确认",
    invoiceState: "unknown",
    invoiceLabel: "确认后判断",
    action: "核对入账",
    needsReview: true,
    warnings: safeArray(review?.warnings ?? [], "review.warnings"),
    original: review,
  };
}

function advanceItem(advance) {
  const region = resolveExpenseRegion(advance);
  return {
    id: `advance:${advance.id}`,
    sourceId: advance.id,
    referenceCode: advance.referenceCode ?? advance.reference_code ?? "",
    kind: "advance",
    formal: true,
    transactionType: "income",
    transactionLabel: "收入",
    date: advance.receivedOn,
    time: timeLabel(advance.receivedAt ?? advance.received_at ?? advance.updatedAt ?? advance.updated_at, advance.receivedOn),
    categoryId: "advance",
    categoryLabel: "借款",
    categoryDetail: "出差借款",
    categoryText: "借款 / 出差借款",
    notes: String(advance.notes ?? "").trim() || String(advance.purpose ?? "").trim() || "出差借款到账",
    amountCents: safeCents(advance.receivedCents, "advance.receivedCents"),
    reimbursementCents: 0,
    sourceLabel: "银行到账",
    region: region.city || "—",
    regionSource: region.source,
    regionSourceLabel: region.sourceLabel,
    proofState: "system",
    proofLabel: "系统入账",
    invoiceState: "not_applicable",
    invoiceLabel: "—",
    action: "查看",
    needsReview: false,
    original: advance,
  };
}

function compareItems(left, right) {
  const leftTime = left.time === "--:--" ? "99:99" : left.time;
  const rightTime = right.time === "--:--" ? "99:99" : right.time;
  return leftTime.localeCompare(rightTime)
    || Number(left.formal) - Number(right.formal)
    || left.id.localeCompare(right.id);
}

function todayKey(today) {
  if (typeof today === "string" && tryDateOnly(today)) return today;
  const parsed = today instanceof Date ? today : new Date(today ?? Date.now());
  if (Number.isNaN(parsed.getTime())) throw new TypeError("today must be a valid date");
  return SHANGHAI_DATE_FORMATTER.format(parsed);
}

function selectedDayKey(days, requested, currentToday) {
  if (days.some((day) => day.date === requested)) return requested;
  if (days.some((day) => day.date === currentToday)) return currentToday;
  return days.find((day) => day.formalCount > 0 || day.pendingCount > 0)?.date ?? days[0].date;
}

function regionRuleSummary(regionProfile, overrideCount) {
  const weeklyDefault = String(
    regionProfile?.weeklyDefaultCity
      ?? regionProfile?.weekDefaultCity
      ?? regionProfile?.weekly_default_city
      ?? "",
  ).trim();
  if (!weeklyDefault && overrideCount === 0) return "区域规则待设置";
  const pieces = [];
  if (weeklyDefault) pieces.push(`周默认 ${weeklyDefault}`);
  if (overrideCount > 0) pieces.push(`${overrideCount} 个日期覆盖`);
  return pieces.join(" · ");
}

export function buildExpenseLedgerWorkbenchModel({
  week,
  expenses = [],
  advances = [],
  reviews = [],
  matches = [],
  noInvoiceConfirmations = [],
  regionProfile = null,
  selectedDate = null,
  today = new Date(),
} = {}) {
  const normalizedWeek = normalizeWeek(week);
  const sourceExpenses = safeArray(expenses, "expenses");
  const sourceAdvances = safeArray(advances, "advances");
  const sourceReviews = safeArray(reviews, "reviews");
  const weekExpenses = sourceExpenses.filter((expense) => dateInWeek(expense?.occurredOn, normalizedWeek));
  const weekAdvances = sourceAdvances.filter((advance) => (
    dateInWeek(advance?.receivedOn, normalizedWeek)
      && safeCents(advance?.receivedCents ?? 0, "advance.receivedCents") > 0
  ));
  const ledgerRows = buildExpenseLedgerRows(weekExpenses, {
    matches: safeArray(matches, "matches"),
    noInvoiceConfirmations: safeArray(noInvoiceConfirmations, "noInvoiceConfirmations"),
  });
  const ledgerByExpenseId = new Map(ledgerRows.map((row) => [row.id, row]));
  const overrides = normalizeRegionOverrides(regionProfile);
  const currentToday = todayKey(today);
  const days = WEEKDAY_LABELS.map((weekday, index) => {
    const date = addDays(normalizedWeek.start, index);
    const region = dayRegion(date, weekExpenses, regionProfile, overrides);
    const formalExpenses = weekExpenses
      .filter((expense) => expense.occurredOn === date)
      .map((expense) => expenseItem(expense, ledgerByExpenseId.get(expense.id), region));
    const incomeItems = weekAdvances
      .filter((advance) => advance.receivedOn === date)
      .map(advanceItem);
    const pendingItems = sourceReviews
      .filter((review) => reviewOccurredOn(review) === date)
      .map((review) => pendingItem(review, region));
    const items = [...formalExpenses, ...incomeItems, ...pendingItems].sort(compareItems);
    return {
      date,
      monthDay: monthDay(date),
      weekdayShort: weekday.short,
      weekdayLong: weekday.long,
      region: region.city,
      regionSource: region.source,
      regionSourceLabel: region.sourceLabel,
      formalExpenseCount: formalExpenses.length,
      formalIncomeCount: incomeItems.length,
      formalCount: formalExpenses.length + incomeItems.length,
      pendingCount: pendingItems.length,
      totalCount: items.length,
      isToday: date === currentToday,
      items,
    };
  });

  const chosenDate = selectedDayKey(days, selectedDate, currentToday);
  for (const day of days) day.selected = day.date === chosenDate;
  const selectedDay = days.find((day) => day.selected);
  const unassignedPending = sourceReviews
    // A review with no usable date still needs a visible human-confirmation
    // path. A review with a valid date in another natural week belongs only in
    // that week's ledger and must not be mislabeled as "missing a date" here.
    .filter((review) => !tryDateOnly(reviewOccurredOn(review)))
    .map((review) => pendingItem(review, {
      city: "区域待确认",
      source: "unresolved",
      sourceLabel: REGION_SOURCE_LABELS.unresolved,
    }));
  const summarySource = summarizeTravelExpenses(weekExpenses, weekAdvances);
  const missingInvoiceCount = ledgerRows.filter((row) => (
    row.visible.invoiceStates.some((state) => state.id === "invoice_pending")
  )).length;
  const balanceCents = -summarySource.personalSettlementCents;

  return {
    week: normalizedWeek,
    days,
    selectedDate: chosenDate,
    selectedDay,
    unassignedPending,
    regionRuleSummary: regionRuleSummary(regionProfile, overrides.size),
    summary: {
      formalExpenseCount: weekExpenses.length,
      formalIncomeCount: weekAdvances.length,
      pendingCount: days.reduce((total, day) => total + day.pendingCount, 0),
      unresolvedPendingCount: unassignedPending.length,
      formalExpenseCents: summarySource.actualPaidCents,
      reimbursableCents: summarySource.reimbursementCents,
      advanceIncomeCents: summarySource.advanceReceivedCents,
      advanceBalanceCents: balanceCents,
      advanceBalanceState: balanceCents > 0 ? "remaining" : balanceCents < 0 ? "overspent" : "balanced",
      missingProofCount: summarySource.paymentProofMissingCount,
      missingInvoiceCount,
    },
  };
}

export const expenseLedgerWorkbenchInternals = Object.freeze({
  CATEGORY_PRESENTATION,
  REGION_SOURCE_LABELS,
  normalizeWeek,
  reviewOccurredOn,
});
