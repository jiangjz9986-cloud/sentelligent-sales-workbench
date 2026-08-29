import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { appendToast, dismissToast, normalizeToastInput } from "./toastModel.js";

// 全局操作反馈提示条：跨页/列表写操作的结果确认走这里，表单内的行内状态文案
// 继续留在各编辑器（接线原则见 v0.10.0 设计 §7.3）。

const ToastContext = createContext(null);

const toastToneIcon = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => dismissToast(current, id));
  }, []);

  const toast = useCallback((input) => {
    const normalized = normalizeToastInput(input);
    if (!normalized.title) return;
    const id = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((current) => appendToast(current, { id, ...normalized }));
    timersRef.current.set(id, setTimeout(() => dismiss(id), normalized.duration));
  }, [dismiss]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const visibleIds = useMemo(() => new Set(toasts.map((item) => item.id)), [toasts]);
  useEffect(() => {
    // appendToast 挤掉最旧一条时同步清掉它的定时器，防止定时器泄漏。
    for (const [id, timer] of timersRef.current) {
      if (!visibleIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [visibleIds]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((item) => {
          const Icon = toastToneIcon[item.tone] ?? Info;
          return (
            <div
              className={`toast tone-rail-${item.tone}`}
              key={item.id}
              role={item.tone === "error" ? "alert" : "status"}
              data-testid={`toast-${item.tone}`}
            >
              <span className={`toast-icon toast-icon-${item.tone}`} aria-hidden="true">
                <Icon size={17} />
              </span>
              <div className="toast-copy">
                <strong>{item.title}</strong>
                {item.description ? <small>{item.description}</small> : null}
              </div>
              {item.actionLabel ? (
                <button
                  className="ghost-button toast-action"
                  type="button"
                  onClick={() => {
                    item.onAction?.();
                    dismiss(item.id);
                  }}
                >
                  {item.actionLabel}
                </button>
              ) : null}
              <button
                className="icon-button toast-close"
                type="button"
                aria-label="关闭提示"
                data-testid="toast-close"
                onClick={() => dismiss(item.id)}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

const noopToast = () => {};

// Provider 之外（登录页等）取到的是安全空实现，调用不产生任何界面效果。
export function useToast() {
  return useContext(ToastContext) ?? noopToast;
}
