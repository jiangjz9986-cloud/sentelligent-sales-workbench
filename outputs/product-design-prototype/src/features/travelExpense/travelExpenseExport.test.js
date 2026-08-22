import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildExpenseListRows,
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

describe("six-field expense list export", () => {
  it("uses the confirmed seven-column expense list without leaking payment details", () => {
    const rows = buildExpenseListRows(expenses);
    assert.deepEqual(Object.keys(rows[0]), [
      "sequence",
      "expenseId",
      "referenceCode",
      "dateLabel",
      "categoryLabel",
      "amountCents",
      "amountLabel",
      "paymentProofLabel",
      "invoiceStatusLabel",
      "notes",
    ]);
    assert.equal(rows[0].dateLabel, "2026-08-03");
    assert.equal(rows[0].categoryLabel, "早餐");
    assert.equal(rows[0].amountCents, 4000);
    assert.equal(rows[0].paymentProofLabel, "3 张");
    assert.match(rows[0].invoiceStatusLabel, /电子发票/);
    assert.equal("merchant" in rows[0], false);
    assert.equal("paidAt" in rows[0], false);
  });

  it("paginates complete expense rows and calculates a recomputed total", () => {
    const rows = buildExpenseListRows(Array.from({ length: 19 }, (_, index) => ({
      ...expenses[1],
      id: `expense-${index}`,
      referenceCode: `EXP-20260804-${String(index).padStart(8, "0")}`,
      payments: [{
        ...expenses[1].payments[0],
        id: `payment-${index}`,
        amountCents: 100,
        reimbursementCents: 100,
      }],
    })));
    const pages = paginateExpenseList({ rows, rowsPerPage: 10 });
    assert.deepEqual(pages.map((page) => page.rows.length), [10, 9]);
    assert.equal(pages[0].totalCents, 1000);
    assert.equal(pages[1].totalCents, 900);
    assert.equal(pages[0].totalPages, 2);
    assert.equal(expenseListFilename("2026-08-03"), "费用清单-2026-08-03.pdf");
  });
});
