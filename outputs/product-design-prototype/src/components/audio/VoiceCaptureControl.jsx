import { useRef } from "react";

import { useServerTranscription } from "../../audio/useServerTranscription.js";

const BUSY_STATUSES = new Set(["requesting_permission", "preparing", "processing"]);

export function updateSyntheticClickToken(tokenRef, event) {
  if (event.pointerType === "mouse") {
    // A real mouse click always has its own pointerdown. Clearing here means a
    // cancelled touch gesture that emitted no click cannot swallow that click.
    tokenRef.current = null;
    return false;
  }
  tokenRef.current = { pointerId: event.pointerId, pointerType: event.pointerType };
  return true;
}

export function consumeSyntheticClickToken(tokenRef) {
  if (!tokenRef.current) return false;
  tokenRef.current = null;
  return true;
}

export function runPrimaryKeyboardAction(event, transcription, primary, primaryDisabled) {
  if (event.repeat) {
    event.preventDefault();
    return false;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    transcription.cancelCapture("keyboard_escape");
    return true;
  }
  if (event.key !== " " && event.key !== "Enter") return false;
  event.preventDefault();
  if (primaryDisabled) return false;
  primary.action();
  return true;
}

export function beginTouchCapture(transcription, gesture, pointerId) {
  gesture.pointerId = pointerId;
  gesture.startedCapture = false;
  if (BUSY_STATUSES.has(transcription.status)) {
    return Boolean(transcription.cancelCapture?.("pointer_busy_cancel"));
  }
  if (
    transcription.status === "recording"
    || transcription.status === "rate_limited"
    || transcription.disabled
    || !transcription.supported
  ) {
    return false;
  }
  // Bind pointerup to what this pointerdown initiated. startCapture is async
  // while permission is pending, so the gesture cannot depend on its Promise.
  gesture.startedCapture = true;
  transcription.startCapture?.();
  return true;
}

export function finishTouchCapture(transcription) {
  // Query the controller through its return value instead of trusting the
  // render-time status captured before a fast pointerup event.
  if (transcription.stopCapture?.()) return true;
  return Boolean(transcription.cancelCapture?.("pointer_up_before_permission"));
}

export function finishTouchGesture(transcription, gesture, pointerId) {
  if (gesture.pointerId !== pointerId) return false;
  const shouldFinish = gesture.startedCapture;
  gesture.pointerId = null;
  gesture.startedCapture = false;
  return shouldFinish ? finishTouchCapture(transcription) : false;
}

export function cancelTouchGesture(transcription, gesture, pointerId, reason = "pointer_cancel") {
  if (gesture.pointerId !== pointerId) return false;
  const shouldCancel = gesture.startedCapture;
  gesture.pointerId = null;
  gesture.startedCapture = false;
  return shouldCancel ? Boolean(transcription.cancelCapture?.(reason)) : false;
}

export function isPointerInsideTarget(event) {
  const rect = event.currentTarget?.getBoundingClientRect?.();
  if (!rect) return true;
  const { clientX, clientY } = event;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  return (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
}

export function moveTouchGesture(transcription, gesture, event) {
  if (
    event.pointerType === "mouse"
    || gesture.pointerId !== event.pointerId
    || !gesture.startedCapture
    || isPointerInsideTarget(event)
  ) {
    return false;
  }
  return cancelTouchGesture(transcription, gesture, event.pointerId, "pointer_leave");
}

export function releaseTouchGesture(transcription, gesture, event) {
  if (event.pointerType === "mouse" || gesture.pointerId !== event.pointerId) return false;
  if (!isPointerInsideTarget(event)) {
    return cancelTouchGesture(transcription, gesture, event.pointerId, "pointer_leave");
  }
  return finishTouchGesture(transcription, gesture, event.pointerId);
}

function primaryAction(transcription) {
  if (transcription.status === "recording") {
    return { label: "停止录音", action: transcription.stopCapture, disabled: false };
  }
  if (BUSY_STATUSES.has(transcription.status)) {
    return { label: "取消转写", action: () => transcription.cancelCapture("user_cancel"), disabled: false };
  }
  return {
    label: "开始录音",
    action: transcription.startCapture,
    disabled: transcription.status === "rate_limited" || !transcription.supported,
  };
}

export function VoiceCaptureControlView({
  transcription,
  disabled = false,
  className = "",
  compact = false,
}) {
  const syntheticClickToken = useRef(null);
  const touchGesture = useRef({ pointerId: null, startedCapture: false });
  const primary = primaryAction(transcription);
  const primaryDisabled = disabled || transcription.disabled || primary.disabled;
  const recording = transcription.status === "recording";

  function toggleFromKeyboard(event) {
    runPrimaryKeyboardAction(event, transcription, primary, primaryDisabled);
  }

  function handlePointerDown(event) {
    if (event.pointerType === "mouse") {
      updateSyntheticClickToken(syntheticClickToken, event);
      return;
    }
    if (primaryDisabled || recording) return;
    updateSyntheticClickToken(syntheticClickToken, event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginTouchCapture(transcription, touchGesture.current, event.pointerId);
  }

  function handlePointerUp(event) {
    releaseTouchGesture(transcription, touchGesture.current, event);
  }

  function handlePointerMove(event) {
    if (!moveTouchGesture(transcription, touchGesture.current, event)) return;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
  }

  function handlePointerCancel(event) {
    if (event.pointerType === "mouse") return;
    cancelTouchGesture(transcription, touchGesture.current, event.pointerId);
  }

  function handleClick() {
    if (consumeSyntheticClickToken(syntheticClickToken)) return;
    if (!primaryDisabled) primary.action();
  }

  return (
    <section
      className={`voice-capture-control${compact ? " voice-capture-control--compact" : ""}${className ? ` ${className}` : ""}`}
      data-state={transcription.status}
      data-recording-generation={transcription.recordingGeneration}
    >
      <div className="voice-capture-control__actions">
        <button
          type="button"
          className="voice-capture-control__primary"
          aria-label={primary.label}
          aria-pressed={recording}
          disabled={primaryDisabled}
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={handleClick}
          onKeyDown={toggleFromKeyboard}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={(event) => {
            if (
              event.pointerType !== "mouse"
              && touchGesture.current.pointerId === event.pointerId
              && touchGesture.current.startedCapture
            ) {
              cancelTouchGesture(
                transcription,
                touchGesture.current,
                event.pointerId,
                "pointer_leave",
              );
            }
          }}
        >
          <span aria-hidden="true">{recording ? "●" : "◉"}</span>
          <span>{primary.label}</span>
        </button>

        {transcription.status === "retryable_error" ? (
          <button
            type="button"
            className="voice-capture-control__retry"
            onClick={transcription.retry}
            disabled={disabled || transcription.retryCountdownSeconds > 0 || transcription.sameBlobRetryCount >= 1}
          >
            {transcription.retryCountdownSeconds > 0
              ? `${transcription.retryCountdownSeconds} 秒后可重试`
              : "人工重试一次"}
          </button>
        ) : null}

        {!transcription.supported && transcription.browserInterimAvailable ? (
          <button
            type="button"
            className="voice-capture-control__browser-interim"
            onClick={transcription.browserInterimActive
              ? transcription.stopBrowserInterim
              : transcription.startBrowserInterim}
            disabled={disabled}
          >
            {transcription.browserInterimActive ? "停止浏览器临时识别" : "浏览器临时识别"}
          </button>
        ) : null}
      </div>

      <div className="voice-capture-control__status" role="status" aria-live="polite" aria-atomic="true">
        <strong>{transcription.statusText}</strong>
        <span>{transcription.secondaryText}</span>
        {transcription.status === "rate_limited" && transcription.rateLimitCountdownSeconds > 0 ? (
          <span>{transcription.rateLimitCountdownSeconds} 秒后可重新录音</span>
        ) : null}
        {transcription.interimText ? (
          <span>
            浏览器临时识别：{transcription.interimText}（以服务端最终结果为准）
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default function VoiceCaptureControl({
  apiClient,
  purpose = "quick_record",
  onTranscript,
  onInterimText,
  disabled = false,
  active = true,
  sessionEpoch,
  className,
  compact,
}) {
  const transcription = useServerTranscription({
    apiClient,
    purpose,
    onTranscript,
    onInterimText,
    active,
    disabled,
    sessionEpoch,
  });
  return (
    <VoiceCaptureControlView
      transcription={{ ...transcription, disabled: disabled || !active }}
      disabled={disabled || !active}
      className={className}
      compact={compact}
    />
  );
}
