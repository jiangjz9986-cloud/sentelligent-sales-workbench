import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Edit3,
  FileText,
  MapPin,
  ReceiptText,
  X,
} from "lucide-react";
import { useEffect, useMemo } from "react";

import { PaymentProofCenter } from "./PaymentProofCenter.jsx";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_INVOICE_TYPES,
  INVOICE_STATUSES,
  formatCny,
  formatTravelExpenseDateTime,
} from "./travelExpenseModel.js";

const PAYMENT_METHOD_LABELS = {
  wechat: "微信支付",
  weixin: "微信支付",
  alipay: "支付宝",
  card: "银行卡",
  bank_card: "银行卡",
  corporate_card: "企业卡",
  cash: "现金",
  other: "其他",
};

const FUNDING_LABELS = {
  personal: "个人垫付",
  company: "公司直付",
  advance: "请款资金",
};

function labelFor(items, id, fallback = "未填写") {
  return items.find((item) => item.id === id)?.label ?? fallback;
}

function paymentTotals(expense) {
  return (expense.payments ?? []).reduce((totals, payment) => ({
    amountCents: totals.amountCents + (Number.isSafeInteger(payment.amountCents) ? payment.amountCents : 0),
    reimbursementCents: totals.reimbursementCents + (Number.isSafeInteger(payment.reimbursementCents) ? payment.reimbursementCents : 0),
  }), { amountCents: 0, reimbursementCents: 0 });
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
  itineraries = [],
  customers = [],
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentUrl,
  getAttachmentContentResponse,
  onUpload,
  onDelete,
  pendingAttachmentId,
  onEdit,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const totals = useMemo(() => (expense ? paymentTotals(expense) : { amountCents: 0, reimbursementCents: 0 }), [expense]);
  if (!open || !expense) return null;

  const categoryLabel = labelFor(EXPENSE_CATEGORIES, expense.category);
  const invoiceTypeLabel = labelFor(EXPENSE_INVOICE_TYPES, expense.invoiceType, "未选择");
  const invoiceStatusLabel = labelFor(INVOICE_STATUSES, expense.invoiceStatus, "待人工确认");
  const itineraryLabel = itineraries.find((item) => item.id === expense.itineraryId)?.title ?? "未关联";
  const customerLabel = customers.find((item) => item.id === expense.customerId)?.name ?? "未关联";
  const proofs = (expense.attachments ?? []).filter((attachment) => attachment.kind === "payment_proof");

  return (
    <div className="expense-detail-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section className="expense-detail-card" role="dialog" aria-modal="true" aria-labelledby="expense-detail-title">
        <header className="expense-detail-head">
          <div>
            <span className="expense-detail-kicker"><ReceiptText size={14} aria-hidden="true" />记账详情</span>
            <h2 id="expense-detail-title">{expense.purpose || expense.notes || "差旅费用"}</h2>
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
            <header><div><FileText size={16} aria-hidden="true" /><h3>费用信息</h3></div><span>可通过“编辑记账”修改</span></header>
            <dl className="expense-detail-info-grid">
              <InfoItem label="发生日期" value={expense.occurredOn} icon={CalendarDays} />
              <InfoItem label="分类" value={categoryLabel} />
              <InfoItem label="费用事由" value={expense.purpose} />
              <InfoItem label="收款方" value={expense.merchant} />
              <InfoItem label="出差区域" value={expense.tripRegion} icon={MapPin} />
              <InfoItem label="票据状态" value={`${invoiceTypeLabel} · ${invoiceStatusLabel}`} icon={expense.invoiceStatus === "covered" ? CheckCircle2 : CircleAlert} />
              <InfoItem label="关联行程" value={itineraryLabel} />
              <InfoItem label="关联客户" value={customerLabel} />
              <InfoItem label="备注" value={expense.notes} />
            </dl>
          </section>

          <section className="expense-detail-section">
            <header><div><ReceiptText size={16} aria-hidden="true" /><h3>付款记录</h3></div><span>{expense.payments?.length ?? 0} 笔</span></header>
            <div className="expense-detail-payments">
              {(expense.payments ?? []).map((payment, index) => (
                <article key={payment.id ?? index}>
                  <div className="expense-detail-payment-head"><strong>第 {index + 1} 笔付款</strong><b>{formatCny(payment.amountCents ?? 0)}</b></div>
                  <dl>
                    <div><dt>支付时间</dt><dd>{formatTravelExpenseDateTime(payment.paidAt)}</dd></div>
                    <div><dt>收款方</dt><dd>{payment.merchant || expense.merchant || "未填写"}</dd></div>
                    <div><dt>计入报销</dt><dd>{formatCny(payment.reimbursementCents ?? 0)}</dd></div>
                    <div><dt>资金来源</dt><dd>{FUNDING_LABELS[payment.fundingSource] ?? payment.fundingSource ?? "未填写"}</dd></div>
                    <div><dt>支付方式</dt><dd>{PAYMENT_METHOD_LABELS[payment.paymentMethod] ?? payment.paymentMethod ?? "未填写"}</dd></div>
                    <div><dt>账号末四位</dt><dd>{payment.accountLast4 || "未填写"}</dd></div>
                    {payment.differenceReason ? <div><dt>差额原因</dt><dd>{payment.differenceReason}</dd></div> : null}
                  </dl>
                </article>
              ))}
              {expense.payments?.length ? null : <p className="expense-detail-empty">暂无付款记录</p>}
            </div>
          </section>

          <section className="expense-detail-section expense-detail-proof-section">
            <header><div><ReceiptText size={16} aria-hidden="true" /><h3>付款凭证</h3></div><span>点击图片可查看原件</span></header>
            <PaymentProofCenter
              compact
              expenses={[expense]}
              expenseIds={[expense.id]}
              inboxItems={[]}
              showInbox={false}
              showProofs
              getAttachmentUrl={getAttachmentUrl}
              getAttachmentContentResponse={getAttachmentContentResponse}
              onUpload={onUpload}
              onDelete={onDelete}
              pendingAttachmentId={pendingAttachmentId}
            />
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
