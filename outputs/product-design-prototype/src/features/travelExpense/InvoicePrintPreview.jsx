import {
  ArrowLeft,
  Check,
  FileText,
  Image,
  Printer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import { AuthenticatedImageFrame } from "./AuthenticatedImageFrame.jsx";
import { loadAuthenticatedPdfBlob } from "./authenticatedPdf.js";
import {
  expandInvoicePrintItems,
  paginateInvoicePrint,
  printWhenImagesReady,
} from "./travelExpenseExport.js";
import {
  isTravelExpenseImage,
  isTravelExpensePdf,
} from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

let pdfRuntimePromise;

function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, workerModule]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfJs;
    }).catch((error) => {
      pdfRuntimePromise = undefined;
      const runtimeError = new Error("PDF 页数读取组件加载失败，请重新加载页面。");
      runtimeError.name = "PdfRuntimeLoadError";
      runtimeError.cause = error;
      throw runtimeError;
    });
  }
  return pdfRuntimePromise;
}

async function readPdfPageCount(loadPdf, { signal } = {}) {
  const blob = await loadAuthenticatedPdfBlob(loadPdf, { signal });
  const [pdfJs, buffer] = await Promise.all([
    loadPdfRuntime(),
    blob.arrayBuffer(),
  ]);
  if (signal?.aborted) {
    const error = new Error("PDF 页数读取已取消");
    error.name = "AbortError";
    throw error;
  }

  const loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) });
  let documentProxy;
  try {
    documentProxy = await loadingTask.promise;
    const pageCount = documentProxy.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new Error("PDF 没有可打印的页面。");
    }
    return pageCount;
  } finally {
    if (documentProxy) await documentProxy.destroy();
    else await loadingTask.destroy();
  }
}

function invoiceMeta(invoice) {
  return [
    invoice.invoiceNumber ? `发票号码 ${invoice.invoiceNumber}` : "发票号码待复核",
    invoice.issuedOn || "日期待复核",
    Number.isSafeInteger(invoice.totalCents) ? formatCny(invoice.totalCents) : "金额待复核",
  ].join(" · ");
}

function InvoiceSlot({ printItem, slotNumber, getInvoiceContentUrl, getInvoiceContentResponse, onMediaStatusChange, onPdfPageCount }) {
  if (!printItem) {
    return (
      <figure className="invoice-print-slot is-empty" aria-label={`第 ${slotNumber} 个空白版位`}>
        <span>空白版位</span>
        <small>本页不足四张时保留固定尺寸</small>
      </figure>
    );
  }

  const invoice = printItem.invoice ?? printItem;
  const pageNumber = Number.isSafeInteger(printItem.pageNumber) ? printItem.pageNumber : null;
  const pageCount = Number.isSafeInteger(printItem.pageCount) ? printItem.pageCount : null;
  const image = isTravelExpenseImage(invoice);
  const pdf = isTravelExpensePdf(invoice);
  const pdfResourceKey = `${invoice.id}:${pageNumber ?? 1}`;
  return (
    <figure className="invoice-print-slot">
      <div className="invoice-print-media">
        {image && typeof getInvoiceContentResponse === "function" ? (
          <AuthenticatedImageFrame
            resourceKey={`${invoice.id}:image`}
            loadImage={({ signal }) => getInvoiceContentResponse(invoice.id, { signal, accept: "application/pdf,image/*" })}
            title={invoice.fileName}
            variant="print"
            onStatusChange={(status) => onMediaStatusChange(`${invoice.id}:image`, status)}
          />
        ) : null}
        {image && typeof getInvoiceContentResponse !== "function" ? <img src={getInvoiceContentUrl(invoice.id)} alt={invoice.fileName} /> : null}
        {pdf ? (
          <AuthenticatedPdfFrame
            resourceKey={pdfResourceKey}
            loadPdf={({ signal }) => getInvoiceContentResponse(invoice.id, { signal })}
            pageNumber={pageNumber ?? 1}
            title={`${invoice.fileName} PDF 发票第 ${pageNumber ?? 1} 页`}
            renderWidth={1440}
            onPageCountChange={(count) => onPdfPageCount(invoice.id, count)}
            onStatusChange={(status) => onMediaStatusChange(pdfResourceKey, status)}
          />
        ) : null}
        {!image && !pdf ? <div className="invoice-print-file-fallback"><FileText size={42} aria-hidden="true" /><strong>发票文件</strong><span>{invoice.fileName}</span></div> : null}
      </div>
      <figcaption>
        <strong>{slotNumber}. {invoice.fileName}</strong>
        <span>{invoiceMeta(invoice)}{pdf && pageCount ? ` · 第 ${pageNumber}/${pageCount} 页` : ""}</span>
      </figcaption>
    </figure>
  );
}

function InvoicePage({ page, week, owner, getInvoiceContentUrl, getInvoiceContentResponse, onMediaStatusChange, onPdfPageCount }) {
  return (
    <article className="expense-print-sheet invoice-print-sheet">
      <header className="invoice-print-page-head">
        <div><span>森特智行 · 差旅报销</span><h2>发票原件四联打印</h2></div>
        <dl><div><dt>报销人</dt><dd>{owner || "—"}</dd></div><div><dt>自然周</dt><dd>{week.start}—{week.end}</dd></div></dl>
      </header>
      <div className="invoice-print-grid">
        {page.slots.map((printItem, index) => (
          <InvoiceSlot
            key={printItem ? `${printItem.invoice?.id ?? printItem.id}:${printItem.pageNumber ?? 1}` : `empty-${page.pageNumber}-${index}`}
            printItem={printItem}
            slotNumber={((page.pageNumber - 1) * 4) + index + 1}
            getInvoiceContentUrl={getInvoiceContentUrl}
            getInvoiceContentResponse={getInvoiceContentResponse}
            onMediaStatusChange={onMediaStatusChange}
            onPdfPageCount={onPdfPageCount}
          />
        ))}
      </div>
      <footer className="expense-print-footer invoice-print-footer">
        <span>每页固定四个版位 · 原件按比例完整显示</span>
        <span>第 {page.pageNumber}/{page.totalPages} 页</span>
      </footer>
    </article>
  );
}

export function InvoicePrintPreview({
  invoices,
  week,
  owner,
  getInvoiceContentUrl,
  getInvoiceContentResponse,
  onClose,
}) {
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [mediaStatuses, setMediaStatuses] = useState({});
  const imageCount = invoices.filter(isTravelExpenseImage).length;
  const pdfCount = invoices.filter(isTravelExpensePdf).length;
  const pdfInvoices = useMemo(() => invoices.filter(isTravelExpensePdf), [invoices]);
  const pdfIds = useMemo(() => pdfInvoices.map((invoice) => invoice.id), [pdfInvoices]);
  const [pdfPageCounts, setPdfPageCounts] = useState({});
  const [pdfPageCountStatuses, setPdfPageCountStatuses] = useState({});
  const [pdfPageCountAttempt, setPdfPageCountAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const activeIds = new Set(pdfIds);
    setPdfPageCounts((current) => Object.fromEntries(
      Object.entries(current).filter(([invoiceId]) => activeIds.has(invoiceId)),
    ));
    setPdfPageCountStatuses((current) => Object.fromEntries(
      pdfIds.map((invoiceId) => [invoiceId, current[invoiceId] === "ready" ? "ready" : "loading"]),
    ));

    if (typeof getInvoiceContentResponse !== "function") {
      setPdfPageCountStatuses(Object.fromEntries(pdfIds.map((invoiceId) => [invoiceId, "error"])));
      return () => controller.abort();
    }

    pdfInvoices.forEach((invoice) => {
      if (Number.isSafeInteger(pdfPageCounts[invoice.id]) && pdfPageCounts[invoice.id] > 0) return;
      void readPdfPageCount(
        ({ signal }) => getInvoiceContentResponse(invoice.id, { signal }),
        { signal: controller.signal },
      ).then((pageCount) => {
        if (controller.signal.aborted) return;
        setPdfPageCounts((current) => ({ ...current, [invoice.id]: pageCount }));
        setPdfPageCountStatuses((current) => ({ ...current, [invoice.id]: "ready" }));
      }).catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setPdfPageCountStatuses((current) => current[invoice.id] === "ready"
          ? current
          : { ...current, [invoice.id]: "error" });
      });
    });

    return () => controller.abort();
  // pdfPageCounts is intentionally read as a snapshot: once a count is stored,
  // the effect must not restart and fetch the same protected PDF again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getInvoiceContentResponse, pdfIds, pdfInvoices, pdfPageCountAttempt]);

  const printablePageCounts = useMemo(() => Object.fromEntries(
    pdfInvoices.map((invoice) => [
      invoice.id,
      Number.isSafeInteger(pdfPageCounts[invoice.id]) && pdfPageCounts[invoice.id] > 0
        ? pdfPageCounts[invoice.id]
        : 1,
    ]),
  ), [pdfInvoices, pdfPageCounts]);
  const printItems = useMemo(
    () => expandInvoicePrintItems(invoices, printablePageCounts),
    [invoices, printablePageCounts],
  );
  const pages = useMemo(() => paginateInvoicePrint(printItems), [printItems]);
  const pdfPageKeys = useMemo(
    () => printItems
      .filter((item) => Number.isSafeInteger(item.pageNumber))
      .map((item) => `${item.invoice.id}:${item.pageNumber}`),
    [printItems],
  );
  const pdfPageCountsReady = pdfIds.every((invoiceId) => (
    pdfPageCountStatuses[invoiceId] === "ready"
      && Number.isSafeInteger(pdfPageCounts[invoiceId])
      && pdfPageCounts[invoiceId] > 0
  ));
  const imageKeys = useMemo(
    () => typeof getInvoiceContentResponse === "function" ? printItems
      .filter((item) => !Number.isSafeInteger(item.pageNumber))
      .map((item) => `${item.invoice.id}:image`) : [],
    [getInvoiceContentResponse, printItems],
  );
  const mediaReady = pdfPageCountsReady
    && pdfPageKeys.every((key) => mediaStatuses[key] === "ready")
    && imageKeys.every((key) => mediaStatuses[key] === "ready");
  // Kept as a descriptive compatibility alias for the existing print QA
  // contract; readiness now covers both PDF canvases and image variants.
  const pdfsReady = mediaReady;
  const pdfPageCountFailed = pdfIds.some((invoiceId) => pdfPageCountStatuses[invoiceId] === "error");
  const mediaRenderFailed = pdfPageKeys.some((key) => mediaStatuses[key] === "error")
    || imageKeys.some((key) => mediaStatuses[key] === "error");
  const pdfLoadFailed = pdfPageCountFailed || mediaRenderFailed;

  function retryPdfPageCounts() {
    setPrintError("");
    setPdfPageCountAttempt((current) => current + 1);
  }

  const handleMediaStatusChange = useCallback((resourceKey, status) => {
    setMediaStatuses((current) => current[resourceKey] === status
      ? current
      : { ...current, [resourceKey]: status });
  }, []);

  const handlePdfPageCount = useCallback((invoiceId, pageCount) => {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) return;
    setPdfPageCounts((current) => current[invoiceId] === pageCount
      ? current
      : { ...current, [invoiceId]: pageCount });
    setPdfPageCountStatuses((current) => current[invoiceId] === "ready"
      ? current
      : { ...current, [invoiceId]: "ready" });
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function printDocument() {
    if (!mediaReady) {
      setPrintError(pdfLoadFailed
        ? "发票原件加载失败，请在对应版位重新加载后再打印。"
        : "发票原件正在加载，请稍后再打印。");
      return;
    }
    setPrinting(true);
    setPrintError("");
    try {
      await printWhenImagesReady({
        documentRef: document,
        print: () => window.print(),
        selector: ".invoice-print-document img",
        errorMessage: "发票原件加载失败，请检查文件后重新打印。",
        minNaturalWidth: 480,
        minNaturalHeight: 300,
      });
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "发票原件加载失败，请检查文件后重新打印。");
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className="expense-print-preview invoice-print-preview" data-testid="invoice-print-preview">
      <header className="expense-print-preview-toolbar invoice-print-preview-toolbar no-print">
        <div><button className="ghost-button" type="button" onClick={onClose}><ArrowLeft size={16} />返回发票管理</button><div><strong>发票四联打印</strong><span>发票管理 / A4 横向预览</span></div></div>
        <button className="primary-button" type="button" onClick={printDocument} disabled={printing || pages.length === 0 || !pdfsReady}><Printer size={16} />{printing ? "准备打印" : !pdfsReady ? (pdfCount ? "加载 PDF" : "加载图片") : "打印"}</button>
      </header>
      {printError ? <div className="expense-page-alert no-print" role="alert"><span>{printError}</span><button className="ghost-button" type="button" onClick={pdfPageCountFailed ? retryPdfPageCounts : printDocument} disabled={printing}>{pdfPageCountFailed ? "重新读取 PDF" : "重新检查并打印"}</button></div> : null}

      <div className="expense-print-layout invoice-print-layout">
        <aside className="expense-print-settings no-print">
          <section><strong>记录范围</strong><span>{week.start}—{week.end}</span></section>
          <section><strong>文件构成</strong><ul><li><Image size={14} />图片 {imageCount} 份</li><li><FileText size={14} />PDF {pdfCount} 份{pdfCount && !pdfPageCountsReady ? "（正在读取页数）" : ""}</li></ul></section>
          <section><strong>打印规则</strong><ul><li><Check size={14} />A4 横向</li><li><Check size={14} />每页 2×2 固定四槽</li><li><Check size={14} />不足四张保留空槽</li><li><Check size={14} />PDF 每页按顺序占一个槽</li><li><Check size={14} />原件不裁切、不拉伸</li><li><Check size={14} />图片低于 480×300 时停止自动打印</li></ul></section>
          <section><strong>打印汇总</strong><dl><div><dt>发票</dt><dd>{invoices.length} 份</dd></div><div><dt>打印页</dt><dd>{printItems.length ? printItems.length : "读取中"}</dd></div><div><dt>A4 页数</dt><dd>{pages.length || "读取中"}</dd></div></dl></section>
        </aside>

        <div className="expense-print-document invoice-print-document">
          {pages.map((page) => <InvoicePage key={page.pageNumber} page={page} week={week} owner={owner} getInvoiceContentUrl={getInvoiceContentUrl} getInvoiceContentResponse={getInvoiceContentResponse} onMediaStatusChange={handleMediaStatusChange} onPdfPageCount={handlePdfPageCount} />)}
          {pages.length === 0 ? <div className="invoice-print-empty" role="status"><FileText size={24} /><strong>{pdfCount && !pdfPageCountsReady ? (pdfLoadFailed ? "PDF 页数读取失败" : "正在读取 PDF 页数") : "本周暂无已匹配发票"}</strong><span>{pdfCount && !pdfPageCountsReady ? (pdfLoadFailed ? "请重新读取后再继续打印。" : "读取完成后将按每页一个版位展开。") : "返回发票管理完成匹配后再打印。"}</span>{pdfLoadFailed ? <button className="ghost-button" type="button" onClick={retryPdfPageCounts}>重新读取 PDF</button> : null}</div> : null}
        </div>
      </div>
    </section>
  );
}
