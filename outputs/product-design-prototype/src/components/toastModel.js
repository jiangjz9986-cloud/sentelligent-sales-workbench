// 全局提示条（toast）纯状态模型：ToastProvider 只负责渲染与定时器，队列语义
// （容量、时长、关闭）全部收敛在这里以便单测。

export const TOAST_LIMIT = 3;

const TOAST_TONES = new Set(["info", "success", "error"]);

export function toastDurationFor(tone, duration) {
  if (Number.isFinite(duration) && duration > 0) return duration;
  return tone === "error" ? 6000 : 4000;
}

export function normalizeToastInput(input = {}) {
  const tone = TOAST_TONES.has(input.tone) ? input.tone : "info";
  return {
    tone,
    title: String(input.title ?? "").trim(),
    description: String(input.description ?? "").trim(),
    duration: toastDurationFor(tone, input.duration),
    actionLabel: String(input.actionLabel ?? "").trim(),
    onAction: typeof input.onAction === "function" ? input.onAction : null,
  };
}

// 追加一条并保持并发上限：超出容量时最旧一条让位。
export function appendToast(toasts, toast) {
  return [...toasts.slice(-(TOAST_LIMIT - 1)), toast];
}

export function dismissToast(toasts, id) {
  return toasts.filter((item) => item.id !== id);
}
