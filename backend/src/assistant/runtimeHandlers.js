import { createHash, randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import {
  countActiveOpportunities,
  createCustomer,
  getActiveCustomer,
  softDeleteCustomer,
  updateCustomer,
} from "../customers/customerStore.js";
import { createQuickRecordStore } from "../quickRecords/quickRecordStore.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { HttpError } from "../http/errors.js";
import { decodeCanonicalBase64 } from "../http/strictBase64.js";
import { withDocumentBlobWritePreflight } from "../travelExpense/documentBlobStore.js";
import { createActionRiskAssistantAdapter } from "./actionRiskAssistantAdapter.js";
import { createAdvanceSettlementAssistantAdapter } from "./advanceSettlementAssistantAdapter.js";
import { createAssistantBusinessSnapshotAdapter } from "./businessSnapshotAdapter.js";
import { createAssistantSettlementSnapshotAdapter } from "./settlementSnapshotAdapter.js";
import { createCustomerAssistantAdapter } from "./customerAssistantAdapter.js";
import { createDashboardAssistantAdapter } from "./dashboardAssistantAdapter.js";
import { createItineraryAssistantAdapter } from "./itineraryAssistantAdapter.js";
import { createKnowledgeAssistantAdapter } from "./knowledgeAssistantAdapter.js";
import { createOpportunityAssistantAdapter } from "./opportunityAssistantAdapter.js";
import { createSalesReportAssistantAdapter } from "./salesReportAssistantAdapter.js";
import { createVisitCaptureAssistantAdapter } from "./visitCaptureAssistantAdapter.js";
import { reconcileWeixinInvoiceAttachments } from "./weixinInvoiceAttachment.js";
import {
  buildBookkeepingAnalysis,
  classifyBookkeepingEntry,
  extractBookkeepingRows,
} from "./bookkeepingCapture.js";
import { resolveItineraryTripRegion } from "./bookkeepingTripRegion.js";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const FINANCIAL_SCOPE_DENIED = "该财务预览仅限已绑定账号本人的微信私聊。";

function safeText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function conversationRecord(sessionRepository, context) {
  return sessionRepository.getOrCreate({
    owner: context.owner,
    channel: context.channel,
    conversationId: context.conversation,
  });
}

function draftParts(sessionRepository, context) {
  const conversation = conversationRecord(sessionRepository, context);
  const parts = sessionRepository.listDraftParts(conversation.id);
  return { conversation, parts };
}

const CONTROL_MESSAGES = new Set([
  "记录", "录入", "确认", "取消", "帮助", "help", "/帮助", "/help",
  // The orchestrator persists confirmation deliveries as this placeholder so
  // the original code never enters the business draft.
  "<confirmation-code>",
]);

function isControlMessage(text) {
  return CONTROL_MESSAGES.has(text);
}

function draftText(sessionRepository, context) {
  const { parts } = draftParts(sessionRepository, context);
  return parts
    .filter((part) => part.role === "user" && !isControlMessage(safeText(part.text)))
    .map((part) => safeText(part.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function previewText(analysis) {
  const customer = safeText(
    analysis?.customerCandidate?.id ? analysis.customerCandidate.name : analysis?.customer?.value,
    "待匹配客户",
  );
  const opportunity = safeText(
    analysis?.opportunityCandidate?.id ? analysis.opportunityCandidate.name : analysis?.opportunity?.value,
    "待确认商机",
  );
  const request = safeText(analysis?.summary?.request?.text, "待补充");
  const risk = safeText(analysis?.summary?.risk?.text, "待确认");
  const action = safeText(analysis?.summary?.action?.text, "待确认");
  const customerCandidate = analysis?.customerCandidate;
  const opportunityCandidate = analysis?.opportunityCandidate;
  const candidateLine = [
    customerCandidate?.status === "ambiguous" ? "客户候选不唯一" : null,
    opportunityCandidate?.status === "ambiguous" ? "商机候选不唯一" : null,
    customerCandidate?.status === "unknown" ? "客户待匹配" : null,
    opportunityCandidate?.status === "unknown" ? "商机待匹配" : null,
  ].filter(Boolean).join("；");
  return [
    "待确认记录：",
    `客户：${customer}`,
    `商机：${opportunity}`,
    `诉求：${request.slice(0, 160)}`,
    `风险：${risk.slice(0, 160)}`,
    `建议：${action.slice(0, 160)}`,
    ...(candidateLine ? [`候选校验：${candidateLine}`] : []),
    ...(analysis?.runId ? [`运行记录：${analysis.runId}`] : []),
    "",
    "确认无误后回复“录入”，再使用返回的确认码完成写入。",
  ].join("\n");
}

function quickRecordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    owner: row.owner ?? null,
    rawContent: row.raw_content,
    occurredAt: row.occurred_at,
    sourceChannel: row.source_channel,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function quickCaptureReceipt(record, insight, db) {
  const customerName = record.customerId
    ? db.prepare("SELECT name FROM customers WHERE id = $id").get({ $id: record.customerId })?.name ?? record.customerId
    : null;
  const actionText = safeText(insight?.summary?.action?.text);
  return [
    `已录入，记录 ID：…${record.id.slice(-6)}。`,
    customerName
      ? `已挂接客户：${customerName}；AI 分析已保存。`
      : "未自动挂接客户（分析未唯一匹配）；AI 分析已保存。",
    ...(actionText ? [`建议待办“${actionText.slice(0, 60)}”可在系统确认页写回客户/商机与待办。`] : []),
    "后续可发“最近的记录”查看，或“把那条记录的下一步改成…”修改。",
  ].join("\n");
}

function insightFromRow(row) {
  if (!row) return null;
  let analysis = {};
  try { analysis = JSON.parse(row.analysis_json); } catch { analysis = {}; }
  return {
    id: row.id,
    quickRecordId: row.quick_record_id,
    source: row.source,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...analysis,
  };
}

function mediaBuffer(media) {
  return decodeCanonicalBase64(media.contentBase64, { maxDecodedBytes: MAX_DOCUMENT_BYTES });
}

function boundedRecognition(recognition) {
  if (!recognition || typeof recognition !== "object" || Array.isArray(recognition)) return {};
  const extractedText = typeof recognition.extractedText === "string"
    ? recognition.extractedText.slice(0, 200_000)
    : recognition.extractedText ?? null;
  return { ...recognition, extractedText };
}

function visionTransactionRows(recognition) {
  const transactions = recognition?.transactions;
  if (!Array.isArray(transactions) || transactions.length < 1 || transactions.length > 20) return [];
  return transactions.flatMap((transaction, index) => {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return [];
    const amountCents = Number.isSafeInteger(transaction.amountCents) && transaction.amountCents > 0
      ? transaction.amountCents
      : null;
    if (amountCents === null) return [];
    const occurredOn = /^\d{4}-\d{2}-\d{2}$/u.test(safeText(transaction.occurredOn))
      ? safeText(transaction.occurredOn)
      : null;
    const paidTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(safeText(transaction.paidTime))
      ? safeText(transaction.paidTime)
      : null;
    const merchant = safeText(transaction.merchant) || null;
    const paymentMethod = safeText(transaction.paymentMethod) || null;
    return [{
      index,
      amountCents,
      entryType: null,
      merchant,
      occurredOn,
      paidTime,
      paymentMethod,
      text: [
        merchant ? `商户：${merchant}` : null,
        occurredOn ? `交易日期：${occurredOn}` : null,
        paidTime ? `支付时间：${paidTime}` : null,
        `金额：${(amountCents / 100).toFixed(2)} 元`,
        paymentMethod ? `支付方式：${paymentMethod}` : null,
      ].filter(Boolean).join("\n").slice(0, 12_000),
      warnings: [],
      visionTransaction: true,
    }];
  });
}

function moneyFromCents(value) {
  return Number.isSafeInteger(value) && value >= 0 ? `${(value / 100).toFixed(2)} 元` : "金额待确认";
}

function shanghaiWeekStart(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const day = new Date(`${valueOf("year")}-${valueOf("month")}-${valueOf("day")}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return null;
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function shanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const normalized = `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function looksLikeInvoiceDocument({ fileName, mediaType, text } = {}) {
  const name = safeText(fileName);
  const value = safeText(text);
  if (/(?:发票|invoice)/iu.test(name)) return true;
  if (mediaType === "application/pdf" && !/(?:付款|支付|交易|账单)/u.test(name)) return true;
  const markers = [
    /(?:电子)?发票/u,
    /发票(?:代码|号码)/u,
    /购买方/u,
    /销售方/u,
    /价税合计/u,
    /税额/u,
  ].filter((pattern) => pattern.test(value)).length;
  return markers >= 2;
}

function safeEntityHint(value, max = 200) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > max
    || normalized.startsWith("synthetic:")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) return null;
  return normalized;
}

function usableEntityLabel(value) {
  const normalized = safeEntityHint(value, 500);
  if (!normalized || /^(?:待匹配客户|待确认商机|未命名|未知|待补充)$/u.test(normalized)) return null;
  return normalized;
}

function resolveQuickRecordLinks(snapshotAdapter, owner, analysis) {
  const customerHint = analysis?.customer ?? {};
  const opportunityHint = analysis?.opportunity ?? {};
  let customer = null;
  let opportunity = null;

  const customerId = safeEntityHint(customerHint.id);
  if (customerId) customer = snapshotAdapter.customerDetail({ owner, customerId });
  if (!customer) {
    const customerName = usableEntityLabel(customerHint.value);
    if (customerName) {
      const matches = snapshotAdapter.customerSearch({ owner, query: customerName }).items;
      if (matches.length === 1) customer = matches[0];
    }
  }

  const opportunityId = safeEntityHint(opportunityHint.id);
  if (opportunityId) opportunity = snapshotAdapter.opportunityDetail({ owner, opportunityId });
  if (!opportunity) {
    const opportunityName = usableEntityLabel(opportunityHint.value);
    if (opportunityName) {
      const matches = snapshotAdapter.opportunitySearch({ owner, query: opportunityName }).items;
      if (matches.length === 1) opportunity = matches[0];
    }
  }

  if (opportunity && customer && opportunity.customerId !== customer.id) {
    // A model-provided pair that does not match the database relationship is
    // not safe to persist. Keep the independently verified customer only.
    opportunity = null;
  }
  if (opportunity && !customer && opportunity.customerId) {
    customer = snapshotAdapter.customerDetail({ owner, customerId: opportunity.customerId });
  }

  return {
    customerId: customer?.id ?? null,
    opportunityId: opportunity?.id ?? null,
  };
}

function expenseSummaryText(summary, label) {
  const lines = [
    `${label}（${summary.weekStart}）：${summary.summary.count} 笔，实付 ${moneyFromCents(summary.summary.actualPaidCents)}，登记可报销 ${moneyFromCents(summary.summary.reimbursementCents)}。`,
    `已匹配发票 ${moneyFromCents(summary.summary.confirmedCoverageCents)}，缺票 ${moneyFromCents(summary.summary.missingInvoiceCents)}。`,
  ];
  if (summary.summary.noInvoiceConfirmedCents > 0) {
    lines.push(`其中已确认无票 ${moneyFromCents(summary.summary.noInvoiceConfirmedCents)}，尚未说明缺票 ${moneyFromCents(summary.summary.unacknowledgedMissingCents)}。`);
  }
  if (summary.summary.invalidAmountCount > 0) lines.push(`有 ${summary.summary.invalidAmountCount} 笔金额待确认。`);
  if (summary.truncated) lines.push("当前只展示前 100 笔，属于部分摘要。 ".trim());
  return lines.join("\n");
}

function projectAnalysisText(analysis) {
  const metrics = analysis.metrics ?? {};
  const opportunity = metrics.opportunity ?? {};
  const freshness = metrics.evidenceFreshness ?? {};
  const lines = [
    "项目分析预览（事实、推断与未知已分开）：",
    `阶段：${opportunity.stage ?? "待确认"}`,
    `金额：${opportunity.amount ?? "待确认"}`,
    `概率：${opportunity.probability === null || opportunity.probability === undefined ? "待确认" : `${opportunity.probability}%`}`,
    `未完成动作：${metrics.actions?.open ?? 0}，活跃风险：${metrics.risks?.active ?? 0}`,
    `关联客户费用：${moneyFromCents(metrics.expense?.actualPaidCents)}，可报销 ${moneyFromCents(metrics.expense?.reimbursementCents)}`,
    `证据新鲜度：${freshness.status ?? "unknown"}`,
  ];
  if (analysis.inferences?.length) lines.push(`推断：${analysis.inferences[0].statement}`);
  if (analysis.unknowns?.length) {
    lines.push(`待补充：${analysis.unknowns.slice(0, 3).map((item) => item.question).join("；")}`);
  }
  return lines.join("\n");
}

function salesDecisionPreviewText(result) {
  const analysis = result?.analysis ?? {};
  const decision = analysis.decision ?? {};
  const stage = analysis.stage ?? {};
  const score = analysis.score ?? {};
  const lines = [
    "项目分析预览（销售决策预览，sales-decision-v1，未写回）：",
    `判断：${decision.code ?? "待确认"}（置信度 ${Number.isSafeInteger(decision.confidence) ? decision.confidence : "待确认"}）`,
    `阶段：当前 ${result?.currentStageLabel ?? stage.current ?? "待确认"}，建议 ${stage.recommended ?? "待确认"}${stage.gatePassed === true ? "（阶段门槛已满足）" : "（阶段门槛未满足）"}`,
    `评分：${Number.isSafeInteger(score.total) ? score.total : "待确认"}`,
    `结论：${String(analysis.headline ?? decision.reason ?? "待补充证据").slice(0, 500)}`,
  ];
  if (analysis.compliance?.status === "review_required") {
    lines.push(`合规：需要人工审查${analysis.compliance.flags?.length ? `（${analysis.compliance.flags.slice(0, 3).join("、")}）` : ""}`);
  }
  if (Array.isArray(analysis.unknowns) && analysis.unknowns.length > 0) {
    lines.push(`待确认：${analysis.unknowns.slice(0, 3).map((item) => item.question).join("；")}`);
  }
  if (Array.isArray(analysis.nextActions) && analysis.nextActions.length > 0) {
    lines.push(`下一步：${analysis.nextActions.slice(0, 3).map((item) => item.action).join("；")}`);
  }
  if (result?.runId) lines.push(`运行记录：${result.runId}（来源 ${result.source ?? "待确认"}）`);
  return lines.join("\n");
}

function salesLoopStatusText(result, fallback) {
  if (result?.status === "clarify") return result.question ?? fallback;
  if (result?.status === "not_found") return "未找到该项目，或当前账号无权查看。";
  if (result?.status === "review_required") {
    const reason = result.message ?? ((result.blockers ?? []).join("、") || "证据不足");
    return `销售决策暂需人工复核：${reason}`;
  }
  return fallback;
}

function salesReportSummaryText(summary) {
  const counts = summary?.statusCounts ?? { draft: 0, saved: 0, ready: 0 };
  const preview = summary?.preview ?? {};
  const lines = [
    `销售周报预览（${summary?.weekStart ?? "待确认"}）：已保存周报 ${summary?.reportCount ?? 0} 条（草稿 ${counts.draft}、已保存 ${counts.saved}、就绪 ${counts.ready}）。`,
  ];
  if (Number.isSafeInteger(summary?.candidateRecordCount) && summary.candidateRecordCount !== summary?.preview?.sourceRecordCount) {
    lines.push(`本周可见快速记录 ${summary.candidateRecordCount} 条，其中 ${preview.sourceRecordCount ?? 0} 条已确认进入预览。`);
  } else if (preview.sourceRecordCount > 0) {
    lines.push(`已基于 ${preview.sourceRecordCount}${preview.truncated ? "+" : ""} 条已确认拜访记录生成未保存预览。`);
  } else {
    lines.push("当前没有可用于生成周报预览的已确认拜访记录。");
  }
  if (preview.preparation?.ready === false) {
    lines.push(`确认前待处理：${(preview.preparation.blockers ?? []).join("、") || "资料不完整"}。`);
  }
  const content = typeof preview.content === "string" && preview.content.trim()
    ? preview.content.slice(0, 4_000)
    : "";
  if (content) lines.push("", content, ...(preview.content.length > 4_000 ? ["（正文已限界，完整内容请在系统内查看。）"] : []));
  lines.push("本次仅预览，尚未写入周报。");
  return lines.join("\n");
}

function settlementDirectionText(direction) {
  return direction === "company_reimburses"
    ? "公司应补"
    : direction === "individual_returns"
      ? "个人应退"
      : direction === "balanced"
        ? "已平衡"
        : "方向待确认";
}

function settlementPreviewText(result) {
  const preview = result?.settlementPreview ?? {};
  const formula = preview.formula ?? {};
  const lines = [
    `请款结算预览（${result?.weekStart ?? "待确认"}）：${settlementDirectionText(preview.direction)}，金额 ${moneyFromCents(preview.amountCents)}。`,
    `公式：非公司直付的可报销金额 ${moneyFromCents(formula.settlementEligibleCents)} - 已收到请款金额 ${moneyFromCents(formula.advanceReceivedCents)} = ${Number.isSafeInteger(formula.personalSettlementCents) ? `${formula.personalSettlementCents < 0 ? "-" : ""}${moneyFromCents(Math.abs(formula.personalSettlementCents))}` : "待确认"}。`,
    "本次结果仅供人工核对，不接受确认写入，也不会生成退款或补款交易。",
  ];
  const blockers = Array.isArray(preview.blockers) ? preview.blockers : [];
  if (blockers.length) lines.push(`待人工复核：${blockers.slice(0, 4).map((item) => item.question).join("；")}`);
  return lines.join("\n");
}

function ambiguousEntityResult(label, items) {
  return {
    text: `找到多个${label}，请补充更具体的名称或内部标识：${items.slice(0, 5).map((item) => item.name).filter(Boolean).join("、")}`,
    status: "clarify",
    question: `请确认要查看哪个${label}。`,
    items,
  };
}

function reusableVisitRun(repository, context, content) {
  if (!repository) return null;
  try {
    const byEvent = context.event && typeof repository.getByEvent === "function"
      ? repository.getByEvent({ owner: context.owner, channel: context.channel, eventId: context.event })
      : null;
    const byConversation = typeof repository.getLatest === "function"
      ? repository.getLatest({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        agentId: "visit-capture",
      })
      : null;
    for (const scoped of [byEvent, byConversation]) {
      const input = scoped?.item?.input;
      if (!scoped?.item?.output || input?.rawContent !== content) continue;
      if ((input?.context?.customerId ?? null) !== (context.businessContext?.customerId ?? null)) continue;
      if ((input?.context?.opportunityId ?? null) !== (context.businessContext?.opportunityId ?? null)) continue;
      return scoped;
    }
    return null;
  } catch {
    return null;
  }
}

export function createAssistantToolHandlers({
  db,
  config,
  sessionRepository,
  travelExpenseDocumentInboxRepository,
  bookkeepingRepository = null,
  bookkeepingRuntime = null,
  travelExpenseRepository = null,
  travelExpenseRegionRepository = null,
  travelExpenseAnalyzer = null,
  invoiceRepository,
  paymentProofRecognizer,
  invoiceRecognizer,
  businessSnapshotAdapter = null,
  settlementSnapshotAdapter = null,
  customerAssistantAdapter = null,
  dashboardAssistantAdapter = null,
  actionRiskAssistantAdapter = null,
  knowledgeAssistantAdapter = null,
  opportunityAssistantAdapter = null,
  itineraryAssistantAdapter = null,
  advanceSettlementAssistantAdapter = null,
  visitCaptureAssistantAdapter = null,
  salesReportAssistantAdapter = null,
  agentRunRepository = null,
  salesLoopPreviewService = null,
  quickRecordStore = null,
  resolveBusinessOwner = (owner) => owner,
  clock = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!db || !sessionRepository) throw new TypeError("assistant runtime dependencies are required");
  const recordStore = quickRecordStore ?? createQuickRecordStore(db, { clock });
  const snapshotAdapter = businessSnapshotAdapter ?? createAssistantBusinessSnapshotAdapter({ db, clock, resolveBusinessOwner });
  const settlementSnapshot = settlementSnapshotAdapter ?? createAssistantSettlementSnapshotAdapter({
    db,
    clock,
    resolveBusinessOwner,
  });
  const customerAdapter = customerAssistantAdapter ?? createCustomerAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const dashboardAdapter = dashboardAssistantAdapter ?? createDashboardAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const opportunityAdapter = opportunityAssistantAdapter ?? createOpportunityAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const actionRiskAdapter = actionRiskAssistantAdapter ?? createActionRiskAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const knowledgeAdapter = knowledgeAssistantAdapter ?? createKnowledgeAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const itineraryAdapter = itineraryAssistantAdapter ?? createItineraryAssistantAdapter({
    snapshotAdapter,
    runRepository: agentRunRepository,
    clock,
  });
  const advanceSettlementAdapter = advanceSettlementAssistantAdapter ?? createAdvanceSettlementAssistantAdapter({
    settlementSnapshotAdapter: settlementSnapshot,
    runRepository: agentRunRepository,
    clock,
  });
  const visitCaptureAdapter = visitCaptureAssistantAdapter ?? createVisitCaptureAssistantAdapter({
    config,
    fetchImpl,
    runRepository: agentRunRepository,
    businessSnapshotAdapter: snapshotAdapter,
    clock,
  });
  const salesReportAdapter = salesReportAssistantAdapter ?? (
    salesLoopPreviewService && typeof salesLoopPreviewService.buildSalesReportSnapshot === "function"
      ? createSalesReportAssistantAdapter({
          config,
          fetchImpl,
          runRepository: agentRunRepository,
          clock,
          snapshotProvider: ({ owner, weekStart, periodStart, periodEnd, knowledgeQuery }) => (
            salesLoopPreviewService.buildSalesReportSnapshot({ owner, weekStart, periodStart, periodEnd, knowledgeQuery })
          ),
        })
      : null
  );

  const handlers = {
    async "bookkeeping.ingest"(args, context, serverData) {
      const media = serverData.media;
      const rawText = safeText(args?.text);
      const receivedAt = clock();
      if (!media && !rawText) {
        return { text: "请发送付款截图，或直接说明金额、日期和用途。", status: "clarify" };
      }
      if (!bookkeepingRepository || !bookkeepingRuntime) {
        return { text: "记账助手尚未完成配置，当前没有写入任何费用。", status: "error" };
      }
      if (context.channel === "weixin" && serverData.auditMetadata?.financialScope !== true) {
        return { text: FINANCIAL_SCOPE_DENIED, status: "denied" };
      }
      if (media && media.sourceRef !== args?.mediaRef) {
        return { text: "这张图片的来源标识已变化，请重新发送。", status: "error" };
      }
      if (media && !rawText && looksLikeInvoiceDocument({
        fileName: media.fileName,
        mediaType: media.mediaType,
        text: "",
      })) {
        return handlers["invoice.ingest"]({ mediaRef: media.sourceRef }, context, serverData);
      }

      const content = media ? mediaBuffer(media) : null;
      const sourceRef = media?.sourceRef
        ?? `weixin:text:${safeText(context.event) || safeText(context.requestId) || createHash("sha256").update(rawText, "utf8").digest("hex")}`;
      if (media && typeof bookkeepingRepository.listBySource === "function") {
        const existingItems = bookkeepingRepository.listBySource({
          owner: context.owner,
          sourceId: sourceRef,
        });
        if (existingItems.length > 0) {
          const existingResults = existingItems.map((item) => ({
            item,
            pending: item.status === "review_required"
              ? bookkeepingRuntime.startReview({ account: context.owner, entry: item })
              : null,
          }));
          const countText = existingItems.length > 1 ? `，共识别 ${existingItems.length} 笔` : "";
          return {
            text: `这张付款凭证已经收到${countText}，已保留原来的记账状态。`,
            status: "duplicate",
            item: existingItems[0] ?? null,
            items: existingItems,
            pending: existingResults[0]?.pending ?? null,
            pendingItems: existingResults.map((result) => result.pending).filter(Boolean),
          };
        }
      }
      let recognition = {};
      if (media) {
        try {
          recognition = boundedRecognition(await paymentProofRecognizer({
            fileName: media.fileName,
            mediaType: media.mediaType,
            buffer: content,
          }, { referenceDate: shanghaiDate(receivedAt) }));
        } catch {
          recognition = { extractedText: null, evidence: null, warnings: ["RECOGNITION_FAILED"], source: { provider: "rules", model: null } };
        }
      }
      const extractedText = safeText(recognition?.extractedText) || rawText;
      if (media && !rawText && (
        recognition?.documentKind === "invoice"
        || looksLikeInvoiceDocument({
          fileName: media.fileName,
          mediaType: media.mediaType,
          text: extractedText,
        })
      )) {
        return handlers["invoice.ingest"]({ mediaRef: media.sourceRef }, context, serverData);
      }
      const splitRows = media
        ? extractBookkeepingRows(extractedText, { layout: recognition?.layout })
        : [];
      const transactionRows = media ? visionTransactionRows(recognition) : [];
      const rowInputs = splitRows.length > 1
        ? splitRows
        : transactionRows.length > 1
          ? transactionRows
          : [{
            index: 0,
            text: extractedText || rawText,
            amountCents: recognition?.evidence?.amountCents ?? null,
            entryType: null,
            merchant: recognition?.evidence?.merchant ?? null,
            warnings: [],
          }];
      const explicitEntryType = /收入|借款|借支|预借|到账|工资|奖金/u.test(rawText)
        ? "income"
        : /支出|消费|付款/u.test(rawText) ? "expense" : null;
      const analyzedRows = [];
      for (const row of rowInputs) {
        const rowText = safeText(row.text) || extractedText || rawText;
        let expenseAnalysis = null;
        if (rowText && typeof travelExpenseAnalyzer === "function") {
          try {
            expenseAnalysis = await travelExpenseAnalyzer(rowText);
          } catch {
            expenseAnalysis = { warnings: ["ANALYSIS_FAILED"], expense: null, source: { provider: "rules", model: null } };
          }
        }
        const combinedText = row.visionTransaction
          ? `${rowText}\n${rawText}`.trim()
          : `${rawText}\n${rowText}`.trim();
        const entryType = classifyBookkeepingEntry({
          text: combinedText,
          entryType: explicitEntryType ?? row.entryType ?? args?.entryType,
        });
        const rowRecognition = rowInputs.length > 1
          ? {
              extractedText: rowText,
              evidence: {
                amountCents: row.amountCents,
                occurredOn: row.visionTransaction ? row.occurredOn : null,
                paidTime: row.visionTransaction ? row.paidTime : null,
                merchant: row.merchant,
                paymentMethod: row.visionTransaction
                  ? row.paymentMethod
                  : recognition?.evidence?.paymentMethod ?? null,
              },
              confidence: recognition?.confidence ?? null,
              warnings: [...new Set([
                ...(Array.isArray(recognition?.warnings) ? recognition.warnings : []),
                ...(Array.isArray(row.warnings) ? row.warnings : []),
              ])],
              source: recognition?.source ?? { provider: "rules", model: null },
            }
          : recognition;
        const analysis = buildBookkeepingAnalysis({
          recognition: rowRecognition,
          expenseAnalysis,
          text: combinedText,
          entryType,
          now: receivedAt,
          tripRegionResolver: ({ occurredOn }) => (
            travelExpenseRegionRepository?.resolveRegion({
              owner: context.owner,
              occurredOn,
            })?.city
            ?? resolveItineraryTripRegion(db, {
              owner: context.owner,
              occurredOn,
            })
          ),
        });
        const profileRegion = travelExpenseRegionRepository?.resolveRegion({
          owner: context.owner,
          occurredOn: analysis.expense?.occurredOn,
        }) ?? null;
        if (profileRegion?.city && analysis.noteAutomation?.kind === "meal") {
          analysis.noteAutomation = {
            ...analysis.noteAutomation,
            tripRegion: profileRegion.city,
            tripRegionSource: profileRegion.source,
          };
        }
        analyzedRows.push({ row, rowText, entryType, analysis });
      }
      let inbox = null;
      if (media && travelExpenseDocumentInboxRepository) {
        try {
          inbox = await withDocumentBlobWritePreflight(db, {
            owner: context.owner,
            content,
          }, (encodedDocumentBlob) => withImmediateTransaction(db, () => travelExpenseDocumentInboxRepository.createDocument({
            owner: context.owner,
            actor: context.owner,
            source: "weixin",
            sourceRef,
            documentKind: "payment_proof",
            fileName: media.fileName,
            mediaType: media.mediaType,
            content,
            encodedDocumentBlob,
            status: "review_required",
            extractedText: recognition?.extractedText ?? null,
            recognition: { ...recognition, bookkeepingCapture: true },
            errorCode: recognition?.warnings?.[0] ?? null,
          })));
        } catch (error) {
          if (error?.code !== "DUPLICATE_DOCUMENT") throw error;
          inbox = error.existingId
            ? travelExpenseDocumentInboxRepository.getDocument(error.existingId, { owner: context.owner })
            : null;
        }
      }
      // Persist the complete source batch atomically. Repository write methods
      // join this outer transaction, so a crash cannot leave row 1 durable
      // while row 2 is absent. The in-transaction source recheck also closes
      // the concurrent-first-request window after asynchronous recognition.
      const capturedResults = withImmediateTransaction(db, () => {
        if (media && typeof bookkeepingRepository.listBySource === "function") {
          const concurrentExisting = bookkeepingRepository.listBySource({
            owner: context.owner,
            sourceId: sourceRef,
          });
          if (concurrentExisting.length > 0) {
            return concurrentExisting.map((item) => ({ item, replayed: true }));
          }
        }
        const batch = [];
        for (const { row, rowText, entryType, analysis } of analyzedRows) {
          const rowOrdinal = row.index + 1;
          const idempotencySource = media
            ? `${sourceRef}:row:${rowOrdinal}`
            : analyzedRows.length > 1
              ? `${sourceRef}:row:${rowOrdinal}`
              : sourceRef;
          const requestHash = createHash("sha256").update(JSON.stringify(media
            ? { sourceRef, rowOrdinal, media: true }
            : {
                sourceRef,
                rowIndex: row.index,
                rowText,
                rawText,
                entryType,
              }), "utf8").digest("hex");
          const received = bookkeepingRepository.receive({
            owner: context.owner,
            actor: context.owner,
            ledgerName: "出差报销",
            entryType,
            category: analysis.category,
            subcategory: analysis.subcategory,
            note: analysis.note ?? null,
            idempotencyKey: `weixin-bookkeeping:${idempotencySource}`,
            requestHash,
            sourceId: sourceRef,
            rawText: rowText || rawText || media?.fileName || "微信图片记账",
            capturedAt: analysis.expense?.paidAt ?? receivedAt.toISOString(),
          });
          if (received.replayed) {
            batch.push({ item: received.item, replayed: true });
            continue;
          }
          const claimed = bookkeepingRepository.claim(received.item.id);
          const completed = bookkeepingRepository.completeLocal(received.item.id, {
            analysis,
            leaseToken: claimed.leaseToken,
          });
          batch.push({ item: completed.item, replayed: false });
        }
        return batch;
      });
      const results = capturedResults.map((result) => ({
        ...result,
        pending: result.item.status === "review_required"
          ? bookkeepingRuntime.startReview({ account: context.owner, entry: result.item })
          : null,
      }));
      const pendingCount = results.filter((result) => result.pending).length;
      const replayed = results.every((result) => result.replayed);
      const countText = results.length > 1 ? `，共识别 ${results.length} 笔` : "";
      return {
        text: replayed
          ? `这张付款凭证已经收到${countText}，已保留原来的记账状态。`
          : `已收到付款凭证${countText}，正在逐笔发送待确认记账信息。请分别引用小小的消息回复。`,
        status: pendingCount > 0 ? "review_required" : "duplicate",
        item: results[0]?.item ?? null,
        items: results.map((result) => result.item),
        pending: results[0]?.pending ?? null,
        pendingItems: results.map((result) => result.pending).filter(Boolean),
        ...(inbox ? { documentInboxId: inbox.id } : {}),
      };
    },

    async "dashboard.summary"(_args, context) {
      const result = await dashboardAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "daily_overview",
      });
      const summary = {
        asOf: result.asOf,
        weekStart: result.weekStart,
        counts: result.counts,
      };
      const counts = summary.counts;
      return {
        text: [
          `战情总览（截至 ${summary.asOf}）：`,
          `客户 ${counts.customers}，商机 ${counts.opportunities}`,
          `未完成动作 ${counts.openActions}，活跃风险 ${counts.activeRisks}`,
          `待执行行程 ${counts.upcomingItineraries}，本周差旅 ${counts.currentWeekExpenses} 笔`,
        ].join("\n"),
        status: "ok",
        summary,
        dashboardResult: result,
        runId: result.runId,
      };
    },

    async "customer.detail"(args, context) {
      const result = await customerAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "detail",
        customerId: args.customerId,
        query: args.customerId,
      });
      if (result.status === "clarify") return {
        ...ambiguousEntityResult("客户", result.matches),
        customerResult: result,
        runId: result.runId,
      };
      if (result.status === "not_found" || !result.customer) return {
        text: "未找到该客户，或当前账号无权查看。",
        status: "not_found",
        customerResult: result,
        runId: result.runId,
      };
      const customer = result.customer;
      const listText = (items) => (Array.isArray(items) && items.length > 0 ? items.join("、") : null);
      const opportunityCount = countActiveOpportunities(db, customer.id);
      return {
        text: [
          `客户画像：${customer.name ?? "名称待确认"} [${customer.id}]`,
          `区域：${customer.region ?? "待补充"} ｜ 类型：${customer.type ?? "待补充"} ｜ 级别：${customer.level ?? "待补充"}`,
          `联系人：${customer.contact ?? "待补充"}`,
          `预算：${customer.budget ?? "待补充"}`,
          `别名：${listText(customer.aliases) ?? "无"} ｜ 标签：${listText(customer.tags) ?? "无"}`,
          ...(customer.summary ? [`摘要：${customer.summary.slice(0, 300)}`] : []),
          `在办商机 ${opportunityCount} 个；更新时间：${customer.updatedAt ?? "待确认"}`,
          "（未录入的字段不会猜测，可发送“修改客户 …”补充。）",
        ].join("\n"),
        status: "ok",
        customer,
        customerResult: result,
        runId: result.runId,
        contextUpdate: {
          customerId: customer.id,
          opportunityId: null,
          source: "verified_entity",
          sourceRefs: [{ type: "customer", id: customer.id }],
        },
      };
    },

    async "customer.create"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，未创建客户档案。", status: "denied" };
      }
      const customerId = safeText(context.actionId) || randomUUID();
      const existing = getActiveCustomer(db, customerId);
      if (existing) {
        return {
          text: `已建档：${existing.name}（ID：${existing.id}，v${existing.version}）。发送“客户详情 ${existing.id}”可查看。`,
          status: "created",
          customer: existing,
          replayed: true,
          contextUpdate: {
            customerId: existing.id,
            opportunityId: null,
            source: "verified_entity",
            sourceRefs: [{ type: "customer", id: existing.id }],
          },
        };
      }
      const created = withImmediateTransaction(db, () => {
        const item = createCustomer(db, {
          name: safeText(args.name),
          region: safeText(args.region) || null,
          type: safeText(args.type) || null,
          level: safeText(args.level) || null,
          contact: safeText(args.contact) || null,
          budget: safeText(args.budget) || null,
          summary: safeText(args.summary) || null,
          aliases: Array.isArray(args.aliases) ? args.aliases : [],
          tags: Array.isArray(args.tags) ? args.tags : [],
          owner: businessOwner,
        }, { id: customerId });
        insertAudit(db, {
          action: "customer.create",
          entityType: "customer",
          entityId: item.id,
          actor: context.owner,
          requestId: context.requestId,
          before: null,
          after: item,
          entityVersion: item.version,
          metadata: {
            name: item.name,
            region: item.region,
            level: item.level,
            source: "weixin-assistant",
            ...(context.actionId ? { actionId: context.actionId } : {}),
          },
        });
        return item;
      });
      return {
        text: [
          `已建档：${created.name}（ID：${created.id}，v${created.version}）。`,
          `发送“客户详情 ${created.id}”可查看；后续可发送“修改客户 …”补充画像。`,
        ].join("\n"),
        status: "created",
        customer: created,
        contextUpdate: {
          customerId: created.id,
          opportunityId: null,
          source: "verified_entity",
          sourceRefs: [{ type: "customer", id: created.id }],
        },
      };
    },

    async "customer.update"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，未修改客户档案。", status: "denied" };
      }
      const customerId = safeText(args.customerId);
      const expectedVersion = Number(args.expectedVersion);
      const changes = args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)
        ? args.changes
        : null;
      if (!customerId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !changes || Object.keys(changes).length === 0) {
        return { text: "修改请求不完整，请重新发送修改指令。", status: "error" };
      }
      const before = getActiveCustomer(db, customerId);
      if (!before || before.owner !== businessOwner) {
        return { text: "客户不存在或已删除，未修改任何资料。", status: "not_found" };
      }
      let updated;
      try {
        updated = withImmediateTransaction(db, () => {
          const item = updateCustomer(db, customerId, changes, expectedVersion);
          if (!item) throw new HttpError(404, "NOT_FOUND", "Requested resource was not found");
          insertAudit(db, {
            action: "customer.update",
            entityType: "customer",
            entityId: item.id,
            actor: context.owner,
            requestId: context.requestId,
            before,
            after: item,
            entityVersion: item.version,
            metadata: {
              changedFields: Object.keys(changes),
              source: "weixin-assistant",
              ...(context.actionId ? { actionId: context.actionId } : {}),
            },
          });
          return item;
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT") {
          return { text: "客户资料刚在其他端被修改，本次未写入。请重新发送修改指令查看最新资料。", status: "conflict" };
        }
        if (error?.code === "NOT_FOUND") {
          return { text: "客户不存在或已删除，未修改任何资料。", status: "not_found" };
        }
        throw error;
      }
      const describe = (value) => (Array.isArray(value)
        ? (value.length > 0 ? value.join("、") : "（空）")
        : (typeof value === "string" && value.trim() ? value.trim() : "（空）"));
      const fieldLabels = {
        name: "名称", region: "区域", type: "类型", level: "级别",
        contact: "联系人", budget: "预算", summary: "摘要", aliases: "别名", tags: "标签",
      };
      const changeLines = Object.keys(changes)
        .map((key) => `${fieldLabels[key] ?? key} ${describe(before[key])}→${describe(updated[key])}`);
      return {
        text: `已更新：${updated.name}（v${updated.version}）。${changeLines.join("；")}。`,
        status: "updated",
        customer: updated,
        contextUpdate: {
          customerId: updated.id,
          opportunityId: null,
          source: "verified_entity",
          sourceRefs: [{ type: "customer", id: updated.id }],
        },
      };
    },

    async "customer.delete"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，未删除客户档案。", status: "denied" };
      }
      const customerId = safeText(args.customerId);
      const expectedVersion = Number(args.expectedVersion);
      if (!customerId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return { text: "删除请求不完整，请重新发送删除指令。", status: "error" };
      }
      const before = getActiveCustomer(db, customerId);
      if (!before || before.owner !== businessOwner) {
        return { text: "客户不存在或已删除，未执行任何操作。", status: "not_found" };
      }
      let deleted;
      try {
        deleted = softDeleteCustomer(db, {
          id: customerId,
          expectedVersion,
          deletedBy: context.owner,
          requestId: context.requestId,
          metadata: {
            source: "weixin-assistant",
            ...(context.actionId ? { actionId: context.actionId } : {}),
          },
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT") {
          return { text: "客户资料刚在其他端被修改，本次未删除。请重新发送删除指令查看最新资料。", status: "conflict" };
        }
        if (error?.code === "NOT_FOUND") {
          return { text: "客户不存在或已删除，未执行任何操作。", status: "not_found" };
        }
        throw error;
      }
      return {
        text: `已删除（归档）：${deleted.name}。原关联商机已随档案隐藏；如需恢复请联系管理员。`,
        status: "deleted",
        customer: deleted,
        contextUpdate: {
          customerId: null,
          opportunityId: null,
          source: "verified_entity",
          sourceRefs: [{ type: "customer", id: deleted.id }],
        },
      };
    },

    async "opportunity.detail"(args, context) {
      const result = await opportunityAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "detail",
        opportunityId: args.opportunityId,
        query: args.opportunityId,
      });
      if (result.status === "clarify") return {
        ...ambiguousEntityResult("商机", result.matches),
        opportunityResult: result,
        runId: result.runId,
      };
      if (result.status === "review_required" && !result.opportunity) return {
        text: "商机与关联客户无法核验，请先在系统中确认关系。",
        status: "review_required",
        opportunityResult: result,
        runId: result.runId,
      };
      if (result.status === "not_found" || !result.opportunity) return {
        text: "未找到该商机，或当前账号无权查看。",
        status: "not_found",
        opportunityResult: result,
        runId: result.runId,
      };
      const opportunity = result.opportunity;
      return {
        text: [
          `商机：${opportunity.name ?? "名称待确认"}`,
          `阶段：${opportunity.stage ?? "待确认"}`,
          `金额：${opportunity.amount ?? "待确认"}`,
          `成交概率：${opportunity.probability === null ? "待确认" : `${opportunity.probability}%`}`,
          `下一步：${opportunity.next ?? "待补充"}`,
        ].join("\n"),
        status: "ok",
        opportunity,
        opportunityResult: result,
        runId: result.runId,
        contextUpdate: {
          customerId: opportunity.customerId ?? null,
          opportunityId: opportunity.id,
          source: "verified_entity",
          sourceRefs: [
            ...(opportunity.customerId ? [{ type: "customer", id: opportunity.customerId }] : []),
            { type: "opportunity", id: opportunity.id },
          ],
        },
      };
    },

    async "sales-decision.preview"(args, context) {
      if (salesLoopPreviewService) {
        let opportunityId = safeText(args.opportunityId);
        if (opportunityId && !snapshotAdapter.opportunityDetail({ owner: context.owner, opportunityId })) {
          const matches = snapshotAdapter.opportunitySearch({ owner: context.owner, query: opportunityId }).items;
          if (matches.length > 1) return ambiguousEntityResult("商机", matches);
          opportunityId = matches[0]?.id ?? opportunityId;
        }
        const result = await salesLoopPreviewService.previewSalesDecision({
          owner: context.owner,
          channel: context.channel,
          conversationId: context.conversation,
          eventId: context.event,
          ...(opportunityId ? { opportunityId } : {}),
        });
        if (result.status !== "preview") {
          return { ...result, text: salesLoopStatusText(result, "请先指定一个客户或商机。") };
        }
        return {
          text: salesDecisionPreviewText(result),
          status: "preview",
          analysis: result.analysis,
          salesDecision: result,
          sourceRefs: result.sourceRefs,
          contextUpdate: {
            customerId: result.context?.customerId ?? null,
            opportunityId: result.context?.opportunityId ?? null,
            source: "analysis",
            sourceRefs: result.sourceRefs,
          },
        };
      }
      let opportunityId = args.opportunityId;
      if (!snapshotAdapter.opportunityDetail({ owner: context.owner, opportunityId })) {
        const matches = snapshotAdapter.opportunitySearch({ owner: context.owner, query: opportunityId }).items;
        if (matches.length > 1) return ambiguousEntityResult("商机", matches);
        opportunityId = matches[0]?.id ?? opportunityId;
      }
      const analysis = snapshotAdapter.projectAnalysis({
        owner: context.owner,
        opportunityId,
      });
      if (!analysis) return { text: "未找到该项目，或当前账号无权分析。", status: "not_found" };
      return { text: projectAnalysisText(analysis), status: "preview", analysis };
    },

    async "action-risk.summary"(args, context) {
      const result = await actionRiskAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "summary",
        customerId: args.customerId,
        opportunityId: args.opportunityId,
      });
      const summary = {
        actions: result.actions,
        risks: result.risks,
        truncated: result.truncated,
      };
      return {
        text: [
          `动作风险摘要：未完成动作 ${summary.actions.length} 项，活跃风险 ${summary.risks.length} 项。`,
          ...summary.actions.slice(0, 3).map((item) => `- 动作：${item.title ?? "待补充"}${item.due ? `（截止 ${item.due}）` : ""}`),
          ...summary.risks.slice(0, 3).map((item) => `- 风险：${item.title ?? "待补充"}（${item.severity ?? "等级待确认"}）`),
        ].join("\n"),
        status: "ok",
        summary,
        actionRiskResult: result,
        runId: result.runId,
      };
    },

    async "itinerary.summary"(_args, context) {
      const result = await itineraryAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "summary",
      });
      const summary = { items: result.items, truncated: result.truncated };
      return {
        text: summary.items.length
          ? [`行程摘要：共 ${summary.items.length} 条。`, ...summary.items.slice(0, 5).map((item) => `- ${item.visitDate} ${item.title ?? "未命名行程"}（${item.status}）`)].join("\n")
          : "当前没有可见行程。",
        status: "ok",
        summary,
        itineraryResult: result,
        runId: result.runId,
      };
    },

    async "travel-expense.summary"(args, context) {
      const summary = snapshotAdapter.travelExpenseSummary({
        owner: context.owner,
        weekStart: args.periodStart ?? args.week,
      });
      return {
        text: expenseSummaryText(summary, "差旅汇总"),
        status: "ok",
        summary,
      };
    },

    async "knowledge.search"(args, context) {
      const result = await knowledgeAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "search",
        query: args.query,
      });
      return {
        text: result.items.length
          ? [`知识检索结果：${result.items.length} 条。`, ...result.items.map((item) => `- ${item.title}：${item.summary ?? "暂无摘要"}（来源：${item.source ?? "待确认"}）`)].join("\n")
          : `未找到相关知识：${safeText(args.query)}`,
        status: "ok",
        items: result.items,
        knowledgeResult: result,
        runId: result.runId,
      };
    },

    async "visit-capture.collect"(args, context) {
      const { parts } = draftParts(sessionRepository, context);
      return {
        text: `已暂存 ${parts.filter((part) => part.role === "user" && !isControlMessage(safeText(part.text))).length} 条拜访内容，可继续补充；整理完成后发送“记录”。`,
        status: "drafted",
      };
    },

    async "visit-capture.preview"(_args, context) {
      const content = draftText(sessionRepository, context);
      if (!content) return { text: "当前没有暂存内容，请先发送拜访、电话或会议内容。", status: "empty" };
      const analysis = await visitCaptureAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "preview",
        rawContent: content,
        sourceChannel: "微信助手",
        // The session primary key is an internal implementation detail; it is
        // deliberately not exposed as an evidence/source reference.
        draftId: null,
        businessContext: context.businessContext,
      });
      return { text: previewText(analysis), status: analysis.status, analysis, runId: analysis.runId };
    },

    async "visit-capture.confirm"(_args, context) {
      const actionId = safeText(context.actionId);
      if (actionId) {
        const existingRow = db.prepare(
          "SELECT * FROM quick_records WHERE id = $id AND owner = $owner",
        ).get({ $id: actionId, $owner: context.owner });
        if (existingRow) {
          const existing = quickRecordFromRow(existingRow);
          const insight = insightFromRow(db.prepare(`
            SELECT * FROM ai_insights
            WHERE quick_record_id = $quickRecordId
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).get({ $quickRecordId: existing.id }));
          try {
            const conversation = conversationRecord(sessionRepository, context);
            sessionRepository.clearDraftParts?.(conversation.id);
          } catch {
            // Recovery remains idempotent even if draft cleanup is retried later.
          }
          return {
            text: `已录入系统，记录 ID：${existing.id}\nAI 分析已保存，可在系统内人工确认客户、商机和行动。`,
            status: "recorded",
            record: existing,
            insight,
          };
        }
      }
      const content = draftText(sessionRepository, context);
      if (!content) return { text: "当前没有待录入内容，请先发送记录内容。", status: "empty" };
      const now = clock();
      const occurredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const reusableRun = reusableVisitRun(agentRunRepository, context, content);
      const analysis = await visitCaptureAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.actionId ? `assistant-action:${context.actionId}` : context.event,
        taskType: "capture",
        rawContent: content,
        sourceChannel: "微信助手",
        draftId: null,
        businessContext: context.businessContext,
        reusableRun,
      });
      const links = resolveQuickRecordLinks(snapshotAdapter, context.owner, analysis);
      const persisted = withImmediateTransaction(db, () => {
        const recordId = actionId || randomUUID();
        db.prepare(`
          INSERT INTO quick_records (id, raw_content, occurred_at, source_channel, customer_id, opportunity_id)
          VALUES ($id, $rawContent, $occurredAt, '微信助手', $customerId, $opportunityId)
        `).run({
          $id: recordId,
          $rawContent: content,
          $occurredAt: occurredAt,
          $customerId: links.customerId,
          $opportunityId: links.opportunityId,
        });
        db.prepare("UPDATE quick_records SET owner = $owner WHERE id = $id")
          .run({ $id: recordId, $owner: context.owner });
        const created = quickRecordFromRow(db.prepare("SELECT * FROM quick_records WHERE id = $id").get({ $id: recordId }));
        insertAudit(db, {
          action: "quick_record.create",
          entityType: "quick_record",
          entityId: recordId,
          actor: context.owner,
          requestId: context.requestId,
          before: null,
          after: created,
          entityVersion: created.version,
          metadata: {
            sourceChannel: created.sourceChannel,
            customerId: created.customerId,
            opportunityId: created.opportunityId,
          },
        });
        const id = randomUUID();
        db.prepare(`
          INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
          VALUES ($id, $quickRecordId, $source, $confidence, $analysisJson)
        `).run({
          $id: id,
          $quickRecordId: created.id,
          $source: analysis?.source ?? "mock",
          $confidence: analysis?.confidence ?? 70,
          $analysisJson: JSON.stringify(analysis ?? {}),
        });
        db.prepare("UPDATE quick_records SET status = 'analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = $id")
          .run({ $id: created.id });
        const updated = quickRecordFromRow(db.prepare("SELECT * FROM quick_records WHERE id = $id").get({ $id: created.id }));
        insertAudit(db, {
          action: "quick_record.analyze",
          entityType: "quick_record",
          entityId: created.id,
          actor: context.owner,
          requestId: context.requestId,
          before: { status: created.status },
          after: { status: updated.status },
          entityVersion: updated.version,
          metadata: { source: analysis?.source ?? "mock" },
        });
        return {
          record: updated,
          insight: insightFromRow(db.prepare("SELECT * FROM ai_insights WHERE id = $id").get({ $id: id })),
        };
      });
      try {
        const conversation = conversationRecord(sessionRepository, context);
        sessionRepository.clearDraftParts?.(conversation.id);
      } catch {
        // A completed business record remains valid even if draft cleanup is retried later.
      }
      return {
        text: `已录入系统，记录 ID：${persisted.record.id}\nAI 分析已保存，可在系统内人工确认客户、商机和行动。`,
        status: "recorded",
        record: persisted.record,
        insight: persisted.insight,
      };
    },

    async "visit-capture.capture"(args, context) {
      const actionId = safeText(context.actionId);
      const recordId = actionId || randomUUID();
      const existingRow = db.prepare(
        "SELECT * FROM quick_records WHERE id = $id AND owner = $owner",
      ).get({ $id: recordId, $owner: context.owner });
      if (existingRow) {
        const existing = quickRecordFromRow(existingRow);
        const insight = insightFromRow(db.prepare(`
          SELECT * FROM ai_insights
          WHERE quick_record_id = $quickRecordId
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get({ $quickRecordId: existing.id }));
        return {
          text: quickCaptureReceipt(existing, insight, db),
          status: "recorded",
          record: existing,
          insight,
          replayed: true,
        };
      }
      const content = safeText(args.rawContent);
      if (!content) return { text: "请把拜访、电话或会议内容跟在“记一下：”后面一起发我。", status: "empty" };
      const now = clock();
      const requestedOccurredAt = safeText(args.occurredAt);
      const occurredAt = requestedOccurredAt && Number.isFinite(Date.parse(requestedOccurredAt))
        ? new Date(requestedOccurredAt).toISOString()
        : (now instanceof Date ? now.toISOString() : new Date(now).toISOString());
      // The affirm preview provider already produced an agent run for this
      // conversation and raw content; reuse it so confirmation does not pay a
      // second model call. A miss falls back to a fresh (fallback-capable)
      // analysis inside the adapter.
      const reusableRun = reusableVisitRun(agentRunRepository, context, content);
      const analysis = await visitCaptureAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.actionId ? `assistant-action:${context.actionId}` : context.event,
        taskType: "capture",
        rawContent: content,
        occurredAt,
        sourceChannel: "微信助手",
        draftId: null,
        businessContext: context.businessContext,
        reusableRun,
      });
      const links = resolveQuickRecordLinks(snapshotAdapter, context.owner, analysis);
      const persisted = withImmediateTransaction(db, () => {
        db.prepare(`
          INSERT INTO quick_records (id, raw_content, occurred_at, source_channel, customer_id, opportunity_id)
          VALUES ($id, $rawContent, $occurredAt, '微信助手', $customerId, $opportunityId)
        `).run({
          $id: recordId,
          $rawContent: content,
          $occurredAt: occurredAt,
          $customerId: links.customerId,
          $opportunityId: links.opportunityId,
        });
        db.prepare("UPDATE quick_records SET owner = $owner WHERE id = $id")
          .run({ $id: recordId, $owner: context.owner });
        const created = quickRecordFromRow(db.prepare("SELECT * FROM quick_records WHERE id = $id").get({ $id: recordId }));
        insertAudit(db, {
          action: "quick_record.create",
          entityType: "quick_record",
          entityId: recordId,
          actor: context.owner,
          requestId: context.requestId,
          before: null,
          after: created,
          entityVersion: created.version,
          metadata: {
            sourceChannel: created.sourceChannel,
            customerId: created.customerId,
            opportunityId: created.opportunityId,
            source: "weixin-assistant",
            ...(context.actionId ? { actionId: context.actionId } : {}),
          },
        });
        const insightId = randomUUID();
        db.prepare(`
          INSERT INTO ai_insights (id, quick_record_id, source, confidence, analysis_json)
          VALUES ($id, $quickRecordId, $source, $confidence, $analysisJson)
        `).run({
          $id: insightId,
          $quickRecordId: created.id,
          $source: analysis?.source ?? "mock",
          $confidence: analysis?.confidence ?? 70,
          $analysisJson: JSON.stringify(analysis ?? {}),
        });
        db.prepare("UPDATE quick_records SET status = 'analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = $id")
          .run({ $id: created.id });
        const updated = quickRecordFromRow(db.prepare("SELECT * FROM quick_records WHERE id = $id").get({ $id: created.id }));
        insertAudit(db, {
          action: "quick_record.analyze",
          entityType: "quick_record",
          entityId: created.id,
          actor: context.owner,
          requestId: context.requestId,
          before: { status: created.status },
          after: { status: updated.status },
          entityVersion: updated.version,
          metadata: {
            source: analysis?.source ?? "mock",
            captureSource: "weixin-assistant",
            ...(context.actionId ? { actionId: context.actionId } : {}),
          },
        });
        return {
          record: updated,
          insight: insightFromRow(db.prepare("SELECT * FROM ai_insights WHERE id = $id").get({ $id: insightId })),
        };
      });
      return {
        text: quickCaptureReceipt(persisted.record, persisted.insight, db),
        status: "recorded",
        record: persisted.record,
        insight: persisted.insight,
        ...(persisted.record.customerId
          ? {
            contextUpdate: {
              customerId: persisted.record.customerId,
              opportunityId: persisted.record.opportunityId ?? null,
              source: "verified_entity",
              sourceRefs: [{ type: "quick_record", id: persisted.record.id }],
            },
          }
          : {}),
      };
    },

    async "visit-capture.search"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，无法查询记录。", status: "denied" };
      }
      const query = safeText(args.query) || null;
      const dateStart = safeText(args.dateStart) || null;
      const dateEnd = safeText(args.dateEnd) || null;
      const { items, truncated } = recordStore.search({
        owner: businessOwner,
        query,
        dateStart,
        dateEnd,
        limit: 5,
      });
      const rangeLabel = dateStart && dateEnd ? `${dateStart} ~ ${dateEnd}` : "近期";
      if (items.length === 0) {
        return {
          text: `${rangeLabel}没有找到${query ? `与“${query}”相关的` : ""}记录。可发送“最近的记录”查看全部。`,
          status: "ok",
          items: [],
          truncated: false,
        };
      }
      const statusLabels = { recorded: "待分析", analyzed: "已分析", confirmed: "已确认" };
      const lines = [
        `找到 ${items.length}${truncated ? "+" : ""} 条记录（${rangeLabel}${query ? `，关键词：${query}` : ""}）：`,
        ...items.map((item, index) => {
          const date = (item.occurredAt ?? item.createdAt ?? "").slice(5, 10) || "日期待确认";
          const customer = item.customerName ?? "（未挂客户）";
          const excerptText = String(item.rawContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 60);
          return `${index + 1}. ${date} ${customer} ｜ ${statusLabels[item.status] ?? item.status} ｜ …${item.id.slice(-6)}\n   ${excerptText}`;
        }),
        ...(truncated ? ["还有更多记录未展示，请补充客户名或缩小时间范围。"] : []),
        "发送“把记录 <编号后6位> 的下一步改成…”可修改；“作废记录 <编号后6位>”可作废。",
      ];
      const onlyCustomerId = items.length === 1 ? items[0].customerId : null;
      return {
        text: lines.join("\n"),
        status: "ok",
        items,
        truncated,
        ...(onlyCustomerId
          ? {
            contextUpdate: {
              customerId: onlyCustomerId,
              opportunityId: items[0].opportunityId ?? null,
              source: "verified_entity",
              sourceRefs: [{ type: "quick_record", id: items[0].id }],
            },
          }
          : {}),
      };
    },

    async "visit-capture.update"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，未修改记录。", status: "denied" };
      }
      const quickRecordId = safeText(args.quickRecordId);
      const expectedVersion = Number(args.expectedVersion);
      const changes = args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)
        ? args.changes
        : null;
      if (!quickRecordId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !changes) {
        return { text: "修改请求不完整，请重新发送修改指令。", status: "error" };
      }
      const summaryPatch = changes.summaryPatch && typeof changes.summaryPatch === "object" && !Array.isArray(changes.summaryPatch)
        ? changes.summaryPatch
        : null;
      const fields = changes.fields && typeof changes.fields === "object" && !Array.isArray(changes.fields)
        ? changes.fields
        : null;
      if (!summaryPatch && !fields) {
        return { text: "修改请求不完整，请重新发送修改指令。", status: "error" };
      }
      const changedParts = [];
      let result = null;
      try {
        result = withImmediateTransaction(db, () => {
          let current = null;
          if (summaryPatch) {
            const updated = recordStore.updateInsightSummary({
              owner: businessOwner,
              id: quickRecordId,
              expectedVersion,
              summaryPatch,
            });
            insertAudit(db, {
              action: "quick_record.analysis.update",
              entityType: "quick_record",
              entityId: updated.record.id,
              actor: context.owner,
              requestId: context.requestId,
              before: { quickRecord: updated.beforeRecord, analysis: updated.beforeAnalysis },
              after: { quickRecord: updated.record, analysis: updated.analysis },
              entityVersion: updated.record.version,
              metadata: {
                insightId: updated.analysis.id,
                summaryFields: Object.keys(summaryPatch),
                source: "weixin-assistant",
                ...(context.actionId ? { actionId: context.actionId } : {}),
              },
            });
            const summaryLabels = { request: "诉求", feedback: "反馈", risk: "风险", action: "建议动作" };
            changedParts.push(...Object.keys(summaryPatch).map((key) => `${summaryLabels[key] ?? key}已修改`));
            current = { record: updated.record, analysis: updated.analysis };
          }
          if (fields) {
            const fieldVersion = current ? current.record.version : expectedVersion;
            const updated = recordStore.updateFields({
              owner: businessOwner,
              id: quickRecordId,
              expectedVersion: fieldVersion,
              ...(Object.hasOwn(fields, "occurredAt") ? { occurredAt: fields.occurredAt } : {}),
              ...(Object.hasOwn(fields, "customerId") ? { customerId: fields.customerId } : {}),
              ...(Object.hasOwn(fields, "opportunityId") ? { opportunityId: fields.opportunityId } : {}),
            });
            insertAudit(db, {
              action: "quick_record.update",
              entityType: "quick_record",
              entityId: updated.after.id,
              actor: context.owner,
              requestId: context.requestId,
              before: updated.before,
              after: updated.after,
              entityVersion: updated.after.version,
              metadata: {
                changedFields: Object.keys(fields),
                source: "weixin-assistant",
                ...(context.actionId ? { actionId: context.actionId } : {}),
              },
            });
            const fieldLabels = { occurredAt: "发生时间", customerId: "挂接客户", opportunityId: "挂接商机" };
            changedParts.push(...Object.keys(fields).map((key) => `${fieldLabels[key] ?? key}已修改`));
            current = { ...(current ?? {}), record: updated.after };
          }
          return current;
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT") {
          return { text: "这条记录刚在其他端被修改，本次未写入。请重新发起修改。", status: "conflict" };
        }
        if (error?.code === "NOT_FOUND") {
          return { text: "记录不存在或已作废，未修改。", status: "not_found" };
        }
        if (error?.code === "QUICK_RECORD_RELATIONSHIP_INVALID") {
          return { text: "客户与商机的关系已变化，本次未写入。请重新发起修改。", status: "conflict" };
        }
        throw error;
      }
      return {
        text: [
          `已更新记录 …${result.record.id.slice(-6)}（v${result.record.version}）：${changedParts.join("；")}。`,
          "注意：已进入周报草稿或已确认写回的内容不会自动回改。",
        ].join("\n"),
        status: "updated",
        record: result.record,
        ...(result.analysis ? { analysis: result.analysis } : {}),
      };
    },

    async "visit-capture.void"(args, context) {
      const businessOwner = resolveBusinessOwner(context.owner);
      if (typeof businessOwner !== "string" || !businessOwner.trim()) {
        return { text: "当前账号未绑定业务负责人，未作废记录。", status: "denied" };
      }
      const quickRecordId = safeText(args.quickRecordId);
      const expectedVersion = Number(args.expectedVersion);
      if (!quickRecordId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return { text: "作废请求不完整，请重新发送作废指令。", status: "error" };
      }
      let voided;
      try {
        voided = withImmediateTransaction(db, () => {
          const outcome = recordStore.void({
            owner: businessOwner,
            id: quickRecordId,
            expectedVersion,
            voidedBy: context.owner,
            reason: "weixin-assistant-void",
          });
          insertAudit(db, {
            action: "quick_record.void",
            entityType: "quick_record",
            entityId: outcome.after.id,
            actor: context.owner,
            requestId: context.requestId,
            before: outcome.before,
            after: outcome.after,
            entityVersion: outcome.after.version,
            metadata: {
              reason: "weixin-assistant-void",
              previousStatus: outcome.before.status,
              wasConfirmed: outcome.before.status === "confirmed",
              source: "weixin-assistant",
              ...(context.actionId ? { actionId: context.actionId } : {}),
            },
          });
          return outcome;
        });
      } catch (error) {
        if (error?.code === "VERSION_CONFLICT") {
          return { text: "这条记录刚在其他端被修改，本次未作废。请重新发起作废。", status: "conflict" };
        }
        if (error?.code === "NOT_FOUND") {
          return { text: "记录不存在或已作废，未执行任何操作。", status: "not_found" };
        }
        throw error;
      }
      return {
        text: [
          `已作废记录 …${voided.after.id.slice(-6)}。该记录不再出现在记录列表、周报素材与项目分析中。`,
          "已确认写回客户/商机的内容不会回退；如需恢复请联系管理员。",
        ].join("\n"),
        status: "voided",
        record: voided.after,
      };
    },

    async "customer.search"(args, context) {
      const query = safeText(args.query);
      const result = await customerAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "search",
        query: query || "客户",
      });
      const items = result.matches ?? [];
      const truncated = result.truncated === true;
      const text = items.length === 0
        ? `未找到客户：${query || "（未提供关键词）"}`
        : [
          `找到 ${items.length}${truncated ? "+" : ""} 个客户：`,
          ...items.map((item) => `- ${item.name ?? "名称待确认"} [${item.id}] / ${item.region ?? "-"}`),
        ].join("\n");
      return {
        text,
        status: "ok",
        items,
        truncated,
        customerResult: result,
        runId: result.runId,
      };
    },

    async "invoice.ingest"(args, context, serverData) {
      const media = serverData.media;
      if (!media || media.sourceRef !== args.mediaRef) return { text: "请把发票图片或 PDF 与命令一起发送。", status: "empty" };
      if (context.channel === "weixin" && serverData.auditMetadata?.financialScope !== true) {
        return { text: FINANCIAL_SCOPE_DENIED, status: "denied" };
      }
      const content = mediaBuffer(media);
      let recognition;
      try {
        recognition = boundedRecognition(await invoiceRecognizer({
          fileName: media.fileName,
          mediaType: media.mediaType,
          buffer: content,
        }));
      } catch {
        recognition = { status: "review_required", extractedText: null, warnings: ["RECOGNITION_FAILED"], conflicts: [], fields: {} };
      }
      let item;
      let duplicate = false;
      try {
        item = await withDocumentBlobWritePreflight(db, {
          owner: context.owner,
          content,
        }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
          const created = invoiceRepository.createInvoice({
            owner: context.owner,
            actor: context.owner,
            source: "weixin",
            sourceRef: media.sourceRef,
            fileName: media.fileName,
            mediaType: media.mediaType,
            content,
            encodedDocumentBlob,
            recognition,
          });
          insertAudit(db, {
            action: "invoice.create",
            entityType: "invoice",
            entityId: created.id,
            actor: context.owner,
            requestId: context.requestId,
            before: null,
            after: { id: created.id, status: created.status, sizeBytes: created.sizeBytes, sha256: created.sha256 },
            entityVersion: created.version,
            metadata: { source: "weixin", mediaType: created.mediaType },
          });
          return created;
        }));
      } catch (error) {
        if (error?.code === "DUPLICATE_INVOICE") {
          item = invoiceRepository.getInvoice(error.existingInvoiceId, { owner: context.owner });
          if (!item) throw error;
          duplicate = true;
        } else {
          throw error;
        }
      }
      let match = null;
      if (typeof invoiceRepository.autoMatchInvoice === "function") {
        try {
          match = invoiceRepository.autoMatchInvoice({
            owner: context.owner,
            actor: context.owner,
            invoiceId: item.id,
            priorityWeekStart: shanghaiWeekStart(clock()),
          });
          if (match?.status === "matched" && match.invoice) item = match.invoice;
        } catch {
          match = { status: "review_required", reason: "automatic_match_failed", candidates: [] };
        }
      }
      if (match?.status === "matched") {
        const confirmedMatches = invoiceRepository.listMatches({
          owner: context.owner,
          invoiceId: item.id,
          state: "confirmed",
        });
        const activeMatch = match.match ?? confirmedMatches[0] ?? null;
        const reconciliation = reconcileWeixinInvoiceAttachments({
          db,
          invoiceRepository,
          travelExpenseRepository,
          owner: context.owner,
          actor: context.owner,
          invoiceId: item.id,
          requestIdPrefix: context.requestId ?? "weixin-invoice",
        });
        const attachmentResult = activeMatch
          ? reconciliation.find((result) => result.matchId === activeMatch.id) ?? null
          : null;
        const expenseAttachment = attachmentResult?.attachment ?? null;
        const attachmentPending = reconciliation.some((result) => result.status === "pending");
        return {
          text: attachmentPending
            ? `发票金额已自动匹配费用：${match.selected?.expenseReferenceCode ?? activeMatch?.expenseId ?? "待确认"}，但报销附件正在后台补传。`
            : `发票${duplicate ? "已存在并" : "已存入并"}自动绑定费用：${match.selected?.expenseReferenceCode ?? activeMatch?.expenseId ?? "待确认"}，金额 ${moneyFromCents(activeMatch?.allocatedCents)}。`,
          status: attachmentPending ? "review_required" : "matched",
          item,
          match: { ...match, match: activeMatch },
          attachmentStatus: attachmentPending ? "pending" : expenseAttachment ? "attached" : "already_attached",
          attachmentReconciliation: reconciliation,
          ...(expenseAttachment ? { expenseAttachment } : {}),
        };
      }
      const candidateText = Array.isArray(match?.candidates) && match.candidates.length
        ? `候选：${match.candidates.slice(0, 3).map((candidate) => `${candidate.expenseReferenceCode}（${candidate.occurredOn}，${moneyFromCents(candidate.paymentRemainingCents)}）`).join("；")}`
        : "当前没有唯一金额候选";
      return {
        text: `发票${duplicate ? "已在" : "已存入"}发票仓库，编号：${item.id}。${candidateText}。当前未形成唯一自动匹配，请在系统内人工复核。`,
        status: duplicate ? "duplicate" : "review_required",
        item,
        match,
      };
    },

    async "payment-proof.ingest"(args, context, serverData) {
      const media = serverData.media;
      if (!media || media.sourceRef !== args.mediaRef) return { text: "请把付款截图或 PDF 与命令一起发送。", status: "empty" };
      const content = mediaBuffer(media);
      let recognition;
      try {
        recognition = boundedRecognition(await paymentProofRecognizer({
          fileName: media.fileName,
          mediaType: media.mediaType,
          buffer: content,
        }));
      } catch {
        recognition = { evidence: null, candidates: [], warnings: ["RECOGNITION_FAILED"] };
      }
      const candidates = Array.isArray(recognition?.candidates) ? recognition.candidates.slice(0, 10) : [];
      let item;
      try {
        item = await withDocumentBlobWritePreflight(db, {
          owner: context.owner,
          content,
        }, (encodedDocumentBlob) => withImmediateTransaction(db, () => {
          const created = travelExpenseDocumentInboxRepository.createDocument({
            owner: context.owner,
            actor: context.owner,
            source: "weixin",
            sourceRef: media.sourceRef,
            documentKind: "payment_proof",
            fileName: media.fileName,
            mediaType: media.mediaType,
            content,
            encodedDocumentBlob,
            status: "review_required",
            extractedText: recognition?.extractedText ?? null,
            recognition: { ...recognition, candidates },
            errorCode: recognition?.warnings?.[0] ?? null,
          });
          insertAudit(db, {
            action: "travel_expense_document_inbox.create",
            entityType: "travel_expense_document_inbox",
            entityId: created.id,
            actor: context.owner,
            requestId: context.requestId,
            before: null,
            after: { id: created.id, status: created.status, sizeBytes: created.sizeBytes, sha256: created.sha256 },
            entityVersion: created.version,
            metadata: { source: "weixin", candidateCount: candidates.length },
          });
          return created;
        }));
      } catch (error) {
        if (error?.code === "DUPLICATE_DOCUMENT") {
          return { text: "这张付款凭证已经在待处理区，无需重复上传。", status: "duplicate" };
        }
        throw error;
      }
      return { text: `付款凭证已上传到待处理区，候选付款 ${candidates.length} 笔，请在系统内人工确认关联。`, status: "received", item };
    },

    async "reimbursement-report.preview"(args, context) {
      const summary = snapshotAdapter.travelExpenseSummary({
        owner: context.owner,
        weekStart: args.periodStart ?? args.week,
      });
      const preparation = summary.preparation?.ready
        ? "确认前准备：金额与票据状态完整。"
        : `确认前待处理：${(summary.preparation?.blockers ?? []).join("、") || "资料不完整"}。`;
      return {
        text: `${expenseSummaryText(summary, "报销周汇总预览")}\n${preparation}`,
        status: "preview",
        summary,
      };
    },

    async "advance-settlement.preview"(args, context, serverData = {}) {
      if (context.channel === "weixin" && serverData.auditMetadata?.financialScope !== true) {
        throw new HttpError(403, "ASSISTANT_FINANCIAL_SCOPE_DENIED", FINANCIAL_SCOPE_DENIED);
      }
      const result = await advanceSettlementAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "settlement_preview",
        weekStart: args.week ?? args.periodStart ?? null,
      });
      return {
        text: settlementPreviewText(result),
        status: result.status,
        settlementPreview: result.settlementPreview,
        summary: {
          weekStart: result.weekStart,
          summary: result.summary,
          settlementEvidence: result.settlementEvidence,
          truncated: result.truncated,
        },
        settlementResult: result,
        runId: result.runId,
      };
    },

    async "sales-report.preview"(args, context) {
      if (!salesReportAdapter) {
        const summary = snapshotAdapter.salesReportSummary({
          owner: context.owner,
          weekStart: args.periodStart ?? args.week,
        });
        return { text: salesReportSummaryText(summary), status: "preview", summary };
      }
      const result = await salesReportAdapter.analyze({
        owner: context.owner,
        channel: context.channel,
        conversationId: context.conversation,
        eventId: context.event,
        taskType: "weekly_preview",
        weekStart: args.periodStart ?? args.week,
        periodStart: args.periodStart ?? null,
        periodEnd: args.periodEnd ?? null,
      });
      if (result.status !== "preview") {
        return {
          text: result.status === "not_found" ? "未找到当前账号可见的销售周报数据。" : "销售周报暂需人工补充资料。",
          status: result.status,
          report: result,
        };
      }
      return {
        text: salesReportSummaryText({
          weekStart: result.period.start,
          periodEnd: result.period.end,
          reportCount: result.persistedReportRefs?.length ?? 0,
          candidateRecordCount: result.candidateRecordCount ?? result.sourceRecordCount ?? 0,
          preview: result.summary,
          statusCounts: result.statusCounts ?? { draft: 0, saved: 0, ready: 0 },
        }),
        status: "preview",
        summary: result.summary,
        report: result,
        runId: result.runId,
      };
    },
  };

  return Object.freeze(handlers);
}
