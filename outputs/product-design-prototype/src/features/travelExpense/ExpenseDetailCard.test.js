import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const folder = new URL("./", import.meta.url);

async function source(name) {
  return readFile(new URL(name, folder), "utf8");
}

describe("expense detail card", () => {
  it("keeps the full expense record and proof controls in one focused dialog", async () => {
    const component = await source("ExpenseDetailCard.jsx");
    const page = await source("TravelExpensePage.jsx");
    const css = await source("travelExpense.css");

    assert.match(component, /role="dialog"/);
    assert.match(component, /aria-modal="true"/);
    assert.match(component, /expense\.referenceCode/);
    assert.match(component, /发生日期/);
    assert.match(component, /票据状态/);
    assert.match(component, /关联行程/);
    assert.match(component, /关联客户/);
    assert.match(component, /付款记录/);
    assert.match(component, /付款凭证/);
    assert.match(component, /formatTravelExpenseDateTime\(payment\.paidAt\)/);
    assert.match(component, /compact/);
    assert.match(component, /onEdit/);
    assert.match(component, /event\.key === "Escape"/);
    assert.match(page, /const \[detailExpenseId, setDetailExpenseId\]/);
    assert.match(page, /open=\{Boolean\(detailExpense\) && !editorOpen\}/);
    assert.match(page, /onEdit=\{\(expense\) =>/);
    assert.match(css, /\.expense-detail-backdrop\s*\{/);
    assert.match(css, /\.expense-detail-info-grid\s*\{/);
    assert.match(css, /\.expense-detail-proof-section\s*> \.expense-proof-center/);
  });

  it("limits the proof center to the selected expense in compact mode", async () => {
    const component = await source("PaymentProofCenter.jsx");

    assert.match(component, /const visibleExpenses = useMemo/);
    assert.match(component, /allowedIds = new Set\(expenseIds\)/);
    assert.match(component, /visibleExpenses\.map\(\(expense\)/);
    assert.match(component, /showInbox \? <section className="expense-inbox-review"/);
    assert.match(component, /showProofs \? <div className=\{`expense-proof-list/);
  });
});
