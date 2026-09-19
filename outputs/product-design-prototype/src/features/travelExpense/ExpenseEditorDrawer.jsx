import {
  CalendarDays,
  Check,
  CircleAlert,
  Edit3,
  FileText,
  MapPin,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ExpenseEvidencePanel } from "./ExpenseEvidencePanel.jsx";
import {
  buildAutomaticExpenseNote,
  EXPENSE_CATEGORIES,
  FUNDING_SOURCES,
  INVOICE_STATUSES,
  formatCny,
  formatTravelExpenseDateTime,
  resolveExpenseInvoiceType,
} from "./travelExpenseModel.js";

const PAYMENT_METHODS = [
  { id: "wechat", label: "微信支付" },
  { id: "alipay", label: "支付宝" },
  { id: "card", label: "银行卡" },
  { id: "cash", label: "现金" },
  { id: "other", label: "其他" },
];

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function centsToInput(value) {
  return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "";
}

function inputToCents(value, label) {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new TypeError(`${label}请输入不小于 0 的金额，最多两位小数`);
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents)) throw new TypeError(`${label}金额过大`);
  return cents;
}

function emptyPayment() {
  return {
    paidAt: localDateTime(new Date()),
    merchant: "",
    amount: "",
    reimbursement: "",
    fundingSource: "personal",
    paymentMethod: "wechat",
    accountLast4: "",
    differenceReason: "",
  };
}

function regionForDate(regionProfile, occurredOn) {
  const override = regionProfile?.dateOverrides?.find((item) => item.date === occurredOn);
  if (override?.city) return { city: override.city, source: "date_override" };
  if (regionProfile?.defaultCity) return { city: regionProfile.defaultCity, source: "week_default" };
  return { city: null, source: null };
}

function expenseDateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : value;
}

function ExpenseInfoItem({ label, value, icon: Icon }) {
  return (
    <div className="expense-detail-info-item">
      <dt>{Icon ? <Icon size={14} aria-hidden="true" /> : null}{label}</dt>
      <dd>{value || "未填写"}</dd>
    </div>
  );
}

function ExpenseDetailView({
  expense,
  matches,
  noInvoiceConfirmations,
  getAttachmentUrl,
  getAttachmentContentResponse,
  onReplace,
  onDelete,
  onVersionChange,
  pendingAttachmentId,
  onClose,
  onEdit,
}) {
  const payments = expense.payments ?? [];
  const category = EXPENSE_CATEGORIES.find((item) => item.id === expense.category)?.label ?? expense.category;
  const notes = String(expense.notes ?? "").trim() || String(expense.purpose ?? "").trim();
  const entrySource = {
    manual: "人工录入",
    weixin: "微信录入",
    icost: "系统同步",
  }[expense.source] ?? `${payments.length} 笔付款 · ${category}`;

  return (
    <>
      <div className="expense-detail-view">
        <section className="expense-detail-section" aria-labelledby="expense-detail-info-title">
          <header>
            <div><FileText size={16} aria-hidden="true" /><h3 id="expense-detail-info-title">费用信息</h3></div>
            <span>{entrySource}</span>
          </header>
          <div className="expense-detail-payment-list">
            {payments.map((payment, index) => (
              <article
                className={`expense-detail-payment-card${payments.length === 1 ? " is-single" : ""}`}
                key={payment.id ?? index}
              >
                {payments.length > 1 ? (
                  <div className="expense-detail-payment-head">
                    <strong>第 {index + 1} 笔付款</strong>
                    <b>{formatCny(payment.amountCents ?? 0)}</b>
                  </div>
                ) : null}
                <dl className="expense-detail-payment-info-grid">
                  <ExpenseInfoItem label="支付时间" value={formatTravelExpenseDateTime(payment.paidAt)} icon={CalendarDays} />
                  <ExpenseInfoItem label="出差区域" value={expense.tripRegion} icon={MapPin} />
                  <ExpenseInfoItem label="付款金额" value={formatCny(payment.amountCents ?? 0)} />
                  <ExpenseInfoItem label="费用事由" value={notes} />
                </dl>
              </article>
            ))}
            {payments.length === 0 ? <p className="expense-detail-empty">暂无付款记录</p> : null}
          </div>
        </section>

        <ExpenseEvidencePanel
          expense={expense}
          invoiceType={String(expense.invoiceType ?? "").trim()
            || resolveExpenseInvoiceType(expense, { matches, noInvoiceConfirmations })
            || "unprovided"}
          readOnly
          getAttachmentUrl={getAttachmentUrl}
          getAttachmentContentResponse={getAttachmentContentResponse}
          onInvoiceTypeChange={() => {}}
          onReplace={onReplace}
          onDelete={onDelete}
          onVersionChange={onVersionChange}
          pendingAttachmentId={pendingAttachmentId}
        />
      </div>
      <footer className="expense-drawer-actions expense-detail-actions">
        <div>
          <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
          <button className="primary-button" type="button" data-expense-edit onClick={onEdit}>
            <Edit3 size={16} aria-hidden="true" />编辑记账
          </button>
        </div>
      </footer>
    </>
  );
}

function createDraft(expense, weekStart, prefill = null, regionProfile = null, invoiceContext = {}) {
  const occurredOn = expense?.occurredOn ?? prefill?.occurredOn ?? weekStart;
  const category = expense?.category ?? (prefill ? "transport" : "breakfast");
  const resolvedRegion = regionForDate(regionProfile, occurredOn);
  const tripRegion = expense?.tripRegion ?? prefill?.tripRegion ?? resolvedRegion.city ?? "";
  const tripRegionSource = expense?.tripRegionSource ?? prefill?.tripRegionSource ?? resolvedRegion.source ?? "";
  const suppliedNotes = expense?.notes ?? prefill?.notes;
  const notes = (typeof suppliedNotes === "string" ? suppliedNotes.trim() : "") || buildAutomaticExpenseNote({
    occurredOn,
    category,
    tripRegion,
  });
  if (!expense) {
    return {
      occurredOn,
      // A visit-linked draft defaults to transport (the most common on-the-road
      // expense); plain manual entry keeps the existing breakfast default.
      category,
      purpose: prefill?.purpose ?? "",
      merchant: "",
      itineraryId: prefill?.itineraryId ?? "",
      customerId: prefill?.customerId ?? "",
      invoiceType: "unprovided",
      tripRegion,
      tripRegionSource,
      notes,
      payments: [emptyPayment()],
    };
  }
  const invoiceType = String(expense.invoiceType ?? "").trim()
    || resolveExpenseInvoiceType(expense, invoiceContext)
    || "unprovided";
  return {
    id: expense.id,
    version: expense.version,
    occurredOn: expense.occurredOn,
    category: expense.category,
    purpose: expense.purpose ?? "",
    merchant: expense.merchant ?? "",
    itineraryId: expense.itineraryId ?? "",
    customerId: expense.customerId ?? "",
    invoiceType,
    tripRegion,
    tripRegionSource,
    notes,
    payments: expense.payments.map((payment) => ({
      id: payment.id,
      paidAt: localDateTime(payment.paidAt),
      merchant: payment.merchant ?? "",
      amount: centsToInput(payment.amountCents),
      reimbursement: centsToInput(payment.reimbursementCents),
      fundingSource: payment.fundingSource,
      paymentMethod: payment.paymentMethod ?? "other",
      accountLast4: payment.accountLast4 ?? "",
      differenceReason: payment.differenceReason ?? "",
    })),
  };
}

export function ExpenseEditorDrawer({
  open,
  expense,
  week,
  itineraries = [],
  customers = [],
  regionProfile = null,
  prefill = null,
  pending = false,
  matches = [],
  noInvoiceConfirmations = [],
  getAttachmentUrl,
  getAttachmentContentResponse,
  onReplace,
  onDelete,
  pendingAttachmentId,
  onClose,
  onSave,
}) {
  const invoiceContextRef = useRef({ matches, noInvoiceConfirmations });
  const [draft, setDraft] = useState(() => createDraft(expense, week.start, prefill, regionProfile, invoiceContextRef.current));
  const [error, setError] = useState("");
  const [isEditing, setIsEditing] = useState(() => !expense);
  const expenseId = expense?.id ?? null;

  useEffect(() => {
    invoiceContextRef.current = { matches, noInvoiceConfirmations };
  }, [matches, noInvoiceConfirmations]);

  useEffect(() => {
    if (!open) return;
    setDraft(createDraft(expense, week.start, prefill, regionProfile, invoiceContextRef.current));
    setError("");
  }, [expenseId, open, prefill, week.start]);

  useEffect(() => {
    if (!open) return;
    setIsEditing(!expense);
  }, [expenseId, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, pending]);

  const totals = useMemo(() => draft.payments.reduce((summary, payment) => ({
    actual: summary.actual + (Number(payment.amount) || 0),
    reimbursement: summary.reimbursement + (Number(payment.reimbursement) || 0),
  }), { actual: 0, reimbursement: 0 }), [draft.payments]);
  const derivedInvoiceStatus = INVOICE_STATUSES.find((item) => item.id === expense?.invoiceStatus)
    ?? INVOICE_STATUSES[0];
  const selectedCategory = EXPENSE_CATEGORIES.find((item) => item.id === draft.category)?.label ?? draft.category;

  if (!open) return null;

  function updateField(field, value) {
    setDraft((current) => {
      if (!["category", "occurredOn", "tripRegion"].includes(field)) return { ...current, [field]: value };
      const oldAutomaticNote = buildAutomaticExpenseNote({
        occurredOn: current.occurredOn,
        category: current.category,
        tripRegion: current.tripRegion,
      });
      const nextOccurredOn = field === "occurredOn" ? value : current.occurredOn;
      const nextCategory = field === "category" ? value : current.category;
      const nextTripRegion = field === "tripRegion" ? value : current.tripRegion;
      const nextAutomaticNote = buildAutomaticExpenseNote({
        occurredOn: nextOccurredOn,
        category: nextCategory,
        tripRegion: nextTripRegion,
      });
      const currentNotes = current.notes.trim();
      const shouldRefreshNote = !currentNotes || currentNotes === oldAutomaticNote;
      return {
        ...current,
        [field]: value,
        ...(field === "tripRegion" ? { tripRegionSource: "" } : {}),
        ...(shouldRefreshNote ? { notes: nextAutomaticNote } : {}),
      };
    });
  }

  function updatePayment(index, field, value) {
    setDraft((current) => ({
      ...current,
      payments: current.payments.map((payment, paymentIndex) => (
        paymentIndex === index ? { ...payment, [field]: value } : payment
      )),
    }));
  }

  function updatePrimaryPayment(field, value) {
    setDraft((current) => {
      const payments = current.payments.length ? current.payments : [emptyPayment()];
      return {
        ...current,
        payments: payments.map((payment, index) => (
          index === 0 ? { ...payment, [field]: value } : payment
        )),
      };
    });
  }

  function updateExpenseReason(value) {
    setDraft((current) => ({ ...current, purpose: value, notes: value }));
  }

  function removePayment(index) {
    if (draft.payments.length === 1) {
      setError("至少保留一笔付款");
      return;
    }
    setDraft((current) => ({
      ...current,
      payments: current.payments.filter((_, paymentIndex) => paymentIndex !== index),
    }));
  }

  async function submit(event) {
    event.preventDefault();
    try {
      const payments = draft.payments.map((payment, index) => {
        const amountCents = inputToCents(payment.amount, `第 ${index + 1} 笔实付金额`);
        const reimbursementCents = inputToCents(payment.reimbursement, `第 ${index + 1} 笔计入报销金额`);
        if (reimbursementCents > amountCents) throw new TypeError(`第 ${index + 1} 笔计入报销不能超过实付金额`);
        if (amountCents !== reimbursementCents && !payment.differenceReason.trim()) {
          throw new TypeError(`第 ${index + 1} 笔存在差额，请填写差额原因`);
        }
        if (payment.accountLast4 && !/^\d{1,4}$/.test(payment.accountLast4)) {
          throw new TypeError(`第 ${index + 1} 笔账号末四位只能填写数字`);
        }
        return {
          ...(payment.id ? { id: payment.id } : {}),
          paidAt: new Date(payment.paidAt).toISOString(),
          merchant: payment.merchant.trim(),
          amountCents,
          reimbursementCents,
          fundingSource: payment.fundingSource,
          paymentMethod: payment.paymentMethod,
          accountLast4: payment.accountLast4,
          differenceReason: payment.differenceReason.trim(),
        };
      });
      const savedExpense = await onSave({
        ...(draft.id ? { id: draft.id, version: draft.version } : {}),
        occurredOn: draft.occurredOn,
        category: draft.category,
        purpose: draft.purpose.trim(),
        merchant: draft.merchant.trim(),
        itineraryId: draft.itineraryId || null,
        customerId: draft.customerId || null,
        invoiceType: draft.invoiceType === "unprovided" ? null : draft.invoiceType || null,
        tripRegion: draft.tripRegion || null,
        tripRegionSource: draft.tripRegionSource || null,
        notes: draft.notes.trim(),
        payments,
      });
      const nextExpense = savedExpense ?? expense;
      if (nextExpense) {
        setDraft(createDraft(nextExpense, week.start, null, regionProfile, invoiceContextRef.current));
        setIsEditing(false);
      }
      setError("");
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存失败，请稍后重试"));
    }
  }

  function cancelEdit() {
    if (!expense) {
      onClose();
      return;
    }
    setDraft(createDraft(expense, week.start, null, regionProfile, invoiceContextRef.current));
    setError("");
    setIsEditing(false);
  }

  return (
    <div className="expense-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section className="expense-drawer" data-mode={expense && !isEditing ? "detail" : "edit"} role="dialog" aria-modal="true" aria-labelledby="expense-editor-title">
        <header className="expense-drawer-head">
          <div className="expense-drawer-title">
            <span className="expense-drawer-mark"><ReceiptText size={18} aria-hidden="true" /></span>
            <div className="expense-drawer-copy">
              <h2 id="expense-editor-title">{expense ? (isEditing ? "编辑记账" : "记账详情") : "记一笔差旅费用"}</h2>
              {expense ? (
                <div className="expense-drawer-meta">
                  <code>{expense.referenceCode || "待生成编号"}</code>
                  {isEditing
                    ? <span className="expense-editing-state">编辑中</span>
                    : <span><CalendarDays size={13} aria-hidden="true" />{expenseDateLabel(expense.occurredOn)}</span>}
                </div>
              ) : null}
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭记账卡片" onClick={onClose} disabled={pending}>
            <X size={20} />
          </button>
        </header>

        {expense && !isEditing ? (
          <ExpenseDetailView
            expense={expense}
            matches={matches}
            noInvoiceConfirmations={noInvoiceConfirmations}
            getAttachmentUrl={getAttachmentUrl}
            getAttachmentContentResponse={getAttachmentContentResponse}
            onReplace={onReplace}
            onDelete={onDelete}
            onVersionChange={(version) => setDraft((current) => ({ ...current, version }))}
            pendingAttachmentId={pendingAttachmentId}
            onClose={onClose}
            onEdit={() => { setError(""); setIsEditing(true); }}
          />
        ) : (
          <form className="expense-editor-form" data-testid="expense-edit-form" onSubmit={submit}>
            {error ? <p className="expense-form-error" role="alert"><CircleAlert size={16} />{error}</p> : null}

            <div className="expense-editor-layout">
              <div className="expense-editor-main">
                <section className="expense-detail-section expense-edit-core" aria-labelledby="expense-edit-core-title">
                  <header>
                    <div><FileText size={16} aria-hidden="true" /><h3 id="expense-edit-core-title">费用信息</h3></div>
                    <span>可修改字段</span>
                  </header>
                  <div className="expense-edit-grid">
                    <label className="expense-edit-field"><span>支付时间</span><input type="datetime-local" value={draft.payments[0]?.paidAt ?? ""} onChange={(event) => updatePrimaryPayment("paidAt", event.target.value)} required /></label>
                    <label className="expense-edit-field"><span>出差区域</span><input value={draft.tripRegion} onChange={(event) => updateField("tripRegion", event.target.value)} placeholder="如：济宁" /></label>
                    <label className="expense-edit-field"><span>付款金额</span><input inputMode="decimal" value={draft.payments[0]?.amount ?? ""} onChange={(event) => updatePrimaryPayment("amount", event.target.value)} placeholder="0.00" required /></label>
                    <label className="expense-edit-field"><span>费用事由</span><input value={draft.notes.trim() || draft.purpose} onChange={(event) => updateExpenseReason(event.target.value)} placeholder="如：9.15 济宁出差午餐" required /></label>
                  </div>
                </section>
              </div>

              <aside className="expense-editor-aside" aria-label="付款凭证和发票状态">
                <ExpenseEvidencePanel
                  expense={expense}
                  invoiceType={draft.invoiceType}
                  getAttachmentUrl={getAttachmentUrl}
                  getAttachmentContentResponse={getAttachmentContentResponse}
                  onInvoiceTypeChange={(value) => updateField("invoiceType", value)}
                  onReplace={onReplace}
                  onDelete={onDelete}
                  onVersionChange={(version) => setDraft((current) => ({ ...current, version }))}
                  pendingAttachmentId={pendingAttachmentId}
                />
              </aside>

              <details className="expense-advanced-details">
                <summary><strong>其他费用字段</strong><span>发生日期、类别、关联信息及付款明细</span></summary>
                <div className="expense-advanced-content">
                  <fieldset className="expense-fieldset">
                    <legend>费用信息</legend>
                    <div className="expense-form-grid">
                      <label className="form-field"><span>发生日期</span><input type="date" min={week.start} max={week.end} value={draft.occurredOn} onChange={(event) => updateField("occurredOn", event.target.value)} required /></label>
                      <label className="form-field"><span>类别</span><select value={draft.category} onChange={(event) => updateField("category", event.target.value)}>{EXPENSE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                      <div className="expense-derived-status" role="note"><span>票据覆盖</span><div><strong className={`expense-status ${derivedInvoiceStatus.id}`}>{derivedInvoiceStatus.label}</strong><small>由发票匹配与无票确认记录更新</small></div></div>
                      <label className="form-field"><span>默认收款方</span><input value={draft.merchant} onChange={(event) => updateField("merchant", event.target.value)} placeholder="商户或收款方" /></label>
                      <label className="form-field"><span>关联行程</span><select value={draft.itineraryId} onChange={(event) => updateField("itineraryId", event.target.value)}><option value="">不关联</option>{itineraries.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                      <label className="form-field"><span>关联客户</span><select value={draft.customerId} onChange={(event) => updateField("customerId", event.target.value)}><option value="">不关联</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                      <label className="form-field expense-span-3"><span>备注</span><textarea value={draft.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="补充客户、业务或报销说明" /></label>
                    </div>
                  </fieldset>

                  <fieldset className="expense-fieldset expense-payment-fieldset">
                    <legend>实际付款</legend>
                    <div className="expense-payment-summary" aria-live="polite">
                      <span>实付合计 <strong>¥{totals.actual.toFixed(2)}</strong></span>
                      <span>计入报销 <strong>¥{totals.reimbursement.toFixed(2)}</strong></span>
                      <span>{draft.payments.length} 笔付款</span>
                    </div>
                    <div className="expense-payment-editors">
                      {draft.payments.map((payment, index) => (
                        <article className="expense-payment-editor" key={payment.id ?? index}>
                          <div className="expense-payment-editor-head"><strong>第 {index + 1} 笔付款</strong><span>出差区域：{draft.tripRegion || "未填写"}</span><b>¥{payment.amount || "0.00"}</b><button className="icon-button" type="button" aria-label={`删除第 ${index + 1} 笔付款`} onClick={() => removePayment(index)} disabled={draft.payments.length === 1}><Trash2 size={16} /></button></div>
                          <div className="expense-form-grid payment-grid">
                            {index > 0 ? <label className="form-field"><span>支付时间</span><input type="datetime-local" value={payment.paidAt} onChange={(event) => updatePayment(index, "paidAt", event.target.value)} required /></label> : null}
                            <label className="form-field"><span>收款方</span><input value={payment.merchant} onChange={(event) => updatePayment(index, "merchant", event.target.value)} placeholder={draft.merchant || "可与默认收款方不同"} /></label>
                            {index > 0 ? <label className="form-field"><span>实付金额（元）</span><input inputMode="decimal" value={payment.amount} onChange={(event) => updatePayment(index, "amount", event.target.value)} placeholder="0.00" required /></label> : null}
                            <label className="form-field"><span>计入报销金额（元）</span><input inputMode="decimal" value={payment.reimbursement} onChange={(event) => updatePayment(index, "reimbursement", event.target.value)} placeholder="0.00" required /></label>
                            <label className="form-field"><span>资金来源</span><select value={payment.fundingSource} onChange={(event) => updatePayment(index, "fundingSource", event.target.value)}>{FUNDING_SOURCES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                            <label className="form-field"><span>支付方式</span><select value={payment.paymentMethod} onChange={(event) => updatePayment(index, "paymentMethod", event.target.value)}>{PAYMENT_METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                            <label className="form-field"><span>账号末四位</span><input inputMode="numeric" maxLength={4} value={payment.accountLast4} onChange={(event) => updatePayment(index, "accountLast4", event.target.value.replace(/\D/g, ""))} placeholder="选填" /></label>
                            <label className="form-field expense-span-2"><span>差额原因</span><input value={payment.differenceReason} onChange={(event) => updatePayment(index, "differenceReason", event.target.value)} placeholder="实付与计入报销不一致时必填" /></label>
                          </div>
                        </article>
                      ))}
                    </div>
                    <button className="ghost-button expense-add-payment" type="button" onClick={() => setDraft((current) => ({ ...current, payments: [...current.payments, emptyPayment()] }))}><Plus size={16} />添加一笔付款</button>
                  </fieldset>
                </div>
              </details>
            </div>

            <footer className="expense-drawer-actions">
              <p>{expense ? "取消可放弃本次修改，不影响已保存记录" : "资金来源：个人垫付、公司直付、请款资金"}</p>
              <div><button className="ghost-button" type="button" onClick={cancelEdit} disabled={pending}>取消</button><button className="primary-button" data-expense-save type="submit" disabled={pending}><Check size={14} />{pending ? "保存中" : "保存"}</button></div>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
