import { useCallback, useRef, useState } from "react";

const PULL_THRESHOLD = 72;
const PULL_DAMPING = 0.45;

export function PullToRefresh({ children, onRefresh, disabled = false }) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartYRef = useRef(0);
  const pullingRef = useRef(false);
  const scrollParentRef = useRef(null);

  const runRefresh = useCallback(async () => {
    if (refreshing || disabled) return;
    setRefreshing(true);
    try {
      await onRefresh?.();
    } finally {
      setRefreshing(false);
      setPullDistance(0);
    }
  }, [disabled, onRefresh, refreshing]);

  function resolveScrollParent(node) {
    let current = node;
    while (current) {
      const style = window.getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  return (
    <div
      className={`pull-to-refresh ${refreshing ? "is-refreshing" : ""} ${pullDistance > 0 ? "is-pulling" : ""}`}
      data-testid="pull-to-refresh"
      ref={(node) => {
        scrollParentRef.current = node ? resolveScrollParent(node) : null;
      }}
      onTouchStart={(event) => {
        if (disabled || refreshing) return;
        const scrollTop = scrollParentRef.current?.scrollTop ?? window.scrollY;
        if (scrollTop > 0) return;
        touchStartYRef.current = event.touches[0]?.clientY ?? 0;
        pullingRef.current = true;
      }}
      onTouchMove={(event) => {
        if (!pullingRef.current || disabled || refreshing) return;
        const currentY = event.touches[0]?.clientY ?? 0;
        const delta = Math.max(0, (currentY - touchStartYRef.current) * PULL_DAMPING);
        if (delta > 0) setPullDistance(delta);
      }}
      onTouchEnd={() => {
        if (!pullingRef.current) return;
        pullingRef.current = false;
        if (pullDistance >= PULL_THRESHOLD) {
          runRefresh();
          return;
        }
        setPullDistance(0);
      }}
      onTouchCancel={() => {
        pullingRef.current = false;
        setPullDistance(0);
      }}
    >
      <div
        className="pull-to-refresh-indicator"
        style={{ height: refreshing ? 3 : Math.min(pullDistance, PULL_THRESHOLD) }}
        aria-live="polite"
        role="status"
      >
        {refreshing || pullDistance >= PULL_THRESHOLD * 0.6 ? "正在刷新" : null}
      </div>
      {children}
    </div>
  );
}
