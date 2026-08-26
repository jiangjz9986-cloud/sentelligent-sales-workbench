import {
  ArrowLeft,
  Check,
  Printer,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  buildExpenseListExport,
  paginateExpenseList,
  printWhenImagesReady,
} from "./travelExpenseExport.js";
import { createPaymentProofThumbnail } from "./paymentProofThumbnail.js";

function PaymentRecordCell({ paymentRecord, thumbnailUrls }) {
  if (paymentRecord.missing) return <span className="expense-list-payment-missing">未上传</span>;
  const thumbnail = paymentRecord.thumbnail;
  const source = thumbnailUrls[thumbnail.attachmentId];
  return source ? (
    <div className="expense-list-payment-thumbnails">
      <figure className="expense-list-payment-thumbnail">
        <img src={source} alt={thumbnail.altText} />
      </figure>
    </div>
  ) : <span className="expense-list-payment-loading">缩略图准备中</span>;
}

export function ExpenseListPage({ page, week, owner, generatedOn, totals, thumbnailUrls }) {
  const isLastPage = page.pageNumber === page.totalPages;
  return (
    <article className="expense-list-print-sheet" data-page-number={page.pageNumber}>
      <header className="expense-list-print-title">
        <h2>费用清单</h2>
        <dl>
          <div><dt>报销人</dt><dd>{owner || "—"}</dd></div>
          <div><dt>自然周</dt><dd>{week.start}—{week.end}</dd></div>
          <div><dt>生成日期</dt><dd>{generatedOn}</dd></div>
        </dl>
      </header>
      <table className="expense-list-print-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>日期</th>
            <th>用途</th>
            <th>金额</th>
            <th>付款记录</th>
            <th>发票</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr
              key={row.key}
              data-expense-id={row.expenseId}
              data-physical-row={row.physicalRowNumber}
              data-continued={row.sharedCells.continuedFromPreviousPage || undefined}
            >
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.sequence.value}</td> : null}
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.date.value}</td> : null}
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.purpose.value}</td> : null}
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.amount.label}</td> : null}
              <td><PaymentRecordCell paymentRecord={row.paymentRecord} thumbnailUrls={thumbnailUrls} /></td>
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.invoice.value}</td> : null}
              {row.sharedCells.render ? <td rowSpan={row.sharedCells.rowSpan}>{row.cells.notes.value}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {isLastPage ? (
        <dl className="expense-list-print-totals">
          <div><dt>{totals.expenseTotalTitle}</dt><dd>{totals.expenseTotalLabel}</dd></div>
          <div><dt>{totals.substituteInvoiceTotalTitle}</dt><dd>{totals.substituteInvoiceTotalLabel}</dd></div>
        </dl>
      ) : <div />}
      <footer className="expense-print-footer">
        <span>严格七列输出 · 付款记录使用压缩且去元数据的预览图</span>
        <span>第 {page.pageNumber}/{page.totalPages} 页</span>
      </footer>
    </article>
  );
}

export function ExpenseListPrintPreview({
  expenses,
  week,
  owner,
  matches,
  noInvoiceConfirmations,
  getAttachmentContentResponse,
  onClose,
}) {
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [thumbnailState, setThumbnailState] = useState({ status: "idle", urls: {}, error: "" });
  const [thumbnailAttempt, setThumbnailAttempt] = useState(0);
  const exportModel = useMemo(() => buildExpenseListExport({
    expenses,
    context: { matches, noInvoiceConfirmations },
  }), [expenses, matches, noInvoiceConfirmations]);
  const pages = useMemo(() => paginateExpenseList({ rows: exportModel.rows, rowsPerPage: 9 }), [exportModel]);
  const physicalRowCount = useMemo(() => pages.reduce((total, page) => (
    total + page.physicalRowCount
  ), 0), [pages]);
  const attachmentIds = useMemo(() => [...new Set(exportModel.rows.flatMap((row) => (
    row.cells.paymentRecord.thumbnails.map((thumbnail) => thumbnail.attachmentId)
  )))], [exportModel]);
  const attachmentKey = attachmentIds.join("|");
  const generatedOn = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const objectUrls = [];
    if (attachmentIds.length === 0) {
      setThumbnailState({ status: "ready", urls: {}, error: "" });
      return () => controller.abort();
    }
    if (typeof getAttachmentContentResponse !== "function") {
      setThumbnailState({ status: "error", urls: {}, error: "付款凭证读取接口未就绪。" });
      return () => controller.abort();
    }
    setThumbnailState({ status: "loading", urls: {}, error: "" });
    void (async () => {
      const pairs = [];
      // Generate sequentially. Besides bounding memory, this guarantees that
      // a failed proof cannot leave later object URLs detached from cleanup.
      for (const attachmentId of attachmentIds) {
        if (controller.signal.aborted) return;
        const response = await getAttachmentContentResponse(attachmentId, { signal: controller.signal });
        if (!response?.ok) throw new Error(`付款凭证读取失败（HTTP ${response?.status ?? "unknown"}）`);
        const original = await response.blob();
        if (controller.signal.aborted) return;
        const thumbnail = await createPaymentProofThumbnail(original);
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(thumbnail);
        objectUrls.push(objectUrl);
        pairs.push([attachmentId, objectUrl]);
      }
      if (!controller.signal.aborted) {
        setThumbnailState({ status: "ready", urls: Object.fromEntries(pairs), error: "" });
      }
    })().catch((error) => {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
      setThumbnailState({
        status: "error",
        urls: {},
        error: error instanceof Error ? error.message : "付款凭证缩略图生成失败。",
      });
    });
    return () => {
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  // attachmentKey is the stable primitive dependency for the attachment ID set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentKey, getAttachmentContentResponse, thumbnailAttempt]);

  async function printDocument() {
    setPrinting(true);
    setPrintError("");
    try {
      if (pages.length === 0) throw new Error("暂无已确认费用，暂不能打印费用清单。");
      if (attachmentIds.length > 0 && thumbnailState.status !== "ready") {
        throw new Error(thumbnailState.error || "付款凭证缩略图仍在准备，请稍后再打印。");
      }
      await printWhenImagesReady({
        documentRef: document,
        selector: ".expense-list-payment-thumbnail img",
        print: () => window.print(),
        errorMessage: "付款记录缩略图加载失败，请重新生成后打印。",
      });
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "费用清单打印失败，请稍后重试。");
    } finally {
      setPrinting(false);
    }
  }

  const thumbnailBusy = attachmentIds.length > 0 && thumbnailState.status !== "ready";
  const thumbnailLoading = thumbnailState.status === "loading";
  return (
    <section className="expense-list-print-preview" data-testid="expense-list-print-preview">
      <header className="expense-print-preview-toolbar expense-list-print-toolbar no-print">
        <div><button className="ghost-button" type="button" onClick={onClose}><ArrowLeft size={16} />返回报销输出</button><div><strong>费用清单</strong><span>报销输出 / A4 纵向预览</span></div></div>
        <button className="primary-button" type="button" onClick={() => void printDocument()} disabled={printing || thumbnailBusy || pages.length === 0}><Printer size={16} />{thumbnailLoading ? "准备凭证" : printing ? "准备打印" : "打印费用清单"}</button>
      </header>
      {printError || thumbnailState.error ? <div className="expense-page-alert no-print" role="alert"><span>{printError || thumbnailState.error}</span><button className="ghost-button" type="button" onClick={() => { setPrintError(""); setThumbnailAttempt((value) => value + 1); }} disabled={printing || thumbnailLoading}>重新生成付款记录</button></div> : null}
      <div className="expense-print-layout expense-list-print-layout">
        <aside className="expense-print-settings no-print">
          <section><strong>记录范围</strong><span>{week.start}—{week.end}</span></section>
          <section><strong>固定七列</strong><ul><li><Check size={14} />序号、日期、用途、金额</li><li><Check size={14} />付款记录、发票、备注</li></ul></section>
          <section><strong>付款记录</strong><ul><li><Check size={14} />单元格直接显示压缩图片</li><li><Check size={14} />360×240、JPEG 0.72</li><li><Check size={14} />重新编码并清除原图元数据</li></ul></section>
          <section><strong>数据汇总</strong><dl><div><dt>费用</dt><dd>{exportModel.rows.length} 条</dd></div><div><dt>付款记录行</dt><dd>{physicalRowCount} 行</dd></div><div><dt>预计页数</dt><dd>{pages.length} 页</dd></div></dl></section>
        </aside>
        <div className="expense-list-print-document">
          {pages.map((page) => <ExpenseListPage key={page.pageNumber} page={page} week={week} owner={owner} generatedOn={generatedOn} totals={exportModel.totals} thumbnailUrls={thumbnailState.urls} />)}
          {pages.length === 0 ? <div className="expense-empty-state"><strong>本周暂无已确认费用</strong><p>返回费用账本录入费用后再输出。</p></div> : null}
        </div>
      </div>
    </section>
  );
}
