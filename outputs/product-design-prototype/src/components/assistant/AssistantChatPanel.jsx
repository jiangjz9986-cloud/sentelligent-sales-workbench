import { LoaderCircle, Send, X } from "lucide-react";
import { useEffect, useRef } from "react";
import VoiceCaptureControl from "../audio/VoiceCaptureControl.jsx";
import { AssistantConfirmCard } from "./AssistantConfirmCard.jsx";

function AssistantMessage({ message }) {
  const tone = message.status === "denied" || message.status === "error" ? "error" : message.role;
  return (
    <div className={`assistant-message is-${tone}`} data-testid={`assistant-message-${message.role}`}>
      <div className="assistant-message-bubble">{message.text}</div>
    </div>
  );
}

export function AssistantChatPanel({
  open,
  messages,
  pending,
  draft,
  busy,
  apiClient,
  online = false,
  sessionEpoch,
  appendTranscriptToDraft,
  voiceFeedback,
  draftFocusToken,
  onDraftChange,
  onSend,
  onClose,
  onConfirm,
  onCancelPending,
}) {
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open, pending]);

  useEffect(() => {
    if (!open || !draftFocusToken) return;
    inputRef.current?.focus();
  }, [draftFocusToken, open]);

  if (!open) return null;

  return (
    <div className="assistant-chat-backdrop" data-testid="assistant-chat-backdrop" onClick={onClose}>
      <section
        id="assistant-chat-panel"
        className="assistant-chat-panel"
        role="dialog"
        aria-modal="true"
        aria-label="小小对话"
        data-testid="assistant-chat-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="assistant-chat-header">
          <strong>小小</strong>
          <button className="icon-button" type="button" aria-label="关闭对话" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div ref={listRef} className="assistant-chat-messages" aria-live="polite" aria-busy={busy}>
          {messages.map((message) => (
            <AssistantMessage key={message.id} message={message} />
          ))}
          {pending ? (
            <AssistantConfirmCard
              card={pending.card}
              text={pending.text}
              risk={pending.risk}
              busy={busy}
              onConfirm={onConfirm}
              onCancel={onCancelPending}
            />
          ) : null}
        </div>

        <form
          className="assistant-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <VoiceCaptureControl
            apiClient={apiClient}
            purpose="assistant_chat"
            onTranscript={appendTranscriptToDraft}
            active={open}
            disabled={busy || Boolean(pending) || !online}
            sessionEpoch={sessionEpoch}
            compact
          />
          {voiceFeedback ? (
            <p className="assistant-chat-voice-feedback" role="status" aria-live="polite">
              {voiceFeedback}
            </p>
          ) : null}
          <textarea
            ref={inputRef}
            value={draft}
            rows={3}
            maxLength={2000}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            disabled={busy || Boolean(pending)}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <button className="primary-button" type="submit" disabled={busy || Boolean(pending) || !draft.trim()}>
            {busy ? <LoaderCircle className="state-spinner" size={16} /> : <Send size={16} />}
            发送
          </button>
        </form>
      </section>
    </div>
  );
}
