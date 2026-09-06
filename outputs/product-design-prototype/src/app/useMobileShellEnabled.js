import { useEffect, useState } from "react";

export function isMobileShellKillSwitchOff() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("sentelligent_mobile_shell") === "0";
  } catch {
    return false;
  }
}

export function resolveMobileShellEnabled() {
  if (typeof window === "undefined") return false;
  if (isMobileShellKillSwitchOff()) return false;
  return window.matchMedia?.("(max-width: 760px)")?.matches ?? false;
}

export function useMobileShellEnabled() {
  const [enabled, setEnabled] = useState(() => resolveMobileShellEnabled());

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const refresh = () => setEnabled(resolveMobileShellEnabled());
    refresh();
    media.addEventListener("change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      media.removeEventListener("change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return enabled;
}
