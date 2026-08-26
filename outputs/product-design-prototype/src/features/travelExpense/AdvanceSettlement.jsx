import {
  ArrowDownRight,
  ArrowUpRight,
  Landmark,
  Plus,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useMemo, useState } from "react";

import { formatCny, formatSignedCny } from "./travelExpenseModel.js";

function amountToCents(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) {
    throw new TypeError("到账金额请输入有效金额");
  }
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new TypeError("到账金额必须大于 0 元");
  }
  return cents;
}

function emptyDraft() {
  return {
    received: "",
    receivedOn: "",
    purpose: "出差借款到账",
    notes: "",
  };
}

export function filterReceivedAdvances(advances = []) {
  if (!Array.isArray(advances)) throw new TypeError("advances must be an array");
  return advances.filter((advance) => (
    advance?.status === "received"
      && Number.isSafeInteger(advance?.receivedCents)
      && advance.receivedCents > 0
      && typeof advance.receivedOn === "string"
  ));
}

export function buildReceivedAdvancePayload({ week, draft } = {}) {
  if (!draft?.receivedOn) throw new TypeError("请选择实际到账日期");
  if (draft.receivedOn < week?.start || draft.receivedOn > week?.end) {
    throw new TypeError(`到账日期必须在当前自然周 ${week?.start}—${week?.end}`);
  }
  return {
    weekStart: week.start,
    status: "received",
    requestedCents: 0,
    receivedCents: amountToCents(draft.received),
    requestedOn: null,
    receivedOn: draft.receivedOn,
    purpose: String(draft.purpose ?? "").trim() || "出差借款到账",
    notes: String(draft.notes ?? "").trim(),
  };
}

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
  const [draft, setDraft] = useState(emptyDraft);
  const receivedAdvances = useMemo(() => filterReceivedAdvances(advances), [advances]);

  const settlementTitle = summary.personalSettlementCents > 0
    ? "公司应补"
    : summary.personalSettlementCents < 0
      ? "个人应退"
      : "已结平";

  async function submit(event) {
    event.preventDefault();
    try {
      await onSave(buildReceivedAdvancePayload({ week, draft }));
      setDraft(emptyDraft());
      setError("");
      setShowForm(false);
    } catch (saveError) {
      setError(String(saveError?.message ?? "借款到账保存失败"));
    }
  }

  return (
    <div className="expense-settlement-view">
      <section className="expense-settlement-formula">
        <div className="expense-formula-item"><span>计入个人结算的费用</span><strong>{formatCny(summary.settlementEligibleCents)}</strong><small>个人垫付 + 借款资金中计入报销</small></div>
        <span className="expense-formula-symbol">−</span>
        <div className="expense-formula-item"><span>本周借款到账</span><strong>{formatCny(summary.advanceReceivedCents)}</strong><small>{receivedAdvances.length ? `${receivedAdvances.length} 笔到账收入` : "本周尚无借款到账"}</small></div>
        <span className="expense-formula-symbol">=</span>
        <div className={`expense-formula-result ${summary.personalSettlementCents < 0 ? "return" : "reimburse"}`}><span>{settlementTitle}</span><strong>{formatSignedCny(summary.personalSettlementCents)}</strong><small>{summary.personalSettlementCents === 0 ? "无需多退少补" : "按实际花费多退少补"}</small></div>
      </section>

      <section className="expense-company-direct-note"><Landmark size={20} /><div><strong>公司直付不计入个人结算</strong><p>本周公司直付实付 {formatCny(summary.companyDirectPaidCents)}，其中计入报销 {formatCny(summary.companyDirectReimbursementCents)}，仅用于公司总账核对。</p></div></section>

      <section className="expense-advance-panel">
        <header className="expense-section-intro"><div><strong>借款到账记录</strong><p>仅记录已经实际到账的出差借款；到账即作为收入进入本周账本。</p></div><button className="primary-button" type="button" onClick={() => setShowForm((value) => !value)}><Plus size={16} />录入借款到账</button></header>
        {showForm ? (
          <form className="expense-advance-form" onSubmit={submit}>
            {error ? <p className="expense-form-error" role="alert">{error}</p> : null}
            <label className="form-field"><span>实际到账（元）</span><input inputMode="decimal" value={draft.received} onChange={(event) => setDraft((current) => ({ ...current, received: event.target.value }))} placeholder="0.00" required /></label>
            <label className="form-field"><span>到账日期</span><input type="date" min={week.start} max={week.end} value={draft.receivedOn} onChange={(event) => setDraft((current) => ({ ...current, receivedOn: event.target.value }))} required /></label>
            <label className="form-field expense-span-2"><span>用途</span><input value={draft.purpose} onChange={(event) => setDraft((current) => ({ ...current, purpose: event.target.value }))} required /></label>
            <label className="form-field expense-span-2"><span>备注</span><input value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
            <div className="expense-advance-form-actions"><button className="ghost-button" type="button" onClick={() => { setShowForm(false); setError(""); }}>取消</button><button className="primary-button" type="submit" disabled={pending}>{pending ? "保存中" : "保存到账收入"}</button></div>
          </form>
        ) : null}

        <div className="expense-advance-list">
          {receivedAdvances.map((advance) => (
            <article key={advance.id}>
              <span className="expense-advance-icon received"><WalletCards size={18} /></span>
              <div><strong>{advance.purpose}</strong><small>收入 · {advance.receivedOn} 到账{advance.notes ? ` · ${advance.notes}` : ""}</small></div>
              <span className="expense-advance-amount"><small>借款到账</small><strong>{formatCny(advance.receivedCents)}</strong></span>
              <button className="icon-button danger" type="button" aria-label={`删除借款到账${advance.purpose}`} onClick={() => onDelete(advance)}><Trash2 size={16} /></button>
            </article>
          ))}
          {receivedAdvances.length === 0 ? <div className="expense-empty-state"><WalletCards size={24} /><strong>本周尚无借款到账</strong><p>借款实际到账后再录入；系统不记录申请、草稿或未到账金额。</p></div> : null}
        </div>
      </section>

      <section className="expense-settlement-direction">
        <article><ArrowUpRight size={19} /><div><strong>公司应补</strong><p>结算结果为正数时，公司补回个人承担的可报销费用。</p></div></article>
        <article><ArrowDownRight size={19} /><div><strong>个人应退</strong><p>结算结果为负数时，本周借款到账超过计入个人结算的费用。</p></div></article>
      </section>
    </div>
  );
}
