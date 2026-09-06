import { useEffect, useRef } from "react";
import { applyServiceWorkerUpdate } from "./registerServiceWorker.js";

export function useServiceWorkerUpdate(toast) {
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (import.meta.env.DEV || typeof navigator === "undefined" || !navigator.serviceWorker) return undefined;

    function notifyUpdate(registration) {
      if (!registration?.waiting || !navigator.serviceWorker.controller) return;
      toastRef.current?.({
        tone: "info",
        title: "新版本可用",
        description: "点击立即更新以加载最新功能。",
        duration: 12000,
        actionLabel: "立即更新",
        onAction: () => applyServiceWorkerUpdate(registration),
      });
    }

    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) notifyUpdate(registration);
    });

    const onControllerChange = () => {
      if (!sessionStorage.getItem("sw_reload_guard")) {
        sessionStorage.setItem("sw_reload_guard", "1");
        window.location.reload();
      }
    };

    const onUpdateFound = (registration) => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed") notifyUpdate(registration);
      });
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.ready.then(onUpdateFound).catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);
}
