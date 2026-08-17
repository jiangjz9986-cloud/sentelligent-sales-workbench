import {
  CalendarDays,
  CircleAlert,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdvanceSettlement } from "./AdvanceSettlement.jsx";
import { ExpenseEditorDrawer } from "./ExpenseEditorDrawer.jsx";
import { ExpenseLedger } from "./ExpenseLedger.jsx";
import { InvoiceManager } from "./InvoiceManager.jsx";
import { InvoicePrintPreview } from "./InvoicePrintPreview.jsx";
import { PaymentProofCenter } from "./PaymentProofCenter.jsx";
import { PaymentRecordPrintPreview } from "./PaymentRecordPrintPreview.jsx";
import { ReimbursementOrganizer } from "./ReimbursementOrganizer.jsx";
import { ShortcutReviewCenter } from "./ShortcutReviewCenter.jsx";
import { WeeklyExpenseOverview } from "./WeeklyExpenseOverview.jsx";
import { prepareTravelExpenseDocument } from "./travelExpenseDocument.js";
import {
  naturalWeekFor,
  summarizeTravelExpenses,
} from "./travelExpenseModel.js";

const TABS = [
  { id: "overview", label: "周总览" },
  { id: "ledger", label: "费用账本" },
  { id: "proofs", label: "付款凭证" },
  { id: "invoices", label: "发票管理" },
  { id: "settlement", label: "请款结算" },
  { id: "organize", label: "报销整理" },
];

function isoWeekInput(weekStart) {
  const monday = new Date(`${weekStart}T12:00:00`);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4, 12);
  firstThursday.setDate(firstThursday.getDate() + (4 - (firstThursday.getDay() || 7)));
  const weekNumber = 1 + Math.round((thursday - firstThursday) / 604_800_000);
  return `${thursday.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function weekFromInput(value) {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) throw new TypeError("自然周格式无效");
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  const januaryFourth = new Date(year, 0, 4, 12);
  const monday = new Date(januaryFourth);
  monday.setDate(januaryFourth.getDate() - ((januaryFourth.getDay() || 7) - 1) + ((weekNumber - 1) * 7));
  return naturalWeekFor(monday);
}

function mergeById(items, item) {
  const index = items.findIndex((current) => current.id === item.id);
  if (index < 0) return [...items, item].sort((left, right) => left.occurredOn.localeCompare(right.occurredOn));
  return items.map((current) => current.id === item.id ? item : current);
}

function expenseErrorMessage(error, fallback) {
  if (error?.code === "VERSION_CONFLICT" || error?.status === 409) {
    return "记录已在其他窗口更新，请重新加载后再编辑。";
  }
  if (error?.status === 413) return "凭证附件超过接收上限。单个原文件最大 12 MiB，系统不会缩放、转码或降低清晰度。";
  return String(error?.message ?? fallback);
}

export function TravelExpensePage({
  apiClient,
  backendStatus,
  customers = [],
  itineraries = [],
  owner = "",
}) {
  const [week, setWeek] = useState(() => naturalWeekFor(new Date()));
  const [activeTab, setActiveTab] = useState("organize");
  const [expenses, setExpenses] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [documentInbox, setDocumentInbox] = useState([]);
  const [shortcutReviews, setShortcutReviews] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingAttachmentId, setPendingAttachmentId] = useState(null);
  const [pendingInboxId, setPendingInboxId] = useState(null);
  const [advancePending, setAdvancePending] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [invoicePrintItems, setInvoicePrintItems] = useState(null);
  const [ledgerCategory, setLedgerCategory] = useState("");
  const tabsRef = useRef(null);

  const revealActiveTab = useCallback(() => {
    const selectedTab = tabsRef.current?.querySelector('[aria-selected="true"]');
    selectedTab?.scrollIntoView({ block: "nearest", inline: "center" });
  }, []);

  const loadWeek = useCallback(async (signal) => {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setStatus("error");
      setError("业务服务未连接，暂不能读取差旅费用。请确认服务在线后重新加载。");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const [nextExpenses, nextAdvances, nextDocumentInbox, nextShortcutReviews] = await Promise.all([
        apiClient.listTravelExpenses({ weekStart: week.start, signal }),
        apiClient.listTravelExpenseAdvances({ weekStart: week.start, signal }),
        apiClient.listTravelExpenseDocumentInbox({
          status: "review_required",
          documentKind: "payment_proof",
          signal,
        }),
        typeof apiClient.listShortcutBookkeepingReviews === "function"
          ? apiClient.listShortcutBookkeepingReviews({ status: "review_required", signal })
          : Promise.resolve([]),
      ]);
      if (signal?.aborted) return;
      setExpenses(nextExpenses);
      setAdvances(nextAdvances);
      setDocumentInbox(nextDocumentInbox);
      setShortcutReviews(nextShortcutReviews);
      setStatus("ready");
    } catch (loadError) {
      if (signal?.aborted) return;
      setStatus("error");
      setError(expenseErrorMessage(loadError, "差旅费用加载失败，请稍后重试。"));
    }
  }, [apiClient, backendStatus, week.start]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWeek(controller.signal);
    return () => controller.abort();
  }, [loadWeek, reloadToken]);

  useEffect(() => {
    revealActiveTab();
  }, [activeTab, revealActiveTab]);

  useEffect(() => {
    const tabsElement = tabsRef.current;
    if (!tabsElement) return undefined;

    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(revealActiveTab);
      resizeObserver.observe(tabsElement);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener("resize", revealActiveTab);
    return () => window.removeEventListener("resize", revealActiveTab);
  }, [revealActiveTab]);

  const summary = useMemo(() => summarizeTravelExpenses(expenses, advances), [advances, expenses]);
  const itineraryLabel = useMemo(() => {
    const ids = [...new Set(expenses.map((expense) => expense.itineraryId).filter(Boolean))];
    if (!ids.length) return "本周差旅";
    return ids.map((id) => itineraries.find((item) => item.id === id)?.title).filter(Boolean).join("、") || "本周差旅";
  }, [expenses, itineraries]);

  function navigate(tab, options = {}) {
    setActiveTab(tab);
    if (options.category) setLedgerCategory(options.category);
  }

  function handleTabKeyDown(event, index) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;

    event.preventDefault();
    navigate(TABS[nextIndex].id);
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll('[role="tab"]');
    tabButtons?.[nextIndex]?.focus();
  }

  async function saveExpense(draft) {
    setSaving(true);
    try {
      const saved = await apiClient.saveTravelExpense(draft);
      setExpenses((current) => mergeById(current, saved));
      setEditorOpen(false);
      setEditingExpense(null);
      setActiveTab("organize");
      return saved;
    } catch (saveError) {
      throw new Error(expenseErrorMessage(saveError, "费用保存失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  }

  async function deleteExpense(expense) {
    if (!globalThis.confirm?.(`确认删除“${expense.purpose}”？`)) return;
    try {
      await apiClient.deleteTravelExpense(expense.id, expense.version);
      setExpenses((current) => current.filter((item) => item.id !== expense.id));
    } catch (deleteError) {
      setError(expenseErrorMessage(deleteError, "费用删除失败，请稍后重试。"));
    }
  }

  async function uploadAttachment(expense, file, paymentIds) {
    setPendingAttachmentId(expense.id);
    try {
      const prepared = await prepareTravelExpenseDocument(file);
      const coveredCents = expense.payments
        .filter((payment) => paymentIds.includes(payment.id))
        .reduce((total, payment) => total + payment.reimbursementCents, 0);
      const updated = await apiClient.addTravelExpenseAttachment(expense.id, {
        paymentIds,
        kind: "payment_proof",
        fileName: prepared.fileName,
        mediaType: prepared.mediaType,
        contentBase64: prepared.contentBase64,
        coveredCents,
        notes: "人工上传付款凭证",
      }, expense.version);
      setExpenses((current) => mergeById(current, updated));
      return updated;
    } catch (uploadError) {
      const message = expenseErrorMessage(uploadError, "付款凭证上传失败，请稍后重试。");
      setError(message);
      throw new Error(message);
    } finally {
      setPendingAttachmentId(null);
    }
  }

  async function deleteAttachment(expense, attachment) {
    if (!globalThis.confirm?.(`确认删除凭证“${attachment.fileName}”？`)) return;
    setPendingAttachmentId(attachment.id);
    try {
      const updated = await apiClient.deleteTravelExpenseAttachment(attachment.id, expense.version);
      setExpenses((current) => mergeById(current, updated));
    } catch (deleteError) {
      setError(expenseErrorMessage(deleteError, "付款凭证删除失败，请稍后重试。"));
    } finally {
      setPendingAttachmentId(null);
    }
  }

  async function confirmInboxItem(item, selection) {
    setPendingInboxId(item.id);
    try {
      const confirmed = await apiClient.confirmTravelExpenseDocumentInbox(item.id, selection, item.version);
      setDocumentInbox((current) => current.filter((candidate) => candidate.id !== confirmed.id));
      setReloadToken((value) => value + 1);
      return confirmed;
    } catch (confirmError) {
      throw new Error(expenseErrorMessage(confirmError, "付款凭证关联失败，请重新选择账单和付款后再试。"));
    } finally {
      setPendingInboxId(null);
    }
  }

  async function rejectInboxItem(item) {
    setPendingInboxId(item.id);
    try {
      const rejected = await apiClient.rejectTravelExpenseDocumentInbox(item.id, item.version);
      setDocumentInbox((current) => current.filter((candidate) => candidate.id !== rejected.id));
      return rejected;
    } catch (rejectError) {
      throw new Error(expenseErrorMessage(rejectError, "待处理凭证更新失败，请重新加载后再试。"));
    } finally {
      setPendingInboxId(null);
    }
  }

  function refreshShortcutReviews() {
    setReloadToken((value) => value + 1);
  }

  async function saveAdvance(advance) {
    setAdvancePending(true);
    try {
      const saved = await apiClient.saveTravelExpenseAdvance(advance);
      setAdvances((current) => {
        const index = current.findIndex((item) => item.id === saved.id);
        return index < 0 ? [...current, saved] : current.map((item) => item.id === saved.id ? saved : item);
      });
      return saved;
    } finally {
      setAdvancePending(false);
    }
  }

  async function deleteAdvance(advance) {
    if (!globalThis.confirm?.(`确认删除请款“${advance.purpose}”？`)) return;
    try {
      await apiClient.deleteTravelExpenseAdvance(advance.id, advance.version);
      setAdvances((current) => current.filter((item) => item.id !== advance.id));
    } catch (deleteError) {
      setError(expenseErrorMessage(deleteError, "请款记录删除失败，请稍后重试。"));
    }
  }

  const getAttachmentUrl = (attachmentId) => apiClient.getTravelExpenseAttachmentContentUrl(attachmentId);

  if (printOpen) {
    return <PaymentRecordPrintPreview expenses={expenses} summary={summary} week={week} owner={owner} itineraryLabel={itineraryLabel} getAttachmentUrl={getAttachmentUrl} getAttachmentContentResponse={apiClient.getTravelExpenseAttachmentContentResponse} onClose={() => setPrintOpen(false)} />;
  }

  if (invoicePrintItems) {
    return <InvoicePrintPreview invoices={invoicePrintItems} week={week} owner={owner} getInvoiceContentUrl={apiClient.getInvoiceContentUrl} getInvoiceContentResponse={apiClient.getInvoiceContentResponse} onClose={() => setInvoicePrintItems(null)} />;
  }

  return (
    <section className="expense-page" data-testid="page-expense">
      <header className="expense-page-toolbar">
        <div className="expense-page-title"><span>个人工作台</span><h1>差旅费用</h1></div>
        <nav ref={tabsRef} className="expense-tabs" aria-label="差旅报销功能" role="tablist">
          {TABS.map((tab, index) => <button key={tab.id} id={`expense-tab-${tab.id}`} className={activeTab === tab.id ? "active" : ""} data-testid={`expense-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`expense-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => navigate(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{tab.label}</button>)}
        </nav>
        <button className="primary-button" type="button" onClick={() => { setEditingExpense(null); setEditorOpen(true); }}><Plus size={16} />记一笔</button>
      </header>

      <section className="expense-week-strip">
        <label><CalendarDays size={18} /><span>自然周</span><input type="week" value={isoWeekInput(week.start)} onChange={(event) => setWeek(weekFromInput(event.target.value))} /></label>
        <div><small>当前范围</small><strong>{week.start}—{week.end}</strong></div>
        <div><small>行程 / 说明</small><strong>{itineraryLabel}</strong></div>
        <div><small>费用与付款</small><strong>{summary.expenseCount} 条 · {summary.paymentCount} 笔</strong></div>
        <button className="icon-button" type="button" aria-label="重新加载本周费用" onClick={() => setReloadToken((value) => value + 1)}><RefreshCw size={17} /></button>
      </section>

      {error ? <div className="expense-page-alert" role="alert"><CircleAlert size={18} /><span>{error}</span><button className="ghost-button" type="button" onClick={() => setReloadToken((value) => value + 1)}>重新加载</button></div> : null}
      {status === "loading" ? <div className="expense-loading" role="status"><LoaderCircle className="state-spinner" size={24} /><strong>正在读取本周费用</strong><p>费用、付款凭证、发票和请款记录正在同步。</p></div> : null}

      {status !== "loading" ? (
        <div className="expense-view-stage" id={`expense-panel-${activeTab}`} role="tabpanel" aria-labelledby={`expense-tab-${activeTab}`} tabIndex={0}>
          {activeTab === "overview" ? <WeeklyExpenseOverview summary={summary} week={week} onNavigate={navigate} /> : null}
          {activeTab === "ledger" ? <ExpenseLedger expenses={expenses} initialCategory={ledgerCategory} onEdit={(expense) => { setEditingExpense(expense); setEditorOpen(true); }} onDelete={deleteExpense} /> : null}
          {activeTab === "proofs" ? <><PaymentProofCenter expenses={expenses} inboxItems={documentInbox} getAttachmentUrl={getAttachmentUrl} getInboxContentUrl={apiClient.getTravelExpenseDocumentInboxContentUrl} getInboxContentResponse={apiClient.getTravelExpenseDocumentInboxContentResponse} onConfirmInbox={confirmInboxItem} onRejectInbox={rejectInboxItem} pendingInboxId={pendingInboxId} onUpload={uploadAttachment} onDelete={deleteAttachment} pendingAttachmentId={pendingAttachmentId} /><ShortcutReviewCenter reviews={shortcutReviews} apiClient={apiClient} onChanged={refreshShortcutReviews} /></> : null}
          {activeTab === "invoices" ? <InvoiceManager apiClient={apiClient} week={week} expenses={expenses} onOpenPrint={(items) => setInvoicePrintItems(items)} onExpenseChanged={() => setReloadToken((value) => value + 1)} /> : null}
          {activeTab === "settlement" ? <AdvanceSettlement week={week} summary={summary} advances={advances} onSave={saveAdvance} onDelete={deleteAdvance} pending={advancePending} /> : null}
          {activeTab === "organize" ? <ReimbursementOrganizer expenses={expenses} summary={summary} week={week} owner={owner} getAttachmentUrl={getAttachmentUrl} onOpenPrint={() => setPrintOpen(true)} onRefresh={() => setReloadToken((value) => value + 1)} /> : null}
        </div>
      ) : null}

      <ExpenseEditorDrawer open={editorOpen} expense={editingExpense} week={week} itineraries={itineraries} customers={customers} pending={saving} onClose={() => { setEditorOpen(false); setEditingExpense(null); }} onSave={saveExpense} />
    </section>
  );
}
