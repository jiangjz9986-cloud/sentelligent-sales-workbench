import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const folder = new URL("./", import.meta.url);

async function source(name) {
  return readFile(new URL(name, folder), "utf8");
}

describe("expense ledger workbench shell", () => {
  it("renders the Monday-to-Sunday day selector with accessible tab behavior", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");

    assert.match(component, /role="tablist"/);
    assert.match(component, /role="tab"/);
    assert.match(component, /aria-selected=/);
    assert.match(component, /aria-controls=/);
    assert.match(component, /role="tabpanel"/);
    assert.match(component, /event\.key === "ArrowRight"/);
    assert.match(component, /event\.key === "ArrowLeft"/);
    assert.match(component, /event\.key === "Home"/);
    assert.match(component, /event\.key === "End"/);
  });

  it("exposes a delete entry on formal expense rows wired to the versioned delete flow", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");
    const page = await source("TravelExpensePage.jsx");
    const css = await source("expenseLedgerWorkbench.css");

    assert.match(component, /function DeleteButton\(\{ item, onDeleteItem \}\)/);
    assert.match(component, /item\.kind !== "expense" \|\| !item\.formal \|\| typeof onDeleteItem !== "function"/);
    assert.match(component, /data-testid="expense-delete-ledger"/);
    assert.match(component, /data-ledger-delete-action=\{item\.sourceId\}/);
    assert.match(component, /onDeleteItem\(item\.original, item\)/);
    assert.match(page, /onDeleteItem=\{deleteExpense\}/);
    assert.match(page, /globalThis\.confirm\?\.\(`确认删除“\$\{expense\.purpose\}”？`\)/);
    assert.match(page, /deleteTravelExpense\(expense\.id, expense\.version\)/);
    assert.match(css, /\.ledger-workbench-delete\s*\{/);
  });

  it("visually and semantically separates pending reviews from formal entries", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");

    assert.match(component, /data-ledger-state=\{item\.formal \? "formal" : "pending"\}/);
    assert.match(component, /尚未计入本周合计/);
    assert.match(component, /待确认内容不会计入本周合计/);
    assert.match(component, /小小待确认记录缺少本周有效日期/);
    assert.match(component, /正式记录/);
    assert.match(component, /待确认/);
  });

  it("provides both a desktop table and a mobile card list without a wide mobile table", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");
    const css = await source("expenseLedgerWorkbench.css");

    assert.match(component, /ledger-workbench-desktop-table/);
    assert.match(component, /ledger-workbench-mobile-list/);
    assert.match(component, /<caption className="sr-only">/);
    assert.match(component, /所选日期账目卡片/);
    assert.match(component, /时间/);
    assert.match(component, /类型/);
    assert.match(component, /分类 \/ 备注/);
    assert.doesNotMatch(component, /来源/);
    assert.match(component, /凭证/);
    assert.match(component, /发票/);
    assert.match(css, /@media \(max-width: 840px\)[\s\S]*?\.ledger-workbench-desktop-table\s*\{\s*display: none;/);
    assert.match(css, /@media \(max-width: 840px\)[\s\S]*?\.ledger-workbench-mobile-list\s*\{\s*display: grid;/);
    assert.doesNotMatch(css, /\.ledger-workbench-desktop-table table\s*\{[^}]*min-width:/s);
  });

  it("exposes loading, error, retry, selection, and live-status contracts", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");

    assert.match(component, /aria-busy="true"/);
    assert.match(component, /role="status"/);
    assert.match(component, /aria-live="polite"/);
    assert.match(component, /role="alert"/);
    assert.match(component, /onRetry/);
    assert.match(component, /onSelectDate/);
    assert.match(component, /onReviewItem/);
    assert.match(component, /onOpenItem/);
    assert.match(component, /onOpenRegionSettings/);
    assert.match(component, /onOpenExpenseListPrint/);
    assert.match(component, /onExportExpenseList/);
    assert.match(component, /getAttachmentContentResponse/);
  });

  it("keeps the confirmed summary and loan income visible without adding pending totals", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");

    assert.match(component, /本周已确认支出/);
    assert.match(component, /可报销金额/);
    assert.match(component, /借款收入/);
    assert.match(component, /借款剩余/);
    assert.match(component, /超额个人垫付/);
    assert.match(component, /凭证缺失/);
    assert.match(component, /发票缺失/);
    assert.match(component, /打印费用清单/);
    assert.match(component, /导出费用清单/);
  });

  it("renders authenticated first-proof previews in desktop rows and mobile cards", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");
    const css = await source("expenseLedgerWorkbench.css");

    assert.match(component, /AuthenticatedImageFrame/);
    assert.match(component, /paymentProofs\?\.\[0\]/);
    assert.match(component, /共 \{item\.paymentProofCount\} 份/);
    assert.match(component, /ledger-proof-pdf-mark/);
    assert.match(component, /未上传/);
    assert.match(css, /\.ledger-proof-preview-image > img\s*\{[^}]*object-fit: contain/s);
    // v0.8.2: at least double the former 48×54 thumbnail so receipt content is
    // readable directly in the row, and the proof column is one of the widest.
    assert.match(css, /\.ledger-proof-preview-image\.authenticated-image-frame\s*\{[^}]*width: 104px[^}]*height: 117px[^}]*flex: 0 0 104px/s);
    assert.match(css, /\.ledger-workbench-desktop-table th:nth-child\(5\)\s*\{\s*width:\s*26%;\s*\}/);
    assert.doesNotMatch(css, /\.ledger-workbench-desktop-table th:nth-child\(8\)/);
    assert.match(component, /共 \{item\.paymentProofCount\} 份/);
    assert.match(component, /aria-label=\{`查看\$\{item\.paymentProofCount\}份付款凭证`\}/);
  });

  it("loads only its isolated stylesheet and leaves the existing page stylesheet untouched", async () => {
    const component = await source("ExpenseLedgerWorkbench.jsx");

    assert.match(component, /import "\.\/expenseLedgerWorkbench\.css"/);
    assert.doesNotMatch(component, /TravelExpensePage/);
    assert.doesNotMatch(component, /salesWorkbenchApi/);
  });
});
