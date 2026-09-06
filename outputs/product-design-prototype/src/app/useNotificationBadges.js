import { useEffect, useMemo, useRef, useState } from "react";

const LAST_FOCUS_DATE_KEY = "sentelligent_last_focus_date";

function readLastSeenFocusDate() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_FOCUS_DATE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function markFocusDateSeen(date) {
  if (!date || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_FOCUS_DATE_KEY, date);
  } catch {
    // Ignore storage failures.
  }
}

export function useNotificationBadges({
  apiClient,
  backendStatus,
  overviewSummary,
  active,
}) {
  const [polledSummary, setPolledSummary] = useState(null);
  const summary = polledSummary ?? overviewSummary;

  useEffect(() => {
    if (active === "overview" && summary?.todayFocus?.date) {
      markFocusDateSeen(summary.todayFocus.date);
    }
  }, [active, summary?.todayFocus?.date]);

  useEffect(() => {
    if (!apiClient?.isEnabled || backendStatus !== "connected") return undefined;
    let cancelled = false;
    let timerId = 0;

    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await apiClient.getDashboardSummary();
        if (!cancelled) setPolledSummary(next);
      } catch {
        // Keep the last badge values when polling fails.
      }
    }

    function schedule() {
      timerId = window.setTimeout(async () => {
        await poll();
        if (!cancelled) schedule();
      }, 60_000);
    }

    poll();
    schedule();
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apiClient, backendStatus]);

  return useMemo(() => {
    const focus = summary?.todayFocus;
    const todos = focus?.todos ?? { overdueCount: 0, todayCount: 0 };
    const tenders = focus?.tenders ?? { highCount: 0 };
    const todayTodos = (todos.overdueCount ?? 0) + (todos.todayCount ?? 0);
    const tenderHigh = tenders.highCount ?? 0;
    const focusDate = focus?.date ?? "";
    const morning = Boolean(
      focusDate
      && focusDate !== readLastSeenFocusDate()
      && active !== "overview",
    );
    return {
      overviewTodos: todayTodos,
      tenderHigh,
      morning,
      badgeMore: tenderHigh + (todos.overdueCount ?? 0),
    };
  }, [summary, active]);
}
