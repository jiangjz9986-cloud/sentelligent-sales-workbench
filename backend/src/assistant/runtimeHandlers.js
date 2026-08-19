import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { decodeCanonicalBase64 } from "../http/strictBase64.js";
import { withDocumentBlobWritePreflight } from "../travelExpense/documentBlobStore.js";
import { createAssistantBusinessSnapshotAdapter } from "./businessSnapshotAdapter.js";
import { createCustomerAssistantAdapter } from "./customerAssistantAdapter.js";
import { createSalesReportAssistantAdapter } from "./salesReportAssistantAdapter.js";
import { createVisitCaptureAssistantAdapter } from "./visitCaptureAssistantAdapter.js";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

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

function moneyFromCents(value) {
  return Number.isSafeInteger(value) && value >= 0 ? `${(value / 100).toFixed(2)} 元` : "金额待确认";
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
    "销售决策预览（sales-decision-v1，未写回）：",
    `判断：${decision.code ?? "待确认"}（置信度 ${Number.isSafeInteger(decision.confidence) ? decision.confidence : "待确认"}）`,
    `阶段：当前 ${stage.current ?? "待确认"}，建议 ${stage.recommended ?? "待确认"}${stage.gatePassed === true ? "（阶段门槛已满足）" : "（阶段门槛未满足）"}`,
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
  invoiceRepository,
  paymentProofRecognizer,
  invoiceRecognizer,
  businessSnapshotAdapter = null,
  customerAssistantAdapter = null,
  visitCaptureAssistantAdapter = null,
  salesReportAssistantAdapter = null,
  agentRunRepository = null,
  salesLoopPreviewService = null,
  resolveBusinessOwner = (owner) => owner,
  clock = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!db || !sessionRepository) throw new TypeError("assistant runtime dependencies are required");
  const snapshotAdapter = businessSnapshotAdapter ?? createAssistantBusinessSnapshotAdapter({ db, clock, resolveBusinessOwner });
  const customerAdapter = customerAssistantAdapter ?? createCustomerAssistantAdapter({
    snapshotAdapter,
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
  const salesReportAdapter = salesReportAssistantAdapter ?? createSalesReportAssistantAdapter({
    config,
    fetchImpl,
    runRepository: agentRunRepository,
    clock,
    snapshotProvider: ({ owner, weekStart, periodStart, periodEnd, knowledgeQuery }) => {
      if (!salesLoopPreviewService || typeof salesLoopPreviewService.buildSalesReportSnapshot !== "function") {
        return { status: "owner_scope_denied", period: { start: weekStart, end: weekStart } };
      }
      return salesLoopPreviewService.buildSalesReportSnapshot({ owner, weekStart, periodStart, periodEnd, knowledgeQuery });
    },
  });

  const handlers = {
    async "dashboard.summary"(_args, context) {
      const summary = snapshotAdapter.dashboardSummary({ owner: context.owner });
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
      return {
        text: [
          `客户：${customer.name ?? "名称待确认"}`,
          `区域：${customer.region ?? "待确认"}`,
          `类型：${customer.type ?? "待确认"}`,
          `级别：${customer.level ?? "待确认"}`,
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

    async "opportunity.detail"(args, context) {
      let opportunity = snapshotAdapter.opportunityDetail({
        owner: context.owner,
        opportunityId: args.opportunityId,
      });
      if (!opportunity) {
        const matches = snapshotAdapter.opportunitySearch({ owner: context.owner, query: args.opportunityId }).items;
        if (matches.length > 1) return ambiguousEntityResult("商机", matches);
        opportunity = matches[0] ?? null;
      }
      if (!opportunity) return { text: "未找到该商机，或当前账号无权查看。", status: "not_found" };
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
      const summary = snapshotAdapter.actionRiskSummary({
        owner: context.owner,
        customerId: args.customerId,
        opportunityId: args.opportunityId,
      });
      return {
        text: [
          `动作风险摘要：未完成动作 ${summary.actions.length} 项，活跃风险 ${summary.risks.length} 项。`,
          ...summary.actions.slice(0, 3).map((item) => `- 动作：${item.title ?? "待补充"}${item.due ? `（截止 ${item.due}）` : ""}`),
          ...summary.risks.slice(0, 3).map((item) => `- 风险：${item.title ?? "待补充"}（${item.severity ?? "等级待确认"}）`),
        ].join("\n"),
        status: "ok",
        summary,
      };
    },

    async "itinerary.summary"(_args, context) {
      const summary = snapshotAdapter.itinerarySummary({ owner: context.owner });
      return {
        text: summary.items.length
          ? [`行程摘要：共 ${summary.items.length} 条。`, ...summary.items.slice(0, 5).map((item) => `- ${item.visitDate} ${item.title ?? "未命名行程"}（${item.status}）`)].join("\n")
          : "当前没有可见行程。",
        status: "ok",
        summary,
      };
    },

    async "travel-expense.summary"(args, context) {
      const summary = snapshotAdapter.travelExpenseSummary({
        owner: context.owner,
        weekStart: args.periodStart ?? args.week,
      });
      return {
        text: `差旅汇总（${summary.weekStart}）：${summary.summary.count} 笔，实付 ${moneyFromCents(summary.summary.actualPaidCents)}，可报销 ${moneyFromCents(summary.summary.reimbursementCents)}。`,
        status: "ok",
        summary,
      };
    },

    async "knowledge.search"(args) {
      const result = snapshotAdapter.knowledgeSearch({ query: args.query });
      return {
        text: result.items.length
          ? [`知识检索结果：${result.items.length} 条。`, ...result.items.map((item) => `- ${item.title}：${item.summary ?? "暂无摘要"}（来源：${item.source ?? "待确认"}）`)].join("\n")
          : `未找到相关知识：${safeText(args.query)}`,
        status: "ok",
        items: result.items,
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
      const persisted = withImmediateTransaction(db, () => {
        const recordId = actionId || randomUUID();
        db.prepare(`
          INSERT INTO quick_records (id, raw_content, occurred_at, source_channel)
          VALUES ($id, $rawContent, $occurredAt, '微信助手')
        `).run({ $id: recordId, $rawContent: content, $occurredAt: occurredAt });
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
          metadata: { sourceChannel: created.sourceChannel },
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
          return { text: "这张发票已经在发票仓库中，无需重复上传。", status: "duplicate" };
        }
        throw error;
      }
      return { text: `发票已存入发票仓库，编号：${item.id}。无需先匹配费用，可在系统内人工复核。`, status: "received", item };
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
      return {
        text: `报销周汇总预览（${summary.weekStart}）：${summary.summary.count} 笔费用，实付 ${moneyFromCents(summary.summary.actualPaidCents)}，可报销 ${moneyFromCents(summary.summary.reimbursementCents)}。`,
        status: "preview",
        summary,
      };
    },

    async "sales-report.preview"(args, context) {
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
