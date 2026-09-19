import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Edit3,
  FileText,
  MapPin,
  ReceiptText,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AuthenticatedImageFrame } from "./AuthenticatedImageFrame.jsx";
import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import { isTravelExpenseImage, isTravelExpensePdf } from "./travelExpenseDocument.js";
import {
  EXPENSE_CATEGORIES,
  formatCny,
  formatTravelExpenseDateTime,
  resolveExpenseInvoiceType,
} from "./travelExpenseModel.js";

const INVOICE_STATUS_VIEWS = Object.freeze({
  electronic: Object.freeze({
    id: "electronic",
    label: "电子",
    description: "电子发票",
    Icon: CheckCircle2,
  }),
  substitute: Object.freeze({
    id: "substitute",
    label: "替票",
    description: "手动指定替票",
    Icon: RefreshCw,
  }),
  paper: Object.freeze({
    id: "paper",
    label: "纸质",
    description: "纸质发票",
    Icon: FileText,
  }),
  unprovided: Object.freeze({
    id: "unprovided",
    label: "未提供",
    description: "尚未提供发票",
    Icon: CircleAlert,
  }),
});

function labelFor(items, id, fallback = "未填写") {
  return items.find((item) => item.id === id)?.label ?? fallback;
}

function paymentTotals(expense) {
  return (expense.payments ?? []).reduce((totals, payment) => ({
    amountCents: totals.amountCents + (Number.isSafeInteger(payment.amountCents) ? payment.amountCents : 0),
    reimbursementCents: totals.reimbursementCents + (Number.isSafeInteger(payment.reimbursementCents) ? payment.reimbursementCents : 0),
  }), { amountCents: 0, reimbursementCents: 0 });
}

function invoiceStatusView(expense, context) {
  const resolvedType = resolveExpenseInvoiceType(expense, context);
  return INVOICE_STATUS_VIEWS[resolvedType] ?? INVOICE_STATUS_VIEWS.unprovided;
}

function InfoItem({ label, value, icon: Icon }) {
  return (
    <div className="expense-detail-info-item">
      <dt>{Icon ? <Icon size={14} aria-hidden="true" /> : null}{label}</dt>
      <dd>{value || "未填写"}</dd>
    </div>
  );
}

export function ExpenseDetailCard({
  open,
  expense,
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentUrl,
  getAttachmentContentResponse,
  onReplace,
  onDelete,
  pendingAttachmentId,
  onEdit,
  onClose,
}) {
  const replacementInputRef = useRef(null);
  const previewClickTimerRef = useRef(null);
  const [replacementAttachmentId, setReplacementAttachmentId] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => () => {
    if (previewClickTimerRef.current) window.clearTimeout(previewClickTimerRef.current);
  }, []);

  const totals = useMemo(() => (expense ? paymentTotals(expense) : { amountCents: 0, reimbursementCents: 0 }), [expense]);
  if (!open || !expense) return null;

  const categoryLabel = labelFor(EXPENSE_CATEGORIES, expense.category);
  const proofs = (expense.attachments ?? []).filter((attachment) => attachment.kind === "payment_proof");
  const invoiceView = invoiceStatusView(expense, { matches, noInvoiceConfirmations });
  const InvoiceIcon = invoiceView.Icon;

  function selectReplacement(attachmentId) {
    if (!onReplace || pendingAttachmentId) return;
    setReplacementAttachmentId(attachmentId);
    replacementInputRef.current?.click();
  }

  function openOriginal(attachment) {
    if (!getAttachmentUrl || typeof window === "undefined") return;
    window.open(getAttachmentUrl(attachment.id), "_blank", "noopener,noreferrer");
  }

  function handlePreviewClick(attachment) {
    if (previewClickTimerRef.current) window.clearTimeout(previewClickTimerRef.current);
    previewClickTimerRef.current = window.setTimeout(() => {
      previewClickTimerRef.current = null;
      openOriginal(attachment);
    }, 220);
  }

  function handlePreviewDoubleClick(event, attachment) {
    event.preventDefault();
    event.stopPropagation();
    if (previewClickTimerRef.current) {
      window.clearTimeout(previewClickTimerRef.current);
      previewClickTimerRef.current = null;
    }
    if (isTravelExpenseImage(attachment)) selectReplacement(attachment.id);
  }

  function handlePreviewKeyDown(event, attachment) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOriginal(attachment);
    }
  }

  async function handleReplacementChange(event) {
    const file = event.target.files?.[0];
    const attachmentId = replacementAttachmentId;
    event.target.value = "";
    setReplacementAttachmentId("");
    if (!file || !attachmentId || !onReplace) return;
    const attachment = proofs.find((item) => item.id === attachmentId);
    if (!attachment) return;
    try {
      await onReplace(expense, attachment, file);
    } catch {
      // The parent owns the error banner; keep the dialog open for another try.
    }
  }

  return (
    <div className="expense-detail-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section className="expense-detail-card" role="dialog" aria-modal="true" aria-labelledby="expense-detail-title">
        <header className="expense-detail-head">
          <div>
            <span className="expense-detail-kicker"><ReceiptText size={14} aria-hidden="true" />记账详情</span>
            <h2 id="expense-detail-title">详情内容</h2>
            <div className="expense-detail-reference"><code>{expense.referenceCode || "待生成编号"}</code><span>{expense.occurredOn}</span><span>{categoryLabel}</span></div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭记账详情" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="expense-detail-scroll">
          <section className="expense-detail-hero" aria-label="费用金额摘要">
            <div><small>实付金额</small><strong>{formatCny(totals.amountCents)}</strong></div>
            <div><small>计入报销</small><strong>{formatCny(totals.reimbursementCents)}</strong></div>
            <div><small>付款凭证</small><strong>{proofs.length} 份</strong></div>
          </section>

          <section className="expense-detail-section">
            <header><div><FileText size={16} aria-hidden="true" /><h3>费用信息</h3></div><span>{expense.payments?.length ?? 0} 笔付款</span></header>
            <div className="expense-detail-payment-list">
              {(expense.payments ?? []).map((payment, index) => (
                <article className="expense-detail-payment-card" key={payment.id ?? index}>
                  <div className="expense-detail-payment-head"><strong>第 {index + 1} 笔付款</strong><b>{formatCny(payment.amountCents ?? 0)}</b></div>
                  <dl className="expense-detail-payment-info-grid">
                    <InfoItem label="支付时间" value={formatTravelExpenseDateTime(payment.paidAt)} icon={CalendarDays} />
                    <InfoItem label="出差区域" value={expense.tripRegion} icon={MapPin} />
                    <InfoItem label="付款金额" value={formatCny(payment.amountCents ?? 0)} />
                    <InfoItem label="费用事由" value={expense.purpose} />
                  </dl>
                </article>
              ))}
              {expense.payments?.length ? null : <p className="expense-detail-empty">暂无付款记录</p>}
            </div>
          </section>

          <section className="expense-detail-section expense-detail-proof-section">
            <header><div><ReceiptText size={16} aria-hidden="true" /><h3>付款凭证和发票</h3></div><span>单击查看，双击图片替换</span></header>
            <div className="expense-detail-evidence-grid">
              <div className="expense-detail-proof-column">
                <div className="expense-detail-subsection-title"><strong>付款凭证</strong><span>{proofs.length} 份</span></div>
                <input
                  ref={replacementInputRef}
                  className="expense-detail-replace-input"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="选择替换付款凭证图片"
                  disabled={Boolean(pendingAttachmentId)}
                  onChange={(event) => void handleReplacementChange(event)}
                />
                <div className="expense-detail-proof-gallery">
                  {proofs.map((attachment) => {
                    const isImage = isTravelExpenseImage(attachment);
                    const isPdf = isTravelExpensePdf(attachment);
                    const pending = pendingAttachmentId === attachment.id;
                    return (
                      <article className={`expense-detail-proof-item${pending ? " is-pending" : ""}`} key={attachment.id}>
                        <div
                          className={`expense-detail-proof-image${isImage ? " is-replaceable" : ""}`}
                          role="button"
                          tabIndex={0}
                          aria-label={`${attachment.fileName || "付款凭证"}，单击查看原件${isImage ? "，双击替换图片" : ""}`}
                          onClick={() => handlePreviewClick(attachment)}
                          onDoubleClick={(event) => handlePreviewDoubleClick(event, attachment)}
                          onKeyDown={(event) => handlePreviewKeyDown(event, attachment)}
                        >
                          {isImage ? (
                            <AuthenticatedImageFrame resourceKey={`${attachment.id}:${expense.version}`} loadImage={({ signal }) => getAttachmentContentResponse(attachment.id, { signal })} title={attachment.fileName} maxDimension={1200} />
                          ) : isPdf ? (
                            <AuthenticatedPdfFrame resourceKey={`${attachment.id}:${expense.version}`} loadPdf={({ signal }) => getAttachmentContentResponse(attachment.id, { signal })} title={`${attachment.fileName} PDF 付款凭证原件`} renderWidth={1000} />
                          ) : (
                            <span><FileText size={28} aria-hidden="true" /><strong>原件文件</strong></span>
                          )}
                          {isImage ? <small>双击替换图片</small> : null}
                          {pending ? <span className="expense-detail-proof-pending" role="status">正在替换</span> : null}
                        </div>
                        <div className="expense-detail-proof-meta">
                          <strong title={attachment.fileName}>{attachment.fileName || "付款凭证"}</strong>
                          <button className="icon-button" type="button" aria-label={`删除${attachment.fileName || "付款凭证"}`} disabled={pending} onClick={() => onDelete?.(expense, attachment)}><Trash2 size={15} aria-hidden="true" /></button>
                        </div>
                      </article>
                    );
                  })}
                  {proofs.length === 0 ? <div className="expense-detail-proof-empty"><FileText size={20} aria-hidden="true" /><span>暂无付款凭证</span></div> : null}
                </div>
              </div>

              <div className="expense-detail-invoice-column">
                <div className="expense-detail-subsection-title"><strong>发票状态</strong><span>{invoiceView.id === "unprovided" ? "默认未提供" : invoiceView.description}</span></div>
                <div className={`expense-detail-invoice-status is-${invoiceView.id}`} data-invoice-status={invoiceView.id}>
                  <InvoiceIcon size={26} aria-hidden="true" />
                  <div><strong>{invoiceView.label}</strong><span>{invoiceView.description}</span></div>
                </div>
                <p className="expense-detail-invoice-note">电子、纸质和替票类型可通过“编辑记账”手动调整。</p>
              </div>
            </div>
          </section>
        </div>

        <footer className="expense-detail-actions">
          <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
          <button className="primary-button" type="button" onClick={() => onEdit?.(expense)}><Edit3 size={16} aria-hidden="true" />编辑记账</button>
        </footer>
      </section>
    </div>
  );
}
