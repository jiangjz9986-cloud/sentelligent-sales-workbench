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
  electronic_invoice: "电子",
  substitute_invoice: "替票",
  no_invoice: "无票确认",
  invoice_pending: "待补",
});

const EXPENSE_LIST_PURPOSE_LABELS = Object.freeze({
  breakfast: "餐费",
  lunch: "餐费",
  dinner: "餐费",
  lodging: "住宿",
  transport: "交通",
  hospitality: "招待",
  other: "其他",
});

/**
 * The reimbursement list is an intentionally small, user-confirmed contract.
 * Internal ledger fields remain available in the Web product, but exporters
 * must not append them to this list.
 */
export const EXPENSE_LIST_COLUMNS = Object.freeze([
  Object.freeze({ id: "sequence", label: "序号", kind: "integer" }),
  Object.freeze({ id: "date", label: "日期", kind: "text" }),
  Object.freeze({ id: "purpose", label: "用途", kind: "text" }),
  Object.freeze({ id: "amount", label: "金额", kind: "currency" }),
  Object.freeze({ id: "paymentRecord", label: "付款记录", kind: "thumbnail_stack" }),
  Object.freeze({ id: "invoice", label: "发票", kind: "text" }),
  Object.freeze({ id: "notes", label: "备注", kind: "text" }),
]);

export const EXPENSE_LIST_FORMAT_CAPABILITIES = Object.freeze({
  xlsx: Object.freeze({ standardOutput: true, embedsPaymentRecordThumbnails: true }),
  pdf: Object.freeze({ standardOutput: true, embedsPaymentRecordThumbnails: true }),
  print: Object.freeze({ standardOutput: true, embedsPaymentRecordThumbnails: true }),
  csv: Object.freeze({
    standardOutput: false,
    embedsPaymentRecordThumbnails: false,
    notice: "CSV 仅供数据交换，不能嵌入付款凭证缩略图，不作为最终标准费用清单。",
  }),
});

const PAYMENT_RECORD_THUMBNAIL_POLICY = Object.freeze({
  format: "image/jpeg",
  fit: "contain",
  maxWidthPx: 360,
  maxHeightPx: 240,
  quality: 0.72,
  stripMetadata: true,
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

function safeAddCents(total, amount, name) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of cents`);
  }
  const next = total + amount;
  if (!Number.isSafeInteger(next)) throw new RangeError(`${name} exceeds the safe integer range`);
  return next;
}

function buildPaymentRecordCell(paymentProofs = []) {
  if (!Array.isArray(paymentProofs)) throw new TypeError("paymentProofs must be an array");
  const thumbnails = paymentProofs.map((attachment, index) => {
    const attachmentId = String(attachment?.id ?? "").trim();
    if (!attachmentId) throw new TypeError("payment proof attachment id is required");
    return {
      attachmentId,
      lineNumber: index + 1,
      altText: `付款凭证 ${index + 1}/${paymentProofs.length}`,
      thumbnailPolicy: PAYMENT_RECORD_THUMBNAIL_POLICY,
    };
  });
  return {
    type: "thumbnail_stack",
    thumbnails,
    missing: thumbnails.length === 0,
  };
}

function expenseListPurposeLabel(row) {
  return EXPENSE_LIST_PURPOSE_LABELS[row.categoryId]
    ?? (String(row.visible.category ?? "").trim() || "其他");
}

function expenseListNotes(row) {
  // The user-confirmed manual sheet keeps the specific what-for text (purpose,
  // merchant, companions) in the 备注 column while 用途 stays a category word,
  // so the remark assembles the existing purpose and notes fields.
  const pieces = [];
  for (const value of [row.source?.purpose, row.source?.notes]) {
    const text = String(value ?? "").trim();
    if (text && !pieces.includes(text)) pieces.push(text);
  }
  return pieces.join("；");
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
      purposeLabel: expenseListPurposeLabel(row),
      // Kept as a compatibility alias while the existing print component is
      // migrated to the user-confirmed “用途” header.
      categoryLabel: expenseListPurposeLabel(row),
      amountCents: row.visible.amountCents,
      amountLabel: formatCny(row.visible.amountCents),
      paymentRecord: buildPaymentRecordCell(row.visible.paymentProofs),
      paymentProofLabel: row.visible.paymentProofs.length > 0
        ? `${row.visible.paymentProofs.length} 张`
        : "未上传",
      invoiceLabel: stateLabels.join("、") || "待补",
      // Kept as a compatibility alias for the existing print renderer.
      invoiceStatusLabel: stateLabels.join("、") || "待补",
      notes: expenseListNotes(row),
    };
  });
}

function expenseListMonthDay(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  if (!match) return null;
  return `${Number(match[2])}.${Number(match[3])}`;
}

/**
 * Builds the user-confirmed sheet title `M.D-M.D<城市顿号列表>出差费用清单`,
 * e.g. `8.17-8.21济宁、东营出差费用清单`. The date range covers the actual
 * expense occurrence dates (falling back to the natural week when the list is
 * empty) and the city list comes from the week's responsible-region profile.
 */
export function buildExpenseListTitle({ expenses = [], week = null, regionProfile = null } = {}) {
  if (!Array.isArray(expenses)) throw new TypeError("expenses must be an array");
  const dates = expenses
    .flatMap((expense) => [expense?.occurredOn, expense?.endedOn ?? expense?.occurredEndOn])
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")))
    .sort();
  const start = dates[0] ?? week?.start;
  const end = dates.at(-1) ?? week?.end ?? start;
  const startLabel = expenseListMonthDay(start);
  const endLabel = expenseListMonthDay(end);
  const rangeLabel = startLabel && endLabel ? `${startLabel}-${endLabel}` : "";
  const cities = Array.isArray(regionProfile?.cities)
    ? [...new Set(regionProfile.cities.map((city) => String(city ?? "").trim()).filter(Boolean))]
    : [];
  return `${rangeLabel}${cities.join("、")}出差费用清单`;
}

export function buildExpenseListTotals(rows = [], { matches = [] } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  const includedExpenseIds = new Set(rows.map((row) => row?.expenseId).filter(Boolean));
  const expenseTotalCents = rows.reduce((total, row) => (
    safeAddCents(total, row?.amountCents, "expenseTotalCents")
  ), 0);
  const substituteInvoiceTotalCents = matches.reduce((total, match) => {
    if (match?.state !== "confirmed" || match?.matchMethod !== "rule_candidate") return total;
    if (!includedExpenseIds.has(match.expenseId)) return total;
    return safeAddCents(total, match.allocatedCents, "substituteInvoiceTotalCents");
  }, 0);
  return {
    expenseTotalTitle: "费用合计",
    expenseTotalCents,
    expenseTotalLabel: formatCny(expenseTotalCents),
    substituteInvoiceTotalTitle: "替票合计金额",
    substituteInvoiceTotalCents,
    substituteInvoiceTotalLabel: formatCny(substituteInvoiceTotalCents),
  };
}

/**
 * Produces the renderer-neutral reimbursement list used by Web preview, Excel,
 * PDF and print generators. Only `cells` defines visible columns; IDs and layout
 * hints are non-printing metadata. Payment proof descriptors intentionally keep
 * only attachment IDs plus compression policy, so file names, original URLs and
 * storage metadata never enter the export model.
 */
export function buildExpenseListExport({ expenses = [], context = {}, week = null, regionProfile = null } = {}) {
  const rows = buildExpenseListRows(expenses, context);
  return {
    schemaVersion: 1,
    title: buildExpenseListTitle({ expenses, week, regionProfile }),
    columns: EXPENSE_LIST_COLUMNS,
    rows: rows.map((row) => {
      const physicalRowCount = Math.max(1, row.paymentRecord.thumbnails.length);
      return {
        expenseId: row.expenseId,
        physicalRowCount,
        mergeCellIds: physicalRowCount > 1
          ? ["sequence", "date", "purpose", "amount", "invoice", "notes"]
          : [],
        cells: {
          sequence: { type: "integer", value: row.sequence },
          date: { type: "text", value: row.dateLabel },
          purpose: { type: "text", value: row.purposeLabel },
          amount: { type: "currency", cents: row.amountCents, label: row.amountLabel },
          paymentRecord: row.paymentRecord,
          invoice: { type: "text", value: row.invoiceLabel },
          notes: { type: "text", value: row.notes },
        },
      };
    }),
    totals: buildExpenseListTotals(rows, context),
    formatCapabilities: EXPENSE_LIST_FORMAT_CAPABILITIES,
  };
}

export function expenseListFilename(weekStart, format = "pdf") {
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new TypeError("weekStart must use YYYY-MM-DD format");
  }
  if (format !== "pdf" && format !== "xlsx") {
    throw new TypeError("expense list format must be pdf or xlsx");
  }
  return `费用清单-${weekStart}.${format}`;
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

function normalizeExpenseListPrintRow(row, logicalRowIndex) {
  if (row?.cells && typeof row.cells === "object" && !Array.isArray(row.cells)) return row;
  if (!row?.paymentRecord || !Array.isArray(row.paymentRecord.thumbnails)) {
    throw new TypeError(`expense list row ${logicalRowIndex + 1} cells are required`);
  }
  return {
    ...row,
    physicalRowCount: row.physicalRowCount
      ?? Math.max(1, row.paymentRecord.thumbnails.length),
    cells: {
      sequence: { type: "integer", value: row.sequence },
      date: { type: "text", value: row.dateLabel },
      purpose: { type: "text", value: row.purposeLabel ?? row.categoryLabel },
      amount: { type: "currency", cents: row.amountCents, label: row.amountLabel },
      paymentRecord: row.paymentRecord,
      invoice: { type: "text", value: row.invoiceLabel ?? row.invoiceStatusLabel },
      notes: { type: "text", value: row.notes },
    },
  };
}

/**
 * Paginates the strict seven-column list by rendered table rows rather than by
 * logical expenses. Each payment proof occupies one physical E-column row. The
 * other six cells are rendered once per same-page segment with `rowSpan`; when
 * an expense crosses a page boundary those cells are repeated at the start of
 * the next page segment.
 *
 * `totalCents` deliberately counts a logical expense only on its first physical
 * row. Consumers may therefore sum all page totals without double-counting an
 * expense whose proofs span multiple pages.
 */
export function paginateExpenseList({ rows = [], rowsPerPage = 18 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  if (!Number.isSafeInteger(rowsPerPage) || rowsPerPage < 1) {
    throw new TypeError("rowsPerPage must be a positive integer");
  }

  const draftPages = [];
  let pageRows = [];
  let pageTotalCents = 0;

  const finishPage = () => {
    if (pageRows.length === 0) return;
    draftPages.push({ rows: pageRows, totalCents: pageTotalCents });
    pageRows = [];
    pageTotalCents = 0;
  };

  rows.forEach((sourceRow, logicalRowIndex) => {
    if (!sourceRow || typeof sourceRow !== "object" || Array.isArray(sourceRow)) {
      throw new TypeError(`expense list row ${logicalRowIndex + 1} is invalid`);
    }
    const row = normalizeExpenseListPrintRow(sourceRow, logicalRowIndex);
    const expenseId = String(row.expenseId ?? "").trim();
    if (!expenseId) throw new TypeError(`expense list row ${logicalRowIndex + 1} expenseId is required`);
    if (!row.cells || typeof row.cells !== "object" || Array.isArray(row.cells)) {
      throw new TypeError(`expense list row ${logicalRowIndex + 1} cells are required`);
    }
    const paymentRecord = row.cells.paymentRecord;
    if (!paymentRecord || !Array.isArray(paymentRecord.thumbnails)) {
      throw new TypeError(`expense list row ${logicalRowIndex + 1} paymentRecord is invalid`);
    }
    const thumbnails = paymentRecord.thumbnails;
    const physicalRowCount = Math.max(1, thumbnails.length);
    if (row.physicalRowCount !== undefined && row.physicalRowCount !== physicalRowCount) {
      throw new TypeError(`expense list row ${logicalRowIndex + 1} physicalRowCount is invalid`);
    }
    const amountCents = row.cells.amount?.cents;
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw new TypeError(`expense list row ${logicalRowIndex + 1} amount is invalid`);
    }

    // Keep a normal-sized expense together when it can fit on a clean page.
    // Only an expense that is itself taller than the page capacity must be
    // split; this avoids needlessly repeating its six shared cells.
    const remainingRows = rowsPerPage - pageRows.length;
    if (
      pageRows.length > 0
      && physicalRowCount <= rowsPerPage
      && physicalRowCount > remainingRows
    ) {
      finishPage();
    }

    let expenseRowOffset = 0;
    while (expenseRowOffset < physicalRowCount) {
      if (pageRows.length === rowsPerPage) finishPage();
      const segmentRowCount = Math.min(
        rowsPerPage - pageRows.length,
        physicalRowCount - expenseRowOffset,
      );
      const continuedFromPreviousPage = expenseRowOffset > 0;
      const continuesOnNextPage = expenseRowOffset + segmentRowCount < physicalRowCount;

      for (let segmentOffset = 0; segmentOffset < segmentRowCount; segmentOffset += 1) {
        const expensePhysicalRowIndex = expenseRowOffset + segmentOffset;
        const countsTowardTotal = expensePhysicalRowIndex === 0;
        const thumbnail = thumbnails[expensePhysicalRowIndex] ?? null;
        const rendersSharedCells = segmentOffset === 0;
        const amountContributionCents = countsTowardTotal ? amountCents : 0;
        pageRows.push({
          key: `${expenseId}:${logicalRowIndex + 1}:${expensePhysicalRowIndex + 1}`,
          expenseId,
          cells: row.cells,
          amountCents,
          amountContributionCents,
          countsTowardTotal,
          physicalRowNumber: expensePhysicalRowIndex + 1,
          physicalRowCount,
          paymentRecord: {
            missing: thumbnails.length === 0,
            thumbnail,
          },
          sharedCells: {
            render: rendersSharedCells,
            rowSpan: rendersSharedCells ? segmentRowCount : 0,
            continuedFromPreviousPage: rendersSharedCells && continuedFromPreviousPage,
            continuesOnNextPage: rendersSharedCells && continuesOnNextPage,
          },
        });
        if (countsTowardTotal) {
          pageTotalCents = safeAddCents(pageTotalCents, amountCents, "expense list page total");
        }
      }

      expenseRowOffset += segmentRowCount;
      if (pageRows.length === rowsPerPage) finishPage();
    }
  });
  finishPage();

  const totalPages = draftPages.length;
  return draftPages.map((page, index) => ({
    kind: "expense-list",
    pageNumber: index + 1,
    totalPages,
    physicalRowCount: page.rows.length,
    rows: page.rows,
    totalCents: page.totalCents,
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
