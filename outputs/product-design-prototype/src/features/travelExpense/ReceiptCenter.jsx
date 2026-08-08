import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  Paperclip,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  isTravelExpenseImage,
  isTravelExpensePdf,
} from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

const GROUP_LABELS = {
  covered: "已覆盖",
  partial: "部分覆盖",
  missing: "缺少票据",
  pending: "待人工确认",
};

function Lightbox({ items, index, onIndex, onClose, getAttachmentUrl }) {
  const [rotation, setRotation] = useState(0);
  const attachment = items[index];

  useEffect(() => {
    const keydown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
      if (event.key === "ArrowRight") onIndex((index + 1) % items.length);
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [index, items.length, onClose, onIndex]);

  useEffect(() => setRotation(0), [attachment?.id]);
  if (!attachment) return null;
  return (
    <div className="expense-lightbox" role="dialog" aria-modal="true" aria-label="查看付款凭证">
      <div className="expense-lightbox-toolbar">
        <strong>{attachment.fileName}</strong>
        <span>{index + 1} / {items.length}</span>
        <button className="icon-button dark" type="button" aria-label="旋转凭证" onClick={() => setRotation((value) => value + 90)}><RotateCw size={18} /></button>
        <button className="icon-button dark" type="button" aria-label="关闭凭证" onClick={onClose}><X size={20} /></button>
      </div>
      <button className="expense-lightbox-nav previous" type="button" aria-label="上一张凭证" onClick={() => onIndex((index - 1 + items.length) % items.length)}><ChevronLeft size={28} /></button>
      <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} style={{ transform: `rotate(${rotation}deg)` }} />
      <button className="expense-lightbox-nav next" type="button" aria-label="下一张凭证" onClick={() => onIndex((index + 1) % items.length)}><ChevronRight size={28} /></button>
    </div>
  );
}

export function ReceiptCenter({
  expenses,
  getAttachmentUrl,
  onUpload,
  onDelete,
  pendingAttachmentId,
}) {
  const [lightbox, setLightbox] = useState(null);
  const [brokenImages, setBrokenImages] = useState(() => new Set());
  const grouped = useMemo(() => Object.fromEntries(Object.keys(GROUP_LABELS).map((status) => [
    status,
    expenses.filter((expense) => expense.invoiceStatus === status),
  ])), [expenses]);
  const allAttachments = expenses.flatMap((expense) => expense.attachments.map((attachment) => ({ ...attachment, expense })));
  const imageAttachments = allAttachments.filter(isTravelExpenseImage);

  return (
    <section className="expense-receipt-center">
      <header className="expense-section-intro"><div><strong>票据中心</strong><p>图片与 PDF 均按原文件上传，不在浏览器中缩放、转码或降低清晰度。</p></div><span>{allAttachments.length} 份附件</span></header>
      <div className="expense-receipt-groups">
        {Object.entries(GROUP_LABELS).map(([status, label]) => (
          <section className={`expense-receipt-group ${status}`} key={status}>
            <header><div><span className={`expense-status-dot ${status}`} /><strong>{label}</strong></div><span>{grouped[status].length} 条费用</span></header>
            <div className="expense-receipt-list">
              {grouped[status].map((expense) => (
                <article className="expense-receipt-card" key={expense.id}>
                  <div className="expense-receipt-card-copy"><span>{expense.occurredOn}</span><strong>{expense.purpose}</strong><small>{formatCny(expense.reimbursementCents)} · {expense.payments.length} 笔付款</small></div>
                  <div className="expense-receipt-thumbnails">
                    {expense.attachments.map((attachment) => {
                      const isImage = isTravelExpenseImage(attachment);
                      const isPdf = isTravelExpensePdf(attachment);
                      const globalIndex = imageAttachments.findIndex((item) => item.id === attachment.id);
                      const broken = brokenImages.has(attachment.id);
                      return (
                        <div className={`expense-receipt-thumb${isImage ? "" : " expense-receipt-file-thumb"}`} key={attachment.id}>
                          {isImage ? (
                            <button type="button" aria-label={`查看${attachment.fileName}`} onClick={() => setLightbox(globalIndex)}>
                              {broken ? <span className="expense-broken-image"><ImageOff size={18} />凭证加载失败</span> : <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} onError={() => setBrokenImages((current) => new Set(current).add(attachment.id))} />}
                            </button>
                          ) : (
                            <div className="expense-receipt-file-card">
                              <div><FileText size={22} aria-hidden="true" /><span><strong>{isPdf ? "PDF 文件" : "附件文件"}</strong><small title={attachment.fileName}>{attachment.fileName}</small></span></div>
                              <nav aria-label={`${attachment.fileName}文件操作`}>
                                <a href={getAttachmentUrl(attachment.id)} target="_blank" rel="noreferrer" aria-label={`打开 PDF ${attachment.fileName}`}><ExternalLink size={14} />打开 PDF</a>
                                <a href={getAttachmentUrl(attachment.id)} download={attachment.fileName} aria-label={`下载${attachment.fileName}`}><Download size={14} />下载</a>
                              </nav>
                            </div>
                          )}
                          <span>{attachment.kind === "payment_proof" ? "付款凭证" : attachment.kind === "invoice" ? "发票" : "替代凭证"}</span>
                          <button className="icon-button danger" type="button" aria-label={`删除${attachment.fileName}`} disabled={pendingAttachmentId === attachment.id} onClick={() => onDelete(expense, attachment)}><Trash2 size={14} /></button>
                        </div>
                      );
                    })}
                    <label className="expense-upload-tile">
                      <Upload size={18} />
                      <span>上传付款凭证</span>
                      <small>图片 / PDF · 原文件最大 12 MiB</small>
                      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) onUpload(expense, file);
                        event.target.value = "";
                      }} />
                    </label>
                  </div>
                </article>
              ))}
              {grouped[status].length === 0 ? <div className="expense-receipt-empty"><Paperclip size={18} /><span>本周没有{label}的费用</span></div> : null}
            </div>
          </section>
        ))}
      </div>
      <aside className="expense-receipt-policy"><CircleAlert size={18} /><div><strong>票据规则待配置</strong><p>首版不会自动认定发票合规、额度超标或凭证有效性，您可以先按实际情况标记并在报销整理中复核。</p></div></aside>
      {Number.isInteger(lightbox) ? <Lightbox items={imageAttachments} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} getAttachmentUrl={getAttachmentUrl} /> : null}
    </section>
  );
}
