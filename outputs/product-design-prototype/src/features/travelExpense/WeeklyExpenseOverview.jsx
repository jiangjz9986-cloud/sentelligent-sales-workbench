import {
  ArrowRight,
  BadgeCheck,
  BedDouble,
  BusFront,
  CircleDollarSign,
  CircleHelp,
  ReceiptText,
  Soup,
  UsersRound,
  WalletCards,
} from "lucide-react";

import {
  EXPENSE_CATEGORIES,
  formatCny,
  formatSignedCny,
} from "./travelExpenseModel.js";

const CATEGORY_ICONS = {
  breakfast: Soup,
  lunch: Soup,
  dinner: Soup,
  lodging: BedDouble,
  transport: BusFront,
  hospitality: UsersRound,
  other: ReceiptText,
};

export function WeeklyExpenseOverview({ summary, week, onNavigate }) {
  const settlementLabel = summary.settlementDirection === "company_reimburses"
    ? "公司应补"
    : summary.settlementDirection === "individual_returns"
      ? "个人应退"
      : "本周已结平";
  const receiptComplete = summary.invoiceStatusCounts.covered;
  const receiptPending = summary.expenseCount - receiptComplete;

  return (
    <div className="expense-overview-view">
      <section className="expense-summary-strip" aria-label="本周费用摘要">
        <article><span className="expense-summary-icon blue"><CircleDollarSign size={18} /></span><div><small>申报金额</small><strong>{formatCny(summary.reimbursementCents)}</strong><p>{summary.expenseCount} 条费用 · {summary.paymentCount} 笔付款</p></div></article>
        <article><span className="expense-summary-icon teal"><WalletCards size={18} /></span><div><small>实际支付</small><strong>{formatCny(summary.actualPaidCents)}</strong><p>公司直付实付 {formatCny(summary.companyDirectPaidCents)}</p></div></article>
        <article><span className="expense-summary-icon green"><BadgeCheck size={18} /></span><div><small>付款凭证</small><strong>{summary.paymentProofCount} 张</strong><p>{receiptComplete} 条已覆盖，{receiptPending} 条待处理</p></div></article>
        <article className={summary.personalSettlementCents < 0 ? "negative" : ""}><span className="expense-summary-icon amber"><ReceiptText size={18} /></span><div><small>{settlementLabel}</small><strong>{formatSignedCny(summary.personalSettlementCents)}</strong><p>提前请款 {formatCny(summary.advanceReceivedCents)}</p></div></article>
      </section>

      <section className="expense-category-grid" aria-label="费用分类概览">
        {EXPENSE_CATEGORIES.map((category, index) => {
          const total = summary.categoryTotals[category.id];
          const Icon = CATEGORY_ICONS[category.id] ?? ReceiptText;
          return (
            <article className="expense-category-card" key={category.id}>
              <span className={`expense-category-icon tone-${index % 4}`}><Icon size={20} /></span>
              <div className="expense-category-copy">
                <strong>{index + 1}. {category.label}记录</strong>
                <p>{total.expenseCount} 条费用 · {total.paymentCount} 笔付款</p>
                <b>{formatCny(total.reimbursementCents)}</b>
              </div>
              <button className="expense-text-button" type="button" onClick={() => onNavigate("ledger", { category: category.id })}>查看{category.label}<ArrowRight size={14} /></button>
            </article>
          );
        })}
        <article className="expense-category-card expense-policy-card">
          <span className="expense-category-icon policy"><CircleHelp size={20} /></span>
          <div className="expense-category-copy"><strong>报销规则</strong><p>餐费、住宿、招待等额度尚未录入</p><b>规则待配置</b></div>
          <button className="expense-text-button" type="button" onClick={() => onNavigate("organize")}>人工核对<ArrowRight size={14} /></button>
        </article>
      </section>

      <section className="expense-overview-note">
        <div><strong>{week.start}—{week.end}</strong><span>按自然周汇总；公司直付的实付和计入报销金额分别统计。</span></div>
        <button className="primary-button" type="button" onClick={() => onNavigate("organize")}>开始报销整理<ArrowRight size={16} /></button>
      </section>
    </div>
  );
}
