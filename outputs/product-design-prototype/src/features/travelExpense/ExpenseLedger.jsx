import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  EXPENSE_CATEGORIES,
  FUNDING_SOURCES,
  INVOICE_STATUSES,
  flattenPaymentRows,
  formatCny,
} from "./travelExpenseModel.js";

const categoryLabel = Object.fromEntries(EXPENSE_CATEGORIES.map((item) => [item.id, item.label]));
const invoiceLabel = Object.fromEntries(INVOICE_STATUSES.map((item) => [item.id, item.label]));

export function ExpenseLedger({
  expenses,
  initialCategory = "",
  onEdit,
  onDelete,
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [funding, setFunding] = useState("");
  const [invoice, setInvoice] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState({ referenceCode: "", message: "", error: false });

  async function copyReferenceCode(referenceCode) {
    try {
      await navigator.clipboard.writeText(referenceCode);
      setCopyFeedback({ referenceCode, message: "账单编号已复制", error: false });
    } catch {
      setCopyFeedback({ referenceCode, message: "复制失败，请手动选择账单编号", error: true });
    }
  }

  const filtered = useMemo(() => expenses.filter((expense) => {
    const rows = flattenPaymentRows([expense]);
    const normalized = query.trim().toLowerCase();
    const matchesText = !normalized || [expense.referenceCode, expense.purpose, expense.merchant, expense.notes]
      .some((value) => String(value ?? "").toLowerCase().includes(normalized));
    const matchesCategory = !category || expense.category === category;
    const matchesFunding = !funding || rows.some((row) => row.fundingSource === funding);
    const matchesInvoice = !invoice || expense.invoiceStatus === invoice;
    const needsReview = expense.invoiceStatus !== "covered" || rows.some((row) => row.differenceCents > 0);
    return matchesText && matchesCategory && matchesFunding && matchesInvoice && (!pendingOnly || needsReview);
  }), [category, expenses, funding, invoice, pendingOnly, query]);

  return (
    <section className="expense-ledger-panel">
      <div className="expense-toolbar">
        <label className="expense-search"><Search size={16} /><span className="sr-only">搜索费用</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索费用事由或收款方、账单编号" /></label>
        <label><span>分类</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部</option>{EXPENSE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>资金来源</span><select value={funding} onChange={(event) => setFunding(event.target.value)}><option value="">全部</option>{FUNDING_SOURCES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>票据状态</span><select value={invoice} onChange={(event) => setInvoice(event.target.value)}><option value="">全部</option>{INVOICE_STATUSES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="expense-checkbox"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />仅看待核对</label>
      </div>

      <div className="expense-table-scroll">
        <table className="expense-data-table expense-ledger-table">
          <thead><tr><th>发生日期</th><th>分类</th><th>事由 / 收款方</th><th>付款</th><th>实付金额</th><th>计入报销</th><th>票据状态</th><th>操作</th></tr></thead>
          <tbody>
            {filtered.map((expense) => {
              const rows = flattenPaymentRows([expense]);
              const hasDifference = rows.some((row) => row.differenceCents > 0);
              return (
                <tr key={expense.id}>
                  <td>{expense.occurredOn}</td>
                  <td><span className={`expense-category-pill ${expense.category}`}>{categoryLabel[expense.category]}</span></td>
                  <td>
                    <strong>{expense.purpose}</strong>
                    <div className="expense-reference-row">
                      <code>{expense.referenceCode}</code>
                      <button type="button" aria-label={`复制账单编号 ${expense.referenceCode}`} onClick={() => copyReferenceCode(expense.referenceCode)}><Copy size={13} aria-hidden="true" />复制</button>
                    </div>
                    <small>{expense.merchant || rows.map((row) => row.merchant).filter(Boolean).join("、") || "未填写收款方"}</small>
                    {copyFeedback.referenceCode === expense.referenceCode ? <span className={`expense-copy-feedback${copyFeedback.error ? " is-error" : ""}`} role={copyFeedback.error ? "alert" : "status"}>{copyFeedback.message}</span> : null}
                  </td>
                  <td>{rows.length} 笔<small>{expense.attachments.length} 张附件</small></td>
                  <td className="expense-money">{formatCny(expense.actualPaidCents)}</td>
                  <td className="expense-money">{formatCny(expense.reimbursementCents)}</td>
                  <td><span className={`expense-status ${expense.invoiceStatus}`}>{expense.invoiceStatus === "covered" ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{invoiceLabel[expense.invoiceStatus]}</span>{hasDifference ? <small className="expense-warning-copy">含付款差额</small> : null}</td>
                  <td><div className="expense-row-actions"><button className="icon-button" type="button" aria-label={`编辑${expense.purpose}`} onClick={() => onEdit(expense)}><Pencil size={16} /></button><button className="icon-button danger" type="button" aria-label={`删除${expense.purpose}`} onClick={() => onDelete(expense)}><Trash2 size={16} /></button></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 ? <div className="expense-empty-state"><Search size={22} /><strong>没有符合条件的费用</strong><p>调整搜索或筛选条件后再试。</p></div> : null}
      </div>
    </section>
  );
}
