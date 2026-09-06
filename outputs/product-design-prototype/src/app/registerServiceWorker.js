import { normalizeBasePath } from "./routes.js";

const DISABLE_KEY = "sentelligent_disable_sw";

export function isServiceWorkerDisabled() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(DISABLE_KEY) === "1";
  } catch {
    return false;
  }
}

function serviceWorkerScope() {
  return normalizeBasePath(
    typeof import.meta !== "undefined" ? import.meta.env?.BASE_URL : "/",
  );
}

function serviceWorkerUrl() {
  return `${serviceWorkerScope()}sw.js`;
}

export async function unregisterServiceWorkers() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

export async function registerServiceWorker() {
  if (import.meta.env.DEV) return null;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (isServiceWorkerDisabled()) {
    await unregisterServiceWorkers();
    return null;
  }
  const registration = await navigator.serviceWorker.register(serviceWorkerUrl(), {
    scope: serviceWorkerScope(),
    updateViaCache: "none",
  });
  return registration;
}

export async function applyServiceWorkerUpdate(registration) {
  const waiting = registration?.waiting;
  if (!waiting) return false;
  await new Promise((resolve) => {
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") resolve();
    });
    waiting.postMessage({ type: "SKIP_WAITING" });
  });
  window.location.reload();
  return true;
}
