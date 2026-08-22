import {
  CheckCircle2,
  CircleAlert,
  Copy,
  FileText,
  ImageOff,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildExpenseLedgerRows,
  EXPENSE_CATEGORIES,
  EXPENSE_INVOICE_STATES,
  formatCny,
} from "./travelExpenseModel.js";
import { isTravelExpensePdf } from "./travelExpenseDocument.js";

const categoryLabel = Object.fromEntries(EXPENSE_CATEGORIES.map((item) => [item.id, item.label]));

function LedgerProofs({ attachments, getAttachmentUrl }) {
  if (attachments.length === 0) {
    return <span className="expense-ledger-proof-empty"><ImageOff size={14} />待补凭证</span>;
  }
  return (
    <div className="expense-ledger-proofs">
      {attachments.slice(0, 2).map((attachment) => isTravelExpensePdf(attachment) ? (
        <a key={attachment.id} href={getAttachmentUrl?.(attachment.id) ?? "#"} target="_blank" rel="noreferrer" aria-label={`打开付款凭证 ${attachment.fileName ?? "PDF"}`}><FileText size={14} /><span>PDF</span></a>
      ) : (
        <img key={attachment.id} src={getAttachmentUrl?.(attachment.id)} alt={attachment.fileName ?? "付款凭证"} />
      ))}
      <span>{attachments.length} 份</span>
    </div>
  );
}

export function ExpenseLedger({
  expenses,
  matches = [],
  noInvoiceConfirmations = [],
  initialCategory = "",
  getAttachmentUrl,
  onEdit,
  onDelete,
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory);
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

  const rows = useMemo(() => buildExpenseLedgerRows(expenses, {
    matches,
    noInvoiceConfirmations,
  }), [expenses, matches, noInvoiceConfirmations]);

  const filtered = useMemo(() => rows.filter((row) => {
    const normalized = query.trim().toLowerCase();
    const matchesText = !normalized || row.searchText.includes(normalized);
    const matchesCategory = !category || row.categoryId === category;
    const matchesInvoice = !invoice || row.visible.invoiceStates.some((state) => state.id === invoice);
    return matchesText && matchesCategory && matchesInvoice && (!pendingOnly || row.needsReview);
  }), [category, invoice, pendingOnly, query, rows]);

  return (
    <section className="expense-ledger-panel">
      <div className="expense-toolbar">
        <label className="expense-search"><Search size={16} /><span className="sr-only">搜索费用</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索备注、日期或账单编号" /></label>
        <label><span>分类</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部</option>{EXPENSE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>发票状态</span><select value={invoice} onChange={(event) => setInvoice(event.target.value)}><option value="">全部</option>{EXPENSE_INVOICE_STATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="expense-checkbox"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />仅看待核对</label>
      </div>

      <div className="expense-table-scroll">
        <table className="expense-data-table expense-ledger-table">
          <thead><tr><th>日期</th><th>费用类别</th><th>金额</th><th>付款凭证</th><th>发票状态</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>
            {filtered.map((row) => {
              const expense = row.source;
              return (
                <tr key={row.id}>
                  <td>{row.visible.date}</td>
                  <td><span className={`expense-category-pill ${row.categoryId}`}>{categoryLabel[row.categoryId]}</span></td>
                  <td className="expense-money">{formatCny(row.visible.amountCents)}</td>
                  <td><LedgerProofs attachments={row.visible.paymentProofs} getAttachmentUrl={getAttachmentUrl} /></td>
                  <td><div className="expense-ledger-invoice-states">{row.visible.invoiceStates.map((state) => <span key={state.id} className={`expense-invoice-state ${state.id}`}>{state.id === "invoice_pending" ? <CircleAlert size={13} /> : <CheckCircle2 size={13} />}{state.label}</span>)}</div></td>
                  <td className="expense-ledger-notes">
                    <strong>{row.visible.notes}</strong>
                    <div className="expense-reference-row">
                      <code>{row.referenceCode}</code>
                      <button type="button" aria-label={`复制账单编号 ${row.referenceCode}`} onClick={() => copyReferenceCode(row.referenceCode)}><Copy size={13} aria-hidden="true" />复制</button>
                    </div>
                    {copyFeedback.referenceCode === row.referenceCode ? <span className={`expense-copy-feedback${copyFeedback.error ? " is-error" : ""}`} role={copyFeedback.error ? "alert" : "status"}>{copyFeedback.message}</span> : null}
                  </td>
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
