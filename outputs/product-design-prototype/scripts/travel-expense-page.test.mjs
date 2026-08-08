import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

describe("travel expense feature boundary", () => {
  it("places travel reimbursement between itinerary and weekly reporting", async () => {
    const data = await source("src/data/salesWorkbenchData.js");
    const itineraryIndex = data.indexOf('{ id: "itinerary"');
    const expenseIndex = data.indexOf('{ id: "expense"');
    const weeklyIndex = data.indexOf('{ id: "weekly"');

    assert.ok(itineraryIndex >= 0, "itinerary navigation must exist");
    assert.ok(expenseIndex > itineraryIndex, "expense navigation must follow itinerary");
    assert.ok(weeklyIndex > expenseIndex, "weekly navigation must follow expense");
    assert.match(data, /ReceiptText/);
    assert.match(data, /差旅报销/);
  });

  it("assembles an isolated TravelExpensePage instead of business JSX in App", async () => {
    const app = await source("src/App.jsx");
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(app, /import \{ TravelExpensePage \} from "\.\/features\/travelExpense\/TravelExpensePage\.jsx"/);
    assert.match(app, /active === "expense"/);
    assert.match(app, /<TravelExpensePage/);
    assert.doesNotMatch(app, /实际付款记录表/);
    assert.match(page, /data-testid="page-expense"/);
    const labels = ["周总览", "费用账本", "付款凭证", "发票管理", "请款结算", "报销整理"];
    const positions = labels.map((label) => page.indexOf(`label: "${label}"`));
    assert.equal(positions.every((position) => position >= 0), true);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
    assert.match(page, /import \{ PaymentProofCenter \}/);
    assert.match(page, /import \{ InvoiceManager \}/);
  });

  it("exposes the primary manual-entry, export, and print controls accessibly", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const editor = await source("src/features/travelExpense/ExpenseEditorDrawer.jsx");
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");

    assert.match(page, /记一笔/);
    assert.match(organizer, /打印实际付款记录/);
    assert.match(organizer, /导出表格/);
    assert.match(editor, /<label/);
    assert.match(editor, /差额原因/);
    assert.match(editor, /个人垫付/);
    assert.match(editor, /公司直付/);
    assert.match(editor, /请款资金/);
  });

  it("implements six focused work views with recovery, filters, and settlement language", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const overview = await source("src/features/travelExpense/WeeklyExpenseOverview.jsx");
    const ledger = await source("src/features/travelExpense/ExpenseLedger.jsx");
    const proofs = await source("src/features/travelExpense/PaymentProofCenter.jsx");
    const invoices = await source("src/features/travelExpense/InvoiceManager.jsx");
    const settlement = await source("src/features/travelExpense/AdvanceSettlement.jsx");

    assert.match(page, /\{ id: "overview", label: "周总览" \}/);
    assert.match(page, /\{ id: "ledger", label: "费用账本" \}/);
    assert.match(page, /\{ id: "proofs", label: "付款凭证" \}/);
    assert.match(page, /\{ id: "invoices", label: "发票管理" \}/);
    assert.match(page, /\{ id: "settlement", label: "请款结算" \}/);
    assert.match(page, /\{ id: "organize", label: "报销整理" \}/);
    assert.match(page, /data-testid=\{`expense-tab-\$\{tab\.id\}`\}/);
    assert.match(page, /重新加载/);
    assert.match(page, /type="week"/);
    assert.match(overview, /规则待配置/);
    assert.match(ledger, /仅看待核对/);
    assert.match(ledger, /搜索费用事由或收款方/);
    assert.match(ledger, /expense\.referenceCode/);
    assert.match(ledger, /navigator\.clipboard\.writeText/);
    assert.match(ledger, /复制账单编号/);
    assert.match(proofs, /上传付款凭证/);
    assert.match(proofs, /至少选择一笔付款/);
    assert.match(proofs, /type="checkbox"/);
    assert.match(proofs, /formatTravelExpenseDateTime\(payment\.paidAt\)/);
    assert.doesNotMatch(proofs, /replace\("T", " "\)\.slice\(0, 16\)/);
    assert.match(invoices, /发票仓库/);
    assert.match(invoices, /识别冲突/);
    assert.match(invoices, /人工复核/);
    assert.match(invoices, /发票匹配/);
    assert.match(invoices, /expenseReferenceCode:\s*expense\.referenceCode/);
    assert.match(invoices, /calculateInvoiceMatchAllocation/);
    assert.match(invoices, /resolveExpenseReferenceCode/);
    assert.match(invoices, /manual_selection/);
    assert.match(invoices, /manual_code/);
    assert.match(invoices, /账单编号/);
    assert.match(invoices, /acceptInvoiceCandidate\(candidate\.id, candidate\.version,/);
    assert.match(invoices, /rejectInvoiceCandidate\(candidate\.id, candidate\.version,/);
    assert.doesNotMatch(invoices, /expenseReferenceCode:\s*expense\.id/);
    assert.match(invoices, /apiClient\.revokeNoInvoice\(expense\.id, confirmation\.id, confirmation\.version\)/);
    assert.doesNotMatch(invoices, /apiClient\.revokeNoInvoice\(expense\.id, confirmation\.id, expense\.version\)/);
    assert.ok((invoices.match(/onExpenseChanged\(\)/g) ?? []).length >= 5);
    assert.match(page, /onExpenseChanged=\{\(\) => setReloadToken/);
    assert.match(invoices, /确认无票/);
    assert.match(invoices, /候选发票/);
    assert.match(invoices, /Math\.round\(candidate\.score \?\? 0\)/);
    assert.doesNotMatch(invoices, /Math\.round\(\(candidate\.score \?\? 0\) \* 100\)/);
    assert.match(invoices, /正在读取发票/);
    assert.match(invoices, /暂未上传发票/);
    assert.match(invoices, /重新加载发票/);
    assert.match(settlement, /公司应补/);
    assert.match(settlement, /个人应退/);
    assert.match(settlement, /公司直付不计入个人结算/);
  });

  it("gives the six work views keyboard tab semantics", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /role="tablist"/);
    assert.match(page, /role="tab"/);
    assert.match(page, /aria-selected=/);
    assert.match(page, /tabIndex=/);
    assert.match(page, /event\.key === "ArrowRight"/);
    assert.match(page, /event\.key === "ArrowLeft"/);
    assert.match(page, /tabsRef/);
    assert.match(page, /scrollIntoView/);
    assert.match(page, /role="tabpanel"/);
    assert.match(page, /aria-labelledby=/);
  });

  it("keeps integration QA aligned with the tab selection contract", async () => {
    const integrationQa = await source("scripts/integration-qa.mjs");

    assert.match(
      integrationQa,
      /organizeTab\.getAttribute\('aria-selected'\) === 'true'/,
    );
    assert.doesNotMatch(
      integrationQa,
      /organizeTab\.getAttribute\('aria-current'\)/,
    );
  });

  it("expects the current six reimbursement tabs in integration QA", async () => {
    const integrationQa = await source("scripts/integration-qa.mjs");

    assert.match(
      integrationQa,
      /assert\.deepEqual\([\s\S]*?result\.expenseFlow\.tabIds,[\s\S]*?\['overview', 'ledger', 'proofs', 'invoices', 'settlement', 'organize'\]/,
    );
    assert.doesNotMatch(
      integrationQa,
      /\['overview', 'ledger', 'receipts', 'settlement', 'organize'\]/,
    );
  });

  it("re-reveals the active tab when the tab strip changes size", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /const revealActiveTab = useCallback/);
    assert.match(page, /new ResizeObserver\(revealActiveTab\)/);
    assert.match(page, /resizeObserver\.observe\(tabsElement\)/);
    assert.match(page, /resizeObserver\.disconnect\(\)/);
  });

  it("prints only this week's matched invoices in a fixed four-slot preview", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const manager = await source("src/features/travelExpense/InvoiceManager.jsx");
    const preview = await source("src/features/travelExpense/InvoicePrintPreview.jsx");
    const css = await source("src/features/travelExpense/travelExpense.css");

    assert.match(page, /import \{ InvoicePrintPreview \}/);
    assert.match(page, /invoicePrintItems/);
    assert.match(page, /<InvoicePrintPreview/);
    assert.match(manager, /onOpenPrint/);
    assert.match(manager, /打印本周已匹配发票/);
    assert.match(manager, /match\.state !== "revoked"/);
    assert.match(manager, /import \{ AuthenticatedPdfFrame \}/);
    assert.match(manager, /<AuthenticatedPdfFrame/);
    assert.match(preview, /paginateInvoicePrint/);
    assert.match(preview, /import \{ AuthenticatedPdfFrame \}/);
    assert.match(preview, /<AuthenticatedPdfFrame/);
    assert.match(preview, /pdfsReady/);
    assert.match(preview, /onStatusChange/);
    assert.match(preview, /disabled=\{printing \|\| pages\.length === 0 \|\| !pdfsReady\}/);
    assert.match(preview, /invoice-print-grid/);
    assert.match(preview, /invoice-print-slot is-empty/);
    assert.match(preview, /PDF 发票/);
    assert.match(preview, /getInvoiceContentResponse/);
    assert.match(preview, /renderWidth=\{1440\}/);
    assert.match(preview, /window\.print/);
    assert.match(preview, /event\.key === "Escape"/);
    assert.doesNotMatch(manager, /<iframe[^>]+getInvoiceContentUrl/);
    assert.doesNotMatch(preview, /<iframe/);
    assert.match(css, /\.invoice-print-media canvas/);
    assert.match(css, /\.invoice-print-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(css, /\.invoice-print-slot\s*\{[^}]*min-width:\s*0/s);
  });

  it("uses the same payment rows for on-screen organization and A4 print pages", async () => {
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");
    const preview = await source("src/features/travelExpense/PaymentRecordPrintPreview.jsx");
    const css = await source("src/features/travelExpense/travelExpense.css");

    assert.match(organizer, /buildPaymentRecordRows/);
    assert.match(organizer, /buildPaymentRecordCsv/);
    assert.match(organizer, /付款主体\/方式/);
    assert.match(organizer, /row\.expenseReferenceCode/);
    assert.doesNotMatch(organizer, /PAY-\{row\.occurredOn/);
    assert.match(preview, /paginatePaymentRecord/);
    assert.match(preview, /row\.expenseReferenceCode/);
    assert.match(preview, /含凭证附件/);
    assert.match(preview, /紧凑无图/);
    assert.match(preview, /凭证附页/);
    assert.match(preview, /window\.print/);
    assert.match(css, /@page\s*\{[^}]*size:\s*A4 landscape/s);
    assert.match(css, /\.topbar/);
    assert.match(css, /\.product-window[\s\S]*height:\s*auto\s*!important/);
    assert.match(css, /\.expense-print-row[\s\S]*break-inside:\s*avoid/);
  });

  it("keeps the travel-expense root grid shrinkable on narrow screens", async () => {
    const css = await source("src/features/travelExpense/travelExpense.css");

    assert.match(
      css,
      /\.expense-page\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    assert.match(css, /@media \(max-width:\s*980px\)/);
    assert.match(css, /@media \(max-width:\s*430px\)/);
    assert.match(css, /@media \(max-height:\s*500px\) and \(orientation:\s*landscape\)/);
    assert.match(css, /\.expense-tabs button\s*\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.invoice-print-preview-toolbar button:focus-visible/);
  });

  it("keeps print failures recoverable and renders shared-proof reconciliation", async () => {
    const preview = await source("src/features/travelExpense/PaymentRecordPrintPreview.jsx");

    assert.match(preview, /printWhenImagesReady/);
    assert.match(preview, /setPrintError/);
    assert.match(preview, /role="alert"/);
    assert.match(preview, /重新检查并打印/);
    assert.match(preview, /paymentReferences\.map/);
    assert.match(preview, /reference\.paymentNumber/);
    assert.match(preview, /formatCny\(reference\.amountCents\)/);
    assert.match(preview, /proofAppendixPageNumbers/);
  });

  it("includes API client regressions in the travel-expense quality gate", async () => {
    const packageJson = JSON.parse(await source("package.json"));

    assert.match(packageJson.scripts["test:travel-expense"], /src\/api\/salesWorkbenchApi\.test\.js/);
  });

  it("keeps the editor explicit, multi-payment, and keyboard dismissible", async () => {
    const editor = await source("src/features/travelExpense/ExpenseEditorDrawer.jsx");

    assert.match(editor, /发生日期/);
    assert.match(editor, /className="expense-derived-status"/);
    assert.doesNotMatch(editor, /value=\{draft\.invoiceStatus\}/);
    assert.doesNotMatch(editor, /updateField\("invoiceStatus"/);
    assert.doesNotMatch(editor, /invoiceStatus:\s*draft\.invoiceStatus/);
    assert.match(editor, /支付时间/);
    assert.match(editor, /实付金额/);
    assert.match(editor, /计入报销金额/);
    assert.match(editor, /添加一笔付款/);
    assert.match(editor, /至少保留一笔付款/);
    assert.match(editor, /event\.key === "Escape"/);
    assert.match(editor, /role="dialog"/);
    assert.match(editor, /aria-modal="true"/);
  });

  it("provides a real WeChat payment-proof review queue", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const proofs = await source("src/features/travelExpense/PaymentProofCenter.jsx");

    assert.match(page, /listTravelExpenseDocumentInbox/);
    assert.match(page, /confirmTravelExpenseDocumentInbox/);
    assert.match(page, /rejectTravelExpenseDocumentInbox/);
    assert.match(page, /inboxItems=/);
    assert.match(proofs, /微信待处理/);
    assert.match(proofs, /识别证据/);
    assert.match(proofs, /确认关联/);
    assert.match(proofs, /不关联，保留原件/);
    assert.match(proofs, /AuthenticatedPdfFrame/);
    assert.match(proofs, /getInboxContentResponse/);
    assert.match(proofs, /role="alert"/);
  });

  it("uploads original image and PDF bytes without client-side transcoding", async () => {
    const documentHelper = await source("src/features/travelExpense/travelExpenseDocument.js");
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const proofs = await source("src/features/travelExpense/PaymentProofCenter.jsx");
    const invoices = await source("src/features/travelExpense/InvoiceManager.jsx");
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");
    const preview = await source("src/features/travelExpense/PaymentRecordPrintPreview.jsx");

    assert.match(documentHelper, /image\/jpeg/);
    assert.match(documentHelper, /image\/png/);
    assert.match(documentHelper, /image\/webp/);
    assert.match(documentHelper, /application\/pdf/);
    assert.match(documentHelper, /12 \* 1024 \* 1024/);
    assert.match(documentHelper, /arrayBuffer\(\)/);
    assert.doesNotMatch(documentHelper, /canvas|toBlob|0\.82|1400/);
    assert.match(page, /prepareTravelExpenseDocument/);
    assert.doesNotMatch(page, /compressTravelExpenseImage/);
    assert.doesNotMatch(page, /paymentIds:\s*expense\.payments\.map/);
    assert.match(proofs, /accept="image\/jpeg,image\/png,image\/webp,application\/pdf"/);
    assert.match(proofs, /selectedPaymentIds/);
    assert.match(proofs, /validatePaymentProofSelection/);
    assert.match(invoices, /prepareTravelExpenseDocument/);
    assert.match(invoices, /application\/pdf/);
    assert.match(organizer, /isTravelExpensePdf/);
    assert.match(preview, /isTravelExpensePdf/);
    assert.match(preview, /AuthenticatedPdfFrame/);
    assert.match(preview, /getAttachmentContentResponse/);
    assert.match(preview, /pdfsReady/);
    assert.match(preview, /pages\.detailPages\.length === 0 \|\| !pdfsReady/);
    assert.doesNotMatch(preview, /PDF 文件/);
  });
});
