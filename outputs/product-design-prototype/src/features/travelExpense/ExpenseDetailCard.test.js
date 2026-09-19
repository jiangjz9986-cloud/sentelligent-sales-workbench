import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const folder = new URL("./", import.meta.url);

async function source(name) {
  return readFile(new URL(name, folder), "utf8");
}

describe("expense detail card", () => {
  it("keeps the focused detail dialog aligned with the compact expense contract", async () => {
    const component = await source("ExpenseDetailCard.jsx");
    const page = await source("TravelExpensePage.jsx");
    const css = await source("travelExpense.css");

    assert.match(component, /role="dialog"/);
    assert.match(component, /aria-modal="true"/);
    assert.match(component, /expense\.referenceCode/);
    assert.match(component, /<h2 id="expense-detail-title">详情内容<\/h2>/);
    assert.match(component, /付款凭证和发票/);
    assert.match(component, /支付时间/);
    assert.match(component, /出差区域/);
    assert.match(component, /付款金额/);
    assert.match(component, /费用事由/);
    assert.doesNotMatch(component, /<h3>付款记录<\/h3>/);
    assert.doesNotMatch(component, /<h3>付款凭证<\/h3>/);
    assert.match(component, /formatTravelExpenseDateTime\(payment\.paidAt\)/);
    assert.match(component, /resolveExpenseInvoiceType/);
    assert.match(component, /invoiceStatusView\(expense, \{ matches, noInvoiceConfirmations \}\)/);
    assert.match(component, /onDoubleClick/);
    assert.match(component, /accept="image\/jpeg,image\/png,image\/webp"/);
    assert.match(component, /onReplace/);
    assert.match(component, /resourceKey=\{`\$\{attachment\.id\}:\$\{expense\.version\}`\}/);
    assert.match(component, /data-invoice-status/);
    assert.match(component, /electronic/);
    assert.match(component, /substitute/);
    assert.match(component, /paper/);
    assert.match(component, /unprovided/);
    assert.match(component, /onEdit/);
    assert.match(component, /event\.key === "Escape"/);
    assert.match(page, /const \[detailExpenseId, setDetailExpenseId\]/);
    assert.match(page, /open=\{Boolean\(detailExpense\) && !editorOpen\}/);
    assert.match(page, /onEdit=\{\(expense\) =>/);
    assert.match(page, /matches=\{invoiceMatches\}/);
    assert.match(page, /noInvoiceConfirmations=\{noInvoiceConfirmations\}/);
    assert.match(page, /replaceTravelExpenseAttachment/);
    assert.match(page, /onReplace=\{replaceAttachment\}/);
    assert.match(css, /\.expense-detail-backdrop\s*\{/);
    assert.match(css, /\.expense-detail-info-grid\s*\{/);
    assert.match(css, /\.expense-detail-evidence-grid\s*\{/);
    assert.match(css, /\.expense-detail-invoice-status\.is-electronic/);
    assert.match(css, /\.expense-detail-invoice-status\.is-substitute/);
    assert.match(css, /\.expense-detail-invoice-status\.is-paper/);
    assert.match(css, /\.expense-detail-invoice-status\.is-unprovided/);
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
