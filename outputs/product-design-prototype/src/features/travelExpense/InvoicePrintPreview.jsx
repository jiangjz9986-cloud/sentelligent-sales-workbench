import {
  ArrowLeft,
  Check,
  FileText,
  Image,
  Printer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import {
  paginateInvoicePrint,
  printWhenImagesReady,
} from "./travelExpenseExport.js";
import {
  isTravelExpenseImage,
  isTravelExpensePdf,
} from "./travelExpenseDocument.js";
import { formatCny } from "./travelExpenseModel.js";

function invoiceMeta(invoice) {
  return [
    invoice.invoiceNumber ? `发票号码 ${invoice.invoiceNumber}` : "发票号码待复核",
    invoice.issuedOn || "日期待复核",
    Number.isSafeInteger(invoice.totalCents) ? formatCny(invoice.totalCents) : "金额待复核",
  ].join(" · ");
}

function InvoiceSlot({ invoice, slotNumber, getInvoiceContentUrl, getInvoiceContentResponse, onPdfStatusChange }) {
  if (!invoice) {
    return (
      <figure className="invoice-print-slot is-empty" aria-label={`第 ${slotNumber} 个空白版位`}>
        <span>空白版位</span>
        <small>本页不足四张时保留固定尺寸</small>
      </figure>
    );
  }

  const contentUrl = getInvoiceContentUrl(invoice.id);
  const image = isTravelExpenseImage(invoice);
  const pdf = isTravelExpensePdf(invoice);
  return (
    <figure className="invoice-print-slot">
      <div className="invoice-print-media">
        {image ? <img src={contentUrl} alt={invoice.fileName} /> : null}
        {pdf ? (
          <AuthenticatedPdfFrame
            resourceKey={invoice.id}
            loadPdf={({ signal }) => getInvoiceContentResponse(invoice.id, { signal })}
            title={`${invoice.fileName} PDF 发票预览`}
            renderWidth={1440}
            onStatusChange={(status) => onPdfStatusChange(invoice.id, status)}
          />
        ) : null}
        {!image && !pdf ? <div className="invoice-print-file-fallback"><FileText size={42} aria-hidden="true" /><strong>发票文件</strong><span>{invoice.fileName}</span></div> : null}
      </div>
      <figcaption>
        <strong>{slotNumber}. {invoice.fileName}</strong>
        <span>{invoiceMeta(invoice)}</span>
      </figcaption>
    </figure>
  );
}

function InvoicePage({ page, week, owner, getInvoiceContentUrl, getInvoiceContentResponse, onPdfStatusChange }) {
  return (
    <article className="expense-print-sheet invoice-print-sheet">
      <header className="invoice-print-page-head">
        <div><span>森特智行 · 差旅报销</span><h2>发票原件四联打印</h2></div>
        <dl><div><dt>报销人</dt><dd>{owner || "—"}</dd></div><div><dt>自然周</dt><dd>{week.start}—{week.end}</dd></div></dl>
      </header>
      <div className="invoice-print-grid">
        {page.slots.map((invoice, index) => (
          <InvoiceSlot
            key={invoice?.id ?? `empty-${page.pageNumber}-${index}`}
            invoice={invoice}
            slotNumber={((page.pageNumber - 1) * 4) + index + 1}
            getInvoiceContentUrl={getInvoiceContentUrl}
            getInvoiceContentResponse={getInvoiceContentResponse}
            onPdfStatusChange={onPdfStatusChange}
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
  const [pdfStatuses, setPdfStatuses] = useState({});
  const pages = useMemo(() => paginateInvoicePrint(invoices), [invoices]);
  const imageCount = invoices.filter(isTravelExpenseImage).length;
  const pdfCount = invoices.filter(isTravelExpensePdf).length;
  const pdfIds = useMemo(() => invoices.filter(isTravelExpensePdf).map((invoice) => invoice.id), [invoices]);
  const pdfsReady = pdfIds.every((invoiceId) => pdfStatuses[invoiceId] === "ready");
  const pdfLoadFailed = pdfIds.some((invoiceId) => pdfStatuses[invoiceId] === "error");

  const handlePdfStatusChange = useCallback((invoiceId, status) => {
    setPdfStatuses((current) => current[invoiceId] === status
      ? current
      : { ...current, [invoiceId]: status });
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function printDocument() {
    if (!pdfsReady) {
      setPrintError(pdfLoadFailed
        ? "PDF 发票加载失败，请在对应版位重新加载后再打印。"
        : "PDF 发票正在加载，请稍后再打印。");
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
        <button className="primary-button" type="button" onClick={printDocument} disabled={printing || pages.length === 0 || !pdfsReady}><Printer size={16} />{printing ? "准备打印" : !pdfsReady ? "加载 PDF" : "打印"}</button>
      </header>
      {printError ? <div className="expense-page-alert no-print" role="alert"><span>{printError}</span><button className="ghost-button" type="button" onClick={printDocument} disabled={printing}>重新检查并打印</button></div> : null}

      <div className="expense-print-layout invoice-print-layout">
        <aside className="expense-print-settings no-print">
          <section><strong>记录范围</strong><span>{week.start}—{week.end}</span></section>
          <section><strong>文件构成</strong><ul><li><Image size={14} />图片 {imageCount} 份</li><li><FileText size={14} />PDF {pdfCount} 份</li></ul></section>
          <section><strong>打印规则</strong><ul><li><Check size={14} />A4 横向</li><li><Check size={14} />每页 2×2 固定四槽</li><li><Check size={14} />不足四张保留空槽</li><li><Check size={14} />原件不裁切、不拉伸</li></ul></section>
          <section><strong>打印汇总</strong><dl><div><dt>发票</dt><dd>{invoices.length} 份</dd></div><div><dt>预计页数</dt><dd>{pages.length} 页</dd></div></dl></section>
        </aside>

        <div className="expense-print-document invoice-print-document">
          {pages.map((page) => <InvoicePage key={page.pageNumber} page={page} week={week} owner={owner} getInvoiceContentUrl={getInvoiceContentUrl} getInvoiceContentResponse={getInvoiceContentResponse} onPdfStatusChange={handlePdfStatusChange} />)}
          {pages.length === 0 ? <div className="invoice-print-empty" role="status"><FileText size={24} /><strong>本周暂无已匹配发票</strong><span>返回发票管理完成匹配后再打印。</span></div> : null}
        </div>
      </div>
    </section>
  );
}
