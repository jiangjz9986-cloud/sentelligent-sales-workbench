let loaderPromise = null;

export function getAmapRuntimeConfig(env = import.meta.env) {
  return {
    key: String(env?.VITE_AMAP_WEB_JS_KEY ?? "").trim(),
    securityCode: String(env?.VITE_AMAP_SECURITY_CODE ?? "").trim(),
  };
}

export function loadAmap({
  key,
  securityCode,
  windowRef = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  if (!key) return Promise.reject(new Error("AMap Web JS configuration is unavailable"));
  if (windowRef?.AMap) return Promise.resolve(windowRef.AMap);
  if (!windowRef || !documentRef) return Promise.reject(new Error("AMap requires a browser environment"));
  if (loaderPromise) return loaderPromise;

  if (securityCode) {
    windowRef._AMapSecurityConfig = { securityJsCode: securityCode };
  }
  loaderPromise = new Promise((resolve, reject) => {
    const existing = documentRef.querySelector("script[data-sentelligent-amap]");
    const script = existing ?? documentRef.createElement("script");
    const onLoad = () => {
      if (windowRef.AMap) resolve(windowRef.AMap);
      else reject(new Error("AMap loaded without a usable SDK"));
    };
    const onError = () => reject(new Error("AMap SDK could not be loaded"));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      const params = new URLSearchParams({ v: "2.0", key });
      script.src = `https://webapi.amap.com/maps?${params}`;
      script.async = true;
      script.dataset.sentelligentAmap = "true";
      documentRef.head.append(script);
    }
  }).catch((error) => {
    loaderPromise = null;
    throw error;
  });
  return loaderPromise;
}
