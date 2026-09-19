import {
  CheckCircle2,
  CircleAlert,
  FileText,
  RefreshCw,
  ReceiptText,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AuthenticatedImageFrame } from "./AuthenticatedImageFrame.jsx";
import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import { isTravelExpenseImage, isTravelExpensePdf } from "./travelExpenseDocument.js";

const INVOICE_OPTIONS = Object.freeze([
  Object.freeze({ id: "electronic", label: "电子", description: "可在发票页自动识别", Icon: CheckCircle2 }),
  Object.freeze({ id: "substitute", label: "替票", description: "手动指定替票", Icon: RefreshCw }),
  Object.freeze({ id: "paper", label: "纸质", description: "纸质发票", Icon: FileText }),
  Object.freeze({ id: "unprovided", label: "未提供", description: "当前费用暂无发票", Icon: CircleAlert }),
]);

export function ExpenseEvidencePanel({
  expense,
  invoiceType,
  readOnly = false,
  getAttachmentUrl,
  getAttachmentContentResponse,
  onInvoiceTypeChange,
  onReplace,
  onDelete,
  onVersionChange,
  pendingAttachmentId,
}) {
  const replacementInputRef = useRef(null);
  const previewClickTimerRef = useRef(null);
  const [replacementAttachmentId, setReplacementAttachmentId] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => () => {
    if (previewClickTimerRef.current) window.clearTimeout(previewClickTimerRef.current);
  }, []);

  const proofs = (expense?.attachments ?? []).filter((attachment) => attachment.kind === "payment_proof");
  const selectedInvoiceType = invoiceType || "unprovided";
  const selectedInvoice = INVOICE_OPTIONS.find((item) => item.id === selectedInvoiceType) ?? INVOICE_OPTIONS[3];
  const SelectedInvoiceIcon = selectedInvoice.Icon;

  function openOriginal(attachment) {
    const url = getAttachmentUrl?.(attachment.id);
    if (url && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  }

  function handlePreviewClick(attachment) {
    if (previewClickTimerRef.current) window.clearTimeout(previewClickTimerRef.current);
    previewClickTimerRef.current = window.setTimeout(() => {
      previewClickTimerRef.current = null;
      openOriginal(attachment);
    }, 220);
  }

  function selectReplacement(attachmentId) {
    if (!onReplace || pendingAttachmentId) return;
    setActionError("");
    setReplacementAttachmentId(attachmentId);
    replacementInputRef.current?.click();
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
      if (previewClickTimerRef.current) {
        window.clearTimeout(previewClickTimerRef.current);
        previewClickTimerRef.current = null;
      }
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
    setActionError("");
    try {
      const updated = await onReplace(expense, attachment, file);
      if (Number.isSafeInteger(updated?.version)) onVersionChange?.(updated.version);
    } catch (error) {
      setActionError(String(error?.message ?? "付款凭证替换失败，请重试。"));
    }
  }

  async function handleDelete(attachment) {
    if (!onDelete || pendingAttachmentId) return;
    setActionError("");
    try {
      const updated = await onDelete(expense, attachment);
      if (Number.isSafeInteger(updated?.version)) onVersionChange?.(updated.version);
    } catch (error) {
      setActionError(String(error?.message ?? "付款凭证删除失败，请重试。"));
    }
  }

  return (
    <section className={`expense-evidence-panel${readOnly ? " is-read-only" : " is-editing"}`} aria-labelledby="expense-evidence-title">
      <header className="expense-evidence-panel-heading">
        <div><ReceiptText size={16} aria-hidden="true" /><h3 id="expense-evidence-title">付款凭证与发票</h3></div>
        <span>{readOnly ? "凭证图片可双击替换" : "编辑票据状态"}</span>
      </header>
      <div className="expense-evidence-columns">
        <section className="expense-evidence-section" aria-labelledby="expense-proof-title">
          <header className="expense-evidence-heading">
            <h4 id="expense-proof-title">付款凭证</h4>
            <span>{readOnly ? `${proofs.length}张` : "双击图片替换"}</span>
          </header>
          <input
            ref={replacementInputRef}
            className="expense-evidence-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="选择替换付款凭证图片"
            disabled={Boolean(pendingAttachmentId)}
            onChange={(event) => void handleReplacementChange(event)}
          />
          <div className="expense-evidence-list">
            {proofs.map((attachment) => {
              const image = isTravelExpenseImage(attachment);
              const pdf = isTravelExpensePdf(attachment);
              const pending = pendingAttachmentId === attachment.id;
              return (
                <article className={`expense-evidence-item${pending ? " is-pending" : ""}`} key={attachment.id}>
                  <button
                    className={`expense-evidence-preview${image ? " is-replaceable" : ""}`}
                    type="button"
                    aria-label={`${attachment.fileName || "付款凭证"}，单击查看原件${image ? "，双击替换图片" : ""}`}
                    onClick={() => handlePreviewClick(attachment)}
                    onDoubleClick={(event) => handlePreviewDoubleClick(event, attachment)}
                    onKeyDown={(event) => handlePreviewKeyDown(event, attachment)}
                  >
                    {image ? (
                      <AuthenticatedImageFrame
                        resourceKey={`${attachment.id}:${expense.version}`}
                        loadImage={({ signal }) => getAttachmentContentResponse(attachment.id, { signal })}
                        title={attachment.fileName}
                        maxDimension={1600}
                        className="expense-evidence-image"
                      />
                    ) : pdf ? (
                      <AuthenticatedPdfFrame
                        resourceKey={`${attachment.id}:${expense.version}`}
                        loadPdf={({ signal }) => getAttachmentContentResponse(attachment.id, { signal })}
                        title={`${attachment.fileName} PDF 付款凭证原件`}
                        renderWidth={1200}
                      />
                    ) : (
                      <span className="expense-evidence-file-mark"><FileText size={22} aria-hidden="true" />原件文件</span>
                    )}
                    {pending ? <span className="expense-evidence-pending" role="status">正在处理</span> : null}
                  </button>
                  {!readOnly ? (
                    <button
                      className="expense-evidence-delete"
                      type="button"
                      aria-label={`删除${attachment.fileName || "付款凭证"}`}
                      title="删除付款凭证"
                      disabled={Boolean(pendingAttachmentId)}
                      onClick={() => void handleDelete(attachment)}
                    ><Trash2 size={15} aria-hidden="true" /></button>
                  ) : null}
                </article>
              );
            })}
            {proofs.length === 0 ? <p className="expense-evidence-empty"><FileText size={18} aria-hidden="true" />暂无付款凭证</p> : null}
          </div>
        </section>

        <section className="expense-evidence-section expense-invoice-section" aria-labelledby="expense-invoice-title">
          <header className="expense-evidence-heading">
            <h4 id="expense-invoice-title">发票状态</h4>
            <span>{readOnly ? "当前状态" : "请选择一项"}</span>
          </header>
          {readOnly ? (
            <div className={`expense-invoice-current is-${selectedInvoiceType}`} data-invoice-status={selectedInvoiceType}>
              <SelectedInvoiceIcon size={23} aria-hidden="true" />
              <div><strong>{selectedInvoice.label}</strong><span>{selectedInvoice.description}</span></div>
            </div>
          ) : (
            <>
              <div className="expense-invoice-options" role="radiogroup" aria-label="发票状态">
                {INVOICE_OPTIONS.map(({ id, label, Icon }) => (
                  <label className={`expense-invoice-option is-${id}${selectedInvoiceType === id ? " is-selected" : ""}`} key={id}>
                    <input
                      type="radio"
                      name="expense-invoice-status"
                      value={id}
                      checked={selectedInvoiceType === id}
                      onChange={() => onInvoiceTypeChange(id)}
                    />
                    <Icon size={17} aria-hidden="true" />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className={`expense-invoice-current is-${selectedInvoiceType}`} data-invoice-status={selectedInvoiceType}>
                <SelectedInvoiceIcon size={20} aria-hidden="true" />
                <div><strong>{selectedInvoice.label}</strong><span>{selectedInvoice.description}</span></div>
              </div>
            </>
          )}
        </section>
      </div>
      {actionError ? <p className="expense-evidence-error" role="alert">{actionError}</p> : null}
    </section>
  );
}
