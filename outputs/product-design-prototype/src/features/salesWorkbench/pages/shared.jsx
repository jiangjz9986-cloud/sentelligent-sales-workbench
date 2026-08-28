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

export function StakeholderGrid({ people }) {
  const [expandedPerson, setExpandedPerson] = useState(null);

  return (
    <div className="stakeholder-grid">
      {people.map((person) => {
        const id = `${person.name}-${person.role}`;
        return (
        <button
          className={`stakeholder-card interactive-card ${expandedPerson === id ? "expanded" : ""}`}
          key={id}
          type="button"
          onClick={() => setExpandedPerson((current) => (current === id ? null : id))}
        >
          <span className="avatar-dot" />
          <strong>{person.name}</strong>
          <small>{person.role}</small>
          <b className="pill tone-blue">{person.influence}</b>
          {expandedPerson === id ? (
            <small className="item-detail" data-testid="stakeholder-expanded">
              已展开：适合补充最近沟通、影响力变化和下次拜访问题。
            </small>
          ) : null}
        </button>
        );
      })}
    </div>
  );
}

export function FieldTags({ items, tone = "blue" }) {
  const [expandedItem, setExpandedItem] = useState(null);

  return (
    <div className="field-tags">
      {items.map((item) => (
        <button
          className={`field-tag interactive-card ${statusTone[tone]} ${expandedItem === item ? "expanded" : ""}`}
          key={item}
          type="button"
          onClick={() => setExpandedItem((current) => (current === item ? null : item))}
        >
          {item}
          {expandedItem === item ? <small data-testid="field-tag-expanded">可用于复盘、方案材料或客户背书。</small> : null}
        </button>
      ))}
    </div>
  );
}

export function DecisionChain({ steps }) {
  const [expandedStep, setExpandedStep] = useState(null);

  return (
    <div className="chain-list">
      {steps.map((step, index) => (
        <button
          className={`chain-step interactive-card ${expandedStep === step ? "expanded" : ""}`}
          key={step}
          type="button"
          onClick={() => setExpandedStep((current) => (current === step ? null : step))}
        >
          <time>{index + 1}</time>
          <span>{step}</span>
          {expandedStep === step ? (
            <small data-testid="chain-expanded">已展开：需要记录责任人、确认材料和下一次推进动作。</small>
          ) : null}
        </button>
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

export function confirmDelete(message) {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(message);
}

export function showOperationError(message) {
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message);
  }
}

export function DeleteConfirmationDialog({
  open,
  entityName,
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
          <h2 id={titleId}>确认删除客户</h2>
          <p id={descriptionId}>“{entityName}”将从客户列表中移除，此操作不能撤销。</p>
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
            {busy ? "删除中" : "确认删除"}
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
