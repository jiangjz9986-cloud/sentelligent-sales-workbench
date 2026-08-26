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
  buildExpenseListExport,
  buildPaymentRecordCsv,
  buildPaymentRecordRows,
  paymentRecordFilename,
} from "./travelExpenseExport.js";
import { buildExpenseListXlsxBlob } from "./expenseListXlsx.js";
import { createPaymentProofThumbnail } from "./paymentProofThumbnail.js";
import { isTravelExpensePdf } from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

export const EXPENSE_LIST_THUMBNAIL_CONCURRENCY = 2;

export async function mapWithBoundedConcurrency(
  items,
  mapper,
  concurrency = EXPENSE_LIST_THUMBNAIL_CONCURRENCY,
) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (typeof mapper !== "function") throw new TypeError("mapper must be a function");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive safe integer");
  }

  const results = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;

  async function runWorker() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (failed) throw firstError;
  return results;
}

function naturalWeekFilename(week) {
  const start = String(week?.start ?? "").trim();
  const end = String(week?.end ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new TypeError("自然周必须包含 YYYY-MM-DD 格式的开始和结束日期");
  }
  return `费用清单-${start}至${end}.xlsx`;
}

export function collectExpenseListAttachmentIds(expenseList) {
  if (!Array.isArray(expenseList?.rows)) {
    throw new TypeError("费用清单数据无效");
  }
  const attachmentIds = [];
  const seen = new Set();
  for (const row of expenseList.rows) {
    const thumbnails = row?.cells?.paymentRecord?.thumbnails;
    if (!Array.isArray(thumbnails)) throw new TypeError("费用清单付款记录数据无效");
    for (const thumbnail of thumbnails) {
      const attachmentId = String(thumbnail?.attachmentId ?? "").trim();
      if (!attachmentId) throw new TypeError("付款凭证附件编号缺失");
      if (seen.has(attachmentId)) continue;
      seen.add(attachmentId);
      attachmentIds.push(attachmentId);
    }
  }
  return attachmentIds;
}

export async function downloadExpenseListXlsx({
  expenses,
  week,
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentContentResponse,
}, {
  createThumbnail = createPaymentProofThumbnail,
  buildWorkbook = buildExpenseListXlsxBlob,
  download = triggerBlobDownload,
  now = () => new Date(),
} = {}) {
  const expenseList = buildExpenseListExport({
    expenses,
    context: { matches, noInvoiceConfirmations },
  });
  if (expenseList.rows.length === 0) {
    throw new Error("暂无已确认费用，暂不能导出费用清单。");
  }

  const attachmentIds = collectExpenseListAttachmentIds(expenseList);
  if (attachmentIds.length > 0 && typeof getAttachmentContentResponse !== "function") {
    throw new Error("付款凭证读取接口未就绪，费用清单未生成。");
  }

  // Keep at most two source blobs and thumbnail conversions active together.
  // Results retain the first-seen attachment order, and workers settle before
  // the first error is rethrown so a partial workbook can never be downloaded.
  const thumbnailPairs = await mapWithBoundedConcurrency(
    attachmentIds,
    async (attachmentId, index) => {
      const response = await getAttachmentContentResponse(attachmentId);
      if (!response?.ok || typeof response.blob !== "function") {
        throw new Error(`第 ${index + 1} 张付款凭证读取失败（HTTP ${response?.status ?? "unknown"}），费用清单未生成。`);
      }
      const source = await response.blob();
      const thumbnail = await createThumbnail(source, { output: "uint8array" });
      if (!(thumbnail instanceof Uint8Array) || thumbnail.byteLength === 0) {
        throw new Error(`第 ${index + 1} 张付款凭证缩略图生成失败，费用清单未生成。`);
      }
      return [attachmentId, thumbnail];
    },
    EXPENSE_LIST_THUMBNAIL_CONCURRENCY,
  );

  const createdAt = now();
  const blob = buildWorkbook({
    expenseList,
    thumbnailImages: new Map(thumbnailPairs),
    createdAt,
  });
  await download({
    blob,
    filename: naturalWeekFilename(week),
  });
  return { expenseList, attachmentCount: attachmentIds.length };
}

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
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentUrl,
  getAttachmentContentResponse,
  onOpenExpenseListPrint = () => {},
  onOpenPrint,
  onRefresh,
}) {
  const rows = useMemo(() => buildPaymentRecordRows(expenses), [expenses]);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");

  async function exportXlsx() {
    setExporting("xlsx");
    setExportError("");
    try {
      await downloadExpenseListXlsx({
        expenses,
        week,
        matches,
        noInvoiceConfirmations,
        getAttachmentContentResponse,
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "费用清单 Excel 导出失败，请稍后重试。");
    } finally {
      setExporting("");
    }
  }

  async function exportCsv() {
    setExporting("csv");
    setExportError("");
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
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "付款明细 CSV 导出失败，请稍后重试。");
    } finally {
      setExporting("");
    }
  }

  const reviewCount = rows.filter((row) => row.invoiceStatus !== "covered" || row.differenceCents > 0).length;

  return (
    <section className="expense-organizer-view">
      <header className="expense-organizer-head">
        <div><strong>实际付款记录</strong><p>一行一笔实际付款；屏幕、CSV 和打印共用同一份付款数据。</p></div>
        <div className="expense-organizer-actions">
          <button className="ghost-button" type="button" onClick={onRefresh}><RefreshCw size={16} />刷新</button>
          <button className="primary-button" type="button" onClick={() => void exportXlsx()} disabled={Boolean(exporting) || expenses.length === 0}><Download size={16} />{exporting === "xlsx" ? "生成 Excel 中" : "导出费用清单 Excel"}</button>
          <button className="ghost-button" type="button" onClick={() => void exportCsv()} disabled={Boolean(exporting) || rows.length === 0}><Download size={16} />{exporting === "csv" ? "导出 CSV 中" : "导出付款明细 CSV"}</button>
          <button className="ghost-button" type="button" onClick={onOpenExpenseListPrint} disabled={rows.length === 0}><FileText size={16} />打印费用清单</button>
          <button className="primary-button" type="button" onClick={onOpenPrint} disabled={rows.length === 0}><Printer size={16} />打印实际付款记录</button>
        </div>
      </header>

      {exportError ? <p className="expense-callout error" role="alert">{exportError}</p> : null}

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
