import { insertAudit } from "../audit/auditRepository.js";

function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

export function weixinInvoiceAttachmentMarker(invoiceId) {
  return `微信发票自动关联:${requiredText(invoiceId, "invoiceId", 200)}`;
}

/**
 * Rebuild invoice attachments from the durable invoice + confirmed-match
 * records. No extra queue table is required: a missing exact marker is the
 * durable retry condition, and the stored lossless document blob is the source
 * for every retry.
 */
export function reconcileWeixinInvoiceAttachments({
  db,
  invoiceRepository,
  travelExpenseRepository,
  owner,
  actor = owner,
  invoiceId = null,
  requestIdPrefix = "weixin-invoice-attachment-reconcile",
  limit = 20,
} = {}) {
  if (!db || typeof db.prepare !== "function" || !invoiceRepository || !travelExpenseRepository) return [];
  const normalizedOwner = requiredText(owner, "owner", 200);
  const normalizedActor = requiredText(actor, "actor", 200);
  const normalizedInvoiceId = invoiceId === null || invoiceId === undefined || invoiceId === ""
    ? null
    : requiredText(invoiceId, "invoiceId", 200);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("limit must be a positive safe integer no greater than 100");
  }
  const rows = db.prepare(`
    SELECT match.id AS match_id, match.invoice_id, match.expense_id,
           match.payment_id, match.allocated_cents
    FROM invoice_matches match
    JOIN invoice_documents invoice
      ON invoice.id = match.invoice_id
     AND invoice.owner = match.owner
     AND invoice.deleted_at IS NULL
    JOIN travel_expenses expense
      ON expense.id = match.expense_id
     AND expense.owner = match.owner
     AND expense.deleted_at IS NULL
    WHERE match.owner = $owner
      AND match.state = 'confirmed'
      AND invoice.source = 'weixin'
      AND ($invoiceId IS NULL OR match.invoice_id = $invoiceId)
      AND NOT EXISTS (
        SELECT 1
        FROM travel_expense_attachments attachment
        JOIN travel_expense_attachment_payments link
          ON link.attachment_id = attachment.id
        WHERE attachment.expense_id = match.expense_id
          AND attachment.kind = 'invoice'
          AND attachment.notes = '微信发票自动关联:' || match.invoice_id
          AND link.payment_id = match.payment_id
      )
    ORDER BY match.confirmed_at ASC, match.id ASC
    LIMIT $limit
  `).all({
    $owner: normalizedOwner,
    $invoiceId: normalizedInvoiceId,
    $limit: limit,
  });
  return rows.map((row) => {
    try {
      const content = invoiceRepository.getInvoiceContent(row.invoice_id, { owner: normalizedOwner });
      let expense = travelExpenseRepository.getExpense(row.expense_id, { owner: normalizedOwner });
      if (!content || !expense) return { status: "not_available", matchId: row.match_id };
      const marker = weixinInvoiceAttachmentMarker(row.invoice_id);
      let attachment = expense.attachments.find((candidate) => (
        candidate.kind === "invoice"
        && candidate.notes === marker
        && candidate.paymentIds.includes(row.payment_id)
      ));
      if (!attachment) {
        const beforeIds = new Set(expense.attachments.map((candidate) => candidate.id));
        expense = travelExpenseRepository.addAttachment(row.expense_id, {
          owner: normalizedOwner,
          actor: normalizedActor,
          expectedVersion: expense.version,
          paymentIds: [row.payment_id],
          kind: "invoice",
          fileName: content.fileName,
          mediaType: content.mediaType,
          content: content.content,
          coveredCents: Number(row.allocated_cents),
          notes: marker,
        });
        attachment = expense.attachments.find((candidate) => !beforeIds.has(candidate.id)) ?? null;
      }
      if (!attachment) throw new Error("WEIXIN_INVOICE_ATTACHMENT_MISSING");
      insertAudit(db, {
        action: "travel_expense.invoice_attachment_add",
        entityType: "travel_expense_attachment",
        entityId: attachment.id,
        actor: normalizedActor,
        requestId: `${requestIdPrefix}:${row.match_id}`,
        before: null,
        after: {
          id: attachment.id,
          expenseId: row.expense_id,
          paymentId: row.payment_id,
          invoiceId: row.invoice_id,
          kind: "invoice",
          sizeBytes: attachment.sizeBytes,
          sha256: content.sha256,
        },
        entityVersion: expense.version,
        metadata: { source: "weixin_invoice_reconcile", matchId: row.match_id },
      });
      return {
        status: "attached",
        matchId: row.match_id,
        invoiceId: row.invoice_id,
        expenseId: row.expense_id,
        paymentId: row.payment_id,
        attachment,
      };
    } catch (error) {
      return {
        status: "pending",
        matchId: row.match_id,
        invoiceId: row.invoice_id,
        code: typeof error?.code === "string" ? error.code : "WEIXIN_INVOICE_ATTACHMENT_PENDING",
      };
    }
  });
}
