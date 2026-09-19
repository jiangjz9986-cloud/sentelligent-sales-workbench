import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const folder = new URL("./", import.meta.url);

async function source(name) {
  return readFile(new URL(name, folder), "utf8");
}

describe("unified travel expense editor drawer", () => {
  it("keeps read-only details and editing in the same drawer with side-by-side evidence", async () => {
    const editor = await source("ExpenseEditorDrawer.jsx");
    const evidence = await source("ExpenseEvidencePanel.jsx");
    const page = await source("TravelExpensePage.jsx");
    const css = await source("travelExpense.css");

    assert.match(editor, /className="expense-drawer" data-mode=\{expense && !isEditing \? "detail" : "edit"\} role="dialog" aria-modal="true"/);
    assert.match(editor, /function ExpenseDetailView\(/);
    assert.match(editor, /<ExpenseDetailView/);
    assert.match(editor, /data-expense-edit/);
    assert.match(editor, /function cancelEdit\(\)/);
    assert.match(editor, /setIsEditing\(false\)/);
    assert.match(editor, /取消可放弃本次修改/);
    assert.match(editor, /费用事由" value=\{notes\}/);
    assert.match(editor, /expense\.referenceCode/);
    assert.match(editor, /<legend>费用信息<\/legend>/);
    assert.match(editor, /<legend>实际付款<\/legend>/);
    assert.match(editor, /<span>出差区域<\/span>/);
    assert.match(editor, /<span>支付时间<\/span>/);
    assert.match(editor, /<span>费用事由<\/span>/);
    assert.match(editor, /className="expense-edit-grid"/);
    assert.match(editor, /\{!expense \? \([\s\S]*?<details className="expense-advanced-details">[\s\S]*?<\/details>\s*\) : null\}/);
    assert.match(editor, /其他费用字段/);
    assert.match(editor, /if \(!expense\) \{[\s\S]*?invoiceType: "unprovided"[\s\S]*?\}\s+const invoiceType/);
    assert.match(editor, /invoiceType: draft\.invoiceType === "unprovided" \? null/);
    assert.match(editor, /resolveExpenseInvoiceType\(expense, invoiceContext\)/);
    assert.match(editor, /<ExpenseEvidencePanel/);
    assert.match(editor, /data-expense-save type="submit"/);
    assert.match(editor, /pending \? "保存中" : "保存"/);
    assert.doesNotMatch(editor, /保存费用/);
    assert.match(evidence, /AuthenticatedImageFrame/);
    assert.match(evidence, /AuthenticatedPdfFrame/);
    assert.match(evidence, /expense-evidence-columns/);
    assert.match(evidence, /付款凭证与发票/);
    assert.match(evidence, /readOnly \? `\$\{proofs\.length\}张` : "双击图片替换"/);
    assert.match(evidence, /readOnly \? "当前状态" : "请选择一项"/);
    assert.match(evidence, /readOnly/);
    assert.match(evidence, /onDoubleClick/);
    assert.match(evidence, /accept="image\/jpeg,image\/png,image\/webp"/);
    assert.match(evidence, /onReplace/);
    assert.match(evidence, /onDelete/);
    assert.match(evidence, /onVersionChange\?\.\(updated\.version\)/);
    assert.match(evidence, /name="expense-invoice-status"/);
    assert.match(evidence, /readOnly \? \(\s*<div className=\{`expense-invoice-current/);
    assert.doesNotMatch(evidence, /SelectedInvoiceIcon size=\{20\}/);
    assert.doesNotMatch(evidence, /expense-evidence-file-meta|>查看</);
    for (const status of ["electronic", "substitute", "paper", "unprovided"]) {
      assert.match(evidence, new RegExp(`id: "${status}"`));
      assert.match(css, new RegExp(`\\.expense-invoice-option\\.is-${status} > svg`));
    }
    assert.match(page, /function openExpenseEditor\(expense\)/);
    assert.match(page, /openExpenseEditor\(item\)/);
    assert.match(page, /openExpenseEditor\(selectedExpense\)/);
    assert.doesNotMatch(page, /ExpenseDetailCard|detailExpenseId|expense-detail-card/);
    assert.match(page, /onDelete=\{deleteAttachment\}/);
    assert.match(page, /const editorExpense = useMemo/);
    assert.match(page, /setEditingExpense\(saved\)/);
    assert.match(css, /\.expense-editor-layout\s*\{/);
    assert.match(css, /\.expense-detail-view \.expense-detail-section\s*\{[\s\S]*?border: 0;/);
    assert.match(css, /\.expense-editor-form \.expense-edit-core\s*\{[\s\S]*?border: 0;/);
    assert.match(css, /\.expense-evidence-preview\s*\{[\s\S]*?height: 80px;/);
    assert.match(css, /\.expense-evidence-columns\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1\.5fr\) minmax\(240px, 1fr\);/);
    assert.match(css, /\.expense-evidence-columns\s*\{[\s\S]*?align-items: start;/);
    assert.match(css, /\.expense-invoice-option\s*\{[\s\S]*?min-height: 28px;/);
    assert.match(css, /\.expense-evidence-delete\s*\{[\s\S]*?width: 24px;[\s\S]*?height: 24px;/);
    assert.match(css, /\.expense-drawer\s*\{[\s\S]*?width: min\(846px, calc\(100vw - 36px\)\);/);
    assert.match(css, /\.expense-drawer\s*\{[\s\S]*?height: auto;[\s\S]*?max-height: min\(792px, calc\(100dvh - 36px\)\);[\s\S]*?grid-template-rows: auto auto auto;/);
    assert.match(css, /\.expense-editor-form\s*\{[\s\S]*?max-height: min\(600px, calc\(100dvh - 220px\)\);[\s\S]*?overflow-y: auto;/);
    assert.match(css, /\.expense-detail-view\s*\{[\s\S]*?max-height: min\(600px, calc\(100dvh - 220px\)\);[\s\S]*?overflow-y: auto;/);
    assert.match(css, /\.expense-drawer\s*\{ width: 100vw; height: 100dvh; max-height: none;/);
    assert.doesNotMatch(css, /\.expense-drawer-actions\s*\{[^}]*position: sticky/);
    assert.match(css, /\.expense-edit-field:focus-within/);
    assert.match(css, /\.expense-advanced-details\s*>\s*summary/);
    assert.match(css, /\.expense-invoice-option\.is-selected\s*\{[\s\S]*?border-color: #83bda1;[\s\S]*?background: #eaf8f1;/);
    assert.doesNotMatch(css, /\.expense-invoice-option\.is-(?:electronic|substitute|paper|unprovided)\.is-selected/);
    assert.match(css, /\.expense-evidence-preview \{ height: 96px; \}/);
  });

  it("keeps the full proof center contract for the ledger and inbox surfaces", async () => {
    const component = await source("PaymentProofCenter.jsx");

    assert.match(component, /const visibleExpenses = useMemo/);
    assert.match(component, /allowedIds = new Set\(expenseIds\)/);
    assert.match(component, /visibleExpenses\.map\(\(expense\)/);
    assert.match(component, /showInbox \? <section className="expense-inbox-review"/);
    assert.match(component, /showProofs \? <div className=\{`expense-proof-list/);
  });
});
