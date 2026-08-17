import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { decodeCanonicalBase64 } from "../http/strictBase64.js";
import { analyzeQuickRecord } from "../modelAnalysis.js";
import { withDocumentBlobWritePreflight } from "../travelExpense/documentBlobStore.js";
import { createAssistantBusinessSnapshotAdapter } from "./businessSnapshotAdapter.js";

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

function isControlMessage(text) {
  return new Set(["记录", "录入", "确认", "取消", "帮助", "help", "/帮助", "/help"]).has(text);
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
  const customer = safeText(analysis?.customer?.value, "待匹配客户");
  const opportunity = safeText(analysis?.opportunity?.value, "待确认商机");
  const request = safeText(analysis?.summary?.request?.text, "待补充");
  const risk = safeText(analysis?.summary?.risk?.text, "待确认");
  const action = safeText(analysis?.summary?.action?.text, "待确认");
  return [
    "待确认记录：",
    `客户：${customer}`,
    `商机：${opportunity}`,
    `诉求：${request.slice(0, 160)}`,
    `风险：${risk.slice(0, 160)}`,
    `建议：${action.slice(0, 160)}`,
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

function ambiguousEntityResult(label, items) {
  return {
    text: `找到多个${label}，请补充更具体的名称或内部标识：${items.slice(0, 5).map((item) => item.name).filter(Boolean).join("、")}`,
    status: "clarify",
    question: `请确认要查看哪个${label}。`,
    items,
  };
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
  resolveBusinessOwner = (owner) => owner,
  clock = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!db || !sessionRepository) throw new TypeError("assistant runtime dependencies are required");
  const snapshotAdapter = businessSnapshotAdapter ?? createAssistantBusinessSnapshotAdapter({ db, clock, resolveBusinessOwner });

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
      let customer = snapshotAdapter.customerDetail({ owner: context.owner, customerId: args.customerId });
      if (!customer) {
        const matches = snapshotAdapter.customerSearch({ owner: context.owner, query: args.customerId }).items;
        if (matches.length > 1) return ambiguousEntityResult("客户", matches);
        customer = matches[0] ?? null;
      }
      if (!customer) return { text: "未找到该客户，或当前账号无权查看。", status: "not_found" };
      return {
        text: [
          `客户：${customer.name ?? "名称待确认"}`,
          `区域：${customer.region ?? "待确认"}`,
          `类型：${customer.type ?? "待确认"}`,
          `级别：${customer.level ?? "待确认"}`,
        ].join("\n"),
        status: "ok",
        customer,
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
      };
    },

    async "sales-decision.preview"(args, context) {
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
      const analysis = await analyzeQuickRecord(content, config, { fetchImpl });
      return { text: previewText(analysis), status: "preview", analysis };
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
      const analysis = await analyzeQuickRecord(content, config, { fetchImpl });
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
      const result = snapshotAdapter.customerSearch({ owner: context.owner, query: query || "客户" });
      const text = result.items.length === 0
        ? `未找到客户：${query || "（未提供关键词）"}`
        : [
          `找到 ${result.items.length}${result.truncated ? "+" : ""} 个客户：`,
          ...result.items.map((item) => `- ${item.name ?? "名称待确认"} [${item.id}] / ${item.region ?? "-"}`),
        ].join("\n");
      return { text, status: "ok", items: result.items, truncated: result.truncated };
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
      const summary = snapshotAdapter.salesReportSummary({
        owner: context.owner,
        weekStart: args.periodStart ?? args.week,
      });
      return { text: `销售周报预览（${summary.weekStart}）：当前共有 ${summary.recordCount} 条快速记录，详情可在系统内继续编辑。`, status: "preview", summary };
    },
  };

  return Object.freeze(handlers);
}
