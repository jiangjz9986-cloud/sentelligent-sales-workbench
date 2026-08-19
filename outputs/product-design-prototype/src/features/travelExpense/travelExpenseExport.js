import {
  buildExpenseLedgerRows,
  flattenPaymentRows,
  formatCny,
  formatTravelExpenseDateTime,
} from "./travelExpenseModel.js";

const PAYMENT_METHOD_LABELS = Object.freeze({
  wechat: "微信支付",
  alipay: "支付宝",
  card: "银行卡",
  cash: "现金",
  other: "其他",
});

const INVOICE_STATUS_LABELS = Object.freeze({
  pending: "待人工确认",
  covered: "已覆盖",
  partial: "部分覆盖",
  missing: "缺少票据",
});

const EXPENSE_INVOICE_STATE_LABELS = Object.freeze({
  electronic_invoice: "电子发票",
  substitute_invoice: "替票",
  no_invoice: "无票",
  invoice_pending: "待补发票",
});

function csvCell(value) {
  const rawText = String(value ?? "");
  const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildPaymentRecordRows(expenses = []) {
  return flattenPaymentRows(expenses).map((row, index) => ({
    ...row,
    sequence: index + 1,
    paidAtLabel: formatTravelExpenseDateTime(row.paidAt),
    purposeMerchantLabel: [row.purpose, row.merchant].filter(Boolean).join("/") || "待补充",
    amountLabel: formatCny(row.amountCents),
    reimbursementLabel: formatCny(row.reimbursementCents),
    fundingPaymentLabel: `${row.fundingLabel}/${PAYMENT_METHOD_LABELS[row.paymentMethod] ?? PAYMENT_METHOD_LABELS.other}`,
    accountLabel: row.accountLast4 ? `尾号 ${String(row.accountLast4).slice(-4)}` : "未记录",
    invoiceStatusLabel: INVOICE_STATUS_LABELS[row.invoiceStatus] ?? INVOICE_STATUS_LABELS.pending,
    differenceLabel: row.differenceCents > 0
      ? `${formatCny(row.differenceCents)} · ${row.differenceReason || "待人工确认"}`
      : "无差额",
  }));
}

export function buildPaymentRecordCsv({ expenses = [], week, generatedOn, owner = "" } = {}) {
  const rows = buildPaymentRecordRows(expenses);
  const headers = [
    "序号",
    "账单编号",
    "发生日期",
    "实际支付日期/时间",
    "分类",
    "费用事由/收款方",
    "实付金额",
    "计入报销",
    "付款主体/方式",
    "付款账号",
    "票据覆盖",
    "差额/说明",
    "备注",
    "报销人",
    "自然周",
    "生成日期",
  ];
  const weekLabel = week?.start && week?.end ? `${week.start}—${week.end}` : "待补充";
  const body = rows.map((row) => [
    row.sequence,
    row.expenseReferenceCode,
    row.occurredOn,
    row.paidAtLabel,
    row.categoryLabel,
    row.purposeMerchantLabel,
    (row.amountCents / 100).toFixed(2),
    (row.reimbursementCents / 100).toFixed(2),
    row.fundingPaymentLabel,
    row.accountLabel,
    row.invoiceStatusLabel,
    row.differenceLabel,
    row.notes,
    owner || "待补充",
    weekLabel,
    generatedOn || "待补充",
  ]);
  return `\uFEFF${[headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function paymentRecordFilename(weekStart) {
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new TypeError("weekStart must use YYYY-MM-DD format");
  }
  return `实际付款记录-${weekStart}.csv`;
}

export function buildExpenseListRows(expenses = [], context = {}) {
  return buildExpenseLedgerRows(expenses, context).map((row, index) => {
    const stateLabels = row.visible.invoiceStates
      .map((state) => EXPENSE_INVOICE_STATE_LABELS[state.id] ?? state.label)
      .filter(Boolean);
    return {
      sequence: index + 1,
      expenseId: row.id,
      referenceCode: row.referenceCode,
      dateLabel: row.visible.date,
      categoryLabel: row.visible.category,
      amountCents: row.visible.amountCents,
      amountLabel: formatCny(row.visible.amountCents),
      paymentProofLabel: row.visible.paymentProofs.length > 0
        ? `${row.visible.paymentProofs.length} 张`
        : "未上传",
      invoiceStatusLabel: stateLabels.join("、") || "待补发票",
      notes: row.visible.notes,
    };
  });
}

export function expenseListFilename(weekStart) {
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new TypeError("weekStart must use YYYY-MM-DD format");
  }
  return `费用清单-${weekStart}.pdf`;
}

function chunk(items, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError("page size must be positive");
  const pages = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages;
}

const PRINT_IMAGE_ERROR_MESSAGE = "付款凭证加载失败，请检查网络或凭证文件后重新打印。";

function waitForPrintImage(image, errorMessage, { minNaturalWidth = 0, minNaturalHeight = 0 } = {}) {
  if (image.complete) {
    if (image.naturalWidth === 0) return Promise.reject(new Error(errorMessage));
    if (image.naturalWidth < minNaturalWidth || image.naturalHeight < minNaturalHeight) {
      return Promise.reject(new Error(
        `${errorMessage}（原图分辨率不足 ${minNaturalWidth}×${minNaturalHeight}，系统未覆盖原件）`,
      ));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      image.removeEventListener?.("load", handleLoad);
      image.removeEventListener?.("error", handleError);
    };
    const handleLoad = () => {
      cleanup();
      if (image.naturalWidth === 0) reject(new Error(errorMessage));
      else if (image.naturalWidth < minNaturalWidth || image.naturalHeight < minNaturalHeight) {
        reject(new Error(
          `${errorMessage}（原图分辨率不足 ${minNaturalWidth}×${minNaturalHeight}，系统未覆盖原件）`,
        ));
      }
      else resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(errorMessage));
    };
    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener("error", handleError, { once: true });
  });
}

export function assessPrintImageResolution({ naturalWidth, naturalHeight, minNaturalWidth = 0, minNaturalHeight = 0 } = {}) {
  if (!Number.isSafeInteger(naturalWidth) || naturalWidth < 1) return "unavailable";
  if (!Number.isSafeInteger(naturalHeight) || naturalHeight < 1) return "unavailable";
  if (!Number.isSafeInteger(minNaturalWidth) || minNaturalWidth < 0) throw new TypeError("minNaturalWidth must be a non-negative integer");
  if (!Number.isSafeInteger(minNaturalHeight) || minNaturalHeight < 0) throw new TypeError("minNaturalHeight must be a non-negative integer");
  return naturalWidth >= minNaturalWidth && naturalHeight >= minNaturalHeight
    ? "ready"
    : "low_resolution";
}

export async function printWhenImagesReady({
  documentRef,
  print,
  selector = ".expense-print-document img",
  errorMessage = PRINT_IMAGE_ERROR_MESSAGE,
  minNaturalWidth = 0,
  minNaturalHeight = 0,
} = {}) {
  if (!documentRef?.querySelectorAll) throw new TypeError("documentRef must support querySelectorAll");
  if (typeof print !== "function") throw new TypeError("print must be a function");
  if (typeof selector !== "string" || !selector.trim()) throw new TypeError("selector must be a non-empty string");
  if (typeof errorMessage !== "string" || !errorMessage.trim()) throw new TypeError("errorMessage must be a non-empty string");
  if (!Number.isSafeInteger(minNaturalWidth) || minNaturalWidth < 0) throw new TypeError("minNaturalWidth must be a non-negative integer");
  if (!Number.isSafeInteger(minNaturalHeight) || minNaturalHeight < 0) throw new TypeError("minNaturalHeight must be a non-negative integer");
  const images = [...documentRef.querySelectorAll(selector)];
  await Promise.all(images.map((image) => waitForPrintImage(image, errorMessage, { minNaturalWidth, minNaturalHeight })));
  print();
}

export function paginateInvoicePrint(invoices = []) {
  if (!Array.isArray(invoices)) throw new TypeError("invoices must be an array");
  const invoicePages = chunk(invoices, 4);
  const totalPages = invoicePages.length;
  return invoicePages.map((pageInvoices, index) => ({
    pageNumber: index + 1,
    totalPages,
    slots: [...pageInvoices, ...Array(4 - pageInvoices.length).fill(null)],
  }));
}

/**
 * Expands a printable invoice list so every PDF page gets its own fixed slot.
 *
 * The original invoice object is kept on each item instead of being copied into
 * the public invoice shape. This keeps the API response lossless while letting
 * the print renderer address a particular PDF page. An image (or a PDF whose
 * page count is not known yet) is never guessed or silently reduced to page 1.
 */
export function expandInvoicePrintItems(invoices = [], pageCounts = {}) {
  if (!Array.isArray(invoices)) throw new TypeError("invoices must be an array");
  if (pageCounts === null || typeof pageCounts !== "object" || Array.isArray(pageCounts)) {
    throw new TypeError("pageCounts must be an object");
  }

  return invoices.flatMap((invoice) => {
    if (!invoice || typeof invoice !== "object") throw new TypeError("invoice must be an object");
    const mediaType = String(invoice.mediaType ?? "").trim().toLowerCase();
    const isPdf = mediaType === "application/pdf"
      || (!mediaType && String(invoice.fileName ?? "").trim().toLowerCase().endsWith(".pdf"));
    if (!isPdf) return [{ invoice, pageNumber: null, pageCount: 1 }];

    const pageCount = pageCounts[invoice.id];
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
    return Array.from({ length: pageCount }, (_, index) => ({
      invoice,
      pageNumber: index + 1,
      pageCount,
    }));
  });
}

export function paginateExpenseList({ rows = [], rowsPerPage = 18 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const pages = chunk(rows, rowsPerPage);
  const totalPages = pages.length;
  return pages.map((pageRows, index) => ({
    kind: "expense-list",
    pageNumber: index + 1,
    totalPages,
    rows: pageRows,
    totalCents: pageRows.reduce((total, row) => {
      const amount = row?.amountCents;
      if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError("expense list amount is invalid");
      const next = total + amount;
      if (!Number.isSafeInteger(next)) throw new RangeError("expense list total exceeds the safe integer range");
      return next;
    }, 0),
  }));
}

export function paginatePaymentRecord({
  rows = [],
  mode = "with_proofs",
  rowsPerPage = 9,
  attachmentsPerPage = 4,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  if (!new Set(["with_proofs", "compact"]).has(mode)) throw new TypeError("print mode is invalid");
  const includeProofs = mode === "with_proofs";
  const attachmentEntriesByKey = new Map();
  const printableRows = rows.map((row) => {
    const proofs = Array.isArray(row.proofAttachments) ? row.proofAttachments : [];
    const proofAttachmentKeys = [];
    if (includeProofs) {
      proofs.forEach((attachment, index) => {
        const attachmentKey = attachment.id ?? `${row.paymentId}-${index}`;
        proofAttachmentKeys.push(attachmentKey);
        let entry = attachmentEntriesByKey.get(attachmentKey);
        if (!entry) {
          entry = {
            ...attachment,
            paymentIds: [],
            paymentReferences: [],
            occurredOn: row.occurredOn,
            amountCents: row.amountCents,
            imageIndex: index + 1,
            imageCount: proofs.length,
          };
          attachmentEntriesByKey.set(attachmentKey, entry);
        }
        const linkedPaymentIds = Array.isArray(attachment.paymentIds)
          ? attachment.paymentIds
          : [row.paymentId];
        entry.paymentIds = [...new Set([...entry.paymentIds, ...linkedPaymentIds, row.paymentId])];
        if (!entry.paymentReferences.some((reference) => reference.paymentId === row.paymentId)) {
          entry.paymentReferences.push({
            paymentId: row.paymentId,
            paymentNumber: row.sequence,
            paidAtLabel: row.paidAtLabel,
            amountCents: row.amountCents,
          });
        }
      });
    }
    return {
      ...row,
      inlineAttachments: includeProofs ? proofs.slice(0, 2) : [],
      proofAttachmentCount: proofs.length,
      proofAttachmentKeys,
    };
  });

  const rawDetailPages = chunk(printableRows, rowsPerPage).map((pageRows, index) => ({
    kind: "details",
    pageIndex: index,
    rows: pageRows,
  }));
  const rawAttachmentPages = includeProofs
    ? chunk([...attachmentEntriesByKey.entries()], attachmentsPerPage).map((attachments, index) => ({
        kind: "attachments",
        pageIndex: rawDetailPages.length + index,
        attachments,
      }))
    : [];
  const totalPages = rawDetailPages.length + rawAttachmentPages.length;
  const appendixPageByAttachmentKey = new Map();
  const attachmentPages = rawAttachmentPages.map((page) => {
    const pageNumber = page.pageIndex + 1;
    return {
      ...page,
      pageNumber,
      totalPages,
      attachments: page.attachments.map(([attachmentKey, attachment]) => {
        appendixPageByAttachmentKey.set(attachmentKey, pageNumber);
        return attachment;
      }),
    };
  });
  const detailPages = rawDetailPages.map((page) => ({
    ...page,
    pageNumber: page.pageIndex + 1,
    totalPages,
    rows: page.rows.map(({ proofAttachmentKeys, ...row }) => ({
      ...row,
      proofAppendixPageNumbers: [...new Set(
        proofAttachmentKeys
          .map((attachmentKey) => appendixPageByAttachmentKey.get(attachmentKey))
          .filter(Number.isSafeInteger),
      )],
    })),
  }));
  return {
    mode,
    detailPages,
    attachmentPages,
  };
}
