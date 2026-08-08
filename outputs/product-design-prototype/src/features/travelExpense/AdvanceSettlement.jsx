import {
  ArrowDownRight,
  ArrowUpRight,
  Landmark,
  Plus,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useState } from "react";

import { formatCny, formatSignedCny } from "./travelExpenseModel.js";

function amountToCents(value, label) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new TypeError(`${label}请输入有效金额`);
  return Math.round(Number(value) * 100);
}

const STATUS_LABELS = {
  draft: "草稿",
  requested: "已申请",
  received: "已收到",
  closed: "已结清",
};

export function AdvanceSettlement({
  week,
  summary,
  advances,
  onSave,
  onDelete,
  pending,
}) {
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    status: "requested",
    requested: "",
    received: "",
    requestedOn: "",
    receivedOn: "",
    purpose: "本周差旅备用金",
    notes: "",
  });

  const settlementTitle = summary.personalSettlementCents > 0
    ? "公司应补"
    : summary.personalSettlementCents < 0
      ? "个人应退"
      : "已结平";

  async function submit(event) {
    event.preventDefault();
    try {
      await onSave({
        weekStart: week.start,
        status: draft.status,
        requestedCents: amountToCents(draft.requested || "0", "申请金额"),
        receivedCents: amountToCents(draft.received || "0", "到账金额"),
        requestedOn: draft.requestedOn || null,
        receivedOn: draft.receivedOn || null,
        purpose: draft.purpose.trim(),
        notes: draft.notes.trim(),
      });
      setDraft({ status: "requested", requested: "", received: "", requestedOn: "", receivedOn: "", purpose: "本周差旅备用金", notes: "" });
      setError("");
      setShowForm(false);
    } catch (saveError) {
      setError(String(saveError?.message ?? "保存请款失败"));
    }
  }

  return (
    <div className="expense-settlement-view">
      <section className="expense-settlement-formula">
        <div className="expense-formula-item"><span>计入个人结算的费用</span><strong>{formatCny(summary.settlementEligibleCents)}</strong><small>个人垫付 + 请款资金中计入报销</small></div>
        <span className="expense-formula-symbol">−</span>
        <div className="expense-formula-item"><span>已收到提前请款</span><strong>{formatCny(summary.advanceReceivedCents)}</strong><small>{advances.length ? `${advances.length} 笔请款记录` : "尚未录入请款"}</small></div>
        <span className="expense-formula-symbol">=</span>
        <div className={`expense-formula-result ${summary.personalSettlementCents < 0 ? "return" : "reimburse"}`}><span>{settlementTitle}</span><strong>{formatSignedCny(summary.personalSettlementCents)}</strong><small>{summary.personalSettlementCents === 0 ? "无需多退少补" : "按实际花费多退少补"}</small></div>
      </section>

      <section className="expense-company-direct-note"><Landmark size={20} /><div><strong>公司直付不计入个人结算</strong><p>本周公司直付实付 {formatCny(summary.companyDirectPaidCents)}，其中计入报销 {formatCny(summary.companyDirectReimbursementCents)}，仅用于公司总账核对。</p></div></section>

      <section className="expense-advance-panel">
        <header className="expense-section-intro"><div><strong>提前请款记录</strong><p>记录已申请和实际到账金额；没有到账时请保留 0 元。</p></div><button className="primary-button" type="button" onClick={() => setShowForm((value) => !value)}><Plus size={16} />录入请款</button></header>
        {showForm ? (
          <form className="expense-advance-form" onSubmit={submit}>
            {error ? <p className="expense-form-error" role="alert">{error}</p> : null}
            <label className="form-field"><span>状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="draft">草稿</option><option value="requested">已申请</option><option value="received">已收到</option><option value="closed">已结清</option></select></label>
            <label className="form-field"><span>申请金额（元）</span><input inputMode="decimal" value={draft.requested} onChange={(event) => setDraft((current) => ({ ...current, requested: event.target.value }))} placeholder="0.00" /></label>
            <label className="form-field"><span>实际到账（元）</span><input inputMode="decimal" value={draft.received} onChange={(event) => setDraft((current) => ({ ...current, received: event.target.value }))} placeholder="0.00" /></label>
            <label className="form-field"><span>申请日期</span><input type="date" value={draft.requestedOn} onChange={(event) => setDraft((current) => ({ ...current, requestedOn: event.target.value }))} /></label>
            <label className="form-field"><span>到账日期</span><input type="date" value={draft.receivedOn} onChange={(event) => setDraft((current) => ({ ...current, receivedOn: event.target.value }))} /></label>
            <label className="form-field expense-span-2"><span>用途</span><input value={draft.purpose} onChange={(event) => setDraft((current) => ({ ...current, purpose: event.target.value }))} required /></label>
            <label className="form-field expense-span-2"><span>备注</span><input value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
            <div className="expense-advance-form-actions"><button className="ghost-button" type="button" onClick={() => setShowForm(false)}>取消</button><button className="primary-button" type="submit" disabled={pending}>保存请款</button></div>
          </form>
        ) : null}

        <div className="expense-advance-list">
          {advances.map((advance) => (
            <article key={advance.id}>
              <span className={`expense-advance-icon ${advance.status}`}><WalletCards size={18} /></span>
              <div><strong>{advance.purpose}</strong><small>{STATUS_LABELS[advance.status]} · {advance.requestedOn || "未填申请日期"}{advance.receivedOn ? ` · ${advance.receivedOn} 到账` : ""}</small></div>
              <span className="expense-advance-amount"><small>申请 {formatCny(advance.requestedCents)}</small><strong>到账 {formatCny(advance.receivedCents)}</strong></span>
              <button className="icon-button danger" type="button" aria-label={`删除请款${advance.purpose}`} onClick={() => onDelete(advance)}><Trash2 size={16} /></button>
            </article>
          ))}
          {advances.length === 0 ? <div className="expense-empty-state"><WalletCards size={24} /><strong>本周尚未录入请款</strong><p>实际到账前可先记录申请金额，到账金额保留 0 元。</p></div> : null}
        </div>
      </section>

      <section className="expense-settlement-direction">
        <article><ArrowUpRight size={19} /><div><strong>公司应补</strong><p>结算结果为正数时，公司补回个人承担的合规费用。</p></div></article>
        <article><ArrowDownRight size={19} /><div><strong>个人应退</strong><p>结算结果为负数时，提前请款超过计入个人结算的费用。</p></div></article>
      </section>
    </div>
  );
}
