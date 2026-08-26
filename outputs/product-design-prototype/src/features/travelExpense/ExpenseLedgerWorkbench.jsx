import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  CreditCard,
  FileCheck2,
  FileClock,
  FileWarning,
  Landmark,
  LoaderCircle,
  MapPin,
  MessageCircleMore,
  Pencil,
  ReceiptText,
  RefreshCw,
  Utensils,
  WalletCards,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import { buildExpenseLedgerWorkbenchModel } from "./expenseLedgerWorkbenchModel.js";
import { formatCny, formatSignedCny } from "./travelExpenseModel.js";
import "./expenseLedgerWorkbench.css";

const CATEGORY_ICONS = {
  breakfast: Utensils,
  lunch: Utensils,
  dinner: Utensils,
  meal: Utensils,
  lodging: Landmark,
  transport: CreditCard,
  hospitality: ReceiptText,
  other: ReceiptText,
  advance: WalletCards,
};

function amountLabel(item) {
  if (item.amountCents === null) return "金额待确认";
  if (item.transactionType === "income") return formatSignedCny(item.amountCents);
  return formatCny(item.amountCents);
}

function itemAccessibleLabel(item) {
  return [
    item.time,
    item.transactionLabel,
    item.categoryText,
    amountLabel(item),
    item.formal ? "已正式入账" : "待确认，尚未计入正式账本",
  ].join("，");
}

function TransactionType({ item }) {
  const income = item.transactionType === "income";
  const Icon = income ? ArrowUp : ArrowDown;
  return (
    <span className={`ledger-workbench-type is-${item.transactionType}`}>
      <span aria-hidden="true"><Icon size={13} /></span>
      {item.transactionLabel}
    </span>
  );
}

function CategoryCopy({ item }) {
  const Icon = CATEGORY_ICONS[item.categoryId] ?? ReceiptText;
  return (
    <div className="ledger-workbench-category">
      <Icon size={17} aria-hidden="true" />
      <span>
        <strong>{item.categoryText}</strong>
        <small>{item.notes}</small>
        {item.region !== "—" ? <small className="ledger-workbench-region"><MapPin size={12} aria-hidden="true" />{item.region}<span>· {item.regionSourceLabel}</span></small> : null}
      </span>
    </div>
  );
}

function SourceState({ item }) {
  const Icon = item.kind === "review" ? MessageCircleMore : item.kind === "advance" ? Landmark : CreditCard;
  return <span className="ledger-workbench-source"><Icon size={16} aria-hidden="true" />{item.sourceLabel}</span>;
}

function ProofState({ item }) {
  const Icon = item.proofState === "attached" || item.proofState === "system"
    ? CheckCircle2
    : item.proofState === "pending" ? FileClock : FileWarning;
  return <span className={`ledger-workbench-state is-${item.proofState}`}><Icon size={15} aria-hidden="true" />{item.proofLabel}</span>;
}

function InvoiceState({ item }) {
  const Icon = item.invoiceState === "ready"
    ? FileCheck2
    : item.invoiceState === "not_applicable" ? null : CircleAlert;
  return <span className={`ledger-workbench-state is-invoice-${item.invoiceState}`}>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{item.invoiceLabel}</span>;
}

function ActionButton({ item, onOpenItem, onReviewItem }) {
  const action = item.formal ? onOpenItem : onReviewItem;
  return (
    <button
      className={item.formal ? "ledger-workbench-link" : "ledger-workbench-review-button"}
      type="button"
      disabled={typeof action !== "function"}
      aria-label={`${item.action}：${itemAccessibleLabel(item)}`}
      onClick={() => action?.(item.original, item)}
    >
      {item.action}
    </button>
  );
}

function LedgerDesktopTable({ items, highlightExpenseId, onOpenItem, onReviewItem }) {
  return (
    <div className="ledger-workbench-desktop-table">
      <table>
        <caption className="sr-only">所选日期的正式账目与待确认记账</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">类型</th>
            <th scope="col">分类 / 备注</th>
            <th scope="col">金额</th>
            <th scope="col">来源</th>
            <th scope="col">凭证</th>
            <th scope="col">发票</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const highlighted = item.kind === "expense" && item.sourceId === highlightExpenseId;
            return (
            <tr key={item.id} className={`${item.formal ? "is-formal" : "is-pending"}${highlighted ? " is-highlighted" : ""}`} data-ledger-state={item.formal ? "formal" : "pending"} data-highlighted={highlighted || undefined}>
              <td><time dateTime={`${item.date}T${item.time === "--:--" ? "00:00" : item.time}`}>{item.time}</time></td>
              <td><TransactionType item={item} /></td>
              <td><CategoryCopy item={item} /></td>
              <td>
                <strong className={`ledger-workbench-amount is-${item.transactionType}`}>{amountLabel(item)}</strong>
                {!item.formal ? <small className="ledger-workbench-not-counted">尚未计入本周合计</small> : null}
              </td>
              <td><SourceState item={item} /></td>
              <td><ProofState item={item} /></td>
              <td><InvoiceState item={item} /></td>
              <td><ActionButton item={item} onOpenItem={onOpenItem} onReviewItem={onReviewItem} /></td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LedgerMobileCards({ items, highlightExpenseId, onOpenItem, onReviewItem }) {
  return (
    <ul className="ledger-workbench-mobile-list" aria-label="所选日期账目卡片">
      {items.map((item) => {
        const highlighted = item.kind === "expense" && item.sourceId === highlightExpenseId;
        return (
        <li key={item.id} className={`${item.formal ? "is-formal" : "is-pending"}${highlighted ? " is-highlighted" : ""}`} data-ledger-state={item.formal ? "formal" : "pending"} data-highlighted={highlighted || undefined}>
          <article aria-label={itemAccessibleLabel(item)}>
            <header>
              <div><time dateTime={`${item.date}T${item.time === "--:--" ? "00:00" : item.time}`}>{item.time}</time><TransactionType item={item} /></div>
              <strong className={`ledger-workbench-amount is-${item.transactionType}`}>{amountLabel(item)}</strong>
            </header>
            <CategoryCopy item={item} />
            <dl>
              <div><dt>来源</dt><dd><SourceState item={item} /></dd></div>
              <div><dt>付款凭证</dt><dd><ProofState item={item} /></dd></div>
              <div><dt>发票</dt><dd><InvoiceState item={item} /></dd></div>
            </dl>
            {!item.formal ? <p className="ledger-workbench-pending-note"><CircleAlert size={14} aria-hidden="true" />待确认内容不会计入本周合计</p> : null}
            <footer><ActionButton item={item} onOpenItem={onOpenItem} onReviewItem={onReviewItem} /></footer>
          </article>
        </li>
        );
      })}
    </ul>
  );
}

function EmptyDay({ day }) {
  return (
    <div className="ledger-workbench-empty" role="status">
      <CalendarDays size={24} aria-hidden="true" />
      <strong>{day.weekdayLong}暂无账目</strong>
      <p>微信确认或手工记账后，正式账目会显示在这里。</p>
    </div>
  );
}

function SummaryStrip({ summary, onStartReimbursement }) {
  const balanceLabel = summary.advanceBalanceState === "remaining"
    ? "借款剩余"
    : summary.advanceBalanceState === "overspent" ? "超额个人垫付" : "借款已结平";
  return (
    <footer className="ledger-workbench-summary" aria-label="本周正式账本摘要">
      <dl>
        <div><dt>本周已确认支出</dt><dd>{formatCny(summary.formalExpenseCents)}</dd></div>
        <div><dt>可报销金额</dt><dd>{formatCny(summary.reimbursableCents)}</dd></div>
        <div className="is-income"><dt>借款收入</dt><dd>{formatCny(summary.advanceIncomeCents)}</dd></div>
        <div className={`is-${summary.advanceBalanceState}`}><dt>{balanceLabel}</dt><dd>{formatSignedCny(summary.advanceBalanceCents)}</dd></div>
        <div><dt>凭证缺失</dt><dd>{summary.missingProofCount}</dd></div>
        <div><dt>发票缺失</dt><dd>{summary.missingInvoiceCount}</dd></div>
      </dl>
      <button type="button" onClick={() => onStartReimbursement?.()} disabled={typeof onStartReimbursement !== "function"}>
        <ReceiptText size={17} aria-hidden="true" />整理报销
      </button>
    </footer>
  );
}

export function ExpenseLedgerWorkbench({
  week,
  expenses = [],
  advances = [],
  reviews = [],
  matches = [],
  noInvoiceConfirmations = [],
  regionProfile = null,
  selectedDate,
  highlightExpenseId = null,
  today,
  status = "ready",
  error = "",
  onSelectDate,
  onOpenItem,
  onReviewItem,
  onOpenRegionSettings,
  onRetry,
  onStartReimbursement,
}) {
  const uid = useId().replaceAll(":", "");
  const [localSelectedDate, setLocalSelectedDate] = useState(selectedDate ?? null);
  const requestedDate = selectedDate ?? localSelectedDate;
  const model = useMemo(() => buildExpenseLedgerWorkbenchModel({
    week,
    expenses,
    advances,
    reviews,
    matches,
    noInvoiceConfirmations,
    regionProfile,
    selectedDate: requestedDate,
    today,
  }), [advances, expenses, matches, noInvoiceConfirmations, regionProfile, requestedDate, reviews, today, week]);

  function selectDay(date) {
    if (selectedDate === undefined) setLocalSelectedDate(date);
    onSelectDate?.(date);
  }

  function handleDayKeyDown(event, index) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % model.days.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + model.days.length) % model.days.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = model.days.length - 1;
    else return;
    event.preventDefault();
    selectDay(model.days[nextIndex].date);
    event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')?.[nextIndex]?.focus();
  }

  if (status === "loading") {
    return (
      <section className="ledger-workbench-state-panel" data-testid="expense-ledger-workbench" aria-busy="true" role="status" aria-live="polite">
        <LoaderCircle className="state-spinner" size={26} aria-hidden="true" />
        <strong>正在同步本周账本</strong>
        <p>正式账目和小小待确认记录会分别展示。</p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="ledger-workbench-state-panel is-error" data-testid="expense-ledger-workbench" role="alert">
        <CircleAlert size={26} aria-hidden="true" />
        <strong>账本暂时没有同步完成</strong>
        <p>{error || "请重新读取本周账本；辅助功能失败时，已加载的正式记录仍应保留。"}</p>
        <button type="button" onClick={() => onRetry?.()} disabled={typeof onRetry !== "function"}><RefreshCw size={16} aria-hidden="true" />重新加载</button>
      </section>
    );
  }

  const selectedPanelId = `${uid}-ledger-day-panel`;
  return (
    <section className="ledger-workbench" data-testid="expense-ledger-workbench" aria-busy="false">
      <header className="ledger-workbench-week-head">
        <div><CalendarDays size={18} aria-hidden="true" /><span>自然周</span><strong>{model.week.label}</strong></div>
        <div className="ledger-workbench-region-rule"><MapPin size={16} aria-hidden="true" /><span>区域规则：{model.regionRuleSummary}</span>{typeof onOpenRegionSettings === "function" ? <button type="button" aria-label="编辑我的负责区域" onClick={() => onOpenRegionSettings()}><Pencil size={16} aria-hidden="true" /></button> : null}</div>
      </header>

      <div className="ledger-workbench-days" role="tablist" aria-label="按周一至周日查看费用账本">
        {model.days.map((day, index) => {
          const tabId = `${uid}-ledger-day-${day.date}`;
          return (
            <button
              key={day.date}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={day.selected}
              aria-controls={selectedPanelId}
              tabIndex={day.selected ? 0 : -1}
              className={day.selected ? "is-selected" : ""}
              onClick={() => selectDay(day.date)}
              onKeyDown={(event) => handleDayKeyDown(event, index)}
            >
              <span>{day.weekdayShort} <time dateTime={day.date}>{day.monthDay}</time>{day.isToday ? <b>今天</b> : null}</span>
              <strong>{day.region}</strong>
              <small>{day.formalCount} 条 / {day.pendingCount} 待</small>
            </button>
          );
        })}
      </div>

      <section
        id={selectedPanelId}
        className="ledger-workbench-day-panel"
        role="tabpanel"
        aria-labelledby={`${uid}-ledger-day-${model.selectedDay.date}`}
        tabIndex={0}
      >
        <header>
          <div><strong>{model.selectedDay.date} {model.selectedDay.weekdayLong}</strong><span aria-hidden="true">·</span><span><MapPin size={14} aria-hidden="true" />{model.selectedDay.region}</span><b>{model.selectedDay.formalCount} 条 · {model.selectedDay.pendingCount} 待</b></div>
          <p className="sr-only" aria-live="polite">当前显示 {model.selectedDay.date}，正式记录 {model.selectedDay.formalCount} 条，待确认 {model.selectedDay.pendingCount} 条。</p>
        </header>

        {model.unassignedPending.length > 0 ? (
          <div className="ledger-workbench-unassigned" role="status">
            <CircleAlert size={16} aria-hidden="true" />
            <span>另有 {model.unassignedPending.length} 条小小待确认记录缺少本周有效日期，暂不计入任何一天和本周合计。</span>
          </div>
        ) : null}

        {model.selectedDay.items.length > 0 ? (
          <>
            <LedgerDesktopTable items={model.selectedDay.items} highlightExpenseId={highlightExpenseId} onOpenItem={onOpenItem} onReviewItem={onReviewItem} />
            <LedgerMobileCards items={model.selectedDay.items} highlightExpenseId={highlightExpenseId} onOpenItem={onOpenItem} onReviewItem={onReviewItem} />
          </>
        ) : <EmptyDay day={model.selectedDay} />}
      </section>

      <SummaryStrip summary={model.summary} onStartReimbursement={onStartReimbursement} />
    </section>
  );
}
