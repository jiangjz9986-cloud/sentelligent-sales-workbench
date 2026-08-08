import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileText,
  ImageOff,
  Printer,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";

import { triggerBlobDownload } from "../../downloadFile.js";
import {
  buildPaymentRecordCsv,
  buildPaymentRecordRows,
  paymentRecordFilename,
} from "./travelExpenseExport.js";
import { isTravelExpensePdf } from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

function InlineProof({ attachment, getAttachmentUrl }) {
  if (isTravelExpensePdf(attachment)) {
    return (
      <a className="expense-inline-proof-file" href={getAttachmentUrl(attachment.id)} target="_blank" rel="noreferrer" aria-label={`打开 PDF ${attachment.fileName}`} title={attachment.fileName}>
        <FileText size={13} aria-hidden="true" />
        <span>PDF</span>
      </a>
    );
  }
  return <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} />;
}

export function ReimbursementOrganizer({
  expenses,
  summary,
  week,
  owner,
  getAttachmentUrl,
  onOpenPrint,
  onRefresh,
}) {
  const rows = useMemo(() => buildPaymentRecordRows(expenses), [expenses]);
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    setExporting(true);
    try {
      const csv = buildPaymentRecordCsv({
        expenses,
        week,
        owner,
        generatedOn: new Date().toISOString().slice(0, 10),
      });
      await triggerBlobDownload({
        blob: new Blob([csv], { type: "text/csv;charset=utf-8" }),
        filename: paymentRecordFilename(week.start),
      });
    } finally {
      setExporting(false);
    }
  }

  const reviewCount = rows.filter((row) => row.invoiceStatus !== "covered" || row.differenceCents > 0).length;

  return (
    <section className="expense-organizer-view">
      <header className="expense-organizer-head">
        <div><strong>实际付款记录</strong><p>一行一笔实际付款；屏幕、CSV 和打印共用同一份付款数据。</p></div>
        <div className="expense-organizer-actions">
          <button className="ghost-button" type="button" onClick={onRefresh}><RefreshCw size={16} />刷新</button>
          <button className="ghost-button" type="button" onClick={exportCsv} disabled={exporting || rows.length === 0}><Download size={16} />{exporting ? "导出中" : "导出表格"}</button>
          <button className="primary-button" type="button" onClick={onOpenPrint} disabled={rows.length === 0}><Printer size={16} />打印实际付款记录</button>
        </div>
      </header>

      <section className="expense-organizer-summary" aria-label="付款核对摘要">
        <span><small>费用记录</small><strong>{summary.expenseCount} 条</strong></span>
        <span><small>实际付款</small><strong>{summary.paymentCount} 笔</strong></span>
        <span><small>付款凭证</small><strong>{summary.paymentProofCount} 张</strong></span>
        <span><small>申报金额</small><strong>{formatCny(summary.reimbursementCents)}</strong></span>
        <span><small>实际支付</small><strong>{formatCny(summary.actualPaidCents)}</strong></span>
        <span className={summary.actualPaidCents !== summary.reimbursementCents ? "warning" : "success"}><small>付款核对差额</small><strong>{formatCny(Math.abs(summary.actualPaidCents - summary.reimbursementCents))}</strong><em>{reviewCount ? `${reviewCount} 笔待人工确认` : "已核对"}</em></span>
      </section>

      <div className="expense-table-scroll organizer-table-scroll">
        <table className="expense-data-table expense-payment-table">
          <thead><tr><th>账单 / 付款</th><th>发生 / 支付时间</th><th>分类</th><th>事由与收款方</th><th>实付金额</th><th>计入报销</th><th>付款主体/方式</th><th>付款凭证</th><th>票据覆盖</th><th>核对状态</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.paymentId}>
                <td className="expense-payment-id"><strong>{row.expenseReferenceCode || "—"}</strong><small>付款 {row.paymentIndex + 1}</small></td>
                <td><strong>{row.occurredOn}</strong><small>{row.paidAtLabel}</small></td>
                <td><span className={`expense-category-pill ${row.category}`}>{row.categoryLabel}</span></td>
                <td><strong>{row.purpose}</strong><small>{row.merchant || "未填写收款方"}</small></td>
                <td className="expense-money">{row.amountLabel}</td>
                <td className="expense-money">{row.reimbursementLabel}</td>
                <td><strong>{row.fundingPaymentLabel}</strong><small>{row.accountLabel}</small></td>
                <td><div className="expense-inline-proofs">{row.proofAttachments.slice(0, 2).map((attachment) => <InlineProof key={attachment.id} attachment={attachment} getAttachmentUrl={getAttachmentUrl} />)}{row.proofAttachments.length === 0 ? <span><ImageOff size={14} />未上传</span> : null}{row.proofAttachments.length > 2 ? <em>+{row.proofAttachments.length - 2}</em> : null}</div></td>
                <td><span className={`expense-status ${row.invoiceStatus}`}>{row.invoiceStatusLabel}</span></td>
                <td>{row.invoiceStatus === "covered" && row.differenceCents === 0 ? <span className="expense-review-state success"><CheckCircle2 size={14} />已核对</span> : <span className="expense-review-state warning"><CircleAlert size={14} />{row.differenceCents ? row.differenceLabel : "待人工确认"}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="expense-empty-state"><CircleAlert size={24} /><strong>本周还没有实际付款记录</strong><p>点击“记一笔”录入费用后，付款明细会显示在这里。</p></div> : null}
      </div>

      {rows.length ? <footer className="expense-organizer-total"><strong>合计（{rows.length} 笔）</strong><span>实付 {formatCny(summary.actualPaidCents)}</span><span>计入报销 {formatCny(summary.reimbursementCents)}</span><span className={reviewCount ? "warning" : "success"}>{reviewCount ? `待核对 ${reviewCount} 笔` : "全部已核对"}</span></footer> : null}
    </section>
  );
}
