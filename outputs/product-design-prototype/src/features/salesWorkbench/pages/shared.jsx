import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { statusTone } from "../../../data/salesWorkbenchData.js";
import { assertBackendReady } from "../../../app/workbenchState.js";

export function joinedList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join("；");
  return String(value ?? "");
}

export async function generateBusinessSuggestion(apiClient, backendStatus, payload) {
  assertBackendReady(
    { isEnabled: apiClient?.isEnabled, status: backendStatus },
    "生成 AI 建议",
  );
  return apiClient.generateAiSuggestion(payload);
}

// 干系人/标签/决策链均为纯展示基元：条目本身即全文，没有可补充的增量信息，
// 因此不再提供点击展开（v0.10.0 去除无信息量的交互示能）。
export function StakeholderGrid({ people }) {
  return (
    <div className="stakeholder-grid">
      {people.map((person) => (
        <article className="stakeholder-card" key={`${person.name}-${person.role}`}>
          <span className="avatar-dot" />
          <strong>{person.name}</strong>
          <small>{person.role}</small>
          <b className="pill tone-blue">{person.influence}</b>
        </article>
      ))}
    </div>
  );
}

export function FieldTags({ items, tone = "blue" }) {
  return (
    <div className="field-tags">
      {items.map((item) => (
        <span className={`field-tag ${statusTone[tone]}`} key={item}>
          {item}
        </span>
      ))}
    </div>
  );
}

export function DecisionChain({ steps }) {
  return (
    <div className="chain-list">
      {steps.map((step, index) => (
        <div className="chain-step" key={step}>
          <time>{index + 1}</time>
          <span>{step}</span>
        </div>
      ))}
    </div>
  );
}

export function DraftPreview({ draft, emptyText }) {
  if (!draft) return <div className="draft-empty">{emptyText}</div>;
  const lines = draft.content.split("\n").filter(Boolean).slice(0, 32);
  const knowledgeRefs = (draft.sourceRefs ?? []).filter((ref) => ref.type === "knowledge");
  return (
    <section className="generated-draft" data-testid="generated-draft">
      <div className="generated-draft-head">
        <span className="pill tone-green">草稿</span>
        <strong>{draft.title ?? `${draft.owner} 销售周报草稿`}</strong>
        <small>{draft.sourceRefs.length} 个来源引用 / {draft.status}</small>
        {knowledgeRefs.length > 0 ? (
          <div className="draft-ref-row">
            <b>知识库引用</b>
            {knowledgeRefs.slice(0, 3).map((ref) => (
              <span className="pill tone-teal" key={`${ref.type}-${ref.id}`}>{ref.title ?? ref.id}</span>
            ))}
          </div>
        ) : null}
      </div>
      <pre>{lines.join("\n")}</pre>
    </section>
  );
}

export function textFromArray(items) {
  return (items ?? []).join("\n");
}

export function arrayFromText(value) {
  return String(value ?? "")
    .split(/\r?\n|[，,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function numberFromInput(value, fallback = 0) {
  if (String(value ?? "").trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function FormField({ label, children }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// 统一样式确认弹窗（以客户删除弹窗为基准泛化）：焦点管理、Escape 取消、
// role="alertdialog"、失败文案留在弹窗内。五域删除共用，testid 前缀区分。
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认删除",
  busy = false,
  errorMessage = "",
  onCancel,
  onConfirm,
  testIdPrefix,
}) {
  const cancelButtonRef = useRef(null);
  const titleId = `${testIdPrefix}-title`;
  const descriptionId = `${testIdPrefix}-description`;

  useEffect(() => {
    if (!open) return undefined;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div className="confirm-dialog-backdrop">
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid={`${testIdPrefix}-dialog`}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <Trash2 size={20} />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {errorMessage ? <p className="confirm-dialog-error" role="alert">{errorMessage}</p> : null}
        </div>
        <div className="confirm-dialog-actions">
          <button
            className="ghost-button"
            type="button"
            ref={cancelButtonRef}
            data-testid={`${testIdPrefix}-cancel`}
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="primary-button danger-button"
            type="button"
            data-testid={`${testIdPrefix}-confirm`}
            disabled={busy}
            onClick={onConfirm}
          >
            <Trash2 size={16} />
            {busy ? "删除中" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function sourceRefText(ref) {
  const typeLabel = {
    artifact: "交付物",
    customer: "客户",
    opportunity: "商机",
    action: "动作",
    knowledge: "知识",
    quick_record: "快速记录",
  }[ref.type] ?? ref.type;
  return `${typeLabel}：${ref.title ?? ref.id ?? "来源"}`;
}
