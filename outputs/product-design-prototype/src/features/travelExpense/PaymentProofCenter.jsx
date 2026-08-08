import {
  Bot,
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  Inbox,
  LoaderCircle,
  Paperclip,
  ScanText,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  createPaymentProofSelection,
  togglePaymentProofPayment,
  validatePaymentProofSelection,
} from "./paymentProofModel.js";
import { AuthenticatedPdfFrame } from "./AuthenticatedPdfFrame.jsx";
import {
  isTravelExpenseImage,
  isTravelExpensePdf,
} from "./travelExpenseDocument.js";
import {
  formatCny,
  formatTravelExpenseDateTime,
} from "./travelExpenseModel.js";

const FUNDING_LABELS = {
  personal: "个人垫付",
  company: "公司直付",
  advance: "请款资金",
};

function paymentLabel(payment, index) {
  const time = payment.paidAt ? formatTravelExpenseDateTime(payment.paidAt) : "时间待补";
  const merchant = payment.merchant || "收款方待补";
  return `付款 ${index + 1} · ${merchant} · ${formatCny(payment.amountCents)} · ${time}`;
}

function proofPaymentSummary(attachment, expense) {
  const paymentIds = Array.isArray(attachment.paymentIds)
    ? attachment.paymentIds
    : attachment.paymentId
      ? [attachment.paymentId]
      : [];
  if (!paymentIds.length && expense.payments.length === 1) return "对应付款 1";
  const indexes = paymentIds
    .map((paymentId) => expense.payments.findIndex((payment) => payment.id === paymentId))
    .filter((index) => index >= 0)
    .map((index) => index + 1);
  return indexes.length ? `对应付款 ${indexes.join("、")}` : "付款关联待确认";
}

const EVIDENCE_LABELS = {
  amountCents: "金额",
  occurredOn: "日期",
  paidTime: "时间",
};

function evidenceValue(evidence, field) {
  const value = evidence?.[field];
  if (value === null || value === undefined || value === "") return "未提供";
  return field === "amountCents" ? formatCny(value) : String(value);
}

function initialInboxSelection(item, expenses) {
  const candidate = item.candidates?.find((current) => (
    expenses.some((expense) => expense.id === current.expenseId)
  ));
  return candidate
    ? { expenseId: candidate.expenseId, paymentId: candidate.paymentId }
    : { expenseId: "", paymentId: "" };
}

export function PaymentProofCenter({
  expenses,
  inboxItems = [],
  getAttachmentUrl,
  getInboxContentUrl,
  getInboxContentResponse,
  onConfirmInbox,
  onRejectInbox,
  pendingInboxId,
  onUpload,
  onDelete,
  pendingAttachmentId,
}) {
  const [selections, setSelections] = useState({});
  const [selectionErrors, setSelectionErrors] = useState({});
  const [inboxSelections, setInboxSelections] = useState({});
  const [inboxErrors, setInboxErrors] = useState({});
  const [brokenImages, setBrokenImages] = useState(() => new Set());

  const proofCount = useMemo(() => expenses.reduce((total, expense) => (
    total + expense.attachments.filter((attachment) => attachment.kind === "payment_proof").length
  ), 0), [expenses]);

  function selectedFor(expense) {
    return selections[expense.id] ?? createPaymentProofSelection(expense);
  }

  function selectedInboxTarget(item) {
    return inboxSelections[item.id] ?? initialInboxSelection(item, expenses);
  }

  function chooseInboxExpense(item, expenseId) {
    const expense = expenses.find((candidate) => candidate.id === expenseId);
    const candidate = item.candidates?.find((current) => current.expenseId === expenseId);
    setInboxSelections((current) => ({
      ...current,
      [item.id]: {
        expenseId,
        paymentId: candidate?.paymentId && expense?.payments.some((payment) => payment.id === candidate.paymentId)
          ? candidate.paymentId
          : "",
      },
    }));
    setInboxErrors((current) => ({ ...current, [item.id]: "" }));
  }

  async function confirmInbox(item) {
    const selection = selectedInboxTarget(item);
    const expense = expenses.find((candidate) => candidate.id === selection.expenseId);
    const payment = expense?.payments.find((candidate) => candidate.id === selection.paymentId);
    if (!expense || !payment) {
      setInboxErrors((current) => ({ ...current, [item.id]: "请选择账单和具体付款记录后再确认关联。" }));
      return;
    }
    try {
      await onConfirmInbox(item, {
        expenseReferenceCode: expense.referenceCode,
        paymentId: payment.id,
      });
      setInboxErrors((current) => ({ ...current, [item.id]: "" }));
    } catch (error) {
      setInboxErrors((current) => ({
        ...current,
        [item.id]: error?.message || "付款凭证关联失败，请重新选择后再试。",
      }));
    }
  }

  async function rejectInbox(item) {
    if (!globalThis.confirm?.(`确认不关联“${item.fileName}”并保留原件吗？`)) return;
    try {
      await onRejectInbox(item);
      setInboxErrors((current) => ({ ...current, [item.id]: "" }));
    } catch (error) {
      setInboxErrors((current) => ({
        ...current,
        [item.id]: error?.message || "待处理凭证更新失败，请稍后重试。",
      }));
    }
  }

  function togglePayment(expense, paymentId) {
    setSelections((current) => ({
      ...current,
      [expense.id]: togglePaymentProofPayment(current[expense.id] ?? [], paymentId, expense),
    }));
    setSelectionErrors((current) => ({ ...current, [expense.id]: "" }));
  }

  async function uploadFile(expense, file) {
    let selectedPaymentIds;
    try {
      selectedPaymentIds = validatePaymentProofSelection(selectedFor(expense), expense);
    } catch (error) {
      setSelectionErrors((current) => ({ ...current, [expense.id]: error.message }));
      return;
    }

    try {
      await onUpload(expense, file, selectedPaymentIds);
      setSelections((current) => ({ ...current, [expense.id]: [] }));
      setSelectionErrors((current) => ({ ...current, [expense.id]: "" }));
    } catch (error) {
      setSelectionErrors((current) => ({
        ...current,
        [expense.id]: error?.message || "付款凭证上传失败，请稍后重试。",
      }));
    }
  }

  return (
    <section className="expense-proof-center">
      <header className="expense-section-intro">
        <div>
          <strong>付款凭证</strong>
          <p>上传前先勾选凭证对应的付款记录；支持一张凭证关联一笔或多笔付款。</p>
        </div>
        <span>{proofCount} 份凭证</span>
      </header>

      <section className="expense-inbox-review" aria-labelledby="expense-inbox-review-title">
        <header>
          <div><Inbox size={18} aria-hidden="true" /><span><strong id="expense-inbox-review-title">微信待处理</strong><small>核对机器人识别结果，再关联到具体付款</small></span></div>
          <b>{inboxItems.length}</b>
        </header>
        <div className="expense-inbox-list">
          {inboxItems.map((item) => {
            const selection = selectedInboxTarget(item);
            const selectedExpense = expenses.find((expense) => expense.id === selection.expenseId);
            const recognition = item.recognition ?? {};
            const evidence = recognition.evidence ?? recognition.effectiveEvidence ?? {};
            const typedEvidence = recognition.typedEvidence ?? {};
            const conflicts = Array.isArray(recognition.conflicts) ? recognition.conflicts : [];
            const pending = pendingInboxId === item.id;
            const isImage = isTravelExpenseImage(item);
            const isPdf = isTravelExpensePdf(item);
            const broken = brokenImages.has(item.id);
            return (
              <article className="expense-inbox-item" key={item.id}>
                <div className="expense-inbox-original">
                  {isImage && !broken ? <img src={getInboxContentUrl(item.id)} alt={item.fileName} onError={() => setBrokenImages((current) => new Set(current).add(item.id))} /> : null}
                  {isPdf ? <AuthenticatedPdfFrame resourceKey={item.id} loadPdf={({ signal }) => getInboxContentResponse(item.id, { signal })} title={`${item.fileName} PDF 付款凭证原件`} renderWidth={900} /> : null}
                  {(!isImage && !isPdf) || broken ? <span><ImageOff size={24} /><strong>{broken ? "预览失败" : "原件文件"}</strong></span> : null}
                  <a href={getInboxContentUrl(item.id)} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开原件</a>
                </div>

                <div className="expense-inbox-evidence">
                  <header><div><ScanText size={16} /><strong>识别证据</strong></div><span className={conflicts.length ? "has-conflict" : "is-ready"}>{conflicts.length ? `${conflicts.length} 项冲突` : item.errorCode ? "需人工补充" : "已识别"}</span></header>
                  <strong className="expense-inbox-file-name" title={item.fileName}>{item.fileName}</strong>
                  <div className="expense-inbox-evidence-grid" role="table" aria-label={`${item.fileName}识别证据`}>
                    <div role="row" className="heading"><span>字段</span><span>人工提示</span><span>OCR / 模型</span></div>
                    {Object.entries(EVIDENCE_LABELS).map(([field, label]) => {
                      const conflict = conflicts.some((current) => current.field === field);
                      return <div role="row" className={conflict ? "conflict" : ""} key={field}><strong>{label}</strong><span>{evidenceValue(typedEvidence, field)}</span><span>{evidenceValue(evidence, field)}</span></div>;
                    })}
                  </div>
                  {conflicts.length ? <p className="expense-inbox-conflict" role="alert"><CircleAlert size={15} />人工提示与识别结果不一致，系统不会自动关联。</p> : null}
                  {!conflicts.length && item.errorCode ? <p className="expense-inbox-warning"><CircleAlert size={15} />自动识别未完成，原件已无损保留，请人工选择。</p> : null}
                  <small className="expense-inbox-candidate-count"><Bot size={13} />机器人给出 {item.candidates?.length ?? 0} 个候选</small>
                </div>

                <div className="expense-inbox-decision">
                  <label><span>账单编号</span><select value={selection.expenseId} onChange={(event) => chooseInboxExpense(item, event.target.value)}><option value="">请选择账单</option>{expenses.map((expense) => <option value={expense.id} key={expense.id}>{expense.referenceCode} · {expense.purpose}</option>)}</select></label>
                  <label><span>付款记录</span><select value={selection.paymentId} disabled={!selectedExpense} onChange={(event) => { setInboxSelections((current) => ({ ...current, [item.id]: { ...selection, paymentId: event.target.value } })); setInboxErrors((current) => ({ ...current, [item.id]: "" })); }}><option value="">请选择付款</option>{selectedExpense?.payments.map((payment, index) => <option value={payment.id} key={payment.id}>{paymentLabel(payment, index)}</option>)}</select></label>
                  {inboxErrors[item.id] ? <p className="expense-inbox-error" role="alert"><CircleAlert size={15} />{inboxErrors[item.id]}</p> : null}
                  <div className="expense-inbox-actions">
                    <button type="button" className="primary" disabled={pending} onClick={() => void confirmInbox(item)}>{pending ? <LoaderCircle className="state-spinner" size={15} /> : <Check size={15} />}确认关联</button>
                    <button type="button" disabled={pending} onClick={() => void rejectInbox(item)}>不关联，保留原件</button>
                  </div>
                </div>
              </article>
            );
          })}
          {inboxItems.length === 0 ? <div className="expense-inbox-empty" role="status"><Check size={18} /><span><strong>没有待处理凭证</strong><small>微信机器人收到的新凭证会显示在这里。</small></span></div> : null}
        </div>
      </section>

      <div className="expense-proof-list">
        {expenses.map((expense) => {
          const selectedPaymentIds = selectedFor(expense);
          const proofs = expense.attachments.filter((attachment) => attachment.kind === "payment_proof");
          const pending = pendingAttachmentId === expense.id;
          return (
            <article className="expense-proof-card" key={expense.id}>
              <header className="expense-proof-card-head">
                <div>
                  <span>{expense.occurredOn}</span>
                  <strong>{expense.purpose}</strong>
                  <small>{formatCny(expense.reimbursementCents)} · {expense.payments.length} 笔付款 · {proofs.length} 份凭证</small>
                </div>
                <span className={proofs.length ? "is-ready" : "is-missing"}>{proofs.length ? "已有凭证" : "待上传"}</span>
              </header>

              <div className="expense-proof-workspace">
                <fieldset className="expense-proof-payments">
                  <legend>选择本次凭证对应的付款</legend>
                  {expense.payments.map((payment, index) => (
                    <label key={payment.id}>
                      <input
                        type="checkbox"
                        checked={selectedPaymentIds.includes(payment.id)}
                        onChange={() => togglePayment(expense, payment.id)}
                      />
                      <span>
                        <strong>{paymentLabel(payment, index)}</strong>
                        <small>{FUNDING_LABELS[payment.fundingSource] ?? payment.fundingSource} · 报销 {formatCny(payment.reimbursementCents)}</small>
                      </span>
                    </label>
                  ))}
                  {expense.payments.length === 0 ? <p className="expense-proof-empty-payment">请先在费用账本中添加付款记录。</p> : null}
                </fieldset>

                <div className="expense-proof-upload">
                  <label className="expense-upload-tile" data-enabled={selectedPaymentIds.length ? "true" : "false"} aria-disabled={!selectedPaymentIds.length || pending}>
                    <Upload size={19} />
                    <span>{pending ? "正在上传" : "上传付款凭证"}</span>
                    <small>{selectedPaymentIds.length ? `已选 ${selectedPaymentIds.length} 笔付款` : "至少选择一笔付款"}</small>
                    <small>图片 / PDF · 原文件最大 12 MiB</small>
                    <input type="file"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      disabled={!selectedPaymentIds.length || pending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadFile(expense, file);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {selectionErrors[expense.id] ? <p className="expense-proof-error" role="alert"><CircleAlert size={15} />{selectionErrors[expense.id]}</p> : null}
                </div>
              </div>

              <div className="expense-proof-files" aria-label={`${expense.purpose}的付款凭证`}>
                {proofs.map((attachment) => {
                  const isImage = isTravelExpenseImage(attachment);
                  const isPdf = isTravelExpensePdf(attachment);
                  const broken = brokenImages.has(attachment.id);
                  return (
                    <article className="expense-proof-file" key={attachment.id}>
                      <a className="expense-proof-file-preview" href={getAttachmentUrl(attachment.id)} target="_blank" rel="noreferrer" aria-label={`打开${attachment.fileName}`}>
                        {isImage && !broken ? (
                          <img src={getAttachmentUrl(attachment.id)} alt={attachment.fileName} onError={() => setBrokenImages((current) => new Set(current).add(attachment.id))} />
                        ) : (
                          <span>{broken ? <ImageOff size={22} /> : <FileText size={24} />}<strong>{isPdf ? "PDF" : broken ? "预览失败" : "文件"}</strong></span>
                        )}
                      </a>
                      <div>
                        <strong title={attachment.fileName}>{attachment.fileName}</strong>
                        <small>{proofPaymentSummary(attachment, expense)}</small>
                        <nav aria-label={`${attachment.fileName}文件操作`}>
                          <a href={getAttachmentUrl(attachment.id)} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开</a>
                          <a href={getAttachmentUrl(attachment.id)} download={attachment.fileName}><Download size={14} />下载</a>
                          <button type="button" disabled={pendingAttachmentId === attachment.id} onClick={() => onDelete(expense, attachment)}><Trash2 size={14} />删除</button>
                        </nav>
                      </div>
                    </article>
                  );
                })}
                {proofs.length === 0 ? <div className="expense-proof-files-empty"><Paperclip size={18} /><span>暂无付款凭证</span></div> : null}
              </div>
            </article>
          );
        })}
        {expenses.length === 0 ? <div className="expense-proof-empty"><Paperclip size={20} /><strong>本周暂无费用</strong><span>先记一笔费用，再为对应付款补充凭证。</span></div> : null}
      </div>
    </section>
  );
}
