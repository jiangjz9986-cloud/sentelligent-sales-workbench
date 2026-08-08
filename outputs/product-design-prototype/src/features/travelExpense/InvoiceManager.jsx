import {
  AlertTriangle,
  Check,
  CircleAlert,
  FileCheck2,
  FileSearch,
  FileText,
  LoaderCircle,
  PackageOpen,
  Printer,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import { prepareTravelExpenseDocument } from "./travelExpenseDocument.js";
import {
  calculateInvoiceMatchAllocation,
  resolveExpenseReferenceCode,
} from "./invoiceMatchingModel.js";
import { formatCny } from "./travelExpenseModel.js";

const STATUS_LABELS = {
  uploaded: "待识别",
  processing: "识别中",
  review_required: "待复核",
  unmatched: "待匹配",
  partially_matched: "部分匹配",
  matched: "已匹配",
  deleted: "已删除",
};

const CATEGORY_LABELS = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  lodging: "住宿",
  transport: "交通",
  hospitality: "招待",
  other: "其他",
};

function initialResource() {
  return { status: "loading", error: "" };
}

function actionKey(prefix) {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("当前浏览器无法生成安全的请求编号，请刷新后重试。");
  return `${prefix}-${id}`;
}

function updateById(items, item) {
  return items.map((current) => current.id === item.id ? item : current);
}

function centsFromYuan(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError("金额必须是大于或等于 0 的数字");
  return Math.round(amount * 100);
}

function yuanFromCents(value) {
  return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "";
}

function invoiceAmount(invoice) {
  return Number.isSafeInteger(invoice?.totalCents) ? formatCny(invoice.totalCents) : "金额待复核";
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "原文件";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function invoiceFieldValue(source, field) {
  const value = source?.[field];
  if (field.endsWith("Cents") && Number.isSafeInteger(value)) return formatCny(value);
  return value === null || value === undefined || value === "" ? "未识别" : String(value);
}

function invoiceConflictFields(invoice) {
  return new Set((invoice?.conflicts ?? []).map((conflict) => conflict.field));
}

function emptyReviewDraft(invoice) {
  return {
    invoiceCode: invoice?.invoiceCode ?? "",
    invoiceNumber: invoice?.invoiceNumber ?? "",
    issuedOn: invoice?.issuedOn ?? invoice?.model?.issuedOn ?? invoice?.ocr?.issuedOn ?? "",
    sellerName: invoice?.sellerName ?? invoice?.model?.sellerName ?? invoice?.ocr?.sellerName ?? "",
    buyerName: invoice?.buyerName ?? invoice?.model?.buyerName ?? invoice?.ocr?.buyerName ?? "",
    totalYuan: yuanFromCents(invoice?.totalCents ?? invoice?.model?.totalCents ?? invoice?.ocr?.totalCents),
    suggestedCategory: invoice?.suggestedCategory ?? "other",
  };
}

function ResourceState({ state, loadingText, empty, isEmpty, retryLabel, onRetry }) {
  if (state.status === "loading") {
    return <div className="invoice-resource-state" role="status"><LoaderCircle className="state-spinner" size={20} /><span>{loadingText}</span></div>;
  }
  if (state.status === "error") {
    return <div className="invoice-resource-state error" role="alert"><CircleAlert size={18} /><span>{state.error}</span><button type="button" onClick={onRetry}><RefreshCw size={14} />{retryLabel}</button></div>;
  }
  if (isEmpty) return <div className="invoice-resource-state empty"><PackageOpen size={20} /><span>{empty}</span></div>;
  return null;
}

export function InvoiceManager({
  apiClient,
  week,
  expenses,
  onOpenPrint = () => {},
  onExpenseChanged = () => {},
}) {
  const [invoices, setInvoices] = useState([]);
  const [matches, setMatches] = useState([]);
  const [confirmations, setConfirmations] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [reviewDraft, setReviewDraft] = useState(() => emptyReviewDraft(null));
  const [matchExpenseId, setMatchExpenseId] = useState("");
  const [matchPaymentId, setMatchPaymentId] = useState("");
  const [matchReferenceCode, setMatchReferenceCode] = useState("");
  const [matchReferenceError, setMatchReferenceError] = useState("");
  const [matchMethod, setMatchMethod] = useState("manual_selection");
  const [noInvoiceExpenseId, setNoInvoiceExpenseId] = useState("");
  const [noInvoicePaymentId, setNoInvoicePaymentId] = useState("");
  const [noInvoiceReason, setNoInvoiceReason] = useState("");
  const [resource, setResource] = useState({
    invoices: initialResource(),
    matches: initialResource(),
    noInvoice: initialResource(),
    candidates: initialResource(),
  });
  const [detailStatus, setDetailStatus] = useState("idle");
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [reload, setReload] = useState({ invoices: 0, matches: 0, noInvoice: 0, candidates: 0 });

  function setResourceState(name, next) {
    setResource((current) => ({ ...current, [name]: next }));
  }

  useEffect(() => {
    const controller = new AbortController();
    setResourceState("invoices", initialResource());
    apiClient.listInvoices({ signal: controller.signal }).then((items) => {
      if (controller.signal.aborted) return;
      setInvoices(items);
      setSelectedInvoiceId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
      setResourceState("invoices", { status: "ready", error: "" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setResourceState("invoices", { status: "error", error: error?.message || "发票加载失败，请稍后重试。" });
    });
    return () => controller.abort();
  }, [apiClient, reload.invoices]);

  useEffect(() => {
    const controller = new AbortController();
    setResourceState("matches", initialResource());
    apiClient.listInvoiceMatches({ signal: controller.signal }).then((items) => {
      if (controller.signal.aborted) return;
      setMatches(items);
      setResourceState("matches", { status: "ready", error: "" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setResourceState("matches", { status: "error", error: error?.message || "发票匹配记录加载失败。" });
    });
    return () => controller.abort();
  }, [apiClient, reload.matches]);

  useEffect(() => {
    const controller = new AbortController();
    setResourceState("noInvoice", initialResource());
    Promise.all([
      apiClient.listNoInvoiceConfirmations({ weekStart: week.start, signal: controller.signal }),
      apiClient.getWeekInvoiceCoverage(week.start, { signal: controller.signal }),
    ]).then(([items, nextCoverage]) => {
      if (controller.signal.aborted) return;
      setConfirmations(items);
      setCoverage(nextCoverage);
      setResourceState("noInvoice", { status: "ready", error: "" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setResourceState("noInvoice", { status: "error", error: error?.message || "无票确认数据加载失败。" });
    });
    return () => controller.abort();
  }, [apiClient, reload.noInvoice, week.start]);

  useEffect(() => {
    const controller = new AbortController();
    setResourceState("candidates", initialResource());
    apiClient.listInvoiceCandidates({ weekStart: week.start, status: "suggested", signal: controller.signal }).then((items) => {
      if (controller.signal.aborted) return;
      setCandidates(items);
      setResourceState("candidates", { status: "ready", error: "" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setResourceState("candidates", { status: "error", error: error?.message || "候选发票加载失败。" });
    });
    return () => controller.abort();
  }, [apiClient, reload.candidates, week.start]);

  useEffect(() => {
    if (!selectedInvoiceId) {
      setSelectedInvoice(null);
      setDetailStatus("idle");
      return undefined;
    }
    const controller = new AbortController();
    setDetailStatus("loading");
    apiClient.getInvoice(selectedInvoiceId, { signal: controller.signal }).then((invoice) => {
      if (controller.signal.aborted) return;
      setSelectedInvoice(invoice);
      setReviewDraft(emptyReviewDraft(invoice));
      setDetailStatus("ready");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setSelectedInvoice(invoices.find((item) => item.id === selectedInvoiceId) ?? null);
      setDetailStatus("error");
      setActionError(error?.message || "发票详情加载失败，请重新选择。 ");
    });
    return () => controller.abort();
  }, [apiClient, invoices, selectedInvoiceId]);

  const matchExpense = expenses.find((expense) => expense.id === matchExpenseId);
  const noInvoiceExpense = expenses.find((expense) => expense.id === noInvoiceExpenseId);
  const selectedMatches = matches.filter((match) => match.invoiceId === selectedInvoiceId && match.state !== "revoked");
  const conflictFields = useMemo(() => invoiceConflictFields(selectedInvoice), [selectedInvoice]);
  const printableInvoices = useMemo(() => {
    const weekExpenseIds = new Set(expenses.map((expense) => expense.id));
    const matchedInvoiceIds = new Set(matches
      .filter((match) => match.state !== "revoked" && weekExpenseIds.has(match.expenseId))
      .map((match) => match.invoiceId));
    return invoices.filter((invoice) => matchedInvoiceIds.has(invoice.id) && invoice.status !== "deleted");
  }, [expenses, invoices, matches]);

  async function perform(name, action) {
    setPendingAction(name);
    setActionError("");
    try {
      return await action();
    } catch (error) {
      setActionError(error?.message || "操作失败，请稍后重试。 ");
      return null;
    } finally {
      setPendingAction("");
    }
  }

  async function uploadInvoice(file) {
    const uploaded = await perform("upload", async () => {
      const prepared = await prepareTravelExpenseDocument(file);
      return apiClient.uploadInvoice({
        fileName: prepared.fileName,
        mediaType: prepared.mediaType,
        contentBase64: prepared.contentBase64,
        sourceRef: "manual-upload",
      }, { idempotencyKey: actionKey("invoice-upload") });
    });
    if (!uploaded) return;
    setInvoices((current) => [uploaded, ...current.filter((item) => item.id !== uploaded.id)]);
    setSelectedInvoiceId(uploaded.id);
  }

  async function saveReview(event) {
    event.preventDefault();
    if (!selectedInvoice) return;
    const reviewed = await perform("review", () => apiClient.reviewInvoice(selectedInvoice.id, {
      invoiceCode: reviewDraft.invoiceCode || null,
      invoiceNumber: reviewDraft.invoiceNumber || null,
      issuedOn: reviewDraft.issuedOn || null,
      sellerName: reviewDraft.sellerName || null,
      buyerName: reviewDraft.buyerName || null,
      totalCents: centsFromYuan(reviewDraft.totalYuan),
      suggestedCategory: reviewDraft.suggestedCategory || "other",
    }, selectedInvoice.version));
    if (!reviewed) return;
    setSelectedInvoice(reviewed);
    setReviewDraft(emptyReviewDraft(reviewed));
    setInvoices((current) => updateById(current, reviewed));
  }

  async function deleteInvoice() {
    if (!selectedInvoice || !globalThis.confirm?.(`确认删除发票“${selectedInvoice.fileName}”？`)) return;
    const deleted = await perform("delete", () => apiClient.deleteInvoice(selectedInvoice.id, selectedInvoice.version));
    if (!deleted) return;
    setInvoices((current) => current.filter((item) => item.id !== deleted.id));
    setSelectedInvoiceId("");
  }

  async function createMatch() {
    const expense = matchExpense;
    const payment = expense?.payments.find((item) => item.id === matchPaymentId);
    if (!selectedInvoice || !expense || !payment) {
      setActionError("请先选择发票、费用和具体付款记录。");
      return;
    }
    const allocatedCents = calculateInvoiceMatchAllocation({
      invoice: selectedInvoice,
      payment,
      matches,
    });
    if (allocatedCents <= 0) {
      setActionError("当前发票或付款已无可匹配金额，请刷新后重新选择。");
      return;
    }
    const created = await perform("match", () => apiClient.createInvoiceMatch(selectedInvoice.id, {
      expenseReferenceCode: expense.referenceCode,
      paymentId: payment.id,
      allocatedCents,
      matchMethod,
    }, selectedInvoice.version, { idempotencyKey: actionKey("invoice-match") }));
    if (!created) return;
    setMatches((current) => [created, ...current]);
    setMatchExpenseId("");
    setMatchPaymentId("");
    setMatchReferenceCode("");
    setMatchReferenceError("");
    setMatchMethod("manual_selection");
    setReload((current) => ({ ...current, invoices: current.invoices + 1, noInvoice: current.noInvoice + 1 }));
    onExpenseChanged();
  }

  function findExpenseByReferenceCode() {
    try {
      const expense = resolveExpenseReferenceCode(expenses, matchReferenceCode);
      setMatchExpenseId(expense.id);
      setMatchPaymentId("");
      setMatchReferenceCode(expense.referenceCode);
      setMatchReferenceError("");
      setMatchMethod("manual_code");
    } catch (error) {
      setMatchExpenseId("");
      setMatchPaymentId("");
      setMatchReferenceError(error instanceof Error ? error.message : "未找到该账单编号，请检查后重试");
    }
  }

  async function revokeMatch(match) {
    const revoked = await perform(`revoke-match-${match.id}`, () => apiClient.revokeInvoiceMatch(match.id, match.version));
    if (!revoked) return;
    setMatches((current) => updateById(current, revoked));
    setReload((current) => ({ ...current, invoices: current.invoices + 1, noInvoice: current.noInvoice + 1 }));
    onExpenseChanged();
  }

  async function confirmNoInvoice() {
    const expense = noInvoiceExpense;
    const payment = expense?.payments.find((item) => item.id === noInvoicePaymentId);
    if (!expense || !payment || !noInvoiceReason.trim()) {
      setActionError("请选择费用和付款，并填写无票原因。");
      return;
    }
    const confirmed = await perform("no-invoice", () => apiClient.confirmNoInvoice(expense.id, {
      paymentId: payment.id,
      reason: noInvoiceReason.trim(),
    }, expense.version, { idempotencyKey: actionKey("no-invoice") }));
    if (!confirmed) return;
    setConfirmations((current) => [confirmed, ...current]);
    setNoInvoiceExpenseId("");
    setNoInvoicePaymentId("");
    setNoInvoiceReason("");
    setReload((current) => ({ ...current, noInvoice: current.noInvoice + 1 }));
    onExpenseChanged();
  }

  async function revokeNoInvoice(confirmation) {
    const expense = expenses.find((item) => item.id === confirmation.expenseId);
    if (!expense) {
      setActionError("费用记录不存在，无法撤销无票确认。");
      return;
    }
    const revoked = await perform(`revoke-no-invoice-${confirmation.id}`, () => (
      apiClient.revokeNoInvoice(expense.id, confirmation.id, confirmation.version)
    ));
    if (!revoked) return;
    setConfirmations((current) => updateById(current, revoked));
    setReload((current) => ({ ...current, noInvoice: current.noInvoice + 1 }));
    onExpenseChanged();
  }

  async function generateCandidates() {
    const generated = await perform("generate-candidates", () => apiClient.generateInvoiceCandidates(week.start, {
      idempotencyKey: actionKey("invoice-candidates"),
    }));
    if (generated) {
      setCandidates(generated);
      setResourceState("candidates", { status: "ready", error: "" });
    }
  }

  async function decideCandidate(candidate, decision) {
    const decided = await perform(`${decision}-${candidate.id}`, () => (
      decision === "accept"
        ? apiClient.acceptInvoiceCandidate(candidate.id, candidate.version, { idempotencyKey: actionKey("candidate-accept") })
        : apiClient.rejectInvoiceCandidate(candidate.id, candidate.version, { idempotencyKey: actionKey("candidate-reject") })
    ));
    if (!decided) return;
    setCandidates((current) => updateById(current, decided));
    if (decision === "accept") {
      setReload((current) => ({ ...current, invoices: current.invoices + 1, matches: current.matches + 1, noInvoice: current.noInvoice + 1 }));
      onExpenseChanged();
    }
  }

  return (
    <section className="invoice-manager">
      <header className="expense-section-intro invoice-manager-intro">
        <div>
          <strong>发票管理</strong>
          <p>原件独立保存；OCR 与模型结果并排核对，冲突项必须人工复核后再匹配费用。</p>
        </div>
        <div className="invoice-manager-actions">
          <button className="invoice-print-button" type="button" disabled={resource.matches.status !== "ready" || printableInvoices.length === 0} title={printableInvoices.length ? `本周可打印 ${printableInvoices.length} 份已匹配发票` : "本周暂无已匹配发票"} onClick={() => onOpenPrint(printableInvoices)}><Printer size={17} />打印本周已匹配发票<span>{printableInvoices.length}</span></button>
          <label className="invoice-upload-button" aria-disabled={pendingAction === "upload"}>
            {pendingAction === "upload" ? <LoaderCircle className="state-spinner" size={17} /> : <Upload size={17} />}
            <span>{pendingAction === "upload" ? "正在上传" : "上传发票"}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={pendingAction === "upload"} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadInvoice(file);
              event.target.value = "";
            }} />
          </label>
        </div>
      </header>

      {actionError ? <div className="invoice-action-error" role="alert"><CircleAlert size={18} /><span>{actionError}</span><button type="button" aria-label="关闭错误提示" onClick={() => setActionError("")}><X size={17} /></button></div> : null}

      <div className="invoice-manager-grid">
        <section className="invoice-repository" aria-label="发票仓库">
          <header><div><PackageOpen size={18} /><strong>发票仓库</strong></div><span>{invoices.length} 份</span></header>
          <ResourceState state={resource.invoices} loadingText="正在读取发票" empty="暂未上传发票" isEmpty={invoices.length === 0} retryLabel="重新加载发票" onRetry={() => setReload((current) => ({ ...current, invoices: current.invoices + 1 }))} />
          {resource.invoices.status === "ready" ? <div className="invoice-repository-list">
            {invoices.map((invoice) => (
              <button className={selectedInvoiceId === invoice.id ? "active" : ""} type="button" key={invoice.id} onClick={() => setSelectedInvoiceId(invoice.id)}>
                <span className="invoice-file-icon"><FileText size={18} /></span>
                <span><strong>{invoice.fileName}</strong><small>{invoice.issuedOn || invoice.createdAt?.slice(0, 10) || "日期待识别"} · {formatFileSize(invoice.sizeBytes)}</small></span>
                <span><strong>{invoiceAmount(invoice)}</strong><small className={`invoice-status ${invoice.status}`}>{STATUS_LABELS[invoice.status] ?? invoice.status}</small></span>
              </button>
            ))}
          </div> : null}
        </section>

        <section className="invoice-detail-panel" aria-label="发票详情">
          {!selectedInvoiceId ? <div className="invoice-detail-empty"><FileSearch size={24} /><strong>选择一份发票查看详情</strong><span>可核对识别结果、查看原件并匹配费用。</span></div> : null}
          {selectedInvoiceId && detailStatus === "loading" ? <div className="invoice-detail-empty" role="status"><LoaderCircle className="state-spinner" size={22} /><strong>正在读取发票详情</strong></div> : null}
          {selectedInvoice && detailStatus !== "loading" ? (
            <>
              <header className="invoice-detail-head">
                <div><span>发票详情</span><strong>{selectedInvoice.fileName}</strong><small>{invoiceAmount(selectedInvoice)} · {STATUS_LABELS[selectedInvoice.status] ?? selectedInvoice.status}</small></div>
                <div><a href={apiClient.getInvoiceContentUrl(selectedInvoice.id)} target="_blank" rel="noreferrer">查看原件</a><button type="button" className="danger" onClick={deleteInvoice} disabled={pendingAction === "delete"}><Trash2 size={15} />删除</button></div>
              </header>

              <div className="invoice-detail-scroll">
                <section className="invoice-original-preview">
                  {selectedInvoice.mediaType.startsWith("image/")
                    ? <img src={apiClient.getInvoiceContentUrl(selectedInvoice.id)} alt={selectedInvoice.fileName} />
                    : <AuthenticatedPdfFrame resourceKey={selectedInvoice.id} loadPdf={({ signal }) => apiClient.getInvoiceContentResponse(selectedInvoice.id, { signal })} title={`${selectedInvoice.fileName}原件预览`} renderWidth={1200} />}
                </section>

                <section className="invoice-recognition-card">
                  <header><div><FileSearch size={17} /><strong>OCR / 模型对比</strong></div>{selectedInvoice.conflicts?.length ? <span className="has-conflict"><AlertTriangle size={14} />识别冲突 {selectedInvoice.conflicts.length} 项</span> : <span className="no-conflict"><Check size={14} />结果一致</span>}</header>
                  <div className="invoice-recognition-table" role="table" aria-label="发票识别结果对比">
                    <div className="heading" role="row"><span>字段</span><span>OCR</span><span>模型</span></div>
                    {[
                      ["issuedOn", "开票日期"],
                      ["totalCents", "价税合计"],
                      ["sellerName", "销售方"],
                      ["invoiceNumber", "发票号码"],
                    ].map(([field, label]) => <div className={conflictFields.has(field) ? "conflict" : ""} role="row" key={field}><strong>{label}</strong><span>{invoiceFieldValue(selectedInvoice.ocr, field)}</span><span>{invoiceFieldValue(selectedInvoice.model, field)}</span></div>)}
                  </div>
                  {selectedInvoice.conflicts?.length ? <p><AlertTriangle size={15} />识别冲突不会自动覆盖，需在下方人工复核。</p> : null}
                </section>

                <form className="invoice-review-form" onSubmit={saveReview}>
                  <header><div><FileCheck2 size={17} /><strong>人工复核</strong></div><span>保存后才能作为正式匹配依据</span></header>
                  <div>
                    <label><span>发票号码</span><input value={reviewDraft.invoiceNumber} onChange={(event) => setReviewDraft((current) => ({ ...current, invoiceNumber: event.target.value }))} /></label>
                    <label><span>开票日期</span><input type="date" value={reviewDraft.issuedOn} onChange={(event) => setReviewDraft((current) => ({ ...current, issuedOn: event.target.value }))} /></label>
                    <label><span>价税合计（元）</span><input type="number" min="0" step="0.01" value={reviewDraft.totalYuan} onChange={(event) => setReviewDraft((current) => ({ ...current, totalYuan: event.target.value }))} /></label>
                    <label><span>费用类别</span><select value={reviewDraft.suggestedCategory} onChange={(event) => setReviewDraft((current) => ({ ...current, suggestedCategory: event.target.value }))}>{Object.entries(CATEGORY_LABELS).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
                    <label><span>销售方</span><input value={reviewDraft.sellerName} onChange={(event) => setReviewDraft((current) => ({ ...current, sellerName: event.target.value }))} /></label>
                    <label><span>购买方</span><input value={reviewDraft.buyerName} onChange={(event) => setReviewDraft((current) => ({ ...current, buyerName: event.target.value }))} /></label>
                  </div>
                  <button type="submit" disabled={pendingAction === "review"}>{pendingAction === "review" ? <LoaderCircle className="state-spinner" size={15} /> : <Check size={15} />}保存人工复核</button>
                </form>

                <section className="invoice-match-card">
                  <header><div><FileCheck2 size={17} /><strong>发票匹配</strong></div><span>{selectedMatches.length} 条有效匹配</span></header>
                  <div className="invoice-match-form">
                    <label><span>费用记录</span><select value={matchExpenseId} onChange={(event) => { const expenseId = event.target.value; const expense = expenses.find((item) => item.id === expenseId); setMatchExpenseId(expenseId); setMatchPaymentId(""); setMatchReferenceCode(expense?.referenceCode ?? ""); setMatchReferenceError(""); setMatchMethod("manual_selection"); }}><option value="">请选择费用</option>{expenses.map((expense) => <option value={expense.id} key={expense.id}>{expense.referenceCode} · {expense.occurredOn} · {expense.purpose}</option>)}</select></label>
                    <label className="invoice-match-reference"><span>账单编号</span><div><input value={matchReferenceCode} placeholder="EXP-20260804-XXXXXXXX" aria-invalid={Boolean(matchReferenceError)} aria-describedby="invoice-match-reference-error" onChange={(event) => { setMatchReferenceCode(event.target.value.toUpperCase()); setMatchReferenceError(""); setMatchExpenseId(""); setMatchPaymentId(""); setMatchMethod("manual_code"); }} onBlur={() => { if (matchReferenceCode.trim()) findExpenseByReferenceCode(); }} /><button type="button" onClick={findExpenseByReferenceCode}>查找账单</button></div>{matchReferenceError ? <small id="invoice-match-reference-error" role="alert">{matchReferenceError}</small> : null}</label>
                    <label><span>付款记录</span><select value={matchPaymentId} disabled={!matchExpense} onChange={(event) => setMatchPaymentId(event.target.value)}><option value="">请选择付款</option>{matchExpense?.payments.map((payment, index) => <option value={payment.id} key={payment.id}>付款 {index + 1} · {formatCny(payment.reimbursementCents)}</option>)}</select></label>
                    <button type="button" onClick={createMatch} disabled={pendingAction === "match"}>确认匹配</button>
                  </div>
                  <div className="invoice-match-list">
                    {selectedMatches.map((match) => {
                      const expense = expenses.find((item) => item.id === match.expenseId);
                      return <article key={match.id}><div><strong>{expense?.purpose ?? match.expenseId}</strong><small>{formatCny(match.allocatedCents ?? 0)} · {match.paymentId || "整笔费用"}</small></div><button type="button" onClick={() => revokeMatch(match)} disabled={pendingAction === `revoke-match-${match.id}`}><RotateCcw size={14} />撤销</button></article>;
                    })}
                    {resource.matches.status === "loading" ? <div className="invoice-inline-state"><LoaderCircle className="state-spinner" size={16} />正在读取匹配记录</div> : null}
                    {resource.matches.status === "error" ? <div className="invoice-inline-state error"><CircleAlert size={16} />{resource.matches.error}<button type="button" onClick={() => setReload((current) => ({ ...current, matches: current.matches + 1 }))}>重新加载</button></div> : null}
                    {resource.matches.status === "ready" && selectedMatches.length === 0 ? <div className="invoice-inline-state">当前发票尚未匹配费用</div> : null}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </section>
      </div>

      <div className="invoice-operations-grid">
        <section className="invoice-operation-card">
          <header><div><CircleAlert size={17} /><strong>确认无票</strong></div><span>人工确认</span></header>
          <ResourceState state={resource.noInvoice} loadingText="正在读取无票记录" empty="本周暂无无票确认" isEmpty={confirmations.filter((item) => !item.revokedAt).length === 0} retryLabel="重新加载无票记录" onRetry={() => setReload((current) => ({ ...current, noInvoice: current.noInvoice + 1 }))} />
          {resource.noInvoice.status === "ready" ? <>
            <div className="invoice-coverage-strip">
              <span><small>本周应报销</small><strong>{formatCny(coverage?.reimbursementCents ?? 0)}</strong></span>
              <span><small>已覆盖</small><strong>{formatCny(coverage?.confirmedCoverageCents ?? 0)}</strong></span>
              <span><small>确认无票</small><strong>{formatCny(coverage?.noInvoiceConfirmedCents ?? 0)}</strong></span>
              <span className="warning"><small>仍缺发票</small><strong>{formatCny(coverage?.missingInvoiceCents ?? 0)}</strong></span>
            </div>
            <div className="invoice-no-ticket-form">
              <label><span>费用</span><select value={noInvoiceExpenseId} onChange={(event) => { setNoInvoiceExpenseId(event.target.value); setNoInvoicePaymentId(""); }}><option value="">请选择费用</option>{expenses.map((expense) => <option value={expense.id} key={expense.id}>{expense.occurredOn} · {expense.purpose}</option>)}</select></label>
              <label><span>付款</span><select value={noInvoicePaymentId} disabled={!noInvoiceExpense} onChange={(event) => setNoInvoicePaymentId(event.target.value)}><option value="">请选择付款</option>{noInvoiceExpense?.payments.map((payment, index) => <option value={payment.id} key={payment.id}>付款 {index + 1} · {formatCny(payment.reimbursementCents)}</option>)}</select></label>
              <label className="wide"><span>无票原因</span><input value={noInvoiceReason} placeholder="例如：商户无法开票" onChange={(event) => setNoInvoiceReason(event.target.value)} /></label>
              <button type="button" onClick={confirmNoInvoice} disabled={pendingAction === "no-invoice"}>确认无票</button>
            </div>
            <div className="invoice-confirmation-list">
              {confirmations.filter((item) => !item.revokedAt).map((confirmation) => {
                const expense = expenses.find((item) => item.id === confirmation.expenseId);
                return <article key={confirmation.id}><div><strong>{expense?.purpose ?? confirmation.expenseId}</strong><small>{formatCny(confirmation.amountSnapshotCents ?? 0)} · {confirmation.reason}</small></div><button type="button" onClick={() => revokeNoInvoice(confirmation)} disabled={pendingAction === `revoke-no-invoice-${confirmation.id}`}><RotateCcw size={14} />撤销</button></article>;
              })}
            </div>
          </> : null}
        </section>

        <section className="invoice-operation-card invoice-candidate-card">
          <header><div><Sparkles size={17} /><strong>候选发票</strong></div><button type="button" onClick={generateCandidates} disabled={pendingAction === "generate-candidates"}>{pendingAction === "generate-candidates" ? <LoaderCircle className="state-spinner" size={15} /> : <Sparkles size={15} />}自动生成候选</button></header>
          <ResourceState state={resource.candidates} loadingText="正在读取候选发票" empty="暂无可用候选发票" isEmpty={candidates.filter((item) => item.status === "suggested").length === 0} retryLabel="重新加载候选发票" onRetry={() => setReload((current) => ({ ...current, candidates: current.candidates + 1 }))} />
          {resource.candidates.status === "ready" ? <div className="invoice-candidate-list">
            {candidates.filter((candidate) => candidate.status === "suggested").map((candidate) => {
              const invoice = invoices.find((item) => item.id === candidate.invoiceId);
              const expense = expenses.find((item) => item.id === candidate.expenseId);
              return <article key={candidate.id}><div className="invoice-candidate-score"><strong>{Math.round(candidate.score ?? 0)}</strong><span>匹配分</span></div><div><strong>{invoice?.fileName ?? candidate.invoiceId}</strong><span>→ {expense?.purpose ?? candidate.expenseId}</span><small>{formatCny(candidate.proposedCents ?? 0)} · {(candidate.rationale ?? []).join(" · ") || "等待人工判断"}</small></div><nav><button type="button" className="accept" onClick={() => decideCandidate(candidate, "accept")} disabled={pendingAction === `accept-${candidate.id}`}><Check size={14} />接受</button><button type="button" onClick={() => decideCandidate(candidate, "reject")} disabled={pendingAction === `reject-${candidate.id}`}><X size={14} />忽略</button></nav></article>;
            })}
          </div> : null}
        </section>
      </div>
    </section>
  );
}
