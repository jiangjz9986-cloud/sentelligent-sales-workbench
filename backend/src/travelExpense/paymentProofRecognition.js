import { boundModelText } from "./modelTextBound.js";

const MODEL_FIELDS = new Set([
  "amountCents",
  "occurredOn",
  "paidTime",
  "merchant",
  "paymentMethod",
  "confidence",
  "warnings",
]);
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

function normalizeModelFields(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  for (const key of Object.keys(value)) {
    if (!MODEL_FIELDS.has(key)) throw stableModelError("MODEL_INVALID_RESPONSE");
  }
  return {
    amountCents: optionalMoneyCents(value.amountCents),
    occurredOn: optionalDate(value.occurredOn),
    paidTime: optionalTime(value.paidTime),
    merchant: optionalText(value.merchant),
    paymentMethod: optionalPaymentMethod(value.paymentMethod),
    confidence: optionalConfidence(value.confidence),
    warnings: warningCodes(value.warnings),
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

function modelMessages(extractedText) {
  return [
    {
      role: "system",
      content: [
        "你是付款凭证字段提取器，只处理服务器本地 OCR 或 PDF 文本提取所得的纯文本。",
        "只输出合法 JSON，不输出解释、Markdown 或猜测内容。",
        "仅允许字段 amountCents、occurredOn、paidTime、merchant、paymentMethod、confidence、warnings。",
        "amountCents 为正整数分；occurredOn 为 YYYY-MM-DD；paidTime 为 HH:mm。",
        "paymentMethod 只能为 wechat、alipay、bank_card、cash、other。",
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
      max_tokens: 500,
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
  if (!options.textExtractor || typeof options.textExtractor.extract !== "function") {
    throw new TypeError("textExtractor.extract is required");
  }
  const typedEvidence = normalizeTypedEvidence(options.typedEvidence);
  const source = {
    provider: String(options.modelProvider ?? "deepseek"),
    model: String(options.modelName ?? "deepseek-v4-flash"),
  };

  let extractedText;
  try {
    const extracted = await options.textExtractor.extract(mediaType, buffer);
    extractedText = typeof extracted === "string" ? extracted.trim() : "";
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
    };
  }

  const evidence = {
    amountCents: analyzed.amountCents,
    occurredOn: analyzed.occurredOn,
    paidTime: analyzed.paidTime,
    merchant: analyzed.merchant,
    paymentMethod: analyzed.paymentMethod,
  };
  const conflicts = EVIDENCE_FIELDS.flatMap((field) => {
    const typedValue = typedEvidence[field];
    const recognizedValue = evidence[field];
    return typedValue !== null && recognizedValue !== null && typedValue !== recognizedValue
      ? [{ field, typedValue, recognizedValue }]
      : [];
  });
  const warnings = [...new Set([
    ...analyzed.warnings,
    ...(conflicts.length > 0 ? ["EVIDENCE_CONFLICT"] : []),
  ])];
  return {
    extractedText,
    evidence,
    typedEvidence,
    conflicts,
    confidence: analyzed.confidence,
    warnings,
    source,
  };
}
