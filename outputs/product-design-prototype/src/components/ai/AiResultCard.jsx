import { useEffect, useMemo, useState } from "react";

import {
  AI_RESULT_CARD_STATUS,
  createAiResultCancellationRequest,
  createAiResultConfirmationRequest,
  normalizeAiResultCard,
  updateAiResultDraft,
} from "./aiResultCardModel.js";

function EvidenceList({ evidence }) {
  if (evidence.length === 0) {
    return <p className="muted-copy">暂无可展示的证据来源</p>;
  }
  return (
    <ul className="ai-result-card-evidence-list">
      {evidence.map((item) => (
        <li key={item.id}>
          <strong>{item.label}</strong>
          {item.detail ? <span>{item.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ChangePreview({ changes, target }) {
  if (changes.length === 0) {
    return <p className="muted-copy">当前没有待确认的业务字段改动</p>;
  }
  return (
    <div className="ai-result-card-preview" data-testid="ai-result-card-preview">
      {target ? <p className="ai-result-card-preview-target">确认后拟更新：{target}</p> : null}
      <dl>
        {changes.map((change) => (
          <div className="ai-result-card-change" key={change.id}>
            <dt>{change.field}</dt>
            <dd>
              <span className="ai-result-card-before">{change.before}</span>
              <span aria-hidden="true"> → </span>
              <span className="ai-result-card-after">{change.after}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AiResultCard({
  result,
  historyReadOnly = false,
  draftMode = "editable",
  draft: controlledDraft,
  busy = false,
  confirmLabel = "人工确认并继续",
  cancelLabel = "取消建议",
  onDraftChange,
  onConfirm,
  onCancel,
}) {
  const model = useMemo(
    () => normalizeAiResultCard(result, { historyReadOnly, draftMode }),
    [draftMode, historyReadOnly, result],
  );
  const [localDraft, setLocalDraft] = useState(model.draft);
  const isControlled = typeof controlledDraft === "string";

  useEffect(() => {
    if (!isControlled) setLocalDraft(model.draft);
  }, [isControlled, model.draft, model.id, model.status]);

  const draft = isControlled ? controlledDraft : localDraft;
  const liveModel = useMemo(
    () => updateAiResultDraft(model, draft),
    [draft, model],
  );
  const showPendingActions = liveModel.status === AI_RESULT_CARD_STATUS.PENDING;

  function handleDraftChange(event) {
    const nextDraft = event.target.value;
    if (!liveModel.editable) return;
    if (!isControlled) setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft, updateAiResultDraft(liveModel, nextDraft));
  }

  function handleConfirm() {
    const request = createAiResultConfirmationRequest(liveModel);
    if (request) onConfirm?.(request);
  }

  function handleCancel() {
    const request = createAiResultCancellationRequest(liveModel);
    if (request) onCancel?.(request);
  }

  return (
    <article
      className={`ai-result-card tone-${liveModel.statusMeta.tone}`}
      data-testid="ai-result-card"
      data-status={liveModel.status}
      data-readonly={liveModel.readOnly ? "true" : "false"}
    >
      <header className="ai-result-card-header">
        <div>
          <span className={`pill tone-${liveModel.statusMeta.tone}`}>{liveModel.statusMeta.label}</span>
          <h3>{liveModel.title}</h3>
        </div>
        <div className="ai-result-card-confidence" aria-label={`置信度 ${liveModel.confidenceLabel}`}>
          <strong>{liveModel.confidenceLabel}</strong>
          <meter min="0" max="100" value={liveModel.confidence}>置信度 {liveModel.confidenceLabel}</meter>
        </div>
      </header>

      <section className="ai-result-card-section" aria-label="建议正文">
        <h4>建议正文</h4>
        <p>{liveModel.suggestion || "暂无建议正文"}</p>
      </section>

      <section className="ai-result-card-section" aria-label="证据来源">
        <h4>证据来源</h4>
        <EvidenceList evidence={liveModel.evidence} />
      </section>

      <section className="ai-result-card-section" aria-label="人工确认草稿">
        <h4>{liveModel.editable ? "确认前可编辑草稿" : "确认草稿"}</h4>
        {liveModel.editable ? (
          <textarea
            data-testid="ai-result-card-draft"
            value={draft}
            disabled={busy}
            onChange={handleDraftChange}
            aria-label="确认前可编辑草稿"
          />
        ) : (
          <p className="ai-result-card-readonly-draft" data-testid="ai-result-card-readonly-draft">
            {draft || "暂无草稿"}
          </p>
        )}
      </section>

      <section className="ai-result-card-section" aria-label="确认后改动预览">
        <h4>确认后改动预览</h4>
        <ChangePreview changes={liveModel.changes} target={liveModel.previewTarget} />
      </section>

      {liveModel.status === AI_RESULT_CARD_STATUS.FAILED && liveModel.errorMessage ? (
        <p className="ai-result-card-error" role="alert">{liveModel.errorMessage}</p>
      ) : null}

      <p className="ai-result-card-status" role="status" aria-live="polite">
        {liveModel.statusMeta.description}
      </p>

      {showPendingActions ? (
        <footer className="ai-result-card-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={handleCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="ai-result-card-confirm"
            disabled={busy || !liveModel.canConfirm || typeof onConfirm !== "function"}
            onClick={handleConfirm}
          >
            {busy ? "确认中" : confirmLabel}
          </button>
        </footer>
      ) : null}
    </article>
  );
}
