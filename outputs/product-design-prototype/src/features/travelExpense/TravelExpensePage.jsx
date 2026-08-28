import {
  CalendarDays,
  CircleAlert,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdvanceSettlement } from "./AdvanceSettlement.jsx";
import { ExpenseEditorDrawer } from "./ExpenseEditorDrawer.jsx";
import { ExpenseLedgerWorkbench } from "./ExpenseLedgerWorkbench.jsx";
import { ExpenseListPrintPreview } from "./ExpenseListPrintPreview.jsx";
import { InvoiceManager } from "./InvoiceManager.jsx";
import { InvoicePrintPreview } from "./InvoicePrintPreview.jsx";
import { PaymentProofCenter } from "./PaymentProofCenter.jsx";
import { downloadExpenseListXlsx } from "./ReimbursementOrganizer.jsx";
import { TripRegionSettingsCard } from "./TripRegionSettingsCard.jsx";
import { prepareTravelExpenseDocument } from "./travelExpenseDocument.js";
import { canSaveRegionProfileForWeek } from "./travelExpensePageState.js";
import { hasResponsibleCity } from "./responsibleRegionModel.js";
import {
  naturalWeekFor,
  summarizeTravelExpenses,
} from "./travelExpenseModel.js";

const TABS = [
  { id: "ledger", label: "账本" },
  { id: "invoices", label: "发票" },
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
  expenseDraft = null,
  onExpenseDraftConsumed,
}) {
  // The itinerary→expense draft is captured once at mount: the URL filters are
  // replaced right after consumption, so the prop turning null later must not
  // close the drawer or drop the region hint.
  const expenseDraftRef = useRef(expenseDraft);
  const [week, setWeek] = useState(() => (
    expenseDraftRef.current
      ? naturalWeekFor(new Date(`${expenseDraftRef.current.occurredOn}T12:00:00`))
      : naturalWeekFor(new Date())
  ));
  const [activeTab, setActiveTab] = useState("ledger");
  const [expenses, setExpenses] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [documentInbox, setDocumentInbox] = useState([]);
  const [invoiceMatches, setInvoiceMatches] = useState([]);
  const [noInvoiceConfirmations, setNoInvoiceConfirmations] = useState([]);
  const [invoiceCoverage, setInvoiceCoverage] = useState(null);
  const [weixinBookkeepingReviews, setWeixinBookkeepingReviews] = useState([]);
  const [regionProfile, setRegionProfile] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [auxiliaryWarning, setAuxiliaryWarning] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [draftPrefill, setDraftPrefill] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingAttachmentId, setPendingAttachmentId] = useState(null);
  const [pendingInboxId, setPendingInboxId] = useState(null);
  const [advancePending, setAdvancePending] = useState(false);
  const [expenseListPrintOpen, setExpenseListPrintOpen] = useState(false);
  const [expenseListExporting, setExpenseListExporting] = useState(false);
  const [regionSettingsOpen, setRegionSettingsOpen] = useState(false);
  const [regionSaving, setRegionSaving] = useState(false);
  const [invoicePrintItems, setInvoicePrintItems] = useState(null);
  const [selectedLedgerDate, setSelectedLedgerDate] = useState(null);
  const [highlightExpenseId, setHighlightExpenseId] = useState(null);
  const [locationAnnouncement, setLocationAnnouncement] = useState("");
  const [locationFailure, setLocationFailure] = useState(null);
  const [proofFocusExpenseId, setProofFocusExpenseId] = useState(null);
  const tabsRef = useRef(null);
  const loadedWeekStartRef = useRef(null);
  const pendingLedgerLocationRef = useRef(null);
  const locationFailureActionRef = useRef(null);
  const previewReturnRef = useRef(null);
  const previewCycleRef = useRef(0);
  const previewRestoreFrameRef = useRef(null);
  const expenseDraftConsumedRef = useRef(false);

  useEffect(() => {
    const draft = expenseDraftRef.current;
    if (!draft || expenseDraftConsumedRef.current) return;
    expenseDraftConsumedRef.current = true;
    setEditingExpense(null);
    // A draft pointing at a deleted itinerary or customer falls back to
    // "不关联" while the other prefilled fields stay usable.
    setDraftPrefill({
      occurredOn: draft.occurredOn,
      purpose: draft.purpose ?? "",
      itineraryId: itineraries.some((item) => item.id === draft.itineraryId) ? draft.itineraryId : "",
      customerId: customers.some((item) => item.id === draft.customerId) ? draft.customerId : "",
    });
    setEditorOpen(true);
    onExpenseDraftConsumed?.();
  }, [customers, itineraries, onExpenseDraftConsumed]);

  const revealActiveTab = useCallback(() => {
    const tabsElement = tabsRef.current;
    const selectedTab = tabsElement?.querySelector('[aria-selected="true"]');
    if (!(tabsElement instanceof HTMLElement) || !(selectedTab instanceof HTMLElement)) return;

    const tabsRect = tabsElement.getBoundingClientRect();
    const selectedRect = selectedTab.getBoundingClientRect();
    const horizontalDelta = (selectedRect.left + (selectedRect.width / 2))
      - (tabsRect.left + (tabsRect.width / 2));
    if (Math.abs(horizontalDelta) > 1) tabsElement.scrollLeft += horizontalDelta;
  }, []);

  const loadWeek = useCallback(async (signal) => {
    if (!apiClient?.isEnabled || backendStatus !== "connected") {
      setStatus("error");
      setError("业务服务未连接，暂不能读取差旅费用。请确认服务在线后重新加载。");
      return;
    }
    const changingWeek = loadedWeekStartRef.current !== week.start;
    if (changingWeek) {
      setStatus("loading");
      // Week-scoped auxiliary state must not appear under a newly selected
      // week while that week's requests are still in flight.
      setInvoiceMatches([]);
      setNoInvoiceConfirmations([]);
      setInvoiceCoverage(null);
      setRegionProfile(null);
      setRegionSettingsOpen(false);
    }
    setError("");
    setAuxiliaryWarning("");
    try {
      const [workbenchResult, documentInboxResult, invoiceMatchesResult, noInvoiceResult, coverageResult] = await Promise.allSettled([
        apiClient.getTravelExpenseWorkbench({ weekStart: week.start, signal }),
        apiClient.listTravelExpenseDocumentInbox({
          status: "review_required",
          documentKind: "payment_proof",
          signal,
        }),
        apiClient.listInvoiceMatches({ weekStart: week.start, state: "confirmed", signal }),
        apiClient.listNoInvoiceConfirmations({ weekStart: week.start, signal }),
        apiClient.getWeekInvoiceCoverage(week.start, { signal }),
      ]);
      if (signal?.aborted) return;
      if (workbenchResult.status === "rejected") throw workbenchResult.reason;

      setExpenses(workbenchResult.value.expenses);
      setAdvances(workbenchResult.value.advances);
      setWeixinBookkeepingReviews(workbenchResult.value.bookkeepingReviews);
      setRegionProfile(workbenchResult.value.regionProfile);
      const auxiliaryFailures = [];
      if (documentInboxResult.status === "fulfilled") setDocumentInbox(documentInboxResult.value);
      else auxiliaryFailures.push("付款凭证待处理");
      if (invoiceMatchesResult.status === "fulfilled") setInvoiceMatches(invoiceMatchesResult.value);
      else auxiliaryFailures.push("发票匹配");
      if (noInvoiceResult.status === "fulfilled") setNoInvoiceConfirmations(noInvoiceResult.value);
      else auxiliaryFailures.push("无票确认");
      if (coverageResult.status === "fulfilled") setInvoiceCoverage(coverageResult.value);
      else auxiliaryFailures.push("发票覆盖统计");
      if (auxiliaryFailures.length > 0) {
        setAuxiliaryWarning(`${auxiliaryFailures.join("、")}暂未同步；正式账本仍按已读取结果显示。`);
      }
      loadedWeekStartRef.current = week.start;
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
    const refresh = () => setReloadToken((value) => value + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (weixinBookkeepingReviews.length === 0) return undefined;
    const timer = window.setInterval(() => setReloadToken((value) => value + 1), 12_000);
    return () => window.clearInterval(timer);
  }, [weixinBookkeepingReviews.length]);

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

  useEffect(() => {
    const request = pendingLedgerLocationRef.current;
    if (!request
      || status !== "ready"
      || loadedWeekStartRef.current !== week.start
      || activeTab !== "ledger"
      || expenseListPrintOpen
      || invoicePrintItems) return undefined;

    // An explicit ledger-location request outranks the preview's old return
    // position and trigger focus. Cancel either queued restore frame so it
    // cannot overwrite the target scroll/focus after the preview closes.
    if (previewRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRestoreFrameRef.current);
      previewRestoreFrameRef.current = null;
    }
    if (previewReturnRef.current !== null) {
      previewCycleRef.current += 1;
      previewReturnRef.current = null;
    }

    const frame = window.requestAnimationFrame(() => {
      if (pendingLedgerLocationRef.current !== request) return;
      const candidates = [...document.querySelectorAll("[data-ledger-expense-id]")]
        .filter((element) => element.dataset.ledgerExpenseId === request.expenseId);
      const target = candidates.find((element) => element.getClientRects().length > 0);
      if (!target && candidates.length > 0) {
        setLocationAnnouncement(`目标账目 ${request.referenceCode} 暂不可见，正在等待账本恢复。`);
        return;
      }
      if (!target) {
        pendingLedgerLocationRef.current = null;
        setLocationFailure(request);
        setLocationAnnouncement(`已切换到 ${request.occurredOn}，但未找到目标账目。可重新加载并再次定位。`);
        window.requestAnimationFrame(() => {
          if (pendingLedgerLocationRef.current === null) {
            locationFailureActionRef.current?.focus({ preventScroll: true });
          }
        });
        return;
      }

      pendingLedgerLocationRef.current = null;
      setLocationFailure(null);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      const action = target.querySelector("[data-ledger-primary-action]");
      if (action instanceof HTMLElement) action.focus({ preventScroll: true });
      setLocationAnnouncement(`已定位到 ${request.referenceCode}，发生日期 ${request.occurredOn}。`);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, expenseListPrintOpen, expenses, invoicePrintItems, status, week.start]);

  useEffect(() => {
    const previewType = expenseListPrintOpen ? "expense-list" : invoicePrintItems ? "invoice" : null;
    if (!previewType) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const content = document.querySelector(".content");
      if (content instanceof HTMLElement) content.scrollTop = 0;
      else window.scrollTo({ top: 0, behavior: "auto" });
      const backButton = document.querySelector(`[data-testid="${previewType}-print-preview-back"]`);
      if (backButton instanceof HTMLElement) backButton.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expenseListPrintOpen, invoicePrintItems]);

  useEffect(() => () => {
    if (previewRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRestoreFrameRef.current);
    }
  }, []);

  const receivedAdvances = useMemo(() => advances.filter((advance) => (
    advance?.status === "received"
      && Number.isSafeInteger(advance?.receivedCents)
      && advance.receivedCents > 0
      && typeof advance.receivedOn === "string"
  )), [advances]);
  const summary = useMemo(() => summarizeTravelExpenses(expenses, receivedAdvances), [expenses, receivedAdvances]);
  const itineraryLabel = useMemo(() => {
    const ids = [...new Set(expenses.map((expense) => expense.itineraryId).filter(Boolean))];
    if (!ids.length) return "本周差旅";
    return ids.map((id) => itineraries.find((item) => item.id === id)?.title).filter(Boolean).join("、") || "本周差旅";
  }, [expenses, itineraries]);

  function navigate(tab) {
    setActiveTab(tab);
  }

  function selectWeek(value) {
    setSelectedLedgerDate(null);
    setHighlightExpenseId(null);
    setProofFocusExpenseId(null);
    setLocationAnnouncement("");
    setLocationFailure(null);
    pendingLedgerLocationRef.current = null;
    // Invalidate the projection synchronously so no old-week region, receipt,
    // or open settings card can be displayed or saved while the new week is
    // loading. The effect below will repopulate all week-scoped data.
    loadedWeekStartRef.current = null;
    setRegionProfile(null);
    setRegionSettingsOpen(false);
    setWeek(weekFromInput(value));
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
      const savedWeek = naturalWeekFor(new Date(`${saved.occurredOn}T12:00:00`));
      if (savedWeek.start === week.start) {
        setExpenses((current) => mergeById(current, saved));
      } else {
        // Editing the occurrence date can move a persisted expense to another
        // natural week. Never merge that row into the currently loaded week:
        // navigate to its canonical week and reload the complete projection.
        setWeek(savedWeek);
      }
      setEditorOpen(false);
      setEditingExpense(null);
      setDraftPrefill(null);
      setActiveTab("ledger");
      setSelectedLedgerDate(saved.occurredOn);
      setHighlightExpenseId(saved.id);
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
    if (!globalThis.confirm?.(`确认删除借款到账“${advance.purpose}”？`)) return;
    try {
      await apiClient.deleteTravelExpenseAdvance(advance.id, advance.version);
      setAdvances((current) => current.filter((item) => item.id !== advance.id));
    } catch (deleteError) {
      setError(expenseErrorMessage(deleteError, "借款到账记录删除失败，请稍后重试。"));
    }
  }

  async function saveRegionProfile(draft) {
    if (!canSaveRegionProfileForWeek({
      loadedWeekStart: loadedWeekStartRef.current,
      selectedWeekStart: week.start,
      draftWeekStart: draft?.weekStart,
    })) {
      throw new Error("当前自然周尚未同步完成，请重新加载后再保存区域。");
    }
    setRegionSaving(true);
    try {
      const saved = await apiClient.saveTravelExpenseRegionProfile(draft);
      setRegionProfile(saved);
      setRegionSettingsOpen(false);
      return saved;
    } finally {
      setRegionSaving(false);
    }
  }

  function reportBookkeepingClientEvent(event, itemCount) {
    // Fire-and-forget telemetry: never block or break the primary interaction.
    try {
      apiClient.recordBookkeepingClientEvent?.(event, { weekStart: week.start, itemCount })?.catch?.(() => {});
    } catch {
      /* telemetry must never interrupt printing or exporting */
    }
  }

  async function exportExpenseList() {
    setExpenseListExporting(true);
    setError("");
    reportBookkeepingClientEvent("export_expense_xlsx", expenses.length);
    try {
      await downloadExpenseListXlsx({
        expenses,
        week,
        matches: invoiceMatches,
        noInvoiceConfirmations,
        regionProfile,
        getAttachmentContentResponse: apiClient.getTravelExpenseAttachmentContentResponse,
      });
    } catch (exportError) {
      setError(expenseErrorMessage(exportError, "费用清单 Excel 导出失败，请稍后重试。"));
    } finally {
      setExpenseListExporting(false);
    }
  }

  function capturePreviewReturn(type) {
    if (previewRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRestoreFrameRef.current);
      previewRestoreFrameRef.current = null;
    }
    const content = document.querySelector(".content");
    const cycle = previewCycleRef.current + 1;
    previewCycleRef.current = cycle;
    previewReturnRef.current = {
      type,
      cycle,
      contentScrollTop: content instanceof HTMLElement ? content.scrollTop : null,
      windowScrollY: window.scrollY,
    };
  }

  function restorePreviewReturn(type) {
    const state = previewReturnRef.current;
    if (!state || state.type !== type) return;
    previewRestoreFrameRef.current = window.requestAnimationFrame(() => {
      previewRestoreFrameRef.current = window.requestAnimationFrame(() => {
        previewRestoreFrameRef.current = null;
        if (previewCycleRef.current !== state.cycle || previewReturnRef.current !== state) return;
        const content = document.querySelector(".content");
        if (content instanceof HTMLElement && state.contentScrollTop !== null) {
          content.scrollTop = state.contentScrollTop;
        } else {
          window.scrollTo({ top: state.windowScrollY, behavior: "auto" });
        }
        const trigger = document.querySelector(`[data-testid="${type}-print-trigger"]`);
        if (trigger instanceof HTMLElement) trigger.focus({ preventScroll: true });
        previewReturnRef.current = null;
      });
    });
  }

  function openExpenseListPrint() {
    capturePreviewReturn("expense-list");
    reportBookkeepingClientEvent("print_expense_list", expenses.length);
    setExpenseListPrintOpen(true);
  }

  function closeExpenseListPrint() {
    setExpenseListPrintOpen(false);
    restorePreviewReturn("expense-list");
  }

  function openInvoicePrint(items) {
    capturePreviewReturn("invoice");
    reportBookkeepingClientEvent("print_invoices", Array.isArray(items) ? items.length : 0);
    setInvoicePrintItems(items);
  }

  function closeInvoicePrint() {
    setInvoicePrintItems(null);
    restorePreviewReturn("invoice");
  }

  function retryLedgerLocation() {
    if (!locationFailure) return;
    pendingLedgerLocationRef.current = locationFailure;
    setLocationFailure(null);
    setLocationAnnouncement(`正在重新加载并定位 ${locationFailure.referenceCode}。`);
    setReloadToken((value) => value + 1);
  }

  const handleProofFocusHandled = useCallback(({ expenseId, referenceCode, found }) => {
    setProofFocusExpenseId(null);
    setLocationAnnouncement(found
      ? `已定位到账目 ${referenceCode ?? expenseId} 的付款凭证。`
      : "未找到对应付款凭证区域，请重新加载。");
  }, []);

  const getAttachmentUrl = (attachmentId) => apiClient.getTravelExpenseAttachmentContentUrl(attachmentId);
  const printPreview = expenseListPrintOpen
    ? <ExpenseListPrintPreview expenses={expenses} week={week} owner={owner} matches={invoiceMatches} noInvoiceConfirmations={noInvoiceConfirmations} regionProfile={regionProfile} getAttachmentUrl={getAttachmentUrl} getAttachmentContentResponse={apiClient.getTravelExpenseAttachmentContentResponse} onClose={closeExpenseListPrint} />
    : invoicePrintItems
      ? <InvoicePrintPreview invoices={invoicePrintItems} week={week} owner={owner} getInvoiceContentUrl={apiClient.getInvoiceContentUrl} getInvoiceContentResponse={apiClient.getInvoiceContentResponse} onClose={closeInvoicePrint} />
      : null;
  const selectedWeekLoaded = loadedWeekStartRef.current === week.start;
  const regionCalloutVisible = Boolean(selectedWeekLoaded && regionProfile
    && !regionProfile.defaultCity && regionProfile.dateOverrides.length === 0);
  // Warn (never auto-write: region saves hold a version lock) when the linked
  // itinerary's destination city is missing from this week's region profile.
  const draftRegion = expenseDraftRef.current?.region ?? null;
  const draftWeekStart = expenseDraftRef.current
    ? naturalWeekFor(new Date(`${expenseDraftRef.current.occurredOn}T12:00:00`)).start
    : null;
  const draftRegionCalloutVisible = Boolean(draftRegion && selectedWeekLoaded && regionProfile
    && week.start === draftWeekStart
    && !hasResponsibleCity(regionProfile.cities, draftRegion));

  return (
    <>
      {printPreview}
      <section className="expense-page" data-testid="page-expense" hidden={Boolean(printPreview)} style={printPreview ? { display: "none" } : undefined}>
      <header className="expense-page-toolbar">
        <div className="expense-page-title"><span>个人工作台</span><h1>费用账本</h1></div>
        <nav ref={tabsRef} className="expense-tabs" aria-label="差旅报销功能" role="tablist">
          {TABS.map((tab, index) => <button key={tab.id} id={`expense-tab-${tab.id}`} className={activeTab === tab.id ? "active" : ""} data-testid={`expense-tab-${tab.id}`} data-trip-region-focus-fallback={tab.id === "ledger" || undefined} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`expense-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => navigate(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{tab.label}</button>)}
        </nav>
        <button className="primary-button" type="button" onClick={() => { setEditingExpense(null); setDraftPrefill(null); setEditorOpen(true); }}><Plus size={16} />手工记一笔</button>
      </header>

      <section className="expense-week-strip">
        <label><CalendarDays size={18} /><span>自然周</span><input type="week" value={isoWeekInput(week.start)} onChange={(event) => selectWeek(event.target.value)} /></label>
        <div className="expense-week-stat"><small>当前范围</small><strong>{week.start}—{week.end}</strong></div>
        <div className="expense-week-stat"><small>行程 / 说明</small><strong>{selectedWeekLoaded ? itineraryLabel : "正在同步"}</strong></div>
        <div className="expense-week-stat"><small>费用与付款</small><strong>{selectedWeekLoaded ? `${summary.expenseCount} 条 · ${summary.paymentCount} 笔` : "—"}</strong></div>
        <button className="icon-button" type="button" aria-label="重新加载本周费用" onClick={() => setReloadToken((value) => value + 1)}><RefreshCw size={17} /></button>
      </section>

      <p className="sr-only" role="status" aria-live="polite">{locationAnnouncement}</p>
      {error || locationFailure || auxiliaryWarning || regionCalloutVisible || draftRegionCalloutVisible ? (
        <div className="expense-page-alerts">
          {error ? <div className="expense-page-alert is-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="ghost-button" type="button" onClick={() => setReloadToken((value) => value + 1)}>重新加载</button></div> : null}
          {locationFailure ? <div className="expense-page-alert is-warning" role="status" data-testid="ledger-location-failure"><CircleAlert size={16} /><span>未找到 {locationFailure.referenceCode}，账目可能尚未同步或已经变更。</span><button ref={locationFailureActionRef} className="ghost-button" type="button" onClick={retryLedgerLocation}>重新加载并定位</button></div> : null}
          {auxiliaryWarning ? <div className="expense-page-alert is-warning" role="status"><CircleAlert size={16} /><span>{auxiliaryWarning}</span><button className="ghost-button" type="button" onClick={() => setReloadToken((value) => value + 1)}>重试辅助数据</button></div> : null}
          {draftRegionCalloutVisible ? <div className="expense-page-alert is-warning" role="status" data-testid="expense-draft-region-warning"><MapPin size={16} /><span>本周区域档案未包含「{draftRegion}」，如当日在该市出差请先补充区域设置。</span><button className="ghost-button" type="button" onClick={() => setRegionSettingsOpen(true)}>打开区域设置</button></div> : null}
          {regionCalloutVisible ? <div className="expense-page-alert is-warning expense-region-callout" role="status"><MapPin size={16} /><span>本周还没有设置出差区域。小小收到付款凭证后会先询问区域，设置后可直接按发生日期匹配。</span><button className="ghost-button" type="button" onClick={() => setRegionSettingsOpen(true)}>设置本周区域</button></div> : null}
        </div>
      ) : null}
      {status === "loading" ? <div className="expense-loading" role="status"><LoaderCircle className="state-spinner" size={24} /><strong>正在读取本周费用</strong><p>费用、付款凭证、发票和借款到账记录正在同步。</p></div> : null}

      {status !== "loading" && selectedWeekLoaded ? (
        <div className="expense-view-stage" id={`expense-panel-${activeTab}`} role="tabpanel" aria-labelledby={`expense-tab-${activeTab}`} tabIndex={0}>
          {activeTab === "ledger" ? <>
            <ExpenseLedgerWorkbench
              week={week}
              expenses={expenses}
              advances={advances}
              reviews={weixinBookkeepingReviews}
              matches={invoiceMatches}
              noInvoiceConfirmations={noInvoiceConfirmations}
              regionProfile={regionProfile}
              selectedDate={selectedLedgerDate}
              highlightExpenseId={highlightExpenseId}
              onSelectDate={setSelectedLedgerDate}
              onOpenItem={(item, projection) => {
                if (projection.kind === "expense") {
                  setEditingExpense(item);
                  setEditorOpen(true);
                  return;
                }
                document.getElementById("expense-ledger-advances")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              onOpenProof={(expense, projection) => {
                const details = document.getElementById("expense-ledger-proofs");
                if (details) details.open = true;
                const expenseId = projection?.sourceId ?? expense?.id;
                setProofFocusExpenseId(expenseId ?? null);
              }}
              onOpenRegionSettings={() => setRegionSettingsOpen(true)}
              getAttachmentContentResponse={apiClient.getTravelExpenseAttachmentContentResponse}
              onRetry={() => setReloadToken((value) => value + 1)}
              onOpenExpenseListPrint={openExpenseListPrint}
              onExportExpenseList={() => void exportExpenseList()}
              exporting={expenseListExporting}
            />
            <div className="expense-ledger-child-functions">
              <details id="expense-ledger-proofs" className="expense-ledger-child-card">
                <summary><span><strong>付款凭证</strong><small>导入、人工关联和查看已附付款原件</small></span><b>{documentInbox.length} 待处理</b></summary>
                <PaymentProofCenter expenses={expenses} inboxItems={documentInbox} getAttachmentUrl={getAttachmentUrl} getAttachmentContentResponse={apiClient.getTravelExpenseAttachmentContentResponse} getInboxContentUrl={apiClient.getTravelExpenseDocumentInboxContentUrl} getInboxContentResponse={apiClient.getTravelExpenseDocumentInboxContentResponse} onConfirmInbox={confirmInboxItem} onRejectInbox={rejectInboxItem} pendingInboxId={pendingInboxId} onUpload={uploadAttachment} onDelete={deleteAttachment} pendingAttachmentId={pendingAttachmentId} focusExpenseId={proofFocusExpenseId} onFocusExpenseHandled={handleProofFocusHandled} />
              </details>
              <details id="expense-ledger-advances" className="expense-ledger-child-card">
                <summary><span><strong>借款到账</strong><small>只记录实际到账的“收入 / 出差借款”</small></span><b>{receivedAdvances.length} 笔</b></summary>
                <AdvanceSettlement week={week} summary={summary} advances={receivedAdvances} onSave={saveAdvance} onDelete={deleteAdvance} pending={advancePending} />
              </details>
            </div>
          </> : null}
          {activeTab === "invoices" ? <InvoiceManager apiClient={apiClient} week={week} expenses={expenses} onOpenPrint={openInvoicePrint} onExpenseChanged={() => setReloadToken((value) => value + 1)} /> : null}
        </div>
      ) : null}

      <ExpenseEditorDrawer open={editorOpen} expense={editingExpense} week={week} itineraries={itineraries} customers={customers} prefill={draftPrefill} pending={saving} onClose={() => { setEditorOpen(false); setEditingExpense(null); setDraftPrefill(null); }} onSave={saveExpense} />
      <TripRegionSettingsCard open={selectedWeekLoaded && regionSettingsOpen} profile={regionProfile} pending={regionSaving} onClose={() => setRegionSettingsOpen(false)} onSave={saveRegionProfile} />
      </section>
    </>
  );
}
