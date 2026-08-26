import {
  Download,
  FileText,
} from "lucide-react";
import { useState } from "react";

import { triggerBlobDownload } from "../../downloadFile.js";
import { buildExpenseListExport } from "./travelExpenseExport.js";
import { buildExpenseListXlsxBlob } from "./expenseListXlsx.js";
import { createPaymentProofThumbnail } from "./paymentProofThumbnail.js";

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


export function ReimbursementOrganizer({
  expenses,
  week,
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentContentResponse,
  onOpenExpenseListPrint = () => {},
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  async function exportXlsx() {
    setExporting(true);
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
      setExporting(false);
    }
  }

  return (
    <section className="expense-reimbursement-actions" data-testid="ledger-reimbursement-actions">
      <div><strong>打印 / 导出</strong><p>账本是唯一费用视图；这里仅生成严格七列费用清单。</p></div>
      <div>
        <button className="ghost-button" type="button" onClick={onOpenExpenseListPrint} disabled={expenses.length === 0}><FileText size={16} />打印费用清单</button>
        <button className="primary-button" type="button" onClick={() => void exportXlsx()} disabled={exporting || expenses.length === 0}><Download size={16} />{exporting ? "生成 Excel 中" : "导出费用清单 Excel"}</button>
      </div>
      {exportError ? <p className="expense-callout error" role="alert">{exportError}</p> : null}
    </section>
  );
}
