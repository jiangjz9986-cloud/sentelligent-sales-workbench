import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const pageSource = readFileSync(resolve("src/features/salesWorkbench/pages.jsx"), "utf8");
const travelExpenseFiles = [
  "src/features/travelExpense/TravelExpensePage.jsx",
  "src/features/travelExpense/ExpenseLedger.jsx",
  "src/features/travelExpense/ExpenseEditorDrawer.jsx",
  "src/features/travelExpense/PaymentProofCenter.jsx",
  "src/features/travelExpense/InvoiceManager.jsx",
  "src/features/travelExpense/InvoicePrintPreview.jsx",
  "src/features/travelExpense/PaymentRecordPrintPreview.jsx",
];
const travelExpenseSources = Object.fromEntries(
  travelExpenseFiles.map((file) => [file, readFileSync(resolve(file), "utf8")]),
);
const travelExpenseSource = Object.entries(travelExpenseSources)
  .map(([file, source]) => `${file}\n${source}`)
  .join("\n\n");

function tagByTestId(testId) {
  return controlContaining(`data-testid="${testId}"`);
}

function textareaByPlaceholder(placeholderStart) {
  return controlContaining(`placeholder="${placeholderStart}`);
}

function controlContaining(fragment) {
  const position = pageSource.indexOf(fragment);
  if (position === -1) return "";

  const start = Math.max(
    pageSource.lastIndexOf("<input", position),
    pageSource.lastIndexOf("<textarea", position),
    pageSource.lastIndexOf("<select", position),
  );
  const end = pageSource.indexOf("/>", position);
  if (start === -1 || end === -1) return "";
  return pageSource.slice(start, end + 2);
}

describe("form accessibility", () => {
  it("gives every page-local search field an explicit accessible name", () => {
    const searchFields = [
      "customer-local-search",
      "opportunity-local-search",
      "actions-local-search",
      "risk-local-search",
    ];

    for (const testId of searchFields) {
      assert.match(tagByTestId(testId), /\baria-label=/, `${testId} needs aria-label`);
    }
    assert.match(controlContaining('placeholder="搜索移动云'), /\baria-label=/, "knowledge search needs aria-label");
  });

  it("names quick-record and generated-summary textareas without relying on placeholder text", () => {
    assert.match(textareaByPlaceholder("粘贴拜访记录"), /\baria-label=/);
    assert.match(pageSource, /data-testid=\{fieldKey \? `analysis-summary-\$\{fieldKey\}` : undefined\}[\s\S]*?\baria-label=/);
  });

  it("keeps travel expense filters, uploads, print choices, and editor fields explicitly labelled", () => {
    const page = travelExpenseSources["src/features/travelExpense/TravelExpensePage.jsx"];
    const ledger = travelExpenseSources["src/features/travelExpense/ExpenseLedger.jsx"];
    const editor = travelExpenseSources["src/features/travelExpense/ExpenseEditorDrawer.jsx"];
    const proofs = travelExpenseSources["src/features/travelExpense/PaymentProofCenter.jsx"];
    const invoices = travelExpenseSources["src/features/travelExpense/InvoiceManager.jsx"];
    const printPreview = travelExpenseSources["src/features/travelExpense/PaymentRecordPrintPreview.jsx"];

    assert.ok(travelExpenseSource.includes("src/features/travelExpense/ExpenseEditorDrawer.jsx"));
    assert.match(page, /<label>[\s\S]*?<span>自然周<\/span>[\s\S]*?<input type="week"/);
    assert.match(ledger, /className="expense-search"[\s\S]*?<span className="sr-only">搜索费用<\/span>[\s\S]*?<input/);
    assert.match(editor, /<label className="form-field">[\s\S]*?<input/);
    assert.match(editor, /<label className="form-field">[\s\S]*?<select/);
    assert.match(editor, /<label className="form-field expense-span-2">[\s\S]*?<textarea/);
    assert.match(proofs, /className="expense-upload-tile"[\s\S]*?<input type="file"/);
    assert.match(proofs, /type="checkbox"[\s\S]*?aria-label=/);
    assert.match(invoices, /<label[\s\S]*?<input/);
    assert.match(invoices, /<label[\s\S]*?<select/);
    assert.match(printPreview, /<label><input type="radio"/);
  });
});
