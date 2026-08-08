import { randomUUID } from "node:crypto";

import { insertAudit } from "../audit/auditRepository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { decodeCanonicalBase64 } from "../http/strictBase64.js";
import { analyzeQuickRecord } from "../modelAnalysis.js";
import { withDocumentBlobWritePreflight } from "../travelExpense/documentBlobStore.js";

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

function weekStartFor(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = (date.getDay() + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function reportWeekStart(args, clock) {
  const explicit = safeText(args?.week);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(explicit)) return explicit;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(safeText(args?.periodStart))) return safeText(args.periodStart);
  return weekStartFor(clock());
}

export function createAssistantToolHandlers({
  db,
  config,
  sessionRepository,
  travelExpenseDocumentInboxRepository,
  invoiceRepository,
  paymentProofRecognizer,
  invoiceRecognizer,
  clock = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!db || !sessionRepository) throw new TypeError("assistant runtime dependencies are required");

  const handlers = {
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
      const content = draftText(sessionRepository, context);
      if (!content) return { text: "当前没有待录入内容，请先发送记录内容。", status: "empty" };
      const now = clock();
      const occurredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const analysis = await analyzeQuickRecord(content, config, { fetchImpl });
      const persisted = withImmediateTransaction(db, () => {
        const recordId = randomUUID();
        db.prepare(`
          INSERT INTO quick_records (id, raw_content, occurred_at, source_channel)
          VALUES ($id, $rawContent, $occurredAt, '微信助手')
        `).run({ $id: recordId, $rawContent: content, $occurredAt: occurredAt });
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

    async "customer.search"(args) {
      const query = safeText(args.query);
      const like = `%${query}%`;
      const rows = db.prepare(`
        SELECT id, name, region, owner, level, type
        FROM customers
        WHERE deleted_at IS NULL
          AND ($query = '' OR name LIKE $like OR region LIKE $like OR owner LIKE $like OR type LIKE $like)
        ORDER BY updated_at DESC, id
        LIMIT 10
      `).all({ $query: query, $like: like });
      const text = rows.length === 0
        ? `未找到客户：${query || "（未提供关键词）"}`
        : [`找到 ${rows.length} 个客户：`, ...rows.map((row) => `- ${row.name} / ${row.region ?? "-"} / ${row.owner ?? "-"}`)].join("\n");
      return { text, status: "ok", items: rows };
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
      const week = reportWeekStart(args, clock);
      const rows = db.prepare(`
        SELECT COUNT(*) AS expense_count, COALESCE(SUM(payment.amount_cents), 0) AS paid_cents
        FROM travel_expenses expense
        LEFT JOIN travel_expense_payments payment ON payment.expense_id = expense.id
        WHERE expense.owner = $owner AND expense.deleted_at IS NULL
          AND expense.occurred_on BETWEEN $week AND date($week, '+6 days')
      `).get({ $owner: context.owner, $week: week });
      return { text: `报销周汇总预览（${week}）：${Number(rows.expense_count)} 笔费用，实付 ${(Number(rows.paid_cents) / 100).toFixed(2)} 元。`, status: "preview", summary: rows };
    },

    async "sales-report.preview"(args) {
      const week = reportWeekStart(args, clock);
      const row = db.prepare(`
        SELECT COUNT(*) AS record_count
        FROM quick_records
        WHERE voided_at IS NULL
          AND date(COALESCE(occurred_at, created_at)) BETWEEN $week AND date($week, '+6 days')
      `).get({ $week: week });
      return { text: `销售周报预览（${week}）：当前共有 ${Number(row.record_count)} 条快速记录，详情可在系统内继续编辑。`, status: "preview" };
    },
  };

  return Object.freeze(handlers);
}
