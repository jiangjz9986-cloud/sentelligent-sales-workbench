import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildExpenseListExport,
  paginateExpenseList,
} from "./travelExpenseExport.js";

const sourcePath = new URL("./ExpenseListPrintPreview.jsx", import.meta.url);
const bundlePath = join(tmpdir(), `expense-list-print-preview-${process.pid}-${Date.now()}.mjs`);
const bundle = await build({
  entryPoints: [sourcePath.pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  jsx: "automatic",
  external: ["pdfjs-dist/*"],
  logLevel: "silent",
});
await writeFile(bundlePath, bundle.outputFiles[0].contents);
const { ExpenseListPage } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

after(async () => {
  await rm(bundlePath, { force: true });
});

function makeExpense(proofCount) {
  return {
    id: `render-${proofCount}`,
    referenceCode: `EXP-RENDER-${proofCount}`,
    occurredOn: "2026-08-24",
    category: "lodging",
    invoiceStatus: "pending",
    notes: "打印分页测试",
    attachments: Array.from({ length: proofCount }, (_, index) => ({
      id: `proof-${index + 1}`,
      kind: "payment_proof",
      paymentIds: ["payment-1"],
    })),
    payments: [{
      id: "payment-1",
      paidAt: "2026-08-24T20:20:00+08:00",
      amountCents: 11800,
      reimbursementCents: 11800,
      fundingSource: "personal",
      paymentMethod: "wechat",
    }],
  };
}

function renderPages(proofCount) {
  const expenseList = buildExpenseListExport({ expenses: [makeExpense(proofCount)] });
  const pages = paginateExpenseList({ rows: expenseList.rows, rowsPerPage: 9 });
  const thumbnailUrls = Object.fromEntries(Array.from({ length: proofCount }, (_, index) => [
    `proof-${index + 1}`,
    `blob:test-${index + 1}`,
  ]));
  return {
    pages,
    html: pages.map((page) => renderToStaticMarkup(createElement(ExpenseListPage, {
      page,
      week: { start: "2026-08-24", end: "2026-08-30" },
      owner: "测试用户",
      generatedOn: "2026-08-26",
      totals: expenseList.totals,
      thumbnailUrls,
    }))),
  };
}

function occurrences(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

describe("ExpenseListPrintPreview physical-row rendering", () => {
  it("renders two proofs as two table rows with six row-spanned shared cells", () => {
    const { pages, html: [html] } = renderPages(2);

    assert.equal(pages.length, 1);
    assert.equal(occurrences(html, /data-physical-row=/g), 2);
    assert.equal(occurrences(html, /rowSpan="2"/g), 6);
    assert.equal(occurrences(html, /<img /g), 2);
    assert.equal(occurrences(html, /打印分页测试/g), 1);
    assert.match(html, /第 1\/1 页/);
  });

  it("repeats the shared cells after an over-capacity page break and reports real page numbers", () => {
    const { pages, html } = renderPages(11);

    assert.deepEqual(pages.map((page) => page.physicalRowCount), [9, 2]);
    assert.equal(occurrences(html[0], /data-physical-row=/g), 9);
    assert.equal(occurrences(html[1], /data-physical-row=/g), 2);
    assert.equal(occurrences(html[0], /<img /g), 9);
    assert.equal(occurrences(html[1], /<img /g), 2);
    assert.equal(occurrences(html[0], /rowSpan="9"/g), 6);
    assert.equal(occurrences(html[1], /rowSpan="2"/g), 6);
    assert.match(html[1], /data-continued="true"/);
    assert.match(html[0], /第 1\/2 页/);
    assert.match(html[1], /第 2\/2 页/);
    assert.equal(occurrences(html.join(""), /¥118\.00/g), 3);
    assert.equal(occurrences(html[0], /费用合计/g), 0);
    assert.equal(occurrences(html[1], /费用合计/g), 1);
  });
});
