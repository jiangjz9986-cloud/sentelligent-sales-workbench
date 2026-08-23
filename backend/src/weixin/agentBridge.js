import { createHash } from "node:crypto";

import { readBoundedResponseText } from "../http/request.js";
import {
  parsePaymentProofCommandArgs,
  readWeixinDocument,
  WeixinDocumentError,
  weixinDocumentSourceRef,
} from "../travelExpense/documentInboxMedia.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

const helpText = [
  "森特智行微信助手",
  "",
  "直接连续发送拜访、电话或会议内容，我会先暂存。",
  "发送“记录”生成待确认草稿；确认无误后发送“录入”写入系统。",
  "需要查询客户时，发送“查询客户名称”，例如：查询日照中医医院。",
  "",
  "可用命令：",
  "/客户 关键词 - 查询客户",
  "/周报 - 生成本周周报草稿",
  "/付款凭证 EXP-... 金额/时间 - 上传付款凭证并查看候选付款",
  "/发票 - 上传图片或 PDF 到发票仓库",
  "取消 - 清空当前暂存内容",
  "/帮助 - 查看说明",
].join("\n");

function normalizeBackendUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function compact(value, limit = 700) {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseJsonResponse(text) {
  if (!text) return null;
  return JSON.parse(text);
}

function documentIdempotencyKey(sourceRef) {
  return `weixin:${createHash("sha256").update(String(sourceRef), "utf8").digest("hex")}`;
}

function formatDateOnly(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function weekRange(now) {
  const date = new Date(now);
  const dayIndex = (date.getDay() + 6) % 7;
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - dayIndex);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    periodStart: formatDateOnly(start),
    periodEnd: formatDateOnly(end),
  };
}

function sourceChannelFromRequest(request) {
  return request?.media?.type === "audio" ? "wechat_voice" : "wechat_text";
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function sessionKeyFromRequest(request) {
  return (
    cleanText(request?.conversationId) ||
    cleanText(request?.senderId) ||
    cleanText(request?.from) ||
    cleanText(request?.chatId) ||
    "default"
  );
}

function parseNaturalCustomerQuery(text) {
  const value = cleanText(text);
  const match = value.match(/^查询\s*(.+)$/);
  return cleanText(match?.[1]);
}

function isRecordCommand(text) {
  return cleanText(text) === "记录";
}

function isEnterCommand(text) {
  return cleanText(text) === "录入";
}

function isClearCommand(text) {
  return ["取消", "清空", "重置", "不要了"].includes(cleanText(text));
}

function createDraftSession() {
  return {
    parts: [],
    phase: "collecting",
    preview: null,
  };
}

function createMemorySessionStore() {
  const sessions = new Map();
  return {
    get: (key) => sessions.get(key),
    set: (key, value) => sessions.set(key, value),
    delete: (key) => sessions.delete(key),
  };
}

function appendDraftPart(session, request, receivedAt) {
  const text = cleanText(request?.text);
  if (!text) return;
  session.parts.push({
    text,
    sourceChannel: sourceChannelFromRequest(request),
    receivedAt: receivedAt.toISOString(),
  });
}

function draftContent(session) {
  return session.parts.map((part) => part.text).join("\n").trim();
}

function sourceChannelFromParts(parts) {
  const hasVoice = parts.some((part) => part.sourceChannel === "wechat_voice");
  const hasText = parts.some((part) => part.sourceChannel === "wechat_text");
  if (hasVoice && hasText) return "wechat_mixed";
  if (hasVoice) return "wechat_voice";
  return "wechat_text";
}

async function buildDraftPreview(session, client) {
  const content = draftContent(session);
  const analysis = await client.previewQuickRecord({ rawContent: content });
  session.preview = analysis;
  session.phase = "review";
  return analysis;
}

function formatDraftPreview(session, label = "待确认记录") {
  const analysis = session.preview;
  const customer = analysis?.customer?.value || "待匹配客户";
  const opportunity = analysis?.opportunity?.value || "待确认商机";
  const request = analysis?.summary?.request?.text || "待补充客户诉求";
  const risk = analysis?.summary?.risk?.text || "待补充风险信息";
  const action = analysis?.summary?.action?.text || "待补充下一步动作";

  return [
    `${label}：`,
    `客户：${customer}`,
    `商机：${opportunity}`,
    `诉求：${compact(request, 120)}`,
    `风险：${compact(risk, 120)}`,
    `建议：${compact(action, 120)}`,
    "",
    "需要调整就继续发送补充内容；确认后发送“录入”。",
  ].join("\n");
}

class SalesWorkbenchClient {
  constructor({ backendUrl, apiToken, fetchImpl = fetch }) {
    this.backendUrl = normalizeBackendUrl(backendUrl);
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    if (!this.backendUrl) throw new Error("WEIXIN_AGENT_BACKEND_URL is required");
    if (!this.apiToken) throw new Error("WEIXIN_AGENT_API_TOKEN is required");

    const response = await this.fetchImpl(`${this.backendUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await readBoundedResponseText(response, {
      maxBytes: MAX_RESPONSE_BYTES,
      errorMessage: "Backend response body is too large",
    });
    const body = parseJsonResponse(text);
    if (!response.ok) {
      const message = body?.message || body?.error || `backend returned ${response.status}`;
      throw new Error(message);
    }
    return body;
  }

  async createQuickRecord(payload) {
    const body = await this.request("/api/quick-records", { method: "POST", body: payload });
    return body.item;
  }

  async analyzeQuickRecord(id) {
    const body = await this.request(`/api/quick-records/${encodeURIComponent(id)}/analyze`, { method: "POST" });
    return body.item;
  }

  async previewQuickRecord(payload) {
    const body = await this.request("/api/quick-records/preview", { method: "POST", body: payload });
    return body.item;
  }

  async listCustomers() {
    const body = await this.request("/api/customers");
    return body.items ?? [];
  }

  async createWeeklyDraft(payload) {
    const body = await this.request("/api/reports/weekly/draft", { method: "POST", body: payload });
    return body.item;
  }

  async uploadPaymentProof(payload) {
    const body = await this.request("/api/travel-expense-document-inbox", {
      method: "POST",
      headers: { "Idempotency-Key": documentIdempotencyKey(payload.sourceRef) },
      body: payload,
    });
    return body.item;
  }

  async uploadInvoice(payload) {
    const body = await this.request("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": documentIdempotencyKey(payload.sourceRef) },
      body: payload,
    });
    return body.item;
  }
}

function formatQuickRecordReply(record, insight) {
  const customer = insight?.customer?.value || "待匹配客户";
  const opportunity = insight?.opportunity?.value || "待确认商机";
  const request = insight?.summary?.request?.text || "已生成结构化识别建议";
  const action = insight?.summary?.action?.text || "请在系统里人工确认后再写入业务档案";
  return [
    "已录入系统，并完成分析。",
    `记录ID：${record.id}`,
    `客户：${customer}`,
    `商机：${opportunity}`,
    `诉求：${compact(request, 140)}`,
    `建议：${compact(action, 140)}`,
    "",
    "客户、商机和周报仍需在系统内人工确认后同步。",
  ].join("\n");
}

function formatCustomerReply(items, keyword) {
  const query = cleanText(keyword);
  const matched = items
    .filter((item) => {
      const text = [item.name, item.region, item.owner, item.level, item.type].join(" ");
      return !query || text.includes(query);
    })
    .slice(0, 5);

  if (matched.length === 0) return `未找到客户：${query || "空关键词"}`;
  return [
    `找到 ${matched.length} 个客户：`,
    ...matched.map((item) => `- ${item.name} / ${item.region || "-"} / ${item.owner || "-"} / ${item.level || "-"}`),
  ].join("\n");
}

function formatWeeklyReply(report) {
  return [
    "周报草稿已生成。",
    `报告ID：${report.id}`,
    `周期：${report.periodStart} 至 ${report.periodEnd}`,
    "",
    compact(report.content, 900),
  ].join("\n");
}

function formatCandidate(candidate) {
  const paidAt = cleanText(candidate?.paidAt ?? candidate?.occurredAt) || "时间待确认";
  const amountCents = Number(candidate?.amountCents);
  const amount = Number.isSafeInteger(amountCents) && amountCents >= 0
    ? `¥${(amountCents / 100).toFixed(2)}`
    : "金额待确认";
  const paymentId = cleanText(candidate?.paymentId ?? candidate?.id);
  return `- ${paidAt} / ${amount}${paymentId ? ` / ${paymentId}` : ""}`;
}

function formatPaymentRecognition(item) {
  const recognition = item?.recognition && typeof item.recognition === "object"
    ? item.recognition
    : null;
  const evidence = recognition?.evidence && typeof recognition.evidence === "object"
    ? recognition.evidence
    : null;
  if (evidence) {
    const amount = Number.isSafeInteger(evidence.amountCents) && evidence.amountCents > 0
      ? `¥${(evidence.amountCents / 100).toFixed(2)}`
      : "金额待确认";
    const date = cleanText(evidence.occurredOn) || "日期待确认";
    const time = cleanText(evidence.paidTime) || "时间待确认";
    return `已识别：${amount} / ${date} / ${time}。`;
  }
  if ((Array.isArray(recognition?.warnings) && recognition.warnings.length > 0) || item?.errorCode) {
    return "自动识别未完成，但原件已无损保留，请在系统中人工选择账单和付款。";
  }
  return null;
}

function formatPaymentProofReply(item, commandInput) {
  const allCandidates = Array.isArray(item?.candidates) ? item.candidates : [];
  const candidates = allCandidates.slice(0, 5);
  const hasReference = Boolean(commandInput.expenseReferenceCode);
  const matched = item?.status === "matched" && Boolean(item?.attachmentId);
  if (matched) {
    const paymentId = cleanText(item?.matchedPaymentId ?? candidates[0]?.paymentId);
    return [
      "付款凭证已上传并自动关联。",
      `账单编号：${commandInput.expenseReferenceCode}`,
      `已自动关联付款${paymentId ? `：${paymentId}` : ""}，可在系统中查看。`,
    ].join("\n");
  }
  const recognitionSummary = formatPaymentRecognition(item);
  return [
    "付款凭证已上传到待处理区。",
    hasReference
      ? `账单编号：${commandInput.expenseReferenceCode}`
      : "未提供 EXP 编号，已按金额和时间查找候选。",
    ...(recognitionSummary ? [recognitionSummary] : []),
    `候选付款 ${allCandidates.length} 笔，${hasReference ? "尚未自动关联" : "未自动关联"}，请在系统中人工确认。`,
    ...candidates.map(formatCandidate),
  ].join("\n");
}

function formatInvoiceReply() {
  return "发票已存入发票仓库，无需先匹配费用。请在系统中人工复核识别结果。";
}

const documentErrorReplies = new Map([
  ["missing_media", "请把图片或 PDF 和命令一起发送。"],
  ["unsupported_media", "只支持 JPG、PNG、WebP 图片或 PDF，请重新发送。"],
  ["file_unavailable", "文件读取失败，请重新发送原文件。"],
  ["too_large", "文件不能超过 12 MiB，请压缩后重新发送。"],
  ["invalid_filename", "文件名无效，请重命名后重新发送。"],
  ["mime_mismatch", "文件类型与实际内容不一致，请导出正确文件后重新发送。"],
  ["invalid_magic", "无法识别文件内容，请发送完整的 JPG、PNG、WebP 图片或 PDF。"],
]);

function documentCommandFailure(error) {
  if (error instanceof WeixinDocumentError) {
    return documentErrorReplies.get(error.code) ?? documentErrorReplies.get("file_unavailable");
  }
  return "暂时上传失败，请稍后重试；原文件可以重新发送。";
}

async function uploadPaymentProofCommand(request, command, client, now) {
  try {
    const document = await readWeixinDocument(request?.media);
    const commandInput = parsePaymentProofCommandArgs(command.args, now());
    const item = await client.uploadPaymentProof({
      expenseReferenceCode: commandInput.expenseReferenceCode,
      fileName: document.fileName,
      mediaType: document.mediaType,
      contentBase64: document.contentBase64,
      sourceRef: weixinDocumentSourceRef(request, document.sha256),
      textHint: commandInput.textHint,
      amountCents: commandInput.amountCents,
      occurredOn: commandInput.occurredOn,
      paidTime: commandInput.paidTime,
      matchMode: commandInput.matchMode,
    });
    return { text: formatPaymentProofReply(item, commandInput) };
  } catch (error) {
    return { text: documentCommandFailure(error) };
  }
}

async function uploadInvoiceCommand(request, client) {
  try {
    const document = await readWeixinDocument(request?.media);
    await client.uploadInvoice({
      fileName: document.fileName,
      mediaType: document.mediaType,
      contentBase64: document.contentBase64,
      sourceRef: weixinDocumentSourceRef(request, document.sha256),
    });
    return { text: formatInvoiceReply() };
  } catch (error) {
    return { text: documentCommandFailure(error) };
  }
}

function parseCommand(text) {
  const value = cleanText(text);
  if (!value.startsWith("/")) return null;
  const [, command, args = ""] = value.match(/^\/(\S+)\s*(.*)$/) ?? [];
  if (!command) return null;
  return { command, args: args.trim() };
}

export function createSalesWorkbenchWeixinAgent(options = {}) {
  const client = new SalesWorkbenchClient(options);
  const now = options.now ?? (() => new Date());
  const owner = options.owner || "weixin-agent";
  const sessionStore = options.sessionStore ?? createMemorySessionStore();
  if (
    !sessionStore
    || typeof sessionStore.get !== "function"
    || typeof sessionStore.set !== "function"
    || typeof sessionStore.delete !== "function"
  ) throw new TypeError("sessionStore must support get, set, and delete");

  return {
    async chat(request) {
      const text = cleanText(request?.text);
      const command = parseCommand(text);
      const naturalCustomerQuery = parseNaturalCustomerQuery(text);
      const sessionKey = sessionKeyFromRequest(request);

      if (command?.command === "帮助" || command?.command.toLowerCase() === "help") {
        return { text: helpText };
      }

      if (command?.command === "客户") {
        const customers = await client.listCustomers();
        return { text: formatCustomerReply(customers, command.args) };
      }

      if (command?.command === "周报") {
        const range = weekRange(now());
        const report = await client.createWeeklyDraft({ owner, ...range });
        return { text: formatWeeklyReply(report) };
      }

      if (command?.command === "付款凭证") {
        return uploadPaymentProofCommand(request, command, client, now);
      }

      if (command?.command === "发票") {
        return uploadInvoiceCommand(request, client);
      }

      if (naturalCustomerQuery) {
        const customers = await client.listCustomers();
        return { text: formatCustomerReply(customers, naturalCustomerQuery) };
      }

      if (!text) {
        return { text: "请发送拜访、电话或会议内容；需要整理时发送“记录”。" };
      }

      if (isClearCommand(text)) {
        await sessionStore.delete(sessionKey);
        return { text: "已清空当前暂存内容，可以重新发送记录。" };
      }

      if (isRecordCommand(text)) {
        const session = await sessionStore.get(sessionKey);
        if (!session || session.parts.length === 0) {
          return { text: "当前没有暂存内容。请先发送拜访、电话或会议内容。" };
        }

        await buildDraftPreview(session, client);
        return { text: formatDraftPreview(session, "待确认记录") };
      }

      if (isEnterCommand(text)) {
        const session = await sessionStore.get(sessionKey);
        if (!session || session.parts.length === 0) {
          return { text: "当前没有待录入内容。请先发送记录内容。" };
        }

        if (session.phase !== "review") {
          return { text: "请先发送“记录”查看整合草稿，再发送“录入”。" };
        }

        const record = await client.createQuickRecord({
          rawContent: draftContent(session),
          occurredAt: now().toISOString(),
          sourceChannel: sourceChannelFromParts(session.parts),
        });
        const insight = await client.analyzeQuickRecord(record.id);
        await sessionStore.delete(sessionKey);
        return { text: formatQuickRecordReply(record, insight) };
      }

      const session = (await sessionStore.get(sessionKey)) ?? createDraftSession();
      appendDraftPart(session, request, now());
      await sessionStore.set(sessionKey, session);

      if (session.phase === "review") {
        await buildDraftPreview(session, client);
        return { text: formatDraftPreview(session, "已更新待录入记录") };
      }

      return {
        text: [
          `已暂存 ${session.parts.length} 条。`,
          "继续发送可追加内容；需要整理时发送“记录”。",
          "需要查询客户时发送“查询客户名称”。",
        ].join("\n"),
      };
    },
  };
}
