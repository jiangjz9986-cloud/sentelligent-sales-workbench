import { boundModelText } from "./modelTextBound.js";

class InvoiceModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InvoiceModelError";
    this.code = code;
  }
}

function stableError(code) {
  const messages = {
    MODEL_UNAVAILABLE: "Invoice text model is not configured",
    MODEL_PROVIDER_ERROR: "Invoice text model request failed",
    MODEL_INVALID_RESPONSE: "Invoice text model returned an invalid response",
    MODEL_TIMEOUT: "Invoice text model request timed out",
  };
  return new InvoiceModelError(code, messages[code] ?? "Invoice text model request failed");
}

function stripJsonFence(value) {
  const text = String(value ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

async function completionContent(response) {
  let body = response;
  if (body && typeof body.text === "function") {
    const text = await body.text();
    if (body.ok === false) throw stableError("MODEL_PROVIDER_ERROR");
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw stableError("MODEL_INVALID_RESPONSE");
    }
  }
  if (typeof body === "string") return body;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw stableError("MODEL_INVALID_RESPONSE");
  }
  return content;
}

function invokeModelClient(modelClient, request) {
  if (typeof modelClient === "function") return modelClient(request);
  if (modelClient && typeof modelClient.complete === "function") return modelClient.complete(request);
  if (modelClient && typeof modelClient.createChatCompletion === "function") {
    return modelClient.createChatCompletion(request);
  }
  throw stableError("MODEL_UNAVAILABLE");
}

function parseInvoiceFields(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw stableError("MODEL_INVALID_RESPONSE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw stableError("MODEL_INVALID_RESPONSE");
  }
  const fields = parsed.invoice ?? parsed.fields ?? parsed;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw stableError("MODEL_INVALID_RESPONSE");
  }
  return fields;
}

function modelMessages(extractedText) {
  return [
    {
      role: "system",
      content: [
        "你是企业差旅发票字段提取器，只处理已经在服务器本地提取出的纯文本。",
        "只输出合法 JSON，不输出解释、Markdown 或猜测内容。",
        "可返回字段：invoiceCode、invoiceNumber、issuedOn、sellerName、buyerName、amountExTaxCents、taxCents、totalCents、suggestedCategory。",
        "日期格式必须为 YYYY-MM-DD；金额必须为非负整数分。",
        "suggestedCategory 只能为 breakfast、lunch、dinner、lodging、transport、hospitality、other。",
        "文本中没有明确依据的字段必须返回 null。",
      ].join("\n"),
    },
    { role: "user", content: extractedText },
  ];
}

export async function analyzeInvoiceText(value, options = {}) {
  const extractedText = String(value ?? "").trim();
  if (!extractedText) throw new TypeError("extracted invoice text is required");
  const modelText = boundModelText(extractedText).text;
  const modelName = String(options.modelName ?? "deepseek-chat").trim() || "deepseek-chat";
  const timeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0
    ? options.modelTimeoutMs
    : 30_000;
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => invokeModelClient(options.modelClient, {
        model: modelName,
        messages: modelMessages(modelText),
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 900,
        stream: false,
        signal: controller.signal,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(stableError("MODEL_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
    return parseInvoiceFields(await completionContent(response));
  } catch (error) {
    if (error instanceof InvoiceModelError) throw error;
    throw stableError("MODEL_PROVIDER_ERROR");
  } finally {
    clearTimeout(timer);
  }
}
