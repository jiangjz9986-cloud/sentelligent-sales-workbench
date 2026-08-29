import { parseWeixinCardText } from "./weixinCardParse.js";

export function AssistantConfirmCard({
  card,
  text,
  risk,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const parsed = card ?? parseWeixinCardText(text);
  const destructive = risk === "R3";

  if (!parsed) {
    return (
      <div className="assistant-confirm-card" data-testid="assistant-confirm-card">
        <pre className="assistant-confirm-fallback">{text}</pre>
        <div className="assistant-confirm-actions">
          <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button
            className={destructive ? "primary-button danger-button" : "primary-button"}
            type="button"
            disabled={busy}
            data-testid="assistant-confirm-submit"
            onClick={onConfirm}
          >
            确认
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-confirm-card" data-testid="assistant-confirm-card">
      <strong className="assistant-confirm-title">{parsed.title}</strong>
      <dl className="assistant-confirm-fields">
        {parsed.fields.map(([label, value]) => (
          <div key={label} className="assistant-confirm-field">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {parsed.footer ? <p className="assistant-confirm-footer">{parsed.footer}</p> : null}
      <div className="assistant-confirm-actions">
        <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button
          className={destructive ? "primary-button danger-button" : "primary-button"}
          type="button"
          disabled={busy}
          data-testid="assistant-confirm-submit"
          onClick={onConfirm}
        >
          {destructive ? "确认删除" : "确认"}
        </button>
      </div>
    </div>
  );
}
