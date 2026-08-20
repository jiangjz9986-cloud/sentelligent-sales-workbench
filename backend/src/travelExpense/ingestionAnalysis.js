import { readBoundedModelResponseText } from "./modelTextBound.js";

const CATEGORY_RULES = [
  ["breakfast", /早餐|早饭|早点/],
  ["lunch", /午餐|午饭|中餐/],
  ["dinner", /晚餐|晚饭|夜宵/],
  ["lodging", /住宿|酒店|宾馆|房费/],
  ["transport", /交通|打车|滴滴|出租车|网约车|高铁|火车|飞机|机票|公交|地铁|停车|过路费|加油/],
  ["hospitality", /业务招待|客户招待|宴请|招待/],
];

const MERCHANT_PATTERN = /微信支付|支付宝|云闪付|现金|银行卡|信用卡/;
const CATEGORY_ALIASES = new Map([
  ["breakfast", "breakfast"],
  ["早餐", "breakfast"],
  ["早饭", "breakfast"],
  ["lunch", "lunch"],
  ["午餐", "lunch"],
  ["午饭", "lunch"],
  ["中餐", "lunch"],
  ["dinner", "dinner"],
  ["晚餐", "dinner"],
  ["晚饭", "dinner"],
  ["lodging", "lodging"],
  ["住宿", "lodging"],
  ["酒店", "lodging"],
  ["transport", "transport"],
  ["交通", "transport"],
  ["打车", "transport"],
  ["hospitality", "hospitality"],
  ["招待", "hospitality"],
  ["业务招待", "hospitality"],
  ["other", "other"],
  ["其他", "other"],
]);
const FUNDING_SOURCES = new Set(["personal", "company", "advance"]);
const PAYMENT_METHODS = new Set(["wechat", "alipay", "card", "cash", "other"]);

class InvalidModelJsonError extends Error {}
class InvalidModelResponseError extends Error {}
class ModelTimeoutError extends Error {}

function formatDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

function currentDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function parseOccurredOn(text, clock) {
  let match = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (match) {
    const value = formatDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return { value, token: match[0], invalid: !value };
  }

  match = /(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(text);
  if (match) {
    const value = formatDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return { value, token: match[0], invalid: !value };
  }

  const now = currentDate(clock);
  match = /(\d{1,2})月(\d{1,2})日?/.exec(text);
  if (match) {
    const value = formatDate(now.getUTCFullYear(), Number(match[1]), Number(match[2]));
    return {
      value,
      token: match[0],
      invalid: !value,
    };
  }

  match = /今天|昨日|昨天|前天/.exec(text);
  if (!match) return { value: null, token: null, invalid: false };
  const offsetDays = match[0] === "前天" ? -2 : match[0] === "今天" ? 0 : -1;
  const relative = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  return { value: relative.toISOString().slice(0, 10), token: match[0], invalid: false };
}

function parseAmountCents(text) {
  const match = /([负+-]?\s*\d[\d,]*(?:\.\d+)?)\s*元/.exec(text);
  if (!match) return { value: null, token: null, invalid: false };
  let amount = match[1].replace(/[\s,]/g, "");
  const negative = amount.startsWith("-") || amount.startsWith("负");
  amount = amount.replace(/^[负+-]/, "");
  const [whole, fraction = ""] = amount.split(".");
  if (negative || fraction.length > 2) return { value: null, token: match[0], invalid: true };
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(value) || value <= 0) return { value: null, token: match[0], invalid: true };
  return { value, token: match[0], invalid: false };
}

function removeToken(text, token) {
  return token ? text.replace(token, " ") : text;
}

function analyzeWithRules(rawText, clock) {
  const text = String(rawText ?? "").trim();
  const source = { provider: "rules", model: null };
  if (!text) {
    return {
      status: "review_required",
      confidence: 0,
      expense: null,
      warnings: ["missing_text"],
      source,
    };
  }

  const date = parseOccurredOn(text, clock);
  const occurredOn = date.value;
  const categoryMatch = CATEGORY_RULES
    .map(([category, pattern]) => [category, pattern.exec(text)?.[0] ?? null])
    .find(([, token]) => token);
  const category = categoryMatch?.[0] ?? null;
  const merchant = text.match(MERCHANT_PATTERN)?.[0] ?? null;
  const amount = parseAmountCents(text);
  const amountCents = amount.value;
  const purpose = removeToken(
    removeToken(
      removeToken(
        removeToken(text, date.token),
        categoryMatch?.[1],
      ),
      merchant,
    ),
    amount.token,
  )
    .replace(/\s+/g, " ")
    .trim();

  const warnings = [];
  if (!occurredOn) warnings.push(date.invalid ? "invalid_date" : "missing_date");
  if (!amountCents) warnings.push(amount.invalid ? "invalid_amount" : "missing_amount");
  if (!category) warnings.push("missing_category");
  if (!purpose) warnings.push("missing_purpose");
  const completeness = [occurredOn, category, purpose, amountCents].filter(Boolean).length / 4;

  return {
    status: warnings.length === 0 ? "ready" : "review_required",
    confidence: completeness,
    expense: {
      occurredOn,
      category,
      purpose,
      merchant,
      amountCents,
      reimbursementCents: amountCents,
    },
    warnings,
    source,
  };
}

function stripJsonFence(content) {
  const text = String(content ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

function optionalText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new InvalidModelResponseError();
  return value.trim();
}

function requiredText(value) {
  const normalized = optionalText(value);
  if (!normalized) throw new InvalidModelResponseError();
  return normalized;
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new InvalidModelResponseError();
  }
  const normalized = number > 1 ? number / 100 : number;
  if (normalized < 0 || normalized > 1) throw new InvalidModelResponseError();
  return normalized;
}

function normalizeDateOnly(value) {
  const text = requiredText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new InvalidModelResponseError();
  const normalized = formatDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!normalized) throw new InvalidModelResponseError();
  return normalized;
}

function normalizeCategory(value) {
  const category = CATEGORY_ALIASES.get(requiredText(value).toLowerCase());
  if (!category) throw new InvalidModelResponseError();
  return category;
}

function integerCents(value, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidModelResponseError();
  return value;
}

function normalizeDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = requiredText(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new InvalidModelResponseError();
  }
  if (Number.isNaN(Date.parse(text))) throw new InvalidModelResponseError();
  return text;
}

function optionalEnum(value, allowed) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value).toLowerCase();
  if (!allowed.has(normalized)) throw new InvalidModelResponseError();
  return normalized;
}

async function responseContent(response) {
  let body = response;
  if (body && typeof body.text === "function") {
    const text = await readBoundedModelResponseText(body);
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new InvalidModelJsonError();
    }
    if (response.ok === false) throw new Error("model_provider_error");
  }
  if (typeof body === "string") return body;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new InvalidModelResponseError();
  return content;
}

export async function normalizeExpenseModelResponse(response) {
  const content = await responseContent(response);
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw new InvalidModelJsonError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidModelResponseError();
  }

  const value = parsed.expense ?? parsed;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidModelResponseError();
  }
  const amountCents = integerCents(value.amountCents ?? value.amount_cents);
  const reimbursementCents = integerCents(
    value.reimbursementCents ?? value.reimbursement_cents ?? amountCents,
  );
  if (reimbursementCents > amountCents) throw new InvalidModelResponseError();

  const expense = {
    occurredOn: normalizeDateOnly(value.occurredOn ?? value.occurred_on),
    category: normalizeCategory(value.category),
    purpose: requiredText(value.purpose ?? value.description),
    merchant: optionalText(value.merchant),
    amountCents,
    reimbursementCents,
  };
  const paidAt = normalizeDateTime(value.paidAt ?? value.paid_at);
  const fundingSource = optionalEnum(value.fundingSource ?? value.funding_source, FUNDING_SOURCES);
  const paymentMethod = optionalEnum(value.paymentMethod ?? value.payment_method, PAYMENT_METHODS);
  if (paidAt) expense.paidAt = paidAt;
  if (fundingSource) expense.fundingSource = fundingSource;
  if (paymentMethod) expense.paymentMethod = paymentMethod;

  return {
    confidence: normalizeConfidence(parsed.confidence ?? value.confidence),
    expense,
  };
}

function buildModelMessages(text, ruleResult) {
  return [
    {
      role: "system",
      content: [
        "你是个人差旅报销账单分析器。",
        "只输出合法 JSON，不要输出解释文字。",
        "JSON 必须包含 confidence 和 expense。",
        "expense 必须包含 occurredOn、category、purpose、merchant、amountCents、reimbursementCents。",
        "金额必须使用正整数分；category 只能为 breakfast、lunch、dinner、lodging、transport、hospitality、other。",
        "不得猜测文本中没有的日期或金额。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({ text, ruleExpense: ruleResult.expense }),
    },
  ];
}

function invokeModelClient(modelClient, request) {
  if (typeof modelClient === "function") return modelClient(request);
  if (modelClient && typeof modelClient.complete === "function") return modelClient.complete(request);
  if (modelClient && typeof modelClient.createChatCompletion === "function") {
    return modelClient.createChatCompletion(request);
  }
  throw new TypeError("modelClient must be a function or completion client");
}

async function callModel(modelClient, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await invokeModelClient(modelClient, { ...request, signal: controller.signal });
        return normalizeExpenseModelResponse(response);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function modelWarning(error) {
  if (error instanceof ModelTimeoutError) return "model_timeout";
  if (error instanceof InvalidModelJsonError) return "invalid_model_json";
  if (error instanceof InvalidModelResponseError) return "invalid_model_response";
  return "model_error";
}

function uniqueWarnings(values) {
  return [...new Set(values)];
}

function preserveRejectedRuleFields(expense, warnings) {
  const result = { ...expense };
  if (warnings.includes("missing_date") || warnings.includes("invalid_date")) {
    result.occurredOn = null;
  }
  if (warnings.includes("missing_amount") || warnings.includes("invalid_amount")) {
    result.amountCents = null;
    result.reimbursementCents = null;
  }
  return result;
}

export async function analyzeExpenseText(rawText, options = {}) {
  const clock = options.clock ?? (() => new Date());
  const ruleResult = analyzeWithRules(rawText, clock);
  if (!options.modelClient || ruleResult.expense === null) return ruleResult;

  const provider = String(options.modelProvider ?? "deepseek").trim() || "deepseek";
  const model = String(options.modelName ?? "deepseek-chat").trim() || "deepseek-chat";
  const timeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0
    ? options.modelTimeoutMs
    : 30_000;
  let minConfidence;
  try {
    minConfidence = normalizeConfidence(options.minModelConfidence ?? 0.8);
  } catch {
    minConfidence = 0.8;
  }
  const source = { provider, model };

  try {
    const normalized = await callModel(options.modelClient, {
      model,
      messages: buildModelMessages(String(rawText ?? "").trim(), ruleResult),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 900,
      stream: false,
    }, timeoutMs);
    const warnings = [...ruleResult.warnings];
    if (normalized.confidence < minConfidence) warnings.push("low_model_confidence");
    return {
      status: warnings.length === 0 ? "ready" : "review_required",
      confidence: normalized.confidence,
      expense: preserveRejectedRuleFields(normalized.expense, warnings),
      warnings: uniqueWarnings(warnings),
      source,
    };
  } catch (error) {
    return {
      ...ruleResult,
      status: "review_required",
      warnings: uniqueWarnings([...ruleResult.warnings, modelWarning(error)]),
      source,
    };
  }
}
