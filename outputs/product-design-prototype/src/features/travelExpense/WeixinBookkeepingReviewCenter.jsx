import { AlertTriangle, Check, ChevronDown, ChevronUp, CircleX, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

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

function expenseDraft(item) {
  const expense = item?.analysis?.expense ?? {};
  const amountCents = Number.isSafeInteger(expense.amountCents)
    ? expense.amountCents
    : Number.isSafeInteger(expense.amount_cents) ? expense.amount_cents : "";
  return {
    occurredOn: expense.occurredOn ?? expense.occurred_on ?? "",
    amountYuan: amountCents === "" ? "" : (amountCents / 100).toFixed(2),
    purpose: expense.purpose ?? "",
    merchant: expense.merchant ?? "",
  };
}

function reviewAnalysis(item, draft) {
  const amount = Number(draft.amountYuan);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.occurredOn) || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("请补齐有效的日期和正数金额。");
  }
  return {
    status: "ready",
    confidence: 1,
    expense: {
      occurredOn: draft.occurredOn,
      amountCents: Math.round(amount * 100),
      reimbursementCents: Math.round(amount * 100),
      purpose: draft.purpose.trim() || `${item.category}${item.subcategory ? `-${item.subcategory}` : ""}`,
      merchant: draft.merchant.trim() || null,
      fundingSource: "personal",
      paymentMethod: "other",
    },
    warnings: [],
    source: { provider: "manual", model: null },
  };
}

export function WeixinBookkeepingReviewCenter({ reviews = [], apiClient, onChanged }) {
  const [drafts, setDrafts] = useState({});
  const [pendingId, setPendingId] = useState(null);
  const [errors, setErrors] = useState({});
  const [expandedRawIds, setExpandedRawIds] = useState(() => new Set());
  const getDraft = (item) => drafts[item.id] ?? expenseDraft(item);
  const pendingLabel = useMemo(() => (pendingId ? "正在更新…" : ""), [pendingId]);

  function toggleRawText(itemId) {
    setExpandedRawIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function confirm(item) {
    setPendingId(item.id);
    setErrors((current) => ({ ...current, [item.id]: "" }));
    try {
      const confirmed = await apiClient.confirmWeixinBookkeepingReview(item.id, reviewAnalysis(item, getDraft(item)));
      onChanged?.(confirmed);
    } catch (error) {
      setErrors((current) => ({ ...current, [item.id]: error.message || "确认失败，请重试。" }));
    } finally {
      setPendingId(null);
    }
  }

  async function reject(item) {
    const reason = globalThis.prompt?.("请输入拒绝原因", "信息无法核实") || "信息无法核实";
    setPendingId(item.id);
    try {
      const rejected = await apiClient.rejectWeixinBookkeepingReview(item.id, reason);
      onChanged?.(rejected);
    } catch (error) {
      setErrors((current) => ({ ...current, [item.id]: error.message || "拒绝失败，请重试。" }));
    } finally {
      setPendingId(null);
    }
  }

  async function retry(item) {
    setPendingId(item.id);
    try {
      const retried = await apiClient.retryWeixinBookkeepingReview(item.id);
      onChanged?.(retried);
    } catch (error) {
      setErrors((current) => ({ ...current, [item.id]: error.message || "重试失败，请重试。" }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="expense-inbox-review weixin-bookkeeping-review-center" aria-labelledby="weixin-bookkeeping-review-title">
      <header>
        <div><AlertTriangle size={18} aria-hidden="true" /><span><strong id="weixin-bookkeeping-review-title">小小待确认记账</strong><small>微信发送的付款凭证或记账文字会先停在这里，确认后才创建正式费用和付款记录。</small></span></div>
        <b>{reviews.length}</b>
      </header>
      <div className="expense-inbox-list">
        {reviews.map((item) => {
          const draft = getDraft(item);
          const update = (field, value) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, [field]: value } }));
          const pending = pendingId === item.id;
          const rawText = item.rawText || "未保存原始文字";
          const rawExpanded = expandedRawIds.has(item.id);
          const rawCollapsible = rawText.length > RAW_TEXT_CLAMP_LENGTH;
          const flagLabels = warningDisplayLabels(item.warnings ?? []);
          const categoryText = `${item.category}${item.subcategory ? ` / ${item.subcategory}` : ""}`;
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
                <div className="weixin-review-form">
                  <label><span>发生日期</span><input type="date" value={draft.occurredOn} onChange={(event) => update("occurredOn", event.target.value)} disabled={pending} /></label>
                  <label><span>金额（元）</span><input type="number" min="0.01" step="0.01" value={draft.amountYuan} onChange={(event) => update("amountYuan", event.target.value)} disabled={pending} /></label>
                  <label className="weixin-review-wide"><span>用途</span><input value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} disabled={pending} /></label>
                  <label><span>商户</span><input value={draft.merchant} onChange={(event) => update("merchant", event.target.value)} disabled={pending} /></label>
                  <div className="weixin-review-category"><span>分类</span><b>{categoryText}</b></div>
                </div>
                {errors[item.id] ? <p className="expense-inbox-error" role="alert">{errors[item.id]}</p> : null}
                <div className="weixin-review-actions">
                  <button type="button" className="primary-button" onClick={() => void confirm(item)} disabled={pending}><Check size={15} />确认入账</button>
                  <button type="button" className="ghost-button" onClick={() => void retry(item)} disabled={pending}><RefreshCw size={15} />重新识别</button>
                  <button type="button" className="ghost-button danger" onClick={() => void reject(item)} disabled={pending}><CircleX size={15} />拒绝</button>
                </div>
              </div>
            </article>
          );
        })}
        {reviews.length === 0 ? <div className="expense-inbox-empty" role="status"><Check size={18} /><span><strong>没有待确认的小小记账</strong><small>{pendingLabel || "请在微信中回复“确认 / 修改 / 取消”，或在此完成网页人工复核。"}</small></span></div> : null}
      </div>
    </section>
  );
}
