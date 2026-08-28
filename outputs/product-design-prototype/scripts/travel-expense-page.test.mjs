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
    const labels = ["账本", "发票"];
    const positions = labels.map((label) => page.indexOf(`label: "${label}"`));
    assert.equal(positions.every((position) => position >= 0), true);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
    assert.match(page, /import \{ PaymentProofCenter \}/);
    assert.match(page, /import \{ InvoiceManager \}/);
    assert.match(page, /import \{ ExpenseLedgerWorkbench \}/);
  });

  it("exposes the primary manual-entry, export, and print controls accessibly", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const editor = await source("src/features/travelExpense/ExpenseEditorDrawer.jsx");
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");
    const listPrint = await source("src/features/travelExpense/ExpenseListPrintPreview.jsx");

    assert.match(page, /记一笔/);
    assert.match(organizer, /打印费用清单/);
    assert.match(organizer, /导出费用清单 Excel/);
    assert.doesNotMatch(organizer, /导出付款明细 CSV/);
    assert.doesNotMatch(organizer, /打印实际付款记录/);
    assert.match(listPrint, /费用清单/);
    assert.match(listPrint, /A4 纵向预览/);
    assert.match(listPrint, /window\.print/);
    assert.match(editor, /<label/);
    assert.match(editor, /差额原因/);
    assert.match(editor, /个人垫付/);
    assert.match(editor, /公司直付/);
    assert.match(editor, /请款资金/);
  });

  it("reports print and export client events fire-and-forget without blocking the interaction", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /recordBookkeepingClientEvent\?\.\(event, \{ weekStart: week\.start, itemCount \}\)\?\.catch\?\.\(\(\) => \{\}\)/);
    assert.match(page, /reportBookkeepingClientEvent\("print_expense_list", expenses\.length\)/);
    assert.match(page, /reportBookkeepingClientEvent\("print_invoices", Array\.isArray\(items\) \? items\.length : 0\)/);
    assert.match(page, /reportBookkeepingClientEvent\("export_expense_xlsx", expenses\.length\)/);
    assert.doesNotMatch(page, /await reportBookkeepingClientEvent/);
    assert.doesNotMatch(page, /await apiClient\.recordBookkeepingClientEvent/);
  });

  it("implements the two canonical workspaces while retaining ledger child tools and settlement language", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const ledger = await source("src/features/travelExpense/ExpenseLedgerWorkbench.jsx");
    const ledgerCss = await source("src/features/travelExpense/expenseLedgerWorkbench.css");
    const proofs = await source("src/features/travelExpense/PaymentProofCenter.jsx");
    const invoices = await source("src/features/travelExpense/InvoiceManager.jsx");
    const settlement = await source("src/features/travelExpense/AdvanceSettlement.jsx");

    assert.match(page, /\{ id: "ledger", label: "账本" \}/);
    assert.match(page, /\{ id: "invoices", label: "发票" \}/);
    assert.doesNotMatch(page, /\{ id: "export", label: "报销输出" \}/);
    assert.doesNotMatch(page, /expense-tab-export/);
    assert.match(page, /data-testid=\{`expense-tab-\$\{tab\.id\}`\}/);
    assert.match(page, /重新加载/);
    assert.match(page, /type="week"/);
    assert.match(ledger, /buildExpenseLedgerWorkbenchModel/);
    assert.match(ledger, /按周一至周日查看费用账本/);
    assert.match(ledger, /待确认内容不会计入本周合计/);
    assert.match(ledger, /借款收入/);
    assert.match(ledger, /打印费用清单/);
    assert.match(ledger, /导出费用清单/);
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
    assert.match(page, /<PaymentProofCenter/);
    assert.match(page, /<AdvanceSettlement/);
    assert.match(invoices, /确认无票/);
    assert.match(invoices, /候选发票/);
    assert.match(invoices, /const noInvoiceConfirmationDisabled =/);
    assert.match(invoices, /!noInvoiceReason\.trim\(\)/);
    assert.match(invoices, /disabled=\{noInvoiceConfirmationDisabled\}/);
    assert.match(invoices, /title=\{noInvoiceConfirmationTitle\}/);
    assert.match(invoices, /const candidateResourcesReady =/);
    assert.match(invoices, /const confirmedCentsByExpense = new Map\(\)/);
    assert.match(invoices, /const confirmedCentsByPayment = new Map\(\)/);
    assert.match(invoices, /const hasActiveCandidateConfirmation = confirmations\.some/);
    assert.match(invoices, /const hasCandidateTarget = confirmations\.some/);
    assert.match(invoices, /confirmation\.amountSnapshotCents > 0/);
    assert.match(invoices, /expense\.id !== confirmation\.expenseId/);
    assert.match(invoices, /expense\.payments\.find\(\(item\) => item\.id === confirmation\.paymentId\)/);
    assert.match(invoices, /payment\.reimbursementCents > \(confirmedCentsByPayment\.get\(payment\.id\) \?\? 0\)/);
    assert.match(invoices, /本周无票记录对应的付款已变更或已被发票覆盖，请刷新后重新确认/);
    assert.match(invoices, /const hasUnmatchedInvoiceBalance = invoices\.some/);
    assert.match(invoices, /coverage\.invoiceWarehouseAvailableCents > 0/);
    assert.match(invoices, /const hasSuggestedCandidate = candidates\.some/);
    assert.match(invoices, /!noInvoicePayment/);
    assert.match(invoices, /当前没有同时满足未覆盖余额、开票日期和费用类别条件的候选发票/);
    assert.match(invoices, /decision === "accept"[\s\S]*?noInvoice: current\.noInvoice \+ 1[\s\S]*?else[\s\S]*?noInvoice: current\.noInvoice \+ 1/);
    assert.match(invoices, /disabled=\{candidateGenerationDisabled\}/);
    assert.match(invoices, /title=\{candidateGenerationTitle\}/);
    assert.match(invoices, /aria-describedby=\{candidateGenerationDisabled \? "invoice-candidate-generation-status" : undefined\}/);
    assert.match(invoices, /id="invoice-candidate-generation-status"[^>]+role="status"/);
    assert.match(invoices, /Math\.round\(candidate\.score \?\? 0\)/);
    assert.doesNotMatch(invoices, /Math\.round\(\(candidate\.score \?\? 0\) \* 100\)/);
    assert.match(invoices, /正在读取发票/);
    assert.match(invoices, /暂未上传发票/);
    assert.match(invoices, /重新加载发票/);
    assert.match(settlement, /公司应补/);
    assert.match(settlement, /个人应退/);
    assert.match(settlement, /公司直付不计入个人结算/);
  });

  it("uses the scheme-three ledger projection as the canonical ledger contract", async () => {
    const ledger = await source("src/features/travelExpense/ExpenseLedgerWorkbench.jsx");

    const headings = ["时间", "类型", "分类 / 备注", "金额", "凭证", "发票", "操作"];
    const positions = headings.map((heading) => ledger.indexOf(`<th scope="col">${heading}</th>`));
    assert.equal(positions.every((position) => position >= 0), true);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
    // v0.8.2: the 来源 column (微信小小 / 个人垫付 tags) is removed on desktop
    // and mobile, and payment-proof thumbnails become the visual anchor.
    assert.equal(ledger.includes('<th scope="col">来源</th>'), false);
    assert.doesNotMatch(ledger, /SourceState/);
    assert.doesNotMatch(ledger, /<dt>来源<\/dt>/);
    assert.match(ledger, /maxDimension=\{360\}/);
    assert.match(ledger, /data-ledger-state=\{item\.formal \? "formal" : "pending"\}/);
    assert.match(ledger, /尚未计入本周合计/);
  });

  it("no longer renders the 小小待确认 review card; WeChat is the only confirmation surface", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const css = await source("src/features/travelExpense/travelExpense.css");
    const model = await source("src/features/travelExpense/expenseLedgerWorkbenchModel.js");

    assert.doesNotMatch(page, /WeixinBookkeepingReviewCenter/);
    assert.doesNotMatch(page, /小小待确认/);
    assert.doesNotMatch(page, /expense-ledger-reviews/);
    assert.doesNotMatch(css, /weixin-review-|weixin-bookkeeping/);
    await assert.rejects(
      source("src/features/travelExpense/WeixinBookkeepingReviewCenter.jsx"),
      { code: "ENOENT" },
    );
    // Pending rows stay in the ledger and keep syncing through the background
    // poll, but their action is a WeChat pointer instead of a web target.
    assert.match(page, /setWeixinBookkeepingReviews/);
    assert.match(page, /weixinBookkeepingReviews\.length === 0/);
    assert.doesNotMatch(page, /onReviewItem=/);
    assert.match(model, /action: "微信中确认"/);
  });

  it("gives the two primary workspaces keyboard tab semantics", async () => {
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

  it("never renders a newly selected week with stale ledger data", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /const loadedWeekStartRef = useRef\(null\)/);
    assert.match(page, /const changingWeek = loadedWeekStartRef\.current !== week\.start/);
    assert.match(page, /loadedWeekStartRef\.current = week\.start/);
    assert.match(page, /const selectedWeekLoaded = loadedWeekStartRef\.current === week\.start/);
    assert.match(page, /status !== "loading" && selectedWeekLoaded/);
    assert.match(page, /function selectWeek\(value\) \{[\s\S]*?loadedWeekStartRef\.current = null;[\s\S]*?setRegionProfile\(null\);[\s\S]*?setRegionSettingsOpen\(false\);[\s\S]*?setWeek\(weekFromInput\(value\)\);\s*\}/);
    assert.match(page, /changingWeek[\s\S]*?setRegionProfile\(null\);[\s\S]*?setRegionSettingsOpen\(false\);/);
    assert.match(page, /canSaveRegionProfileForWeek/);
    assert.match(page, /open=\{selectedWeekLoaded && regionSettingsOpen\}/);
    assert.match(page, /setActiveTab\("ledger"\)/);
  });

  it("moves a saved expense to its canonical week instead of merging it into stale week data", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /const savedWeek = naturalWeekFor\(new Date\(`\$\{saved\.occurredOn\}T12:00:00`\)\)/);
    assert.match(page, /if \(savedWeek\.start === week\.start\) \{\s*setExpenses\(\(current\) => mergeById\(current, saved\)\);\s*\} else \{[\s\S]*?setWeek\(savedWeek\);\s*\}/);
    assert.match(page, /setSelectedLedgerDate\(saved\.occurredOn\)/);
    assert.match(page, /setHighlightExpenseId\(saved\.id\)/);
  });

  it("keeps the borrowing tool as received-income only", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const settlement = await source("src/features/travelExpense/AdvanceSettlement.jsx");

    assert.match(page, /const receivedAdvances = useMemo\(\(\) => advances\.filter/);
    assert.match(page, /advance\?\.status === "received"/);
    assert.match(page, /<AdvanceSettlement[^>]+advances=\{receivedAdvances\}/);
    assert.match(settlement, /status: "received"/);
    assert.match(settlement, /requestedCents: 0/);
    assert.match(settlement, /requestedOn: null/);
    assert.match(settlement, /录入借款到账/);
    assert.match(settlement, /保存到账收入/);
    assert.match(settlement, /系统不记录申请、草稿或未到账金额/);
    assert.doesNotMatch(settlement, /录入请款|申请金额|申请日期/);
  });

  it("keeps integration QA aligned with the two-tab contract", async () => {
    const integrationQa = await source("scripts/integration-qa.mjs");

    assert.match(integrationQa, /const legacyExportAbsent = !expensePage\.querySelector\('\[data-testid="expense-tab-export"\]'\)/);
    assert.match(
      integrationQa,
      /assert\.deepEqual\([\s\S]*?result\.expenseFlow\.tabIds,[\s\S]*?\['ledger', 'invoices'\]/,
    );
  });

  it("re-reveals the active tab when the tab strip changes size", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");

    assert.match(page, /const revealActiveTab = useCallback/);
    assert.match(page, /new ResizeObserver\(revealActiveTab\)/);
    assert.match(page, /resizeObserver\.observe\(tabsElement\)/);
    assert.match(page, /resizeObserver\.disconnect\(\)/);
    assert.match(page, /tabsElement\.scrollLeft \+= horizontalDelta/);
    assert.doesNotMatch(page, /selectedTab\?\.scrollIntoView/);
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
    assert.match(manager, /data-testid="invoice-print-trigger"/);
    assert.match(preview, /data-testid="invoice-print-preview-back"/);
    assert.match(page, /capturePreviewReturn\("invoice"\)/);
    assert.match(page, /restorePreviewReturn\("invoice"\)/);
    assert.doesNotMatch(manager, /<iframe[^>]+getInvoiceContentUrl/);
    assert.doesNotMatch(preview, /<iframe/);
    assert.match(css, /\.invoice-print-media canvas/);
    assert.match(css, /\.invoice-print-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(css, /\.invoice-print-slot\s*\{[^}]*min-width:\s*0/s);
  });

  it("wires the strict seven-column expense list preview without expanding the shared app shell", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const preview = await source("src/features/travelExpense/ExpenseListPrintPreview.jsx");
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");
    const css = await source("src/features/travelExpense/travelExpense.css");
    assert.match(page, /import \{ ExpenseListPrintPreview \}/);
    assert.match(page, /expenseListPrintOpen/);
    assert.match(page, /onOpenExpenseListPrint/);
    assert.match(page, /listInvoiceMatches\(\{ weekStart: week\.start, state: "confirmed"/);
    assert.match(page, /listNoInvoiceConfirmations\(\{ weekStart: week\.start/);
    assert.match(preview, /buildExpenseListExport/);
    assert.match(preview, /createPaymentProofThumbnail/);
    const columns = ["序号", "日期", "用途", "金额", "付款记录", "发票", "备注"];
    const columnPositions = columns.map((column) => preview.indexOf(`<th>${column}</th>`));
    assert.equal(columnPositions.every((position) => position >= 0), true);
    assert.deepEqual([...columnPositions].sort((left, right) => left - right), columnPositions);
    assert.equal((preview.match(/<th>/g) ?? []).length, columns.length);
    assert.match(preview, /expense-list-payment-thumbnails/);
    assert.match(preview, /expense-list-payment-thumbnail/);
    assert.match(preview, /expense-list-payment-missing/);
    assert.match(preview, /expense-list-print-totals/);
    assert.match(preview, /data-testid="expense-list-print-preview-back"/);
    assert.match(page, /capturePreviewReturn\("expense-list"\)/);
    assert.match(page, /restorePreviewReturn\("expense-list"\)/);
    assert.match(page, /contentScrollTop/);
    assert.match(page, /content\.scrollTop = 0/);
    assert.match(page, /backButton\.focus\(\{ preventScroll: true \}\)/);
    assert.match(page, /content\.scrollTop = state\.contentScrollTop/);
    assert.match(page, /trigger\.focus\(\{ preventScroll: true \}\)/);
    assert.match(page, /const printPreview = expenseListPrintOpen/);
    assert.match(page, /hidden=\{Boolean\(printPreview\)\}/);
    assert.match(page, /style=\{printPreview \? \{ display: "none" \} : undefined\}/);
    assert.match(organizer, /buildExpenseListExport/);
    assert.match(organizer, /createPaymentProofThumbnail/);
    assert.match(organizer, /buildExpenseListXlsxBlob/);
    assert.match(organizer, /output: "uint8array"/);
    assert.match(css, /\.expense-list-print-table th:nth-child\(5\)\s*\{\s*width:\s*28%;\s*\}/);
    assert.match(css, /\.expense-list-payment-thumbnail img/);
    assert.match(css, /\.expense-list-print-totals/);
    // v0.8.2 manual-sheet alignment: the week's responsible-region cities feed
    // the “M.D-M.D城市出差费用清单” title in print and XLSX alike, printed
    // proofs match the embedded XLSX picture size, and six proof rows fit an
    // A4 portrait page.
    assert.match(preview, /regionProfile = null/);
    assert.match(preview, /week,\s*\n\s*regionProfile,/);
    assert.match(preview, /rowsPerPage: 6/);
    assert.match(preview, /<h2>\{title\}<\/h2>/);
    assert.match(preview, /title=\{exportModel\.title\}/);
    assert.match(page, /<ExpenseListPrintPreview[^/]*regionProfile=\{regionProfile\}/);
    assert.match(page, /noInvoiceConfirmations,\s*\n\s*regionProfile,\s*\n\s*getAttachmentContentResponse: apiClient\.getTravelExpenseAttachmentContentResponse,/);
    assert.match(css, /\.expense-list-payment-thumbnail img\s*\{[^}]*max-width:\s*190px/s);
  });

  it("shows authenticated payment thumbnails and editable weekly regions without web cross-week banners", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const ledger = await source("src/features/travelExpense/ExpenseLedgerWorkbench.jsx");
    const ledgerCss = await source("src/features/travelExpense/expenseLedgerWorkbench.css");
    const model = await source("src/features/travelExpense/expenseLedgerWorkbenchModel.js");
    const regionCard = await source("src/features/travelExpense/TripRegionSettingsCard.jsx");
    const regionCss = await source("src/features/travelExpense/tripRegionSettingsCard.css");

    assert.doesNotMatch(page, /selectCrossWeekLedgerReceipts/);
    assert.doesNotMatch(page, /crossWeekReceipts/);
    assert.doesNotMatch(page, /locateRecentReceipt/);
    assert.doesNotMatch(page, /RecentLedgerReceipts/);
    assert.doesNotMatch(page, /小小录入了其他自然周的账目/);
    assert.match(page, /pendingLedgerLocationRef\.current = locationFailure/);
    assert.match(page, /pendingLedgerLocationRef\.current !== request/);
    assert.match(page, /pendingLedgerLocationRef\.current = null;[\s\S]*?setLocationFailure\(request\)/);
    assert.match(page, /querySelectorAll\("\[data-ledger-expense-id\]"\)/);
    assert.match(page, /const target = candidates\.find\(\(element\) => element\.getClientRects\(\)\.length > 0\);/);
    assert.doesNotMatch(page, /\?\? candidates\[0\]/);
    assert.match(page, /activeTab !== "ledger"/);
    assert.match(page, /\|\| expenseListPrintOpen[\s\S]*?\|\| invoicePrintItems/);
    assert.match(page, /window\.cancelAnimationFrame\(previewRestoreFrameRef\.current\);[\s\S]*?previewReturnRef\.current = null;/);
    assert.match(page, /previewCycleRef\.current \+= 1/);
    assert.match(page, /\[activeTab, expenseListPrintOpen, expenses, invoicePrintItems, status, week\.start\]/);
    assert.match(page, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
    assert.match(page, /action\.focus\(\{ preventScroll: true \}\)/);
    assert.match(page, /aria-live="polite"/);
    assert.match(page, /data-testid="ledger-location-failure"/);
    assert.match(page, /重新加载并定位/);
    assert.match(ledger, /data-ledger-expense-id=/);
    assert.match(ledger, /data-ledger-primary-action=/);
    assert.match(page, /selectedWeekLoaded && regionProfile/);
    assert.match(page, /<TripRegionSettingsCard/);
    assert.match(page, /saveTravelExpenseRegionProfile/);
    assert.match(model, /paymentProofs: ledgerRow\.visible\.paymentProofs/);
    assert.match(ledger, /<AuthenticatedImageFrame/);
    assert.match(ledgerCss, /object-fit: contain/);
    assert.match(ledger, /共 \{item\.paymentProofCount\} 份/);
    assert.match(page, /focusExpenseId=\{proofFocusExpenseId\}/);
    assert.match(page, /onFocusExpenseHandled=\{handleProofFocusHandled\}/);
    assert.match(page, /const handleProofFocusHandled = useCallback/);
    const proofs = await source("src/features/travelExpense/PaymentProofCenter.jsx");
    assert.match(proofs, /data-proof-expense-id=\{expense\.id\}/);
    assert.match(proofs, /data-proof-open/);
    assert.match(proofs, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
    assert.match(proofs, /focusTarget\.focus\(\{ preventScroll: true \}\)/);
    assert.match(regionCard, /role="dialog"/);
    assert.match(regionCard, /openerRef/);
    assert.match(regionCard, /connectedHtmlElement\(document\.activeElement\)/);
    assert.match(regionCard, /scheduleNextFrame/);
    assert.match(regionCard, /target\.focus\(\{ preventScroll: true \}\)/);
    assert.match(regionCard, /function focusReturnTarget\(opener\)/);
    assert.match(regionCard, /\[data-trip-region-focus-fallback\]/);
    assert.match(page, /data-trip-region-focus-fallback=\{tab\.id === "ledger" \|\| undefined\}/);
    assert.match(regionCard, /openCycleRef/);
    assert.match(regionCard, /逐日覆盖/);
    assert.match(regionCard, /区域设置已在其他窗口更新/);
    assert.match(regionCss, /position: fixed/);
    assert.match(regionCss, /@media \(max-width: 620px\)/);
  });

  it("keeps failed payment thumbnails retryable without leaking partial object URLs", async () => {
    const preview = await source("src/features/travelExpense/ExpenseListPrintPreview.jsx");

    assert.match(preview, /const \[thumbnailAttempt, setThumbnailAttempt\] = useState\(0\)/);
    assert.match(preview, /objectUrls\.splice\(0\)\.forEach\(\(url\) => URL\.revokeObjectURL\(url\)\)/);
    assert.match(preview, /\[attachmentKey, getAttachmentContentResponse, thumbnailAttempt\]/);
    assert.match(preview, /setThumbnailAttempt\(\(value\) => value \+ 1\)/);
    assert.match(preview, /重新生成付款记录/);
  });

  it("keeps reimbursement output inside the ledger and removes legacy output entry points", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const organizer = await source("src/features/travelExpense/ReimbursementOrganizer.jsx");
    const preview = await source("src/features/travelExpense/ExpenseListPrintPreview.jsx");

    assert.match(page, /downloadExpenseListXlsx/);
    assert.match(page, /onOpenExpenseListPrint/);
    assert.doesNotMatch(page, /PaymentRecordPrintPreview/);
    assert.doesNotMatch(page, /activeTab === "export"/);
    assert.match(organizer, /账本是唯一费用视图/);
    assert.doesNotMatch(organizer, /buildPaymentRecordRows|buildPaymentRecordCsv|付款主体\/方式/);
    assert.match(preview, /返回账本/);
    assert.match(preview, /账本 \/ A4 纵向预览/);
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

    const gate = packageJson.scripts["test:travel-expense"];
    for (const testPath of [
      "src/api/salesWorkbenchApi.test.js",
      "src/features/travelExpense/expenseLedgerWorkbenchModel.test.js",
      "src/features/travelExpense/ExpenseLedgerWorkbench.test.js",
      "src/features/travelExpense/AdvanceSettlement.test.js",
      "src/features/travelExpense/paymentProofThumbnail.test.js",
      "src/features/travelExpense/expenseListXlsx.test.js",
      "src/features/travelExpense/ReimbursementOrganizer.test.js",
      "src/features/travelExpense/responsibleRegionModel.test.js",
      "scripts/trip-region-settings-browser.test.mjs",
    ]) {
      assert.match(gate, new RegExp(testPath.replaceAll(".", "\\.")));
    }
  });

  it("prefills the drawer from an itinerary draft exactly once and warns on unlisted regions", async () => {
    const page = await source("src/features/travelExpense/TravelExpensePage.jsx");
    const editor = await source("src/features/travelExpense/ExpenseEditorDrawer.jsx");
    const app = await source("src/App.jsx");
    const itineraryPage = await source("src/features/visitItinerary/VisitItineraryPage.jsx");
    const link = await source("src/features/visitItinerary/itineraryExpenseLink.js");

    // One-shot draft consumption: captured at mount, week initialized to the
    // itinerary's natural week, URL params cleared through the App callback.
    assert.match(page, /const expenseDraftRef = useRef\(expenseDraft\)/);
    assert.match(page, /naturalWeekFor\(new Date\(`\$\{expenseDraftRef\.current\.occurredOn\}T12:00:00`\)\)/);
    assert.match(page, /const expenseDraftConsumedRef = useRef\(false\)/);
    assert.match(page, /expenseDraftConsumedRef\.current = true/);
    assert.match(page, /onExpenseDraftConsumed\?\.\(\)/);
    // A deleted itinerary or customer falls back to 不关联 instead of a dangling id.
    assert.match(page, /itineraries\.some\(\(item\) => item\.id === draft\.itineraryId\) \? draft\.itineraryId : ""/);
    assert.match(page, /customers\.some\(\(item\) => item\.id === draft\.customerId\) \? draft\.customerId : ""/);
    // Prefill reaches the drawer only for the linked opening; manual entry and
    // closing always clear it.
    assert.match(page, /prefill=\{draftPrefill\}/);
    assert.match(page, /setEditingExpense\(null\); setDraftPrefill\(null\); setEditorOpen\(true\);/);
    assert.match(page, /setEditorOpen\(false\); setEditingExpense\(null\); setDraftPrefill\(null\);/);
    // Region mismatch is advisory only: a warning plus a settings shortcut,
    // never an automatic region-profile write.
    assert.match(page, /import \{ hasResponsibleCity \} from "\.\/responsibleRegionModel\.js"/);
    assert.match(page, /data-testid="expense-draft-region-warning"/);
    assert.match(page, /打开区域设置/);
    assert.match(page, /week\.start === draftWeekStart/);
    assert.match(editor, /function createDraft\(expense, weekStart, prefill = null\)/);
    assert.match(editor, /occurredOn: prefill\?\.occurredOn \?\? weekStart/);
    assert.match(editor, /category: prefill \? "transport" : "breakfast"/);
    assert.match(app, /expenseDraft=\{expenseDraftFromFilters\(routeFilters\)\}/);
    assert.match(app, /onExpenseDraftConsumed=\{consumeExpenseDraftRoute\}/);
    assert.match(app, /function consumeExpenseDraftRoute\(\) \{[\s\S]*?writeBrowserRoute\(route, \{ replace: true \}\);[\s\S]*?\}/);
    assert.match(app, /onRecordExpense=\{recordItineraryExpense\}/);
    assert.match(itineraryPage, /data-testid="itinerary-record-expense"/);
    assert.match(itineraryPage, /记当日费用/);
    assert.match(link, /export function expenseDraftFiltersFromItinerary/);
    assert.match(link, /export function expenseDraftFromFilters/);
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
    assert.match(proofs, /AuthenticatedImageFrame/);
    assert.match(proofs, /getAttachmentContentResponse/);
    assert.match(preview, /isTravelExpensePdf/);
    assert.match(preview, /AuthenticatedPdfFrame/);
    assert.match(preview, /getAttachmentContentResponse/);
    assert.match(preview, /pdfsReady/);
    assert.match(preview, /pages\.detailPages\.length === 0 \|\| !pdfsReady/);
    assert.doesNotMatch(preview, /PDF 文件/);
  });
});
