import {
  CircleAlert,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  EXPENSE_CATEGORIES,
  FUNDING_SOURCES,
  INVOICE_STATUSES,
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

function createDraft(expense, weekStart) {
  if (!expense) {
    return {
      occurredOn: weekStart,
      category: "breakfast",
      purpose: "",
      merchant: "",
      itineraryId: "",
      customerId: "",
      notes: "",
      payments: [emptyPayment()],
    };
  }
  return {
    id: expense.id,
    version: expense.version,
    occurredOn: expense.occurredOn,
    category: expense.category,
    purpose: expense.purpose ?? "",
    merchant: expense.merchant ?? "",
    itineraryId: expense.itineraryId ?? "",
    customerId: expense.customerId ?? "",
    notes: expense.notes ?? "",
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
  pending = false,
  onClose,
  onSave,
}) {
  const [draft, setDraft] = useState(() => createDraft(expense, week.start));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(createDraft(expense, week.start));
    setError("");
  }, [expense, open, week.start]);

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

  if (!open) return null;

  function updateField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updatePayment(index, field, value) {
    setDraft((current) => ({
      ...current,
      payments: current.payments.map((payment, paymentIndex) => (
        paymentIndex === index ? { ...payment, [field]: value } : payment
      )),
    }));
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
      await onSave({
        ...(draft.id ? { id: draft.id, version: draft.version } : {}),
        occurredOn: draft.occurredOn,
        category: draft.category,
        purpose: draft.purpose.trim(),
        merchant: draft.merchant.trim(),
        itineraryId: draft.itineraryId || null,
        customerId: draft.customerId || null,
        notes: draft.notes.trim(),
        payments,
      });
      setError("");
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存失败，请稍后重试"));
    }
  }

  return (
    <div className="expense-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section className="expense-drawer" role="dialog" aria-modal="true" aria-labelledby="expense-editor-title">
        <header className="expense-drawer-head">
          <div>
            <span className="expense-kicker">人工录入</span>
            <h2 id="expense-editor-title">{expense ? "编辑费用" : "记一笔差旅费用"}</h2>
            <p>首版只保存您确认过的实际付款，不自动判断报销标准。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭费用录入" onClick={onClose} disabled={pending}>
            <X size={20} />
          </button>
        </header>

        <form className="expense-editor-form" onSubmit={submit}>
          {error ? <p className="expense-form-error" role="alert"><CircleAlert size={16} />{error}</p> : null}

          <fieldset className="expense-fieldset">
            <legend>费用信息</legend>
            <div className="expense-form-grid">
              <label className="form-field"><span>发生日期</span><input type="date" min={week.start} max={week.end} value={draft.occurredOn} onChange={(event) => updateField("occurredOn", event.target.value)} required /></label>
              <label className="form-field"><span>分类</span><select value={draft.category} onChange={(event) => updateField("category", event.target.value)}>{EXPENSE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <div className="expense-derived-status" role="note">
                <span>票据状态</span>
                <div><strong className={`expense-status ${derivedInvoiceStatus.id}`}>{derivedInvoiceStatus.label}</strong><small>由发票匹配、无票确认和候选处理自动更新</small></div>
              </div>
              <label className="form-field expense-span-2"><span>费用事由</span><input value={draft.purpose} onChange={(event) => updateField("purpose", event.target.value)} placeholder="如：济宁酒店住宿、客户晚餐招待" required /></label>
              <label className="form-field"><span>默认收款方</span><input value={draft.merchant} onChange={(event) => updateField("merchant", event.target.value)} placeholder="商户或收款方" /></label>
              <label className="form-field"><span>关联行程</span><select value={draft.itineraryId} onChange={(event) => updateField("itineraryId", event.target.value)}><option value="">不关联</option>{itineraries.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
              <label className="form-field"><span>关联客户</span><select value={draft.customerId} onChange={(event) => updateField("customerId", event.target.value)}><option value="">不关联</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="form-field expense-span-2"><span>备注</span><textarea value={draft.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="补充客户、业务或报销说明" /></label>
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
                  <div className="expense-payment-editor-head"><strong>第 {index + 1} 笔付款</strong><button className="icon-button" type="button" aria-label={`删除第 ${index + 1} 笔付款`} onClick={() => removePayment(index)}><Trash2 size={16} /></button></div>
                  <div className="expense-form-grid payment-grid">
                    <label className="form-field"><span>支付时间</span><input type="datetime-local" value={payment.paidAt} onChange={(event) => updatePayment(index, "paidAt", event.target.value)} required /></label>
                    <label className="form-field"><span>收款方</span><input value={payment.merchant} onChange={(event) => updatePayment(index, "merchant", event.target.value)} placeholder={draft.merchant || "可与默认收款方不同"} /></label>
                    <label className="form-field"><span>实付金额（元）</span><input inputMode="decimal" value={payment.amount} onChange={(event) => updatePayment(index, "amount", event.target.value)} placeholder="0.00" required /></label>
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

          <footer className="expense-drawer-actions">
            <p>资金来源可选：个人垫付、公司直付、请款资金。额度、超标和发票规则待配置。</p>
            <div><button className="ghost-button" type="button" onClick={onClose} disabled={pending}>取消</button><button className="primary-button" type="submit" disabled={pending}><Save size={16} />{pending ? "保存中" : "保存费用"}</button></div>
          </footer>
        </form>
      </section>
    </div>
  );
}
