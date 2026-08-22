import {
  ArrowLeft,
  Check,
  Printer,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  buildExpenseListRows,
  paginateExpenseList,
} from "./travelExpenseExport.js";
import { formatCny } from "./travelExpenseModel.js";

function ExpenseListPage({ page, week, owner, generatedOn }) {
  return (
    <article className="expense-list-print-sheet">
      <header className="expense-list-print-title">
        <h2>费用清单</h2>
        <dl>
          <div><dt>报销人</dt><dd>{owner || "—"}</dd></div>
          <div><dt>自然周</dt><dd>{week.start}—{week.end}</dd></div>
          <div><dt>生成日期</dt><dd>{generatedOn}</dd></div>
        </dl>
      </header>
      <table className="expense-list-print-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>日期</th>
            <th>费用类别</th>
            <th>金额</th>
            <th>付款凭证</th>
            <th>发票状态</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr key={row.expenseId}>
              <td>{row.sequence}</td>
              <td>{row.dateLabel}</td>
              <td>{row.categoryLabel}</td>
              <td>{row.amountLabel}</td>
              <td>{row.paymentProofLabel}</td>
              <td>{row.invoiceStatusLabel}</td>
              <td>{row.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="expense-list-print-total"><strong>本页合计</strong><span>{formatCny(page.totalCents)}</span></div>
      <footer className="expense-print-footer">
        <span>数据按已确认费用重新计算 · 不复制历史表公式口径</span>
        <span>第 {page.pageNumber}/{page.totalPages} 页</span>
      </footer>
    </article>
  );
}

export function ExpenseListPrintPreview({
  expenses,
  week,
  owner,
  matches,
  noInvoiceConfirmations,
  onClose,
}) {
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const rows = useMemo(() => buildExpenseListRows(expenses, { matches, noInvoiceConfirmations }), [expenses, matches, noInvoiceConfirmations]);
  const pages = useMemo(() => paginateExpenseList({ rows, rowsPerPage: 18 }), [rows]);
  const generatedOn = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function printDocument() {
    setPrinting(true);
    setPrintError("");
    try {
      if (pages.length === 0) throw new Error("暂无已确认费用，暂不能打印费用清单。");
      window.print();
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "费用清单打印失败，请稍后重试。");
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className="expense-list-print-preview" data-testid="expense-list-print-preview">
      <header className="expense-print-preview-toolbar expense-list-print-toolbar no-print">
        <div><button className="ghost-button" type="button" onClick={onClose}><ArrowLeft size={16} />返回报销整理</button><div><strong>费用清单</strong><span>报销整理 / A4 纵向预览</span></div></div>
        <button className="primary-button" type="button" onClick={printDocument} disabled={printing || pages.length === 0}><Printer size={16} />{printing ? "准备打印" : "打印费用清单"}</button>
      </header>
      {printError ? <div className="expense-page-alert no-print" role="alert"><span>{printError}</span><button className="ghost-button" type="button" onClick={printDocument} disabled={printing}>重新打印</button></div> : null}
      <div className="expense-print-layout expense-list-print-layout">
        <aside className="expense-print-settings no-print">
          <section><strong>记录范围</strong><span>{week.start}—{week.end}</span></section>
          <section><strong>固定列</strong><ul><li><Check size={14} />日期、费用类别、金额</li><li><Check size={14} />付款凭证、发票状态</li><li><Check size={14} />备注</li></ul></section>
          <section><strong>打印规则</strong><ul><li><Check size={14} />A4 纵向</li><li><Check size={14} />费用行不跨页</li><li><Check size={14} />合计按全部确认费用重算</li></ul></section>
          <section><strong>数据汇总</strong><dl><div><dt>费用</dt><dd>{rows.length} 条</dd></div><div><dt>预计页数</dt><dd>{pages.length} 页</dd></div></dl></section>
        </aside>
        <div className="expense-list-print-document">
          {pages.map((page) => <ExpenseListPage key={page.pageNumber} page={page} week={week} owner={owner} generatedOn={generatedOn} />)}
          {pages.length === 0 ? <div className="expense-empty-state"><strong>本周暂无已确认费用</strong><p>返回费用账本录入费用后再打印。</p></div> : null}
        </div>
      </div>
    </section>
  );
}
