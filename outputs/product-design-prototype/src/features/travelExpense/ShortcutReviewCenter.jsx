import { AlertTriangle, Check, CircleX, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

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

export function ShortcutReviewCenter({ reviews = [], apiClient, onChanged }) {
  const [drafts, setDrafts] = useState({});
  const [pendingId, setPendingId] = useState(null);
  const [errors, setErrors] = useState({});
  const getDraft = (item) => drafts[item.id] ?? expenseDraft(item);
  const pendingLabel = useMemo(() => (pendingId ? "正在更新…" : ""), [pendingId]);

  async function confirm(item) {
    setPendingId(item.id);
    setErrors((current) => ({ ...current, [item.id]: "" }));
    try {
      await apiClient.confirmShortcutBookkeepingReview(item.id, reviewAnalysis(item, getDraft(item)));
      onChanged?.();
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
      await apiClient.rejectShortcutBookkeepingReview(item.id, reason);
      onChanged?.();
    } catch (error) {
      setErrors((current) => ({ ...current, [item.id]: error.message || "拒绝失败，请重试。" }));
    } finally {
      setPendingId(null);
    }
  }

  async function retry(item) {
    setPendingId(item.id);
    try {
      await apiClient.retryShortcutBookkeepingReview(item.id);
      onChanged?.();
    } catch (error) {
      setErrors((current) => ({ ...current, [item.id]: error.message || "重试失败，请重试。" }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="expense-inbox-review shortcut-review-center" aria-labelledby="shortcut-review-title">
      <header>
        <div><AlertTriangle size={18} aria-hidden="true" /><span><strong id="shortcut-review-title">快捷指令待复核</strong><small>信息不足的出差报销会停在这里，确认后才创建正式费用和付款记录。</small></span></div>
        <b>{reviews.length}</b>
      </header>
      <div className="expense-inbox-list">
        {reviews.map((item) => {
          const draft = getDraft(item);
          const update = (field, value) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, [field]: value } }));
          const pending = pendingId === item.id;
          return (
            <article className="expense-inbox-item shortcut-review-item" key={item.id}>
              <div className="expense-inbox-evidence">
                <strong>原始文字</strong>
                <p>{item.rawText || "未保存原始文字"}</p>
                <small>{item.category}{item.subcategory ? ` · ${item.subcategory}` : ""} · {item.updatedAt || ""}</small>
                {item.warnings?.length ? <p className="expense-inbox-warning"><AlertTriangle size={15} />{item.warnings.join("、")}</p> : null}
              </div>
              <div className="expense-inbox-decision">
                <label><span>发生日期</span><input type="date" value={draft.occurredOn} onChange={(event) => update("occurredOn", event.target.value)} disabled={pending} /></label>
                <label><span>金额（元）</span><input type="number" min="0.01" step="0.01" value={draft.amountYuan} onChange={(event) => update("amountYuan", event.target.value)} disabled={pending} /></label>
                <label><span>用途</span><input value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} disabled={pending} /></label>
                <label><span>商户</span><input value={draft.merchant} onChange={(event) => update("merchant", event.target.value)} disabled={pending} /></label>
                {errors[item.id] ? <p className="expense-inbox-error" role="alert">{errors[item.id]}</p> : null}
                <div className="expense-inbox-actions">
                  <button type="button" className="primary-button" onClick={() => void confirm(item)} disabled={pending}><Check size={15} />确认入账</button>
                  <button type="button" onClick={() => void retry(item)} disabled={pending}><RefreshCw size={15} />重新识别</button>
                  <button type="button" className="danger-button" onClick={() => void reject(item)} disabled={pending}><CircleX size={15} />拒绝</button>
                </div>
              </div>
            </article>
          );
        })}
        {reviews.length === 0 ? <div className="expense-inbox-empty" role="status"><Check size={18} /><span><strong>没有待复核的快捷指令记账</strong><small>{pendingLabel || "信息完整的记录会直接入账。"}</small></span></div> : null}
      </div>
    </section>
  );
}
