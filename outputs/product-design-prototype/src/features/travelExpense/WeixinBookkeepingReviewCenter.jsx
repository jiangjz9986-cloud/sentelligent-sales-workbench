import { AlertTriangle, Check, ChevronDown, ChevronUp, MessageCircle } from "lucide-react";
import { useState } from "react";

const WARNING_LABELS = {
  missing_date: "缺发生日期",
  missing_amount: "缺金额",
  missing_category: "缺费用类别",
  invalid_model_response: "模型返回无效",
  WEIXIN_CONFIRMATION_REQUIRED: "需微信引用确认",
};

const RAW_TEXT_CLAMP_LENGTH = 60;

function warningDisplayLabels(warnings = []) {
  const labels = [];
  for (const code of warnings) {
    const label = WARNING_LABELS[code] ?? "待人工复核";
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function draftSummary(item) {
  const expense = item?.analysis?.expense ?? {};
  const amountCents = Number.isSafeInteger(expense.amountCents)
    ? expense.amountCents
    : Number.isSafeInteger(expense.amount_cents) ? expense.amount_cents : null;
  return {
    occurredOn: expense.occurredOn ?? expense.occurred_on ?? "",
    amountYuan: amountCents === null ? "" : `¥${(amountCents / 100).toFixed(2)}`,
    purpose: expense.purpose ?? "",
    merchant: expense.merchant ?? "",
  };
}

/**
 * Read-only review list. WeChat is the only confirmation surface: the web
 * workbench shows pending drafts and their recognition summary, and every
 * confirm / revise / cancel decision happens by quoting the WeChat message.
 */
export function WeixinBookkeepingReviewCenter({ reviews = [] }) {
  const [expandedRawIds, setExpandedRawIds] = useState(() => new Set());

  function toggleRawText(itemId) {
    setExpandedRawIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <section className="expense-inbox-review weixin-bookkeeping-review-center" aria-labelledby="weixin-bookkeeping-review-title">
      <header>
        <div><AlertTriangle size={18} aria-hidden="true" /><span><strong id="weixin-bookkeeping-review-title">小小待确认记账</strong><small>确认、修改和取消只在微信中完成：引用小小的待记账消息回复即可，网页仅作只读复核。</small></span></div>
        <b>{reviews.length}</b>
      </header>
      <div className="expense-inbox-list">
        {reviews.map((item) => {
          const rawText = item.rawText || "未保存原始文字";
          const rawExpanded = expandedRawIds.has(item.id);
          const rawCollapsible = rawText.length > RAW_TEXT_CLAMP_LENGTH;
          const flagLabels = warningDisplayLabels(item.warnings ?? []);
          const categoryText = `${item.category}${item.subcategory ? ` / ${item.subcategory}` : ""}`;
          const summary = draftSummary(item);
          return (
            <article className="expense-inbox-item weixin-bookkeeping-review-item" key={item.id}>
              <div className="weixin-review-source">
                <strong>原始文字</strong>
                <p className={`weixin-review-raw${rawExpanded ? " is-expanded" : ""}`}>{rawText}</p>
                {rawCollapsible ? (
                  <button type="button" className="weixin-review-raw-toggle" aria-expanded={rawExpanded} onClick={() => toggleRawText(item.id)}>
                    {rawExpanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                    {rawExpanded ? "收起全文" : "展开全文"}
                  </button>
                ) : null}
                <small>{item.category}{item.subcategory ? ` · ${item.subcategory}` : ""} · {item.updatedAt || ""}</small>
                {flagLabels.length ? (
                  <p className="weixin-review-flags" aria-label="识别待补事项">
                    {flagLabels.map((label) => <span className="weixin-review-flag" key={label}><AlertTriangle size={11} aria-hidden="true" />{label}</span>)}
                  </p>
                ) : null}
              </div>
              <div className="weixin-review-decision">
                <dl className="weixin-review-summary" aria-label="识别结果摘要">
                  <div><dt>发生日期</dt><dd>{summary.occurredOn || "待确认"}</dd></div>
                  <div><dt>金额</dt><dd>{summary.amountYuan || "待确认"}</dd></div>
                  <div className="weixin-review-wide"><dt>用途</dt><dd>{summary.purpose || "待确认"}</dd></div>
                  <div><dt>商户</dt><dd>{summary.merchant || "—"}</dd></div>
                  <div><dt>分类</dt><dd>{categoryText}</dd></div>
                </dl>
                <p className="weixin-review-wechat-hint" role="note">
                  <MessageCircle size={14} aria-hidden="true" />
                  请在微信中引用这条待记账消息回复“确认”“修改金额为…”或“取消”。
                </p>
              </div>
            </article>
          );
        })}
        {reviews.length === 0 ? <div className="expense-inbox-empty" role="status"><Check size={18} /><span><strong>没有待确认的小小记账</strong><small>请在微信中回复“确认 / 修改 / 取消”，这里会实时同步结果。</small></span></div> : null}
      </div>
    </section>
  );
}
