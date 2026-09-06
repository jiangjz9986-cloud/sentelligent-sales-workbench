const CATEGORY_LABELS = Object.freeze({
  breakfast: ["餐饮", "早餐"],
  lunch: ["餐饮", "午餐"],
  dinner: ["餐饮", "晚餐"],
  lodging: ["住宿费", null],
  transport: ["交通", null],
  maintenance: ["汽车维保", null],
  hospitality: ["招待/礼品", null],
  other: ["其他", null],
});

const PAYMENT_METHODS = new Set(["wechat", "alipay", "bank_card", "card", "cash", "other"]);

const MEAL_AMOUNT_LIMIT_CENTS = 4_000;
const MEAL_SUBCATEGORY_BY_KEY = Object.freeze({
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
});
const MEAL_MERCHANT_PATTERN = /(?:餐厅|餐馆|饭店|酒楼|食府|小吃|快餐|食堂|烧烤|火锅|烤肉|面馆|粉店|粥铺|包子|饺子|馄饨|米线|汉堡|咖啡|茶饮|奶茶|肯德基|麦当劳|必胜客)/u;
const MULTI_TRAVEL_MEAL_PATTERN = /(?:多人|同行|同事|团队|(?:[2-9]|[一二两三四五六七八九十])人).{0,12}(?:出差|差旅|用餐)/u;

const NORMALIZED_CATEGORIES = Object.freeze(new Map([
  ["餐饮", new Set(["早餐", "午餐", "晚餐", null])],
  ["住宿费", new Set([null])],
  ["交通", new Set([null, "火车", "路桥费", "打车", "代驾", "停车"])],
  ["汽车维保", new Set([null, "维修", "保养"])],
  ["招待/礼品", new Set([null])],
  ["其他", new Set([null])],
]));

const NON_TRANSACTION_ROW = /(?:余额|可用额度|应还|还款|原价|优惠|折扣|合计|总计|手续费|积分|账单日|还款日)/u;
const TERMINAL_AMOUNT = /(?<sign>[+\-\u2212]?)[\s]*(?<currency>[¥￥]?)[\s]*(?<amount>\d{1,9}(?:[.,]\d{2}))[\s]*(?:元)?[\s]*$/u;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function dateFromText(text, now) {
  const value = clean(text);
  const full = value.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/u);
  if (full) return validDate(`${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`);
  const monthDay = value.match(/(\d{1,2})月(\d{1,2})日?/u);
  if (!monthDay) return null;
  const base = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(base.getTime())) return null;
  return validDate(`${base.getFullYear()}-${String(monthDay[1]).padStart(2, "0")}-${String(monthDay[2]).padStart(2, "0")}`);
}

function paidAtFor(occurredOn, paidTime) {
  const date = validDate(occurredOn);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/u.test(clean(paidTime)) ? clean(paidTime) : "12:00";
  return date ? `${date}T${time}:00+08:00` : null;
}

function labeledPaidTimeFromText(text) {
  const value = clean(text);
  const timeSource = "(?<hour>[01]?\\d|2[0-3])[:：](?<minute>[0-5]\\d)";
  const explicit = new RegExp(
    `(?:支付|付款|交易|成交|消费|记账)(?:时间|时刻)?\\s*[:：]?\\s*${timeSource}(?!\\d)`,
    "u",
  ).exec(value);
  if (explicit?.groups) {
    return `${String(explicit.groups.hour).padStart(2, "0")}:${explicit.groups.minute}`;
  }
  return null;
}

function paidTimeFromText(text) {
  const value = clean(text);
  const labeled = labeledPaidTimeFromText(value);
  if (labeled) return labeled;
  const timeSource = "(?<hour>[01]?\\d|2[0-3])[:：](?<minute>[0-5]\\d)";
  // Screenshots often contain the iPhone status-bar clock before the actual
  // payment time. Without a semantic label, the last complete clock token is
  // the least surprising fallback for a payment-detail screen and remains
  // row-local for a split transaction list.
  const matches = [...value.matchAll(new RegExp(
    `(?:^|[^\\d])${timeSource}(?!\\d)`,
    "gu",
  ))];
  const match = matches.at(-1);
  return match?.groups
    ? `${String(match.groups.hour).padStart(2, "0")}:${match.groups.minute}`
    : null;
}

function paidTimeFromDateTime(value) {
  const date = new Date(clean(value));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  const result = `${part("hour")}:${part("minute")}`;
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(result) ? result : null;
}

function mealKeyFromTime(value) {
  const match = /^(?<hour>[01]\d|2[0-3]):[0-5]\d$/u.exec(clean(value));
  if (!match?.groups) return null;
  const hour = Number(match.groups.hour);
  if (hour >= 4 && hour <= 10) return "breakfast";
  if (hour >= 11 && hour <= 15) return "lunch";
  if (hour >= 17 && hour <= 23) return "dinner";
  return null;
}

function amountFromText(text) {
  const value = clean(text);
  const matches = [];
  const patterns = [
    /(?:金额|实付|支付|消费|支出|收入|借款|到账|¥|￥)\s*[:：]?\s*(\d{1,9}(?:[.,]\d{1,2})?)/giu,
    /(\d{1,9}(?:[.,]\d{1,2})?)\s*(?:元|块|人民币)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const normalized = String(match[1]).replace(",", ".");
      const amount = Number(normalized);
      const cents = Math.round(amount * 100);
      if (Number.isSafeInteger(cents) && cents > 0 && cents <= 99_999_999_999) matches.push(cents);
    }
  }
  return matches[0] ?? null;
}

function categoryFromText(text) {
  const value = clean(text);
  if (/招待|宴请|宴会|客户(?:早餐|午餐|晚餐|用餐)|商务餐/u.test(value)) return "hospitality";
  if (/汽修|汽车维修|车辆维修|修车|汽车保养|车辆保养/u.test(value)) return "maintenance";
  if (/交通|高铁|火车|打车|滴滴|出租|地铁|公交|高速|过路|停车|加油|机场|机票/u.test(value)) return "transport";
  if (/酒店|宾馆|住宿|房费/u.test(value)) return "lodging";
  if (/早餐|早饭|早点/u.test(value)) return "breakfast";
  if (/午餐|午饭|中餐/u.test(value)) return "lunch";
  if (/晚餐|晚饭|夜宵/u.test(value)) return "dinner";
  return "other";
}

function inferredMealKey({ text, amountCents, paidTime }) {
  const key = mealKeyFromTime(paidTime);
  if (!key) return null;
  if (Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= MEAL_AMOUNT_LIMIT_CENTS) {
    return key;
  }
  const value = clean(text);
  return MEAL_MERCHANT_PATTERN.test(value) || MULTI_TRAVEL_MEAL_PATTERN.test(value) ? key : null;
}

function transportSubcategory(text) {
  const value = clean(text);
  if (/高铁|火车/u.test(value)) return "火车";
  if (/高速|过路|路桥/u.test(value)) return "路桥费";
  if (/打车|滴滴|出租/u.test(value)) return "打车";
  if (/代驾/u.test(value)) return "代驾";
  if (/停车/u.test(value)) return "停车";
  return null;
}

function maintenanceSubcategory(text) {
  const value = clean(text);
  if (/保养/u.test(value)) return "保养";
  if (/维修|汽修|修车/u.test(value)) return "维修";
  return null;
}

export function classifyBookkeepingEntry({ text = "", entryType = null } = {}) {
  const value = clean(text);
  if (entryType === "income" || /收入|借款|借支|预借|到账|预付款/u.test(value)) return "income";
  return "expense";
}

export function mapBookkeepingCategory({
  category,
  subcategory = null,
  text = "",
  entryType = "expense",
  amountCents = null,
  paidTime = null,
} = {}) {
  if (entryType === "income") {
    if (/借款|借支|预借|出差借款/u.test(clean(text))) return { category: "出差", subcategory: "借款" };
    if (/奖金|奖励/u.test(clean(text))) return { category: "奖金", subcategory: null };
    if (/工资|薪资|工资到账/u.test(clean(text))) return { category: "工资", subcategory: null };
    return { category: "其他", subcategory: null };
  }
  const normalizedChinese = clean(category);
  const normalizedSubcategory = clean(subcategory) || null;
  const allowedSubcategories = NORMALIZED_CATEGORIES.get(normalizedChinese);
  const inferredMeal = inferredMealKey({ text, amountCents, paidTime });
  const textualKey = categoryFromText(text);
  const textualMeal = ["breakfast", "lunch", "dinner"].includes(textualKey)
    ? textualKey
    : null;
  // Purpose/merchant evidence for a non-meal category is stronger than a
  // model's early breakfast/lunch/dinner token match. This prevents strings
  // such as "客户宴请午餐" or "火车午餐" from being written as routine meals.
  if (["hospitality", "maintenance", "transport", "lodging"].includes(textualKey)) {
    const [mappedCategory, mappedSubcategory] = CATEGORY_LABELS[textualKey];
    return {
      category: mappedCategory,
      subcategory: textualKey === "transport"
        ? transportSubcategory(text)
        : textualKey === "maintenance"
          ? maintenanceSubcategory(text)
          : mappedSubcategory,
    };
  }
  if (normalizedChinese === "餐饮" && normalizedSubcategory === null && inferredMeal) {
    return { category: "餐饮", subcategory: MEAL_SUBCATEGORY_BY_KEY[inferredMeal] };
  }
  if (allowedSubcategories?.has(normalizedSubcategory) && normalizedChinese !== "其他") {
    return { category: normalizedChinese, subcategory: normalizedSubcategory };
  }
  const normalized = clean(category).toLowerCase();
  const modeledKey = CATEGORY_LABELS[normalized] ? normalized : null;
  const modeledMeal = ["breakfast", "lunch", "dinner"].includes(modeledKey);
  const key = modeledMeal
    ? textualMeal ?? inferredMeal ?? "other"
    : modeledKey && modeledKey !== "other"
      ? modeledKey
      : textualKey !== "other"
        ? textualKey
        : inferredMeal ?? "other";
  const [mappedCategory, mappedSubcategory] = CATEGORY_LABELS[key] ?? CATEGORY_LABELS.other;
  return {
    category: mappedCategory,
    subcategory: key === "transport"
      ? transportSubcategory(text)
      : key === "maintenance"
        ? maintenanceSubcategory(text)
        : mappedSubcategory,
  };
}

function normalizedTripRegion(value) {
  const normalized = clean(value)
    .replace(/^(?:到|赴|前往|去)/u, "")
    .replace(/(?:出差|差旅)$/u, "")
    .replace(/[，。；,.;：:\s]+$/u, "")
    .trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  if (/^(?:多人|同行|同事|团队|客户|业务|个人|本次|这次|当天)/u.test(normalized)) return null;
  return normalized;
}

export function tripRegionFromText(text) {
  const value = clean(text).normalize("NFKC");
  if (!value) return null;
  const explicit = /(?:出差区域|出差地点|差旅区域|所在地区|所在城市)\s*[:：]?\s*(?<region>\p{Script=Han}{2,10}?)(?=\s|早餐|午餐|晚餐|用餐|$)/u.exec(value);
  if (explicit?.groups?.region) return normalizedTripRegion(explicit.groups.region);
  const tripPrefix = /(?:^|[\s，,。；;：:])(?:到|赴|前往|去)(?<region>\p{Script=Han}{2,8}?)(?:出差|差旅)(?=\s|早餐|午餐|晚餐|用餐|$)/u.exec(value);
  if (tripPrefix?.groups?.region) return normalizedTripRegion(tripPrefix.groups.region);
  return null;
}

export function buildAutomaticMealNote({ occurredOn, tripRegion, mealKey }) {
  const meal = MEAL_SUBCATEGORY_BY_KEY[mealKey];
  if (!meal) return null;
  const date = validDate(occurredOn);
  if (!date) return null;
  const dateLabel = `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`;
  return `${dateLabel}${normalizedTripRegion(tripRegion) ?? ""}${meal}`;
}

function normalizedOcrLines(value) {
  return clean(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\u00a0]+/gu, " ").replace(/\s{2,}/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 300);
}

function merchantFromAnchorPrefix(value) {
  const normalized = clean(value)
    .replace(/^[\p{P}\p{S}\d\s]+/gu, "")
    .replace(/[\p{P}\p{S}\s]+$/gu, "")
    .trim();
  if (!normalized || NON_TRANSACTION_ROW.test(normalized)) return null;
  return normalized.slice(0, 300);
}

/**
 * Split OCR from transaction-list screenshots into independently confirmable
 * rows. A terminal signed/currency decimal is the row anchor. Two or more
 * distinct anchor lines are required, so a detail screen containing original
 * price/discount/paid amounts is not accidentally expanded into several
 * expenses. Dates intentionally remain nullable when the low-contrast row was
 * not read by OCR; receipt time must never be substituted for occurrence time.
 */
function amountAnchor(line) {
  const match = TERMINAL_AMOUNT.exec(line);
  if (!match) return null;
  const prefix = line.slice(0, match.index).trim();
  const signed = Boolean(match.groups?.sign);
  const currency = Boolean(match.groups?.currency);
  if ((!signed && !currency) || NON_TRANSACTION_ROW.test(prefix)) return null;
  const amount = Number(String(match.groups.amount).replace(",", "."));
  const amountCents = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 99_999_999_999) return null;
  return {
    match,
    prefix,
    amountCents,
    entryType: match.groups.sign === "+" ? "income" : "expense",
  };
}

function linesFromLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout) || !Array.isArray(layout.tokens)) return [];
  const groups = new Map();
  for (const token of layout.tokens.slice(0, 4000)) {
    if (!token || typeof token !== "object" || typeof token.text !== "string" || !token.text.trim()) continue;
    const numbers = [token.page, token.block, token.paragraph, token.line, token.word,
      token.left, token.top, token.width, token.height].map(Number);
    if (numbers.some((item) => !Number.isFinite(item)) || numbers[7] <= 0 || numbers[8] <= 0) continue;
    const [page, block, paragraph, line, word, left, top, width, height] = numbers;
    const key = `${page}:${block}:${paragraph}:${line}`;
    const group = groups.get(key) ?? { page, block, paragraph, line, tokens: [] };
    group.tokens.push({ word, left, top, width, height, text: token.text.trim() });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.tokens.sort((left, right) => left.word - right.word || left.left - right.left);
    const left = Math.min(...group.tokens.map((token) => token.left));
    const top = Math.min(...group.tokens.map((token) => token.top));
    const right = Math.max(...group.tokens.map((token) => token.left + token.width));
    const bottom = Math.max(...group.tokens.map((token) => token.top + token.height));
    return {
      ...group,
      left,
      top,
      right,
      bottom,
      centerY: (top + bottom) / 2,
      text: group.tokens.map((token) => token.text).join(" "),
    };
  }).sort((left, right) => left.centerY - right.centerY || left.left - right.left);
}

function extractLayoutRows(layout) {
  const pageWidth = Number(layout?.pageWidth);
  if (!Number.isFinite(pageWidth) || pageWidth < 1) return [];
  const lines = linesFromLayout(layout);
  const candidates = lines.flatMap((line) => {
    const anchor = amountAnchor(line.text);
    if (!anchor) return [];
    const amountToken = [...line.tokens].reverse().find((token) => /\d[.,]\d{2}/u.test(token.text));
    if (!amountToken) return [];
    const anchorRight = amountToken.left + amountToken.width;
    if (anchorRight < pageWidth * 0.62) return [];
    return [{ ...anchor, line, amountToken, anchorRight }];
  });
  if (candidates.length < 2) return [];
  const tolerance = Math.max(20, pageWidth * 0.045);
  let cluster = [];
  for (const candidate of candidates) {
    const current = candidates.filter((other) => Math.abs(other.anchorRight - candidate.anchorRight) <= tolerance);
    if (current.length > cluster.length) cluster = current;
  }
  if (cluster.length < 2) return [];
  cluster.sort((left, right) => left.line.centerY - right.line.centerY);
  return cluster.map((anchor, index) => {
    const previousY = cluster[index - 1]?.line.centerY;
    const nextY = cluster[index + 1]?.line.centerY;
    const top = previousY === undefined ? Number.NEGATIVE_INFINITY : (previousY + anchor.line.centerY) / 2;
    const bottom = nextY === undefined ? Number.POSITIVE_INFINITY : (anchor.line.centerY + nextY) / 2;
    const rowLines = lines.filter((line) => line.centerY >= top && line.centerY < bottom);
    const merchantWords = anchor.line.tokens.filter((token) => (
      token.left + token.width < anchor.amountToken.left
      && token.left >= pageWidth * 0.12
    ));
    const merchantSource = merchantWords.length
      ? merchantWords.map((token) => token.text).join(" ")
      : anchor.prefix;
    const merchant = merchantFromAnchorPrefix(merchantSource);
    const rowText = rowLines.map((line) => line.text).join("\n").slice(0, 12_000);
    return {
      index,
      amountCents: anchor.amountCents,
      entryType: anchor.entryType,
      merchant,
      text: rowText,
      warnings: merchant && /(?:\.\.\.|…)/u.test(merchantSource) ? ["merchant_partial"] : [],
      region: {
        top: Number.isFinite(top) ? Math.max(0, Math.round(top)) : 0,
        bottom: Number.isFinite(bottom) ? Math.round(bottom) : Number(layout.pageHeight) || null,
        amountRight: Math.round(anchor.anchorRight),
      },
    };
  });
}

export function extractBookkeepingRows(text, { layout = null } = {}) {
  const layoutRows = extractLayoutRows(layout);
  if (layoutRows.length > 1) return layoutRows;
  if (layout && typeof layout === "object" && Array.isArray(layout.tokens) && layout.tokens.length > 0) return [];
  const lines = normalizedOcrLines(text);
  const anchors = [];
  lines.forEach((line, lineIndex) => {
    const anchor = amountAnchor(line);
    if (!anchor) return;
    anchors.push({
      lineIndex,
      amountCents: anchor.amountCents,
      entryType: anchor.entryType,
      merchant: merchantFromAnchorPrefix(anchor.prefix),
    });
  });
  if (anchors.length < 2) return [];
  return anchors.map((anchor, index) => {
    const end = anchors[index + 1]?.lineIndex ?? lines.length;
    const rowLines = lines.slice(anchor.lineIndex, end);
    return {
      index,
      amountCents: anchor.amountCents,
      entryType: anchor.entryType,
      merchant: anchor.merchant,
      text: rowLines.join("\n").slice(0, 12_000),
    };
  });
}

function paymentMethod(value) {
  const normalized = clean(value).toLowerCase();
  if (!PAYMENT_METHODS.has(normalized)) return "other";
  return normalized === "bank_card" ? "card" : normalized;
}

function warningsFor({
  amountCents,
  occurredOn,
  purpose,
  category,
  recognition,
  expenseAnalysis,
  extraWarnings = [],
}) {
  const warnings = [];
  for (const warning of [
    ...(Array.isArray(recognition?.warnings) ? recognition.warnings : []),
    ...(Array.isArray(expenseAnalysis?.warnings) ? expenseAnalysis.warnings : []),
    ...extraWarnings,
  ]) {
    if (typeof warning === "string" && warning.trim()) warnings.push(warning.trim());
  }
  const resolved = warnings.filter((warning) => {
    if (validDate(occurredOn) && /(?:missing|invalid)_(?:date|occurredOn)/iu.test(warning)) return false;
    if (Number.isSafeInteger(amountCents) && amountCents > 0
      && /(?:missing|invalid)_(?:amount|amountCents)/iu.test(warning)) return false;
    if (clean(purpose) && /(?:missing|invalid)_purpose/iu.test(warning)) return false;
    if (clean(category) && category !== "其他" && /(?:missing|invalid)_category/iu.test(warning)) return false;
    return true;
  });
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) resolved.push("missing_amount");
  if (!validDate(occurredOn)) resolved.push("missing_date");
  if (!clean(purpose)) resolved.push("missing_purpose");
  // Receipt arrival is always a reviewable draft, even when OCR is complete.
  resolved.push("WEIXIN_CONFIRMATION_REQUIRED");
  return [...new Set(resolved)];
}

export function buildBookkeepingAnalysis({
  recognition = {},
  expenseAnalysis = null,
  text = "",
  entryType = "expense",
  now = new Date(),
  tripRegionResolver = null,
} = {}) {
  const evidence = recognition?.evidence && typeof recognition.evidence === "object" ? recognition.evidence : {};
  const analyzedExpense = expenseAnalysis?.expense && typeof expenseAnalysis.expense === "object"
    ? expenseAnalysis.expense
    : {};
  const occurredOn = validDate(evidence.occurredOn)
    ?? validDate(analyzedExpense.occurredOn)
    ?? dateFromText(recognition?.extractedText ?? text, now);
  const amountCents = Number.isSafeInteger(evidence.amountCents) && evidence.amountCents > 0
    ? evidence.amountCents
    : Number.isSafeInteger(analyzedExpense.amountCents) && analyzedExpense.amountCents > 0
      ? analyzedExpense.amountCents
      : amountFromText(`${text}\n${recognition?.extractedText ?? ""}`);
  const merchant = clean(evidence.merchant) || clean(analyzedExpense.merchant) || null;
  const purpose = clean(analyzedExpense.purpose)
    || merchant
    || (entryType === "income"
      ? (/借款|借支|预借|到账/u.test(`${text}\n${recognition?.extractedText ?? ""}`) ? "出差借款" : "其他收入")
      : null);
  const combinedText = `${text}\n${recognition?.extractedText ?? ""}\n${merchant ?? ""}\n${purpose ?? ""}`;
  const paymentText = `${text}\n${recognition?.extractedText ?? ""}`;
  const paidTime = labeledPaidTimeFromText(paymentText)
    || clean(evidence.paidTime)
    || paidTimeFromText(paymentText)
    || paidTimeFromDateTime(analyzedExpense.paidAt);
  const selection = mapBookkeepingCategory({
    category: analyzedExpense.category,
    subcategory: analyzedExpense.subcategory,
    text: combinedText,
    entryType,
    amountCents,
    paidTime,
  });
  const paidAt = paidAtFor(occurredOn, paidTime)
    ?? (clean(analyzedExpense.paidAt) || null);
  const mealKey = selection.category === "餐饮"
    ? Object.entries(MEAL_SUBCATEGORY_BY_KEY).find(([, value]) => value === selection.subcategory)?.[0] ?? null
    : null;
  let tripRegion = tripRegionFromText(combinedText);
  let tripRegionSource = tripRegion ? "text" : null;
  if (!tripRegion && typeof tripRegionResolver === "function") {
    tripRegionSource = "itinerary";
    try {
      tripRegion = normalizedTripRegion(tripRegionResolver({
        occurredOn,
        merchant,
        purpose,
        text: combinedText,
      }));
    } catch {
      tripRegion = null;
    }
  }
  const note = entryType === "expense" && mealKey
    ? buildAutomaticMealNote({ occurredOn, tripRegion, mealKey })
    : null;
  const warnings = warningsFor({
    amountCents,
    occurredOn,
    purpose,
    category: selection.category,
    recognition,
    expenseAnalysis,
    extraWarnings: [
      ...(mealKey && !tripRegion ? ["missing_trip_region"] : []),
      ...(mealKey && Number.isSafeInteger(amountCents) && amountCents > MEAL_AMOUNT_LIMIT_CENTS
        && !MULTI_TRAVEL_MEAL_PATTERN.test(combinedText)
        ? ["large_meal_context_unknown"]
        : []),
    ],
  });
  const source = recognition?.source ?? expenseAnalysis?.source ?? { provider: "rules", model: null };
  return {
    status: "review_required",
    confidence: Number.isFinite(recognition?.confidence)
      ? recognition.confidence
      : Number.isFinite(expenseAnalysis?.confidence) ? expenseAnalysis.confidence : 0,
    category: selection.category,
    subcategory: selection.subcategory,
    // Merchant remains a dedicated field. Meal notes are the only automatic
    // note: month/day + evidence-backed trip region + meal period.
    note,
    noteAutomation: mealKey ? {
      kind: "meal",
      tripRegion: normalizedTripRegion(tripRegion),
      tripRegionSource,
      paidTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(paidTime) ? paidTime : null,
    } : null,
    // Keep the model's original classification seed so an amount/time
    // correction can deterministically re-run the same contextual rules.
    // A later explicit category correction clears this provenance.
    categoryAutomation: entryType === "expense" ? {
      kind: "contextual",
      sourceCategory: clean(analyzedExpense.category) || null,
      sourceSubcategory: clean(analyzedExpense.subcategory) || null,
    } : null,
    expense: {
      occurredOn,
      amountCents,
      reimbursementCents: amountCents,
      purpose,
      merchant,
      paidAt,
      fundingSource: entryType === "expense" ? "personal" : "other",
      paymentMethod: paymentMethod(evidence.paymentMethod ?? analyzedExpense.paymentMethod),
    },
    warnings,
    source,
  };
}
