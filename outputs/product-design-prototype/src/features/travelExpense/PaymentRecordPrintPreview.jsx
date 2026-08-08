import {
  ArrowLeft,
  Check,
  FileText,
  Image,
  Printer,
  Rows3,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import {
  buildPaymentRecordRows,
  paginatePaymentRecord,
  printWhenImagesReady,
} from "./travelExpenseExport.js";
import { isTravelExpensePdf } from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

function PrintProof({ attachment, getAttachmentUrl }) {
  if (isTravelExpensePdf(attachment)) {
    return <span className="expense-print-pdf-inline" title={attachment.fileName}><FileText size={10} aria-hidden="true" /><strong>PDF</strong></span>;
  }
  return <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} />;
}

function DetailPage({ page, owner, week, itineraryLabel, generatedOn, getAttachmentUrl, totals }) {
  return (
    <article className="expense-print-sheet">
      <header className="expense-print-title"><h2>实际付款记录表</h2><dl><div><dt>报销人</dt><dd>{owner || "—"}</dd></div><div><dt>自然周</dt><dd>{week.start}—{week.end}</dd></div><div><dt>行程 / 说明</dt><dd>{itineraryLabel || "本周差旅"}</dd></div><div><dt>生成日期</dt><dd>{generatedOn}</dd></div></dl></header>
      <table className="expense-print-table">
        <thead><tr><th>序号</th><th>付款日期时间</th><th>类别</th><th>用途 / 收款方</th><th>实付金额</th><th>计入报销</th><th>资金来源</th><th>付款凭证</th><th>票据覆盖</th><th>差额 / 备注</th></tr></thead>
        <tbody>{page.rows.map((row) => <tr className="expense-print-row" key={row.paymentId}><td>{row.sequence}</td><td>{row.paidAtLabel}</td><td>{row.categoryLabel}</td><td><strong>{row.purpose}</strong><small>{row.expenseReferenceCode || "账单编号待补充"}</small><small>{row.merchant || "—"}</small></td><td>{row.amountLabel}</td><td>{row.reimbursementLabel}</td><td><strong>{row.fundingLabel}</strong><small>{row.paymentMethod} · {row.accountLabel}</small></td><td><div className="expense-print-proofs">{row.inlineAttachments.map((attachment) => <PrintProof key={attachment.id} attachment={attachment} getAttachmentUrl={getAttachmentUrl} />)}{row.proofAttachmentCount === 0 ? <span>未上传</span> : row.proofAppendixPageNumbers.length > 0 ? <span>见凭证附页 {row.proofAppendixPageNumbers.map((pageNumber) => `P${pageNumber}`).join("、")}</span> : <span>已上传 {row.proofAttachmentCount} 份</span>}</div></td><td>{row.invoiceStatusLabel}</td><td>{row.differenceLabel}{row.notes ? <small>{row.notes}</small> : null}</td></tr>)}</tbody>
      </table>
      <div className="expense-print-totals"><span>本页 {page.rows.length} 笔</span><strong>实付合计：{formatCny(totals.actualPaidCents)}</strong><strong>计入报销：{formatCny(totals.reimbursementCents)}</strong><strong className="warning">付款核对差额：{formatCny(Math.abs(totals.actualPaidCents - totals.reimbursementCents))}</strong></div>
      <footer className="expense-print-footer"><span>{week.start}—{week.end} · 第 {page.pageNumber}/{page.totalPages} 页</span><span>报销人签名：________________</span><span>日期：____________</span></footer>
    </article>
  );
}

function AttachmentPage({ page, week, getAttachmentUrl, getAttachmentContentResponse, onPdfStatusChange }) {
  return (
    <article className="expense-print-sheet expense-attachment-sheet">
      <header className="expense-print-title"><h2>付款凭证附页</h2><p>{week.start}—{week.end} · 第 {page.pageNumber}/{page.totalPages} 页</p></header>
      <div className="expense-print-attachment-grid">
        {page.attachments.map((attachment) => (
          <figure key={attachment.id}>
            {isTravelExpensePdf(attachment) ? (
              <AuthenticatedPdfFrame
                resourceKey={attachment.id}
                loadPdf={({ signal }) => getAttachmentContentResponse(attachment.id, { signal })}
                title={`${attachment.fileName} PDF 付款凭证预览`}
                renderAllPages
                renderWidth={1440}
                className="expense-print-pdf-canvas"
                onStatusChange={(status) => onPdfStatusChange(attachment.id, status)}
              />
            ) : <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} />}
            <figcaption><strong>{attachment.fileName}</strong>{attachment.paymentReferences.map((reference) => <span key={reference.paymentId}>付款 {reference.paymentNumber}：{reference.paidAtLabel} · {formatCny(reference.amountCents)}</span>)}<span>附件：{attachment.imageIndex}/{attachment.imageCount}</span></figcaption>
          </figure>
        ))}
      </div>
      <footer className="expense-print-footer"><span>凭证附页</span><span>第 {page.pageNumber}/{page.totalPages} 页</span></footer>
    </article>
  );
}

export function PaymentRecordPrintPreview({
  expenses,
  summary,
  week,
  owner,
  itineraryLabel,
  getAttachmentUrl,
  getAttachmentContentResponse,
  onClose,
}) {
  const [mode, setMode] = useState("with_proofs");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const rows = useMemo(() => buildPaymentRecordRows(expenses), [expenses]);
  const pages = useMemo(() => paginatePaymentRecord({ rows, mode, rowsPerPage: 9, attachmentsPerPage: 4 }), [mode, rows]);
  const pdfIds = useMemo(() => [...new Set(pages.attachmentPages.flatMap((page) => page.attachments
    .filter(isTravelExpensePdf)
    .map((attachment) => attachment.id)))], [pages]);
  const pdfScope = pdfIds.join("|");
  const [pdfState, setPdfState] = useState({ scope: "", statuses: {} });
  const pdfStatuses = pdfState.scope === pdfScope ? pdfState.statuses : {};
  const pdfsReady = pdfIds.every((attachmentId) => pdfStatuses[attachmentId] === "ready");
  const pdfLoadFailed = pdfIds.some((attachmentId) => pdfStatuses[attachmentId] === "error");
  const generatedOn = new Date().toISOString().slice(0, 10);

  const handlePdfStatusChange = useCallback((attachmentId, status) => {
    setPdfState((current) => {
      const statuses = current.scope === pdfScope ? current.statuses : {};
      if (statuses[attachmentId] === status) return current;
      return { scope: pdfScope, statuses: { ...statuses, [attachmentId]: status } };
    });
  }, [pdfScope]);

  function changeMode(nextMode) {
    setPdfState({ scope: "", statuses: {} });
    setPrintError("");
    setMode(nextMode);
  }

  async function printDocument() {
    if (!pdfsReady) {
      setPrintError(pdfLoadFailed
        ? "PDF 付款凭证加载失败，请在对应凭证上重新加载后再打印。"
        : "PDF 付款凭证正在加载，请稍后再打印。");
      return;
    }
    setPrinting(true);
    setPrintError("");
    try {
      await printWhenImagesReady({ documentRef: document, print: () => window.print() });
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "付款凭证加载失败，请检查后重新打印。");
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className="expense-print-preview" data-testid="expense-print-preview">
      <header className="expense-print-preview-toolbar no-print">
        <div><button className="ghost-button" type="button" onClick={onClose}><ArrowLeft size={16} />返回报销整理</button><div><strong>实际付款记录表</strong><span>报销整理 / 打印预览</span></div></div>
        <button className="primary-button" type="button" onClick={printDocument} disabled={printing || pages.detailPages.length === 0 || !pdfsReady}><Printer size={16} />{printing ? "准备打印" : !pdfsReady ? "加载 PDF" : "打印"}</button>
      </header>
      {printError ? <div className="expense-page-alert no-print" role="alert"><span>{printError}</span><button className="ghost-button" type="button" onClick={printDocument} disabled={printing}>重新检查并打印</button></div> : null}
      {pdfLoadFailed && !printError ? <div className="expense-page-alert no-print" role="alert"><span>PDF 付款凭证加载失败，请在失败凭证上点击“重新加载”，成功后才可打印。</span></div> : null}

      <div className="expense-print-layout">
        <aside className="expense-print-settings no-print">
          <section><strong>记录范围</strong><span>{week.start}—{week.end}</span></section>
          <section><strong>打印内容</strong><label><input type="radio" name="print-mode" checked={mode === "with_proofs"} onChange={() => changeMode("with_proofs")} /><Image size={16} />含凭证附件</label><label><input type="radio" name="print-mode" checked={mode === "compact"} onChange={() => changeMode("compact")} /><Rows3 size={16} />紧凑无图</label></section>
          <section><strong>打印规则</strong><ul><li><Check size={14} />A4 横向</li><li><Check size={14} />付款行不跨页</li><li><Check size={14} />每页重复表头</li><li><Check size={14} />账号末四位脱敏</li></ul></section>
          <section><strong>数据汇总</strong><dl><div><dt>费用</dt><dd>{summary.expenseCount} 条</dd></div><div><dt>付款</dt><dd>{summary.paymentCount} 笔</dd></div><div><dt>凭证</dt><dd>{summary.paymentProofCount} 份</dd></div><div><dt>预计页数</dt><dd>{pages.detailPages.length + pages.attachmentPages.length} 页</dd></div></dl></section>
        </aside>

        <div className="expense-print-document">
          {pages.detailPages.map((page) => <DetailPage key={`detail-${page.pageNumber}`} page={page} owner={owner} week={week} itineraryLabel={itineraryLabel} generatedOn={generatedOn} getAttachmentUrl={getAttachmentUrl} totals={summary} />)}
          {pages.attachmentPages.map((page) => <AttachmentPage key={`attachment-${page.pageNumber}`} page={page} week={week} getAttachmentUrl={getAttachmentUrl} getAttachmentContentResponse={getAttachmentContentResponse} onPdfStatusChange={handlePdfStatusChange} />)}
        </div>
      </div>
    </section>
  );
}
