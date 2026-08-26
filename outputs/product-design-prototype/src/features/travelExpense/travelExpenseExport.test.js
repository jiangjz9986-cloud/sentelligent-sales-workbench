import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPENSE_LIST_COLUMNS,
  EXPENSE_LIST_FORMAT_CAPABILITIES,
  buildExpenseListExport,
  buildExpenseListRows,
  buildExpenseListTotals,
  buildPaymentRecordCsv,
  buildPaymentRecordRows,
  assessPrintImageResolution,
  expandInvoicePrintItems,
  paginateInvoicePrint,
  paginatePaymentRecord,
  paymentRecordFilename,
  expenseListFilename,
  paginateExpenseList,
  printWhenImagesReady,
} from "./travelExpenseExport.js";

const expenses = [
  {
    id: "expense-1",
    referenceCode: "EXP-20260803-ABC12345",
    occurredOn: "2026-08-03",
    category: "breakfast",
    purpose: "出差早餐, 含饮品",
    merchant: "第一餐厅",
    invoiceStatus: "covered",
    notes: "第一行\n第二行",
    attachments: [
      { id: "attachment-1", kind: "payment_proof", paymentIds: ["payment-1"], contentUrl: "/api/a1" },
      { id: "attachment-2", kind: "payment_proof", paymentIds: ["payment-1"], contentUrl: "/api/a2" },
      { id: "attachment-3", kind: "payment_proof", paymentIds: ["payment-1"], contentUrl: "/api/a3" },
    ],
    payments: [
      {
        id: "payment-1",
        paidAt: "2026-08-03T08:12:00+08:00",
        amountCents: 3100,
        reimbursementCents: 3100,
        fundingSource: "personal",
        paymentMethod: "wechat",
        accountLast4: "1234",
      },
      {
        id: "payment-2",
        paidAt: "2026-08-03T08:15:00+08:00",
        amountCents: 900,
        reimbursementCents: 800,
        fundingSource: "personal",
        paymentMethod: "cash",
        differenceReason: "个人消费不计入报销",
      },
    ],
  },
  {
    id: "expense-2",
    referenceCode: "EXP-20260804-DEF67890",
    occurredOn: "2026-08-04",
    category: "transport",
    purpose: "市内交通",
    merchant: "出租车",
    invoiceStatus: "pending",
    notes: "",
    attachments: [],
    payments: [
      {
        id: "payment-3",
        paidAt: "2026-08-04T09:00:00+08:00",
        amountCents: 2400,
        reimbursementCents: 2400,
        fundingSource: "company",
        paymentMethod: "card",
        accountLast4: "9876",
      },
    ],
  },
];

function expenseWithProofCount({ id, proofCount, amountCents = 1000, occurredOn = "2026-08-05" }) {
  const paymentId = `${id}-payment`;
  return {
    ...expenses[1],
    id,
    referenceCode: `EXP-${id}`,
    occurredOn,
    attachments: Array.from({ length: proofCount }, (_, index) => ({
      id: `${id}-proof-${index + 1}`,
      kind: "payment_proof",
      paymentIds: [paymentId],
    })),
    payments: [{
      ...expenses[1].payments[0],
      id: paymentId,
      amountCents,
      reimbursementCents: amountCents,
    }],
  };
}

function buildPrintableRows(specifications) {
  return buildExpenseListExport({
    expenses: specifications.map((specification) => expenseWithProofCount(specification)),
  }).rows;
}

describe("actual payment record export", () => {
  it("exports one row per actual payment with a UTF-8 BOM", () => {
    const csv = buildPaymentRecordCsv({
      expenses,
      week: { start: "2026-08-03", end: "2026-08-09" },
      generatedOn: "2026-08-04",
      owner: "继振",
    });

    assert.equal(csv.startsWith("\uFEFF"), true);
    assert.match(csv, /账单编号/);
    assert.match(csv, /EXP-20260803-ABC12345/);
    assert.match(csv, /EXP-20260804-DEF67890/);
    assert.match(csv, /实际支付日期\/时间,分类,费用事由\/收款方,实付金额/);
    assert.equal(csv.split("\r\n").filter(Boolean).length, 4);
    assert.match(csv, /"出差早餐, 含饮品\/第一餐厅"/);
    assert.match(csv, /"第一行\n第二行"/);
  });

  it("masks accounts and exposes only the final four digits", () => {
    const rows = buildPaymentRecordRows(expenses);
    assert.equal(rows[0].accountLabel, "尾号 1234");
    assert.equal(rows[2].accountLabel, "尾号 9876");
  });

  it("uses a stable natural-week filename", () => {
    assert.equal(paymentRecordFilename("2026-08-03"), "实际付款记录-2026-08-03.csv");
  });

  it("neutralizes spreadsheet formulas in user-controlled cells", () => {
    const csv = buildPaymentRecordCsv({
      expenses: [{
        ...expenses[1],
        purpose: "=1+1",
        merchant: "危险收款方",
        notes: "+cmd|' /C calc'!A0",
      }],
      week: { start: "2026-08-03", end: "2026-08-09" },
      generatedOn: "2026-08-04",
      owner: "-危险报销人",
    });

    assert.match(csv, /,'=1\+1\/危险收款方,/);
    assert.match(csv, /,'\+cmd\|' \/C calc'!A0,'-危险报销人,/);
  });
});

describe("actual payment print pagination", () => {
  it("keeps payment rows intact and moves extra images to attachment pages", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      ...buildPaymentRecordRows(expenses)[index % 3],
      paymentId: `payment-${index + 1}`,
      proofAttachments: index === 0
        ? [
            { id: "p1", contentUrl: "/p1" },
            { id: "p2", contentUrl: "/p2" },
            { id: "p3", contentUrl: "/p3" },
          ]
        : [],
    }));

    const pages = paginatePaymentRecord({ rows, rowsPerPage: 9, attachmentsPerPage: 4 });

    assert.deepEqual(pages.detailPages.map((page) => page.rows.length), [9, 9, 7]);
    assert.equal(pages.detailPages[0].rows[0].inlineAttachments.length, 2);
    assert.equal(pages.attachmentPages.flatMap((page) => page.attachments).length, 3);
    assert.equal(pages.attachmentPages.every((page) => page.attachments.length <= 4), true);
  });

  it("supports a compact print mode without inline images", () => {
    const rows = buildPaymentRecordRows(expenses);
    const pages = paginatePaymentRecord({ rows, mode: "compact", rowsPerPage: 12 });

    assert.equal(pages.detailPages[0].rows.every((row) => row.inlineAttachments.length === 0), true);
    assert.equal(pages.attachmentPages.length, 0);
  });

  it("prints a proof linked to multiple payments only once in the appendix", () => {
    const shared = { id: "shared", contentUrl: "/shared", paymentIds: ["payment-1", "payment-2"] };
    const rows = [
      { ...buildPaymentRecordRows(expenses)[0], proofAttachments: [shared] },
      { ...buildPaymentRecordRows(expenses)[1], proofAttachments: [shared] },
    ];
    const pages = paginatePaymentRecord({ rows, attachmentsPerPage: 4 });
    assert.equal(pages.attachmentPages.flatMap((page) => page.attachments).length, 1);
    assert.deepEqual(pages.attachmentPages[0].attachments[0].paymentIds, ["payment-1", "payment-2"]);
    assert.deepEqual(pages.attachmentPages[0].attachments[0].paymentReferences, [
      {
        paymentId: "payment-1",
        paymentNumber: 1,
        paidAtLabel: rows[0].paidAtLabel,
        amountCents: 3100,
      },
      {
        paymentId: "payment-2",
        paymentNumber: 2,
        paidAtLabel: rows[1].paidAtLabel,
        amountCents: 900,
      },
    ]);
    assert.equal(pages.attachmentPages[0].pageNumber, 2);
    assert.deepEqual(pages.detailPages[0].rows.map((row) => row.proofAppendixPageNumbers), [[2], [2]]);
  });

  it("does not print failed proof images and allows a successful retry", async () => {
    const { printWhenImagesReady } = await import("./travelExpenseExport.js");
    assert.equal(typeof printWhenImagesReady, "function");
    let printCalls = 0;
    let images = [{ complete: true, naturalWidth: 0 }];
    const documentRef = {
      querySelectorAll: () => images,
    };
    const print = () => {
      printCalls += 1;
    };

    await assert.rejects(
      printWhenImagesReady({ documentRef, print }),
      /付款凭证加载失败/,
    );
    assert.equal(printCalls, 0);

    images = [{ complete: true, naturalWidth: 640 }];
    await printWhenImagesReady({ documentRef, print });
    assert.equal(printCalls, 1);
  });
});

describe("invoice print pagination", () => {
  it("expands every PDF page into an ordered fixed-slot print item", () => {
    const invoices = [
      { id: "pdf-1", fileName: "multi-page.pdf", mediaType: "application/pdf" },
      { id: "image-1", fileName: "receipt.png", mediaType: "image/png" },
      { id: "pdf-2", fileName: "unknown-pages.pdf", mediaType: "application/pdf" },
    ];

    const items = expandInvoicePrintItems(invoices, { "pdf-1": 3 });

    assert.deepEqual(items.map((item) => [item.invoice.id, item.pageNumber, item.pageCount]), [
      ["pdf-1", 1, 3],
      ["pdf-1", 2, 3],
      ["pdf-1", 3, 3],
      ["image-1", null, 1],
    ]);
    assert.equal(items.some((item) => item.invoice.id === "pdf-2"), false);
  });

  it("keeps four fixed invoice slots on every landscape A4 page", () => {
    const invoices = Array.from({ length: 5 }, (_, index) => ({
      id: `invoice-${index + 1}`,
      fileName: `invoice-${index + 1}.pdf`,
      mediaType: "application/pdf",
    }));

    const pages = paginateInvoicePrint(invoices);

    assert.equal(pages.length, 2);
    assert.equal(pages.every((page) => page.slots.length === 4), true);
    assert.deepEqual(pages[0].slots.map((invoice) => invoice?.id ?? null), [
      "invoice-1",
      "invoice-2",
      "invoice-3",
      "invoice-4",
    ]);
    assert.deepEqual(pages[1].slots.map((invoice) => invoice?.id ?? null), [
      "invoice-5",
      null,
      null,
      null,
    ]);
    assert.deepEqual(pages.map((page) => [page.pageNumber, page.totalPages]), [[1, 2], [2, 2]]);
  });

  it("uses an invoice-specific image selector and recoverable load error", async () => {
    let selector = "";
    const documentRef = {
      querySelectorAll(value) {
        selector = value;
        return [{ complete: true, naturalWidth: 0 }];
      },
    };

    await assert.rejects(
      printWhenImagesReady({
        documentRef,
        print: () => assert.fail("print must not run when an invoice image failed"),
        selector: ".invoice-print-document img",
        errorMessage: "发票原件加载失败，请重新检查后打印。",
      }),
      /发票原件加载失败/,
    );
    assert.equal(selector, ".invoice-print-document img");
  });

  it("flags low-resolution originals instead of silently replacing them", async () => {
    assert.equal(assessPrintImageResolution({
      naturalWidth: 479,
      naturalHeight: 800,
      minNaturalWidth: 480,
      minNaturalHeight: 300,
    }), "low_resolution");
    assert.equal(assessPrintImageResolution({
      naturalWidth: 1200,
      naturalHeight: 800,
      minNaturalWidth: 480,
      minNaturalHeight: 300,
    }), "ready");

    const documentRef = {
      querySelectorAll: () => [{ complete: true, naturalWidth: 479, naturalHeight: 800 }],
    };
    await assert.rejects(
      printWhenImagesReady({
        documentRef,
        print: () => assert.fail("low-resolution original must not print automatically"),
        selector: ".invoice-print-document img",
        minNaturalWidth: 480,
        minNaturalHeight: 300,
        errorMessage: "发票原件加载失败，请重新检查后打印。",
      }),
      /分辨率不足/,
    );
  });
});

describe("confirmed seven-column expense list export", () => {
  it("freezes the exact seven visible columns and does not append internal ledger fields", () => {
    assert.deepEqual(EXPENSE_LIST_COLUMNS.map(({ id, label }) => [id, label]), [
      ["sequence", "序号"],
      ["date", "日期"],
      ["purpose", "用途"],
      ["amount", "金额"],
      ["paymentRecord", "付款记录"],
      ["invoice", "发票"],
      ["notes", "备注"],
    ]);

    const output = buildExpenseListExport({ expenses });
    assert.deepEqual(Object.keys(output.rows[0].cells), EXPENSE_LIST_COLUMNS.map((column) => column.id));
    assert.equal("referenceCode" in output.rows[0].cells, false);
    assert.equal("merchant" in output.rows[0].cells, false);
    assert.equal("fundingSource" in output.rows[0].cells, false);
    assert.equal("accountLast4" in output.rows[0].cells, false);
  });

  it("keeps compatibility fields while supplying sanitized proof thumbnail data", () => {
    const rows = buildExpenseListRows(expenses);
    assert.deepEqual(Object.keys(rows[0]), [
      "sequence",
      "expenseId",
      "referenceCode",
      "dateLabel",
      "purposeLabel",
      "categoryLabel",
      "amountCents",
      "amountLabel",
      "paymentRecord",
      "paymentProofLabel",
      "invoiceLabel",
      "invoiceStatusLabel",
      "notes",
    ]);
    assert.equal(rows[0].dateLabel, "2026-08-03");
    assert.equal(rows[0].purposeLabel, "餐费");
    assert.equal(rows[0].categoryLabel, "餐费");
    assert.equal(rows[0].amountCents, 4000);
    assert.equal(rows[0].paymentProofLabel, "3 张");
    assert.equal(rows[0].paymentRecord.type, "thumbnail_stack");
    assert.equal(rows[0].paymentRecord.thumbnails.length, 3);
    assert.deepEqual(Object.keys(rows[0].paymentRecord.thumbnails[0]), [
      "attachmentId",
      "lineNumber",
      "altText",
      "thumbnailPolicy",
    ]);
    assert.equal(rows[0].paymentRecord.thumbnails[0].attachmentId, "attachment-1");
    assert.equal(rows[0].paymentRecord.thumbnails[0].thumbnailPolicy.stripMetadata, true);
    assert.equal("contentUrl" in rows[0].paymentRecord.thumbnails[0], false);
    assert.equal("fileName" in rows[0].paymentRecord.thumbnails[0], false);
    assert.equal(rows[0].invoiceStatusLabel, "电子");
    assert.equal(rows[1].notes, "");
    assert.equal("merchant" in rows[0], false);
    assert.equal("paidAt" in rows[0], false);
  });

  it("keeps one logical lodging entry and stacks multiple proofs into physical rows", () => {
    const output = buildExpenseListExport({
      expenses: [{
        ...expenses[0],
        id: "lodging-1",
        referenceCode: "EXP-20260803-LODGING",
        category: "lodging",
        notes: "8.3 济南住宿",
      }],
    });

    assert.equal(output.rows.length, 1);
    assert.equal(output.rows[0].cells.purpose.value, "住宿");
    assert.equal(output.rows[0].physicalRowCount, 3);
    assert.deepEqual(output.rows[0].mergeCellIds, [
      "sequence",
      "date",
      "purpose",
      "amount",
      "invoice",
      "notes",
    ]);
    assert.deepEqual(
      output.rows[0].cells.paymentRecord.thumbnails.map((thumbnail) => thumbnail.lineNumber),
      [1, 2, 3],
    );
  });

  it("calculates expense and confirmed substitute-invoice totals for selected rows", () => {
    const matches = [
      {
        id: "substitute-1",
        expenseId: "expense-1",
        state: "confirmed",
        matchMethod: "rule_candidate",
        allocatedCents: 17990,
      },
      {
        id: "electronic-1",
        expenseId: "expense-2",
        state: "confirmed",
        matchMethod: "manual",
        allocatedCents: 2400,
      },
      {
        id: "outside-selection",
        expenseId: "expense-outside",
        state: "confirmed",
        matchMethod: "rule_candidate",
        allocatedCents: 99900,
      },
      {
        id: "revoked-substitute",
        expenseId: "expense-2",
        state: "revoked",
        matchMethod: "rule_candidate",
        allocatedCents: 500,
      },
    ];
    const rows = buildExpenseListRows(expenses, { matches });

    assert.deepEqual(buildExpenseListTotals(rows, { matches }), {
      expenseTotalTitle: "费用合计",
      expenseTotalCents: 6400,
      expenseTotalLabel: "¥64.00",
      substituteInvoiceTotalTitle: "替票合计金额",
      substituteInvoiceTotalCents: 17990,
      substituteInvoiceTotalLabel: "¥179.90",
    });
    assert.deepEqual(buildExpenseListExport({ expenses, context: { matches } }).totals, {
      expenseTotalTitle: "费用合计",
      expenseTotalCents: 6400,
      expenseTotalLabel: "¥64.00",
      substituteInvoiceTotalTitle: "替票合计金额",
      substituteInvoiceTotalCents: 17990,
      substituteInvoiceTotalLabel: "¥179.90",
    });
  });

  it("marks CSV as data-only while Excel, PDF and print retain proof thumbnails", () => {
    assert.deepEqual(EXPENSE_LIST_FORMAT_CAPABILITIES.xlsx, {
      standardOutput: true,
      embedsPaymentRecordThumbnails: true,
    });
    assert.equal(EXPENSE_LIST_FORMAT_CAPABILITIES.csv.standardOutput, false);
    assert.equal(EXPENSE_LIST_FORMAT_CAPABILITIES.csv.embedsPaymentRecordThumbnails, false);
    assert.match(EXPENSE_LIST_FORMAT_CAPABILITIES.csv.notice, /仅供数据交换/);
    assert.match(EXPENSE_LIST_FORMAT_CAPABILITIES.csv.notice, /不作为最终标准费用清单/);
  });

  it("expands two proofs into two E-column rows and row-spans the other six cells", () => {
    const rows = buildPrintableRows([{ id: "two-proofs", proofCount: 2, amountCents: 3200 }]);
    const pages = paginateExpenseList({ rows, rowsPerPage: 9 });

    assert.equal(pages.length, 1);
    assert.equal(pages[0].physicalRowCount, 2);
    assert.deepEqual(pages[0].rows.map((row) => row.paymentRecord.thumbnail?.attachmentId), [
      "two-proofs-proof-1",
      "two-proofs-proof-2",
    ]);
    assert.deepEqual(pages[0].rows.map((row) => row.sharedCells.render), [true, false]);
    assert.equal(pages[0].rows[0].sharedCells.rowSpan, 2);
    assert.equal(pages[0].rows[1].sharedCells.rowSpan, 0);
    assert.equal(pages[0].totalCents, 3200);
  });

  it("uses exactly one physical page for nine proof rows", () => {
    const rows = buildPrintableRows([{ id: "nine-proofs", proofCount: 9, amountCents: 9000 }]);
    const pages = paginateExpenseList({ rows, rowsPerPage: 9 });

    assert.deepEqual(pages.map((page) => page.physicalRowCount), [9]);
    assert.equal(pages[0].rows[0].sharedCells.rowSpan, 9);
    assert.equal(pages[0].rows.at(-1).physicalRowNumber, 9);
    assert.equal(pages[0].pageNumber, 1);
    assert.equal(pages[0].totalPages, 1);
  });

  it("splits an over-capacity expense and repeats its six shared cells on the next page", () => {
    const rows = buildPrintableRows([{ id: "eleven-proofs", proofCount: 11, amountCents: 11800 }]);
    const pages = paginateExpenseList({ rows, rowsPerPage: 9 });

    assert.deepEqual(pages.map((page) => page.physicalRowCount), [9, 2]);
    assert.deepEqual(pages.map((page) => [page.pageNumber, page.totalPages]), [[1, 2], [2, 2]]);
    assert.equal(pages[0].rows[0].sharedCells.rowSpan, 9);
    assert.equal(pages[0].rows[0].sharedCells.continuesOnNextPage, true);
    assert.equal(pages[1].rows[0].sharedCells.render, true);
    assert.equal(pages[1].rows[0].sharedCells.rowSpan, 2);
    assert.equal(pages[1].rows[0].sharedCells.continuedFromPreviousPage, true);
    assert.equal(pages[1].rows[0].physicalRowNumber, 10);
    assert.equal(pages[1].rows[0].cells.amount.label, "¥118.00");
  });

  it("keeps normal proof groups together and counts every logical amount exactly once", () => {
    const rows = buildPrintableRows([
      { id: "two-proofs-first", proofCount: 2, amountCents: 3200, occurredOn: "2026-08-05" },
      { id: "nine-proofs-second", proofCount: 9, amountCents: 9000, occurredOn: "2026-08-06" },
      { id: "eleven-proofs-third", proofCount: 11, amountCents: 11800, occurredOn: "2026-08-07" },
    ]);
    const pages = paginateExpenseList({ rows, rowsPerPage: 9 });

    assert.deepEqual(pages.map((page) => page.physicalRowCount), [2, 9, 9, 2]);
    assert.equal(pages[1].rows[0].expenseId, "nine-proofs-second");
    assert.equal(pages[1].rows[0].sharedCells.rowSpan, 9);
    assert.equal(pages.flatMap((page) => page.rows).filter((row) => row.countsTowardTotal).length, 3);
    assert.equal(pages.reduce((total, page) => total + page.totalCents, 0), 24000);
    assert.equal(pages.flatMap((page) => page.rows).reduce((total, row) => (
      total + row.amountContributionCents
    ), 0), 24000);
    assert.deepEqual(pages.map((page) => page.totalPages), [4, 4, 4, 4]);
  });

  it("rejects a renderer row whose declared physical count disagrees with its proofs", () => {
    const rows = buildPrintableRows([{ id: "invalid-count", proofCount: 2 }]);
    rows[0].physicalRowCount = 1;
    assert.throws(
      () => paginateExpenseList({ rows, rowsPerPage: 9 }),
      /physicalRowCount is invalid/,
    );
  });

  it("uses the stable PDF and XLSX file names", () => {
    assert.equal(expenseListFilename("2026-08-03"), "费用清单-2026-08-03.pdf");
    assert.equal(expenseListFilename("2026-08-03", "xlsx"), "费用清单-2026-08-03.xlsx");
  });
});
