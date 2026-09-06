import { boundModelText } from "./modelTextBound.js";

const MODEL_FIELDS = new Set([
  "amountCents",
  "occurredOn",
  "occurredOnYearExplicit",
  "paidTime",
  "merchant",
  "paymentMethod",
  "transactions",
  "documentKind",
  "confidence",
  "warnings",
]);
const TRANSACTION_FIELDS = new Set([
  "amountCents",
  "occurredOn",
  "occurredOnYearExplicit",
  "paidTime",
  "merchant",
  "paymentMethod",
]);
const MAX_TRANSACTIONS = 20;
const MAX_REFERENCE_DATE_DISTANCE_DAYS = 366;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const EVIDENCE_FIELDS = ["amountCents", "occurredOn", "paidTime"];
const PAYMENT_METHODS = new Set(["wechat", "alipay", "bank_card", "cash", "other"]);

class PaymentProofModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaymentProofModelError";
    this.code = code;
  }
}

function stableModelError(code) {
  const messages = {
    MODEL_UNAVAILABLE: "Payment proof model is not configured",
    MODEL_PROVIDER_ERROR: "Payment proof model request failed",
    MODEL_INVALID_RESPONSE: "Payment proof model returned an invalid response",
    MODEL_TIMEOUT: "Payment proof model request timed out",
  };
  return new PaymentProofModelError(code, messages[code] ?? messages.MODEL_PROVIDER_ERROR);
}

function stableWarning(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code
    : fallback;
}

function stripJsonFence(value) {
  const text = String(value ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  return match ? match[1].trim() : text;
}

async function completionContent(response) {
  let body = response;
  if (body && typeof body.text === "function") {
    const text = await body.text();
    if (body.ok === false) throw stableModelError("MODEL_PROVIDER_ERROR");
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw stableModelError("MODEL_INVALID_RESPONSE");
    }
  }
  if (typeof body === "string") return body;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return content;
}

function invokeModelClient(modelClient, request) {
  if (typeof modelClient === "function") return modelClient(request);
  if (modelClient && typeof modelClient.complete === "function") return modelClient.complete(request);
  if (modelClient && typeof modelClient.createChatCompletion === "function") {
    return modelClient.createChatCompletion(request);
  }
  throw stableModelError("MODEL_UNAVAILABLE");
}

function parseJsonObject(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  for (const key of Object.keys(parsed)) {
    if (!MODEL_FIELDS.has(key)) throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return parsed;
}

function optionalMoneyCents(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,2})$/u.test(value.trim())) {
    const [whole, fraction] = value.trim().split(".");
    const cents = (Number(whole) * 100) + Number(fraction.padEnd(2, "0"));
    if (Number.isSafeInteger(cents) && cents > 0) return cents;
  }
  throw stableModelError("MODEL_INVALID_RESPONSE");
}

function optionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return value;
}

function validMonthDay(value) {
  const match = /^(\d{2})-(\d{2})$/u.exec(String(value ?? ""));
  if (!match) return null;
  const canonical = `2000-${match[1]}-${match[2]}`;
  const parsed = new Date(`${canonical}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === canonical
    ? `${match[1]}-${match[2]}`
    : null;
}

function closestDateNotAfter(monthDay, referenceDate) {
  const referenceYear = Number(referenceDate.slice(0, 4));
  for (let year = referenceYear; year >= referenceYear - 8; year -= 1) {
    const candidate = `${String(year).padStart(4, "0")}-${monthDay}`;
    try {
      if (optionalDate(candidate) && candidate <= referenceDate) return candidate;
    } catch {
      // February 29 is invalid in most years; keep looking for the nearest leap year.
    }
  }
  throw stableModelError("MODEL_INVALID_RESPONSE");
}

function outsideReferenceWindow(occurredOn, referenceDate) {
  const occurredTime = new Date(`${occurredOn}T00:00:00.000Z`).getTime();
  const referenceTime = new Date(`${referenceDate}T00:00:00.000Z`).getTime();
  return Math.abs(occurredTime - referenceTime) / MILLISECONDS_PER_DAY
    > MAX_REFERENCE_DATE_DISTANCE_DAYS;
}

function normalizeDateEvidence(value, {
  referenceDate = null,
  requireYearEvidence = false,
} = {}) {
  const hasYearEvidence = Object.hasOwn(value, "occurredOnYearExplicit");
  if (requireYearEvidence && !hasYearEvidence) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  if (hasYearEvidence && typeof value.occurredOnYearExplicit !== "boolean") {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }

  const rawDate = value.occurredOn;
  const hasDate = rawDate !== undefined && rawDate !== null && rawDate !== "";
  if (!hasDate) {
    if (hasYearEvidence && value.occurredOnYearExplicit !== false) {
      throw stableModelError("MODEL_INVALID_RESPONSE");
    }
    return {
      occurredOn: null,
      ...(hasYearEvidence ? { occurredOnYearExplicit: false } : {}),
      warnings: [],
    };
  }

  if (!hasYearEvidence) {
    return { occurredOn: optionalDate(rawDate), warnings: [] };
  }

  if (value.occurredOnYearExplicit) {
    const occurredOn = optionalDate(rawDate);
    return {
      occurredOn,
      occurredOnYearExplicit: true,
      warnings: referenceDate && outsideReferenceWindow(occurredOn, referenceDate)
        ? ["OCCURRED_ON_OUTSIDE_REFERENCE_WINDOW"]
        : [],
    };
  }

  if (typeof rawDate !== "string") throw stableModelError("MODEL_INVALID_RESPONSE");
  const monthDay = validMonthDay(/^(?:\d{4}-)?(\d{2}-\d{2})$/u.exec(rawDate)?.[1]);
  if (!monthDay) throw stableModelError("MODEL_INVALID_RESPONSE");
  return {
    occurredOn: referenceDate ? closestDateNotAfter(monthDay, referenceDate) : null,
    occurredOnYearExplicit: false,
    warnings: referenceDate ? [] : ["OCCURRED_ON_REFERENCE_REQUIRED"],
  };
}

function optionalTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return value;
}

function optionalText(value, max = 300) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw stableModelError("MODEL_INVALID_RESPONSE");
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw stableModelError("MODEL_INVALID_RESPONSE");
  return normalized;
}

function optionalPaymentMethod(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PAYMENT_METHODS.has(value)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return value;
}

function optionalDocumentKind(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "payment_proof" && value !== "invoice") {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return value;
}

function optionalConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return value;
}

function warningCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw stableModelError("MODEL_INVALID_RESPONSE");
  const normalized = value.map((warning) => {
    if (typeof warning !== "string" || !/^[A-Z0-9_]{1,80}$/u.test(warning)) {
      throw stableModelError("MODEL_INVALID_RESPONSE");
    }
    return warning;
  });
  return [...new Set(normalized)];
}

function normalizeTransactions(value, options = {}) {
  if (value === undefined || value === null) return { transactions: [], warnings: [] };
  if (!Array.isArray(value) || value.length > MAX_TRANSACTIONS) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  const warnings = [];
  const transactions = value.map((transaction) => {
    if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction)) {
      throw stableModelError("MODEL_INVALID_RESPONSE");
    }
    for (const key of Object.keys(transaction)) {
      if (!TRANSACTION_FIELDS.has(key)) throw stableModelError("MODEL_INVALID_RESPONSE");
    }
    const amountCents = optionalMoneyCents(transaction.amountCents);
    if (amountCents === null) throw stableModelError("MODEL_INVALID_RESPONSE");
    const dateEvidence = normalizeDateEvidence(transaction, options);
    warnings.push(...dateEvidence.warnings);
    return {
      amountCents,
      occurredOn: dateEvidence.occurredOn,
      ...(Object.hasOwn(dateEvidence, "occurredOnYearExplicit")
        ? { occurredOnYearExplicit: dateEvidence.occurredOnYearExplicit }
        : {}),
      paidTime: optionalTime(transaction.paidTime),
      merchant: optionalText(transaction.merchant),
      paymentMethod: optionalPaymentMethod(transaction.paymentMethod),
    };
  });
  return { transactions, warnings };
}

function normalizeModelFields(value, options = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  for (const key of Object.keys(value)) {
    if (!MODEL_FIELDS.has(key)) throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  const { transactions, warnings: transactionWarnings } = normalizeTransactions(value.transactions, options);
  const dateEvidence = normalizeDateEvidence(value, options);
  const firstTransaction = transactions[0] ?? null;
  const occurredOn = dateEvidence.occurredOn ?? firstTransaction?.occurredOn ?? null;
  const hasYearEvidence = Object.hasOwn(dateEvidence, "occurredOnYearExplicit")
    || Object.hasOwn(firstTransaction ?? {}, "occurredOnYearExplicit");
  const occurredOnYearExplicit = dateEvidence.occurredOn !== null
    ? dateEvidence.occurredOnYearExplicit
    : firstTransaction?.occurredOnYearExplicit ?? dateEvidence.occurredOnYearExplicit ?? false;
  return {
    amountCents: optionalMoneyCents(value.amountCents) ?? firstTransaction?.amountCents ?? null,
    occurredOn,
    ...(hasYearEvidence ? { occurredOnYearExplicit } : {}),
    paidTime: optionalTime(value.paidTime) ?? firstTransaction?.paidTime ?? null,
    merchant: optionalText(value.merchant) ?? firstTransaction?.merchant ?? null,
    paymentMethod: optionalPaymentMethod(value.paymentMethod) ?? firstTransaction?.paymentMethod ?? null,
    ...(transactions.length > 0 ? { transactions } : {}),
    ...(Object.hasOwn(value, "documentKind")
      ? { documentKind: optionalDocumentKind(value.documentKind) }
      : {}),
    confidence: optionalConfidence(value.confidence),
    warnings: [...new Set([
      ...warningCodes(value.warnings),
      ...dateEvidence.warnings,
      ...transactionWarnings,
    ])],
  };
}

function normalizeTypedEvidence(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("typedEvidence must be an object");
  }
  return {
    amountCents: optionalMoneyCents(value.amountCents),
    occurredOn: optionalDate(value.occurredOn),
    paidTime: optionalTime(value.paidTime),
  };
}

function completedRecognition(analyzed, typedEvidence, source, extra = {}) {
  const evidence = {
    amountCents: analyzed.amountCents,
    occurredOn: analyzed.occurredOn,
    paidTime: analyzed.paidTime,
    merchant: analyzed.merchant,
    paymentMethod: analyzed.paymentMethod,
    ...(Object.hasOwn(analyzed, "occurredOnYearExplicit")
      ? { occurredOnYearExplicit: analyzed.occurredOnYearExplicit }
      : {}),
  };
  const conflicts = EVIDENCE_FIELDS.flatMap((field) => {
    const typedValue = typedEvidence[field];
    const recognizedValue = evidence[field];
    return typedValue !== null && recognizedValue !== null && typedValue !== recognizedValue
      ? [{ field, typedValue, recognizedValue }]
      : [];
  });
  return {
    documentKind: analyzed.documentKind ?? null,
    evidence,
    typedEvidence,
    conflicts,
    confidence: analyzed.confidence,
    warnings: [...new Set([
      ...analyzed.warnings,
      ...(conflicts.length > 0 ? ["EVIDENCE_CONFLICT"] : []),
    ])],
    source,
    ...(Array.isArray(analyzed.transactions) && analyzed.transactions.length > 0
      ? { transactions: analyzed.transactions }
      : {}),
    ...extra,
  };
}

function normalizeLayout(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pageWidth = Number(value.pageWidth);
  const pageHeight = Number(value.pageHeight);
  if (!Number.isFinite(pageWidth) || pageWidth < 1 || !Number.isFinite(pageHeight) || pageHeight < 1) return null;
  if (!Array.isArray(value.tokens)) return null;
  const tokens = value.tokens.slice(0, 4000).flatMap((token) => {
    if (!token || typeof token !== "object" || Array.isArray(token)) return [];
    const normalized = {
      page: Number(token.page),
      block: Number(token.block),
      paragraph: Number(token.paragraph),
      line: Number(token.line),
      word: Number(token.word),
      left: Number(token.left),
      top: Number(token.top),
      width: Number(token.width),
      height: Number(token.height),
      confidence: Number(token.confidence),
      text: typeof token.text === "string" ? token.text.trim().slice(0, 500) : "",
    };
    if (!normalized.text
      || [normalized.page, normalized.block, normalized.paragraph, normalized.line, normalized.word,
        normalized.left, normalized.top, normalized.width, normalized.height, normalized.confidence]
        .some((item) => !Number.isFinite(item))
      || normalized.left < 0 || normalized.top < 0 || normalized.width < 1 || normalized.height < 1) return [];
    return [normalized];
  });
  return tokens.length ? { pageWidth, pageHeight, tokens } : null;
}

function modelMessages(extractedText) {
  return [
    {
      role: "system",
      content: [
        "你是付款凭证字段提取器，只处理服务器本地 OCR 或 PDF 文本提取所得的纯文本。",
        "只输出合法 JSON，不输出解释、Markdown 或猜测内容。",
        "顶层仅允许字段 amountCents、occurredOn、paidTime、merchant、paymentMethod、transactions、confidence、warnings。",
        "amountCents 为正整数分；occurredOn 为 YYYY-MM-DD；paidTime 为 HH:mm。",
        "paymentMethod 只能为 wechat、alipay、bank_card、cash、other。",
        "transactions 仅用于多笔独立付款，按文本出现顺序最多返回 20 笔；每项只能包含 amountCents、occurredOn、paidTime、merchant、paymentMethod，且 amountCents 必须为正整数分。",
        "原价、优惠、折扣、合计与实付属于同一付款详情时不能拆成多笔，只取最终实付金额。",
        "文本没有明确依据的字段必须返回 null。",
      ].join("\n"),
    },
    { role: "user", content: extractedText },
  ];
}

async function withTimeout(task, timeoutMs) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(stableModelError("MODEL_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzePaymentProofText(value, options = {}) {
  const extractedText = String(value ?? "").trim();
  if (!extractedText) throw new TypeError("extracted payment proof text is required");
  const modelText = boundModelText(extractedText).text;
  const modelName = String(options.modelName ?? "deepseek-v4-flash").trim() || "deepseek-v4-flash";
  const timeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0
    ? options.modelTimeoutMs
    : 30_000;
  try {
    const response = await withTimeout((signal) => invokeModelClient(options.modelClient, {
      model: modelName,
      messages: modelMessages(modelText),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1_600,
      stream: false,
      signal,
    }), timeoutMs);
    const parsed = parseJsonObject(await completionContent(response));
    return normalizeModelFields(parsed);
  } catch (error) {
    if (error instanceof PaymentProofModelError) throw error;
    throw stableModelError("MODEL_PROVIDER_ERROR");
  }
}

export async function recognizePaymentProofDocument(file, options = {}) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new TypeError("payment proof file is required");
  const mediaType = String(file.mediaType ?? "").trim().toLowerCase();
  const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer ?? []);
  if (!buffer.length) throw new TypeError("payment proof buffer is required");
  const typedEvidence = normalizeTypedEvidence(options.typedEvidence);
  const source = {
    provider: String(options.modelProvider ?? "deepseek"),
    model: String(options.modelName ?? "deepseek-v4-flash"),
  };

  if (typeof options.analyzeDocument === "function") {
    const timeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0
      ? options.modelTimeoutMs
      : 30_000;
    try {
      const referenceDate = optionalDate(options.referenceDate);
      const analyzed = normalizeModelFields(await withTimeout(
        () => options.analyzeDocument({
          fileName: String(file.fileName ?? "payment-proof"),
          mediaType,
          buffer,
        }, { referenceDate: options.referenceDate }),
        timeoutMs,
      ), {
        referenceDate,
        requireYearEvidence: true,
      });
      return completedRecognition(analyzed, typedEvidence, source, { extractedText: null });
    } catch (error) {
      return {
        extractedText: null,
        evidence: null,
        typedEvidence,
        conflicts: [],
        confidence: null,
        warnings: [stableWarning(error, "VISION_MODEL_PROVIDER_ERROR")],
        documentKind: null,
        source,
      };
    }
  }

  if (!options.textExtractor || typeof options.textExtractor.extract !== "function") {
    throw new TypeError("textExtractor.extract is required");
  }

  let extractedText;
  let layout = null;
  try {
    const extracted = typeof options.textExtractor.extractLayout === "function"
      ? await options.textExtractor.extractLayout(mediaType, buffer)
      : await options.textExtractor.extract(mediaType, buffer);
    extractedText = typeof extracted === "string"
      ? extracted.trim()
      : typeof extracted?.text === "string" ? extracted.text.trim() : "";
    layout = normalizeLayout(extracted);
    if (!extractedText) throw Object.assign(new Error("No text was extracted"), { code: "TEXT_EMPTY" });
  } catch (error) {
    return {
      extractedText: null,
      evidence: null,
      typedEvidence,
      conflicts: [],
      confidence: null,
      warnings: [stableWarning(error, "TEXT_EXTRACTION_FAILED")],
      source,
      ...(layout ? { layout } : {}),
    };
  }

  const timeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0
    ? options.modelTimeoutMs
    : 30_000;
  let analyzed;
  try {
    analyzed = await withTimeout(
      () => options.analyzeText
        ? options.analyzeText(extractedText)
        : analyzePaymentProofText(extractedText, options),
      timeoutMs,
    );
    analyzed = normalizeModelFields(analyzed);
  } catch (error) {
    return {
      extractedText,
      evidence: null,
      typedEvidence,
      conflicts: [],
      confidence: null,
      warnings: [stableWarning(error, "MODEL_PROVIDER_ERROR")],
      source,
      ...(layout ? { layout } : {}),
    };
  }

  return completedRecognition(analyzed, typedEvidence, source, {
    extractedText,
    ...(layout ? { layout } : {}),
  });
}
